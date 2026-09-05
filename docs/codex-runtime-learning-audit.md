# Codex runtime learning audit

> Snapshot: 2026-09-06. Reference checkout:
> `/Users/zhujianbo/work/projects/ai/codex` at locally inspected revision `8e6a44b428`.

Hara should learn Codex's reliability mechanisms, not turn into an OpenAI-only clone. This audit compares the
runtime contracts that matter to long tasks, interruption, compaction, retries, and future mobile control.
Hara Desktop and Hara mobile remain the product control plane: mobile connects to Hara-managed sessions through
the Hara protocol and does not depend on ChatGPT Remote Connections. Codex and Claude Code are execution
providers behind that boundary, not competing user-facing control products.

## 1. Already present in Hara

| Runtime concern | Hara status | Notes |
| --- | --- | --- |
| Turn-scoped steering | Implemented | A live executable turn owns a steer target; local controls cannot accidentally receive task input. |
| Explicit next-task barrier | Implemented | `/next` queues a new task instead of mutating the current task. |
| Durable task identity | Implemented | Objective, accepted brief, steering audit, checkpoint, task ID, and turn ID survive compaction/resume. |
| Pre-mutation understanding gate | Implemented | `task_intake` must complete in a separate round before change actions become available. |
| Automatic context compaction | Implemented | Context watermark reporting and automatic summary replacement exist; manual user intervention is not required. |
| Atomic compaction installation | Implemented | Each installed window has stable window/attempt identity, records observed versus estimated input accounting, and saves the complete replacement before changing live history. Failed persistence leaves the prior window untouched. |
| Repeated-failure guard | Implemented in 0.166.1 | The second identical failure requires a strategy change; the third stops that exact loop. It no longer ends healthy work merely because 20 rounds passed. |
| Healthy long-task continuation | Implemented after 0.166.1 | A fresh durable checkpoint and new evidence can open another bounded tranche automatically; deadlines, no-progress detection, cumulative task limits, and the absolute 256-round ceiling remain hard stops. |
| Verified user-decision retention | Implemented after 0.166.1 | Successful `ask_user` decisions are redacted, deduplicated, persisted outside the compactable transcript, and restored in future task prompts and forks. |
| Replay-safe provider retry | Implemented after 0.166.1 | One provider-neutral coordinator classifies empty pre-output failures, honors bounded `Retry-After`, backs off cancellably, and never replays after stream activity, output, or a tool call. SDK-local automatic retries are disabled. |
| Projection commit journal | Foundation implemented after 0.166.1 | Every durable snapshot appends a credential-free generation/hash record. Readers isolate malformed lines, ignore a torn final line, and report chain gaps. This detects projection loss but is not yet a typed event-source for every task action. |
| Remote mutation deduplication | Implemented after 0.166.1 | `session.submit/send/steer/interrupt` accept a client UUID, share concurrent work, save the first terminal result before ACK, replay across Serve restarts, and reject same-ID/different-payload reuse. Provider-owned Codex/Claude submit, steer, and interrupt commands are deduplicated across socket reconnects during one Serve lifetime and support turn fencing. Controlled terminal streams reject duplicate, conflicting, and out-of-order `inputSeq` values before the PTY write. |
| Slow-client memory boundary | Implemented after 0.166.1 | All Serve notifications share a 4 MiB per-socket queue ceiling. A sleeping/stalled renderer is closed with an explicit reconnect-and-refresh reason instead of retaining unbounded terminal or task frames. |
| Cursor/ACK/event replay | Implemented after 0.166.1 | Broadcast events carry a process-stream UUID and monotonic sequence. A reconnecting Desktop/mobile client can replay the exact retained tail, ACK its cursor, and receives an explicit `snapshotRequired` result for a restart, eviction, or oversized-frame gap instead of silently losing events. The retained tail is bounded to 10,000 events and 8 MiB. |
| Single-writer Agent control | Implemented after 0.166.1 | One Desktop/mobile socket can acquire a session control lease. Takeover rotates an opaque lease ID and monotonic epoch, revokes the old controller, and fails stale delayed writes closed. Observer clients stay read-only; old clients remain compatible only while no lease is active. |
| Rewind projection repair | Implemented after 0.166.1 | Rewinding history also invalidates future task/todo/reminder/repeat-guard state and tells every client to refresh history. It deliberately does not pretend that transcript rewind reverted files. |
| Tool approvals and sandbox boundary | Implemented | Engine policy remains authoritative rather than trusting prose in the transcript. |
| Background jobs and bounded output | Implemented | Long-running processes and large tool output do not have to block or flood the main model context. |
| Deferred tool discovery | Implemented | Optional web, desktop, scheduler, external-agent, and MCP schemas stay out of the base prompt until provider-neutral `tool_search` activates an allowed capability. |
| Bounded read-only delegation | Partially implemented | The current `agent` tool has FIFO admission, cancellation, specialist roles, bounded concurrency, and read-only policy enforcement. A child is still an ephemeral call that returns one result, not a durable addressable member of an Agent tree. |
| Provider-independent runtime | Stronger Hara requirement | Hara keeps Anthropic/OpenAI-compatible/subscription/enterprise connections behind one engine contract. |
| External Codex app-server adapter | Implemented | Hara can preserve the provider's native execution path without leaking its native session ID into UI clients. |

