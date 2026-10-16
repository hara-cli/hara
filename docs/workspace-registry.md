# Workspace registry foundation (stage 1, not activated)

This branch implements a local Workspace metadata store and an additional frozen-connection guard.
It does **not** enable a Workspace product in Serve, CLI or Desktop, advertise `workspace.v2`,
migrate a real installation, or establish full tenant/process isolation. The maintenance release
branch and current session binding remain unchanged. A subsequent, separate legacy Space connection
memory fix is described in [the compatibility increment](workspace-compatibility-integration.md);
it does not activate this registry or create new execution audiences.

The [explicit local resource-storage increment](workspace-resource-storage.md) now supplies bound
adapters for keys/config, sessions, memory and lexical recall. It also remains host-private and
unactivated; it does not establish membership, full resource isolation or an Agent/Host execution grant.

## Model

`WorkspaceRecord` has an opaque `ws_<uuid>` id, name, creation time, optional legacy audience
alias, and one default connection. `WorkspaceConnection` has its own `mc_<uuid>` id, exact
Workspace owner, direct/managed source, private profile reference, route fingerprint, credential
generation, revision, and active/revoked state. There is no personal/enterprise Workspace kind,
parent Workspace, inherited membership, or tier-based authority.

`active` means enabled metadata, not verified provider health, available quota or authorization.
Plan/entitlement and membership services remain separate responsibilities. This owner-only local
registry is not a remotely accessible membership database or a substitute for Control policy.

Explicit bootstrap accepts credential-free projections made by `legacyWorkspaceConnection`.
All old BYOK profiles remain in **one** compatibility Workspace, named independently of any
provider/package. Each old managed Space keeps its boundary. An unavailable active profile,
duplicate ownership, corrupt/future schema or uncertain legacy mapping is an error, not a guess.
The same stored opaque IDs survive reloads; no profile, config, history or native Session is renamed.

New Workspaces have no connections, default, alias or copied data. The host can explicitly assign
a previously unassigned direct profile; attaching does not select a default. Reassignment of an
existing profile is refused, including a revoked one. Managed attachment requires a future
authenticated Workspace/enrollment mapping, not a caller-supplied tenant label.

### Confirmed independent-connection rule (2026-10-14)

A new Workspace requires an explicit connection addition even when its owner enters exactly the same
provider key used elsewhere. Each addition has a distinct private credential/profile reference,
connection ID, generation, default and lifecycle. Never deduplicate, transfer, discover or grant access
across Workspaces by key value/hash, provider account, label or the global login identity. Returning to
an already configured Workspace restores its own saved configuration; switching does not require
entering the key again and does not reauthorize an old run.

Local revocation or rotation of A's connection must leave B's stored connection and default unchanged.
This is not a claim of independent provider billing: the same upstream key can share quota, and
revoking that key at the provider can invalidate both connections. The new regressions prove only
the registry/frozen-binding rules using synthetic keys, not full data or membership isolation.

The login account is shared identity, not a global role. Future Membership authority is keyed by
`(workspaceId, accountId)` with independent roles, grants and revocation revisions. A's administrator
must not become B's administrator or be able to read B's credentials, history, memory or tasks.
Membership and full storage partitioning remain unimplemented next-stage gates below; this local
registry is deliberately not exposed as their substitute.

## Storage and display

`WorkspaceRegistryStore` requires an explicit absolute home and has no constructor side effects.
`initialize` must be called deliberately by a future trusted composition root, not on import or
through today's startup path. It uses the existing symlink-safe private-state implementation:

- `.hara/workspaces.json`, owner-only file/directory permissions;
- per-resource interprocess lock, expected revision and filesystem compare-and-swap;
- bounded 1 MiB reads/writes, at most 128 Workspaces and 1,024 connections;
- corrupt or future state preserved rather than repaired/overwritten;
- no plaintext model key, device token, endpoint or private prompt in registry records.

Legacy credentials stay in their existing private stores. The registry stores a private route
fingerprint and an opaque credential generation; neither goes to the renderer. `workspaceDirectory`
and `workspaceConnections` use explicit allowlisted fields. **The trusted host must verify membership
and visibility before calling either projection.** Do not expose these helpers directly as RPC handlers.

## Frozen run connection

`captureWorkspaceRunConnection` fixes the Workspace, connection, profile, credential generation,
connection revision and model. Selection/default changes do not rewrite a captured run. Route/key/
enrollment changes, expiry, revocation, deletion or missing state refuse execution without using
the global active profile or another connection. Explicit reauthorization creates a new generation;
old bindings stay invalid even if the connection is restored.

`bindWorkspaceProvider` copies the binding and checks fresh registry/profile state before and after
provider preflight and inference. It preserves the inner provider's preflight, policy version,
capabilities and errors; it does not retry a rejected or outcome-unknown operation. It must wrap the
existing organization-bound provider, **not replace** authenticated Control refresh, model policy,
tool filtering, membership or action approval. None of today's provider construction paths are
switched to this wrapper in stage 1.

A request already accepted externally cannot be unsent by revoking local metadata. The guard does
not claim to cancel an accepted paid request, retract streamed text, roll back external effects or
provide an OS sandbox. Streaming delivery and result acceptance still need audience-aware routing.

## Verification

```sh
export PATH=/Users/zhujianbo/.nvm/versions/node/v22.23.1/bin:$PATH
npm run build
node --import ./test/setup-isolated-home.mjs --test test/workspace-registry.test.mjs
```

The regression tests use synthetic profiles, fresh canonical temporary homes, two real child
processes for a conflicting revision, and fake providers. They cover exact ownership, no copied
keys, stable persisted IDs, secret-free display, frozen defaults/models, route and enrollment
changes, revoke/restore generations, stale updates, corrupt/oversized state, symlink/hardlink
preseeding, existing policy errors and no request replay. No real provider, mailbox or user home
is involved. Full-suite results are recorded in the workspace-level implementation handoff.

## Required next stages

1. Authenticated Workspace membership and enrollment mappings; server-side authorization on reads
   and mutations, versioned capability negotiation, exact request/late-response routing.
2. Partition sessions, history, memory/search, files, Agent identities, connectors, queues, approvals,
   budgets and audit by stable Workspace plus the applicable conversation/resource audience.
3. Persist trusted run bindings and integrate the guard at every actual execution boundary, including
   vision/judge/sidecar and external Runtime paths. Preserve Control and provider-native sessions.
4. Connect the reviewed UIUX prototype, Workspace switching and one multi-connection settings UI;
   old clients remain compatible and may not execute unpartitioned new Workspaces.
5. Versioned Collab/Desk integration, explicit legacy backup/restore rehearsal and separately
   authorized rollout. Desk's current single-organization deployment does not become multi-tenant
   through a new local metadata file.

Until these stages are verified, do not offer new registry Workspaces as an execution feature or claim
that all Hara information is isolated merely because this metadata layer's tests pass.
