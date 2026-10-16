# Workspace resource storage — local host slice

Status: explicit host-private adapters, not activated in CLI/Serve/Desktop startup. No new RPC,
`workspace.v2`, execution capability, migration, release, or deployment is implied.

## Implemented boundary

`WorkspaceResources(explicitHostHome, verifiedScope)` binds the existing profile/config, session,
memory and lexical-recall implementations and the new explicit Agent catalog to one private partition. Construction performs no writes;
`initialize()` deliberately creates or reopens it. It never changes HOME, USERPROFILE, cwd, a foreground
selection or environment overrides. Concurrent A/B operations retain their original contexts.

The exact namespace is either:

- local: schema + Workspace UUID + immutable local authority UUID;
- hosted: schema + Workspace UUID + Account issuer origin + CN/GLOBAL + enrolled Realm UUID.

The host must obtain these values from trusted local registration or verified Account context.
Syntax validation is **not** membership, delegated Agent identity or a HostGrant. Identical Workspace
IDs under different authorities, regions, issuers or Realms do not merge. Nothing selects a scope from
cwd, a model argument or a renderer-supplied path.

Storage is below `<hostHome>/.hara/workspace-data/v1/<domain-separated-scope-hash>/`:

```
scope.json                        immutable scope + storage generation
state/.hara/resource-binding.json  independent data-side generation binding
state/.hara/profiles.json          this scope's private connection profiles
state/.hara/config.json            this scope's optional base configuration
state/.hara/workspace-agents-owner.json  immutable main Agent/storage owner
state/.hara/workspace-agents.json   Agent identities, lifecycle epochs and private config snapshots
state/.hara/sessions/              transcripts, metadata, journals, locks
state/.hara/session-index/         this scope's acceleration index
state/.hara/memory/global/         this Workspace's shared memory
state/.hara/memory/projects/<id>/  per-checkout memory within this Workspace
```

The project hash uses a canonical, explicitly supplied project root inside an already selected resource
scope. It is a storage bucket, not cwd-derived Workspace enrollment or project execution permission.

## Keys, history and memory

New storage is empty. No legacy key, Account login, managed token, persona, memory, transcript,
approval, semantic index or reviewed learning is copied or discovered. Named direct connections reuse
the private profile writer and require an independently supplied key. Identical key values in A/B are
two records; removing/changing A does not affect B. Upstream billing/revocation may still affect both.
Connection results are **host-private and may contain secrets**: never return them over RPC or place
them in prompts, logs, renderer state or localStorage. Managed enrollment is not added here. Oversized
profile writes are refused before replacing the existing readable registry.

Sessions persist a strictly validated resource binding. Foreign, unbound or wrong-generation copies
cannot load into a scoped store or overwrite its existing transcript. Legacy readers reject scoped
transcripts placed in the old directory. New transcripts are stamped on first save; existing legacy
files are never adopted by first load/save. Storage binding grants no Runtime/task permissions.

Locks, metadata caches and index-migration caches use the full path plus scope/generation. A/B may use
the same session ID concurrently without losing ownership tokens. Scoped paging wraps the existing
cursor with the exact generation; foreign cursors are refused, not downgraded. Journals use the same
session partition. The real SessionHub accepts this SessionStore adapter for storage operations; that
does **not** make Serve's other dependencies multi-Workspace safe.

`global` memory means shared inside this Workspace, not all user Workspaces. Project memory does not
fall through to `<checkout>/.hara/memory`. Legacy HARA_MEMORY, reviewed learning, embedding credentials
and semantic indexes are ignored by explicit resource stores. Search is lexical-only and cannot make
a paid embedding call. Legacy behavior remains unchanged without an explicit resource context.

## Filesystem and asynchronous writes

