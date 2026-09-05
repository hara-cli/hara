# Codex runtime learning audit

> Snapshot: 2026-09-06. Reference checkout:
> `/Users/zhujianbo/work/projects/ai/codex` at locally inspected revision `8e6a44b428`.

Hara should learn Codex's reliability mechanisms, not turn into an OpenAI-only clone. This audit compares the
runtime contracts that matter to long tasks, interruption, compaction, retries, and future mobile control.

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
| Tool approvals and sandbox boundary | Implemented | Engine policy remains authoritative rather than trusting prose in the transcript. |
| Background jobs and bounded output | Implemented | Long-running processes and large tool output do not have to block or flood the main model context. |
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

### 2.3 Flush-before-suspend and explicit handoff

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

Suspension must be rejected while unaccounted child processes or tool side effects remain. The client must never
infer ownership from a stale UI label.

### 2.4 Retry health feeding typed failover

Hara's provider factory now installs one central, replay-safe retry coordinator for rate limits, overload,
timeouts, and transient transport failures. It caps attempts and elapsed time independently, respects bounded
`Retry-After`, cancels backoff, emits credential-free metadata, and refuses replay after any observable activity.
The remaining Codex lesson is to connect that classified health to route selection:

- maintain a bounded circuit state per concrete connection, not only per provider family;
- distinguish quota exhaustion, authentication, regional outage, overload, and transient transport health;
- reset health through successful probes and half-open attempts;
- let typed capability/policy matching select an authorized fallback without replaying visible work.

### 2.5 Multi-client cursor, ACK, replay, and backpressure

Codex separates a session mailbox from turn-local pending input. Mobile adds a second reason to formalize this.
Hara now has the hard memory boundary: a socket beyond the advertised 4 MiB queue ceiling is disconnected, and
terminal streams already expose explicit attach/release ownership. The remaining work is an acknowledged cursor
per Desktop/mobile consumer. Reconnecting observers should receive a bounded snapshot plus tail and prove that
10,000 frames contain neither gaps nor duplicates. Input remains assigned to an exact task/turn and one control
lease.

### 2.6 Idempotent remote commands

The canonical session mutation methods now support client-generated UUID `commandId` values. Core persists 64
recent identities, keeps exact results for the newest eight, returns matching durable outcomes across reconnect
and restart, and rejects payload reuse; if result retention expires, it still refuses to repeat the action and
directs the client to `session.history`. Raw input on a private terminal stream has a monotonic, payload-bound
`inputSeq`; a new stream starts a new sequence. Provider-owned Codex/Claude commands use the same payload-bound
UUID contract across reconnecting sockets, while `expectedTurnId` keeps delayed steer/interrupt requests on the
intended turn. The cache retains at most 64 command identities and 256 KiB per exact replay result. Their
receipts are deliberately Serve-lifetime only: after a process restart the provider-native
session must be resumed and inspected because Hara cannot prove a remote action did not happen. Remaining: bind
approval replies and the legacy terminal helper methods to command identity, make provider-owned receipts
durable through explicit provider reconciliation, and add a lease/publication epoch so a stale command can never
be silently re-targeted to a newer controller or task.

### 2.7 Typed provider capabilities and circuit health

Connection failover cannot be a string-only `fallbackModel`. Each connection should publish a typed capability
record: input modalities, tools, context, reasoning controls, data region, enterprise policy, quota source, and
health/circuit state. Failover selection only considers compatible, user-authorized connections.

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
4. **In progress — multi-client stream**: hard socket backpressure exists; add cursor/ACK/snapshot replay and
   10,000-frame duplicate/gap tests.
5. **In progress — idempotent remote commands**: canonical session mutations persist bounded receipts and raw
   controlled-terminal input is sequence-deduplicated; add approval/legacy-control IDs and stale lease epochs.
6. **Next — control handoff**: flush-before-suspend, lease epoch, Desktop/mobile/terminal contention tests.
7. **Then — connection failover**: typed compatibility, circuit health, quota state, and explicit user policy.

No slice is complete until it has unit tests, an interruption/crash test, bounded logs, and a real CLI/Desktop
integration check. These changes should ship incrementally after 0.166.1 rather than as a runtime rewrite.
