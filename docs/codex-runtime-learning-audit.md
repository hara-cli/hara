# Codex runtime learning audit

> Snapshot: 2026-09-08. Reference checkout:
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
| Engine-owned no-progress watchdog | Implemented after 0.168.2 | Successful calls are no longer assumed to be progress. Four repeated calls with substantially unchanged output stop, six same-evidence rounds stop, and unattended Serve/print/gateway/subagent work pauses after eight rounds without new checkpoint evidence or a newly completed todo. A 200k run-token ceiling accelerates the same pause; live steering starts a fresh unattended window. Desktop receives typed round/tool/token/todo counters and a stop reason instead of scraping terminal prose. |
| Healthy long-task continuation | Implemented after 0.166.1 | A fresh durable checkpoint and new evidence can open another bounded tranche automatically; deadlines, no-progress detection, cumulative task limits, and the absolute 256-round ceiling remain hard stops. |
| Verified user-decision retention | Implemented after 0.166.1; headless continuation completed after 0.168.0 | Successful in-process `ask_user` decisions are redacted, deduplicated, persisted outside the compactable transcript, and restored in future task prompts and forks. A persisted headless/gateway/cron question now closes as an addressable pause; the next same-conversation reply is durably retained before the original task and provider turn resume. |
| Honest end-to-end completion | Hardened after 0.168.0 | Change tasks require a fresh engine-readable completion receipt against every accepted check. File writes, scaffolds, tests, and scheduler registration prove only their stage. Missing verification preserves a resumable checkpoint and suppresses success prose; unavoidable questions pause durably instead of ending the task. Model-authored credential enrollment through chat or shell-history commands is withheld in favor of trusted masked surfaces. |
| Replay-safe provider retry | Implemented after 0.166.1 | One provider-neutral coordinator classifies empty pre-output failures, honors bounded `Retry-After`, backs off cancellably, and never replays after stream activity, output, or a tool call. SDK-local automatic retries are disabled. |
| Projection commit journal | Foundation implemented after 0.166.1 | Every durable snapshot appends a credential-free generation/hash record. Readers isolate malformed lines, ignore a torn final line, and report chain gaps. This detects projection loss but is not yet a typed event-source for every task action. |
| Remote mutation deduplication | Implemented after 0.166.1; write-ahead restart hardening completed after 0.167.0 | `session.submit/send/steer/interrupt` accept a client UUID, persist a prompt-free started receipt before model/tool execution, share concurrent work, save the first terminal result before ACK, replay across Serve restarts, and reject same-ID/different-payload reuse. A crash-window or failed terminal save blocks later mutation until an explicit authoritative resume reconciles task/history state. Provider-owned Codex/Claude submit, steer, and interrupt use the same contract in a private ledger, publish committed/failed receipts, and reconcile through provider read/resume. Desktop retains only opaque retry IDs plus salted payload fingerprints and fences delayed steer/interrupt by turn ID. Controlled terminal streams reject duplicate, conflicting, and out-of-order `inputSeq` values before the PTY write. |
| Slow-client memory boundary | Implemented after 0.166.1 | All Serve notifications share a 4 MiB per-socket queue ceiling. A sleeping/stalled renderer is closed with an explicit reconnect-and-refresh reason instead of retaining unbounded terminal or task frames. |
| Cursor/ACK/event replay | Restart-safe foundation completed after 0.167.0 | Broadcast events carry a stream UUID and monotonic sequence. A reconnecting client replays an exact bounded tail and ACKs its cursor. The redacted tail is checkpointed in private state and keeps its stream identity across an orderly Serve replacement. For a changed, expired, ahead, or oversized-frame cursor, `events.snapshot` supplies one authoritative fence for task, workforce, external-turn, and approval projections; Desktop applies it before buffered events newer than the fence. The tail remains bounded to 10,000 events and 8 MiB. |
| Single-writer Agent control | Implemented after 0.166.1 | One Desktop/mobile socket can acquire a session control lease. Takeover rotates an opaque lease ID and monotonic epoch, revokes the old controller, and fails stale delayed writes closed. Observer clients stay read-only; old clients remain compatible only while no lease is active. |
| Lossless terminal control handoff | Implemented after 0.168.1 | Feature-aware Desktop/mobile controllers stop accepting new input, drain their serialized queue, ACK the exact monotonic input fence, and remain frozen until a successor stream is ready. The server rechecks the old owner and commits the new controller atomically; timeout, launch failure, disconnect, or an intervening reattach cancels the transaction and restores the old controller. |
| Rewind projection repair | Implemented after 0.166.1 | Rewinding history also invalidates future task/todo/reminder/repeat-guard state and tells every client to refresh history. It deliberately does not pretend that transcript rewind reverted files. |
| Tool approvals and sandbox boundary | Implemented | Engine policy remains authoritative rather than trusting prose in the transcript. |
| Background jobs and bounded output | Implemented | Long-running processes and large tool output do not have to block or flood the main model context. |
| Deferred tool discovery | Implemented | Optional web, desktop, scheduler, external-agent, and MCP schemas stay out of the base prompt until provider-neutral `tool_search` activates an allowed capability. |
| Durable read-only Agent teams | Foundation implemented after 0.166.1 | Persistent Serve sessions now own stable nested Agent IDs/paths, parent/root turn provenance, a redacted durable mailbox, background spawn, list/wait/message/follow-up/interrupt/resume, terminal outcomes, shared concurrency/accounting, cold-interruption recovery, and replayable safe state events. The original `agent` tool remains the faster one-shot path. |
| Provider-independent runtime | Stronger Hara requirement | Hara keeps Anthropic/OpenAI-compatible/subscription/enterprise connections behind one engine contract. |
| External Codex app-server adapter | Implemented | Hara can preserve the provider's native execution path without leaking its native session ID into UI clients. |
| Hara Mobile companion bridge | Foundation implemented after 0.167.0 | CLI owns account login, Desktop device registration, explicit phone pairing, signed end-to-end encrypted relay envelopes, bounded publication of Personal coding-agent sessions, expiring control leases, idempotent remote commands, and sequenced terminal input. The mobile app and cloud account/relay deployment remain separate delivery work; the phone never receives provider credentials or native session IDs. |

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

