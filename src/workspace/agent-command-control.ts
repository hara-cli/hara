import { workspaceRunDrainProof, assertWorkspaceRunDrainOwner, workspaceRunEffectFacts, workspaceRunDrainFacts, type WorkspaceRunPermit } from "./execution.js";
// C3 trusted Host composition. There is no default issuer and no renderer callback/approved boolean.
import { createHash, randomUUID } from "node:crypto";
import { AGENT_BOUNDARY_ERRORS, AgentBoundaryContractError, assertAgentBoundaryContext, parseAgentBoundaryDocument,
  type AgentBoundaryCommand, type AgentBoundaryErrorCode, type AgentBoundaryReceipt } from "./agent-boundaries-contract.js";
import { WorkspaceAgentBoundaryAuthority, type AgentCommandGrant, type AgentCommandMutation } from "./agent-boundary-authority.js";
import { assertAgentBoundaryRuntimeSupported, type AgentBoundaryControlSource } from "./agent-boundary-execution.js";
import { agentPolicyProposalDigest, agentCommandRunIdentity, agentCommandTargetEpoch, assertAgentCommandCapacity, commandDigest, commandId, nextCommandEpoch,
  type AgentCommandAudit, type AgentCommandControl, type AgentCommandHold, type AgentCommandRun, type AgentCommandState } from "./agent-command-state.js";
import { canonical, deepFreeze, messageBody, UUID } from "./local-state.js";
import { captureWorkspaceProjectIdentity, freezeWorkspaceRunBinding, workspaceRunBindingsEqual, type WorkspaceRunBinding } from "./run-binding.js";
import { WorkspaceSessionLease } from "./session-lease.js";

const restrictive = (action: string) => ["task.stop", "agent.pause", "agent.dismiss"].includes(action);
const fail = (code: AgentBoundaryErrorCode, field = "control.authority"): never => { throw new AgentBoundaryContractError(code, field); };
export const agentCommandMessageDigest = (conversationId: string, message: string): string => createHash("sha256")
  .update("hara-agent-command-message-v1\0").update(canonical({ conversationId, message })).digest("hex");
