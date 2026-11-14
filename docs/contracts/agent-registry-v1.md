# Managed Agent registry v1 (R1)

This contract describes source A: external sessions explicitly created by Hara.
It does not implement the Agent mailbox, proactive status, external egress or a
tmux source. Core and the independent ag operations tool can consume the same
versioned schema and golden corpus; neither one may treat legacy pane-derived
ag metadata as a compliant source.

## Composition and authority

`ManagedAgentRegistry` implements W0 `AgentHubDirectory`. The trusted Host
constructs it with its exact home, C0 resource binding, shared HaraStorageQuota
and synchronous current-authority fence, and injects it into the owned
`ExternalSessionRegistry`. Production Host/bootstrap/CLI/Desk composition is R2
and R3, not claimed by this library slice. No model, renderer or Agent message
can register a session by supplying this JSON.

Only successful explicit createCodingSession/createSession and explicit Hara
Live recovery creation publish launch metadata. The observer reads the opaque
returned ID and explicit launch label, never provider title or messages. The
existing native operation is not retried if metadata publication fails: creation
still returns its original result, while the directory becomes unavailable and
refuses W0 sender grants. This avoids duplicating an already-created Agent.

No adapter inspect/list/read/resume/fork, terminal snapshot, input, queue,
process scanner or transcript reader is called to list this directory. Native
operations explicitly requested elsewhere retain their original behavior. R1
does not turn those operations into discovery for Hub.

## Wire format

See agent-registry-v1.schema.json and agent-registry-v1.fixtures.json.
The lock binds these files and src/agent-hub/registry-contract.ts. The C0 binding
uses its existing schemaVersion/scopeKey/generation shape. C0 source and receipt
discriminants are unchanged.

The envelope has contract=hara.agent-registry.v1, schemaVersion=1, the exact
binding, source=core-managed, capturedAt and an explicit availability. Available
snapshots carry a nonnegative safe-integer revision and error=null. Unavailable
snapshots carry revision=null, error=registry_unavailable and no agents. An
unavailable source is never a healthy empty directory. Version mismatch is a
refusal, not permission to fall back to an unversioned ag file.

Agent records carry only agentId, instanceId, alias, displayName, engine,
sessionSource, createdAt, registeredAt, lifecycle and state. Extra fields,
accessors, nonplain objects and duplicate identities are rejected. No PID, cwd,
argv, native thread ID, credentials, private controller ID or message preview
cross this boundary.

Normative constraints beyond generic JSON Schema:
- alias is exactly agent- followed by agentId. The source-specific opaque ID
  prefix matches sessionSource. Non-runtime source equals engine; runtime
  supports codex or claude only. Unsupported future sources need review.
- displayName is 1..160 UTF-16 code units, matching W0, with no C0/DEL or bidi
  override/isolate controls. JSON Schema maxLength counts code points, so the
  x-maxUtf16CodeUnits annotation and golden boundary cases MUST also be enforced
  by a Python consumer (UTF-16-LE encoded byte length divided by two).
- timestamps are canonical UTC ISO strings with three fractional digits and
  valid calendar values; they are metadata, never authentication.
- at most 128 distinct agents; encoded snapshots and private catalogs are at
  most 262144 UTF-8 bytes. Do not evict old entries silently to admit new work.

## Identity and lifecycle

agentId is the existing Hara opaque external session ID, not a provider ID.
instanceId is a fresh registration UUID on explicit creation. Each registry
controller has a private UUID; persistent entries remember their owner, while
only that controller's current in-memory map can satisfy registeredAgent.
This is a logical Host registration, not proof that an OS process is alive.

A new controller can display saved launch labels, but previous registrations
become lifecycle=unknown and do not satisfy W0 lookup. Reads never resume native
sessions or reissue tokens. A replacement creation rotates instanceId, so old
grants no longer match. Removal captures its expected instance before awaiting
the native operation; a late result cannot retire a replacement. Failed remove
does not claim an ended session. Close fences this controller before awaiting
adapter shutdown; it does not claim every native process has exited.

state is always unknown in 1.3.0, including after native activity or a completed
turn. lifecycle=registered/ended/unknown is registration metadata, not idle,
busy, waiting, draft, human approval or task completion. Proactive reporting
belongs to the reviewed 1.3.x mailbox contract.

## Storage and failure

The small private catalog lives in the existing private Hara namespace under
agent-registry/<scopeKey>/<generation>/agents.json. It uses the existing
symlink-safe private-state binding, frozen directory identity, per-resource
lock, CAS publication and shared home quota. Scope generations do not overwrite
one another. Mutable raw state and controller IDs are not wire documents.

Corrupt/missing/replaced state, authority failure, quota failure or publication
uncertainty fences this object. It neither repairs from native history nor
silently recovers when a missing file reappears. Host lifecycle may explicitly
construct a new controller under current authority; that is not an ingress
retry grant. All callbacks here are trusted Host ports, not request fields.

The schema parser proves syntax only. Neither a saved file, parsed JSON,
lifecycle=registered, a Hub saved receipt nor an ag operations message proves
human intent or permission to dispatch. R1 contains no send/approval API.
