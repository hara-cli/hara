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
