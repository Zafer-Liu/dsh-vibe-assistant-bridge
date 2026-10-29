# dsh-vibe-assistant-bridge

一个开源的 [DeepSeek Harness](https://github.com/deepseek-ai/dsh)（dsh）插件，把你的 dsh
会话桥接到本地的 [Vibe Assistant](https://www.zaferliu.me)（智管）——隐私优先的智能体记忆
与治理工作站。

插件运行在 dsh 宿主内，**运行时零 npm 依赖**（仅 Node 内置模块），通过回环 HTTP
（默认 `http://127.0.0.1:9420`）与智管通信。智管未运行时，后台特性全部静默降级、
工具返回可读错误，绝不干扰你的会话。

## 前置条件

- dsh `>=0.2.0 <0.3.0`（developer preview；每轮宿主版本验证通过后再放宽引擎区间）
- Node.js `>=22`
- 本机运行中的 Vibe Assistant才有完整功能（注入、用量、收集、工具）

## 安装

**dsh 桌面版（Web UI）**——打开 **Plugins → Add plugin**，粘贴 npm 包名：

```
dsh-vibe-assistant-bridge
```

**CLI**——按精确版本安装进 profile（桌面端 pnpm 对刚发布的 `@latest` 最多有 24 小时
延迟，建议钉住版本）：

```bash
npx @deepseek-ai/dsh plugin --profile desktop add --save-exact dsh-vibe-assistant-bridge@0.1.0
```

**git / 本地克隆安装**——仓库自带编译好的 `lib/` 产物，无需构建步骤或 prepare 脚本：

```bash
# 从 GitHub 引用安装
npx @deepseek-ai/dsh plugin --profile desktop add git+https://github.com/Zafer_Liu/dsh-vibe-assistant-bridge.git
# 从本地克隆安装
git clone https://github.com/Zafer_Liu/dsh-vibe-assistant-bridge
npx @deepseek-ai/dsh plugin --profile desktop add ./dsh-vibe-assistant-bridge
```

卸载：`dsh plugin --profile desktop remove dsh-vibe-assistant-bridge`。

## 功能

| 功能 | 机制 | 智管端点 |
| --- | --- | --- |
| 记忆注入 | `agent/pre-step`——首个 step ≈ SessionStart 注入 L3+L2 共享记忆；后续按内容指纹门控，同一内容绝不重复注入 | `POST /memory/context?event=…` |
| MCP 调用观测 | `session/event` 的 `tool/call` × `tool/result` 配对，按 `mcp__<server>__<tool>` 拆分命名空间；只上报调用边界与成败，绝不上报参数或返回正文 | `POST /mcp/observation` |
| token 用量上报 | 每条携带 `usage` 的 `assistant/message` 即一条用量记录，结合 `model/selection` 事件附上当前模型名 | `POST /telemetry/usage` |
| 会话收集触发 | `agent/turn-stopping` 通知智管，会话回合结束后立即执行 L0→L1 记忆提取，无需等待扫描周期 | `POST /collect/trigger` |
| 记忆工具 | 原生 dsh 工具 `recall_memory` 与 `get_user_profile`，直通共享记忆中心 | `POST /memory/recall`、`POST /memory/profile` |
| 技能工具 | 原生 dsh 工具 `list_shared_skills` 与 `read_shared_skill`，直通已发布技能库 | `POST /skills/list`、`POST /skills/read` |

六项能力相互独立：各自 try/catch 隔离、可单独开关。智管端点不可达时，注入回退到
本地最后一次快照（默认 `~/.dsh/profiles/desktop/plugins/vibe-assistant-memory-snapshot.md`），
后台上报静默丢弃，四个工具返回可读错误（如「Vibe Assistant is not running or
unreachable at http://127.0.0.1:9420」）。

## 配置

默认零配置可用。如需覆盖，在 profile 的 `cordis.patch.yml` 用户层写一条同 `id` 的
config 覆盖行（later layers win per row）：

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `endpoint` | `string` | `http://127.0.0.1:9420` | 智管本地 HTTP 端点 |
| `timeoutMs` | `number` | `2000` | 所有桥接请求的超时（毫秒） |
| `maxInflight` | `number` | `8` | 后台上报的最大并发数 |
| `maxPending` | `number` | `512` | 等待 `call_end` 配对的调用记忆上限 |
| `snapshotPath` | `string?` | `~/.dsh/profiles/desktop/plugins/vibe-assistant-memory-snapshot.md` | 离线注入回退快照；`null` 关闭 |
| `features.injection` | `boolean` | `true` | 记忆注入 |
| `features.observation` | `boolean` | `true` | MCP 调用观测 |
| `features.usage` | `boolean` | `true` | token 用量上报 |
| `features.collect` | `boolean` | `true` | 会话收集触发 |
| `features.tools` | `boolean` | `true` | 四个记忆/技能工具 |

示例——只关闭用量上报：

```yaml
- id: vibe-assistant-bridge
  config:
    features:
      usage: false
```

## 开发

```bash
npm install
npm run build     # tsdown → lib/
npm test          # vitest
npm run typecheck
```

运行时代码只 import Node 内置模块；`@deepseek-ai/cordis` 仅作为 devDependency 提供
类型，四个工具以原始 JSON Schema 注册——在 dsh developer preview 期间最大限度降低
宿主破坏性变更的影响面。

## 许可

[MIT](LICENSE) © [Zafer_Liu](https://www.zaferliu.me)
