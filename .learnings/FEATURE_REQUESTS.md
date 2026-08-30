## [FR-20260717-SESSION-RESUME-CWD] Resume saved sessions from their persisted project root

**Logged**: 2026-07-17T22:34:00+08:00
**Priority**: high
**Status**: resolved
**Area**: session

### Requested Capability
Make a saved Hara session resumable after the user launches Hara from another directory, matching the
project-aware continuity users expect from Codex.

### User Context
Every session already persisted `meta.cwd`, and the low-level resume engine correctly rejected a foreign
execution root. However, the public `hara resume <id>` wrapper relaunched in the caller's current directory,
so the documented resume command defeated its own safety check. Inside the TUI, `/resume` was also an alias
for continuing an unfinished task rather than switching a saved session.

### Resolution
- **Completed**: 2026-07-17T22:34:00+08:00
- **Notes**: Explicit session resume now resolves and validates the persisted project directory before
  relaunching. The low-level/headless cross-project refusal remains fail-closed. `/continue` exclusively
  steers the active task; `/resume <id>` now switches saved sessions, and session lists show project roots.
  Regression coverage binds the attached child to the saved cwd and covers missing/corrupt session state.

### Metadata
- Related Files: src/session/resume.ts, src/session/store.ts, src/index.ts, test/session-resume.test.mjs,
  test/self-invoke.test.mjs
- Requested By: user

---

## [FR-20260715-INTERACTION-TASK-SEPARATION] Persist task execution independently from conversation history

**Logged**: 2026-07-15T17:40:00+08:00
**Priority**: high
**Status**: in_progress
**Area**: architecture

### Requested Capability
Separate user interaction, a single turn, and long-running task execution so resume, steering, interruption, and queued follow-ups do not infer the active objective from the latest transcript message.

### User Context
The current Hara session can resume the conversation but still loses an authoritative task boundary. Messages typed while working are appended to shared history and leftovers can become ordinary new turns, which makes context drift and task switching ambiguous.

### Proposed Direction
Adopt a narrow `session/thread -> turn -> task/run` model inspired by Codex: persist an optional active task separately from history; bind steering to an expected task/turn ID; recover interrupted running tasks as paused; inject task state as structured execution context. Borrow only cc-haha's terminal framing mechanics for input, not its renderer wholesale.

### Metadata
- Related Files: src/session/store.ts, src/agent/loop.ts, src/tui/App.tsx, src/index.ts, src/serve/sessions.ts, src/serve/server.ts
- Requested By: user

---

## [FR-20260717-WECOM-CHANNEL] Add an enterprise WeChat / WeCom gateway

**Logged**: 2026-07-17T10:58:00+08:00
**Priority**: high
**Status**: completed
**Area**: backend

### Requested Capability
Add first-class enterprise WeChat (WeCom / 企业微信) support to Hara CLI and validate it locally.

### User Context
Hara already exposes external chat-gateway behavior and needs an enterprise WeChat transport that can
receive authenticated callbacks, preserve conversation/source identity, send replies, and handle media
without weakening the existing credential, private-state, timeout, and untrusted-content boundaries.

### Complexity Estimate
complex

### Suggested Implementation
Extend the existing gateway adapter contract rather than adding a separate agent loop. Keep credentials in
the shared protected state, verify callback signatures before parsing/decrypting content, deduplicate
delivery IDs, bound media/network operations, and add a local deterministic fake-WeCom server plus
process-level gateway tests before any real tenant configuration is attempted.

### Metadata
- Frequency: first_time
- Related Features: Feishu gateway, WeChat gateway, external channels
- Related Files: src/gateway/, src/security/private-state.ts, src/security/external-content.ts, test/gateway-*.test.mjs
- Requested By: user

### Resolution
- **Completed**: 2026-07-17T11:58:00+08:00
- **Notes**: The repository already contained a WeCom AI-Bot WebSocket adapter, so the work hardened and
  completed that implementation instead of adding a duplicate channel. Released in 0.124.2 with authenticated
  readiness, bounded auth/heartbeat/reconnect/request behavior, stable callback identity, strict media
  handling, local fake-server and spawned-CLI regressions, plus a standalone-binary transport smoke.

---

## [FR-20260718-OFFICE-WORKBENCH-PROVIDER-SETTINGS] Add a novice office workbench and unified model settings

**Logged**: 2026-07-18T16:00:00+08:00
**Priority**: high
**Status**: in_progress
**Area**: desktop

### Requested Capability
Turn Hara Desktop into a task-and-artifact workbench for ordinary office users. It should support
presentation generation, spreadsheet editing and XLSX export, Markdown editing, DOCX export, installable
industry capability packs, and a real System Settings surface for cloud providers, compatible gateways,
and local models such as Ollama and LM Studio.