Reuse the existing private directory binder, bounded no-follow/hard-link-refusing reader, CAS writer
and interprocess locks. Missing, corrupt, future, oversized or mismatched scope/data markers fail
closed; they are never re-created beside existing data. Open stores pin directory inode identities,
including each visited nested memory/session/index directory, rather than just the outer state root.
Recall uses the private reader even if a directory changes during an async walk. Scoped memory files
are 0600 and capped at 256 KiB.

Memory snapshots retain the original private directory through write preparation and commit; a late
alias cannot be canonicalized into another Workspace's target. Session filesystem operations have
pre/post identity fences. If a staging open races a directory replacement, its descriptor is closed
before writing content. The same checks cover session indexes, journals and lock-file operations.
Scoped removal first moves one regular, single-link entry to an unpredictable claim and verifies its
original inode before unlinking. A mismatched claim is restored without overwriting a successor;
uncertain recovery is retained for explicit inspection, not retried against another entry. Recursive
directory deletion is not supported by this lane. These checks do not promise OS-level protection
against an administrator concurrently manipulating every path or forging all state.

Async memory mutations capture the original synchronous authority check and pass it to
`atomicWriteText`. It checks beside cancellation immediately before visible commits, not merely after
the Promise finishes. Denial after claiming an old entry can still restore that verified old inode;
it never authorizes the replacement or an automatic replay. Async authority callbacks are rejected.

These are application/storage safeguards, **not encryption, an OS sandbox, or protection against a
host administrator who can forge every file**. They do not authorize arbitrary filesystem/tool access.
External side effects still require their own receipts and uncertain-outcome recovery.

## Explicit Agent and Runtime configuration slice (2026-10-16)

`resources.agents` never discovers legacy, project, Claude, OpenClaw/Hermes or plugin roles. A read of a
new partition returns an empty catalog. Only `initializeMain()` explicitly creates its stable `ag_UUID`
main Hara, with the packaged Hara brand and available Pi default. New colleagues have their own stable
IDs, immutable usernames and available Pi default; names/persona are presentation, not identity or
permission. Existing main/legacy Agents are not rebound. Codex/Claude/OpenCode general-Agent drivers
remain unavailable and cannot be selected merely because their CLI or coding worker is installed.

One bounded owner-only manifest is authoritative for identities, persona and one effective Runtime
configuration. The separate immutable owner marker reserves exactly one main identity, not a second
mutable default. Main cannot be archived/replaced or impersonated by create input. Missing either
half, bad/future format, wrong scope/generation, altered hashes, duplicate IDs/usernames or unexpected
fields deny reads/writes rather than repair or import. A failed first publication can retain its owner
reservation for explicit repair; it never silently creates another main. No repair/migration UI exists
in this slice.

Create uses catalog revision CAS; per-Agent edits use exact Agent ID, configuration revision and
lifecycle epoch under the shared interprocess lock. Configuration edits append immutable private
snapshots and advance the effective pointer in one commit. Old tasks keep their exact persona, Runtime,
hash and revision across restart rather than resolving today's config. The manifest caps 256 retained
Agents, 64 configurations per Agent and 2 MiB; a full catalog refuses edits instead of pruning old
snapshots or reusing an archived username/ID. Instructions are capped at 32,000 characters and stay
host-private. List/get projections include only allowlisted public identity/status/Runtime metadata,
not private instructions, past configs, hashes, paths, imported role policy or model credentials.

Archive and explicit restore each advance a separate lifecycle epoch. Archive denies private execution
snapshot resolution; restoring the same identity does not revive a prior task epoch. Neither operation
deletes historical sessions, receipts or configs. Structural history validation is independent from live
admission so authorized retained conversation history remains readable after archival. These are local
catalog fences, not a cloud revocation service or cancellation of a running external action.

