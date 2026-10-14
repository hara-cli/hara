# Workspace-first compatibility increment

2026-10-14. Source candidate only; not published, deployed or enabled in a real installation.

Jeff selected UIUX's `workspace` / Hara Daylight direction. This increment fixes the existing
Space-switch route loss before the new Workspace registry becomes authoritative. It deliberately
does not rename old audiences or pretend every BYOK profile is already a separate Workspace.

## Runtime change

`profiles.json.spaceProfileSelections` holds only legacy audience → profile-id pointers. Existing
credentials remain in the same private stores. Selection and these pointers share the existing
profiles mutex and atomic/CAS write, avoiding two competing runtime selectors or a partial two-file
switch. Reading an old registry does not write a new preference; the first explicit activation records
both the departing and arriving connection. Temporary flag/env/project pins do not overwrite it.

`profileSpaceSnapshot()` returns the catalog and preference pointers from one verified inode.
`spaces.list` uses that snapshot to display the preferred inactive route. `spaces.use` no longer
hard-codes reserved Personal: `useSpaceProfile()` rechecks the exact displayed audience/profile pair
under the profiles lock. Removed, re-enrolled or concurrently superseded targets return an error;
they do not turn that stale click into another connection. Existing pin/flag/env and expired managed
access guards remain in the composition root. A switch alone calls no model and sends no message.

Explicit profile creation/activation, deletion, replacement and historical-route cleanup maintain the
compatibility pointers. Deletion retains the pre-existing legacy removal/fallback contract; this is
not the new Workspace registry's revocation/default-selection policy. Corrupt or cross-audience
pointer maps fail closed without overwriting original bytes. No historical Session is rebound.

## Verification

- `test/profile-space-selection.test.mjs`: legacy Token Plan return, managed accounts in one audience,
  restart, temporary overrides, create without activation, concurrent stale choice, re-enrollment,
  removal, replacement and invalid state. All use synthetic data in temporary HOME directories.
- `test/provider-connections-cli.test.mjs`: actual Serve RPC switches into a fake managed Space and
  back to the named private connection, without model traffic or credential disclosure.
- Existing profile, Serve Space, approval/interruption and frozen Workspace registry suites remain
  required. Exact full-suite receipts and commits live in the workspace-level implementation inbox.

The initial full run used umask 077 and exposed an existing fixture's hard-coded 0755 directory
assumption. Its original failure is retained; the final run uses normal test umask 022. No production
permission code or fixture assertion was weakened to make it pass.

## Next migration boundary

`src/workspace/` is still opt-in. The compatibility map is **not** a membership service, capability
grant, credential generation or second Workspace registry. When the authenticated migration becomes
active, translate validated preferences to exact opaque connection defaults, then retire this map as
authority rather than updating two defaults in parallel. Preserve all legacy audience bindings and
refuse ambiguous ownership; do not derive it from directory names or recent activity.

Session/history, Agent memory/search, attachments, connector cursors, queues, approval consumption,
budgets and audit still need stable Workspace/audience partitions. New isolated local Workspaces,
unified direct/managed connection management, Collab/Desk membership and persistent Runtime bindings
must not be enabled until those real storage and authorization paths are verified. No `workspace.v2`
capability is advertised by this increment.

## Agent Runtime binding foundation (2026-10-14)

The Serve entry now reads owner-only `agent-runtime-bindings.json`, separate from imported Agent
Markdown, model connections and tool grants. Records use an exact legacy Space + qualified Agent ref,
an engine id and a monotonic revision. The store is bounded, locked and CAS-written; malformed/future
state is refused rather than repaired. The binding file is a protected Hara control-plane path.
The directory batches its reads rather than parsing the same file once per Agent.

`agents.list` returns credential-free binding/availability metadata. `agents.set-runtime` authenticates
the existing Personal Agent, checks profile and binding revisions, and admits only a host-registered
general-Agent driver. It accepts no tool permissions, commands, keys or audience override. Personal
configuration cannot define an organization Runtime policy. An edit neither stops old work nor resets
identity, history, memory or native sessions.

Each new Serve task freezes its Runtime and configuration revision before provider/tool side effects.
Steering and recovery keep that task's original binding; legacy unfinished tasks keep Hara. A fork gets
a new task binding from the host without inheriting a native-session handle. Persistence checks the
task id, Agent and Space and refuses an invalid binding before replacing an existing transcript.
Runtime dispatch is through the exact registered driver with the existing Hara RunOpts/tool authority;
there is no automatic engine fallback.

Production currently registers ONLY the Hara compatibility driver. Pi remains the product default
direction, not an implemented general-Agent default. Pi/OpenCode/Codex/Claude coding workers remain
separate existing capabilities; no CLI-presence check upgrades one into a general-Agent driver. Tests
inject clearly identified trusted fixture drivers, not a claimed Pi SDK integration. No model call,
dependency upgrade, installation, native migration, or commercial Raft code import is part of this slice.

The matching Desktop candidate adds a folded Runtime setting in Agent profile editing, separate from
model/reasoning controls and saved separately from the persona draft. It follows actual engine
availability, blocks stale/duplicate saves and tolerates old engines. Agent creation, the real Pi
general-Agent adapter, remaining CLI/gateway/cron surfaces and new Workspace authority are unfinished.
Do not enable those capabilities or change the default to Pi on the strength of these fixture tests.

Verification: both full CLI runs passed 2688 tests with one existing Windows-only skip; a 61-test
session/Space/runtime follow-up passed. The final full run includes the additional fork-lock and
protected configuration changes; no failure or cancellation was reported.
The Desktop candidate passed all 558 tests and production build with 36 asset checks. These are local
source/automated results, not a release, installed-app test, native pixel QA or full Workspace isolation.
