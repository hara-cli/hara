# Codex runtime learning audit

> Snapshot: 2026-09-10. Reference checkout:
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
| Typed runtime journal | Implemented after 0.169.0 | Every durable snapshot appends a credential-free generation/hash record. CLI and Serve interleave bounded task, provider, message, tool, diff, Agent, mailbox, steering, control, approval, and compaction lifecycles with stable item identity. The deterministic reducer recovers their ordered safe projection and diagnoses torn tails, gaps, and invalid transitions. `session.runtime.replay` pages that projection without prompts, reasoning text, tool payloads, paths, diff bodies, raw provider errors, or credentials. |
| Remote mutation deduplication | Implemented after 0.166.1; write-ahead restart hardening completed after 0.167.0 | `session.submit/send/steer/interrupt` accept a client UUID, persist a prompt-free started receipt before model/tool execution, share concurrent work, save the first terminal result before ACK, replay across Serve restarts, and reject same-ID/different-payload reuse. A crash-window or failed terminal save blocks later mutation until an explicit authoritative resume reconciles task/history state. Provider-owned Codex/Claude submit, steer, and interrupt use the same contract in a private ledger, publish committed/failed receipts, and reconcile through provider read/resume. Desktop retains only opaque retry IDs plus salted payload fingerprints and fences delayed steer/interrupt by turn ID. Controlled terminal streams reject duplicate, conflicting, and out-of-order `inputSeq` values before the PTY write. |
| Slow-client memory boundary | Implemented after 0.166.1 | All Serve notifications share a 4 MiB per-socket queue ceiling. A sleeping/stalled renderer is closed with an explicit reconnect-and-refresh reason instead of retaining unbounded terminal or task frames. |
| Cursor/ACK/event replay | Restart-safe foundation completed after 0.167.0 | Broadcast events carry a stream UUID and monotonic sequence. A reconnecting client replays an exact bounded tail and ACKs its cursor. The redacted tail is checkpointed in private state and keeps its stream identity across an orderly Serve replacement. For a changed, expired, ahead, or oversized-frame cursor, `events.snapshot` supplies one authoritative fence for task, workforce, external-turn, and approval projections; Desktop applies it before buffered events newer than the fence. The tail remains bounded to 10,000 events and 8 MiB. |
| Single-writer Agent control | Implemented after 0.166.1 | One Desktop/mobile socket can acquire a session control lease. Takeover rotates an opaque lease ID and monotonic epoch, revokes the old controller, and fails stale delayed writes closed. Observer clients stay read-only; old clients remain compatible only while no lease is active. |
| Lossless terminal control handoff | Implemented after 0.168.1 | Feature-aware Desktop/mobile controllers stop accepting new input, drain their serialized queue, ACK the exact monotonic input fence, and remain frozen until a successor stream is ready. The server rechecks the old owner and commits the new controller atomically; timeout, launch failure, disconnect, or an intervening reattach cancels the transaction and restores the old controller. |
| Rewind projection repair | Implemented after 0.166.1 | Rewinding history also invalidates future task/todo/reminder/repeat-guard state and tells every client to refresh history. It deliberately does not pretend that transcript rewind reverted files. |
| Tool approvals and sandbox boundary | Implemented and replay-auditable after 0.169.0 | Engine policy remains authoritative rather than trusting prose in the transcript. Registered requests and terminal outcomes now have content-free task/turn-bound journal items; approval text and tool payloads remain only on the live protected surface. |
| Background jobs and bounded output | Implemented | Long-running processes and large tool output do not have to block or flood the main model context. |
| Deferred tool discovery | Implemented | Optional web, desktop, scheduler, external-agent, and MCP schemas stay out of the base prompt until provider-neutral `tool_search` activates an allowed capability. |
| Durable Agent teams and isolated writing | Hardened after 0.169.0 | Persistent Serve sessions own stable nested Agent IDs/paths, parent/root turn provenance, a redacted payload-bound idempotent mailbox, background spawn, list/wait/message/follow-up/interrupt/resume, terminal outcomes, shared concurrency/accounting, cold-interruption recovery, and replayable safe state events. Children are read-only by default; an explicit `isolated-write` child receives a private Git worktree and one owned, bounded Diff that requires fresh human approval to apply. Whole-tree and per-Agent generations, rounds, tools, active time, and actual transport tokens are durably bounded from the active saved connection's model capability; subscription allowance remains provider-authoritative. The original `agent` tool remains the faster one-shot path. |
| Provider-independent runtime | Stronger Hara requirement | Hara keeps Anthropic/OpenAI-compatible/subscription/enterprise connections behind one engine contract. |
| External Codex app-server adapter | Implemented | Hara can preserve the provider's native execution path without leaking its native session ID into UI clients. |
| Hara Mobile companion bridge | Restart-safe foundation implemented after 0.169.0 | CLI owns account login, Desktop device registration, explicit phone pairing, signed end-to-end encrypted relay envelopes, bounded publication of Personal coding-agent sessions, expiring control leases, idempotent remote commands, sequenced terminal input, persisted publications/outcomes, and a Relay-owned delivery cursor. The mobile app and production Account/Relay deployment remain separate delivery work; the phone never receives provider credentials or native session IDs. |

