import { afterEach, describe, expect, it, vi } from 'vitest'
import { setupObservation } from '../src/observation'
import { resolveConfig } from '../src/config'
import { BridgeHttp } from '../src/http'
import { fakeContext, fakeFetchQueue, flush } from './helpers'

const setup = (overrides: Record<string, unknown> = {}) => {
  const ctx = fakeContext()
  const { fetchMock, calls } = fakeFetchQueue(
    Array.from({ length: 64 }, () => new Response('', { status: 202 })),
  )
  vi.stubGlobal('fetch', fetchMock)
  setupObservation(ctx, resolveConfig(overrides), new BridgeHttp(resolveConfig(overrides)))
  return { ctx, calls }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

const session = { id: 's1' }
const callEvent = (data: unknown, surfaceOp?: unknown) => ({
  type: 'tool/call',
  surfaceOp,
  data,
})

describe('observation payloads', () => {
  it('reports call_start with the mcp__server__tool namespace split', async () => {
    const { ctx, calls } = setup()
    ctx.emit('session/event', session, callEvent({ callId: 'c1', name: 'mcp__github__create_issue' }))
    await flush()
    expect(calls[0]?.url).toBe('http://127.0.0.1:9420/mcp/observation?source=dsh')
    expect(calls[0]?.body).toEqual({
      event: 'call_start',
      session_id: 's1',
      call_id: 'c1',
      server: 'github',
      tool: 'create_issue',
    })
  })

  it('reports call_end success without error fields', async () => {
    const { ctx, calls } = setup()
    ctx.emit('session/event', session, callEvent({ callId: 'c1', name: 'mcp__github__create_issue' }))
    ctx.emit('session/event', session, {
      type: 'tool/result',
      data: { message: { toolCallId: 'c1', isError: false } },
    })
    await flush()
    expect(calls[1]?.body).toEqual({
      event: 'call_end',
      session_id: 's1',
      call_id: 'c1',
      server: 'github',
      tool: 'create_issue',
      status: 'success',
    })
  })

  it('reports call_end failure with reason and numeric code', async () => {
    const { ctx, calls } = setup()
    ctx.emit('session/event', session, callEvent({ callId: 'c9', name: 'mcp__fs__read_file' }))
    ctx.emit('session/event', session, {
      type: 'tool/result',
      data: {
        message: { toolCallId: 'c9', isError: true },
        error: { name: 'TimeoutError', info: { code: -32000 } },
      },
    })
    await flush()
    expect(calls[1]?.body).toEqual({
      event: 'call_end',
      session_id: 's1',
      call_id: 'c9',
      server: 'fs',
      tool: 'read_file',
      status: 'failed',
      error_category: 'tool_error',
      error_phase: 'response',
      failure_kind: 'tool_error',
      error_reason: 'TimeoutError',
      error_code: -32000,
    })
  })

  it('marks isError results failed even without an error object', async () => {
    const { ctx, calls } = setup()
    ctx.emit('session/event', session, callEvent({ callId: 'c2', name: 'mcp__web__fetch' }))
    ctx.emit('session/event', session, {
      type: 'tool/result',
      data: { message: { toolCallId: 'c2', isError: true } },
    })
    await flush()
    expect(calls[1]?.body).toMatchObject({ status: 'failed', error_category: 'tool_error' })
  })
})

describe('observation filtering', () => {
  it.each([
    ['non-mcp tool name', { callId: 'c1', name: 'read_file' }],
    ['missing callId', { callId: '', name: 'mcp__github__create_issue' }],
    ['server-only name', { callId: 'c1', name: 'mcp__github' }],
    ['empty tool part', { callId: 'c1', name: 'mcp__github__' }],
  ])('ignores tool/call with %s', async (_label, data) => {
    const { ctx, calls } = setup()
    ctx.emit('session/event', session, callEvent(data))
    await flush()
    expect(calls.length).toBe(0)
  })

  it('ignores surface replacements (surfaceOp not append)', async () => {
    const { ctx, calls } = setup()
    ctx.emit('session/event', session,
      callEvent({ callId: 'c1', name: 'mcp__github__create_issue' }, { op: 'replace', startSeq: 1, endSeq: 2 }))
    await flush()
    expect(calls.length).toBe(0)
  })

  it('ignores call_end without a remembered call_start', async () => {
    const { ctx, calls } = setup()
    ctx.emit('session/event', session, {
      type: 'tool/result',
      data: { message: { toolCallId: 'unknown' } },
    })
    await flush()
    expect(calls.length).toBe(0)
  })

  it('falls back to session.header.id and skips id-less sessions', async () => {
    const { ctx, calls } = setup()
    ctx.emit('session/event', { header: { id: 'h1' } }, callEvent({ callId: 'c1', name: 'mcp__a__b' }))
    ctx.emit('session/event', {}, callEvent({ callId: 'c2', name: 'mcp__a__b' }))
    await flush()
    expect(calls.length).toBe(1)
    expect(calls[0]?.body['session_id']).toBe('h1')
  })

  it('evicts the oldest remembered call at maxPending', async () => {
    const { ctx, calls } = setup({ maxPending: 2 })
    ctx.emit('session/event', session, callEvent({ callId: 'c1', name: 'mcp__a__b' }))
    ctx.emit('session/event', session, callEvent({ callId: 'c2', name: 'mcp__a__b' }))
    ctx.emit('session/event', session, callEvent({ callId: 'c3', name: 'mcp__a__b' }))
    await flush()
    // c1 was evicted: its call_end is dropped, c2's still pairs.
    ctx.emit('session/event', session, {
      type: 'tool/result',
      data: { message: { toolCallId: 'c1' } },
    })
    ctx.emit('session/event', session, {
      type: 'tool/result',
      data: { message: { toolCallId: 'c2' } },
    })
    await flush()
    const events = calls.map((call) => call.body['event'])
    expect(events).toEqual(['call_start', 'call_start', 'call_start', 'call_end'])
  })
})
