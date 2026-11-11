# Agent boundaries v1: C0 wire contract

Status: draft machine contract for review. This slice adds types, strict readers,
synthetic fixtures and non-destructive migration proposals. It registers no RPC,
capability, executor, lifecycle command, UI action or migration writer. Parsing a
record, comparing its context or hashing an intent never authorizes execution.

## Source of truth and consumers

Core `src/workspace/agent-boundaries-contract.ts` is canonical. Desktop vendors the
same bytes at `src/contracts/agent-boundaries-v1.ts`, with a consumption seam at
`src/agent-boundary-contract.ts`. Both repositories carry the same JSON fixture
corpus and content-addressed lock at `docs/contracts/agent-boundaries-v1.lock.json`.
The lock binds the exact source and fixtures, not a mutable branch name.

Run Core's `node scripts/check-agent-boundaries-contract.mjs /path/to/hara-desktop`
to compare both consumers without editing either checkout. Each repository's
normal tests also check its own frozen artifacts and compile a type-consumption
fixture. No dependency, native toolchain, application install or server is needed.

The contract version is independent of the existing Serve protocol-v1. Existing
initialize/capabilities and RPC methods remain unchanged. C1 and later slices must
explicitly negotiate and implement this contract before advertising it. An older
consumer does not infer support from a version string or a schema file. Unknown
versions/fields are refused; no fallback creates unrestricted permissions.
After v1 is reviewed/frozen, breaking shapes or semantics require a new version,
fixtures and paired consumer review. Draft changes must update both source/fixture
hashes together; the checker must reject drift.

## Identity and personal-only mode

Every document has `schemaVersion: 1`, `mode: personal` and a complete `context`:

- `scope` preserves the existing WorkspaceResourceScope tuple: local authority UUID
  or Account issuer/region/Realm UUID, plus the Workspace UUID. No implicit cwd,
  foreground workspace, display name or default authority may fill a missing part.
- `resourceBinding` preserves the existing scopeKey and immutable generation.
  C1 must compare the existing Core scope hash and current physical generation;
  the wire reader cannot authenticate or resolve storage identity.
- `humanSubjectId`, `nodeId`, optional device claim, and the exact local grant
  identity/revision remain separate. Grant subject/node claims must agree inside
  the envelope; live ownership, signature, grant state and physical resource checks
  still belong to the trusted Host. One person's devices do not bypass those checks.
- `collaboration` reserves organizationId, membershipId, membershipVersion, role
  and delegation. All are required and **null** in v1. Non-null role/member/team
  claims fail PERSONAL_MODE_ONLY. This is not an invitation or second human seat.

Local offline use remains possible: a trusted local human session supplies the
local subject; Account login is not a prerequisite. Local socket input, an Agent,
quoted text or an external session cannot self-declare that trusted origin.
Account-shaped fixtures only reserve the existing namespace; they do not enable
remote execution. C1 must verify the genuine Account/device proof and bind it to
this node/grant. The parser intentionally accepts syntactically consistent forged
claims; they must still fail trusted-context/signature/current-authority checks.
No serializable document is an ExecutionPermit or a policy issuer.

Cloud entitlements stay outside this contract: device count, human seats and
storage are independent configurable rights. Neither the free device default nor
a prospective paid quota is a hard-coded authorization constant here.

## Documents and scope of the two batches

| Document | Meaning | Required trust check beyond C0 |
|---|---|---|
| duty-profile | Public responsibility tags and exclusions, versioned separately | Editing a description cannot issue tools, resource access or owner authority. Private persona is not a field. |
| execution-boundary | Explicit opaque resources, tool catalog references/deny set, readOnly, budget reference and requirements | C1/C2 resolve resources and intersect current human, Agent, node and runtime policy; deny wins. No arbitrary filesystem root, wildcard, null allow-all or token is accepted. |
| command | Exact human intent, actor chain, target operation and expected policy/control revisions | C1 verifies actual transport/actor/device; C2/C3 check current grant, versions, owner/claim, hold and journal before effects. |
| command-receipt | Accepted/queued/applying/draining/observed/unknown facts, error and control version | Only the trusted Host may issue facts; match the original command/digest and actual runtime evidence. A parser does not make a receipt genuine. |
| work-claim | Root/task/Agent/attempt identity, claim revision and unresolved effect reference | C6/C3 serialize claim/owner updates and preserve the original effect across reconnect. |
| owner-decision | One explicit owner, needs_owner, or blocked | No first-candidate fallback. Owner choice never grants execution or data rights. |
| migration-draft | Original source digest/reference and confirmation requirement | Never runnable, never issues a grant; confirm separately under the original source/authority lock. |

The first batch covers C0–C6 and its C13 checks: dispatch, precise task stop,
duty/boundary changes, pause/resume and dismissal. Dismissal retains records and
recovery evidence; content deletion is a separate authorization and workflow.
The complete command taxonomy is documented in AGENT_BOUNDARIES_ACTION_PHASE.
That table is planning metadata, not feature enablement. Commands for handoff,
priority, activity/private memory, new approval decisions, sharing and report
routing are reserved for the second 1.3.x batch and fail ACTION_DEFERRED in this
reader. Shared data shapes do not enable those runtime endpoints.

C3 still needs minimal command audit/receipts in the first batch. Deferring C10's
record/memory surface does not remove audit or current-authorization checks.
Existing approved operation flows are not disabled or replaced by C0. In
particular, external-session messages remain display data; they cannot approve,
stop or dispatch a controlled colleague merely by carrying this schema.

## Command identity, conflict and evidence