The provider-neutral foundation is now implemented for persistent Serve/Desktop sessions. A session owns a
durable tree with stable child UUIDs and paths, parent/root turn provenance, role and lifecycle generation. The
private `0600` store uses locked atomic writes and retains redacted instructions, mailbox deliveries, lifecycle
state, aggregate usage, and terminal outcomes across process restarts.

The collaboration surface now supports background `spawn`, queued `message`, a new-generation `followup`,
targeted `wait`, `interrupt`, `list`, and cold `resume`. Nested descendants inherit the same bounded
`SubagentRuntime` concurrency policy. Mailbox deliveries are drained exactly once at a child run boundary;
unfinished children are reconstructed as interrupted after a cold start rather than being shown as live. Safe
Agent metadata is exposed through `session.agents.list` and replayable `event.agent_state` events, while prompts,
messages, results, credentials, and provider payloads remain outside the public projection. The original `agent`
tool remains available as the lower-overhead one-shot path.

The remaining Agent hardening is narrower:

- enforce provider-neutral tree safety ceilings for concurrency, active time, and rounds; subscription allowance
  must remain a separate provider/Control-native decision because units, coefficients, windows, and overage rules
  differ by provider and plan;
- add payload-bound idempotent command receipts for mailbox delivery and follow-up retries;
- fence automatic child completion delivery to its intended parent turn, so it cannot silently target a newer
  turn;
- expose the durable host to direct non-Serve CLI sessions; the persistent implementation currently belongs to
  Serve/Desktop sessions;
- add richer Desktop/mobile presentation and control for the existing safe Agent state projection.

The direct headless task path now also preserves an unanswered structured question and its bounded options as a
durable pause, normalizes a numbered remote reply to the retained option, and records it in the verified decision
ledger before model execution. Structured-output retries stop at that pause instead of guessing an answer. This closes the common
gateway/cron failure mode where a task either died at `ask_user` or forgot the answer after compaction; it does not
turn missing credentials into chat input, and credential enrollment remains restricted to a trusted masked surface.

