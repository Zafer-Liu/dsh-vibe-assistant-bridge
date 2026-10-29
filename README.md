# dsh-vibe-assistant-bridge

An open-source [DeepSeek Harness](https://github.com/deepseek-ai/dsh) (dsh) plugin that bridges
your dsh sessions to [Vibe Assistant](https://www.zaferliu.me) (智管) — a local, privacy-first
agent memory and governance workstation.

The plugin runs inside the dsh host with **zero runtime npm dependencies** (Node builtins only)
and talks to Vibe Assistant over loopback HTTP (`http://127.0.0.1:9420` by default). Without
Vibe Assistant running, every background feature degrades silently and the tools return a
readable error — the plugin never disturbs your session.

## Requirements

- dsh `>=0.2.0 <0.3.0` (developer preview; the engine range is widened after each verified release)
- Node.js `>=22`
- Vibe Assistant running locally for full functionality (injection, telemetry, collection, tools)

## Install

**dsh desktop (Web UI)** — open **Plugins → Add plugin** and paste the npm package name:

```
dsh-vibe-assistant-bridge
```

**CLI** — install into a profile with an exact version (the desktop's pnpm can lag behind a
fresh `@latest` publish for up to 24 h, so pin the version):

```bash
npx @deepseek-ai/dsh plugin --profile desktop add --save-exact dsh-vibe-assistant-bridge@0.1.0
```

**From git / a local clone** — the compiled `lib/` bundle ships in the repository, so no build
step or prepare script is needed:

```bash
# from a GitHub ref
npx @deepseek-ai/dsh plugin --profile desktop add git+https://github.com/Zafer_Liu/dsh-vibe-assistant-bridge.git
# from a local checkout
git clone https://github.com/Zafer_Liu/dsh-vibe-assistant-bridge
npx @deepseek-ai/dsh plugin --profile desktop add ./dsh-vibe-assistant-bridge
```

Uninstall with `dsh plugin --profile desktop remove dsh-vibe-assistant-bridge`.

## What it does

| Feature | Mechanism | Vibe Assistant endpoint |
| --- | --- | --- |
| Memory injection | `agent/pre-step` — first step ≈ SessionStart injects L3+L2 shared memory; later steps re-pull and gate by content digest, so identical content is never injected twice | `POST /memory/context?event=…` |
| MCP observation | `session/event` `tool/call` × `tool/result` pairs under the `mcp__<server>__<tool>` namespace; only call boundaries and success/failure are reported — never arguments or result bodies | `POST /mcp/observation` |
| Token usage reporting | every `assistant/message` carrying `usage` becomes one usage record, attributed with the model tracked from `model/selection` events | `POST /telemetry/usage` |
| Session collection trigger | `agent/turn-stopping` notifies Vibe Assistant so L0→L1 memory extraction runs right after a session's turn closes, without waiting for a scan cycle | `POST /collect/trigger` |
| Memory tools | native dsh tools `recall_memory` and `get_user_profile` expose the shared memory center | `POST /memory/recall`, `POST /memory/profile` |
| Skill tools | native dsh tools `list_shared_skills` and `read_shared_skill` expose the published Skill library | `POST /skills/list`, `POST /skills/read` |

All six capabilities are independent: each is try/catch-isolated and can be switched off
individually. When the Vibe Assistant endpoint is unreachable, injection falls back to the
last locally cached snapshot (`~/.dsh/profiles/desktop/plugins/vibe-assistant-memory-snapshot.md`
by default), the background reports are dropped silently, and the four tools fail with a
readable error such as “Vibe Assistant is not running or unreachable at http://127.0.0.1:9420”.

## Configuration

The defaults work with no configuration at all. To override, edit the plugin row's `config`
in your profile's `cordis.patch.yml` (write a same-`id` row in the user-level patch layer —
later layers win per row):

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `endpoint` | `string` | `http://127.0.0.1:9420` | Vibe Assistant local HTTP endpoint |
| `timeoutMs` | `number` | `2000` | Per-request timeout for every bridge call |
| `maxInflight` | `number` | `8` | Max concurrent fire-and-forget reports |
| `maxPending` | `number` | `512` | Max remembered tool calls awaiting their `call_end` |
| `snapshotPath` | `string?` | `~/.dsh/profiles/desktop/plugins/vibe-assistant-memory-snapshot.md` | Offline injection fallback; `null` disables it |
| `features.injection` | `boolean` | `true` | Memory injection |
| `features.observation` | `boolean` | `true` | MCP call observation |
| `features.usage` | `boolean` | `true` | Token usage reporting |
| `features.collect` | `boolean` | `true` | Session collection trigger |
| `features.tools` | `boolean` | `true` | The four memory/skill tools |

Example — turn off telemetry reporting only:

```yaml
- id: vibe-assistant-bridge
  config:
    features:
      usage: false
```

## Development

```bash
npm install
npm run build     # tsdown → lib/
npm test          # vitest
npm run typecheck
```

Runtime code imports Node builtins only; `@deepseek-ai/cordis` stays a devDependency for
types, and the four tools register with raw JSON Schema — keeping the plugin resilient to
host churn during the dsh developer preview.

## License

[MIT](LICENSE) © [Zafer_Liu](https://www.zaferliu.me)
