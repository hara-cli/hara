# Copilot / Cursor / Grok Workspace drivers (local candidate, 2026-11-03)

These adapters use the existing Hara Workspace permit, lease, governor, confirmation cards, MCP bridge,
proxy, version history and stage/failure contracts. They are not External Session imports and do not
substitute another provider when a native run fails.

## Production admission is closed

`expanded-isolation.ts` rejects all three native sessions and metadata subprocesses before spawn.
There is no environment switch or renderer override. Desk explains this pending acceptance state.
The CLIs are not installed on this workstation; no real login, paid request or vendor UI was tested.

The 2026-11-03 coordination requirement prohibits native schedulers/wakeup/background agents and
inherited user MCP/plugins/hooks. Merely adding Hara MCP does not meet that requirement. Copilot
adds its file to existing MCP configuration; Cursor merges scopes; Grok also discovers compatible
Claude/Cursor configuration. Do not remove the admission gate until an exact binary has a reviewed,
tested mechanism covering all these sources while preserving host login. Missing capabilities must
refuse execution rather than changing HOME, copying credentials or silently enabling a tool.

`isForbiddenNativeTool` additionally refuses known native scheduling/background tool names. ACP
permission replies refuse these before authorization, use allow-once only, and bind authority to the
active session. Output observations from always-approve CLIs occur after execution; they are not an
isolation proof. Only Hara WorkspaceScheduler may create scheduled executions, with the normal
frozen task tier and audit path. This slice does not add a native cron service.

## Public permission layer

The branch includes public module commit d1ad885 (local cherry-pick 6e23066). Tier authority comes
from `workspaceRunPermissionTier(permit)`; an old frozen binding without the field stays controlled.
`expanded-policy-adapter.ts` is prepared for the common Host bridge `newWorkspaceNativePolicy` /
`endWorkspaceNativePolicy` / `publishWorkspaceNativeRisks`. The bridge starts the attempt with the
frozen run ID, excludes overlapping native writers, attaches verified diff evidence and publishes
sanitized risks. Those Host functions are not in d1ad885: integration with their published implementation
is still required. Missing functions refuse before spawn; no arbitrary CLI JSON becomes a receipt.
The production isolation gate is an additional prerequisite and remains closed after integration.

All launches use `policy.wrap`; both modes keep the outer Seatbelt. Cursor disables its nested native
sandbox. Full CLI flags depend only on the frozen full-protected tier. Cleanup joins actual physical
process termination, then restores the Cursor overlay, then collects evidence, then closes the policy.
Repeated MCP close calls join the same cleanup promise, including cancellation.

Host authentication is retained only in the native child. Agents/tests never inspect, copy or export
Keychain entries or host credential files. The shared policy preserves securityd access and prevents
Hara/credential writes; its exact credential exceptions and known child-tree limitations are documented
in the shared interface. This slice does not implement a custom provider or copy user configuration.

## Protocol and model contracts

- Copilot: JSONL, temporary private `--additional-mcp-config=@file`, builtin MCP disabled, no auto-update.
  Session idle/result plus a successful exit is required; intermediate/replayed/subagent completion and
  typed errors do not count. The dated documented model list does not promise account entitlement.
  Effort is offered only if the exact binary's protected help query advertises it.
- Cursor: bounded `models` parser and stream-json parser. A locked, inode/hash-fenced project
  `.cursor/mcp.json` overlay contains only Hara during the attempt; original bytes/mode return afterward.
  This project overlay alone does not suppress global sources. No effort option is invented.
- Grok: local ACP stdio (no shared leader), HTTP MCP capability required before session/new, exact
  current-session updates, bounded output and permission replay protection. No effort option is offered.

The constructor metadata/protection seams used in tests are trusted Host code with explicitly synthetic
CLI fixtures. They are not exposed through RPC and do not certify vendor behavior or Seatbelt isolation.
No installer downloads these CLIs. Missing executables use official manual-install links; binding only
accepts host login and does not launch login/reauth/resume commands.

## Verification scope

Run the focused files listed in the task's inbox report with Node 22.23.1 and the isolated HOME preload.
Fake main/colleague flows cover all three transports through real loopback Hara MCP/governor calls;
negative cases cover missing isolation/protection, native scheduler permission, typed zero-exit error,
foreign session, missing HTTP MCP capability, and cancellation/cleanup. The shared module's separate
fake-HOME Seatbelt tests establish only that module's stated boundaries, not end-to-end native tool
isolation, real Keychain ACL behavior, native change/check completion or Desk visual acceptance.

Official sources: [Copilot CLI](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference),
[Copilot configuration](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference),
[Cursor parameters](https://cursor.com/docs/cli/reference/parameters),
[Cursor MCP](https://cursor.com/docs/mcp),
[Grok ACP](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/15-agent-mode.md),
[Grok configuration](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/README.md).
Raft db5e399 was consulted for mechanisms only; no Raft implementation was copied.
