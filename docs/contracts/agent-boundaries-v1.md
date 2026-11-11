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

Every agent-boundary document has `schemaVersion: 1`, `mode: personal` and a complete `context`:

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
C1 derives provenance from the genuine authenticated transport first, then
requires the command claim to match exactly; a request body cannot select
local_human or signed_device authority. An external message containing a
syntactically valid human command stays display content and never enters the
command route. Intent digests remain unverified wire claims after parsing; C1
must compute the signing input digest and verify the actual source proof.
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

## Agent Hub external source and transport extension (C0 only)

The Hub family is frozen alongside the human family under the same C0 v1 source,
fixture corpus and lock; it does not define a competing Hub-owned wire format.
This independent `AgentHubDocumentV1` union is not an `AgentBoundaryDocument`.
It adds no command origin, human actorChain, grant, execution status, RPC, token
issuer, transport adapter or model/tool/task entry point. Human command v1 bytes
and validation remain unchanged. Hub ingress remains a passive mailbox.

Core and Desktop export the same types: `ExternalAgentSourceV1`,
`HubSavedFactsV1`, `HubSavedReceiptV1`, `HubTransportReceiptV1`, `HubReceiptV1`,
`HubErrorV1` and `HubResourceBindingV1`. `parseAgentHubDocument` strictly parses
only these distinct shapes. Its local parse failures use the existing
AgentBoundaryContractError; the serialized lower-case Hub error domain is separate.
Both parsers reject each other's documents, including superficially similar ACKs.

All Hub documents require schemaVersion=1, mode=personal and a fixed Host binding
of schemaVersion/scopeKey/generation. They do not carry the human command context.
The external source kind is `external-agent-source`; actor.kind is
`external-agent`, with externalAgentId and exact registered instanceId.
identityBasis=registered-credential is a claim label, not token verification.
humanPrincipal must be null, contentTrust=untrusted-reference and use=display-only.
No token, token digest, arbitrary from, display metadata or native transcript is
serialized. The Host authenticates a revocable per-connection credential and
selects that connection's frozen registered agent/instance. Raw from is lookup
only, never the source of authority, even if it names a real registered Agent.

`createAgentHubBoundaryContract(binding)` returns Hub's four mandatory ports:
externalSource(registeredAgent), isExternalSource(unknown), savedReceipt(facts),
isSavedReceipt(unknown). It copies the binding and makes immutable outputs.
Validators require the exact captured scope and generation as well as strict
shape/kind; they do not check live generation, registration, token validity,
connection ownership or whether an actual commit occurred. That remains Hub/Host
work. A caller supplying a forged binding or identity has not authenticated it.
Registered metadata may include alias/displayName/engine; only the registered pair
is projected into the C0 source. No Hub source or human contract is duplicated.

The inbound `hub-ingress-receipt` accepts status=saved only and exactly five save
facts: messageId, requestId, connectionId, positive safe-integer seq and canonical
UTC savedAt. savedAt is the Store's record timestamp, not independent fsync proof.
The Store emits this ACK only after its durable transaction for the message,
attachment references, idempotency record and sequence. Parsing or calling the
factory does not commit anything. Retries resolve the original binding +
connectionId + requestId across token rotation; same identity/different digest is
conflict. Credential epoch is revocation/audit state, not a new dedupe identity.

The separate `hub-transport-receipt` has operationId, exact target pair and positive
safe receiptRevision. States are accepted, queued, delivered, rejected or unknown:

- accepted means the Host recorded intent, with null evidenceRef/error; no delivery.
- queued and delivered require a non-null opaque G0 evidenceRef and null error.
  Evidence must come from the precise transport operation; neither state means
  read, approved, model started, task accepted or an execution effect completed.
- rejected has a stable non-null error and null evidenceRef. It cannot hide an
  uncertain dispatch under a known rejection.
- unknown requires dispatch_unknown/query_original, with optional evidenceRef.
  Keep the original operationId, query its original receipt and never automatically
  redispatch, create a replacement operation or fall back to human commands.

AGENT_HUB_ERRORS freezes these lower-case code/retry pairs:
invalid_request/none, unauthorized/none, conflict/query_original,
quota_exceeded/explicit_user_only, unsupported_attachment/none,
registry_unavailable/same_request_only, store_unavailable/same_request_only,
draft_present/explicit_user_only, target_unavailable/explicit_user_only,
transport_unavailable/explicit_user_only, dispatch_unknown/query_original.
The error is only {code,retry}, with no free text, private paths, content, stack,
credential or hash. Unauthorized responses do not reveal whether a token was
revoked or a connection exists. Retry values are recovery hints only:
same_request_only permits the same inbound idempotency lookup/retry, never an
autonomous egress send. A failed/ambiguous store write must consult the original
record; explicit_user_only still requires a genuine new human action when safe.
Human UserAction proof for any future egress is separate from ExternalAgentSourceV1
and from the inbound credential. This C0 slice does not implement that proof or G0.
