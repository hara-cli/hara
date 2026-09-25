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

## [FEAT-20260923-002] custom-wechat-group-wake-name

**Logged**: 2026-09-23T21:00:00+08:00
**Priority**: high
**Status**: resolved
**Area**: frontend

### Requested Capability

Let a managed local WeChat group choose the exact group-visible name that members will `@` to wake its
Agent, rather than hard-coding `@Hara` or the internal Agent identity.

### User Context

The identity visible inside a real WeChat group may be a company assistant name such as `小南`. The WeChat
group title and the Agent wake name are separate concepts: the title is discovered and bound by Hara as a
safety boundary, while the wake name is a user-owned interaction choice.

### Complexity Estimate

medium

### Suggested Implementation

Persist one normalized wake name without the leading `@`, expose it through the authenticated settings RPC,
require a true mention boundary when matching, keep selected-Agent aliases only as the empty-value fallback,
and migrate older settings without changing their behavior.

### Metadata

- Frequency: first_time
- Related Features: local WeChat group Agent, Managed mode, group binding

### Resolution

Implemented settings v4, authenticated RPC/Desktop controls, strict `@` boundary matching, legacy migration,
and visible ignored-message feedback. Local source and the refreshed development sidecar are verified; this
entry does not claim a tagged public release.

---

## [FR-20260920-AGENT-CONVERSATION-AND-COMPUTER] Productize Agents as conversations with computers

**Logged**: 2026-09-20T23:59:00+08:00
**Priority**: high
**Status**: pending
**Area**: product-architecture

### Requested Capability

Evolve Hara toward Grok Bot's useful interaction model: persistent Agent direct chats, visible Agent group
chats and handoffs, local execution, optional container management, and one live computer/terminal surface,
without restoring desk pets or an Agent Office simulation.

### User Context

The installed Grok Bot demonstrates that users understand Agents best as chat contacts. Individual Bots can
message one another, groups preserve visible handoffs, and the right-side computer panel exposes real work.
Hara now has durable Agent mailboxes/rooms and approved Codex/Claude Worktrees in Core, but Desktop and Mobile
do not expose `session.agents.list` or room transcripts as first-class conversations. The current Desktop
Groups area is organization Desk/task management, not Agent group chat. Docker is only reachable through
generic shell execution and lacks typed inventory, policy, receipts, and destructive-operation guards.

### Complexity Estimate

complex

### Suggested Implementation

Promote Agent conversations and rooms into an authenticated Serve surface with explicit wake/turn leases,
mention routing, bounded hops, durable message receipts, and one owner per stage. Add Desktop/Mobile thin
clients for direct chats, groups, approvals, terminal/browser observation, and contextual computer takeover.
Implement container management as an optional typed capability/plugin: read-only inventory by default;
explicit approval and immutable target binding for mutations; destructive confirmation for remove/prune,
volumes, and Compose teardown. Keep organization work/task management as a separate product area.

### Metadata

- Frequency: recurring
- Related Features: Agent catalog, Agent room, mailbox, Hara Live, Mobile Relay, computer use, cron
- Related Files: src/subagent/team.ts, src/serve/server.ts, ../hara-desktop/src/client.ts,
  ../hara-desktop/src/Groups.tsx, ../hara-mobile/src/services/cloudCompanionGateway.ts
- Requested By: user

---

## [FR-20260920-BOUNDED-AGENT-ROOM-AND-CODING-RUNTIME] Bounded Agent rooms and Codex/Claude execution

**Logged**: 2026-09-20T00:00:00+08:00
**Priority**: high
**Status**: completed
**Area**: agent-runtime

### Requested Capability

Let newly created Hara Agents exchange messages in a small group, and let a parent Hara Agent explicitly
start Codex or Claude Code to work on code without introducing another office/game-style orchestration UI.

### User Context

The useful OpenClaw pattern is Agent-to-Agent routing plus coding-agent control. Hara already had stronger
durable identity, mailbox, Worktree, Diff, approval, and terminal-session primitives, but they were not
joined into one product path. The deprecated Agent-office projection also remained in the Engine after the
simplified Desktop stopped rendering it.

### Complexity Estimate

complex

### Resolution

