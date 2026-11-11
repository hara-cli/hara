# C3 command authority and control

C3 implements the trusted C2 control source for **personal, controlled, in-process Pi, depth zero**.
It composes current C1 policy, a durable original C0 command/claim, C2 effects and the existing opaque
WorkspaceRunPermit. It adds no model, dispatcher, external Agent execution authority or approval issuer.
The portable C0 v1 source, fixtures and lock are unchanged.

## Bootstrap and migration

Production/CLI/Desktop composition remains disabled. Only trusted Host-library composition can set
`boundaryCommandControl: true`, or the corresponding `startLocalWorkspaceServe` input
`agentBoundaries.commandControl: true`. RPC parameters, client capabilities, settings, imported data
and prompts cannot enable it. The separate 256-bit owner credential is still required; generic socket
credentials cannot obtain protected metadata or command access. C1's broad `runtimeEnforced: false`
projection remains false until product adoption is separately verified. The opt-in capability
`workspace.agent-command-control.v1` describes this narrow Host adapter, not native/cloud/UI coverage.

The existing scoped `workspace-agent-authority-v1.json` becomes **private schema 2** by explicit owner
initialization. C1 policy and C3 command/control/audit changes use that same private CAS, resource
generation, file-identity and parent-grant fences. There is no second policy mirror to keep atomic.
Migration preserves policy documents, increments their private revisions to retire old handles, and
records the previous revision/digest and trusted human/node. It does not change portable C0 versions.

First migration and physical session-lease acquisition share one cross-process private admission lock.
Any existing/ambiguous lease refuses first migration; neither age nor presumed owner death permits
activation over it. Legacy command/notification claims use the same lock; unresolved command or
queued/sending/unknown notification records also refuse first migration. Background legacy schedules
skip protected scopes without constructing their business adapter. Initialized schema 2 is idempotently readable. Corrupt/missing C3 state is preserved
and rejects controlled execution. A protected scope cannot reopen via the generic transport when
bootstrap is disabled; existing legacy RunPermits also recheck protection before effects. Legacy
policy configure cannot write schema 2; later policy changes require original commands.

The aggregate is bounded: 256 retained commands, 128 runs, 768 audit events and 2 MiB control state,
inside the existing 4 MiB private writer. No accepted/UNKNOWN identity is evicted or reset. New
admission reserves capacity for restrictive control/observations and fails closed at the limit.
Stop/pause/dismiss may use the reserve. A later reviewed archival/migration is needed to reclaim
history; this slice offers no destructive reset, automatic pruning or business retry.

## Identity and accepted work

Host derives provenance from its authenticated connection. Request-body source/role/principal,
Hub `external-agent-source`, delivered/saved receipts and approved booleans cannot authenticate a
human or produce an execution capability. A valid current reader may query an old original receipt
after reconnect/expiry without rewriting its provenance; it cannot re-admit that old intent.

A dispatch commits original command/digest, task/conversation, stable transport request mapping,
claimRevision, exact RunBinding/physical attempt, source issuer, initial Agent epoch and run epoch.
Acceptance alone has `execution.effect: none`. Preparing a real runtime then records acceptance by
the **Hara execution pipeline**, with a `work_…` reference; this is neither provider acknowledgment nor
business completion. A genuine locally started runtime can project `applying`. No model/tool is
called to decide whether a duplicate should execute.

An opaque intake/preparation is issuer-local, single-use and absent from every wire DTO. C2 bind is
single-use for the original command/run/claim/lease only. Root request, task and run identities of
accepted work cannot be reused with another command ID. The old effect journal separately refuses
same-operation replay under new effect IDs. Reconnect/restart does not mint a live issuer handle.
A different Host reports unavailable local control/UNKNOWN authority for an old unobserved run and
retains recovery actions; it cannot take a living or unproven-dead physical lease. This is read-only
reconciliation, not restored execution or a claim of an unknown business outcome.

## Epoch domains and arbitration

C0's single `expected.controlEpoch` means the current epoch of the **exact command target**.

| Action | Atomic authority change | Runtime consequence |
| --- | --- | --- |
| `task.dispatch` | Current invoke + nodeUse; exact current policy and Agent epoch; unique original claim. | One supported original run; no silent runtime fallback. |
| `task.stop` | Current manage; exact task/run/claim and run epoch; persist run hold and advance that run epoch. | Fences that run, preserves sibling runs. Actual drain remains separately observed. |
| `agent.pause` | Current manage and Agent epoch; persist hold and advance Agent epoch. | Fences this Agent's new admission and its old runs' new effects. |
| `agent.resume` | Fresh current manage command, epoch and exact holdId; clear appropriate Agent hold and advance epoch. | Opens fresh admission only; cannot revive old gates or clear run UNKNOWN/stop. |
| `agent.dismiss` | Current manage; terminal Agent hold and epoch. | Fences work and preserves records. Actual lifecycle/archive/revocation is C4. |
| `duty.update` / `boundary.update` | Current manage and revisions; matching frozen proposal; policy + epoch + original audit in one CAS. | Old policy/gates cannot produce new effects; prose grants no rights. |

