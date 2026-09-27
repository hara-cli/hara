# OpenCode → Hara coding-runtime audit

Date: 2026-09-27  
Audited source: local `opencode` checkout, `dev` at `a42f393c850bec0c0f395fb91bf19b1ee8b31666`  
OpenCode package version: `1.18.32`  
License: MIT

## Decision

Hara should use OpenCode, but should not replace its runtime with an unmodified OpenCode UI or expose a
second product inside Desktop.

The durable product boundary is a **Hara-owned coding runtime**:

1. Hara owns the conversation, Agent identity, task lifecycle, permission decision, event journal,
   workspace, Diff ownership, remote-control lease, and public opaque IDs.
2. Codex, Claude Code, and OpenCode are execution adapters behind that boundary.
3. Desktop and Mobile render the same Hara conversation regardless of which adapter executes a coding
   segment. Runtime identity is available in execution details, not as a second chat mode.
4. A user changes connection or runtime only when needed; ordinary requests such as “修复这个项目” are
   routed by Hara from capability, authentication, policy, health, and workspace state.

This provides functional transparency without falsely promising credential transparency.

## Authentication finding

OpenCode supports ChatGPT Plus/Pro, Claude Pro/Max, GitHub Copilot, and ordinary provider API keys. Its
provider catalog and OAuth flows are useful, but its credential store is independent (`OpenCode` keeps its
own owner-only `auth.json`). It does **not** automatically reuse the current Codex CLI or Claude Code login
files.

Therefore Hara must use two paths:

- **Existing native subscriptions:** keep the current Codex App Server and Claude Agent SDK adapters. They
  preserve each product's native login, session identity, and resume behavior.
- **Hara model connections:** launch OpenCode with invocation-scoped provider configuration and credentials
  supplied by the Hara engine. Secrets must never cross Serve or enter Desktop, command arguments, logs, or
  OpenCode's global store.
- **Optional OpenCode subscription login:** expose a one-time Hara-managed OAuth flow later. The result is a
  distinct OpenCode connection; do not imply that an existing Codex/Claude login was silently imported.

## What is worth adopting

| OpenCode capability | Hara decision |
| --- | --- |
| Durable prompt admission before execution wake-up | Keep Hara's durable command/idempotency journal; tighten the same “persist before wake” invariant for every coding adapter. |
| Explicit queue and steer delivery | Hara already has queued follow-ups and steering. Normalize both through the coding-runtime interface. |
| Rule-ordered allow/ask/deny permissions | Adopt the vocabulary and deterministic matching idea, but Hara remains the final approval authority. Never copy OpenCode's permissive defaults. |
| Headless server + SDK + event stream | Preferred long-lived OpenCode adapter boundary. Bind only to loopback, use a random per-launch credential, and normalize events into Hara's journal. |
| Agent Client Protocol (ACP) | Viable fallback/interop boundary, especially for editor integrations. The managed local server is better for Hara-owned replay, provider discovery, and session operations. |
| Provider/model catalog and OAuth methods | Read dynamically through the adapter. Never copy a static model list into Hara. Filter it through Hara connection and policy capabilities. |
| Session list/read/fork/abort/export | Map to Hara opaque session IDs and existing resume/fork/interrupt concepts. Provider-native IDs never cross Serve. |
| LSP diagnostics, snapshots, revert, MCP, skills | Reuse as adapter capabilities where they add value. Hara already owns Diff/replay/MCP/skill policy, so do not create a second visible system. |
| OpenCode TUI/Desktop | Do not embed. Hara Desktop and Mobile remain the only product UI. |

## Integration stages

### Stage 1 — bounded delegation (implemented)

`external_agent` now recognizes `opencode` alongside `claude` and `codex`.

- Read-only Hara work maps to OpenCode `plan` plus an invocation-only deny-by-default rule set.
- Workspace-write maps to `build`, permits edit tools, and still denies shell, child Agents, network tools,
  and external directories.
