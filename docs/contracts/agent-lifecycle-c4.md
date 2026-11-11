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
