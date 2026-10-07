# Local Agent capabilities

## Decision

Hara should keep local execution useful without Hara Collab, an organization account, or a
public community. Collaboration may later deliver a task to an Agent, but the local Agent remains
the execution authority for a person's files, calendar, browser, and desktop applications.

Build the platform and the local Agent as two layers:

```text
conversation / scheduled task / collaboration assignment
                         |
                         v
             Agent action + approval policy
                         |
                         v
          local capability broker in Hara Desktop
             |            |             |
          calendar      browser      computer use
             |            |             |
       native/cloud API   CDP/DOM    AX/UIA, then vision
```

The broker is a narrow native boundary. It reports capabilities, asks for operating-system
permissions, executes typed operations, and returns a receipt. The model never receives a generic
privileged native handle.

## Product invariants

1. Installing or updating Hara Desktop must not silently grant a local capability.
2. Reading private personal data and changing external state are separate grants.
3. A write approval binds to normalized inputs, target account/resource, and an expiry.
4. API or semantic accessibility automation is preferred to pixel automation.
5. Every external write has an idempotency key and a durable, redacted execution receipt.
6. Collaboration can request an action but cannot expand the local user's authority.
7. Hara CLI continues to work when Desktop, Collab, and every optional connector are absent.

## Creating a personal Bot through chat

In a Personal Space conversation backed by `hara serve`, the main Hara Agent can offer
`agent_create`. A request such as “Create a research colleague named Ada” follows this flow:

1. Check existing contacts with `agent_contact(action: list)` and agree on the job and boundaries.
2. Present a single-use creation card with the nickname, stable username, role, description, and
   complete standing instructions. Desktop renders the same review in English or Chinese.
3. Save only after a live human confirmation. Full-auto and headless auto-yes do not waive that decision.
4. Persist the private native role and refresh the contact list. The receipt distinguishes a new save
   (`created: true`) from an existing colleague (`created: false`); existing instructions are not overwritten.

Pending proposals survive a UI disconnect through the authenticated foreground `events.snapshot`
approvals. They do not survive a server shutdown as an already-authorized creation. Ambient task telemetry
contains only the pending action summary, not the proposed standing instructions. Duplicate approval replies
cannot create another Bot. A dismissed username must be explicitly restored or a different username chosen.

Creation accepts no credentials, model/endpoint overrides, or execution grants. The new colleague follows
the Space model and ordinary tool permissions; it does not receive the main Agent's hiring authority.
Organization-managed Agent enrollment remains a separate, policy-governed workflow.

A permanent contact is not a temporary coding worker. Hara understands, dispatches, and reviews the task;
eligible coding engines execute it behind their existing permission checks. Codex and Claude Code's durable
workers retain their native-session continuation links. OpenCode's existing headless execution adapter is
not equivalent to a durable, resumable worker, and this creation feature does not claim to add that capability.

## Capability contract

Desktop and CLI should negotiate capabilities instead of assuming platform parity:

```ts
type CapabilityState =
  | "unavailable"
  | "not_configured"
  | "permission_required"
  | "ready"
  | "degraded"
  | "error";

interface LocalCapability {
  id: string;
  version: number;
  state: CapabilityState;
  operations: string[];
  provider?: string;
  limitations: string[];
  permissions: Array<{
    id: string;
    access: "read" | "write" | "control";
    state: "unknown" | "denied" | "granted" | "limited";
  }>;
}
```

The local broker should expose:

- `capabilities.list`
- `capabilities.request_permission`
- `actions.preview`
- `actions.execute`
- `actions.cancel`
- `actions.receipt`

`actions.execute` accepts the preview's action hash. It must reject changed arguments, an expired
approval, or a provider/account different from the preview.

## Calendar

### Shared tool vocabulary

Calendar is a typed connector, not a screen-control recipe:

- `calendar.accounts.list`
- `calendar.calendars.list`
- `calendar.events.list`
- `calendar.freebusy`
- `calendar.events.create`
- `calendar.events.update`
- `calendar.events.delete`

Reminders/tasks use a separate namespace because their lifecycle and fields differ from events.
Inviting attendees is a higher-risk external write than creating a private time block and must be
identified separately in the preview.

Hara should initially query the provider live. Do not copy a person's complete calendar into the
Hara database. Store only connector metadata, an encrypted token reference, optional incremental
sync cursor, and redacted action receipts. Add a bounded local cache only when offline or
notification requirements justify it.

### macOS

Use a signed native helper owned by Hara Desktop and EventKit:

