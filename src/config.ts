import { join } from 'node:path'
import { homedir } from 'node:os'

/** Default Vibe Assistant local HTTP endpoint (loopback only, no auth). */
export const DEFAULT_ENDPOINT = 'http://127.0.0.1:9420'

/** Default per-request timeout shared by every bridge HTTP call. */
export const DEFAULT_TIMEOUT_MS = 2000

/** Default cap on concurrent fire-and-forget reports. */
export const DEFAULT_MAX_INFLIGHT = 8

/** Default cap on remembered tool calls awaiting their call_end pairing. */
export const DEFAULT_MAX_PENDING = 512

/**
 * Offline-snapshot path the legacy embedded injection plugin used. Agent
 * Manager keeps refreshing this file when it serves a SessionStart context,
 * so defaulting to it preserves snapshot continuity across the migration
 * from the embedded plugins to this bundle.
 */
export function defaultSnapshotPath(): string {
  return join(homedir(), '.dsh', 'profiles', 'desktop', 'plugins', 'vibe-assistant-memory-snapshot.md')
}

/** Per-feature switches. Every feature defaults to enabled. */
export interface FeatureFlags {
  readonly injection: boolean
  readonly observation: boolean
  readonly usage: boolean
  readonly collect: boolean
  readonly tools: boolean
}

/** Fully resolved runtime configuration; every field is valid and defaulted. */
export interface BridgeConfig {
  readonly endpoint: string
  readonly timeoutMs: number
  readonly maxInflight: number
  readonly maxPending: number
  /** Offline injection fallback; `null` disables the snapshot fallback. */
  readonly snapshotPath: string | null
  readonly features: FeatureFlags
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const positiveInt = (value: unknown, fallback: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return fallback
  return Math.max(1, Math.trunc(value))
}

const resolveEndpoint = (value: unknown): string => {
  if (typeof value !== 'string') return DEFAULT_ENDPOINT
  const trimmed = value.trim().replace(/\/+$/, '')
  return trimmed === '' ? DEFAULT_ENDPOINT : trimmed
}

const resolveSnapshotPath = (value: unknown): string | null => {
  if (value === null) return null
  if (typeof value !== 'string') return defaultSnapshotPath()
  const trimmed = value.trim()
  return trimmed === '' ? defaultSnapshotPath() : trimmed
}

const resolveFeatures = (value: unknown): FeatureFlags => {
  // Only an explicit `false` disables a feature; anything else (including a
  // missing features object) keeps it on, so a malformed override never
  // silently turns the bridge off.
  const raw = isRecord(value) ? value : {}
  return {
    injection: raw['injection'] !== false,
    observation: raw['observation'] !== false,
    usage: raw['usage'] !== false,
    collect: raw['collect'] !== false,
    tools: raw['tools'] !== false,
  }
}

/**
 * Normalize raw plugin config into a fully valid {@link BridgeConfig}.
 * Invalid or missing fields fall back to defaults instead of throwing, so a
 * bad hand-edited patch entry can never break plugin loading.
 */
export function resolveConfig(raw: unknown): BridgeConfig {
  const input = isRecord(raw) ? raw : {}
  return {
    endpoint: resolveEndpoint(input['endpoint']),
    timeoutMs: positiveInt(input['timeoutMs'], DEFAULT_TIMEOUT_MS),
    maxInflight: positiveInt(input['maxInflight'], DEFAULT_MAX_INFLIGHT),
    maxPending: positiveInt(input['maxPending'], DEFAULT_MAX_PENDING),
    snapshotPath: resolveSnapshotPath(input['snapshotPath']),
    features: resolveFeatures(input['features']),
  }
}

/**
 * Config schema export for the cordis loader, in Standard Schema form
 * (`Config["~standard"].validate`). Hand-rolled instead of schemastery so the
 * plugin keeps zero runtime npm dependencies; validation is lenient — every
 * invalid field resolves to its default and never produces issues.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-vibe-assistant-bridge',
    validate(raw: unknown): { value: BridgeConfig } {
      return { value: resolveConfig(raw) }
    },
  },
} as const
