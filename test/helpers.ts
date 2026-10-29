import { vi } from 'vitest'

export type OnFn = (event: string, listener: (...args: never[]) => unknown) => void
export type WarnFn = (message?: string, ...args: unknown[]) => void

export interface FakeContext {
  on: ReturnType<typeof vi.fn<OnFn>>
  emit(event: string, ...args: unknown[]): unknown
  listenersOf(event: string): Array<(...args: never[]) => unknown>
  logger: { warn: ReturnType<typeof vi.fn<WarnFn>> }
}

/** Minimal plugin context fake: captures listeners per event name. */
export function fakeContext(): FakeContext {
  const listeners = new Map<string, Array<(...args: never[]) => unknown>>()
  const logger = { warn: vi.fn<WarnFn>() }
  const on = vi.fn<OnFn>((event, listener) => {
    const list = listeners.get(event) ?? []
    list.push(listener)
    listeners.set(event, list)
  })
  return {
    on,
    emit(event: string, ...args: unknown[]) {
      const list = listeners.get(event) ?? []
      if (list.length === 0) throw new Error(`no listener registered for ${event}`)
      return list[0]!(...(args as never[]))
    },
    listenersOf(event: string) {
      return listeners.get(event) ?? []
    },
    logger,
  }
}

/** Mocked global fetch queue: each POST pops the next scripted response. */
export function fakeFetchQueue(responses: Array<Response | Promise<Response> | Error>) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    })
    const next = responses.shift()
    if (next === undefined) throw new Error('fake fetch queue exhausted')
    if (next instanceof Error) throw next
    return next
  })
  return { fetchMock, calls }
}

/** Let fire-and-forget posts (and their catch/finally chains) settle. */
export const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}