- Added one bounded `agent_room` tool with durable ordered history, participant limits, idempotent posts,
  mailbox fan-out, ownership checks, close semantics, and no automatic idle-Agent wake loop.
- Extended `spawn_agent` with approved Personal-Space `codex` and `claude` runtimes. Each runtime owns an
  isolated Git Worktree, persists one opaque Hara Live continuation ID, accepts bounded in-flight messages,
  and still requires parent Diff inspection/application.
- Kept company Spaces fail-closed and removed deprecated Engine `offices`/`currentOfficeId` computation while
  preserving the complete Agent directory and the separate document-focused Hara Office product.
- Verified the implementation with the full feedback evaluation and 1,755 project tests.

### Metadata

- Frequency: recurring
- Related Features: durable Agent tree, Hara Live, Agent mailbox, isolated Worktree, Diff review
- Related Files: src/subagent/team.ts, src/subagent/external.ts, src/tools/collaboration.ts, src/serve/server.ts
- Requested By: user

---

## [FR-20260910-COMPUTER-USE-PARITY] Productize browser and desktop computer control

**Logged**: 2026-09-10T18:16:00+08:00
**Priority**: high
**Status**: in_progress
**Area**: frontend

### Requested Capability

Bring the useful Codex Computer Use experience into Hara: a discoverable Desktop capability that can inspect
screens, click, type, scroll, upload, and verify browser or desktop UI work, with per-application permissions
and an explicit boundary for sensitive actions. Repair the current Browser Use path that reports no interaction
tools or stalls on an unapproved browser connection.

### User Context

Hara Desktop 0.1.158 / Engine 0.171.0 opened a trademark application URL but then told the user it had no
click/input/screenshot/upload capability. The underlying Windows `computer` tool and Playwright browser plugin
already exist, but deferred-tool discovery, binary bundling, installation, permission status, and Desktop setup
are not a coherent product flow.

### Complexity Estimate

complex

### Suggested Implementation

Auto-route web/GUI intents to the appropriate deferred capability; package the isolated browser as a reviewed,
pinned bundled plugin; add Desktop install/enable/status UI; expose computer-control mode and app allow-list
through authenticated Serve RPC; keep screenshots and action receipts in one deterministic loop; and require
fresh confirmation for login, upload, submit, payment, account, or security boundaries.

### Metadata

- Frequency: recurring
- Related Features: computer tool, browser plugin, tool_search, Desktop security settings, MCP
- Related Files: src/tools/computer.ts, src/agent/loop.ts, src/plugins/bundled.ts, src/serve/server.ts,
  hara-desktop/src/App.tsx, hara-desktop/src/client.ts
- Requested By: user and Hara feedback group

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

---

## [FR-20260909-FEISHU-WECHAT-BRIDGE] Native cross-channel Feishu and WeChat delivery

**Logged**: 2026-09-09T00:00:00+08:00
**Priority**: high
**Status**: implemented_unreleased
**Area**: gateway

### Requested Capability

Let an authorized Hara conversation in WeChat send through the already-connected Feishu gateway, and let
ordinary messages from an explicitly enabled Feishu group reach colleagues who opted in from their bound
WeChat DMs. Do not depend on a separately installed Feishu CLI.

### Root Cause

Connector readiness and Agent-callable capability were separate. The Feishu gateway correctly kept its App
Secret inside its own process, while a WeChat-launched Hara child had neither those environment variables nor
an outbound tool. It therefore mistook a connected connector for a missing local integration.

### Implementation

- Added the eager `channel_message` tool and registered it in both the CLI and Serve tool aggregates.
- Added a private request/receipt broker so the credential-owning target gateway performs the send.
- Added owner-created Feishu source aliases plus per-person WeChat `/bridge join` and `/bridge leave` consent.
- Added bounded storage, account ambiguity rejection, opaque idempotency, FIFO WeChat delivery, loop
  prevention, and tests that ensure ids/credentials are absent from user-visible results.

### Metadata

- Frequency: first_time
- Related Features: Feishu gateway, WeChat gateway, channel_message, group bridge
- Related Files: src/gateway/outbound-broker.ts, src/gateway/channel-bridges.ts, src/gateway/serve.ts,
  src/tools/channel-message.ts
- Requested By: user