These are not placeholders. They are current runtime contracts documented in
`conversation-task-execution.md` and covered by engine tests/evals.

## 2. High-value mechanisms still to adopt

### 2.1 Append-only rollout log and deterministic replay

Codex persists typed rollout items and reconstructs state through deterministic processing. Hara now has a
bounded append-only **projection commit journal**, but the complete JSON snapshot is still the authoritative
recovery unit. Extend the foundation into typed events for:

- task lifecycle and brief revisions;
- steering acceptance, delivery, promotion, and consumption;
- approvals and their terminal result;
- compaction installation;
- control-lease acquisition/release;
- provider attempts and failover decisions.

The current snapshot should then become a rebuildable projection. Typed events need an event ID, schema version,
task/turn identity, monotonic sequence, timestamp, and redacted payload. Startup must replay them into the same
projection in property tests. Torn-tail isolation, append bounds, secure file handling, generation chaining, and
gap diagnostics already exist in the projection journal and should be reused rather than replaced.

### 2.2 Atomic compaction windows

Codex's `auto_compact_window` and compaction flow distinguish an observed server prefill baseline from an
estimate, assign stable window identity, and install replacement history as a completed checkpoint. Hara now:

1. assigns `windowId`, `previousWindowId`, and `attemptId` before summarization;
2. retains the source transcript until the replacement is validated and durably saved;
3. distinguishes provider-observed input usage from estimated tokens;
4. installs summary + preserved tail atomically, or keeps the previous live window unchanged.

The remaining hardening is explicit fault injection at process-crash points before the request, after the
response, and between transcript rename and secondary journal/index writes, plus one reminder/fallback policy per
window. Full typed replay will eventually make recovery deterministic rather than merely detectable.

### 2.3 Durable Agent tree, mailbox, and cold resume

This is now the largest Agent-specific gap. Codex's multi-Agent runtime is not merely parallel prompting: a root
thread owns a registry of named descendants, every child has a stable path and parent/root turn provenance, and
the runtime supports spawn, follow-up, queued message, wait, interrupt, listing, and cold resume. Role/model/
reasoning/sandbox settings survive the child identity, and one rollout budget and concurrency policy cover the
whole tree.

Hara currently has a safe but intentionally smaller primitive: the `agent` tool starts a bounded read-only
sub-run, waits for one terminal result, reports a process-local lifecycle event, and then discards the child.
To reach durable Agent parity, add a provider-neutral tree with:

- stable `agentPath`, child ID, parent turn ID, root turn ID, role, and lifecycle generation;
- persisted spawn receipts and terminal outcomes so a restart cannot duplicate a child;
- a mailbox that distinguishes current-turn steering from queue-only next-turn context;
- explicit `spawn/followup/message/wait/interrupt/list/resume` operations with bounded command receipts;
- cold reconstruction of surviving children and nested descendants;
- one concurrency limit and token/time/cost budget shared by the complete tree;
- child completion/failure messages that retain provenance and cannot silently target a newer turn.

Writable children should remain disabled until managed worktree isolation, diff ownership, and an explicit merge
step exist. Hara should preserve its present rule that parallel children cannot mutate the same working tree.

### 2.4 Flush-before-suspend and explicit handoff

Codex's turn suspension rechecks ownership under a lock, flushes pending output, closes the writer, and only then
announces that control stopped. Hara needs the same protocol for Desktop/mobile/WezTerm handoff:

```text
request handoff
  -> freeze new writes
  -> flush acknowledged frames
  -> recheck owner + lease epoch
  -> close old writer
  -> publish new owner
```

Suspension must be rejected while unaccounted child processes or tool side effects remain. Accepted pending
input must either be flushed with a receipt or explicitly returned to the mailbox; it cannot disappear during
handoff. The client must never infer ownership from a stale UI label.

### 2.5 Retry health feeding typed failover

Hara's provider factory now installs one central, replay-safe retry coordinator for rate limits, overload,
timeouts, and transient transport failures. It caps attempts and elapsed time independently, respects bounded
`Retry-After`, cancels backoff, emits credential-free metadata, and refuses replay after any observable activity.
The remaining Codex lesson is to connect that classified health to route selection:

- maintain a bounded circuit state per concrete connection, not only per provider family;
- distinguish quota exhaustion, authentication, regional outage, overload, and transient transport health;
- reset health through successful probes and half-open attempts;
- let typed capability/policy matching select an authorized fallback without replaying visible work.

