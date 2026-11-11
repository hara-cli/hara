# C1: local identity and policy authority

C1 consumes the frozen `hara.agent-boundaries.v1` contract. It binds a verified local controller to the existing Workspace owner, node, local grant, Agent registry, resource generation and explicit Duty/Boundary policies. It does not dispatch work or grant permission to a runtime.

## Composition and authenticated transport

`AgentBoundaryTransports` is constructed only by trusted Host bootstrap with an independent, random 256-bit owner credential. `startLocalWorkspaceServe` accepts it through its trusted `agentBoundaries` option; CLI defaults do not supply this option. The credential must differ from the generic Workspace transport token. Native bootstrap must deliver it through a private channel to the owner controller, never to model/tool inputs, ordinary discovery files, shared logs, imported settings or external Agents. This slice provides the Host port and real loopback acceptance tests; Desktop/native bootstrap integration remains a later consumer step.

After the generic transport token has authenticated a real WebSocket, Host verifies the independent owner credential. It stores an opaque connection handle in a private WeakMap. Only a verified handle derives `local_human` provenance and a Host-generated connection proof reference. No request may create that handle or choose a subject, source channel or proof reference. A client name, capability, loopback address, OS process ownership, external display name, model text or `source`/`provenance` field proves nothing. This authenticates possession of the owner's local control capability, not physical human presence or a hardware-backed device signature.

Each reauthentication first retires the previous handle, including a failed attempt. Disconnect, server shutdown and Host update lease also fence admission. An authenticated owner on another connection cannot replay an old connection's command. Account, signed-device, organization, membership and delegation authority are not implemented here; the C0 collaboration fields stay null and remote execution stays closed.

Host `draft` builds the context, actor chain, provenance, expected policy revisions, issuance time and expiry itself. Admission compares the original declared provenance with the actual connection and rejects a mismatch as `AUTHORITY_UNVERIFIED`. It independently hashes the exact C0 signing text and verifies the deadline (maximum five minutes). It never rewrites a bad origin or recomputes a forged command into approval.

## Existing parents and explicit policies

`WorkspaceAgentBoundaryAuthority` derives the personal subject from the existing catalog row's `actorId`, the node from `hostId`, and the grant from `grantId`/`grantRevision`. It retains the existing host epoch, policy revision, scope key and resource generation. Labels, usernames, persona text and `owns` never become identity or authorization.

The only new private document is `workspace-agent-authority-v1.json` in existing scoped Workspace storage. It uses the existing private CAS writer, directory identities and generation fences. It contains explicit policies, their private revisions, the Agent epoch/configuration revision and current registry references. An absent policy is unconfigured and grants nothing; corruption is rejected and preserved. No read creates a policy, recreates a missing registry or imports legacy permissions. An owner can explicitly initialize an unconfigured policy. Existing grants fail immediately if its backing policy disappears.

A configuration write requires the current global CAS revision, exact C0 context, a live registered Agent and Host-owned resource/tool attestations. Initial Duty and Boundary revisions are 1; a changed document advances exactly one, while an unchanged document can keep its revision. Every accepted configuration advances the private policy revision, invalidating previously issued opaque command grants even when Duty/Boundary bytes did not change. The root owner capability is allowed to administer these grants; a grant's `manage` bit is command permission and is not a replacement root credential.

The four rights remain separate:

| Right | C1 meaning |
| --- | --- |
| `manage` | Admit the supported management command intents. It does not imply private history or memory access. |
| `invoke` | Admit `task.dispatch` intent only when `nodeUse` is also true. |
| `privateRead` | A distinct stored right for later private-surface consumers; it cannot authorize management or invocation. C1 exposes no history/memory read endpoint. |
| `nodeUse` | Allows invocation to use this node only together with `invoke`; it grants no invocation or management by itself. |