`bindTask()` freezes a separate `workspaceAgentBinding` containing schema, full resource binding,
Workspace/Agent ID, lifecycle epoch, config revision/hash, Runtime and task ID. It grants no membership,
Host/placement, native session, tool, Skill or model connection authority. Scoped Session persistence
checks exact task/Agent/resource attribution on both read and write; provenance contains no private
persona body. Existing transcript IDs cannot lose, adopt or change their Agent affiliation. Scoped
publications serialize that check in a separately pinned private lock directory before index, staging or
journal writes; its keys cannot collide with normal Session locks. Legacy fresh-task admission,
configured/direct Hara/Pi runners, driver registry and fork
all explicitly refuse this new provenance, including malformed/future/dual legacy+scoped data, before
model/tools. A new scoped fork still requires future explicit admission; it cannot drop provenance and
fall through to Hara. This slice does **not** enable Workspace Agent execution.
Legacy SessionHub also refuses Agent-bound resume and every scoped-resource fork, even with no task;
authorized history remains available through the bound store's read/list operations.

The synchronous private-state writer now accepts a host-owned void authority fence before staging
content, namespace claims and publication. Denial after claiming a catalog restores its verified old
inode without publishing new bytes. Context and owner marker remain checked at commit. The whole
Workspace resource tree is protected from generic model file tools even outside the ambient home,
including an inner `.hara` that would otherwise hide its outer private partition.
Authorized memory writes reuse the existing object-identity private-state binder for their exact
inspected immediate parent. Memory recall gets a separate bounded inventory permit for only one
global/project memory bucket, original context and pinned directories. Generic walkers retain their
protected-file policy; copied options, another root/context, cancelled work and wider private directories
cannot use this permit. No ambient-context-wide bypass is introduced.

## Compatibility and activation gates

No user data, registry, main Agent binding, native session, gateway or Dev process is moved, deleted,
stopped or upgraded. Legacy storage remains the startup default. New APIs are not advertised to users.
Before activation, implement and independently verify:

1. Trusted local/Account enrollment and fresh membership for resource operations; explicit connection
   mapping and immutable RunBindingV2 without a second default authority.
2. Wire the explicit Agent/persona/Runtime catalog into authenticated admission, then isolate Host
   grants, per-Agent private memory, tools, skills, attachments/files, other indexes, connectors,
   queues, approvals, budgets, results and audit. These are not covered by the current storage adapters.
3. Frozen scope through actual CLI/Serve/gateway/cron/provider/tool/vision/judge/native-runtime paths,
   cancellation/drain and restart. Do not inject only the SessionStore while leaving other dependencies
   on the legacy home.
4. Desktop/Web switching and revocation/late-response fences, Desk result/acceptance closure, and
   explicit legacy migration with private backup, restore and rollout authorization.

Account/Collab v1 membership/mention APIs remain human-only. Agent projection and delegated sending
need a separate versioned contract. AccountDevice is not a HostGrant; a Control organization is not an
inferred Workspace mapping. No automatic @ dispatch or remote Host fallback is enabled.

## Verification

`test/workspace-resources.test.mjs` uses actual stores, real SessionHubs and child-process locks with
synthetic data only. It covers namespace/ID/key equality, concurrent writes, unchanged legacy bytes,
foreign transcript copies, restart/paging/journals, generation and directory/file alias failures,
an actual suspended-search root swap, and a suspended write denied before commit. The atomic writer
also tests denial after claim restoring the original inode and rejection of an asynchronous fence.
Whole-CLI and fixed-source receipts are recorded in the workspace inbox. No paid model, real account,
native external-engine control, signed Desktop package or production acceptance is claimed.

`test/workspace-agents.test.mjs` additionally exercises real catalog/Session stores, actual SessionHub,
two host processes racing the same Agent revision, retained config/lifecycle recovery, private public
projections, corrupt/foreign/partial state, full snapshot capacity, zero-call legacy refusals and late
generation/owner changes around staging/claim. Writer tests independently verify denied-claim restoration
and reject Promise authority callbacks. An initial nested-tree protection red receipt and exact final
fixed-source results are retained separately from fixture and restricted-loopback failures in the inbox.
