// C3 trusted Host composition. There is no default issuer and no renderer callback/approved boolean.
import { createHash, randomUUID } from "node:crypto";
import { AGENT_BOUNDARY_ERRORS, AgentBoundaryContractError, assertAgentBoundaryContext, parseAgentBoundaryDocument,
  type AgentBoundaryCommand, type AgentBoundaryErrorCode, type AgentBoundaryReceipt } from "./agent-boundaries-contract.js";
import { WorkspaceAgentBoundaryAuthority, type AgentCommandGrant, type AgentCommandMutation } from "./agent-boundary-authority.js";
import { assertAgentBoundaryRuntimeSupported, type AgentBoundaryControlSource } from "./agent-boundary-execution.js";
import { agentCommandTargetEpoch, assertAgentCommandCapacity, commandDigest, commandId, nextCommandEpoch,
  type AgentCommandAudit, type AgentCommandControl, type AgentCommandHold, type AgentCommandRun, type AgentCommandState } from "./agent-command-state.js";
import { canonical, deepFreeze, messageBody, UUID } from "./local-state.js";
import { captureWorkspaceProjectIdentity, freezeWorkspaceRunBinding, workspaceRunBindingsEqual, type WorkspaceRunBinding } from "./run-binding.js";
import { WorkspaceSessionLease } from "./session-lease.js";

const fail = (code: AgentBoundaryErrorCode, field = "control.authority"): never => { throw new AgentBoundaryContractError(code, field); };
export const agentCommandMessageDigest = (conversationId: string, message: string): string => createHash("sha256")
  .update("hara-agent-command-message-v1\0").update(canonical({ conversationId, message })).digest("hex");
declare const intakeBrand: unique symbol;
export interface AgentCommandIntake { readonly [intakeBrand]: true }
declare const preparationBrand: unique symbol;
export interface AgentCommandRunPreparation { readonly [preparationBrand]: true }
interface Intake { owner: WorkspaceAgentCommandControl; transport: Parameters<WorkspaceAgentBoundaryAuthority["admit"]>[0]; command: AgentBoundaryCommand; proposal?: unknown; consumed: boolean }
interface Preparation { intake: AgentCommandIntake; binding: Readonly<WorkspaceRunBinding>; lease: WorkspaceSessionLease; requestId: string }
interface LiveRun extends Preparation { command: AgentBoundaryCommand; grant: AgentCommandGrant; bound: boolean }
const intakes = new WeakMap<object, Intake>(), preparations = new WeakMap<object, Preparation>();
export function agentCommandIntakeFacts(handle: unknown) {
  const state = handle && typeof handle === "object" ? intakes.get(handle) : undefined;
  if (!state || state.consumed) return fail("AUTHORITY_UNVERIFIED", "control.intake");
  return deepFreeze({ command: state.command, workspaceId: state.command.context.scope.workspaceId });
}
function receipt(command: AgentBoundaryCommand, epoch: number, holdId: string | null, status: AgentBoundaryReceipt["status"], code: AgentBoundaryErrorCode | null = null,
  run?: AgentCommandRun, pendingDrain = false): AgentBoundaryReceipt {
  const effect = run?.effect ?? "none", unknown = effect === "unknown";
  const value = parseAgentBoundaryDocument({ schemaVersion: 1, mode: "personal", kind: "command-receipt", context: command.context,
    commandId: command.commandId, rootRequestId: command.rootRequestId, agentId: command.agentId, intentDigest: command.intentDigest,
    status: unknown ? "unknown" : status, control: { epoch, holdId }, execution: {
      drain: run?.drainProofRef ? "observed" : pendingDrain ? "pending" : "not_requested", drainProofRef: run?.drainProofRef ?? null,
      effect, effectId: run?.effectId ?? null },
    error: unknown ? { code: "EFFECT_OUTCOME_UNKNOWN", retry: AGENT_BOUNDARY_ERRORS.EFFECT_OUTCOME_UNKNOWN }
      : code ? { code, retry: AGENT_BOUNDARY_ERRORS[code] } : null });
  if (value.kind !== "command-receipt") return fail("INVALID_DOCUMENT"); return value;
}
function agentControl(state: AgentCommandState, agentId: string): AgentCommandControl {
  let row = state.agents.find(row => row.agentId === agentId);
  if (!row) { row = { agentId, epoch: 0, hold: null, dismissed: false }; state.agents.push(row); }
  return row;
}
function addAudit(state: AgentCommandState, command: AgentBoundaryCommand, input: {
  action?: AgentCommandAudit["action"]; decision: AgentCommandAudit["decision"]; code?: AgentBoundaryErrorCode | null;
  oldEpoch: number; newEpoch: number; policyRevision: number; now: number;
}): void {
  state.sequence = nextCommandEpoch(state.sequence);
  state.audit.push({ eventId: `audit_${state.sequence}`, sequence: state.sequence, commandId: command.commandId, agentId: command.agentId,
    action: input.action ?? command.operation.action, decision: input.decision, code: input.code ?? null,
    actorId: command.context.humanSubjectId, nodeId: command.context.nodeId, at: new Date(input.now).toISOString(),
    oldEpoch: input.oldEpoch, newEpoch: input.newEpoch, policyRevision: input.policyRevision, acknowledged: false });
}
/** Accepted command/control authority only. The existing opaque RuntimePermit and current C1 policy
 * remain independent requirements. An original acceptance is never re-bound after process restart. */
