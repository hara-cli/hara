# Task-scoped human approvals — development integration

Status: the security core, agent loop, authenticated Serve transport and Desktop card are connected in
the development source. This work has not been released or verified with a real model and live Desktop.
An isolated test passing is not a public release. It does not change approval modes, project approvals,
native Codex/Claude approvals, Computer Use consent, or the physical-desktop lease.

## Scope and authority

`src/security/task-approvals.ts` holds memory-only grants for an exact engine-owned
`taskId + sessionId + agentId + canonical project identity + built-in tool family`.
The project key reuses `projectApprovalScope`, including the canonical root and directory dev/ino.
The core defines Bash, Python and file-change families. The current loop offers only the captured,
frozen built-in Bash and non-deleting file editors; Python stays one-action approved because arbitrary
source cannot be safely classified. File editors share one family and must stay inside both the canonical
project and any narrower host write boundary. Obvious destructive commands, opaque interpreters,
wrappers, scripts and unsupported shell syntax are ineligible. This classification is not an OS sandbox.
Unknown tools, copied tool objects and extra/plugin tools reusing a built-in name are ineligible.

Known native UI/script entry points (for example AppleScript, Windows Script Host, screenshots and
UI launchers) stay one-action approved. A Bash-family grant is still human delegation to shell commands,
not proof that `npm`, `make` or a custom executable has no indirect side effects. This development
feature does not add process isolation or claim to enforce Computer Use boundaries inside arbitrary
subprocesses. A rollout requiring that guarantee must defer shell-family reuse until such enforcement
exists; the dedicated Computer Use tools are never eligible for task grants.

`taskApprovalScope` requires a complete, already evaluated deterministic/organization/guardian guard
snapshot. Deny, Computer Use (including read screenshots requiring computer consent), explicit approval,
opaque/external tools, destructive operations, organization approval, and guardian review/block all win.
The module never determines whether an operation itself is authorized or within the user's objective.
It only permits reusing a human decision at the ordinary confirmation gate after every other gate passes.

Scope objects are module-owned and cannot be reconstructed from JSON, model input, history, environment,
or persisted task state. Grants contain no commands, arguments, source text, human answers, or credentials.
Project identity is revalidated at lookup and grant time. New processes start empty.

## Host-only contract

`createTaskApprovalStore()` exposes a read-only `reader.has(scope)` and privileged host operations:

- `prepareHumanGrant(scope, {approvalChannel, signal, isCurrent, ttlMs?})` creates a single-use callback.
  Creating a callback is not approval. The human transport must invoke it only after the human explicitly
  chooses task-scoped approval for that exact pending request. Ordinary allow/always must not invoke it.
- `revokeScope`, `revokeTask`, `revokeSession`, and `clear` erase grants and invalidate pending callbacks.
  Targeted revocation keeps unrelated existing grants; it conservatively invalidates all pending callbacks.

The callback checks a real-channel flag, live AbortSignal, exact host freshness callback, project identity,
and non-expired request deadline. Default TTL is 15 minutes; hard maximum is 30 minutes. Time is monotonic;
lookups and duplicate human callbacks never refresh an active grant. The bound signal's cancellation also
invalidates an active grant at lookup. Invalid/backward clock state fails closed. Expiry/revocation prevents
future reuse, not cancellation of an action already started.

These are internal trusted-host functions, not a human-authentication mechanism by themselves. Never
expose the store, callbacks, grant writer, or an equivalent approve/mode-escalation operation as a model
tool, MCP method, ToolContext field, plugin API, or durable state field.

## Development wiring

1. Serve supplies a fresh, private execution UUID for each root run, plus an authoritative task/session
   binding. A path, persona, provider, model or unchecked Agent reference is not approval identity. Missing
   bindings fail closed. Child Agents never inherit grants, and `/continue` starts a fresh approval run.
2. `confirm` still returns `boolean | "always"`. Its host-only `taskApproval` offer carries safe descriptive
   fields and private `grantFromHuman`/`isActive` closures. No closure, store or writer enters ToolContext,
   model prompts, snapshots, events or durable state.