These are not placeholders. They are current runtime contracts documented in
`conversation-task-execution.md` and covered by engine tests/evals.

## 2. High-value mechanisms still to adopt

### 2.1 Append-only rollout log and deterministic replay

Codex persists typed rollout items and reconstructs state through deterministic processing. Hara now applies the
same provider-neutral contract through a bounded append-only runtime journal. Stable item IDs, schema version,
task/turn identity, monotonic sequence, timestamps, redacted metadata, generation chaining, torn-tail isolation,
append bounds, secure file handling, and gap/transition diagnostics cover task, provider, message, tool, diff,
Agent, mailbox, steering, control, approval, and compaction lifecycles. The complete private session snapshot is
still the authoritative content store; the journal is the deterministic, content-free execution projection.

Serve pages that projection through `session.runtime.replay` and reports integrity diagnostics instead of hiding a
gap. Prompts, assistant/reasoning text, tool inputs/results, workspace paths, diff bodies, provider error bodies,
endpoints, and credentials never enter this stream. Remaining work is process-level property/fault injection and
promoting safe todo/artifact identities; it is no longer a missing tool/diff/message lifecycle foundation.

### 2.2 Atomic compaction windows

Codex's `auto_compact_window` and compaction flow distinguish an observed server prefill baseline from an
estimate, assign stable window identity, and install replacement history as a completed checkpoint. Hara now:

1. assigns `windowId`, `previousWindowId`, and `attemptId` before summarization;
2. retains the source transcript until the replacement is validated and durably saved;
3. distinguishes provider-observed input usage from estimated tokens;
4. installs summary + preserved tail atomically, or keeps the previous live window unchanged;
5. writes content-free start/install/failure transitions for CLI and Serve and treats the paired projection
   commit as authoritative evidence when a crash loses the explicit installed item.

The deterministic reducer now handles the commit-to-terminal crash window. Remaining hardening is real
process-level fault injection before the request, after the response, and between transcript rename and
secondary journal/index writes, plus one reminder/fallback policy per window.

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

Mailbox messages and follow-up retries now carry a payload hash plus stable command identity. An exact retry is a
no-op, conflicting reuse fails closed, and both target generation and parent/root turn are rechecked before any
delivery or launch. A newer root turn interrupts older active children instead of allowing their completion to
silently target the new turn. The durable root budget reserves and then reconciles actual generations, provider
rounds, tool starts, transport tokens, and active time across every descendant; crossing a limit blocks the next
model/tool boundary. Context-derived admission uses the current saved connection's model capability, while plan
allowance, coefficients, reset windows, and overage remain separate provider/Control-authoritative facts.

Writable children now use the managed worktree/owned-Diff/manual-merge contract in section 2.10. The child still
inherits the current session's saved connection, account, model-capability policy, and organization authorization;
workspace mode never selects or broadens a provider. Remaining Agent work is to expose the same durable host to
direct non-Serve CLI sessions and add richer Desktop/mobile presentation.

The direct headless task path now also preserves an unanswered structured question and its bounded options as a
durable pause, normalizes a numbered remote reply to the retained option, and records it in the verified decision
ledger before model execution. Structured-output retries stop at that pause instead of guessing an answer. This closes the common
gateway/cron failure mode where a task either died at `ask_user` or forgot the answer after compaction; it does not
turn missing credentials into chat input, and credential enrollment remains restricted to a trusted masked surface.

Writable children remain opt-in and never mutate the source checkout during execution. Read-only remains the
default; only the root can inspect/reject an owned Diff, and applying it always crosses a fresh human approval gate.

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

The broader Serve suspension path now uses the same rule: it freezes new submissions and follow-up generations,
interrupts the current provider turn, drains observed provider/tool/Agent work within a hard deadline, and only
then persists a paused or token-bound migrating checkpoint and releases the writer. Queued mailbox data stays with
the durable tree for resume; a non-cooperative live effect makes suspension fail closed. The client must never infer
ownership from a stale UI label.

