# Copilot / Cursor / Grok Workspace drivers (local candidate, tier wiring 2026-11-04)

These adapters retain Hara Workspace permits, leases, governor, confirmation cards, MCP, proxy,
version history and stage/failure contracts. No provider fallback or automatic prompt replay is added.

## Jeff option A: inherited personal extensions

The former extension-isolation hard refusal is removed. Copilot/Cursor/Grok may load the user's
personal plugins, hooks and MCP using the original HOME/login. Hara does not read, copy or rewrite
home configuration or credentials. `expanded-isolation.ts` now only validates the runtime ID; its
compatibility preflight no longer requires isolation proof. There is no new permission opt-in.
Only these three adapters receive `extensionsIsolation: "inherited"` in closed failure diagnostics
and normal runtime-stage metadata. Existing diagnostics remain readable. Other isolated runtimes
keep their current behavior. Desk discloses the inherited mode in English, Simplified Chinese and
Traditional Chinese during draft selection, runtime-switch confirmation and local binding.

Hara MCP remains injected. Copilot's additional MCP config augments native configuration. Cursor's
locked project overlay adds Hara while retaining existing project MCP entries, then restores original
bytes/mode after physical exit. Global sources are left to the native CLI; Hara never enumerates them.
Grok requires ACP HTTP MCP capability before session/new. This is inherited mode, not isolation.

## Protection and governance remain mandatory

All native execution still requires the trusted common Seatbelt wrapper. Full flags come only from
the frozen full-protected tier; old task bindings without a tier remain controlled. HOME/login is
preserved without login/reauth commands. Missing policy/Host bridge, unsafe paths or unavailable
Seatbelt refuse execution; option A does not authorize unprotected full mode.

The complete public v4 Core baseline 9c75b58 is merged with its history. All three adapters use
`newWorkspaceNativePolicy` / `endWorkspaceNativePolicy` and `publishWorkspaceNativeRisks` with
installer-proved account/runtime/protected-state roots. Every launch retains both `onProcess` and
`drainProcess`, including Grok ACP and controlled model/help capture. Host owns beginAttempt(runId),
overlapping-writer exclusion, verified diff binding and sanitized risk publication. No CLI JSON or
prose becomes an effect receipt. Missing ownership never releases the public startup barrier.

Own login files are declared read-only: Copilot `.copilot/config.json` and `.config/gh/hosts.yml`,
Cursor `.cursor/cli-config.json`, Grok `.grok/user-settings.json` and `.grok/auth.json`. These are
path declarations, not credential reads by Hara. The native runtime retains securityd/login-Keychain
access under system ACLs. Direct writes to Hara state and credentials, and reads of other runtimes'
credentials, remain denied. Personal extensions inherit the same native process policy.

Known native scheduling/wakeup/background tools remain refused. ACP permissions are allow-once,
current-session/active-turn bound; late, cancelled and changed-identity requests fail. Observations
from always-approve CLIs can arrive after execution, so they are not a universal pre-execution
interceptor. Only Hara WorkspaceScheduler owns scheduling and the normal frozen tier/audit path.

Attempt shutdown awaits public process ownership/drain before Host evidence publication and
private temporary-state cleanup. Duplicate MCP close calls join the same physical cleanup. Cursor's
project overlay is installed before the attempt baseline and restored after drain/evidence, so live
and final evidence exclude Hara injection. Restore refuses concurrent config changes. A failed drain
retains recovery state rather than restoring configuration under a live native child.

The public boundary uses process groups, birth identifiers and observed ancestry. An unobserved
daemon that instantly detaches and reparents between samples remains outside its proven coverage.
This is the accepted public-layer limitation; no administrator helper or universal daemon claim is
added. Only owned processes are terminated.

## Protocol/model contracts

- Copilot: bounded JSONL; private temporary additional MCP config; no auto-update. Completion needs
  a real terminal and successful exit. Intermediate/replayed/subagent terminals and typed zero-exit
  errors do not pass. Dated documented models; effort only when exact protected help advertises it.
- Cursor: bounded live models parser and stream-json. Both tiers disable its nested sandbox and keep
  outer Seatbelt. Full uses force; controlled uses ask. No unverified effort option is offered.
- Grok: local ACP stdio without a shared leader, current-session events and bounded permission replay
  handling. Documented model list; no unverified effort option is offered.

Missing CLI uses official manual-install instructions; Hara does not install it or initiate login.
Fake metadata/protection seams in tests are trusted Host composition only, never RPC capabilities.

## Verification limits

Only focused tests and builds run with Node 22.23.1. Fake HOME/CLI fixtures cover inherited config
reads under real Seatbelt, denied Hara writes/foreign credential reads, normal/abort process cleanup,
MCP/governor flow, two frozen tiers, Host workspace diff evidence (including controlled write denial),
scheduling refusal and closed diagnostics/stages. Public common-layer N1 checks and Desk permission
controls are covered separately. Real CLI/account login, Keychain ACL behavior, vendor extension
discovery, end-to-end native risk/Desk composition and native app visual acceptance are not established.
No real Keychain item or paid model is accessed. Focused evidence and exact final SHAs are recorded in
the local inbox tip; there is no main merge, push, installation or release.

Official references: [Copilot CLI](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference),
[Copilot config](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference),
[Cursor parameters](https://cursor.com/docs/cli/reference/parameters), [Cursor MCP](https://cursor.com/docs/mcp),
[Grok ACP](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/15-agent-mode.md).
Raft db5e399 was consulted only for mechanisms; no FSL implementation was copied.
