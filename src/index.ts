/**
 * dsh-vibe-assistant-bridge — bridges DeepSeek Harness (dsh) sessions to a
 * local Vibe Assistant instance over loopback HTTP.
 *
 * One bundle, six capabilities across five modules:
 * - memory injection  (`agent/pre-step`  → `POST /memory/context`)
 * - MCP observation   (`session/event`   → `POST /mcp/observation`)
 * - usage reporting   (`session/event`   → `POST /telemetry/usage`)
 * - collect triggers  (`agent/turn-stopping` → `POST /collect/trigger`)
 * - memory tools      (`ctx.tools.register` → `/memory/recall`, `/memory/profile`)
 * - skill tools       (`ctx.tools.register` → `/skills/list`, `/skills/read`)
 *
 * Runtime has zero npm dependencies (Node builtins only). Every feature is
 * independently try/catch-isolated at setup and gated by `config.features`;
 * without Vibe Assistant running, listeners degrade silently and the tools
 * return readable errors.
 *
 * @module dsh-vibe-assistant-bridge
 */

import { Config, resolveConfig, type BridgeConfig } from './config'
import { BridgeHttp } from './http'
import { setupInjection } from './injection'
import { setupObservation } from './observation'
import { setupUsage } from './usage'
import { setupCollect } from './collect'
import { setupTools } from './tools'

/** Entry id shared with the `- insert:` row in cordis.patch.yml. */
export const name = 'vibe-assistant-bridge'

/**
 * `tools` is a hard requirement for the tool feature: cordis guarantees the
 * service is injected before `apply` runs (the same contract
 * `@deepseek-ai/dsh-mcp-client` relies on). The remaining four features only
 * subscribe to lifecycle events and need no injected services.
 */
export const inject: string[] = ['tools']

export { Config }
export type { BridgeConfig }

export interface PluginContext {
  on(event: string, listener: (...args: never[]) => unknown): unknown
  logger?: { warn?: (message?: string, ...args: unknown[]) => void }
}

export function apply(ctx: PluginContext, rawConfig?: unknown): void {
  const config = resolveConfig(rawConfig)
  const http = new BridgeHttp(config)

  const features: ReadonlyArray<readonly [keyof BridgeConfig['features'], string, () => void]> = [
    ['injection', 'memory injection', () => setupInjection(ctx, config, http)],
    ['observation', 'MCP observation', () => setupObservation(ctx, config, http)],
    ['usage', 'token usage reporting', () => setupUsage(ctx, http)],
    ['collect', 'collection trigger', () => setupCollect(ctx, http)],
    // The `internal/service` listener below was a speculative lazy-binding
    // fallback for a guessed event name that does not exist in cordis — tools
    // are injected before `apply` via `inject = ["tools"]`, so registration
    // happens eagerly in setupTools and no service event is subscribed.
    ['tools', 'memory and skill tools', () => setupTools(ctx, config, http)],
  ]

  for (const [flag, label, setup] of features) {
    if (config.features[flag] === false) continue
    try {
      setup()
    } catch (error) {
      ctx.logger?.warn?.(
        `vibe-assistant-bridge: ${label} feature failed to activate: ${String(error)}`,
      )
    }
  }
}