Writable children should remain disabled until managed worktree isolation, diff ownership, and an explicit merge
step exist. Hara should preserve its present rule that parallel children cannot mutate the same working tree.

### 2.4 Flush-before-suspend and explicit handoff

Codex's turn suspension rechecks ownership under a lock, flushes pending output, closes the writer, and only then
announces that control stopped. Hara now applies the same ordering to provider-terminal control shared by Desktop
and the Mobile bridge:

```text
request handoff
  -> freeze new writes
  -> flush acknowledged frames
  -> recheck owner + lease epoch
  -> close old writer
  -> publish new owner
```

Suspension must be rejected while unaccounted child processes or tool side effects remain. Accepted pending
input is serialized behind payload-bound `inputSeq` receipts. The old controller acknowledges only the exact
accepted fence; a failed or unresolved input blocks that ACK. The successor terminal is started before the old
stream is released, but it cannot become authoritative until one synchronous commit rechecks the pending handoff,
old stream, and current controller. A racing reattach releases the uncommitted successor instead of overwriting
the newer controller. Legacy clients retain their old takeover behavior but receive the same final owner recheck.

The remaining work is broader runtime suspension rather than terminal ownership: apply an equivalent explicit
disposition to queued Agent mailbox items, live tool output, and child-process completion when an entire Serve
session is paused or migrated. The client must never infer ownership from a stale UI label.

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

The local replacement path is now implemented. Hara checkpoints a credential-redacted, size/event-bounded tail
under the same private-state rules as other control data, preserves its stream ID on an orderly Serve restart,
and rejects a second live writer. ACK traffic coalesces checkpoints; shutdown forces the final checkpoint before
the old writer acknowledges replacement. Desktop combines replay with `events.snapshot`, buffers frames arriving
during the snapshot, discards frames covered by its fence, then drains the newer suffix in order.

Remaining work is narrower: an abrupt process/host loss can still lose the small interval after the last
coalesced checkpoint, so the authoritative snapshot remains mandatory; a future cloud relay needs its own
bounded delivery/ACK cursor rather than treating a local Serve cursor as globally durable. Raw PTY byte streams
must continue to use terminal snapshots and must never enter this retained event database.

### 2.7 Idempotent remote commands

The canonical session mutation methods now support client-generated UUID `commandId` values. Core first
persists a content-free started receipt, then crosses the model/tool boundary. It retains 64 recent identities,
keeps exact results for the newest eight, returns matching durable outcomes across reconnect and restart, and
rejects payload reuse. If Core dies or the terminal save fails, the old UUID and new mutations fail closed until
an explicit `session.resume` reconciles the authoritative task/history projection; an unknown cold-start result
stays deduplicated as omitted rather than being guessed or executed twice. Desktop keeps the original UUID on
an outcome-unknown retry and forces resume before sending it again. Raw input on a private terminal stream has
a monotonic, payload-bound `inputSeq`; a new stream starts a new sequence.

Provider-owned Codex/Claude commands now use the same durable write-ahead contract. A started receipt crosses the
private fsync/rename boundary before the provider action; a bounded redacted result/error is committed before RPC
success/failure and before the corresponding `external.event.command_committed/failed` event. A crash between
those boundaries blocks the old UUID and all new mutation for that native session until `read`/`resume` observes
an authoritative non-live state. Desktop persists only the UUID and a salted payload fingerprint so it can retry
the exact logical action after renderer restart without storing prompt text. `expectedTurnId` keeps delayed
steer/interrupt input on the intended turn.

Remaining: bind approval replies and legacy terminal helper methods to command identity, persist the mobile
bridge's publication/receipt projection across bridge restart, and use the same durable receipt contract for
Agent mailbox/follow-up delivery.

### 2.8 Typed provider capabilities and circuit health

Connection failover cannot be a string-only `fallbackModel`. Each connection should publish a typed capability
record: input modalities, tools, context, reasoning controls, data region, enterprise policy, quota source, and
health/circuit state. Failover selection only considers compatible, user-authorized connections.