- Full trust is reachable only through Hara's existing external trust boundary and explicit approval.
- External plugins are disabled for this bounded path (`--pure`) so project or global plugin hooks cannot
  silently broaden the invocation.
- The established native preference order remains Claude Code → Codex → OpenCode when the caller does not
  choose a backend.

This stage makes OpenCode useful to Hara immediately, but it is not represented as a durable Hara Live
session and must not be advertised as one.

### Stage 2 — Hara-owned OpenCode runtime

Add a `CodingRuntimeAdapter` contract shared by native Codex, native Claude Code, and OpenCode:

```text
inspect / authenticate / create / read / submit / steer / interrupt / fork / close
                              ↓
          normalized text, tool, diff, approval, usage, lifecycle events
                              ↓
           Hara journal → Desktop / Mobile / Relay replay
```

The OpenCode implementation should manage one local headless server per compatible runtime version or
profile, not one process per chat message. Requirements:

- loopback-only listener and random owner-only launch password;
- exact version/capability negotiation before use;
- Hara opaque ID ↔ native session ID mapping held only behind Serve;
- durable submit command ID before the provider is woken;
- event cursor, reconnect replay, and terminal result reconciliation;
- Hara approval callback for every consequential tool action;
- explicit directory binding and Hara protected-file policy;
- provider credentials injected only into the owned process environment or in-memory auth content;
- bounded output, redaction, cancellation, process-tree cleanup, and crash recovery;
- no OpenCode web UI and no publicly reachable OpenCode server.

### Stage 3 — transparent routing

The root Hara Agent chooses a coding runtime from policy and capability:

1. Continue the already-owned runtime when a conversation has one.
2. Prefer native Codex/Claude adapters when the selected connection is their existing subscription login.
3. Prefer OpenCode for Hara personal/company API connections and provider-neutral coding work.
4. Fall back only to a healthy compatible connection after a user-visible route receipt; never send a model
   to another vendor's endpoint.
5. Keep one Hara conversation even when multiple execution segments or child Agents are involved.

The composer should say which connection will be used only when that information helps a decision. It
should not make users choose an engine for every message.

## Chat presentation implications

Runtime unification succeeds only if execution looks like part of a normal conversation:

- user and Agent messages remain the primary visual layer;
- “working” is an Agent presence/typing state, not a raw protocol line;
- tool calls, Diff, token usage, retries, and adapter names live in one expandable execution receipt;
- task blockers and approval requests stay prominent because they need action;
- internal reminders, routing envelopes, provider IDs, and native session IDs are never rendered;
- a completed turn ends with a plain-language Agent reply, even when OpenCode performed the code work;
- recovery after reconnect restores the exact visible message and execution receipt without duplicate text.

## Non-goals

- Copying the OpenCode monorepo into Hara.
- Replacing Hara's Agent/team/task model with OpenCode Agents.
- Importing Codex or Claude credentials without explicit provider authorization.
- Running OpenCode with `--auto` merely because a Hara conversation uses automatic edits.
- Exposing the OpenCode local server to LAN, Relay, Desktop, or Mobile.
- Maintaining a copied OpenCode model catalog.

## Acceptance criteria for the durable adapter

1. The same Hara conversation can create, reconnect to, interrupt, and resume an OpenCode-backed coding
   session after Desktop or Engine restart.
2. Desktop and Mobile receive only Hara-normalized, cursor-replayable events and opaque IDs.
3. API keys and OAuth tokens are absent from argv, Desktop state, logs, journals, crash reports, and test
   fixtures.
4. Read-only, workspace-write, and explicit full-trust behavior each have hermetic integration tests.
5. A provider crash after submit cannot duplicate the user message or tool side effect on reconnect.
6. Switching Codex ↔ Claude Code ↔ OpenCode never silently changes the model vendor or endpoint.
7. The UI presents one conversation with natural Agent presence; runtime details remain inspectable but
   secondary.