### 2.6 Durable event replay across Serve replacement

Hara now has cursor/ACK/exact-tail replay, a 10,000-event no-gap/no-duplicate test, bounded socket queues, and a
single-writer session lease. The replay stream is deliberately process-local. After Serve replacement its stream
ID changes and clients are told to fetch a fresh authoritative snapshot. The next step is a small durable event
tail or relay-owned stream cursor so a process upgrade can resume without a full refresh. That work must preserve
the existing fail-closed gap result and must never turn terminal byte streams into an unbounded database.

### 2.7 Idempotent remote commands

The canonical session mutation methods now support client-generated UUID `commandId` values. Core persists 64
recent identities, keeps exact results for the newest eight, returns matching durable outcomes across reconnect
and restart, and rejects payload reuse; if result retention expires, it still refuses to repeat the action and
directs the client to `session.history`. Raw input on a private terminal stream has a monotonic, payload-bound
`inputSeq`; a new stream starts a new sequence. Provider-owned Codex/Claude commands use the same payload-bound
UUID contract across reconnecting sockets, while `expectedTurnId` keeps delayed steer/interrupt requests on the
intended turn. The cache retains at most 64 command identities and 256 KiB per exact replay result. Their
receipts are deliberately Serve-lifetime only: after a process restart the provider-native session must be
resumed and inspected because Hara cannot prove a remote action did not happen. Session writes now also require
the current lease ID/epoch whenever a controller is active. Remaining: bind approval replies and legacy terminal
helper methods to command identity, give externally published Codex/Claude sessions a durable publication epoch,
and reconcile provider-owned receipts after restart before permitting a retry.

### 2.8 Typed provider capabilities and circuit health

Connection failover cannot be a string-only `fallbackModel`. Each connection should publish a typed capability
record: input modalities, tools, context, reasoning controls, data region, enterprise policy, quota source, and
health/circuit state. Failover selection only considers compatible, user-authorized connections.

### 2.9 Structured Agent progress and resumable tool items

Mobile should not have to scrape terminal prose such as “searched files” or infer whether a tool is running.
Promote model turns, reasoning/progress summaries, tool calls, approvals, diffs, todos, child-Agent activity, and
terminal outcomes into versioned item lifecycle events. Each item needs stable identity and
`started/completed/failed/cancelled` transitions. The existing redacted workforce projection and replay stream
are useful transport foundations, but they do not yet form an authoritative resumable item trace.

### 2.10 Managed workspace isolation for future writing Agents

Codex exposes repository-aware managed worktrees. Hara does not need that architecture for today's read-only
fan-out, but it becomes a prerequisite before specialists can edit in parallel. The Hara implementation should
create a bounded workspace per child, record its base revision and owned diff, run verification there, then ask
the root Agent to accept or reject the patch. Never merge automatically merely because the child reported
success.

## 3. What Hara should not copy

- OpenAI-only Responses/server assumptions. Hara's task and event types remain provider-neutral.
- Internal Guardian, cloud services, telemetry fields, or private protocols not part of public Codex contracts.
- The entire Rust application/UI architecture. Copying implementation shape is not a substitute for preserving
  Hara's existing TypeScript engine, Desktop integration, and provider adapters.
- Speculative parallel work that violates Hara's single-owner task semantics or produces overlapping edits.
- Automatic cross-provider replay after visible output, a tool call, file mutation, or any external side effect.

## 4. Delivery order and gates

1. **Completed foundation — retry core**: central classification/backoff/cancellation with deterministic tests.
2. **Completed foundation — compaction transaction**: stable window IDs, observed/estimated accounting, and
   save-before-install semantics; process-crash fault injection remains.
3. **In progress — event journal**: projection commits, torn-tail handling, and gap detection exist; add typed
   task/steering/approval/provider-attempt events and deterministic snapshot rebuild.
4. **Completed transport foundation — multi-client stream**: socket backpressure, cursor/ACK/exact replay,
   10,000-event duplicate/gap coverage, and explicit snapshot fallback exist.
5. **Completed control foundation — session lease**: one controller, takeover/revocation, epoch fencing, socket
   release, and legacy compatibility when unleased are covered by two-client integration tests.
6. **Next Agent slice — durable tree**: stable child identity/path, mailbox, lifecycle commands, shared budget,
   nested descendant recovery, and cold-resume tests.
7. **Next handoff slice — suspend/resume**: flush-before-suspend, pending-input disposition, successor readiness,
   and Desktop/mobile/terminal contention tests.
8. **Then — connection failover**: typed compatibility, circuit health, quota state, and explicit user policy.
9. **Before writable parallel Agents — managed worktrees**: isolated changes, owned diffs, verification, and
   root-controlled merge/rejection.

No slice is complete until it has unit tests, an interruption/crash test, bounded logs, and a real CLI/Desktop
integration check. These changes should ship incrementally after 0.166.1 rather than as a runtime rewrite.
