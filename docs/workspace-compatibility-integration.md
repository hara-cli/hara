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