### 2.9 Structured Agent progress and resumable tool items

Mobile should not have to scrape terminal prose such as “searched files” or infer whether a tool is running.
Hara now emits a credential-free `progress` snapshot on task lifecycle events with provider rounds, tool-call
count, run-local input/output tokens, todo completion, unchanged-checkpoint age, similarity state, and a typed
warning/stop trigger. The Engine—not the model—computes it from successful observation fingerprints plus durable
task/todo state. Rewording a checkpoint, changing an offset/temp name, or alternating a 401/403 with a harmless
read cannot erase the relevant streak. New facts, artifacts, capabilities, completion evidence, or completed
todos reset it; changed explicit percentages and completion ratios also prevent a healthy poll from looking
stale, while bare offsets do not. No prompt or raw tool result is retained in the watchdog. A no-progress stop becomes a visible,
resumable task pause rather than an opaque RPC failure.

The remaining work is to promote individual model turns, reasoning/progress summaries, tool calls, approvals,
diffs, todos, child-Agent activity, and terminal outcomes into versioned item lifecycle events. Each item needs
stable identity and `started/completed/failed/cancelled` transitions. Hara has an authoritative reconnect
snapshot for task, workforce, active external turns, and approvals, plus a restart-safe event tail. Tool/diff/
message items still do not form a complete durable, replay-derived trace, so Mobile must use bounded conversation/
terminal snapshot APIs for those surfaces instead of inferring lifecycle from partial events.

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
4. **Completed local transport foundation — multi-client stream**: socket backpressure, cursor/ACK/exact replay,
   restart-safe redacted checkpoints, 10,000-event duplicate/gap coverage, and an authoritative Desktop snapshot
   fence exist. Cloud relay delivery still needs an independent bounded cursor.
5. **Completed control foundation — session lease**: one controller, takeover/revocation, epoch fencing, socket
   release, and legacy compatibility when unleased are covered by two-client integration tests.
6. **Completed Agent foundation — durable tree**: stable child identity/path, mailbox, lifecycle commands,
   nested descendant recovery, safe state projection, and shared concurrency/accounting are implemented. The
   next slice is hard tree-wide execution safety plus provider-native allowance admission, idempotent receipts,
   parent-turn delivery fencing, and direct CLI hosting. Hara must never derive cost or subscription exhaustion
   from transport token counters.
7. **Completed headless interaction slice — questions and completion**: persisted `ask_user` pauses, exact-task
   answer continuation, decision retention, credential-safe handoff, and fail-closed completion receipts are covered
   by unit and spawned-CLI integration tests. A full masked integration-secret editor remains a Desktop/Mobile UI
   delivery item rather than a reason to accept credentials through chat.
8. **In progress — Mobile companion**: account/device pairing, encrypted relay protocol, explicit publication,
   leases, command replay, and terminal sequencing exist in CLI. Complete the account/relay deployment and native
   mobile client against the versioned contract before broadening publication beyond coding-agent sessions.
9. **Completed terminal handoff slice — suspend/resume**: feature negotiation, exact input-fence ACK, successor
   readiness, rollback, atomic owner commit, and Desktop/mobile/terminal contention tests are implemented. Full
   Serve-session migration still needs typed disposition for live tools, child processes, and mailbox items.
10. **Completed no-progress control slice**: output-similarity and exact-call guards, eight-round unattended
    checkpoint/todo gate, run-local token ceiling, access-boundary coalescing, resumable stop state, and typed
    Desktop telemetry are covered by unit and Serve integration tests. Full item-level replay remains separate.
11. **Then — connection failover**: typed compatibility, circuit health, quota state, and explicit user policy.
12. **Before writable parallel Agents — managed worktrees**: isolated changes, owned diffs, verification, and
   root-controlled merge/rejection.

No slice is complete until it has unit tests, an interruption/crash test, bounded logs, and a real CLI/Desktop
integration check. These changes should ship incrementally after 0.166.1 rather than as a runtime rewrite.
