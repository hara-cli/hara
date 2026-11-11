# Agent Hub passive inbox foundation

This slice provides a Host-owned passive inbox, a separate authenticated loopback listener, and the G0 adapter ports. It does not enable Agent Hub in the production Workspace Host, expose a model/MCP tool, implement `hara send`, send to an external agent, or run a colleague. Those entry points remain separate slices. No dependency or native cache was added.

## Shared C0 and G0 boundaries

`src/agent-hub/contracts.ts` deliberately defines no competing actor kind, human principal, command receipt, or execution status. `AgentHubBoundaryContract<ExternalSource, SavedReceipt>` requires C0-owned factories and validators. The directory is a synchronous exact lookup of already-registered local metadata. It must not discover native sessions, read their messages, or capture tmux panes. G0 egress is a type-only port for a later adapter, not a claim that current `ag send` supplies privacy-preserving discovery or precise receipts.

An external message is never a human command. C0 command acceptance, execution, drain and task completion must not be inferred from a mailbox save or transport ACK. The production-shaped adapter in `src/agent-hub/c0-adapter.ts` imports the canonical C0 v1 types, parser, factories and error/retry table. It creates only `external-agent-source` with a null human principal and `hub-ingress-receipt`/`saved`; transport types are shared but real egress remains a later slice. Synthetic port fixtures remain for storage fault injection, with additional real-C0 storage/HTTP regression coverage. No C0 source is copied or redefined.

## Host ownership and credentials

Construct `AgentHubStore` with the explicit private home and the C0 `scopeKey`/`generation` obtained by the trusted Host. Neither comes from the network request. The required `assertCurrent` callback belongs to the live C1 Host authority; it runs on each operation and before admission/commit. Parsing a C0 context or accepting a client capability is not an authority check. Each scope has its own private namespace. A new generation invalidates old grants while preserving old messages for display. The registered instance and alias are checked before reading the body and again during commit. Unknown/stale registration fails closed. Historical records are validated with the canonical C0 parser in their exact scope, so a new generation can still display history. New admissions use the current C0 factories, current Host authority and current-generation grants; historical parsing does not revive old credentials or approvals.

Only the trusted Host API can issue, rotate or revoke grants. A grant contains 256 random bits. The catalog keeps only its SHA256, not the raw token. `writeAgentHubCredential` provides an exclusive 0600 handoff below a prevalidated 0700 directory chosen by the trusted native flow. It rejects preseeded files/links and remote endpoints. The returned raw grant is only for that native connection/handoff flow; it must never enter a conversation, general Workspace discovery receipt, URL, log or command argument. No network mint/rotate/revoke endpoint exists. Token possession is a local capability, not proof of a human action or protection from an unrestricted malicious process running as the same OS user.

The default and maximum per-inbox ceiling is 128 MiB. The required `HaraStorageQuota` is a separate home-wide persisted policy and mutex: every Hub scope shares it. Its total byte limit is explicitly provided by the trusted Host, rather than guessed from an Agent request. It counts the default private `.hara` tree and the Host's additional prevalidated Hara-owned storage roots using metadata only. The registered root set and limit are persisted; a second scope/process cannot omit a root or increase the limit. Unknown aliases/census failures refuse new data rather than reporting zero. Unrelated project/sender files are not storage roots.

All Hub writers serialize under this global mutex and check global growth before staging and publication, in addition to their scope ceiling. Other Hara domains are included in usage; their future writers must also use this common controller for coordinated admission. This change does not rewrite unrelated legacy writers or claim an OS filesystem hard quota. Fixed-schema revocation, cleanup recovery and at most eight durable read leases retain bounded control writes (at most 64 KiB per small control write; a CAS-bound restrictive catalog replacement is additionally allowed up to 4 MiB only when its permanent byte size does not grow) at a full data budget. These control bytes, staging copies and orphaned files still count against subsequent new-data admissions; they are not unmetered payload capacity. No receive path silently deletes content.

## Narrow transport

`startAgentHubIngress` opens an ephemeral port on `127.0.0.1` only. It accepts an exact loopback Host, JSON POST, and `Authorization: Bearer <per-agent token>`. Browser Origin/Fetch-Metadata requests are refused. There is no CORS, general WebSocket initialization, file-path, session read/resume, task or schedule route. Header/body/concurrent-upload/connection/time limits are finite. The Host supplies the C0 error projection, which receives a fixed classification rather than arbitrary exception text.

The only paths are:

- `POST /v1/agent-hub/messages`: exact body `{ requestId, from, text, attachments }`.
- `POST /v1/agent-hub/receipts`: exact body `{ requestId }`; only the authenticated connection's receipt is returned, or null.

`from` must match the authenticated registration; it cannot select the true source. Any actor/human/approval/Workspace/permission fields are rejected. Incoming approval-looking text remains text. The saved receipt is persisted before returning. No callback for starting models, tools, tasks or schedules is accepted.

## Persistence and retry

