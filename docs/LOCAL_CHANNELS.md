# Local Workspace channels

`workspace.local-channels.v1` is an additive capability on the authenticated local Workspace transport. A local channel belongs to one active Workspace and needs no Account or hosted collaboration service. It contains the local user and any selected active colleagues. Channel membership has no person-count quota; the existing private-state byte bounds still fail before a write can overflow storage. Joining a channel never grants a colleague the main Hara's tools.

The host advertises the capability in `initialize`. Channel RPCs require the exact `workspaceId` and `expectedGeneration`; unknown fields are rejected. A controller must first select the Workspace, then the channel, before sending or editing it.

| Method | Additional parameters | Result |
| --- | --- | --- |
| `workspace.channels.list` | — | catalog revision and local channels |
| `workspace.channels.create` | `channelId` (UUID), `name`, `memberIds`, `expectedRevision` | catalog; repeated identical UUID is idempotent |
| `workspace.channels.update` | same fields as create | catalog; room lease excludes an active reply queue |
| `workspace.channels.select` | `channelId` | channel snapshot and controller-scoped approval cards |
| `workspace.channels.snapshot` | `channelId` | read-only snapshot |
| `workspace.channels.send` | `channelId`, `message`, `requestId` (UUID), `recipientIds` | durable acceptance, before the queue finishes |
| `workspace.channels.receipt` | `channelId`, `requestId` | `accepted` or `unknown`; never calls a Provider |
| `workspace.channels.cancel` | `channelId` | stop current reply and skip queued recipients |

The user chooses the recipients for each message. An empty array stores a personal note without needing a model connection. Otherwise Core calls those colleagues once each, in the supplied order; a later colleague sees the shared channel transcript including earlier replies. There is no autonomous loop among participants. Each reply keeps its existing governed Pi execution, resource binding, budget, task receipts and interruption checks.

`local-channels.json` stores names and member IDs. Each `local-channel-<UUID>.json` stores user turns, frozen recipients and per-recipient request receipts. An Agent's per-channel conversation/session and request journal use a deterministic namespaced UUID; they cannot alias its private conversation or another channel. Shared history is a projection of those channel-only conversations. Removing a member preserves the original messages and sender labels. A bounded preview enters the model context; omitted context is available through the existing scoped receipt reader.

The queue saves all participant nonces before starting any model. Retrying an identical user request returns the original acceptance, including after a restart; a changed body/recipient list with the same nonce is rejected. Cold reads recover accepted participant replies even if the room process crashed before recording their run IDs. Interrupted and queued work is displayed as interrupted and is never automatically replayed. A new, explicit user turn seals the old transcript bounds before proceeding. Transport-unknown sends must be checked through the original receipt, not purchased again.

All documents use the existing Workspace resource filesystem, private modes, revision checks and generation fences. Channel edits and execution share a room lease. The renderer never selects paths, credentials, runtime contracts, budgets or approval authority. Local channels do not call `workspace.collaboration.*`, enroll people, synchronize messages or create cloud invitations. That future integration remains a separate decision.

This branch is an unpublished extension based on Core 1.0.2. It does not change the released 1.0.2 tag or authorize a release. Desktop must record the exact extension commit; the normal formal release checks still reject a mismatched released tag.
