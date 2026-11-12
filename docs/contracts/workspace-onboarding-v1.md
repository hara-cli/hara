# Workspace onboarding Core contract v1 (G1/G2/G4)

This is a Core interface slice. Desktop owns the guide and HireAgentDialog. This slice does not launch a model, install/probe an engine, load global plugins/MCP/hooks, or implement C5 duty/answer/draft fields. A saved engine choice is a preference, never proof that a model works.

## G1: new-colleague default

Initialization advertises `workspace.preferences.default-runtime.v1`. `workspace.preferences.get` adds `defaultRuntimeId: AgentRuntimeId | null` to the existing Host UI preferences. Old v2 documents project a missing value as null without rewriting on read. `workspace.preferences.set` accepts `{defaultRuntimeId, expectedRevision}` or the existing theme/display/update fields; its shared revision is required. Null restores the previous Pi-first behavior. Default-only changes preserve appearance and unrelated preferences.

The proposal tool and omitted batch runtime choices use the saved engine only if currently available for new colleagues, otherwise available Pi, otherwise the first available colleague engine. The model cannot select this value through `agent_create` arguments, and the existing human confirmation card remains required. An explicit batch runtime is honored exactly or fails; it never silently falls back. Existing Agent bindings/configurations and in-flight tasks are unchanged. Desktop must consume the preference in its own hire dialog.

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

Success markers `(runId,draftKey)` and their Agents are published by one Agent-catalog CAS, with at most one revision increment. A failed publication cannot commit only the marker or only the Agent. A lost ACK/restart returns `exists` for previously committed keys, even with an old expected revision. Successful keys always refer to the original Agent: altered retry text does not rename it, change its instructions/runtime, or restore it from archive. Archived Agent records retain their markers. New slots with a stale revision fail `catalog_changed` without mutation. Use the returned revision to explicitly retry corrected failed rows; never invent a new run/key to work around an unknown result. Invalid envelopes, unavailable storage or corrupt catalogs reject the whole operation rather than claim per-row success.

No task, Provider, native runtime or colleague home is activated by creation. Existing runtime confirmation/platform permission-tier fences remain required. Profile/instruction text does not grant capabilities.

## G4: Workspace-scoped progress

Capability: `workspace.onboarding.v1`.

- `workspace.onboarding.get {workspaceId, expectedGeneration}`.
- `workspace.onboarding.set {workspaceId, expectedGeneration, expectedRevision, runId, step, engineChoice, thirdPartySkipped, dismissed, completedAt}`.

The six progress fields are `runId: UUID`, `step: 1|2|3`, `engineChoice: AgentRuntimeId|null`, `thirdPartySkipped: boolean`, `dismissed: boolean`, `completedAt: ISO timestamp|null`. Completion requires step 3. Replies also carry `schemaVersion:1`, `revision`, `readOnly`, and `recovered`. Do not write when readOnly; unknown/future/corrupt versions are preserved through the existing settings recovery rules.

Progress is stored under the bound Workspace resource storage. A missing record is initialized persistently as dismissed. This covers every existing pre-upgrade Workspace, including one containing only Hara, without counting colleagues or reading unrelated user history. A normal new Workspace explicitly initializes an undismissed step-one run after creating its main Agent. Legacy auto-inheritance initializes dismissed. If creation crashes before this marker commits, reopening conservatively stays dismissed. Reads and commits retain the resource generation/authority fences.

A rerun supplies a fresh UUID, current revision, step 1, null completion and no third-party skip. Same-run completion cannot be undone; stale clients cannot replace a new run. Saving progress never creates Agents, changes runtime preferences, or proves approval/execution. Set shares the current-main-view and close/update checks. Protected C3 RPC entries remain denied until a separately reviewed adapter exists. `answers`, `draft`, `duty` and extra authority fields are rejected in this version.
