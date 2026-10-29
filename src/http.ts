import type { BridgeConfig } from './config'

/**
 * Shared HTTP channel to the local Vibe Assistant instance.
 *
 * Two calling conventions mirror the two legacy embedded plugins:
 * - `request()` is awaited (injection pull, tool execute) and propagates
 *   failures to its caller, which owns the fallback/error behavior.
 * - `fire()` is a fire-and-forget report (observation/usage/collect): it is
 *   capped by `maxInflight` concurrent posts and fails silently, because a
 *   reporting hiccup must never disturb the host session.
 */
export class BridgeHttp {
  private readonly endpoint: string
  private readonly timeoutMs: number
  private readonly maxInflight: number
  private readonly inflight = new Set<Promise<unknown>>()

  constructor(config: Pick<BridgeConfig, 'endpoint' | 'timeoutMs' | 'maxInflight'>) {
    this.endpoint = config.endpoint
    this.timeoutMs = config.timeoutMs
    this.maxInflight = config.maxInflight
  }

  /** Resolve a bridge path (or pass through an already-absolute URL). */
  url(path: string): string {
    if (path.startsWith('http://') || path.startsWith('https://')) return path
    return this.endpoint + (path.startsWith('/') ? path : `/${path}`)
  }

  /**
   * POST a JSON body and await the raw response. Throws on transport failure
   * or timeout; HTTP error statuses are the caller's to interpret.
   */
  async request(
    path: string,
    body: unknown,
    extraSignal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<Response> {
    const timeout = AbortSignal.timeout(timeoutMs ?? this.timeoutMs)
    const signal = extraSignal === undefined ? timeout : AbortSignal.any([timeout, extraSignal])
    return await fetch(this.url(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal,
    })
  }

  /**
   * POST a JSON report without waiting for it. Never throws: transport
   * failures are swallowed and over-cap posts are dropped on the floor.
   */
  fire(path: string, body: unknown): void {
    if (this.inflight.size >= this.maxInflight) return
    const task = fetch(this.url(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
      .catch(() => {})
      .finally(() => {
        this.inflight.delete(task)
      })
    this.inflight.add(task)
  }
}
