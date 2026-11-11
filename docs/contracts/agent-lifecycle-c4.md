# C4 lifecycle: private authority contract

C0 portable v1, actor/provenance, errors, fixtures and locks stay unchanged. C4 is an explicitly enabled Host-only lifecycle lane; production defaults remain off. A JSON lifecycle fact, receipt, proofRef or C1 policy is never an execution or physical-release capability.

The existing private authority aggregate migrates explicitly from schema2 to schema3, retaining the exact C3 control history. Its new `lifecycle` member is parsed by `agent-lifecycle-state.ts`. A historical accepted run starts as `legacy_unknown`, never `prepared` or proven not executed. The shared physical admission lock and absence of any legacy/unknown lease are migration prerequisites. Old readers/writers reject schema3; omitting the lifecycle bootstrap cannot downgrade it.

## Durable execution and closure

Each newly accepted attempt has an exact run/claim/binding/owner tuple and its original C0 acceptance. `prepared -> issued` is persisted before any execution-capable C2/runtime handle is exposed. Only the genuine original preparation, while still `prepared`, can publish `aborted_before_execution`. Historical absence of a live object, zero counters, missing files, ACKs or JSON never prove this. Published issuance cannot be undone even if construction later fails.

Physical quiescence and original lease release are distinct monotonic facts. Runtime-owned evidence is minted only after tracked work and teardown finish and all old effects are fenced. Publish quiescence before releasing the exact original lease; publication failure retains ownership. Genuine post-release proof or an authenticated, identity-checked explicit reconciliation can finish the receipt. UNKNOWN business effects stay UNKNOWN.

## Commands and projections

Task stop targets the exact Agent/task/run/claim and run epoch. Agent pause/dismiss targets only that Agent; resume checks current hold and every required physical closure in the same authority CAS. Main Hara cannot be dismissed or archived. The lifecycle outbox records per-target notification, capability revocation, schedule closure and logical archive separately; ACK or cancellation is not drain. A second Host must notify the actual owning Host through persisted control facts, without minting new work.

`AgentLifecycleProjectionV1` is read-only and contains no body, memory or credential. `AgentLifecycleRecoveryV1` is a proposed private authenticated Host request reviewed with this PR, not a new C0 action. It binds a new command/root and new operationId to the exact previous run/claim and terminal-proof digest. Only a proven never-issued and lease-released predecessor can acquire the next monotonic claim. Normal dispatch never overwrites a taskId; duplicate recovery is read-only and UNKNOWN cannot recover by changing IDs.

## Bounded history

Active C3 limits remain256 commands/128 runs/768 audit events/2MiB. The lifecycle member is bounded1MiB; immutable history segments are at most512KiB each/64 segments, with exact indices of at most4096 commands/2048 runs. Limits are exported constants, not an age policy. Publish and verify an immutable segment before the authoritative manifest/tombstones retire active rows. Original IDs, accepted/UNKNOWN, holds, recovery and audit stay queryable; no empty-ledger rebuild, reset, Bloom-only dedup or automatic business restart.

Unpublished archive failure retains active state. Referenced history failure refuses dependent reads/admission/recovery, without turning healthy unrelated active effects into the M1 global failure. Actual active authority corruption still fences that source permanently. Logical archive retains memories, records, work directories and private recovery; this is not user-data deletion or a new runtime/platform admission.

## Gates

The implementation requires exact-run and sibling isolation, genuine pending-Promise drain, explicit pre-issuance failures/crash cuts, two-Host notification, claim CAS, main/legacy guards, scoped approvals/grants, bounded archive/dedup and fault-domain tests. Exact final source gets the standard private HOME/TMP guard full test/build before the single draft PR is handed to review. Production/native/MCP/child/mobile activation remains out of scope.

## Runtime/Host closure ports

The genuine C4 control source supplies the C2 gate's synchronous `prepareQuiescence` sink. The real runtime alone mints the opaque proof after tracked Promise/native teardown/retirement, while its captured lease is still current. A failed publication keeps the lease. The final drain proof uses the same prepublished drain reference. Exact duplicate publication after completed reconciliation is read-only and still requires the genuine original runtime proof, original issuer and complete persisted tuple. Serialized facts are never accepted as proofs.

`reconcileQuiescentRelease` requires a genuine C1 authority and current authenticated management rights; it re-reads the positive persisted closure inside physical admission/lease locks, checks the complete owner digest/inode/times/scope and proves the old owner dead (or the exact current process instance). It never acquires an execution. Missing ownership alone proves nothing. Its in-process WeakRef table only marks an original receipt released after those checks; it supplies no permission or epoch. Recovered business outcomes become UNKNOWN conservatively.

The actual owning Host observes persisted exact target IDs every250ms while it has owned work. Explicit reconciliation gets a bounded30s observer window; the timer is unref'ed and closes with that Host. A second Host with an empty jobs map cannot report notification or drain. Notifications may only abort an already-owned matching job, and never start/rebind business. Independent synchronous C2 gates reject effects immediately without waiting for this notification interval.

## Explicit N5 recovery and conversation projection

Only the original opaque preparation plus its current captured lease may prove a never-issued acceptance. The terminal proof and recovery hold publish before original lease release. Post-issuance failure retains UNKNOWN, the accepted request journal and original owner; a missing permit or zero usage cannot retire it. Failed proof publication never frees the owner.

An explicit private recovery request binds the previous positive terminal digest and latest claim revision to a new C0 dispatch. Current manage, invoke and nodeUse are re-read in the same CAS. Duplicate operation is read-only; another operation cannot share the next claim. Original taskId/root/run/receipt remain retained. The conversation store accepts a same-task old-run to new-run projection only through a genuine opaque handle minted for that exact accepted claim. JSON, ordinary save and zero counters cannot reset its budget or erase prior requests/tasks.

The C implementation checkpoint is saved before its joint validation because the workstation load gate refused the test start. This is a local implementation commit, not acceptance: the final draft requires a rebuilt exact final SHA and full guard receipt.

## Scoped revocation and logical archive

C1 re-reads the persisted C4 run hold, Agent epoch/dismissal and terminal/physical facts on every grant and execution-policy use. This revokes copied handles in other Hosts as well as local handles; a resumed Agent epoch never revives an old command. Revocation acknowledgment is backed by that durable deny, never by an empty local capability list. Parent Workspace owner credentials, shared connections and sibling runs stay separate. Actual owned-job cancellation closes only that job's approval/interaction objects.

Pause/dismiss retries the exact durable schedule-pause receipt before publishing its phase. A cross-file failure keeps schedules paused and the receipt retained; resume never re-enables them. Dismiss captures the original directory config/epoch in private `archiveExpected`, rejects main Hara, and waits for every exact target's positive physical closure and revocation before logical archive. A cut after directory archive publishes only the matching epoch+1 receipt on retry. Files, memories, records and recovery remain. Protected scopes reject legacy archive/restore/configuration/schedule mutation before side effects; initialization-before-protection remains available. C0 v1 is unchanged.