C1 policy administration is available only on the explicitly enabled owner route and affects C1 admission. C3 will bind live policy changes to its command ledger, arbitration and audit before protected execution is enabled. The existing runtime remains under its existing checks; this slice does not claim all legacy write routes already consume C1.

## Resources, tools and external executors

Resource references are opaque IDs obtained from Host registries, never caller filesystem paths. Local Host reuses `WorkspaceColleagueHomes`: explicit `prepareProject` registers the actual Agent's private working directory, and subsequent checks preserve its original inode and existing resource generation. A moved, replaced, unmounted or symlinked directory is unavailable; checking it never recreates or adopts a replacement. Each allowed access must be a subset of the attested registry access.

Tool allows require an exact tool/connector/catalog revision and a fresh trusted attestation. Missing tools and allow/deny overlap are denied. The default Host tool catalog is empty; this slice does not infer grants from prompt text or the tool names exposed by a runtime. Resource isolation, tool effects, budgets and approval consumption are C2/C3 obligations.

An external executor is optional metadata linked by an exact G0-registered external Agent/instance pair. It can reference an actual managed Agent and an attested resource. It never creates a Hara colleague, authenticates a human, issues an execution grant or controls the external process. The projection retains `controlled: false` and freshly reports `currentRegistration`; changed instances/unavailable registries invalidate that report. External mailbox text remains C0 `external-agent-source`, `humanPrincipal: null`, `use: display-only`.

## Host RPC and errors

All `workspace.boundaries.*` calls authenticate the private connection before Workspace lookup or policy disclosure. Mutations, drafts and checks also require the current `expectedGeneration`.

| Method | Result |
| --- | --- |
| `get` | Current personal identity, policy revision/status and metadata-only external links. |
| `prepareProject` | Explicitly register the Agent working directory and return opaque resource references. |
| `configure` | CAS-write an explicit Duty, Boundary and four-rights policy. |
| `linkExternal` | Record an exact registered external executor as uncontrolled metadata. |
| `draft` | Host-constructed C0 command intent for this connection; no execution. |
| `check` | Current identity/policy verification with `executable: false`, `effect: none`; no effect receipt. |

C0 errors are nested at JSON-RPC `error.data.boundary = {contract, code, retry}`; the existing i18n `data.code` remains intact. Source mismatch is `AUTHORITY_UNVERIFIED`, changed versions are `STALE_REVISION`, and absent policy is `BOUNDARY_CONFIRMATION_REQUIRED`. Generic parent/storage failures return a fixed authority error without request values, credentials or native paths.

The library issues `AgentCommandGrant` as an opaque, issuer-local WeakMap handle. JSON copies, foreign handles, retired grants and stale policy/transport/Agent/resource/parent bindings fail. `grantFacts` rechecks current authority every time and returns `executionPermit: false`, `controlVerified: false`. A later C2 consumer must still obtain the actual existing Workspace runtime permit and a current C3 control decision at each effect boundary. C1 does not validate a hold/control epoch or promise command idempotence, stop/drain, acceptance, completion or approval consumption.

## Acceptance

`test/agent-boundary-host.test.mjs` tests the actual loopback WebSocket Host and HTTP C0 Hub with synthetic private homes. It proves Host-generated provenance; a normal connection on the same endpoint cannot gain human authority through body claims; a valid human command in a real Hub message remains passive external text. Both paths assert zero provider activations, zero model calls, no conversation history and no approval creation. The Hub uses the real C1 catalog/grant/generation fence and rejects new admissions after parent revocation.

The tests also cover discovery secrecy, default-off composition, failed reauthentication, connection replay and actual project-inode replacement. `test/agent-boundary-authority.test.mjs` covers independent rights, same-name isolation (including two Workspaces on one Host/connection), CAS/revision limits, accessor rejection, missing/corrupt policy preservation, resource/tool revocation, registered external metadata and opaque grant lifetime. These tests are C1 acceptance, not C2 native isolation, C3 ledger, cloud/mobile or release acceptance.
