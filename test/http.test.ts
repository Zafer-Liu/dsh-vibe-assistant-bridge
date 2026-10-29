import { afterEach, describe, expect, it, vi } from 'vitest'
import { BridgeHttp } from '../src/http'
import { DEFAULT_ENDPOINT } from '../src/config'
import { fakeFetchQueue, flush } from './helpers'

const channel = (): BridgeHttp => new BridgeHttp({
  endpoint: DEFAULT_ENDPOINT,
  timeoutMs: 2000,
  maxInflight: 2,
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('BridgeHttp', () => {
  it('url() joins the endpoint and passes absolute URLs through', () => {
    const http = channel()
    expect(http.url('/mcp/observation?source=dsh'))
      .toBe('http://127.0.0.1:9420/mcp/observation?source=dsh')
    expect(http.url('memory/recall')).toBe('http://127.0.0.1:9420/memory/recall')
    expect(http.url('http://example.internal/x')).toBe('http://example.internal/x')
  })

  it('request() posts JSON and resolves the response', async () => {
    const { fetchMock, calls } = fakeFetchQueue([new Response('{"ok":true}', { status: 200 })])
    vi.stubGlobal('fetch', fetchMock)
    const response = await channel().request('/memory/recall', { query: 'x' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(calls[0]).toEqual({
      url: 'http://127.0.0.1:9420/memory/recall',
      body: { query: 'x' },
    })
  })

  it('fire() posts without awaiting and swallows transport failures', async () => {
    const { fetchMock, calls } = fakeFetchQueue([new Error('ECONNREFUSED')])
    vi.stubGlobal('fetch', fetchMock)
    channel().fire('/collect/trigger?source=dsh', { session_id: 's1' })
    await flush()
    expect(calls.length).toBe(1)
    // No unhandled rejection escaped: reaching this point is the assertion.
  })

  it('fire() drops posts beyond maxInflight while earlier ones are pending', async () => {
    const hanging = new Promise<Response>(() => {})
    const { fetchMock, calls } = fakeFetchQueue([hanging, new Response('', { status: 202 })])
    vi.stubGlobal('fetch', fetchMock)
    const http = channel()
    http.fire('/mcp/observation?source=dsh', { event: 'call_start' })
    http.fire('/mcp/observation?source=dsh', { event: 'call_start' })
    http.fire('/mcp/observation?source=dsh', { event: 'call_start' })
    // Synchronous cap check: the third post is dropped before any microtask runs.
    expect(calls.length).toBe(2)
    await flush()
  })
})
