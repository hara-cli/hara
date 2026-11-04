# Workspace managed MCP

Workspace extension grants and Host code review are separate permissions. Discovery supplies metadata only. Both the Workspace switch and the exact colleague tool assignment default off. A descriptor or upstream `readOnlyHint` never authorizes a process or a call.

## Host admission

The trusted composition may supply `reviewedMcpSources`, or restore the owner-only Host library `.hara/mcp-reviewed-v1.json`:

```json
{ "schemaVersion": 1, "records": [] }
```

Records come from `prepareWorkspaceMcpReview` **after owner code review** and are restored with `restoreWorkspaceMcpReview`. Preparing a record hashes code but does not audit its behavior, install dependencies, or run the server. The library is not editable through a model tool or Workspace RPC. Missing review means no executable extension tools.

A record binds the original source descriptor, physical absolute executable, bounded complete package directory, fixed arguments, actual binary/package digests and each tool's exact name, description and input schema. Review assigns the trusted `read` or `exec` effect. A changed candidate, binary, package entry or upstream schema requires a new review and new explicit grants. `tools/list_changed` freezes the connection; it cannot expand a running attempt.

This implementation accepts fixed **credential-free stdio** packages and text/JSON results on macOS with Seatbelt. Other platforms expose no callable managed tools; there is no unprotected fallback. It rejects symlinks, hard links, writable-by-group code, oversized packages/schemas, remote schema references, secret arguments and unsupported tool metadata. It does not support remote HTTP/SSE, OAuth, arbitrary package installation, dynamic tools, or credential injection. Those sources remain non-callable until their own Host admission exists. Do not put credentials in the review library, command arguments or child environment.

## Execution

A supported Desk advertises `workspace.extensions.manager.v1` during authenticated initialization. Clients without the external-call card contract, including unattended scheduled runs, receive no executable managed tools.

Tools are frozen into one admitted attempt and exposed through the existing registered CLI bridge or Pi native conversion. A Host-only object brand survives the receipt/permit decorators; serialized objects cannot obtain it. Every call still passes the common role policy, exact permit, lease, budget, cancellation and external confirmation path. The card approves the reviewed startup and **one exact call**; changing input, switching view, disconnecting, revoking or consuming the approval prevents dispatch. The card shows the complete redacted canonical input up to the 32 KiB input limit; it does not silently hide an action in a truncated tail. Authority is checked again after the response; a late response cannot restore a revoked grant. Ordinary external/exec tools retain their previous admission rules.

The server starts lazily after confirmation. A connection is reused within the attempt only; there are at most two owned servers per Workspace manager and 32 exposed tools per attempt. Children receive isolated writable state, reviewed code and system support reads, no ambient login/configuration/provider/bridge secrets, no Keychain service access and no hard-link creation. The frozen Workspace HTTP proxy defaults to `http://127.0.0.1:18888`; the kernel allows outbound connections only to that proxy port. There is no direct fallback. Other Workspace data remains unreadable even on external disks.

The existing loopback bridge binds the immutable attempt/lease and closes at completion or cancellation. Codex's existing S3 resident process retains its process authentication secret; each attempt still has its own endpoint and current permit closure. This manager does not replace S3 session origin/refresh rules or assert that a resident secret rotates every attempt. Pi and nonresident CLI endpoints use fresh bearer secrets.

## Results and recovery

A successful response means `server_reported_success`, with `verified:false`. It proves that a response was observed, not external business success. Text and structured values are redacted; raw stderr is discarded. Complete bounded results continue through the existing private receipt/pagination path. Results over the hard limit are rejected, never presented as complete truncated evidence.

The private per-Workspace invocation journal contains only bounded identifiers, argument digests, timing and outcomes. Desk receives a reduced last-call view, never the arguments, executable, environment or credential references. Before dispatch the journal records an operation. A crash, cancellation, protocol/result-limit failure or lost response after dispatch leaves `outcome_unknown`; a new attempt or restart cannot automatically replay identical source/tool/input. The user must reconcile the original operation. Unknown records are not evicted to make room.

Closing revokes approvals/capabilities and joins the common owned-process drain. An unknown drain keeps the admission lock and capacity reservation. It never authorizes killing unrelated processes or releasing the lease early.

The focused test uses real task-owned stdio servers, actual Host/governor/confirmation paths and synthetic Codex/Claude executables, plus actual Pi SDK/RPC conversion. Synthetic CLI protocol acceptance does not establish compatibility with authenticated vendor CLI versions or product/UI acceptance.