`actorChain` preserves requestedBy, actingAgent, approvedBy and executingNode.
The first batch requires approvedBy=null; an external Agent or forwarded message
cannot mint human approval. The requested human/Agent/node must match the command
context/target. Expected revisions are safe integers (no truncation/coercion).
C1/C3 must reject exhausted counters before incrementing, and must compare current
versions under the relevant mutation lock. No client-provided role supplies rank.

`agentBoundaryCommandSigningText` specifies the exact signing/hash input:
UTF-8 bytes of `hara-agent-boundaries-command-v1` + one NUL + recursively
key-sorted compact JSON for the whole parsed command except intentDigest. Array
order and text are preserved; there is no Unicode, URL, whitespace or content
normalization. Non-JSON data, getters, sparse lists, unsafe integers, lone UTF-16
surrogates and unknown fields are refused before canonicalization. C1 must compute
SHA-256, compare intentDigest and verify the real human/device proof. Hex syntax
alone is not digest or signature verification. Proof references are opaque
references, never credentials embedded in JSON.

Identical command identity returns its original receipt in C3; same ID with a
different context/root/target/operation/revision/digest is a conflict, not a retry.
Refreshing UI metadata cannot resubmit, restart or enlarge the original command.
The issuedAt/notAfter interval is syntactically canonical UTC; C1 must verify the
current clock, actual expiry and configured limits. C0 never reads the wall clock
or extends a deadline. Cloud queue lifetime and approval windows remain governed
by their existing contracts, not a new default in this module.

Current deny/revocation wins; an authorized stop/hold fences newer dispatch. A
resume needs the current hold identity, exact control epoch and new current
human authority. Old queued work or reconnect cannot lift a hold. These are
C1–C4 implementation obligations, **not implemented by a parser**.

An offline stop can be queued without being physically stopped. A drain requires
an observation reference. Process drain can coexist with an unknown external
paid/tool effect: the fixture keeps drain=observed, effect=unknown, status=unknown
and retry=original_receipt_only. Do not report it as a completed effect, discard
its journal or rerun it on a new process/owner. C4 must bind observations to the
original run/claim; a transport ACK is not drain evidence.

## Stable error envelope

AGENT_BOUNDARY_ERRORS freezes code/retry pairs. Code and retry must agree. No error
includes source values, file contents, credentials or a private object name.
The public `field` is a structural location; unknown keys/values are not echoed.

| Codes | Client handling |
|---|---|
| CONTRACT_VERSION_UNSUPPORTED | Show unsupported contract; no weaker fallback. |
| INVALID_DOCUMENT / PERSONAL_MODE_ONLY / ACTION_DEFERRED | Refuse; do not turn malformed/deferred intent into an enabled command. |
| CONTEXT_MISMATCH / STALE_REVISION / CONTROL_HELD / GRANT_REVOKED | Refresh authorized state only; do not reissue the action or auto-resume. |
| AUTHORITY_UNVERIFIED / AUTHORIZATION_DENIED / RUNTIME_UNSUPPORTED / COUNTER_EXHAUSTED | Refuse; require the relevant genuine authority, supported runtime or explicit recovery. |
| COMMAND_ID_CONFLICT / EFFECT_OUTCOME_UNKNOWN | Consult the original receipt/recovery only; never create a new attempt automatically. |
| BOUNDARY_CONFIRMATION_REQUIRED | Present the bounded migration proposal to the actual owner; not an implicit approval. |

A future Serve transport can put `{contract, code, retry}` in its established RPC
error data; it must preserve existing protocol error semantics. C0 adds no numeric
RPC code, HTTP endpoint, handler or capability. Transport mapping is reviewed with
C1 instead of manufacturing a new renderer-only permission gate.

## Non-destructive migration

1. C0's pure asynchronous draft helper accepts only bounded JSON legacy versions
   1/2, hashes the exact supplied UTF-8 source text and emits an inert proposal.
   Its `sourceRef` is opaque; raw legacy records never appear in the wire draft.
   A corrupt/unknown source is refused, with original data retained by the caller.
2. No owns/description, old allow-all, creator, role, old cwd, token or imported
   instruction is converted to a resource/tool/actor grant. No node/runtime is
   started and no old task/UNKNOWN receipt is cleared. The draft always has
   state=confirmation_required, runnable=false and issuedGrant=null.
3. C1 must read the exact original file under the bound resource generation,
   verify strict text decoding and source digest under the write lock, resolve
   current human/node/resource policy and show a concrete diff. Confirmation
   authorizes only that reviewed mapping, never default all tools/directories.
4. A later writer uses the existing private-state lock/CAS and original scope;
   source changes or stale generation require a new review. Preserve unknown
   fields, local-only data, old workspaces, credentials and recovery pointers.
   Until a confirmed binding exists, the new boundary-controlled route is not
   runnable. Existing legacy behavior is not silently promoted or rewritten.
5. Old clients keep existing read/recovery paths. Once C1/C2 enforcement is
   activated, no legacy mutation may bypass it: the trusted Host either derives
   the exact intent/context from a genuine authenticated legacy transport and
   checks the same policy, or refuses the unsupported write. Unknown future
   contract versions are preserved and refused, never downgraded or replaced
   with empty state. Repeated reads/proposals cannot issue permissions or delete
   a migration source. C0 itself does not activate that runtime transition.

The shared fixture corpus is synthetic. It includes positive personal/local and
Account namespaces, exact commands, offline/drained/unknown receipts, ownership
conflicts and retained legacy data; negative mutations cover forged fields,
second-human reservations, wrong subject/Agent/node, missing stop/hold identity,
unsafe versions, deferred commands and invented success/permission shortcuts.
The same fixtures run against compiled Core and the actual Desktop consumer seam.
This C0 evidence does not claim runtime, multiuser, OS sandbox or release acceptance.