- EventKit is the source for local/iCloud calendar events and reminders.
- Creating an event can use write-only access; reading events requires full calendar access.
- A sandboxed app needs the calendar entitlement and usage description.
- EventKit change notifications invalidate a short-lived cache; they are not a reason to mirror
  the complete event store.

AppleScript/Calendar UI automation may be a diagnostic fallback, but it is not the production
calendar backend. It introduces a second Automation permission and loses EventKit's typed error and
identity semantics.

### Windows

Use Microsoft Graph for Outlook/Microsoft 365 calendars:

- delegated OAuth through MSAL;
- least privilege (`Calendars.Read` for reads and `Calendars.ReadWrite` only for writes);
- calendar-view delta tokens for incremental changes over a defined time window;
- credentials stay in the operating-system credential store or an approved encrypted vault.

Do not treat the Windows Calendar/Outlook GUI as a database API. Optional Outlook COM support can
be added later for a validated enterprise/offline requirement, behind its own provider identifier.
Google Calendar and CalDAV are additional connectors and work on either operating system; they do
not belong in the Windows native backend.

### Chat flow

```text
“把周三下午空出来和小王开会”
  -> resolve timezone, calendar, attendee, and ambiguous duration
  -> read free/busy (privacy grant)
  -> show an exact event preview
  -> user approves the normalized write
  -> execute once with an idempotency key
  -> return event id/link and a redacted receipt
```

The Agent must not guess the calendar account, timezone, attendee identity, or recurrence rule when
the choice materially changes the result.

## Computer use

### Native fallback hardening (unreleased source, CLI 0.183.2)

The LCU comparison informed lifecycle/approval patterns, not a bundled LCU/OpenAI runtime. Hara
keeps its configured model/provider and existing OS permission boundary. This implementation adds:

- Fixed per-mille grounding: one complete numeric `x/y` JSON object, both divided by 1000.
  Missing, ambiguous, non-finite, duplicate-key, or out-of-range coordinates are rejected.
- A live human channel for every computer action, including screenshots. `full-auto` and a headless
  `confirm => true` callback are not a substitute. No setting is silently enabled by an upgrade.
- An ephemeral, host-owned run scope. `activate` binds an exact app/PID/native window/frame;
  coordinate and keyboard input require the latest opaque `observationId`, valid for 30 seconds.
  The host rechecks screen bytes, window identity/geometry and current permissions immediately
  before dispatch. Changed state requires a fresh observation rather than an automatic retry.
- A private cross-process desktop lease at `~/.hara/computer-control/desktop.json`. It contains
  opaque run/session identity and worker lifecycle facts, not screen/message content. A live
  owner/worker is never displaced by a timeout. A crash with an unresolved spawn reservation
  deliberately blocks recovery until it is diagnosed; never delete a live lease to bypass control.
- Private temporary screenshots with normal/error/cancel cleanup. Up to four validated tool
  images (3.6 MB each) reach only the next model request, through native input or the authorized
  vision-first route. Pixels, base64 and ephemeral file paths do not enter durable tool history.
  Unknown/text-only routes explicitly report unread images. MCP `isError` remains an error.
  Media echoed in errors or successful text is scrubbed before local history, result continuation
  files, or UI output. This local cleanup does not change a provider's own retention/cache policies.
- `Dispatched` and `Observed` receipts, not a success checkmark based on subprocess exit code.
  Business completion needs separate evidence. A failed/uncertain paste has no automatic alternate
  input path; an uncertain post-action observation stops this run rather than resending.
  A failed/cancelled macOS paste attempts only a fixed `Cmd` key-up while still owning the lease;
  that cleanup is not another paste or evidence that the input succeeded.

The pixel fallback is still not an atomic semantic action. A person or non-Hara application can
change focus between the last host check and native input. Windows additionally checks HWND/PID/frame
inside its worker; X11 keyboard input names the bound window, which some applications may ignore.
macOS AX/CGWindow matching, Windows DPI behavior and real application effects require explicit
device acceptance. Synthetic tests do not establish that a real send/click succeeded.

Only the primary display is supported on macOS/Windows; macOS capture uses `screencapture -m`
and logical primary-screen coordinates. Linux target binding supports X11, not Wayland control.
Moving a window, switching screens, animated UI/caret changes, or a large capture can refuse
input under the conservative exact-snapshot rule. Semantic AX/UIA inspection/invoke, isolated browser
APIs, general MCP elicitation/turn-ended integration, a crash-recovery UI and real-device testing
remain follow-up work. This source change is not a release or an unattended-send authorization.

Validation on 2026-10-05: `npm test` (Node 22.23.1, isolated test homes) passed all 1,912 tests,
with no failures or skips. Native transactions use executable fixtures instead of OS GUI programs;
provider/media tests use synthetic images and in-memory transports. This is source regression evidence,
not macOS/Windows application acceptance. No release, real desktop action or WeChat send was performed.

