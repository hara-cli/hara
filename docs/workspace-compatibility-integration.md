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

## Runtime acceptance and shared Pi SDK primitive (2026-10-14)

`src/agent-runtime/pi-session.ts` now owns the exact reviewed Pi 1.1.0 SDK initialization, shared with
the existing coding worker. The host supplies the persona, SessionManager, authorized custom tools
and frozen loopback model/tool bridge. The constructor refuses foreign endpoints, mismatched tools,
widened budgets, ambient account/model stores and cancelled work. Built-in tools, ambient resources,
provider discovery, automatic retries, compaction, telemetry and cache warming remain disabled.
Cancellation aborts the SDK; callers still own physical drain, bridge closure, durable state and task
governance. The `hara/coding` model alias and nominal SDK context/cost fields describe the existing
proxy transport, not the actual provider's limits, pricing or a new general-Agent capability.

This is a shared SDK primitive, **not** a registered Pi general-Agent driver or a tool grant. Tests
exercise the real SDK for one-call ordinary chat, explicit in-memory context reconstruction, waiting
for a host tool decision, cancellation and rejected authority changes. The reconstruction test is
not production main-Agent durable recovery. The coding worker retains its signed native state,
leases, ordered mailbox, continuation and live authorization rules.

The direct CLI/headless compatibility loop also refuses a task whose frozen Runtime is not Hara,
or whose binding/task/audience is invalid. Four regressions first reproduced one unwanted model call
for Pi/OpenCode/Codex/Claude-bound tasks; all now assert zero calls and unchanged history. A Serve
routing fixture returns its own synthetic Pi response instead of silently delegating back to Hara.

Repeatable credential-free diagnostics:

```sh
npm run check:agent-runtimes
```

Use the repository-approved Node runtime. The command builds first and runs isolated test homes with
scrubbed child environments, then writes private logs and `report.json` under a temporary directory.
Exit 1 means a test failed. Exit **2** means the scoped tests passed but the requested general-Agent
end-to-end gates remain unverified; it must not be presented as a release-ready success. The report
records source SHA/dirty state and explicitly distinguishes real SDK/Serve tests from vendor CLI
transport fixtures. No flag can green missing production drivers or native live-session acceptance.

Verified on local macOS arm64: all **118** diagnostic tests passed; the full CLI suite passed
**2697**, with **1** existing Windows-only skip and **0** failures/cancellations. A private Bun 1.3.9
`desktop-sidecar`-mode build also passed `standalone-pi-runtime-smoke.mjs`: authenticated compiled
Serve, actual Pi SDK read tool, same native worker session across two generations, exact usage and
clean shutdown. This smoke uses only a loopback synthetic model and an isolated temporary HOME.
It verifies the compiled Pi **coding worker**, not a main Pi driver, external vendor terminal,
embedded OpenCode artifact, Desktop installer or real-model cost/performance comparison.

Production still registers Hara only. General Codex/Claude/OpenCode/Pi drivers, main Hara Pi governance
and default binding, Agent creation Runtime selection, exact native-session linkage across entry
points, CLI/gateway/cron parity and packaged Desktop end-to-end acceptance remain open. Do not change
the default or replace a running installation on the strength of these tests. No release, deployment,
dependency upgrade or user-session migration was performed.
