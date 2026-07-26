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

