# C2 execution gates

C2 composes three independent authorities: the existing opaque WorkspaceRunPermit, current C1 policy,
and a trusted C3 accepted-command/control source. Parsing C0, receiving a Hub message, checking C1,
setting an approval boolean or possessing a serialized RunBinding grants none of these.

The original C2 slice supplied the **consumer and in-process Pi adapter**; it did not implement the
durable C3 source. The C3 extension below now supplies trusted opt-in Host composition. C4 physical
lifecycle, C9 approvals, C12 product ingress, default production/Desktop activation and native
credential changes remain separate. Unprotected legacy runs retain their existing behavior and must
not be presented as C2-enforced; a C3-protected scope refuses legacy downgrade. C1 views continue
to report runtimeEnforced=false.

## Host composition and C3 port

`createAgentBoundaryExecutionGate({binding, authority, grant, control, tools})` verifies a live C1
command grant for task.dispatch and exactly matches scope/generation, human, node/local grant,
Agent, task and conversation to the frozen run. A gate is private WeakMap identity, single attachment,
and cannot be reconstructed from JSON. createWorkspaceRunPermit accepts it only through its trusted
Host-library input, `agentBoundary`; there is no equivalent transport/config field.

C3 implements `AgentBoundaryControlSource.bind(command, binding)`. The source must authenticate the
already-durably-accepted original command/digest and its unique run, reject accepted/unknown replay
onto another run, and return its commandId/runId/controlEpoch plus `assertCurrent(): void`. That
method synchronously checks live persistent control authority, holds and epoch on every effect.
Unknown/missing/async sources fail closed. A bare allowed/approved flag cannot implement the port.
The source is executable trusted Host code, never a client or model supplied callback or JSON object.
The deterministic in-memory source in tests is a fixture, not a production C3 implementation.

After C3 binding, C1 captures an opaque **policy-only** handle. Command deadline and transport
proof are checked at admission. Accepted work may continue after the UI disconnects; each new effect
still rereads the exact current parent/Agent/resource/tool policy and checks C3. Revocation, policy
revision changes, Host closure and C3 holds invalidate it. Neither this policy handle nor a C1 grant
can replace the genuine existing runtime permit. Closing a run retires its policy after physical drain.

C3 must keep accepted command/run identity durable across reconnect/restart; C2 does not mint a new
command, run or effect ID to resolve UNKNOWN. New dispatch after a hold/resume requires the new C3
control epoch, not a client timestamp. C3 owns command receipts and reconciliation; C2 owns local
per-effect fences and reuses the existing private completion journal.

## Supported effects and refusal

The supported initial lane is **controlled, in-process Pi, depth zero** with reviewed Host-scoped
tools. Tool function/schema/classifier/trust boundary and canonical C0 tool reference are pinned.
Actual dispatch checks allow/deny, current catalog revision, read-only policy, current C1 registry
resources and their original physical roots. Resource IDs resolve only through C1's own registry;
no second caller path map is accepted. A write requires write access. Roots retain canonical path,
dev/inode and generation, and the scoped file tools retain traversal/symlink/hardlink/protected-file
checks and atomic CAS. The actual IO target must lie in the approved demand, even if a Host classifier
incorrectly labels a legacy root as the home resource. Resource/control checks run again immediately before visible commits and
before returning private bytes. Classifier/resource resolvers are reviewed trusted Host code.

Bookkeeping tools task_intake/task_checkpoint/todo_write/ask_user still require explicit tool refs
and consume the same bounded effect budget. They never grant file or external access. Model requests
check the current C0 model-call budget before provider preparation and actual turn dispatch; the
original runtime/run budget remains an additional ceiling. Duty prose grants no execution rights.

Unmediated MCP servers, shell/computer effects, native engines (including full-protected Pi), and
child/delegation paths return **RUNTIME_UNSUPPORTED** before launch/remote call. A native read-only
switch or broad Seatbelt profile cannot enforce this fine-grained policy. A future adapter needs
actual per-effect interception and resource isolation before joining the support set. Approval-required
effects are refused until the exact-effect C9 authority is implemented; paid-required model calls also refuse before preparation; a remembered/boolean approval
cannot waive them. This refusal is part of the initial support contract, not successful native/MCP
acceptance. No native fallback is started.

## One existing durable effect journal

The existing completion-<runHash>.json remains bound to the complete frozen RunBinding. Its optional
snapshot.effects extension is additive: old observation-only documents stay readable and unchanged
unless a C2 admission/effect is claimed. Before any model/effect, the same journal pins a one-way
agentBoundaryAuthority digest of the original command/current policy/run. Reopening that run without
C2, with a different command authority, or by removing an option is refused; no legacy downgrade.
Restart recovery remains fail-closed until C3 can supply the original durable accepted authority; a
new connection proof or new command ID is not a substitute for the old acceptance. No arguments, raw results, paths, secrets or source text are retained.
The older completion observations continue to serve evidence checks; they are not replay permission.

Before physical dispatch C2 durably records accepted with a whole-run call ID hash and operation
digest. A returned successful call records completed (dispatch completion, not business acceptance).
Thrown/failed calls record unknown conservatively. A crash or failed settlement leaves accepted or
unknown; both block the original ID and the same operation under a new ID. Reusing an ID with changed
input conflicts. Completed duplicate IDs also conflict and cannot execute again; C3 returns the
original command receipt separately. Capacity exhaustion, malformed state or persistence failure
blocks effects without eviction or resetting identities. No automatic reconciliation/retry is added.

The actual physical Promise remains tracked by the original runtime permit and lease. Cancellation,
a C3 hold or lost response does not release a running Promise's claim/lease or infer rollback. C4 may
later expose draining/unknown/confirmed-stop states without changing this evidence.

## Review / activation gate

Run the C2 real-file tests, existing C1 provenance entry tests, original completion-evidence/run
regressions and the full repository suite. Test C3 admission/hold, simultaneous queued effects,
resource inode/symlink swaps, real atomic-write denial, missing/replaced tool bindings, actual governor
dispatch, unknown/crash recovery and native/MCP/child refusals independently. C0 canonical source,
fixture and cross-repository lock remain unchanged.

Production activation remains pending actual C3 integration and joint review. Passing the consumer
fixture tests does not establish real C3/Host/desktop/native joint acceptance.


## C3 source and reviewed adapter identity

[C3 command authority](agent-command-control-c3.md) now implements the persistent source through
trusted opt-in Host composition. The default product/bootstrap remains disabled. Scoped file tools
require the reviewed factory's opaque registration; names/regex and JSON copies cannot register an
adapter. New tools, including an innocently named `agent`, remain unsupported. A protected scope and
its existing completion authority cannot be reopened through an unmediated legacy RunPermit.
