# Workspace onboarding Core contract v1 (G1/G2/G4)

This is a Core interface slice. Desktop owns the guide and HireAgentDialog. This slice does not launch a model, install/probe an engine, load global plugins/MCP/hooks, or implement C5 duty/answer/draft fields. A saved engine choice is a preference, never proof that a model works.

## G1: new-colleague default

Initialization advertises the new `workspace.default-runtime.v1` capability; the old `workspace.preferences.default-runtime.v1` draft capability is not advertised. This lets Desktop hide this setting on old Host-global draft producers. The default is **per Workspace**, separate from Host appearance and onboarding progress:

- `workspace.defaultRuntime.get {workspaceId, expectedGeneration}`.
- `workspace.defaultRuntime.set {workspaceId, expectedGeneration, expectedRevision, defaultRuntimeId: AgentRuntimeId|null}`.
- Reply: `{schemaVersion:1, workspaceId, revision, defaultRuntimeId, readOnly, recovered}`. `expectedRevision` uses this Workspace's G1 revision, never the appearance, onboarding or Agent-catalog revision. Read before writing. Reject stale revisions, stale generations, extra fields and writes outside the selected main-Hara/settings view. C3-protected legacy entries remain denied.

OWNER/ADMIN may write; MEMBER is read-only. The role comes only from trusted Host composition, never request fields, discovery or renderer state. Missing/unknown/failed role policy results fail closed. A read-only missing record returns null/revision 0 without reading legacy migration input or creating the G1 document; callers must not initialize it by writing. Owner/admin initialization produces revision 1. Writes recheck the current view and role at each backup/primary publication. Stale revisions use the existing Settings changed RPC error; reread and prompt rather than automatically overwriting.

The existing Local catalog admits only registered local owners. Its default is therefore writable; the optional Host-only `defaultRuntimeRole(workspaceId)` restriction uses the canonical Account role type and can only narrow that existing local metadata right. It does not admit an Account scope, authenticate a human, grant execution, or wire real Account members into this local transport. A future Account adapter must supply its own verified authority and freshness. Synthetic member-policy WS tests are not real Account-member production acceptance.

The bound Workspace resource storage owns `workspace-default-runtime-v1.json`. A missing record is initialized once by CAS from the explicit old Host `ui-preferences-v1.json` default, if safely readable in a known schema. Missing/invalid old values seed null (Pi first); the legacy source is preserved byte-for-byte. A missing primary first arbitrates with the existing Host writer lock and may use its retained backup. A busy publication or unverified IO leaves migration pending without writing a scoped empty value. The migration reads only these bounded preference files, does not restore/migrate appearance, enumerate history or read another Agent's session. Existing scoped records, including an explicit null, never reread or follow the Host default. Workspace choices and revisions survive restart independently. Newer/corrupt scoped state follows the standard read-only recovery rules; links cannot redirect reads/writes.

`workspace.preferences.get/set` continue to manage Host appearance/update settings. Their public DTO no longer exposes the legacy default; global default writes are rejected. Appearance saves preserve any old migration input. This replaces the original Host-global G1 draft before merge; Desktop #78 must use the scoped calls and drop stale replies after switching Workspaces. The setting belongs inside the Workspace's read-only boundary. Onboarding step one uses the same G1 calls; saving onboarding progress alone never changes G1.

The proposal tool and omitted batch runtime choices read **their bound Workspace's** saved engine, use it only if currently available for new colleagues, otherwise available Pi, otherwise the first available colleague engine. Null restores Pi first. The model cannot select this value through `agent_create` arguments, and the existing human confirmation card remains required. An explicit batch runtime is honored exactly or fails, with no silent fallback. Existing Agent bindings/configurations and in-flight tasks are unchanged.

In 1.3.0 Desktop, hiring consumes this preference indirectly through Core's `agent_create` confirmation card. The legacy-only `HireAgentDialog` is not used by that entry and is outside this slice. Settings and onboarding consume the scoped G1 API; a saved choice never probes/starts a runtime or proves it works.

## G2: `workspace.agents.createBatch`

Capability: `workspace.agents.create-batch.v1`. The authenticated request is:

