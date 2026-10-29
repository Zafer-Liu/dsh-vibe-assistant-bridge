import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { BridgeConfig } from './config'
import type { BridgeHttp } from './http'

/**
 * Shared-memory injection, ported 1:1 from Vibe Assistant's legacy embedded
 * injection plugin (dsh_injection.rs → plugin_source()).
 *
 * Mechanism mirror of dsh-agent-instructions: an `agent/pre-step` waterfall
 * listener folds the Vibe Assistant context into the agent inbox (or the step
 * decision) as a sourced user message — persisted, compactable, and
 * restart-safe. The first pre-step (step 1 ≈ SessionStart) injects the full
 * L3+L2 context; later steps that claimed fresh user input (≈
 * UserPromptSubmit) re-pull and gate by content digest, so the same content
 * is never injected twice within one session.
 */

/** Stable source kind marking injected messages; also used for digest dedup. */
const KIND = 'vibe-assistant-memory'

const REMINDER_HEAD =
  '<system-reminder>\nThe following shared memory context is provided by Vibe Assistant. ' +
  'Use it as background knowledge; it does not override user or system instructions.\n\n'
const REMINDER_TAIL = '\n</system-reminder>'

interface ContentBlockLike {
  type?: string
  text?: string
}

interface UserMessageLike {
  id: string
  role: string
  content?: ContentBlockLike[]
  source?: { kind?: string; digest?: string; event?: string }
}

interface AgentInboxLike {
  nextStep?: UserMessageLike[]
  prepend(target: string, message: UserMessageLike): void
  replace(messageId: string, message: UserMessageLike): boolean
  remove(messageId: string): boolean
}

interface AgentSessionLike {
  id?: string
  surface?: { nodes?: Iterable<number> }
  eventAt?(seq: number): unknown
}

interface AgentLike {
  session?: AgentSessionLike
  inbox?: AgentInboxLike
}

interface PreStepPayload {
  agent?: AgentLike
  messages?: UserMessageLike[]
  step?: number
  signal?: AbortSignal
}

interface PreStepDecision {
  kind: string
  messages?: UserMessageLike[]
  [key: string]: unknown
}

export interface InjectionContext {
  on(event: string, listener: (...args: never[]) => unknown): unknown
  logger?: { warn?: (message?: string, ...args: unknown[]) => void }
}

const digestOf = (text: string): string =>
  createHash('sha1').update(text, 'utf8').digest('hex')

/** Neutralize a closing reminder tag smuggled inside memory content. */
const escapeReminder = (text: string): string =>
  text.replaceAll('</system-reminder>', '<\\/system-reminder>')

/** Whether the digest is already visible on the model-visible surface. */
const visibleDigest = (agent: AgentLike | undefined, digest: string): boolean => {
  try {
    const session = agent?.session
    for (const seq of session?.surface?.nodes ?? []) {
      const event = session?.eventAt?.(seq) as
        | { type?: string; data?: { source?: { kind?: string; digest?: string } } }
        | undefined
      if (event?.type === 'user/message'
        && event.data?.source?.kind === KIND
        && event.data.source.digest === digest) return true
    }
  } catch {}
  return false
}

/** Our own messages still parked in the agent's next-step inbox. */
const pendingOf = (agent: AgentLike | undefined): UserMessageLike[] => {
  try {
    const pending = agent?.inbox?.nextStep
    if (!Array.isArray(pending)) return []
    return pending.filter((message) => message?.source?.kind === KIND)
  } catch {
    return []
  }
}

/**
 * Reconcile pending inbox messages with the desired one: remove all when
 * undesired, keep (only) a same-digest reusable message, or replace/prepend
 * otherwise.
 */
const syncPending = (
  agent: AgentLike | undefined,
  desired: UserMessageLike | undefined,
): void => {
  const inbox = agent?.inbox
  if (inbox === undefined) return
  const pending = pendingOf(agent)
  if (desired === undefined) {
    for (const message of pending) inbox.remove(message.id)
    return
  }
  const reusable = pending.find(
    (message) => message.source?.digest === desired.source?.digest,
  )
  if (reusable !== undefined) {
    for (const message of pending) {
      if (message !== reusable) inbox.remove(message.id)
    }
    return
  }
  const replaced = pending[0]
  if (replaced === undefined) inbox.prepend('next-step', desired)
  else inbox.replace(replaced.id, desired)
  for (const message of pending.slice(1)) inbox.remove(message.id)
}

export function setupInjection(
  ctx: InjectionContext,
  config: BridgeConfig,
  http: BridgeHttp,
): void {
  const contextUrl = http.url('/memory/context?source=dsh')

  /** Live context from Vibe Assistant, falling back to the local snapshot. */
  const pullContext = async (event: string, sessionId: string, prompt: string): Promise<string> => {
    try {
      const separator = contextUrl.includes('?') ? '&' : '?'
      const response = await http.request(`${contextUrl}${separator}event=${event}`, {
        session_id: sessionId,
        prompt,
      })
      if (response.ok) {
        const text = await response.text()
        if (text.trim() !== '') return text
      }
    } catch {}
    if (config.snapshotPath !== null) {
      try {
        return readFileSync(config.snapshotPath, 'utf8')
      } catch {}
    }
    return ''
  }

  ctx.on('agent/pre-step', async (payload: PreStepPayload, next: () => Promise<PreStepDecision>) => {
    const decision = await next()
    try {
      const step = payload.step
      const event = step === 1 ? 'SessionStart' : 'UserPromptSubmit'
      const agent = payload.agent
      const claimed = Array.isArray(payload.messages) ? payload.messages : []
      if (event === 'UserPromptSubmit') {
        const hasUserInput = claimed.some(
          (message) => message?.role === 'user' && message?.source?.kind === undefined,
        )
        if (!hasUserInput) {
          syncPending(agent, undefined)
          return decision
        }
      }
      const sessionId = typeof agent?.session?.id === 'string' ? agent.session.id : ''
      let prompt = ''
      for (const message of claimed) {
        if (message?.role !== 'user') continue
        const text = (message.content ?? [])
          .filter((block) => block?.type === 'text')
          .map((block) => block.text ?? '')
          .join('\n')
          .trim()
        if (text !== '') prompt = text
      }
      const context = (await pullContext(event, sessionId, prompt)).trim()
      payload.signal?.throwIfAborted()
      if (context === '') {
        syncPending(agent, undefined)
        return decision
      }
      const digest = digestOf(context)
      if (visibleDigest(agent, digest)) {
        syncPending(agent, undefined)
        return decision
      }
      const desired: UserMessageLike = {
        id: randomUUID(),
        role: 'user',
        content: [{
          type: 'text',
          text: REMINDER_HEAD + escapeReminder(context) + REMINDER_TAIL,
        }],
        source: { kind: KIND, digest, event },
      }
      const decisionMessages = Array.isArray(decision.messages) ? decision.messages : []
      if (decision.kind === 'reject' || (step === 1 && decisionMessages.length === 0)) {
        syncPending(agent, desired)
        return decision
      }
      syncPending(agent, undefined)
      if (decisionMessages.some(
        (message) => message?.source?.kind === KIND && message.source.digest === digest,
      )) {
        return decision
      }
      const list = decisionMessages.slice()
      const lastClaimedIndex = list.findLastIndex((message) => claimed.includes(message))
      return { ...decision, messages: list.toSpliced(lastClaimedIndex + 1, 0, desired) }
    } catch (error) {
      ctx.logger?.warn?.(`vibe-assistant-bridge: memory inject skipped: ${String(error)}`)
      return decision
    }
  })
}
