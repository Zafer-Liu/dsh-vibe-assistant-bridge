import { afterEach, describe, expect, it, vi } from 'vitest'
import { setupTools, bridgeToolDefinitions } from '../src/tools'
import { resolveConfig } from '../src/config'
import { BridgeHttp } from '../src/http'
import { fakeContext, fakeFetchQueue, type FakeContext } from './helpers'

afterEach(() => {
  vi.unstubAllGlobals()
})

const registerTools = () => {
  const register = vi.fn<(definition: unknown) => unknown>()
  const ctx = { ...fakeContext(), tools: { register } }
  const { fetchMock, calls } = fakeFetchQueue(
    Array.from({ length: 16 }, () => new Response('', { status: 202 })),
  )
  vi.stubGlobal('fetch', fetchMock)
  const config = resolveConfig({})
  setupTools(ctx, config, new BridgeHttp(config))
  const definitions = register.mock.calls.map((call) => call[0] as ReturnType<typeof bridgeToolDefinitions>[number])
  return { ctx, register, definitions, calls }
}

describe('tool registration', () => {
  it('registers the four bridge tools with raw JSON Schema parameters', () => {
    const { definitions } = registerTools()
    expect(definitions.map((definition) => definition.name)).toEqual([
      'recall_memory',
      'get_user_profile',
      'list_shared_skills',
      'read_shared_skill',
    ])
    const recall = definitions[0]!
    expect(recall.parameters).toEqual({
      type: 'object',
      properties: {
        query: { type: 'string', description: expect.any(String) },
        limit: { type: 'number', description: expect.any(String), minimum: 1, maximum: 12 },
      },
      required: ['query'],
      additionalProperties: false,
    })
    const read = definitions[3]!
    expect(read.parameters).toMatchObject({ required: ['source', 'name'] })
    for (const definition of definitions) {
      expect(definition.output.schema).toEqual({})
      const blocks = definition.output.render({}, { ok: true })
      expect(blocks).toEqual([{ type: 'text', text: JSON.stringify({ ok: true }, null, 2) }])
    }
  })

  it('registers all four tools eagerly when the registry is injected', () => {
    const register = vi.fn<(definition: unknown) => unknown>()
    const ctx: FakeContext & { tools?: { register: typeof register } } = {
      ...fakeContext(),
      tools: { register },
    }
    const config = resolveConfig({})
    setupTools(ctx, config, new BridgeHttp(config))
    expect(register.mock.calls.length).toBe(4)
    const names = register.mock.calls.map((call) => (call[0] as { name: string }).name)
    expect(names).toEqual(['recall_memory', 'get_user_profile', 'list_shared_skills', 'read_shared_skill'])
  })

  it('warns and skips registration when the registry is absent', () => {
    const ctx = fakeContext()
    const config = resolveConfig({})
    expect(() => setupTools(ctx, config, new BridgeHttp(config))).not.toThrow()
    expect(ctx.logger.warn).toHaveBeenCalled()
  })
})

describe('tool execute: happy paths', () => {
  it('recall_memory posts the query and a clamped limit, returning the JSON body', async () => {
    const { definitions, calls } = registerTools()
    // Re-stub with a JSON response for this run.
    vi.unstubAllGlobals()
    const { fetchMock, calls: jsonCalls } = fakeFetchQueue([
      new Response('{"items":["memory-1"]}', { status: 200 }),
    ])
    vi.stubGlobal('fetch', fetchMock)
    const value = await definitions[0]!.execute({ query: 'render pipeline', limit: 40 })
    expect(value).toEqual({ items: ['memory-1'] })
    expect(jsonCalls[0]?.url).toBe('http://127.0.0.1:9420/memory/recall')
    expect(jsonCalls[0]?.body).toEqual({ query: 'render pipeline', limit: 12 })
    void calls
  })

  it('recall_memory omits a non-numeric limit and floors fractional ones', async () => {
    const { definitions } = registerTools()
    vi.unstubAllGlobals()
    const { fetchMock, calls } = fakeFetchQueue([
      new Response('{}', { status: 200 }),
      new Response('{}', { status: 200 }),
    ])
    vi.stubGlobal('fetch', fetchMock)
    await definitions[0]!.execute({ query: 'q' })
    await definitions[0]!.execute({ query: 'q', limit: 0.5 })
    expect(calls[0]?.body).toEqual({ query: 'q' })
    expect(calls[1]?.body).toEqual({ query: 'q', limit: 1 })
  })

  it('profile and skill tools post empty bodies to their endpoints', async () => {
    const { definitions } = registerTools()
    vi.unstubAllGlobals()
    const { fetchMock, calls } = fakeFetchQueue([
      new Response('{"profile":null}', { status: 200 }),
      new Response('{"skills":[]}', { status: 200 }),
      new Response('{"source":"codex","name":"x","content":"..."}', { status: 200 }),
    ])
    vi.stubGlobal('fetch', fetchMock)
    await definitions[1]!.execute({})
    await definitions[2]!.execute({})
    await definitions[3]!.execute({ source: 'codex', name: 'deploy' })
    expect(calls.map((call) => call.url)).toEqual([
      'http://127.0.0.1:9420/memory/profile',
      'http://127.0.0.1:9420/skills/list',
      'http://127.0.0.1:9420/skills/read',
    ])
    expect(calls[2]?.body).toEqual({ source: 'codex', name: 'deploy' })
  })
})

describe('tool execute: error paths', () => {
  it('throws a readable error when Vibe Assistant is unreachable', async () => {
    const { definitions } = registerTools()
    vi.unstubAllGlobals()
    const { fetchMock } = fakeFetchQueue([new Error('fetch failed')])
    vi.stubGlobal('fetch', fetchMock)
    await expect(definitions[0]!.execute({ query: 'q' }))
      .rejects.toThrow(/Vibe Assistant is not running or unreachable at http:\/\/127\.0\.0\.1:9420/)
  })

  it('relays a readable JSON error message verbatim on non-2xx', async () => {
    const { definitions } = registerTools()
    vi.unstubAllGlobals()
    const { fetchMock } = fakeFetchQueue([
      new Response(JSON.stringify({ error: 'Vibe Assistant 未运行' }), { status: 503 }),
    ])
    vi.stubGlobal('fetch', fetchMock)
    await expect(definitions[1]!.execute({})).rejects.toThrow('Vibe Assistant 未运行')
  })

  it('relays a short plain-text error body on non-2xx', async () => {
    const { definitions } = registerTools()
    vi.unstubAllGlobals()
    const { fetchMock } = fakeFetchQueue([new Response('internal error', { status: 500 })])
    vi.stubGlobal('fetch', fetchMock)
    await expect(definitions[2]!.execute({})).rejects.toThrow('internal error')
  })

  it('throws on a 200 response that is not JSON', async () => {
    const { definitions } = registerTools()
    vi.unstubAllGlobals()
    const { fetchMock } = fakeFetchQueue([new Response('<html>oops</html>', { status: 200 })])
    vi.stubGlobal('fetch', fetchMock)
    await expect(definitions[1]!.execute({})).rejects.toThrow(/non-JSON/)
  })
})