```ts
{
  workspaceId: string;
  expectedGeneration: string;
  expectedCatalogRevision: number; // snapshot.agentRevision, NOT workspace.list().revision
  runId: string;                  // UUID, reuse after lost ACK/retry
  rows: Array<{
    draftKey: string;             // 1..128 letters/digits/._:-, starts alphanumeric
    username: string;
    profile: AgentPublicIdentityInput;
    description?: string;
    instructions?: string;
    runtimeId?: AgentRuntimeId;   // omission alone uses G1
    permissionTier?: RuntimePermissionTier;
  }>;
}
```

There are 1..8 rows and no duplicate draft keys. Each run ID can retain at most eight successful keys in this Workspace. Rows may fail independently. The result preserves input order:

```ts
{
  runId: string;
  revision: number;              // current Agent catalog revision
  results: Array<
    | {index: number; draftKey: string; status: "created" | "exists"; agent: WorkspaceAgentView}
    | {index: number; draftKey: string; status: "failed"; reason:
        "invalid_request" | "runtime_unconfirmed" | "runtime_unavailable" |
        "permission_tier_unavailable" | "username_taken" | "catalog_changed" | "batch_limit"}
  >;
}
```

Index is zero-based. The caller's explicit, authenticated UI submission represents confirmation; request text such as `approved`, `actor`, `source` or a command document is not accepted as authority. The caller must be viewing the Workspace's main Hara, with a current generation and no close/update lease. C3-protected legacy entries still default-deny; this is not a new C1/C3 configuration adapter or execution grant.

Explicit-only batches do not read G1. If a new implicit-runtime slot needs an unreadable G1 record (including pending migration), the batch rejects before publishing any Agent or marker, including earlier explicit slots in that batch. It never silently creates Pi colleagues. Already committed keys still return `exists`, and stale/new slots retain `catalog_changed`; neither needs a G1 choice. Retry the same run/key after refreshing the preference. A readable preference with no available colleague engine yields the existing per-row `runtime_unavailable` reason, not `invalid_request`. The proposal-card path alone retains its human-visible fallback. The Host's preflight result is an internal argument, never an extra RPC/row field or an authorization fact.

Success markers `(runId,draftKey)` and their Agents are published by one Agent-catalog CAS, with at most one revision increment. A failed publication cannot commit only the marker or only the Agent. A lost ACK/restart returns `exists` for previously committed keys, even with an old expected revision. Successful keys always refer to the original Agent: altered retry text does not rename it, change its instructions/runtime, or restore it from archive. Archived Agent records retain their markers. New slots with a stale revision fail `catalog_changed` without mutation. Use the returned revision to explicitly retry corrected failed rows; never invent a new run/key to work around an unknown result. Invalid envelopes, unavailable storage or corrupt catalogs reject the whole operation rather than claim per-row success.

No task, Provider, native runtime or colleague home is activated by creation. Existing runtime confirmation/platform permission-tier fences remain required. Profile/instruction text does not grant capabilities.

## G4: Workspace-scoped progress

Capability: `workspace.onboarding.v1`.

- `workspace.onboarding.get {workspaceId, expectedGeneration}`.
- `workspace.onboarding.set {workspaceId, expectedGeneration, expectedRevision, runId, step, engineChoice, thirdPartySkipped, dismissed, completedAt}`.

The six progress fields are `runId: UUID`, `step: 1|2|3`, `engineChoice: AgentRuntimeId|null`, `thirdPartySkipped: boolean`, `dismissed: boolean`, `completedAt: ISO timestamp|null`. Completion requires step 3. Replies also carry `schemaVersion:1`, `revision`, `readOnly`, and `recovered`. Do not write when readOnly; unknown/future/corrupt versions are preserved through the existing settings recovery rules.

Progress is stored under the bound Workspace resource storage. A missing record is initialized persistently as dismissed. This covers every existing pre-upgrade Workspace, including one containing only Hara, without counting colleagues or reading unrelated user history. A normal new Workspace explicitly initializes an undismissed step-one run after creating its main Agent. Legacy auto-inheritance initializes dismissed. If creation crashes before this marker commits, reopening conservatively stays dismissed. Reads and commits retain the resource generation/authority fences.

A rerun supplies a fresh UUID, current revision, step 1, null completion and no third-party skip. Same-run completion cannot be undone; stale clients cannot replace a new run. Saving progress never creates Agents, changes runtime preferences, or proves approval/execution. Set shares the current-main-view and close/update checks. Protected C3 RPC entries remain denied until a separately reviewed adapter exists. `answers`, `draft`, `duty` and extra authority fields are rejected in this version.
