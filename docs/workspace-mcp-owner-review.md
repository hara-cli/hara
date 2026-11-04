# Workspace MCP owner review

`workspace.extensions.owner-review.v1` adds human review of a discovered local MCP source. The authenticated client must be viewing Main Hara in a local-authority Workspace. Colleague/channel sessions and model tool interfaces cannot call the review service.

## Owner flow

1. List candidates, then describe an opaque Host record. The Host resolves an installed executable and complete local package, computes SHA256 fingerprints, and freezes the launch definition. Nothing starts during discovery or description.
2. Review the displayed paths, code fingerprints, proxy-only network boundary and lack of forwarded credentials. Explicitly confirm one isolated startup to read the tool catalog. The inspector has no reverse capabilities and sends only initialize/tools/list; it never calls a tool. Startup itself may have effects, so this first confirmation is required.
3. Inspect exact tool names, descriptions and input schemas. Approve the fixed record after the process drains. The Host does not recompute changed code into an approval.
4. Select tools and confirm the existing Workspace and individual-agent grants separately. A source approval is not an enable switch or a call approval. Every invocation still passes the governor, runtime permissions and a fresh one-call card.

All inspected tools conservatively have exec effect, regardless of untrusted readOnlyHint metadata. The caller therefore needs an applicable user-authorized change/operation intent. The upstream result reports server_reported_success with verified:false; it is not independent verification of a business result.

## Storage and fences

The Host alone writes owner-only `.hara/mcp-reviewed-v1.json`, version 1, under the configured Host account home. Legacy records remain readable. The new envelope adds a monotonically increasing CAS revision and an invalidated map. A per-file private lock plus exact text/inode checks fence writes; malformed, future and backup-only states are read-only, never reset to a writable empty library. The backup is updated after each write so recovery cannot resurrect a revoked source.

Opaque review IDs are client/view/generation/Main-epoch/proxy/config/library-bound, expire after two minutes, and are replaced by a list reload. Inspection is single-use with a 15-second deadline and at most two owned child reservations. Cancellation, selection changes and disconnect abort inspection; common process ownership/drain rules apply. Unknown drain retains capacity rather than spawning another child automatically.

Approve/inspect/revoke requests accept only workspaceId, expectedGeneration, recordId and confirmed. Describe/cancel accept scope plus recordId. Commands, arguments, environment, tool definitions and file paths are rejected as RPC input. Launch summaries are read-only Host output. No credentials resolver, login or Keychain path is introduced.

Revoking a record or changing code/config/schema makes it non-callable. Each newly approved record contains a new review nonce in its source revision, so identical-code reapproval cannot revive old grants. Upstream catalog notifications persist invalidation against the exact reviewed revision; late old notifications cannot invalidate a newer owner review. Permission removal remains available with an unavailable proxy. A dispatched operation may already have effects; revocation does not claim rollback or authorize replay.

## Deliberately unsupported

Only macOS protected, credential-free stdio is callable. HTTP/SSE/OAuth, custom environment/headers/credential declarations, floating installers, shells and inline code cannot be approved. Complete bounded fixed packages are required (512 files, 1,024 entries, 32 MiB; no symlinks, hard links, credential paths or group/world-writable code). Package/runtime dependencies outside the reviewed readable set are unavailable. There is no unprotected or direct-network fallback.

## Focused verification

Build with the repository-approved Node version, then run the owner, manager, catalog, local execution and registered CLI MCP tests with `--test-concurrency=1` and isolated HOME. Owner fixtures use actual discovered synthetic config and actual protected stdio; no real accounts, model credentials or user MCP configuration. Desktop tests cover code/catalog/approval ordering, revocation confirmation, three languages, unknown outcomes, cancellation and stale views. These checks do not establish native visual acceptance or a formal release receipt.