Private directories/files use the existing Hara 0700/0600, no-follow, inode, hardlink, atomic-write and cross-process lock primitives. Binary publication now accepts the same synchronous authority fence, checked again after staging and before publishing. Catalogs and stored messages are parsed and bounded; damaged, missing-but-nonempty, aliased or foreign state fails closed instead of becoming an empty mailbox.

The stable request key is `(connectionId, requestId)`, including across token rotation. Equal retries return the original C0 receipt; changed content conflicts. Reinstating a different registered instance requires a new connection. A crash after immutable message publication and before catalog commit leaves one deterministic, quota-accounted orphan; retry verifies and reuses it. It is not silently replayed as a task. Unread is based on committed sequence numbers; marking read cannot consume future arrivals or move backward.

The quota counts raw payload files, catalog/message/control metadata, orphan/staging files and replacement peak space. Base64 exists only in the bounded ingress envelope; it is not retained in message metadata or payload files. Full storage rejects new content without eviction. Revocation remains available even when the configured content quota is full; disk/permission failure is still reported rather than claimed as a successful revoke.

## Attachments and preview quarantine

Text is at most 32 KiB UTF-8. A message has at most four files, each at most 8 MiB, totaling at most 16 MiB of decoded bytes. Exact canonical base64, safe display names, extension/type agreement and bounded image dimensions/container framing are checked. PNG/JPEG/WebP are limited to 20 MP and 8192 per dimension; animated PNG/WebP and other image formats are refused. MD/TXT are strict text; PDF is download-only. Executables, HTML, archives, video and unspecified types are refused.

Images are stored with `preview: "quarantined"`. Container/header checks are **not** a complete bitstream decoder. A future Desktop/media adapter must perform bounded trusted decoding and matching dimension/frame verification before any inline preview; this slice neither decodes via an external binary nor advertises preview capability. Malformed images can therefore remain quarantined rather than becoming executable/rendered content.

Content is copied into separate private immutable text and attachment files, never read again through the sender's original path. Storage schema 2 keeps each message's source, text preview/hash and attachment metadata in a file capped at 64 KiB. Listing only opens metadata, never a body/blob. A serialized page is capped at 256 KiB and 50 items; callers continue after the last returned sequence. Full text is fetched separately with its 32 KiB limit/hash check. A selected attachment streams in chunks no larger than 64 KiB and verifies its complete hash; consumers must await verified completion before saving/rendering it. Durable reader records prevent cleanup of active or unknown readers, including across Host objects/processes. Normal completion/abort releases the exact record. A crashed reader's record is retained until the trusted lifecycle authority proves it can be retired; no age-based or unknown-reader eviction is implemented.

Pre-enable schema-1 inline records are rejected and retained, never implicitly reset or destructively migrated. An actual existing installation needs a separately verified migration before use. Raw token holders cannot enumerate inbox messages, fetch payloads or invoke cleanup; these remain trusted Host APIs, without a network route or runtime directory grant.

## Confirmed quota cleanup

`planAttachmentCleanup` produces a five-minute preview of the oldest eligible private attachment copies, with bounded candidates and exact metadata/inode snapshots. It includes unpublished attachment orphans, but preserves text bodies, message/source metadata, receipts and recovery records. The Host must explicitly confirm that each target has no forward/material/pinned/recovery references; unknown protection state is not eligible. Durable read leases are always protected.

`cleanupAttachments` requires a native human action bound to the plan digest, current scope/generation and current authority; `approved: true` or an Agent message is not a proof. The preview is revalidated before the first mutation, references are rechecked at publication/deletion, and a changed catalog or inode refuses the operation. Published attachments become `expired` tombstones before their exact private copy is removed. The sender's original file is never touched. Unpublished metadata/text remains recoverable; a later identical receive can restore the missing copy before its first ACK.

A private cleanup journal permits explicit recovery after interruption. Completed retries return the original receipt and cannot delete a newly restored orphan upload. Partial recovery requires current native confirmation again; no cleanup is resumed automatically. Receipts report validated payload bytes actually removed, separately from already-missing targets, rather than claiming exclusive physical disk space. Stored control/journal bytes remain part of global usage. Production UI must display the preview and obtain this native action before applying a plan.

## Verification and enablement gate

Focused tests exercise wrong source/extra authority fields, registration reuse, revocation during streaming, cross-scope/generation rejection, ACK loss/restart/token rotation, interrupted commit recovery, unread, quota/no eviction, links/corruption, attachment quarantine and the actual loopback listener. Tests use isolated synthetic state and zero model/provider calls.

Before enabling the feature, review the C0 v1 adapter together with its shared contract dependency; connect real registered-only G0 metadata; connect trusted native token handoff, the complete shared storage-root registry and native cleanup/reference/lifecycle authority; then wire CLI/Host/UI as separate reviewed slices. Transport submission does not prove an external agent read or executed anything. Human sends/forwards and future approval cards retain their independent authority checks.
