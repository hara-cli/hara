# Codex runtime learning audit

> Snapshot: 2026-09-05. Reference checkout:
> `/Users/zhujianbo/work/projects/ai/codex` at the locally inspected revision.

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
| Repeated-failure guard | Implemented in 0.166.1 | The second identical failure requires a strategy change; the third stops that exact loop. It no longer ends healthy work merely because 20 rounds passed. |
| Tool approvals and sandbox boundary | Implemented | Engine policy remains authoritative rather than trusting prose in the transcript. |
| Background jobs and bounded output | Implemented | Long-running processes and large tool output do not have to block or flood the main model context. |
| Provider-independent runtime | Stronger Hara requirement | Hara keeps Anthropic/OpenAI-compatible/subscription/enterprise connections behind one engine contract. |
| External Codex app-server adapter | Implemented | Hara can preserve the provider's native execution path without leaking its native session ID into UI clients. |

These are not placeholders. They are current runtime contracts documented in
`conversation-task-execution.md` and covered by engine tests/evals.

## 2. High-value mechanisms to adopt next

### 2.1 Append-only rollout log and deterministic replay

Codex persists typed rollout items and reconstructs state through deterministic processing. Hara still has
places where a whole JSON snapshot is the primary recovery unit. Add a versioned, append-only event journal for:

- task lifecycle and brief revisions;
- steering acceptance, delivery, promotion, and consumption;
- approvals and their terminal result;
- compaction installation;
- control-lease acquisition/release;
- provider attempts and failover decisions.

The current snapshot becomes a rebuildable projection. Each event needs an event ID, schema version, task/turn
identity, monotonic sequence, timestamp, and redacted payload. Startup must replay into the same projection in
property tests, and a truncated final event must be safely ignored.

### 2.2 Atomic compaction windows

Codex's `auto_compact_window` and compaction flow distinguish an observed server prefill baseline from an
estimate, assign stable window identity, and install replacement history as a completed checkpoint. Hara should:

1. assign `windowId`, `previousWindowId`, and `attemptId` before summarization;
2. retain the exact transcript range being replaced until the replacement is validated;
3. distinguish provider-observed input usage from estimated tokens;
4. install summary + preserved tail atomically, or keep the previous window unchanged;
5. emit one reminder/fallback per window rather than per retry;
6. test crash points before request, after response, and during projection install.

This is the most important remaining automatic-compaction hardening.

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

### 2.4 Central retry policy

Codex centralizes classified retry behavior for rate limits, server errors, and transport failures, respecting
`Retry-After`, exponential backoff, jitter, cancellation, and trace-safe attempt metadata. Hara should replace
provider-local ad hoc loops with one policy object:

- retry only operations classified as replay-safe;
- cap attempts and elapsed time independently;
- honor provider delay hints within a configured ceiling;
- make backoff cancellable by interrupt/steer/shutdown;
- record provider, connection, class, delay, and attempt without request bodies or authorization data;
- expose a circuit state to connection-level failover rather than interpreting strings in UI code.

### 2.5 Multi-client cursor, ACK, replay, and backpressure

Codex separates a session mailbox from turn-local pending input. Mobile adds a second reason to formalize this.
Every Desktop/mobile consumer needs its own acknowledged cursor. Slow observers receive a bounded snapshot plus
tail; they cannot retain unbounded terminal frames or hold the execution writer open. Input remains assigned to
an exact task/turn and a single control lease.

### 2.6 Idempotent remote commands

Every remote reply, approval, interrupt, and terminal input needs a client-generated `commandId`. Core persists
the first terminal result and returns it for repeats. An epoch or publication mismatch rejects the command; it
must never be silently re-targeted to a newer task.

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

1. **Retry core**: central classification/backoff/cancellation with deterministic clock tests.
2. **Event journal**: task/steering/approval/provider-attempt events plus snapshot projection and crash replay.
3. **Compaction transaction**: stable window IDs, observed prefill, atomic install/rollback fault injection.
4. **Multi-client stream**: cursor/ACK/snapshot/backpressure and 10,000-frame duplicate/gap tests.
5. **Control handoff**: flush-before-suspend, lease epoch, Desktop/mobile/WezTerm contention tests.
6. **Connection failover**: typed compatibility and explicit user policy after all earlier idempotency gates pass.

No slice is complete until it has unit tests, an interruption/crash test, bounded logs, and a real CLI/Desktop
integration check. These changes should ship incrementally after 0.166.1 rather than as a runtime rewrite.
