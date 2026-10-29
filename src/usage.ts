import type { BridgeHttp } from './http'

/**
 * Token usage reporting: every committed `assistant/message` session event
 * that carries `usage` becomes one record on Vibe Assistant's telemetry ledger
 * (`POST /telemetry/usage?source=dsh`), keyed per session.
 *
 * `model/selection` events are tracked to attribute each record with the
 * model the session currently uses (DeepSeek reports usage per model call;
 * the selection event is the durable "which model" signal on the session
 * log). `TokenUsage` counts are disjoint: `inputTokens` is uncached input
 * only and cached input arrives as `cacheReadTokens`, so the three forwarded
 * numbers map 1:1 onto the endpoint contract.
 */

interface ModelSelectionData {
  model?: unknown
  name?: unknown
}

interface AssistantMessageData {
  usage?: {
    inputTokens?: unknown
    outputTokens?: unknown
    cacheReadTokens?: unknown
  } | undefined
}

interface SessionLike {
  id?: string
  header?: { id?: string }
}

interface SessionEventLike {
  type?: string
  time?: unknown
  seq?: unknown
  data?: unknown
}

export interface UsageContext {
  on(event: string, listener: (...args: never[]) => unknown): unknown
}

const sessionIdOf = (session: SessionLike | undefined): string => {
  if (typeof session?.id === 'string') return session.id
  if (typeof session?.header?.id === 'string') return session.header.id
  return ''
}

const tokenCount = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

export function setupUsage(ctx: UsageContext, http: BridgeHttp): void {
  const url = http.url('/telemetry/usage?source=dsh')
  const models = new Map<string, string>()

  const listener = (session: SessionLike, event: SessionEventLike): void => {
    try {
      const sessionId = sessionIdOf(session)
      if (sessionId === '') return
      const type = event?.type
      const data = event?.data
      if (type === 'model/selection') {
        const selection = data as ModelSelectionData
        const model = typeof selection?.model === 'string' && selection.model !== ''
          ? selection.model
          : selection?.name
        if (typeof model === 'string' && model !== '') models.set(sessionId, model)
        return
      }
      if (type !== 'assistant/message') return
      const usage = (data as AssistantMessageData)?.usage
      const input = tokenCount(usage?.inputTokens)
      const output = tokenCount(usage?.outputTokens)
      const cached = tokenCount(usage?.cacheReadTokens)
      // `usage` is absent when the adapter reported none — nothing to record.
      if (input === undefined && output === undefined && cached === undefined) return
      const body: Record<string, unknown> = {
        session_id: sessionId,
        input_tokens: input ?? 0,
        output_tokens: output ?? 0,
        cached_tokens: cached ?? 0,
      }
      const model = models.get(sessionId)
      if (model !== undefined) body['model'] = model
      if (typeof event.time === 'number' && Number.isFinite(event.time)) {
        body['occurred_at'] = new Date(event.time).toISOString()
      }
      // 幂等契约：message_id 必须等于会话日志事件的 `seq`——智管的转录
      // 扫描路径按 usage_record_id("dsh", session, "message", seq) 建主键，
      // 插件上报同一 seq 才能让两条采集路径对同一条 assistant/message
      // 命中同一行（不双计）；缺省时后端退回 model+tokens+occurred_at 组合，
      // 仅保证同路径重试幂等。
      const seq = typeof event.seq === 'number' && Number.isFinite(event.seq)
        ? String(event.seq)
        : typeof event.seq === 'string' && event.seq !== '' ? event.seq : ''
      if (seq !== '') body['message_id'] = seq
      http.fire(url, body)
    } catch {}
  }

  ctx.on('session/event', listener)
}
