import { afterEach, describe, expect, it, vi } from 'vitest'
import { setupCollect } from '../src/collect'
import { resolveConfig } from '../src/config'
import { BridgeHttp } from '../src/http'
import { fakeContext, fakeFetchQueue, flush } from './helpers'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('collection trigger', () => {
  it('posts the session id when the turn is stopping', async () => {
    const ctx = fakeContext()
    const { fetchMock, calls } = fakeFetchQueue([new Response('', { status: 202 })])
    vi.stubGlobal('fetch', fetchMock)
    setupCollect(ctx, new BridgeHttp(resolveConfig({})))
    ctx.emit('agent/turn-stopping', { agent: { session: { id: 'session-abc' } }, turn: 3 })
    await flush()
    expect(calls[0]?.url).toBe('http://127.0.0.1:9420/collect/trigger?source=dsh')
    expect(calls[0]?.body).toEqual({ session_id: 'session-abc' })
  })

  it('stays silent without a session id', async () => {
    const ctx = fakeContext()
    const { fetchMock, calls } = fakeFetchQueue([])
    vi.stubGlobal('fetch', fetchMock)
    setupCollect(ctx, new BridgeHttp(resolveConfig({})))
    ctx.emit('agent/turn-stopping', { agent: {}, turn: 1 })
    ctx.emit('agent/turn-stopping', {})
    await flush()
    expect(calls.length).toBe(0)
  })

  it('never propagates a fetch failure to the host', async () => {
    const ctx = fakeContext()
    const { fetchMock } = fakeFetchQueue([new Error('ECONNREFUSED')])
    vi.stubGlobal('fetch', fetchMock)
    setupCollect(ctx, new BridgeHttp(resolveConfig({})))
    expect(() =>
      ctx.emit('agent/turn-stopping', { agent: { session: { id: 's1' } } }),
    ).not.toThrow()
    await flush()
  })
})