declare const intakeBrand: unique symbol;
export interface AgentCommandIntake { readonly [intakeBrand]: true }
declare const preparationBrand: unique symbol;
export interface AgentCommandRunPreparation { readonly [preparationBrand]: true }
interface Intake { owner: WorkspaceAgentCommandControl; transport: Parameters<WorkspaceAgentBoundaryAuthority["admit"]>[0]; command: AgentBoundaryCommand; proposal?: unknown; consumed: boolean }
interface Preparation { intake: AgentCommandIntake; binding: Readonly<WorkspaceRunBinding>; lease: WorkspaceSessionLease; requestId: string }
interface LiveRun extends Preparation { accepted: Readonly<AgentCommandRun>; command: AgentBoundaryCommand; grant: AgentCommandGrant; bound: boolean; permit?: WorkspaceRunPermit }
const intakes = new WeakMap<object, Intake>(), preparations = new WeakMap<object, Preparation>();
export function agentCommandIntakeFacts(handle: unknown, owner?: WorkspaceAgentCommandControl) {
  const state = handle && typeof handle === "object" ? intakes.get(handle) : undefined;
  if (!state || state.consumed || owner && state.owner !== owner) return fail("AUTHORITY_UNVERIFIED", "control.intake");
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
  private readonly pendingDrainProofs = new Map<string, unknown>();
  private readonly issuerId = randomUUID();
  constructor(private readonly authority: WorkspaceAgentBoundaryAuthority, private readonly now: () => number = Date.now) {}
  initialize(transport: Intake["transport"]) { return this.authority.initializeCommandControl(transport); }
  private intake(handle: unknown): Intake {
    const state = handle && typeof handle === "object" ? intakes.get(handle) : undefined;
    if (!state || state.owner !== this || state.consumed || !this.available && !restrictive(state.command.operation.action)) return fail("AUTHORITY_UNVERIFIED", "control.intake"); return state;
  }
  begin(transport: Intake["transport"], raw: unknown, input: { message?: string; proposal?: unknown } = {}): { receipt: AgentBoundaryReceipt } | { intake: AgentCommandIntake } {
    const parsed = parseAgentBoundaryDocument(raw);
    if (parsed.kind !== "command") return fail("INVALID_DOCUMENT");
    const snapshot = this.authority.commandControlForReader(transport, parsed.agentId);
    assertAgentBoundaryContext(parsed, snapshot.context);
    const existing = snapshot.control.commands.find(row => row.command.commandId === parsed.commandId);
    if (existing) {
      if (canonical(parsed) !== canonical(existing.command)) return fail("COMMAND_ID_CONFLICT", "control.command");
      const op = parsed.operation;
      if (input.message !== undefined && (op.action !== "task.dispatch" || !messageBody(input.message)
        || agentCommandMessageDigest(op.conversationId, input.message) !== op.messageDigest)) return fail("COMMAND_ID_CONFLICT", "control.message");
      if (input.proposal !== undefined && (op.action !== "duty.update" && op.action !== "boundary.update"
        || agentPolicyProposalDigest(input.proposal) !== (op.action === "duty.update" ? op.proposedDutyDigest : op.proposedBoundaryDigest))) return fail("COMMAND_ID_CONFLICT", "control.proposal");
      return { receipt: this.currentReceipt(existing.command, existing.receipt, snapshot.control) }; // Fresh reader authentication; never re-admit an expired intent.
    }
    if (!this.authority.commandControlSourceHealthy()) this.available = false;
    if (!this.available && !restrictive(parsed.operation.action)) return fail("AUTHORITY_UNVERIFIED", "control.source");
    const command = this.authority.authenticateCommandIntent(transport, parsed);
    if (command.operation.action === "task.dispatch") {
      if (!messageBody(input.message) || agentCommandMessageDigest(command.operation.conversationId, input.message) !== command.operation.messageDigest) return fail("AUTHORITY_UNVERIFIED", "control.message");
    } else if (input.message !== undefined) return fail("INVALID_DOCUMENT", "control.message");
    const handle = Object.freeze({}) as AgentCommandIntake;
    intakes.set(handle, { owner: this, transport, command, ...(input.proposal !== undefined ? { proposal: structuredClone(input.proposal) } : {}), consumed: false });
    return { intake: handle };
  }
  /** Denials are committed before Host opens private model context or prepares an execution. */
  rejectBlocked(handle: AgentCommandIntake): AgentBoundaryReceipt | null {
    const intake = this.intake(handle), { command, transport } = intake, operation = command.operation;
    let grant: AgentCommandGrant | undefined;
    try {
      grant = this.authority.admit(transport, command);
      const { control } = this.authority.commandControlState(), agent = control.agents.find(row => row.agentId === command.agentId);
      if (command.expected.controlEpoch !== agentCommandTargetEpoch(control, command)
        || command.operation.action === "task.dispatch" && (agent?.hold || agent?.dismissed
          || control.runs.some(run => run.rootRequestId === command.rootRequestId || operation.action === "task.dispatch" && run.taskId === operation.taskId))) return this.accept(handle);
      return null;
    } catch (error) {
      if (error instanceof AgentBoundaryContractError) return this.accept(handle);
      throw error;
    } finally { if (grant) this.authority.retire(grant); }
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
      const transact = () => this.authority.transactCommand(intake.transport, intake.command, facts => {
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
          if (state.runs.some(run => run.rootRequestId === command.rootRequestId || run.taskId === op.taskId || preparation && run.runId === preparation.binding.runId)) code = "COMMAND_ID_CONFLICT";
          else if (!preparation) code = "AUTHORITY_UNVERIFIED";
          else {
            this.authority.assertCommandRunBinding(preparation.binding); preparation.lease.assertCurrent();
            const run: AgentCommandRun = { commandId: command.commandId, rootRequestId: command.rootRequestId, agentId: command.agentId, taskId: op.taskId,
              runId: preparation.binding.runId, claimRevision: 1, policyRevision: facts.policyRevision, requestId: preparation.requestId, leaseAttemptId: preparation.lease.attemptId, issuerId: this.issuerId,
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
        const result = receipt(command, newEpoch, holdId, code ? "rejected" : drain || op.action === "task.dispatch" ? "accepted" : "applied", code, !code && op.action === "task.stop" ? targetRun : undefined, !code && drain);
        addAudit(state, command, { decision: code ? "rejected" : "allowed", code, oldEpoch, newEpoch,
          policyRevision: applyPolicy ? facts.proposedPolicyRevision! : facts.policyRevision, now: this.now() });
        state.commands.push({ command, receipt: result, sequence: state.sequence });
        assertAgentCommandCapacity(state, !code && drain);
        return { control: state, applyPolicy };
      }, intake.proposal);
      for (let attempt = 0; ; attempt++) {
        acceptedNew = false;
        try { transact(); break; }
        catch (error) {
          // Only a pre-commit CAS conflict is re-evaluated, with the original expected epoch/intent.
          if (!(error instanceof AgentBoundaryContractError && error.code === "STALE_REVISION" && attempt < 2)) throw error;
        }
      }
      intake.consumed = true;
      const snapshot = this.authority.commandControlState(), record = snapshot.control.commands.find(row => row.command.commandId === intake.command.commandId)!;
      if (acceptedNew && preparation && record.receipt.status === "accepted") {
        try {
          const grant = this.authority.admit(intake.transport, intake.command);
          this.live.set(preparation.binding.runId, { ...preparation, accepted: snapshot.control.runs.find(run => run.runId === preparation.binding.runId)!, command: intake.command, grant, bound: false });
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
    if (!this.available || !this.authority.commandControlSourceHealthy()) { this.available = false; return fail("AUTHORITY_UNVERIFIED", "control.source"); }
    live.lease.assertCurrent();
    let state: Readonly<AgentCommandState>;
    try { state = this.authority.commandControlState().control; }
    catch (error) { this.available = false; throw error; }
    const record = state.commands.find(row => row.command.commandId === live.command.commandId);
    const run = state.runs.find(row => row.runId === live.binding.runId), agent = state.agents.find(row => row.agentId === live.command.agentId);
    if (!run || !agent || !record || canonical(record.command) !== canonical(live.command)
      || canonical(agentCommandRunIdentity(run)) !== canonical(agentCommandRunIdentity(live.accepted)) || run.commandId !== live.command.commandId || run.issuerId !== this.issuerId || run.leaseAttemptId !== live.lease.attemptId
      || run.bindingDigest !== commandDigest(live.binding) || !workspaceRunBindingsEqual(run.binding, live.binding)) { this.available = false; return fail("AUTHORITY_UNVERIFIED", "control.run"); }
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
  private currentReceipt(command: AgentBoundaryCommand, original: AgentBoundaryReceipt, state: AgentCommandState): AgentBoundaryReceipt {
    const operation = command.operation;
    const found = operation.action === "task.dispatch" ? state.runs.find(run => run.commandId === command.commandId)
      : operation.action === "task.stop" ? state.runs.find(run => run.runId === operation.runId && run.agentId === command.agentId) : undefined;
    if (!found || original.status === "rejected") return original;
    const run = { ...found }, agent = state.agents.find(row => row.agentId === command.agentId), live = this.live.get(run.runId);
    let started = false;
    if (live?.permit && !run.drainProofRef && run.effect !== "unknown") {
      try {
        const facts = workspaceRunEffectFacts(live.permit); started = facts.started;
        if (facts.effects.some(effect => effect.state === "unknown") || facts.operations?.some(row => row.outcome === "error" || row.outcome === "cancelled")) run.effect = "unknown";
      } catch { if (run.effect !== "none") run.effect = "unknown"; }
    }
    const blocked = Boolean(run.hold || agent?.hold || agent?.dismissed || agent?.epoch !== run.agentControlEpoch);
    const phase = run.drainProofRef ? "drained" : !live || !this.available || !this.authority.commandControlSourceHealthy() || run.state === "unknown" ? "unknown" : blocked ? "draining" : started || run.state === "running" ? "applying" : "accepted";
    return receipt(command, run.hold ? run.epoch : agent?.epoch ?? run.epoch, run.hold?.holdId ?? agent?.hold?.holdId ?? null, phase,
      phase === "unknown" && run.effect !== "unknown" ? "AUTHORITY_UNVERIFIED" : null, run, blocked);
  }
  /** Called only after the real opaque permit exists, before any model/tool call. */
  attachRuntime(runId: string, permit: WorkspaceRunPermit): void {
    const live = this.live.get(runId); if (!live || !live.bound || live.permit) return fail("AUTHORITY_UNVERIFIED", "control.runtime");
    const facts = workspaceRunEffectFacts(permit);
    if (!workspaceRunBindingsEqual(facts.binding, live.binding) || facts.attemptId !== live.lease.attemptId || facts.started || facts.modelCalls || facts.toolCalls) return fail("CONTEXT_MISMATCH", "control.runtime");
    this.assertRunCurrent(live);
    const snapshot = this.authority.commandControlState();
    live.permit = permit;
    this.authority.observeCommandControl(snapshot.revision, state => {
      const run = state.runs.find(run => run.runId === runId)!;
      run.state = "bound"; run.effect = "accepted"; run.effectId = `work_${runId}`;
      addAudit(state, live.command, { action: "runtime.bound", decision: "observed", oldEpoch: run.epoch, newEpoch: run.epoch, policyRevision: run.policyRevision, now: this.now() });
      const record = state.commands.find(record => record.command.commandId === live.command.commandId)!;
      record.receipt = this.currentReceipt(record.command, record.receipt, state);
      assertAgentCommandCapacity(state); return state;
    });
  }
  /** The proof is minted only after all actual Promises/native teardown and the physical lease drain. */
  observeDrained(proof: unknown): void {
    const facts = workspaceRunDrainFacts(proof), live = this.live.get(facts.binding.runId);
    if (live?.permit) {
      assertWorkspaceRunDrainOwner(proof, live.permit);
      if (facts.attemptId !== live.lease.attemptId || !workspaceRunBindingsEqual(facts.binding, live.binding)) return fail("AUTHORITY_UNVERIFIED", "control.drainProof");
      this.pendingDrainProofs.set(facts.binding.runId, proof);
    }
    let before: ReturnType<WorkspaceAgentBoundaryAuthority["commandControlState"]>;
    try { before = this.authority.commandControlState(); } catch (error) { this.available = false; throw error; }
    const prior = before.control.runs.find(run => run.runId === facts.binding.runId);
    if (prior?.drainProofRef === facts.proofRef) { this.pendingDrainProofs.delete(facts.binding.runId); this.live.delete(facts.binding.runId); return; }
    if (!live || !live.permit || !prior || prior.issuerId !== this.issuerId || facts.attemptId !== prior.leaseAttemptId
      || !workspaceRunBindingsEqual(facts.binding, prior.binding)) return fail("AUTHORITY_UNVERIFIED", "control.drainProof");
    try { this.authority.observeCommandControl(before.revision, state => {
      const run = state.runs.find(run => run.runId === facts.binding.runId)!;
      run.state = "drained"; run.drainProofRef = facts.proofRef;
      const unknown = run.effect === "unknown" || facts.effects.some(effect => effect.state !== "completed") || facts.operations === null
        || facts.operations.some(row => row.outcome !== "completed");
      if (run.effect !== "none") run.effect = unknown ? "unknown" : "completed";
      addAudit(state, live.command, { action: "runtime.drained", decision: "observed", code: unknown ? "EFFECT_OUTCOME_UNKNOWN" : null,
        oldEpoch: run.epoch, newEpoch: run.epoch, policyRevision: run.policyRevision, now: this.now() });
      for (const record of state.commands) if (record.command.commandId === live.command.commandId
        || record.command.operation.action === "task.stop" && record.command.operation.runId === run.runId) {
        record.receipt = this.currentReceipt(record.command, record.receipt, state);
      }
      assertAgentCommandCapacity(state, true); return state;
    });
    } catch (error) { this.available = false; throw error; }
    this.pendingDrainProofs.delete(facts.binding.runId);
    this.live.delete(facts.binding.runId);
  }
  /** Explicit owner reconciliation retries only publication of retained genuine proofs, never work. */
  reconcileDrainObservations(transport: Intake["transport"], agentId: string) {
    this.authority.commandControlForReader(transport, agentId);
    for (const live of this.live.values()) if (live.command.agentId === agentId && live.permit) {
      try { this.pendingDrainProofs.set(live.binding.runId, workspaceRunDrainProof(live.permit)); } catch { /* Not physically drained; no substitute proof. */ }
    }
    for (const proof of [...this.pendingDrainProofs.values()]) if (workspaceRunDrainFacts(proof).binding.agent.agentId === agentId) this.observeDrained(proof);
    return this.inspect(transport, agentId);
  }
  /** A consumer acknowledges stable event IDs after persisting its projection; this changes no control/effect fact. */
  acknowledgeAudit(transport: Intake["transport"], agentId: string, eventIds: unknown) {
    const before = this.authority.commandControlForReader(transport, agentId);
    if (!Array.isArray(eventIds) || eventIds.length > 64 || eventIds.some(id => !commandId(id)) || new Set(eventIds).size !== eventIds.length) return fail("INVALID_DOCUMENT", "control.auditAck");
    const selected = eventIds.map(id => before.control.audit.find(row => row.eventId === id && row.agentId === agentId));
    if (selected.some(row => !row)) return fail("AUTHORIZATION_DENIED", "control.auditAck");
    if (selected.some(row => !row!.acknowledged)) this.authority.observeCommandControl(before.revision, state => {
      this.authority.commandControlForReader(transport, agentId);
      for (const row of state.audit) if (eventIds.includes(row.eventId) && row.agentId === agentId) row.acknowledged = true;
      return state;
    });
    return this.audit(transport, agentId).filter(row => eventIds.includes(row.eventId));
  }
  runForIntake(handle: AgentCommandIntake) {
    const intake = intakes.get(handle); if (!intake || intake.owner !== this) return fail("AUTHORITY_UNVERIFIED", "control.intake");
    return this.authority.commandControlState().control.runs.find(run => run.commandId === intake.command.commandId);
  }
  readReceipt(transport: Intake["transport"], agentId: string, id: string): AgentBoundaryReceipt {
    if (!commandId(id)) return fail("INVALID_DOCUMENT");
    const snapshot = this.authority.commandControlForReader(transport, agentId), row = snapshot.control.commands.find(row => row.command.commandId === id && row.command.agentId === agentId);
    if (!row) return fail("AUTHORIZATION_DENIED", "control.receipt"); return this.currentReceipt(row.command, row.receipt, snapshot.control);
  }
  inspect(transport: Intake["transport"], agentId: string) {
    const { control } = this.authority.commandControlForReader(transport, agentId), agent = control.agents.find(row => row.agentId === agentId);
    return deepFreeze({ sourceAvailableHere: this.available && this.authority.commandControlSourceHealthy(), pendingDrainObservations: this.pendingDrainProofs.size, agent: agent ?? { agentId, epoch: 0, hold: null, dismissed: false },
      runs: control.runs.filter(run => run.agentId === agentId).map(run => ({ runId: run.runId, taskId: run.taskId, commandId: run.commandId,
        claimRevision: run.claimRevision, epoch: run.epoch, state: run.state, effect: run.effect, controlledHere: this.live.has(run.runId), hold: run.hold, drainProofRef: run.drainProofRef,
        recovery: run.effect === "unknown" || !run.drainProofRef && !this.live.has(run.runId) || ["unknown", "draining"].includes(run.state) ? ["query_original", "request_stop", "await_physical_drain"] : [] })) });
  }
  audit(transport: Intake["transport"], agentId: string) {
    return this.authority.commandControlForReader(transport, agentId).control.audit.filter(row => row.agentId === agentId);
  }
}
