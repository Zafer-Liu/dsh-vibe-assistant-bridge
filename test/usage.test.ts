import { afterEach, describe, expect, it, vi } from 'vitest'
import { setupUsage } from '../src/usage'
import { resolveConfig } from '../src/config'
import { BridgeHttp } from '../src/http'
import { fakeContext, fakeFetchQueue, flush } from './helpers'

const setup = () => {
  const ctx = fakeContext()
  const { fetchMock, calls } = fakeFetchQueue(
    Array.from({ length: 32 }, () => new Response('', { status: 202 })),
  )
  vi.stubGlobal('fetch', fetchMock)
  setupUsage(ctx, new BridgeHttp(resolveConfig({})))
  return { ctx, calls }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

const assistantEvent = (data: unknown, time?: number, seq?: number) => ({
  type: 'assistant/message',
  time,
  seq,
  data,
})

describe('usage payloads', () => {
  it('reports per-message usage with occurred_at and the event seq as message_id', async () => {
    const { ctx, calls } = setup()
    ctx.emit('session/event', { id: 's1' }, assistantEvent(
      { usage: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 900 } },
      1761625600123,
      42,
    ))
    await flush()
    expect(calls[0]?.url).toBe('http://127.0.0.1:9420/telemetry/usage?source=dsh')
    expect(calls[0]?.body).toEqual({
      session_id: 's1',
      input_tokens: 100,
      output_tokens: 40,
      cached_tokens: 900,
      occurred_at: '2025-10-28T04:26:40.123Z',
      message_id: '42',
    })
  })

  it('omits occurred_at when the event carries no time', async () => {
    const { ctx, calls } = setup()
    ctx.emit('session/event', { id: 's1' }, assistantEvent(
      { usage: { inputTokens: 1, outputTokens: 2 } },
    ))
    await flush()
    expect(calls[0]?.body).not.toHaveProperty('occurred_at')
    expect(calls[0]?.body).not.toHaveProperty('message_id')
    expect(calls[0]?.body).not.toHaveProperty('model')
  })

  it('tracks model/selection and attributes later usage with the model', async () => {
    const { ctx, calls } = setup()
    ctx.emit('session/event', { id: 's1' }, { type: 'model/selection', data: { provider: 'pi-ai', model: 'deepseek-v4-chat' } })
    ctx.emit('session/event', { id: 's1' }, assistantEvent({ usage: { inputTokens: 5, outputTokens: 6 } }))
    ctx.emit('session/event', { id: 's2' }, assistantEvent({ usage: { inputTokens: 7, outputTokens: 8 } }))
    await flush()
    expect(calls[0]?.body['model']).toBe('deepseek-v4-chat')
    expect(calls[1]?.body).not.toHaveProperty('model')
    expect(calls[1]?.body['session_id']).toBe('s2')
  })

  it('reports zero for absent optional token fields', async () => {
    const { ctx, calls } = setup()
    ctx.emit('session/event', { id: 's1' }, assistantEvent(
      { usage: { inputTokens: 10, outputTokens: 3 } },
      1761625600000,
    ))
    await flush()
    expect(calls[0]?.body).toMatchObject({
      input_tokens: 10,
      output_tokens: 3,
      cached_tokens: 0,
    })
  })
})

describe('usage filtering', () => {
  it('skips assistant messages without usage', async () => {
    const { ctx, calls } = setup()
    ctx.emit('session/event', { id: 's1' }, assistantEvent({ message: { id: 'm-no-usage' } }))
    await flush()
    expect(calls.length).toBe(0)
  })

  it('skips usage whose fields are all non-numeric', async () => {
    const { ctx, calls } = setup()
    ctx.emit('session/event', { id: 's1' }, assistantEvent(
      { usage: { inputTokens: 'many', outputTokens: null } },
    ))
    await flush()
    expect(calls.length).toBe(0)
  })

  it('ignores unrelated event types', async () => {
    const { ctx, calls } = setup()
    ctx.emit('session/event', { id: 's1' }, { type: 'tool/call', data: { callId: 'c1', name: 'mcp__a__b' } })
    ctx.emit('session/event', { id: 's1' }, { type: 'turn/end', data: { reason: 'done' } })
    await flush()
    expect(calls.length).toBe(0)
  })
})