3. The original submitter must have negotiated `task.approvals.v1`. Serve advertises a five-minute pending
   request deadline and a 15-minute maximum task choice. Only authenticated, session-owned
   `approval.reply` with `allow: true`, `forTask: true` and a UUID command ID can invoke the pending writer.
   `always` cannot be combined with `forTask`. Ordinary approvals never grant task scope. Duplicate intent
   uses the same receipt; changed, late, cross-session or stale intent cannot create or renew a grant.
   A failed writer is rejected, never downgraded to an ordinary allow.
4. The loop skips only ordinary confirmation, after all policy/understanding/permission/skill/Guardian
   floors pass. It rechecks task revision, registry provenance, target, permission rules, expiry and host
   freshness before hooks and again immediately before dispatch. Revoked planned reuse does not execute.
5. Revocation covers human denial/revoke, changed task brief/steering, completion, cancellation, deletion,
   original submitter disconnect, control transfer/release, policy changes and shutdown. Another observer
   socket cannot keep the disconnected owner's grant alive. Native external sessions remain independent.
6. Desktop renders the task option only for complete negotiated offers, never Agent-creation cards or
   native Codex/Claude requests. It displays server-confirmed state and a revoke action. An uncertain reply
   preserves the original task intent and command ID for safe retry; it cannot switch to another verdict.
   Client-clock expiry is an estimate and does not hide the revoke action. Newer terminal/revoke events
   win over a delayed acknowledgment. Snapshot restoration does not grant authority.
7. Computer Use always retains fresh consent per action. Expiring a task grant never releases/reclaims a
   physical desktop lease. There are no full-auto changes, approval models or AI self-approval.

`session.task-approval.revoke` withdraws the session's grants idempotently. `event.task_approval_state`,
the Serve snapshot and read-only resume expose only `{active, toolFamilies, expiresAt?, canRevoke}`.
Receipt persistence records command outcomes, not an active grant; process restart starts with none.

## Verification coverage and remaining rollout

Core/provenance tests cover forged scopes, builtin shadows, strict guards, monotonic expiry and revocation.
Loop fixtures cover explicit human choice, ordinary allow, changed task/policy/target, cancellation,
dispatch races, opaque commands and new-run isolation. Local fake-provider WebSocket fixtures cover
negotiation, ownership, duplicate receipts, deadlines, snapshots/resume and disconnect. Desktop tests
cover card rendering, typed RPC, restoration, uncertain intent, status and delayed acknowledgments.

These are isolated source tests. Real-model/live-GUI acceptance and release verification remain separate
rollout steps. Do not close a feedback ticket or announce a released version from these tests alone.

2026-10-08 final development verification, pinned Node 22.23.1:

- CLI full suite: 2,124/2,124 passed from a task-private compiled repository copy with isolated HOME.
- Desktop full suite: 410/410 passed, including task-card SSR, actual client payloads and recovery state.
- Synthetic feedback evaluation: 9/9; synthetic execution-latency evaluation: 8/8.
- Both repositories passed TypeScript and diff checks; the frontend production bundle built into a
  private temporary directory. No live daemon/dist replacement, real model, GUI automation or release.

Local WebSocket/proxy fixtures required permission to listen on loopback. Sandbox `listen EPERM` was
verified separately and is not a runtime regression. The final full CLI run used the same frozen loop,
Serve and test bytes as the working source, checked by SHA256 before execution.

## Isolated offline verification

Use Node 22.23.1 and the existing repository TypeScript compiler. Compile the new module and its local
dependencies into a newly created task-private `/private/tmp` directory, not the repository's `dist`.
The test-only `HARA_TASK_APPROVAL_TEST_BUILD_ROOT` selects that compiler output; production never reads it.
No dependency install, real model, daemon, credentials, or network call is needed.

```sh
task_build=$(mktemp -d /private/tmp/hara-task-approval-core.XXXXXX)
/Users/zhujianbo/.nvm/versions/node/v22.23.1/bin/node node_modules/typescript/bin/tsc --ignoreConfig \
  src/security/task-approvals.ts --module NodeNext --moduleResolution NodeNext --target ES2022 \
  --strict --skipLibCheck --types node --noEmitOnError --rootDir src --outDir "$task_build/dist"
HARA_TASK_APPROVAL_TEST_BUILD_ROOT="$task_build/dist" \
  /Users/zhujianbo/.nvm/versions/node/v22.23.1/bin/node --experimental-default-type=module \
  --test test/task-approvals.test.mjs
```
