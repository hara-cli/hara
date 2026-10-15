# Hosted Workspace client — local preview

2026-10-15 candidate, not deployed or released. This client connects authenticated Desktop
to Account Workspace discovery/context and Collab channels. It is not a replacement for
local profile selection and grants no Agent, Host, model, file or computer execution.

## Ownership and configuration

- Core owns the existing private Hara Account sign-in state and access token. This slice
  reads it, never rotates/writes credentials or creates an account. Expired sign-in requires
  existing account authorization recovery; automatic refresh coordination remains later work.
- Account origin is the existing Core login origin. Renderer cannot supply an origin, token,
  Realm, role, principal or enrollment. Test-only dependency injection permits owned loopback
  services; production configuration requires HTTPS without URL credentials/path/query/hash.
- Account's directory and Workspace context routes and Collab's Workspace routes must
  separately be enabled/configured by the service operator.
- Core is default-off. The operator must set both:

    HARA_WORKSPACE_COLLAB_ENABLED=1
    HARA_WORKSPACE_COLLAB_ORIGIN=https://<operator-configured-collab-origin>

The angle-bracket value is not a deployed hostname. Invalid/partial configuration does not
advertise the feature or break pure-local startup. No DNS, production configuration, real
account enrollment or existing Dev restart is part of this candidate.

## Authenticated local protocol

Feature: workspace.collaboration.v1. All operations require normal local Serve initialization.
Methods:

- workspace.collaboration.list {cursor?}: Account directory, fixed page size 50, plus Core's
  opaque accountScope. No implicit first-space selection or public onboarding.
- workspace.collaboration.bootstrap {workspaceId,accountScope}: membership/channels/cursor.
- workspace.collaboration.sync {workspaceId,cursor,accountScope}: bounded events/messages and
  allowlisted channel-created metadata, never arbitrary event payloads.
- workspace.collaboration.send {workspaceId,channelId,body,idempotencyKey,accountScope}.
- workspace.collaboration.create-channel {workspaceId,slug,displayName,idempotencyKey,accountScope}.

Replies are {ok:true,value} or {ok:false,error:{code}}. Code-only failures do not reflect
upstream HTML, database details, credentials or message bodies. Receipts omit internal Realm
IDs and signing material. Account/access and short-lived Workspace tokens stay inside Core;
each collaboration operation obtains a fresh assertion from Account.

accountScope is a per-process HMAC boundary over the current private sign-in identity, not a
credential. A stale selection is rejected before network I/O after login/token/device changes.
Core rechecks the sign-in after each asynchronous response and before sending to Collab.
Changing this token does not select or grant a local profile or execution Runtime.

HTTP uses redirect:error, request timeouts and a streaming 6 MiB response cap (including
worst-case JSON escaping for a legal page). Directory pagination failures are DIRECTORY_STALE,
not permission revocation; they never discard pending sends. There is no
service fallback or automatic POST retry. Unknown/malformed send outcomes remain
OUTCOME_UNKNOWN; explicit retry must preserve the exact Workspace/channel/body/key/scope.
Idempotency authority remains the server's transactional receipt, not a renderer flag.

## Desktop preview boundaries

The feature-gated collaboration surface hides local chat/files/Agent state while open and
keeps original local tasks running. It does not call legacy spaces.use with a cloud ID.
Account/Workspace/request epochs fence delayed A→B→A results. Drafts and pending retries are
in memory only, keyed to their exact scope. Leaving with pending requests requires explicit
acknowledgment; restart/close is not a durable retry queue and cannot undo a server effect.

Only new events after the connection's bootstrap cursor are shown. Historic transcripts,
readable directory-wide names, full member profiles, private channels, DMs, attachments,
push delivery, Agent channel identity and Desk cards are not yet implemented. The existing
Realm sync API's history capability is not claimed as a finished Desktop history UX.
Workspace names currently fall back to the opaque ID when the server supplies no display metadata.
All channel members currently share the same Realm-wide authorized TEXT-channel audience.

Native screenshot acceptance, full Workspace key/memory/file/session partitioning, browser
account authentication and Host/Agent Runtime dispatch remain separate gates. This preview
must not be described as a deployed Human + AI Workspace or a finished Workspace migration.