C1 authorization is evaluated before epoch arbitration. A valid stop wins over an old same-domain
dispatch whether the stop commits first or the dispatch is accepted first. An unauthorized manager
cannot win by being newer or holding an Admin label. Personal v1 keeps collaboration/role fields null;
real two-owner-capability connections test the ordering, and restricted-right fixtures test authority
independently. This is not multi-human role enablement. Only a pre-commit CAS conflict is re-evaluated,
at most three attempts, with the original intent/expected epoch. No physical request is retried.

The proposal digest is SHA256 over UTF-8 `hara-agent-policy-proposal-v1\0` followed by canonical JSON
of the **whole** `{ duty, boundary, rights }` proposal. Canonicalization sorts object keys recursively;
arrays retain order. Duty update must retain boundary/rights; boundary update must retain duty.
The actual message digest similarly covers canonical `{ conversationId, message }` after the UTF-8
prefix `hara-agent-command-message-v1\0`. Host verifies actual submitted text against that digest.

## Physical observation and UNKNOWN

A logical hold is not proof that in-flight work stopped. Abort/disconnect, C1 handles and JSON cannot
report `execution.drain: observed`. The existing RunPermit must await all tracked operations, finish
native teardown where applicable, retire policy and release its original physical lease. Only then
can it mint a private proof bound to that exact permit/attempt. Concurrent close shares one drain.
C3 observes that genuine proof and can publish `drained`; it never adopts an arbitrary binding/proofRef.

Unknown/failed physical effects remain `status: unknown` + `EFFECT_OUTCOME_UNKNOWN` after drain or
manual stop. Drain proves physical quiescence, not successful business completion. Completed effects
mean their dispatches returned successfully; business acceptance still belongs to existing task
verification. A stop can preserve UNKNOWN while still persisting its control hold and later drain.

Publication failure keeps the genuine proof in its owning process and fences new effects. A controlled
authority that observes corrupt/missing control does not reactivate old permits when the file returns;
new work requires explicit Host reopen, with original accepted IDs still retained. Explicit
owner reconcile retries publication only. Without a retained genuine proof, a restart cannot infer
physical drain from an absent job/lease, elapsed time or a client acknowledgment. C4/provider-specific
original-request recovery remains separate. Source failure does not block a still-authorized
restrictive command from using retained stop capacity. It never changes UNKNOWN to not-started.

## RPC and privacy

All `workspace.boundaries.control.*` methods authenticate the real owner before Workspace lookup and
require explicit workspaceId, expectedGeneration and agentId. Strict fields reject approved/source,
callbacks, arbitrary RunBindings and paths.

| Method | Additional fields / result |
| --- | --- |
| `initialize` | Explicit private migration; returns bounded control projection. |
| `submit` | `command`, dispatch `message`, or matching update `proposal`; returns C0 receipt. |
| `receipt` | `commandId`; current original receipt only. |
| `inspect` | Agent/run/claim/hold metadata, local-control availability and recovery actions. |
| `audit` | Stable local event IDs, decisions, actor/node, epochs, policy revisions; no prompt/tool arguments. |
| `audit.ack` | At most 64 unique `eventIds`; acknowledges a persisted consumer projection, never authority/effects. |
| `reconcile` | Retries only this process's retained genuine drain observations. |

After activation, old send/resume/cancel, lifecycle/permission/config mutation, approvals, groups,
schedules and unsupported private projections refuse with a typed error. There is no boolean fallback.
The narrow old snapshot/receipt adapter additionally requires current **privateRead**; manage/invoke
do not imply reading private history. Protected media HTTP is disabled pending its reviewed adapter.
The new submit lane currently accepts only direct conversations and UUID task IDs; continuation,
answers, child work, channels, native engines, MCP, external control and remote/mobile ingress remain
unsupported. C4 lifecycle, C9 approvals, C10 private-surface expansion and C12 entry adoption require
separate implementation/review; no install, release or production activation follows from this PR.

Audit decisions share the control CAS. A consumer reads stable IDs, persists its projection and ACKs
those IDs; repeated ACKs are read-only and cannot erase original UNKNOWN/control facts. Projection
failure leaves unacknowledged events. Retained original commands identify duplicate reads without
appending a second business decision. Unauthorized or malformed untrusted inputs are rejected before
metadata and are not used to manufacture authenticated audit actors.

## Verification

Focused tests exercise actual WS Host composition and file effects, separate real owner connections,
original-ID duplicate/reconnect, pause/resume and exact task stop, genuine pending Promise/drain,
privateRead separation, second-Host lease refusal and disabled-bootstrap downgrade refusal. Disk/CAS
fixtures cover policy+command atomicity, independent process arbitration, bounded stop reserve,
corruption, counter exhaustion, original UNKNOWN and publication/ACK idempotence. C2's scoped-adapter,
explicit-deny and independent-inode tests also have in-process mutation checks. Passing these is
narrow Core acceptance; it does not establish UI, native, multi-human, cloud/mobile or release acceptance.
