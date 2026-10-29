import type { BridgeConfig } from './config'
import type { BridgeHttp } from './http'

/**
 * Native tool bridge: registers four Vibe Assistant capabilities as raw
 * dsh tools (`ctx.tools.register`), the same shape MCP tools arrive in —
 * plain JSON Schema `parameters`, an `output` declaration, and an `execute`
 * whose thrown errors the host marks `isError`.
 *
 * No `@deepseek-ai/dsh-tools` import (zero runtime dependencies): the
 * definitions are hand-built against the registry's raw `ToolDefinition`
 * form, so the bundle stays host-version-proof during the dsh preview.
 */

interface ContentBlock {
  type: string
  text: string
}

interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render(args: unknown, value: unknown): ContentBlock[]
  }
  execute(args: unknown, exec?: { signal?: AbortSignal }): Promise<unknown>
}

interface ToolsRegistry {
  register(definition: ToolDefinition): unknown
}

export interface ToolsContext {
  on(event: string, listener: (...args: never[]) => unknown): unknown
  logger?: { warn?: (message?: string, ...args: unknown[]) => void }
  tools?: ToolsRegistry
}

const jsonText = (value: unknown): string => JSON.stringify(value, null, 2)

/** Canonical output declaration: any lossless JSON value, rendered as text. */
const passthroughOutput = {
  schema: {},
  render: (_args: unknown, value: unknown): ContentBlock[] => [
    { type: 'text', text: jsonText(value) },
  ],
}

const stringArg = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value : undefined

/** Extract the readable error message an HTTP error response carries. */
const readableError = async (response: Response): Promise<string> => {
  let text = ''
  try {
    text = await response.text()
  } catch {}
  const trimmed = text.trim()
  if (trimmed !== '') {
    try {
      const parsed = JSON.parse(trimmed) as { error?: unknown }
      if (typeof parsed?.error === 'string' && parsed.error.trim() !== '') return parsed.error
    } catch {}
    if (trimmed.length <= 300) return trimmed
    return `Vibe Assistant request failed (HTTP ${response.status}): ${trimmed.slice(0, 200)}...`
  }
  return `Vibe Assistant request failed (HTTP ${response.status} ${response.statusText})`
}

/**
 * POST one tool request and return the JSON response as the canonical value.
 * Transport failures and non-2xx responses throw readable errors (the host
 * marks the call `isError`); a readable server error message such as
 * "Vibe Assistant 未运行" is relayed verbatim.
 */
const postForValue = async (
  http: BridgeHttp,
  endpoint: string,
  path: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> => {
  let response: Response
  try {
    // Tools face the model with a real user waiting: allow up to 15s (the
    // server's semantic-search budget is 3s, so even a slow embedding
    // endpoint leaves headroom), instead of the shared 2s observation budget.
    response = await http.request(path, body, signal, 15_000)
  } catch (error) {
    const cause = error instanceof Error ? ` (${error.message})` : ''
    throw new Error(`Vibe Assistant is not running or unreachable at ${endpoint}${cause}`)
  }
  if (!response.ok) throw new Error(await readableError(response))
  const text = await response.text()
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`Vibe Assistant returned a non-JSON response (HTTP ${response.status})`)
  }
}

/** The four bridge tools, built from a config and HTTP channel. */
export function bridgeToolDefinitions(
  config: BridgeConfig,
  http: BridgeHttp,
): ToolDefinition[] {
  const post = (
    path: string,
    build: (args: Record<string, unknown>) => Record<string, unknown>,
  ) => async (args: unknown, exec?: { signal?: AbortSignal }): Promise<unknown> => {
    const source = typeof args === 'object' && args !== null
      ? (args as Record<string, unknown>)
      : {}
    return await postForValue(http, config.endpoint, path, build(source), exec?.signal)
  }

  return [
    {
      name: 'recall_memory',
      description:
        'Search the user\'s shared Vibe Assistant memory and return the records most relevant to a query. Use before planning or continuing work when prior decisions or preferences may matter.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Free-text query describing the memory, decision, or constraint to recall.',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of records to return (1-12, default 6).',
            minimum: 1,
            maximum: 12,
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
      output: passthroughOutput,
      execute: post('/memory/recall', (args) => {
        const body: Record<string, unknown> = { query: stringArg(args['query']) ?? '' }
        const limit = args['limit']
        if (typeof limit === 'number' && Number.isFinite(limit)) {
          body['limit'] = Math.min(12, Math.max(1, Math.trunc(limit)))
        }
        return body
      }),
    },
    {
      name: 'get_user_profile',
      description:
        "Read the user's long-term Vibe Assistant profile: stable preferences, constraints, and identity markers that apply across projects.",
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      output: passthroughOutput,
      execute: post('/memory/profile', () => ({})),
    },
    {
      name: 'list_shared_skills',
      description:
        'List the published reusable workflow Skills in the user\'s shared Vibe Assistant Skill library.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      output: passthroughOutput,
      execute: post('/skills/list', () => ({})),
    },
    {
      name: 'read_shared_skill',
      description:
        'Read one published Skill from the user\'s shared Vibe Assistant Skill library by its source namespace and name.',
      parameters: {
        type: 'object',
        properties: {
          source: {
            type: 'string',
            description: 'Skill source namespace returned by list_shared_skills (e.g. "codex" or "claude").',
          },
          name: {
            type: 'string',
            description: 'Skill name returned by list_shared_skills.',
          },
        },
        required: ['source', 'name'],
        additionalProperties: false,
      },
      output: passthroughOutput,
      execute: post('/skills/read', (args) => ({
        source: stringArg(args['source']) ?? '',
        name: stringArg(args['name']) ?? '',
      })),
    },
  ]
}

/**
 * Register the four tools. The `tools` service can bind after this plugin
 * under the loader's concurrent activation, so registration is retried on
 * every `internal/service` event until the registry appears.
 */
export function setupTools(
  ctx: ToolsContext,
  config: BridgeConfig,
  http: BridgeHttp,
): void {
  // The plugin declares `inject = ["tools"]`, so cordis guarantees the
  // registry is present when `apply` runs. Register eagerly; a missing or
  // mis-shaped registry is a host bug, surfaced loudly instead of silently
  // dropping the four tools.
  const tools = ctx.tools
  if (tools === undefined || typeof tools.register !== 'function') {
    ctx.logger?.warn?.(
      'vibe-assistant-bridge: ctx.tools unavailable at apply time — memory/skill tools not registered',
    )
    return
  }
  for (const definition of bridgeToolDefinitions(config, http)) {
    tools.register(definition)
  }
}