### User Context
The current first-run screen exposes a hard-coded provider list and writes one flat configuration directly,
while the normal Settings screen cannot add, test, switch, or discover provider models. Local providers are
especially confusing because the UI requires a dummy API key and the CLI does not model them consistently.
Office outputs are also still treated as files produced by ad-hoc Skills instead of versioned, reviewable
artifacts with an editor and export lifecycle.

### Complexity Estimate
complex

### Suggested Implementation
Keep Desktop thin. Add redacted provider catalog/health/model-discovery and secure secret-write RPCs to
`hara serve`; represent local endpoints as no-secret provider profiles. Build a common Artifact/Revision
protocol, then ship official signed capability packs combining Skill, deterministic Tool/worker, Panel,
Template, and Policy. Start with a local spreadsheet pack before adding cloud office connectors.

### Metadata
- Frequency: recurring
- Related Features: provider profiles, local models, capability marketplace, office artifacts
- Related Files: src/config.ts, src/serve/, hara-desktop/src/client.ts, hara-desktop/src/App.tsx,
  hara-desktop/docs/NOVICE_WORKBENCH_ARCHITECTURE.md
- Requested By: user

---

---

## flow 分诊调用应关闭思考模式（2026-08-30，南荒实测）

**现象**：`~/.hara/flows.json` 的分诊 flow（零工具 + schema 强制 JSON 的五选一分类）
单次耗时 8~30 秒、方差 3.5 倍，飞书群里 @bot 到回执要 16~24 秒。

**根因**：qwen3 系列的 `reasoning.effort` **默认是 `xhigh`**（阿里百炼文档：七档中的次高档）。
一个分类任务被迫按最高强度做思考链。实测 **91% 的输出 token 是 reasoning_tokens**。

**实测数据**（qwen3.7-plus，同一 prompt，各 3 次取中位）：

| 调用参数 | 耗时 | 输出 tok | 其中 reasoning |
|---|---|---|---|
| 默认 | 8.8s | 464 | **423** |
| `enable_thinking: false` | **2.2s** | **41** | **0** |
| `reasoning: {effort: "none"}` | 5.1s | 268 | **227** |
| `reasoning: {effort: "minimal"}` | 3.5s | 170 | 110 |

**这是不是 hara 的 bug —— 是，而且是影响全体用户的那种（2026-08-30 读源码确认）**：
1. `serve.ts:571 runFlowAgent()` → `runNoToolModel(prompt, {schema, …})`。
   **hara 有一条专门的「无工具 + schema 强制」代码路径**，函数名就写着 NoTool，
   注释也写明 "isolated flow judgments cannot read a project" —— 它 100% 知道
   这次调用是「照模板填空的判断」，不是开放推理。
2. 但 `grep -rniE "enable_thinking|reasoning|thinking|effort|budget_tokens" src/`
   **在整个源码里零命中**（只匹配到 "best effort" 这种无关词）。
   也就是说 hara **对任何 provider 都不传推理控制参数**。
3. 后果：在所有默认开思考的 provider 上（实测 qwen 全系 / deepseek / glm **无一例外**）
   分诊白烧 80~93% 的输出 token。这不是某家的问题，是调用方缺了这一层。
4. 性质是**沉默的税**：不报错、不失败，只是慢 3~10 倍、贵 5~10 倍，所以没人会去查。

**建议**：
1. `dispatchFlows` 调 provider 时，对**带 schema 的结构化分类调用**默认传 `enable_thinking: false`
   （或把它做成 FlowRule / profile 级可配项）。这类调用要的是照模板填空，不是推理。
2. 顺带补 FlowRule 的 `model` 覆盖 —— 现在只有全局 `defaultModel`，
   改它会同时影响 cron 的 agent 班（重活）和 flow 分诊（轻活），两者诉求相反。

**⚠️ 附带发现（值得单独记）**：阿里 token-plan 端点上 **`reasoning.effort: "none"` 并没有真正关闭思考**
（仍有 227 reasoning tokens），只有 `enable_thinking: false` 归零。
而官方文档写着「`reasoning.effort` 优先级高于 `enable_thinking`，建议优先使用，
`enable_thinking` 后续将不再支持」—— 文档与实测不符。若日后 `enable_thinking` 真被下线，
需要重新验证 `effort` 是否已修好，**不能照文档直接切**。

**另一个通用缺口**：FlowRule 的 `do` 是必填 agent prompt，**没有「匹配即产出固定 JSON、不跑 LLM」的静态模式**。
有了它才能做真正零 token 的关键词分流（现在关键词只能省 prompt 长度，省不掉那次调用）。