### 2.5 Retry health feeding typed failover

Hara's provider factory now installs one central, replay-safe retry coordinator for rate limits, overload,
timeouts, and transient transport failures. It caps attempts and elapsed time independently, respects bounded
`Retry-After`, cancels backoff, emits credential-free metadata, and refuses replay after any observable activity.
The next connection-aware slice is also implemented. The final policy-bound provider is decorated with a
process-local circuit keyed by saved connection, credential/endpoint generation, and model. Authentication,
quota exhaustion, regional unavailability, rate limits, overload, timeouts, and transient failures have distinct
thresholds; an opened circuit admits only one half-open probe and closes on success. Public Settings snapshots
contain capability and health metadata but never the runtime key, endpoint material, or credentials.

Fallback is now gated by the exact turn's image, tool, and known-context requirements, organization authorization,
fallback circuit health, and replay safety. Authentication can move only across an account/endpoint generation;
no error can trigger app-level fallback after provider activity, reasoning, text, output tokens, or tool use. This
is intentionally more conservative than guessing. Subscription reports such as Ark Agent Plan's delayed usage
detail are display/accounting inputs, not real-time routing signals; automatic switching uses only the current
request's explicit typed error or a fresh authoritative adapter result.

Remaining: persist credential-free circuit transitions in the runtime journal, support a user-authorized ordered
set of compatible saved connections rather than only one configured fallback, and add provider-specific live
allowance adapters where a documented account-scoped endpoint actually exists.

### 2.6 Durable event replay across Serve replacement

The local replacement path is now implemented. Hara checkpoints a credential-redacted, size/event-bounded tail
under the same private-state rules as other control data, preserves its stream ID on an orderly Serve restart,
and rejects a second live writer. ACK traffic coalesces checkpoints; shutdown forces the final checkpoint before
the old writer acknowledges replacement. Desktop combines replay with `events.snapshot`, buffers frames arriving
during the snapshot, discards frames covered by its fence, then drains the newer suffix in order.

An abrupt process/host loss can still lose the small interval after the last coalesced local checkpoint, so the
authoritative snapshot remains mandatory. The Mobile protocol and self-hosted Relay now have a separate bounded,
per-device delivery/ACK cursor and never pretend the local Serve cursor is cloud-global. Production deployment and
public-path fault testing are still required. Raw PTY byte streams continue to use terminal snapshots and never
enter either retained event database.

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

The mobile bridge now persists bounded publication and command-receipt projections across restart, and Agent
mailbox/follow-up delivery uses payload-bound command identity and turn fencing. Remaining: bind approval replies
and legacy terminal helper methods to command identity.

### 2.8 Typed provider capabilities and circuit health

Connection failover is no longer a string-only `fallbackModel` decision. Each concrete connection publishes a
credential-free capability record for wire protocol, image input, tool calling, reasoning, known context window,
data region, accounting source, and process-local circuit health. The current model set is handled conservatively:
for example `glm-5.3-flash`, `MiniMax-M3`, `Kimi-K3`, `Kimi-K2.7-Code`, and the documented Doubao multimodal route
may accept images, while DeepSeek image input is restricted to its explicit Vision model rather than inferred from
the provider family. A live account model catalog or Control policy remains authoritative over static product docs.

The compatibility gate uses only capabilities needed by the current turn. Unknown image, tool, or context support
does not qualify for automatic fallback; ordinary explicit text selection remains available. Enterprise policy and
saved-connection authorization are checked separately from model capability, so a technically compatible model is
not automatically an allowed route. Provider accounting never fabricates monetary or subscription consumption
from transport tokens when the provider has no current authoritative usage interface.

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

Provider attempts, messages, tools, diffs, Agent generations, mailbox deliveries, steering, and control now have
stable content-free lifecycle items and deterministic replay. Hara still intentionally keeps reasoning/progress
text, tool payloads, path names, diff bodies, and PTY bytes out of that journal; Mobile uses the bounded
conversation/terminal snapshot APIs when actual content is required. Remaining item work is safe todo/artifact
identity and UI projection, not reconstructing private content from lifecycle metadata.

### 2.10 Managed workspace isolation for writing Agents

Persistent Serve/Desktop sessions now support that contract. An explicit `isolated-write` child receives a
Hara-owned detached Git worktree at the exact source `HEAD`; ordinary children remain read-only. The child can use
only bounded file edit tools inside its canonical workspace. Hara disables hooks, rejects active executable Git
filters, symlink/submodule changes, `.gitattributes` mutation, unsafe paths, patches above 2 MiB, and more than 256
changed paths. It records a content-free owner/workspace/base/hash receipt and keeps the patch body private.

