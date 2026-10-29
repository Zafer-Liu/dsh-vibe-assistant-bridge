import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, Config, inject, name } from '../src/index'
import { fakeContext } from './helpers'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('plugin entry', () => {
  it('exports the cordis plugin surface', () => {
    expect(name).toBe('vibe-assistant-bridge')
    expect(Array.isArray(inject)).toBe(true)
    expect(Config['~standard'].version).toBe(1)
  })

  it('registers every event listener under the default config', () => {
    const ctx = fakeContext()
    apply(ctx, undefined)
    const registered = ctx.on.mock.calls.map((call) => call[0] as string)
    expect(registered).toContain('agent/pre-step')
    expect(registered.filter((event) => event === 'session/event').length).toBe(2)
    expect(registered).toContain('agent/turn-stopping')
    // Tools register eagerly via inject=['tools']; no service-binding event.
    expect(registered).not.toContain('internal/service')
  })

  it('feature flags gate each listener', () => {
    const ctx = fakeContext()
    apply(ctx, { features: { injection: false, usage: false, collect: false } })
    const registered = ctx.on.mock.calls.map((call) => call[0] as string)
    expect(registered).not.toContain('agent/pre-step')
    expect(registered).not.toContain('agent/turn-stopping')
    expect(registered.filter((event) => event === 'session/event').length).toBe(1)
  })

  it('survives garbage config without throwing', () => {
    const ctx = fakeContext()
    expect(() => apply(ctx, 'nonsense')).not.toThrow()
    expect(() => apply(ctx, null)).not.toThrow()
  })

  it('one feature failing to activate does not block the others', () => {
    const ctx = fakeContext()
    // Force one setup to throw by making `on` reject a single event name.
    const original = ctx.on
    const on = vi.fn((event: string, listener: (...args: never[]) => unknown) => {
      if (event === 'agent/pre-step') throw new Error('boom')
      return original(event, listener)
    })
    const broken = { ...ctx, on }
    apply(broken, undefined)
    const registered = original.mock.calls.map((call) => call[0] as string)
    expect(registered).not.toContain('agent/pre-step')
    expect(registered.filter((event) => event === 'session/event').length).toBe(2)
    expect(broken.logger.warn).toHaveBeenCalled()
  })
})
