import { describe, expect, it } from 'vitest'
import {
  Config,
  DEFAULT_ENDPOINT,
  DEFAULT_MAX_INFLIGHT,
  DEFAULT_MAX_PENDING,
  DEFAULT_TIMEOUT_MS,
  resolveConfig,
} from '../src/config'

describe('config defaults', () => {
  it('fills every field from an absent config', () => {
    const config = resolveConfig(undefined)
    expect(config.endpoint).toBe(DEFAULT_ENDPOINT)
    expect(config.timeoutMs).toBe(DEFAULT_TIMEOUT_MS)
    expect(config.maxInflight).toBe(DEFAULT_MAX_INFLIGHT)
    expect(config.maxPending).toBe(DEFAULT_MAX_PENDING)
    expect(config.snapshotPath).toMatch(/vibe-assistant-memory-snapshot\.md$/)
    expect(config.features).toEqual({
      injection: true,
      observation: true,
      usage: true,
      collect: true,
      tools: true,
    })
  })

  it('keeps valid overrides and strips a trailing endpoint slash', () => {
    const config = resolveConfig({
      endpoint: 'http://127.0.0.1:9999///',
      timeoutMs: 5000,
      maxInflight: 4,
      maxPending: 100,
      snapshotPath: '/tmp/snapshot.md',
      features: { injection: false },
    })
    expect(config.endpoint).toBe('http://127.0.0.1:9999')
    expect(config.timeoutMs).toBe(5000)
    expect(config.maxInflight).toBe(4)
    expect(config.maxPending).toBe(100)
    expect(config.snapshotPath).toBe('/tmp/snapshot.md')
    expect(config.features.injection).toBe(false)
    expect(config.features.observation).toBe(true)
  })

  it('falls back to defaults on garbage values (fault tolerance)', () => {
    const config = resolveConfig({
      endpoint: 42,
      timeoutMs: 'fast',
      maxInflight: -3,
      maxPending: 0,
      snapshotPath: '   ',
      features: 'all',
    })
    expect(config.endpoint).toBe(DEFAULT_ENDPOINT)
    expect(config.timeoutMs).toBe(DEFAULT_TIMEOUT_MS)
    expect(config.maxInflight).toBe(DEFAULT_MAX_INFLIGHT)
    expect(config.maxPending).toBe(DEFAULT_MAX_PENDING)
    expect(config.features.tools).toBe(true)
  })

  it('truncates fractional numeric fields', () => {
    const config = resolveConfig({ timeoutMs: 2500.9, maxInflight: 2.7 })
    expect(config.timeoutMs).toBe(2500)
    expect(config.maxInflight).toBe(2)
  })

  it('treats null snapshotPath as disabled and empty string as default', () => {
    expect(resolveConfig({ snapshotPath: null }).snapshotPath).toBeNull()
    expect(resolveConfig({ snapshotPath: '' }).snapshotPath).not.toBeNull()
  })

  it('is idempotent (resolved config re-resolves to itself)', () => {
    const once = resolveConfig({ endpoint: 'http://127.0.0.1:9420/' })
    expect(resolveConfig(once)).toEqual(once)
  })
})

describe('Config standard schema', () => {
  it('exposes the cordis Standard Schema interface', () => {
    expect(Config['~standard'].version).toBe(1)
    const result = Config['~standard'].validate({ timeoutMs: 'nope' })
    expect(result).not.toHaveProperty('issues')
    expect(result.value.timeoutMs).toBe(DEFAULT_TIMEOUT_MS)
  })
})