The root can inspect or reject the Diff. Apply re-captures the exact bytes, verifies owner and hash, requires the
source `HEAD` to remain at the base, rejects overlapping source changes, runs `git apply --check`, and always asks
for one fresh human approval—even in full-auto. There is no automatic merge. Crash-after-apply is reconciled with
a reverse check, and permanent session removal/rewind cleans up the Hara-owned worktrees.

## 3. What Hara should not copy

- OpenAI-only Responses/server assumptions. Hara's task and event types remain provider-neutral.
- Internal Guardian, cloud services, telemetry fields, or private protocols not part of public Codex contracts.
- The entire Rust application/UI architecture. Copying implementation shape is not a substitute for preserving
  Hara's existing TypeScript engine, Desktop integration, and provider adapters.
- Speculative parallel work that violates Hara's single-owner task semantics or produces overlapping edits.
- Automatic cross-provider replay after visible output, a tool call, file mutation, or any external side effect.

## 4. Delivery order and gates

1. **Completed foundation — retry core**: central classification/backoff/cancellation with deterministic tests.
2. **Completed foundation — compaction transaction**: stable window IDs, observed/estimated accounting,
   save-before-install semantics, typed terminal outcomes, and commit-backed crash-window recovery exist;
   real process-crash fault injection remains.
3. **Completed safe execution trace — event journal**: projection commits, torn-tail handling,
   sequence/generation gap detection, typed task/provider/message/tool/diff/Agent/mailbox/steering/control,
   compaction and approval lifecycles, deterministic reduction, and bounded Serve paging are implemented. The
   private session snapshot remains authoritative for content by design.
4. **Completed local and Relay transport foundation — multi-client stream**: socket backpressure, cursor/ACK/exact replay,
   restart-safe redacted checkpoints, 10,000-event duplicate/gap coverage, and an authoritative Desktop snapshot
   fence exist. Relay delivery uses its own persisted bounded per-device stream/cursor; production rollout and
   public-path fault testing remain.
5. **Completed control foundation — session lease**: one controller, takeover/revocation, epoch fencing, socket
   release, and legacy compatibility when unleased are covered by two-client integration tests.
6. **Completed Agent safety slice — durable tree and owned writing**: stable child identity/path, payload-bound idempotent mailbox,
   root/parent-turn fencing, lifecycle commands, nested recovery, safe state projection, and persistent whole-tree
   generations/rounds/tools/active-time/token ceilings are implemented. Opt-in writable children use isolated
   worktrees, owned Diffs, and human-approved conflict-safe apply. Direct CLI hosting remains; Hara never derives
   cost or subscription exhaustion from transport token counters.
7. **Completed headless interaction slice — questions and completion**: persisted `ask_user` pauses, exact-task
   answer continuation, decision retention, credential-safe handoff, and fail-closed completion receipts are covered
   by unit and spawned-CLI integration tests. A full masked integration-secret editor remains a Desktop/Mobile UI
   delivery item rather than a reason to accept credentials through chat.
8. **In progress — Mobile companion**: account/device pairing, encrypted relay protocol, explicit publication,
   leases, durable command replay, terminal sequencing, and Relay cursor recovery exist. Complete the production
   Account/Relay deployment and native mobile client against the versioned contract before broadening publication.
9. **Completed terminal and Serve handoff slice — suspend/resume/migrate**: feature negotiation, exact input-fence
   ACK, successor readiness, rollback, atomic owner commit, bounded provider/tool/Agent drain, durable pause, and
   token-bound cross-process migration are implemented with contention and recovery tests.
10. **Completed no-progress control slice**: output-similarity and exact-call guards, eight-round unattended
    checkpoint/todo gate, run-local token ceiling, access-boundary coalescing, resumable stop state, typed Desktop
    telemetry, and content-free item lifecycle replay are covered by unit and Serve integration tests.
11. **Completed connection safety foundation**: exact-route circuit health, typed compatibility, quota/region
    classification, account-aware authentication fallback, and no-replay-after-activity are covered by unit and
    Serve/settings tests. Ordered multi-connection user policy and durable health-event replay remain incremental.
12. **Completed writable Agent boundary — managed worktrees**: isolated changes, owned Diffs, strict verification,
   explicit rejection, and one-time human-approved root apply without automatic merge.

No slice is complete until it has unit tests, an interruption/crash test, bounded logs, and a real CLI/Desktop
integration check. These changes should ship incrementally after 0.166.1 rather than as a runtime rewrite.
