import { join } from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
// src/config.ts
/** Default Vibe Assistant local HTTP endpoint (loopback only, no auth). */
const DEFAULT_ENDPOINT = "http://127.0.0.1:9420";
/** Default per-request timeout shared by every bridge HTTP call. */
const DEFAULT_TIMEOUT_MS = 2e3;
/**
* Offline-snapshot path the legacy embedded injection plugin used. Agent
* Manager keeps refreshing this file when it serves a SessionStart context,
* so defaulting to it preserves snapshot continuity across the migration
* from the embedded plugins to this bundle.
*/
function defaultSnapshotPath() {
	return join(homedir(), ".dsh", "profiles", "desktop", "plugins", "vibe-assistant-memory-snapshot.md");
}
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const positiveInt = (value, fallback) => {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return fallback;
	return Math.max(1, Math.trunc(value));
};
const resolveEndpoint = (value) => {
	if (typeof value !== "string") return DEFAULT_ENDPOINT;
	const trimmed = value.trim().replace(/\/+$/, "");
	return trimmed === "" ? DEFAULT_ENDPOINT : trimmed;
};
const resolveSnapshotPath = (value) => {
	if (value === null) return null;
	if (typeof value !== "string") return defaultSnapshotPath();
	const trimmed = value.trim();
	return trimmed === "" ? defaultSnapshotPath() : trimmed;
};
const resolveFeatures = (value) => {
	const raw = isRecord(value) ? value : {};
	return {
		injection: raw["injection"] !== false,
		observation: raw["observation"] !== false,
		usage: raw["usage"] !== false,
		collect: raw["collect"] !== false,
		tools: raw["tools"] !== false
	};
};
/**
* Normalize raw plugin config into a fully valid {@link BridgeConfig}.
* Invalid or missing fields fall back to defaults instead of throwing, so a
* bad hand-edited patch entry can never break plugin loading.
*/
function resolveConfig(raw) {
	const input = isRecord(raw) ? raw : {};
	return {
		endpoint: resolveEndpoint(input["endpoint"]),
		timeoutMs: positiveInt(input["timeoutMs"], DEFAULT_TIMEOUT_MS),
		maxInflight: positiveInt(input["maxInflight"], 8),
		maxPending: positiveInt(input["maxPending"], 512),
		snapshotPath: resolveSnapshotPath(input["snapshotPath"]),
		features: resolveFeatures(input["features"])
	};
}
/**
* Config schema export for the cordis loader, in Standard Schema form
* (`Config["~standard"].validate`). Hand-rolled instead of schemastery so the
* plugin keeps zero runtime npm dependencies; validation is lenient — every
* invalid field resolves to its default and never produces issues.
*/
const Config = { "~standard": {
	version: 1,
	vendor: "dsh-vibe-assistant-bridge",
	validate(raw) {
		return { value: resolveConfig(raw) };
	}
} };
// src/http.ts
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
var BridgeHttp = class {
	endpoint;
	timeoutMs;
	maxInflight;
	inflight = /* @__PURE__ */ new Set();
	constructor(config) {
		this.endpoint = config.endpoint;
		this.timeoutMs = config.timeoutMs;
		this.maxInflight = config.maxInflight;
	}
	/** Resolve a bridge path (or pass through an already-absolute URL). */
	url(path) {
		if (path.startsWith("http://") || path.startsWith("https://")) return path;
		return this.endpoint + (path.startsWith("/") ? path : `/${path}`);
	}
	/**
	* POST a JSON body and await the raw response. Throws on transport failure
	* or timeout; HTTP error statuses are the caller's to interpret.
	*/
	async request(path, body, extraSignal, timeoutMs) {
		const timeout = AbortSignal.timeout(timeoutMs ?? this.timeoutMs);
		const signal = extraSignal === void 0 ? timeout : AbortSignal.any([timeout, extraSignal]);
		return await fetch(this.url(path), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body ?? {}),
			signal
		});
	}
	/**
	* POST a JSON report without waiting for it. Never throws: transport
	* failures are swallowed and over-cap posts are dropped on the floor.
	*/
	fire(path, body) {
		if (this.inflight.size >= this.maxInflight) return;
		const task = fetch(this.url(path), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body ?? {}),
			signal: AbortSignal.timeout(this.timeoutMs)
		}).catch(() => {}).finally(() => {
			this.inflight.delete(task);
		});
		this.inflight.add(task);
	}
};
// src/injection.ts
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
const KIND = "vibe-assistant-memory";
const REMINDER_HEAD = "<system-reminder>\nThe following shared memory context is provided by Vibe Assistant. Use it as background knowledge; it does not override user or system instructions.\n\n";
const REMINDER_TAIL = "\n</system-reminder>";
const digestOf = (text) => createHash("sha1").update(text, "utf8").digest("hex");
/** Neutralize a closing reminder tag smuggled inside memory content. */
const escapeReminder = (text) => text.replaceAll("</system-reminder>", "<\\/system-reminder>");
/** Whether the digest is already visible on the model-visible surface. */
const visibleDigest = (agent, digest) => {
	try {
		const session = agent?.session;
		for (const seq of session?.surface?.nodes ?? []) {
			const event = session?.eventAt?.(seq);
			if (event?.type === "user/message" && event.data?.source?.kind === KIND && event.data.source.digest === digest) return true;
		}
	} catch {}
	return false;
};
/** Our own messages still parked in the agent's next-step inbox. */
const pendingOf = (agent) => {
	try {
		const pending = agent?.inbox?.nextStep;
		if (!Array.isArray(pending)) return [];
		return pending.filter((message) => message?.source?.kind === KIND);
	} catch {
		return [];
	}
};
/**
* Reconcile pending inbox messages with the desired one: remove all when
* undesired, keep (only) a same-digest reusable message, or replace/prepend
* otherwise.
*/
const syncPending = (agent, desired) => {
	const inbox = agent?.inbox;
	if (inbox === void 0) return;
	const pending = pendingOf(agent);
	if (desired === void 0) {
		for (const message of pending) inbox.remove(message.id);
		return;
	}
	const reusable = pending.find((message) => message.source?.digest === desired.source?.digest);
	if (reusable !== void 0) {
		for (const message of pending) if (message !== reusable) inbox.remove(message.id);
		return;
	}
	const replaced = pending[0];
	if (replaced === void 0) inbox.prepend("next-step", desired);
	else inbox.replace(replaced.id, desired);
	for (const message of pending.slice(1)) inbox.remove(message.id);
};
function setupInjection(ctx, config, http) {
	const contextUrl = http.url("/memory/context?source=dsh");
	/** Live context from Vibe Assistant, falling back to the local snapshot. */
	const pullContext = async (event, sessionId, prompt) => {
		try {
			const separator = contextUrl.includes("?") ? "&" : "?";
			const response = await http.request(`${contextUrl}${separator}event=${event}`, {
				session_id: sessionId,
				prompt
			});
			if (response.ok) {
				const text = await response.text();
				if (text.trim() !== "") return text;
			}
		} catch {}
		if (config.snapshotPath !== null) try {
			return readFileSync(config.snapshotPath, "utf8");
		} catch {}
		return "";
	};
	ctx.on("agent/pre-step", async (payload, next) => {
		const decision = await next();
		try {
			const step = payload.step;
			const event = step === 1 ? "SessionStart" : "UserPromptSubmit";
			const agent = payload.agent;
			const claimed = Array.isArray(payload.messages) ? payload.messages : [];
			if (event === "UserPromptSubmit") {
				if (!claimed.some((message) => message?.role === "user" && message?.source?.kind === void 0)) {
					syncPending(agent, void 0);
					return decision;
				}
			}
			const sessionId = typeof agent?.session?.id === "string" ? agent.session.id : "";
			let prompt = "";
			for (const message of claimed) {
				if (message?.role !== "user") continue;
				const text = (message.content ?? []).filter((block) => block?.type === "text").map((block) => block.text ?? "").join("\n").trim();
				if (text !== "") prompt = text;
			}
			const context = (await pullContext(event, sessionId, prompt)).trim();
			payload.signal?.throwIfAborted();
			if (context === "") {
				syncPending(agent, void 0);
				return decision;
			}
			const digest = digestOf(context);
			if (visibleDigest(agent, digest)) {
				syncPending(agent, void 0);
				return decision;
			}
			const desired = {
				id: randomUUID(),
				role: "user",
				content: [{
					type: "text",
					text: REMINDER_HEAD + escapeReminder(context) + REMINDER_TAIL
				}],
				source: {
					kind: KIND,
					digest,
					event
				}
			};
			const decisionMessages = Array.isArray(decision.messages) ? decision.messages : [];
			if (decision.kind === "reject" || step === 1 && decisionMessages.length === 0) {
				syncPending(agent, desired);
				return decision;
			}
			syncPending(agent, void 0);
			if (decisionMessages.some((message) => message?.source?.kind === KIND && message.source.digest === digest)) return decision;
			const list = decisionMessages.slice();
			const lastClaimedIndex = list.findLastIndex((message) => claimed.includes(message));
			return {
				...decision,
				messages: list.toSpliced(lastClaimedIndex + 1, 0, desired)
			};
		} catch (error) {
			ctx.logger?.warn?.(`vibe-assistant-bridge: memory inject skipped: ${String(error)}`);
			return decision;
		}
	});
}
// src/observation.ts
/**
* MCP call observation, ported 1:1 from Vibe Assistant's legacy embedded
* observe plugin (dsh_observe.rs → plugin_source()).
*
* Listens to `session/event` for `tool/call` / `tool/result` pairs, keeps the
* `mcp__<server>__<tool>` namespace split, and reports call boundaries to
* Vibe Assistant (`POST /mcp/observation?source=dsh`). Tool arguments and
* result bodies are never reported — only the call identity and the
* success/failure classification.
*/
const MCP_PREFIX = "mcp__";
const sessionIdOf$1 = (session) => {
	if (typeof session?.id === "string") return session.id;
	if (typeof session?.header?.id === "string") return session.header.id;
	return "";
};
/** Split `mcp__<server>__<tool>` into its namespace pair, else undefined. */
const splitToolName = (name) => {
	if (typeof name !== "string" || !name.startsWith(MCP_PREFIX)) return void 0;
	const rest = name.slice(5);
	const index = rest.indexOf("__");
	if (index <= 0) return void 0;
	const server = rest.slice(0, index);
	const tool = rest.slice(index + 2);
	if (server === "" || tool === "") return void 0;
	return {
		server,
		tool
	};
};
function setupObservation(ctx, config, http) {
	const url = http.url("/mcp/observation?source=dsh");
	const pending = /* @__PURE__ */ new Map();
	const post = (payload) => {
		http.fire(url, payload);
	};
	/** Remember a call_start under its key, evicting the oldest when full. */
	const remember = (key, value) => {
		if (pending.size >= config.maxPending) {
			const oldest = pending.keys().next().value;
			if (oldest !== void 0) pending.delete(oldest);
		}
		pending.set(key, value);
	};
	/** Classify a tool/result into the call_end status/failure fields. */
	const failureOf = (data) => {
		const message = data?.message;
		const error = data?.error;
		if (!(message?.isError === true || error !== void 0 && error !== null)) return { status: "success" };
		const payload = {
			status: "failed",
			error_category: "tool_error",
			error_phase: "response",
			failure_kind: "tool_error"
		};
		const name = error?.name;
		if (typeof name === "string" && name !== "") payload["error_reason"] = name;
		const code = error?.info?.code ?? error?.code;
		if (typeof code === "number" && Number.isSafeInteger(code)) payload["error_code"] = code;
		return payload;
	};
	const listener = (session, event) => {
		try {
			const sessionId = sessionIdOf$1(session);
			if (sessionId === "") return;
			const surfaceOp = event?.surfaceOp;
			if (surfaceOp !== void 0 && surfaceOp !== "append") return;
			const type = event?.type;
			const data = event?.data;
			if (data === void 0 || data === null) return;
			if (type === "tool/call") {
				const call = data;
				const parsed = splitToolName(call.name);
				const callId = typeof call.callId === "string" ? call.callId : "";
				if (parsed === void 0 || callId === "") return;
				remember(sessionId + ":" + callId, parsed);
				post({
					event: "call_start",
					session_id: sessionId,
					call_id: callId,
					server: parsed.server,
					tool: parsed.tool
				});
				return;
			}
			if (type === "tool/result") {
				const result = data;
				const callId = typeof result.message?.toolCallId === "string" ? result.message.toolCallId : "";
				if (callId === "") return;
				const key = sessionId + ":" + callId;
				const started = pending.get(key);
				if (started === void 0) return;
				pending.delete(key);
				post({
					event: "call_end",
					session_id: sessionId,
					call_id: callId,
					server: started.server,
					tool: started.tool,
					...failureOf(result)
				});
			}
		} catch {}
	};
	ctx.on("session/event", listener);
}
// src/usage.ts
const sessionIdOf = (session) => {
	if (typeof session?.id === "string") return session.id;
	if (typeof session?.header?.id === "string") return session.header.id;
	return "";
};
const tokenCount = (value) => typeof value === "number" && Number.isFinite(value) ? value : void 0;
function setupUsage(ctx, http) {
	const url = http.url("/telemetry/usage?source=dsh");
	const models = /* @__PURE__ */ new Map();
	const listener = (session, event) => {
		try {
			const sessionId = sessionIdOf(session);
			if (sessionId === "") return;
			const type = event?.type;
			const data = event?.data;
			if (type === "model/selection") {
				const selection = data;
				const model = typeof selection?.model === "string" && selection.model !== "" ? selection.model : selection?.name;
				if (typeof model === "string" && model !== "") models.set(sessionId, model);
				return;
			}
			if (type !== "assistant/message") return;
			const usage = data?.usage;
			const input = tokenCount(usage?.inputTokens);
			const output = tokenCount(usage?.outputTokens);
			const cached = tokenCount(usage?.cacheReadTokens);
			if (input === void 0 && output === void 0 && cached === void 0) return;
			const body = {
				session_id: sessionId,
				input_tokens: input ?? 0,
				output_tokens: output ?? 0,
				cached_tokens: cached ?? 0
			};
			const model = models.get(sessionId);
			if (model !== void 0) body["model"] = model;
			if (typeof event.time === "number" && Number.isFinite(event.time)) body["occurred_at"] = new Date(event.time).toISOString();
			const seq = typeof event.seq === "number" && Number.isFinite(event.seq) ? String(event.seq) : typeof event.seq === "string" && event.seq !== "" ? event.seq : "";
			if (seq !== "") body["message_id"] = seq;
			http.fire(url, body);
		} catch {}
	};
	ctx.on("session/event", listener);
}
// src/collect.ts
function setupCollect(ctx, http) {
	const url = http.url("/collect/trigger?source=dsh");
	ctx.on("agent/turn-stopping", (payload) => {
		try {
			const sessionId = typeof payload?.agent?.session?.id === "string" ? payload.agent.session.id : "";
			if (sessionId === "") return;
			http.fire(url, { session_id: sessionId });
		} catch {}
	});
}
// src/tools.ts
const jsonText = (value) => JSON.stringify(value, null, 2);
/** Canonical output declaration: any lossless JSON value, rendered as text. */
const passthroughOutput = {
	schema: {},
	render: (_args, value) => [{
		type: "text",
		text: jsonText(value)
	}]
};
const stringArg = (value) => typeof value === "string" && value.trim() !== "" ? value : void 0;
/** Extract the readable error message an HTTP error response carries. */
const readableError = async (response) => {
	let text = "";
	try {
		text = await response.text();
	} catch {}
	const trimmed = text.trim();
	if (trimmed !== "") {
		try {
			const parsed = JSON.parse(trimmed);
			if (typeof parsed?.error === "string" && parsed.error.trim() !== "") return parsed.error;
		} catch {}
		if (trimmed.length <= 300) return trimmed;
		return `Vibe Assistant request failed (HTTP ${response.status}): ${trimmed.slice(0, 200)}...`;
	}
	return `Vibe Assistant request failed (HTTP ${response.status} ${response.statusText})`;
};
/**
* POST one tool request and return the JSON response as the canonical value.
* Transport failures and non-2xx responses throw readable errors (the host
* marks the call `isError`); a readable server error message such as
* "Vibe Assistant 未运行" is relayed verbatim.
*/
const postForValue = async (http, endpoint, path, body, signal) => {
	let response;
	try {
		response = await http.request(path, body, signal, 15e3);
	} catch (error) {
		const cause = error instanceof Error ? ` (${error.message})` : "";
		throw new Error(`Vibe Assistant is not running or unreachable at ${endpoint}${cause}`);
	}
	if (!response.ok) throw new Error(await readableError(response));
	const text = await response.text();
	if (text.trim() === "") return {};
	try {
		return JSON.parse(text);
	} catch {
		throw new Error(`Vibe Assistant returned a non-JSON response (HTTP ${response.status})`);
	}
};
/** The four bridge tools, built from a config and HTTP channel. */
function bridgeToolDefinitions(config, http) {
	const post = (path, build) => async (args, exec) => {
		const source = typeof args === "object" && args !== null ? args : {};
		return await postForValue(http, config.endpoint, path, build(source), exec?.signal);
	};
	return [
		{
			name: "recall_memory",
			description: "Search the user's shared Vibe Assistant memory and return the records most relevant to a query. Use before planning or continuing work when prior decisions or preferences may matter.",
			parameters: {
				type: "object",
				properties: {
					query: {
						type: "string",
						description: "Free-text query describing the memory, decision, or constraint to recall."
					},
					limit: {
						type: "number",
						description: "Maximum number of records to return (1-12, default 6).",
						minimum: 1,
						maximum: 12
					}
				},
				required: ["query"],
				additionalProperties: false
			},
			output: passthroughOutput,
			execute: post("/memory/recall", (args) => {
				const body = { query: stringArg(args["query"]) ?? "" };
				const limit = args["limit"];
				if (typeof limit === "number" && Number.isFinite(limit)) body["limit"] = Math.min(12, Math.max(1, Math.trunc(limit)));
				return body;
			})
		},
		{
			name: "get_user_profile",
			description: "Read the user's long-term Vibe Assistant profile: stable preferences, constraints, and identity markers that apply across projects.",
			parameters: {
				type: "object",
				properties: {},
				additionalProperties: false
			},
			output: passthroughOutput,
			execute: post("/memory/profile", () => ({}))
		},
		{
			name: "list_shared_skills",
			description: "List the published reusable workflow Skills in the user's shared Vibe Assistant Skill library.",
			parameters: {
				type: "object",
				properties: {},
				additionalProperties: false
			},
			output: passthroughOutput,
			execute: post("/skills/list", () => ({}))
		},
		{
			name: "read_shared_skill",
			description: "Read one published Skill from the user's shared Vibe Assistant Skill library by its source namespace and name.",
			parameters: {
				type: "object",
				properties: {
					source: {
						type: "string",
						description: "Skill source namespace returned by list_shared_skills (e.g. \"codex\" or \"claude\")."
					},
					name: {
						type: "string",
						description: "Skill name returned by list_shared_skills."
					}
				},
				required: ["source", "name"],
				additionalProperties: false
			},
			output: passthroughOutput,
			execute: post("/skills/read", (args) => ({
				source: stringArg(args["source"]) ?? "",
				name: stringArg(args["name"]) ?? ""
			}))
		}
	];
}
/**
* Register the four tools. The `tools` service can bind after this plugin
* under the loader's concurrent activation, so registration is retried on
* every `internal/service` event until the registry appears.
*/
function setupTools(ctx, config, http) {
	const tools = ctx.tools;
	if (tools === void 0 || typeof tools.register !== "function") {
		ctx.logger?.warn?.("vibe-assistant-bridge: ctx.tools unavailable at apply time — memory/skill tools not registered");
		return;
	}
	for (const definition of bridgeToolDefinitions(config, http)) tools.register(definition);
}
// src/index.ts
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
/** Entry id shared with the `- insert:` row in cordis.patch.yml. */
const name = "vibe-assistant-bridge";
/**
* `tools` is a hard requirement for the tool feature: cordis guarantees the
* service is injected before `apply` runs (the same contract
* `@deepseek-ai/dsh-mcp-client` relies on). The remaining four features only
* subscribe to lifecycle events and need no injected services.
*/
const inject = ["tools"];
function apply(ctx, rawConfig) {
	const config = resolveConfig(rawConfig);
	const http = new BridgeHttp(config);
	const features = [
		[
			"injection",
			"memory injection",
			() => setupInjection(ctx, config, http)
		],
		[
			"observation",
			"MCP observation",
			() => setupObservation(ctx, config, http)
		],
		[
			"usage",
			"token usage reporting",
			() => setupUsage(ctx, http)
		],
		[
			"collect",
			"collection trigger",
			() => setupCollect(ctx, http)
		],
		[
			"tools",
			"memory and skill tools",
			() => setupTools(ctx, config, http)
		]
	];
	for (const [flag, label, setup] of features) {
		if (config.features[flag] === false) continue;
		try {
			setup();
		} catch (error) {
			ctx.logger?.warn?.(`vibe-assistant-bridge: ${label} feature failed to activate: ${String(error)}`);
		}
	}
}
export { Config, apply, inject, name };
