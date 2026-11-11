# Agent Hub passive inbox foundation

This slice provides a Host-owned passive inbox, a separate authenticated loopback listener, and the G0 adapter ports. It does not enable Agent Hub in the production Workspace Host, expose a model/MCP tool, implement `hara send`, send to an external agent, or run a colleague. Those entry points remain separate slices. No dependency or native cache was added.

## Shared C0 and G0 boundaries

`src/agent-hub/contracts.ts` deliberately defines no competing actor kind, human principal, command receipt, or execution status. `AgentHubBoundaryContract<ExternalSource, SavedReceipt>` requires C0-owned factories and validators. The directory is a synchronous exact lookup of already-registered local metadata. It must not discover native sessions, read their messages, or capture tmux panes. G0 egress is a type-only port for a later adapter, not a claim that current `ag send` supplies privacy-preserving discovery or precise receipts.

An external message is never a human command. C0 command acceptance, execution, drain and task completion must not be inferred from a mailbox save or transport ACK. The C0 external-source/transport extension and a real C0 adapter are an explicit integration dependency; the storage-port tests use clearly synthetic, non-production shapes until that adapter is frozen.

## Host ownership and credentials

Construct `AgentHubStore` with the explicit private home and the C0 `scopeKey`/`generation` obtained by the trusted Host. Neither comes from the network request. The required `assertCurrent` callback belongs to the live C1 Host authority; it runs on each operation and before admission/commit. Parsing a C0 context or accepting a client capability is not an authority check. Each scope has its own private namespace. A new generation invalidates old grants while preserving old messages for display. The registered instance and alias are checked before reading the body and again during commit. Unknown/stale registration fails closed.

Only the trusted Host API can issue, rotate or revoke grants. A grant contains 256 random bits. The catalog keeps only its SHA256, not the raw token. `writeAgentHubCredential` provides an exclusive 0600 handoff below a prevalidated 0700 directory chosen by the trusted native flow. It rejects preseeded files/links and remote endpoints. The returned raw grant is only for that native connection/handoff flow; it must never enter a conversation, general Workspace discovery receipt, URL, log or command argument. No network mint/rotate/revoke endpoint exists. Token possession is a local capability, not proof of a human action or protection from an unrestricted malicious process running as the same OS user.

The caller allocates `quotaBytes` from the remaining Hara storage budget. Production enablement must connect that allocation to the shared storage authority. The default and maximum per-inbox ceiling is 128 MiB; an isolated per-scope ceiling is not a substitute for the global Hara quota. No automatic content cleanup is implemented in this slice.

## Narrow transport

`startAgentHubIngress` opens an ephemeral port on `127.0.0.1` only. It accepts an exact loopback Host, JSON POST, and `Authorization: Bearer <per-agent token>`. Browser Origin/Fetch-Metadata requests are refused. There is no CORS, general WebSocket initialization, file-path, session read/resume, task or schedule route. Header/body/concurrent-upload/connection/time limits are finite. The Host supplies the C0 error projection, which receives a fixed classification rather than arbitrary exception text.

The only paths are:

- `POST /v1/agent-hub/messages`: exact body `{ requestId, from, text, attachments }`.
- `POST /v1/agent-hub/receipts`: exact body `{ requestId }`; only the authenticated connection's receipt is returned, or null.

`from` must match the authenticated registration; it cannot select the true source. Any actor/human/approval/Workspace/permission fields are rejected. Incoming approval-looking text remains text. The saved receipt is persisted before returning. No callback for starting models, tools, tasks or schedules is accepted.

## Persistence and retry

Private directories/files use the existing Hara 0700/0600, no-follow, inode, hardlink, atomic-write and cross-process lock primitives. Catalogs and stored messages are parsed and bounded; damaged, missing-but-nonempty, aliased or foreign state fails closed instead of becoming an empty mailbox.

The stable request key is `(connectionId, requestId)`, including across token rotation. Equal retries return the original C0 receipt; changed content conflicts. Reinstating a different registered instance requires a new connection. A crash after immutable message publication and before catalog commit leaves one deterministic, quota-accounted orphan; retry verifies and reuses it. It is not silently replayed as a task. Unread is based on committed sequence numbers; marking read cannot consume future arrivals or move backward.

The quota counts serialized payloads, base64 overhead, catalog metadata, orphan/staging files and replacement peak space. Full storage rejects new content without eviction. Revocation remains available even when the configured content quota is full; disk/permission failure is still reported rather than claimed as a successful revoke.

## Attachments and preview quarantine

Text is at most 32 KiB UTF-8. A message has at most four files, each at most 8 MiB, totaling at most 16 MiB of decoded bytes. Exact canonical base64, safe display names, extension/type agreement and bounded image dimensions/container framing are checked. PNG/JPEG/WebP are limited to 20 MP and 8192 per dimension; animated PNG/WebP and other image formats are refused. MD/TXT are strict text; PDF is download-only. Executables, HTML, archives, video and unspecified types are refused.

Images are stored with `preview: "quarantined"`. Container/header checks are **not** a complete bitstream decoder. A future Desktop/media adapter must perform bounded trusted decoding and matching dimension/frame verification before any inline preview; this slice neither decodes via an external binary nor advertises preview capability. Malformed images can therefore remain quarantined rather than becoming executable/rendered content.

Content is copied into private immutable message files, never read again through the sender's original path. The read projection omits inline base64. A later media route must authorize one message/attachment at a time and must not grant the Hub directory to a runtime. Raw token holders cannot enumerate inbox messages or retrieve another agent's content.

## Verification and enablement gate

Focused tests exercise wrong source/extra authority fields, registration reuse, revocation during streaming, cross-scope/generation rejection, ACK loss/restart/token rotation, interrupted commit recovery, unread, quota/no eviction, links/corruption, attachment quarantine and the actual loopback listener. Tests use isolated synthetic state and zero model/provider calls.

Before enabling the feature, freeze the C0 external-source/receipt adapter; connect real registered-only G0 metadata; connect trusted native token handoff and the Hara quota allocator; then wire CLI/Host/UI as separate reviewed slices. Transport submission does not prove an external agent read or executed anything. Human sends/forwards and future approval cards retain their independent authority checks.