The current `computer` tool supplies a useful last-resort screenshot/coordinate path. Its next
backend should be semantic:

| Layer | macOS | Windows | Rule |
|---|---|---|---|
| Application API | connector, MCP, app URL/API | connector, Graph, app API | use first |
| Browser | CDP/DOM/accessibility tree | CDP/DOM/accessibility tree | use for Web UI |
| Desktop semantics | AXUIElement | Microsoft UI Automation | inspect and invoke by element |
| Screen capture | ScreenCaptureKit | Windows.Graphics.Capture | explicit visible permission |
| Pixel fallback | vision + bounded pointer/keyboard | vision + bounded pointer/keyboard | verify after every action |

Add semantic actions:

- `inspect`: bounded window/accessibility tree with stable element references;
- `focus`: activate an allowlisted app/window;
- `invoke`: perform a supported semantic action on an element;
- `set_value`: set a supported text/value field without clipboard leakage;
- `scroll`;
- existing `screenshot`, `click`, `type`, and `key` as fallbacks.

Element references are short-lived and scoped to process, window, and accessibility-tree
generation. A stale reference fails closed and triggers a new inspection. Password/secure fields
are never returned in tool output. Hara must not attempt to bypass Windows UAC/secure desktop,
macOS login dialogs, screen-lock surfaces, or operating-system consent prompts.

### Platform permission differences

macOS needs separately visible states for:

- Accessibility (AX inspection and control);
- Screen Recording (capture);
- Automation/Apple Events only for a specific fallback integration;
- Calendar and Reminders;
- Files and folders selected by the user.

Windows needs separately visible states for:

- UI Automation availability and target integrity boundary;
- the user-selected Windows Graphics Capture target;
- Microsoft account/tenant connector authorization;
- filesystem scopes;
- elevated/UAC boundary (reported as unavailable, never worked around).

Desktop Settings should show `Ready`, `Permission required`, `Limited`, or `Unavailable` for each
ability, along with a focused repair action. A single “computer access on/off” switch hides too much
state.

## Risk and approval model

| Class | Examples | Default |
|---|---|---|
| private read | list calendar events, inspect a window tree | ask once per scoped session/provider |
| reversible write | create private calendar block, fill a draft | preview and one-time approval |
| external communication | invite attendees, send/post/submit | preview recipients and one-time approval |
| destructive | delete event, overwrite data, close unsaved work | explicit one-time approval; no full-auto |
| prohibited surface | password field, lock screen, UAC/secure desktop | deny |

Persistent grants name the exact operation family, provider/account, resource scope, and expiry.
They never mean “all computer actions.”

## Relationship to Hara Collab

Collab owns communities, channels, messages, task assignment, and public discovery. It does not
own a user's local operating-system permissions.

A collaboration task references:

- assignee principal (human or Agent);
- requested capability scopes;
- originating realm/channel/message;
- approval owner;
- execution location (`local_device` or a separately isolated remote sandbox);
- run, artifact, and receipt references.

Public task listings are a later marketplace projection, not ordinary chat messages. They require
moderation, eligibility, reputation, billing/settlement, dispute handling, and privacy controls.
Build them only after internal task assignment and the safe local Agent execution spine are proven.

## Delivery order

1. **Capability discovery and status UI** — Desktop/Serve negotiation, permissions, limitations.
2. **Calendar vertical slice** — list, free/busy, and create; EventKit on macOS, Graph connector on
   Windows; action preview, approval hash, idempotency, receipt.
3. **Semantic computer inspection** — AXUIElement and UI Automation read-only trees.
4. **Semantic actions** — invoke/set-value/scroll with app allowlists and verification.
5. **Collab M1** — internal text channel, transactional outbox, resumable sync.
6. **Agent task handoff** — assign a Collab task to the same local execution contract.
7. **Public communities**, then a separately governed public task marketplace.

## References used for this decision

- OpenMinis: `src/ios/NativeOffloads/CalendarOffload.m`,
  `src/ios/Agent/Offload/OffloadPermissionManager.swift`,
  `src/android/app/src/main/java/com/openminis/app/sandbox/offload/CalendarOffloadHandler.kt`.
- Hara: `src/tools/computer.ts`, `src/tools/registry.ts`,
  `docs/conversation-task-execution.md`.
- Apple: EventKit event-store access, AXUIElement, and ScreenCaptureKit documentation.
- Microsoft: Graph Calendar/delta query, Microsoft UI Automation, and
  Windows.Graphics.Capture documentation.
