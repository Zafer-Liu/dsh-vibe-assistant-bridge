import type { BridgeHttp } from './http'

/**
 * Session collection trigger: when an agent's turn is about to close
 * (`agent/turn-stopping` — the model owes no response and the boundary is
 * about to commit), notify Vibe Assistant (`POST /collect/trigger?source=dsh`)
 * so it can run L0→L1 memory extraction for that session immediately,
 * without waiting for the next transcript scan cycle.
 *
 * The listener is awaited by the host, so the POST is fired without awaiting
 * it: Vibe Assistant schedules collection in the background and answers 202
 * immediately, and a slow or absent Vibe Assistant must never delay the turn
 * boundary.
 */

interface TurnStoppingPayload {
  agent?: { session?: { id?: string } }
}

export interface CollectContext {
  on(event: string, listener: (...args: never[]) => unknown): unknown
}

export function setupCollect(ctx: CollectContext, http: BridgeHttp): void {
  const url = http.url('/collect/trigger?source=dsh')

  ctx.on('agent/turn-stopping', (payload: TurnStoppingPayload) => {
    try {
      const sessionId = typeof payload?.agent?.session?.id === 'string'
        ? payload.agent.session.id
        : ''
      if (sessionId === '') return
      http.fire(url, { session_id: sessionId })
    } catch {}
  })
}
