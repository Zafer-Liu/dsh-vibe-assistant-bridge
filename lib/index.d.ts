/** Per-feature switches. Every feature defaults to enabled. */
interface FeatureFlags {
  readonly injection: boolean;
  readonly observation: boolean;
  readonly usage: boolean;
  readonly collect: boolean;
  readonly tools: boolean;
}
/** Fully resolved runtime configuration; every field is valid and defaulted. */
interface BridgeConfig {
  readonly endpoint: string;
  readonly timeoutMs: number;
  readonly maxInflight: number;
  readonly maxPending: number;
  /** Offline injection fallback; `null` disables the snapshot fallback. */
  readonly snapshotPath: string | null;
  readonly features: FeatureFlags;
}
/**
 * Config schema export for the cordis loader, in Standard Schema form
 * (`Config["~standard"].validate`). Hand-rolled instead of schemastery so the
 * plugin keeps zero runtime npm dependencies; validation is lenient — every
 * invalid field resolves to its default and never produces issues.
 */
export declare const Config: {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: "dsh-vibe-assistant-bridge";
    readonly validate: (raw: unknown) => {
      value: BridgeConfig;
    };
  };
};
/** Entry id shared with the `- insert:` row in cordis.patch.yml. */
export declare const name = "vibe-assistant-bridge";
/**
 * `tools` is a hard requirement for the tool feature: cordis guarantees the
 * service is injected before `apply` runs (the same contract
 * `@deepseek-ai/dsh-mcp-client` relies on). The remaining four features only
 * subscribe to lifecycle events and need no injected services.
 */
export declare const inject: string[];
export interface PluginContext {
  on(event: string, listener: (...args: never[]) => unknown): unknown;
  logger?: {
    warn?: (message?: string, ...args: unknown[]) => void;
  };
}
export declare function apply(ctx: PluginContext, rawConfig?: unknown): void;
export type { BridgeConfig };