export class WorkspaceAgentCommandControl implements AgentBoundaryControlSource {
  private readonly live = new Map<string, LiveRun>();
  private available = true;
  private readonly issuerId = randomUUID();
  constructor(private readonly authority: WorkspaceAgentBoundaryAuthority, private readonly now: () => number = Date.now) {}
  initialize(transport: Intake["transport"]) { return this.authority.initializeCommandControl(transport); }
  private intake(handle: unknown): Intake {
    const state = handle && typeof handle === "object" ? intakes.get(handle) : undefined;
    if (!this.available || !state || state.owner !== this || state.consumed) return fail("AUTHORITY_UNVERIFIED", "control.intake"); return state;
  }
  begin(transport: Intake["transport"], raw: unknown, input: { message?: string; proposal?: unknown } = {}): { receipt: AgentBoundaryReceipt } | { intake: AgentCommandIntake } {
    const parsed = parseAgentBoundaryDocument(raw);
    if (parsed.kind !== "command") return fail("INVALID_DOCUMENT");
    const snapshot = this.authority.commandControlForReader(transport, parsed.agentId);
    assertAgentBoundaryContext(parsed, snapshot.context);
    const existing = snapshot.control.commands.find(row => row.command.commandId === parsed.commandId);
    if (existing) {
      if (canonical(parsed) !== canonical(existing.command)) return fail("COMMAND_ID_CONFLICT", "control.command");
      return { receipt: existing.receipt }; // Fresh reader authentication; never re-admit an expired intent.
    }
    if (!this.available) return fail("AUTHORITY_UNVERIFIED", "control.source");
    const command = this.authority.authenticateCommandIntent(transport, parsed);
    if (command.operation.action === "task.dispatch") {
      if (!messageBody(input.message) || agentCommandMessageDigest(command.operation.conversationId, input.message) !== command.operation.messageDigest) return fail("AUTHORITY_UNVERIFIED", "control.message");
    } else if (input.message !== undefined) return fail("INVALID_DOCUMENT", "control.message");
    const handle = Object.freeze({}) as AgentCommandIntake;
    intakes.set(handle, { owner: this, transport, command, ...(input.proposal !== undefined ? { proposal: structuredClone(input.proposal) } : {}), consumed: false });
    return { intake: handle };
  }
  prepareRun(handle: AgentCommandIntake, bindingInput: WorkspaceRunBinding, lease: WorkspaceSessionLease, requestId: string): AgentCommandRunPreparation {
    const state = this.intake(handle), command = state.command, binding = freezeWorkspaceRunBinding(bindingInput);
    if (command.operation.action !== "task.dispatch" || command.operation.taskId !== binding.agent.taskId || command.operation.conversationId !== binding.sessionId
      || binding.agent.agentId !== command.agentId || !(lease instanceof WorkspaceSessionLease) || lease.sessionId !== binding.sessionId || !UUID.test(requestId)) return fail("CONTEXT_MISMATCH", "control.run");
    assertAgentBoundaryRuntimeSupported(binding); this.authority.assertCommandRunBinding(binding); lease.assertCurrent();
    if (canonical(captureWorkspaceProjectIdentity(binding.project.root)) !== canonical(binding.project)) return fail("STALE_REVISION", "control.run");
    const preparation = Object.freeze({}) as AgentCommandRunPreparation;
    preparations.set(preparation, { intake: handle, binding, lease, requestId }); return preparation;
  }
  accept(handle: AgentCommandIntake, prepared?: AgentCommandRunPreparation): AgentBoundaryReceipt {
    const intake = this.intake(handle), preparation = prepared && preparations.get(prepared);
    if (prepared && (!preparation || preparation.intake !== handle)) return fail("AUTHORITY_UNVERIFIED", "control.preparation");
    let acceptedNew = false;
    try {
      this.authority.transactCommand(intake.transport, intake.command, facts => {
        const state = facts.control, command = facts.command, op = command.operation;
        const existing = state.commands.find(row => row.command.commandId === command.commandId);
        if (existing) {
          if (canonical(existing.command) !== canonical(command)) return fail("COMMAND_ID_CONFLICT", "control.command");
          return { control: state };
        }
        const agent = agentControl(state, command.agentId);
        let code = facts.authorizationError, oldEpoch = agent.epoch, targetRun: AgentCommandRun | undefined, applyPolicy = false;
        if (op.action === "task.stop") targetRun = state.runs.find(run => run.runId === op.runId && run.agentId === command.agentId && run.taskId === op.taskId && run.claimRevision === op.claimRevision);
        if (!code) {
          try { oldEpoch = agentCommandTargetEpoch(state, command); }
          catch (error) { code = error instanceof AgentBoundaryContractError ? error.code : "AUTHORITY_UNVERIFIED"; }
        }
        if (!code && command.expected.controlEpoch !== oldEpoch) code = "STALE_REVISION";
        if (!code && agent.dismissed && op.action !== "task.stop") code = "CONTROL_HELD";
        if (!code && op.action === "task.dispatch" && agent.hold) code = "CONTROL_HELD";
        if (!code && op.action === "task.dispatch") {
          if (!preparation) code = "AUTHORITY_UNVERIFIED";
          else if (state.runs.some(run => run.rootRequestId === command.rootRequestId || run.taskId === op.taskId || run.runId === preparation.binding.runId)) code = "COMMAND_ID_CONFLICT";
          else {
            this.authority.assertCommandRunBinding(preparation.binding); preparation.lease.assertCurrent();
            const run: AgentCommandRun = { commandId: command.commandId, rootRequestId: command.rootRequestId, agentId: command.agentId, taskId: op.taskId,
              runId: preparation.binding.runId, claimRevision: 1, requestId: preparation.requestId, leaseAttemptId: preparation.lease.attemptId, issuerId: this.issuerId,
              binding: preparation.binding, bindingDigest: commandDigest(preparation.binding), agentControlEpoch: agent.epoch, epoch: agent.epoch,
              hold: null, state: "accepted", effect: "none", effectId: null, drainProofRef: null };
            state.runs.push(run); targetRun = run; acceptedNew = true;
          }
        }
        if (!code && op.action === "agent.resume" && (!agent.hold || agent.hold.holdId !== op.holdId)) code = "STALE_REVISION";
        const sequence = nextCommandEpoch(state.sequence);
        const newHold = (reason: AgentCommandHold["reason"]): AgentCommandHold => ({ holdId: `hold_${randomUUID()}`, reason, sequence });
        if (!code) {
          if (op.action === "task.stop" && targetRun && !targetRun.hold) { targetRun.epoch = nextCommandEpoch(targetRun.epoch); targetRun.hold = newHold("task_stop"); if (targetRun.state !== "drained") targetRun.state = "draining"; }
          else if (op.action === "agent.pause" && !agent.hold) { agent.epoch = nextCommandEpoch(agent.epoch); agent.hold = newHold("agent_pause"); }
          else if (op.action === "agent.resume") { agent.epoch = nextCommandEpoch(agent.epoch); agent.hold = null; }
          else if (op.action === "agent.dismiss") { agent.epoch = nextCommandEpoch(agent.epoch); agent.hold = newHold("dismissed"); agent.dismissed = true; }
          else if (op.action === "duty.update" || op.action === "boundary.update") { agent.epoch = nextCommandEpoch(agent.epoch); applyPolicy = true; }
        }
        const newEpoch = op.action === "task.stop" ? targetRun?.epoch ?? oldEpoch : agent.epoch;
        const holdId = op.action === "task.stop" ? targetRun?.hold?.holdId ?? null : agent.hold?.holdId ?? null;
        const drain = ["task.stop", "agent.pause", "agent.dismiss"].includes(op.action);
        const result = receipt(command, newEpoch, holdId, code ? "rejected" : drain || op.action === "task.dispatch" ? "accepted" : "applied", code, undefined, !code && drain);
        addAudit(state, command, { decision: code ? "rejected" : "allowed", code, oldEpoch, newEpoch,
          policyRevision: applyPolicy ? facts.proposedPolicyRevision! : facts.policyRevision, now: this.now() });
        state.commands.push({ command, receipt: result, sequence: state.sequence });
        assertAgentCommandCapacity(state, !code && drain);
        return { control: state, applyPolicy };
      }, intake.proposal);
      intake.consumed = true;
      const snapshot = this.authority.commandControlState(), record = snapshot.control.commands.find(row => row.command.commandId === intake.command.commandId)!;
      if (acceptedNew && preparation && record.receipt.status === "accepted") {
        try {
          const grant = this.authority.admit(intake.transport, intake.command);
          this.live.set(preparation.binding.runId, { ...preparation, command: intake.command, grant, bound: false });
        } catch { this.available = false; } // Accepted intent stays original; no fallback/start or new identity.
      }
      return record.receipt;
    } catch (error) {
      intake.consumed = true;
      if (!(error instanceof AgentBoundaryContractError && ["STALE_REVISION", "COMMAND_ID_CONFLICT"].includes(error.code))) this.available = false;
      throw error;
    }
  }
  executionGrant(runId: string): AgentCommandGrant {
    const live = this.live.get(runId); if (!this.available || !live) return fail("AUTHORITY_UNVERIFIED", "control.run");
    this.assertRunCurrent(live); return live.grant;
  }
  private assertRunCurrent(live: LiveRun): AgentCommandRun {
    if (!this.available) return fail("AUTHORITY_UNVERIFIED", "control.source");
    live.lease.assertCurrent();
    const state = this.authority.commandControlState().control;
    const run = state.runs.find(row => row.runId === live.binding.runId), agent = state.agents.find(row => row.agentId === live.command.agentId);
    if (!run || !agent || run.commandId !== live.command.commandId || run.issuerId !== this.issuerId || run.leaseAttemptId !== live.lease.attemptId
      || run.bindingDigest !== commandDigest(live.binding) || !workspaceRunBindingsEqual(run.binding, live.binding)) return fail("AUTHORITY_UNVERIFIED", "control.run");
    if (agent.hold || agent.dismissed || run.hold || ["draining", "drained", "unknown"].includes(run.state)) return fail("CONTROL_HELD", "control.hold");
    if (agent.epoch !== run.agentControlEpoch || run.epoch !== live.command.expected.controlEpoch) return fail("STALE_REVISION", "control.epoch");
    return run;
  }
  bind(command: AgentBoundaryCommand, binding: Readonly<WorkspaceRunBinding>) {
    const live = this.live.get(binding.runId);
    if (!live || live.bound || canonical(live.command) !== canonical(command) || !workspaceRunBindingsEqual(live.binding, binding)) return fail("AUTHORITY_UNVERIFIED", "control.binding");
    this.assertRunCurrent(live); live.bound = true;
    return Object.freeze({ commandId: command.commandId, runId: binding.runId, controlEpoch: command.expected.controlEpoch,
      assertCurrent: () => { this.assertRunCurrent(live); } });
  }
  readReceipt(transport: Intake["transport"], agentId: string, id: string): AgentBoundaryReceipt {
    if (!commandId(id)) return fail("INVALID_DOCUMENT");
    const snapshot = this.authority.commandControlForReader(transport, agentId), row = snapshot.control.commands.find(row => row.command.commandId === id && row.command.agentId === agentId);
    if (!row) return fail("AUTHORIZATION_DENIED", "control.receipt"); return row.receipt;
  }
  inspect(transport: Intake["transport"], agentId: string) {
    const { control } = this.authority.commandControlForReader(transport, agentId), agent = control.agents.find(row => row.agentId === agentId);
    return deepFreeze({ agent: agent ?? { agentId, epoch: 0, hold: null, dismissed: false },
      runs: control.runs.filter(run => run.agentId === agentId).map(run => ({ runId: run.runId, taskId: run.taskId, commandId: run.commandId,
        claimRevision: run.claimRevision, epoch: run.epoch, state: run.state, effect: run.effect, hold: run.hold, drainProofRef: run.drainProofRef,
        recovery: ["unknown", "draining"].includes(run.state) ? ["query_original", "request_stop", "await_physical_drain"] : [] })) });
  }
  audit(transport: Intake["transport"], agentId: string) {
    return this.authority.commandControlForReader(transport, agentId).control.audit.filter(row => row.agentId === agentId);
  }
}
