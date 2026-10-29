import type { BridgeConfig } from './config'
import type { BridgeHttp } from './http'

/**
 * MCP call observation, ported 1:1 from Vibe Assistant's legacy embedded
 * observe plugin (dsh_observe.rs → plugin_source()).
 *
 * Listens to `session/event` for `tool/call` / `tool/result` pairs, keeps the
 * `mcp__<server>__<tool>` namespace split, and reports call boundaries to
 * Vibe Assistant (`POST /mcp/observation?source=dsh`). Tool arguments and
 * result bodies are never reported — only the call identity and the
 * success/failure classification.
 */

const MCP_PREFIX = 'mcp__'

interface ToolCallData {
  name?: unknown
  callId?: unknown
}

interface ToolResultData {
  message?: { toolCallId?: unknown; isError?: unknown } | undefined
  error?: {
    name?: unknown
    info?: { code?: unknown } | undefined
    code?: unknown
  } | undefined
}

interface SessionLike {
  id?: string
  header?: { id?: string }
}

interface SessionEventLike {
  type?: string
  time?: unknown
  surfaceOp?: unknown
  data?: unknown
}

export interface ObservationContext {
  on(event: string, listener: (...args: never[]) => unknown): unknown
}

const sessionIdOf = (session: SessionLike | undefined): string => {
  if (typeof session?.id === 'string') return session.id
  if (typeof session?.header?.id === 'string') return session.header.id
  return ''
}

/** Split `mcp__<server>__<tool>` into its namespace pair, else undefined. */
const splitToolName = (name: unknown): { server: string; tool: string } | undefined => {
  if (typeof name !== 'string' || !name.startsWith(MCP_PREFIX)) return undefined
  const rest = name.slice(MCP_PREFIX.length)
  const index = rest.indexOf('__')
  if (index <= 0) return undefined
  const server = rest.slice(0, index)
  const tool = rest.slice(index + 2)
  if (server === '' || tool === '') return undefined
  return { server, tool }
}

export function setupObservation(
  ctx: ObservationContext,
  config: BridgeConfig,
  http: BridgeHttp,
): void {
  const url = http.url('/mcp/observation?source=dsh')
  const pending = new Map<string, { server: string; tool: string }>()

  const post = (payload: Record<string, unknown>): void => {
    http.fire(url, payload)
  }

  /** Remember a call_start under its key, evicting the oldest when full. */
  const remember = (key: string, value: { server: string; tool: string }): void => {
    if (pending.size >= config.maxPending) {
      const oldest = pending.keys().next().value
      if (oldest !== undefined) pending.delete(oldest)
    }
    pending.set(key, value)
  }

  /** Classify a tool/result into the call_end status/failure fields. */
  const failureOf = (data: ToolResultData): Record<string, unknown> => {
    const message = data?.message
    const error = data?.error
    const failed = message?.isError === true
      || (error !== undefined && error !== null)
    if (!failed) return { status: 'success' }
    const payload: Record<string, unknown> = {
      status: 'failed',
      error_category: 'tool_error',
      error_phase: 'response',
      failure_kind: 'tool_error',
    }
    const name = error?.name
    if (typeof name === 'string' && name !== '') payload['error_reason'] = name
    const code = error?.info?.code ?? error?.code
    if (typeof code === 'number' && Number.isSafeInteger(code)) payload['error_code'] = code
    return payload
  }

  const listener = (session: SessionLike, event: SessionEventLike): void => {
    try {
      const sessionId = sessionIdOf(session)
      if (sessionId === '') return
      const surfaceOp = event?.surfaceOp
      if (surfaceOp !== undefined && surfaceOp !== 'append') return
      const type = event?.type
      const data = event?.data
      if (data === undefined || data === null) return
      if (type === 'tool/call') {
        const call = data as ToolCallData
        const parsed = splitToolName(call.name)
        const callId = typeof call.callId === 'string' ? call.callId : ''
        if (parsed === undefined || callId === '') return
        remember(sessionId + ':' + callId, parsed)
        post({
          event: 'call_start',
          session_id: sessionId,
          call_id: callId,
          server: parsed.server,
          tool: parsed.tool,
        })
        return
      }
      if (type === 'tool/result') {
        const result = data as ToolResultData
        const callId = typeof result.message?.toolCallId === 'string'
          ? result.message.toolCallId
          : ''
        if (callId === '') return
        const key = sessionId + ':' + callId
        const started = pending.get(key)
        if (started === undefined) return
        pending.delete(key)
        post({
          event: 'call_end',
          session_id: sessionId,
          call_id: callId,
          server: started.server,
          tool: started.tool,
          ...failureOf(result),
        })
      }
    } catch {}
  }

  ctx.on('session/event', listener)
}
