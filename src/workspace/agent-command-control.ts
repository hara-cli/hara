import type { AgentRoutingClaim } from "./agent-boundary-authority.js";
import { workspaceRunDrainProof, assertWorkspaceRunDrainOwner, workspaceRunEffectFacts, workspaceRunDrainFacts, workspaceRunQuiescenceFacts, assertWorkspaceRunQuiescenceOwner, type WorkspaceRunPermit } from "./execution.js";
// C3 trusted Host composition. There is no default issuer and no renderer callback/approved boolean.
import { randomUUID } from "node:crypto";
import { AGENT_BOUNDARY_ERRORS, AgentBoundaryContractError, assertAgentBoundaryContext, parseAgentBoundaryDocument,
  type AgentBoundaryCommand, type AgentBoundaryErrorCode, type AgentBoundaryReceipt } from "./agent-boundaries-contract.js";
import { WorkspaceAgentBoundaryAuthority, type AgentCommandGrant, type AgentCommandMutation } from "./agent-boundary-authority.js";
import { assertAgentBoundaryRuntimeSupported, type AgentBoundaryControlSource } from "./agent-boundary-execution.js";
import { agentCommandMessageDigest, agentPolicyProposalDigest, agentCommandRunIdentity, agentCommandTargetEpoch, assertAgentCommandCapacity, commandDigest, commandId, nextCommandEpoch,
  type AgentCommandAudit, type AgentCommandControl, type AgentCommandHold, type AgentCommandRun, type AgentCommandState } from "./agent-command-state.js";
import { canonical, deepFreeze, messageBody, plain, UUID } from "./local-state.js";
import { captureWorkspaceProjectIdentity, freezeWorkspaceRunBinding, workspaceRunBindingsEqual, type WorkspaceRunBinding } from "./run-binding.js";
import { WorkspaceSessionLease } from "./session-lease.js";
import { newAgentLifecycleRun, parseAgentLifecycleRecovery, type AgentLifecycleOperation, type AgentLifecycleState, type AgentLifecycleRun, type AgentLifecycleRecoveryV1, type AgentLifecycleProjectionV1 } from "./agent-lifecycle-state.js";

const restrictive = (action: string) => ["task.stop", "agent.pause", "agent.dismiss"].includes(action);
const fail = (code: AgentBoundaryErrorCode, field = "control.authority"): never => { throw new AgentBoundaryContractError(code, field); };
export { agentCommandMessageDigest } from "./agent-command-state.js";
/** Private authenticated read projection, NOT a portable C0 receipt or an execution permission. */
export type AgentCommandReceiptLookup = Readonly<{
  schemaVersion: 1; kind: "command-receipt-lookup"; context: AgentBoundaryCommand["context"];
  agentId: string; commandId: string; observedAt: string;
} & ({ state: "seen"; receipt: AgentBoundaryReceipt } | { state: "not_seen"; receipt: null })>;
declare const intakeBrand: unique symbol;
export interface AgentCommandIntake { readonly [intakeBrand]: true }
declare const preparationBrand: unique symbol;
export interface AgentCommandRunPreparation { readonly [preparationBrand]: true }
interface Intake { owner: WorkspaceAgentCommandControl; transport: Parameters<WorkspaceAgentBoundaryAuthority["admit"]>[0]; command: AgentBoundaryCommand; proposal?: unknown; recovery?: AgentLifecycleRecoveryV1; routing?: AgentRoutingClaim; routingChannelId?: string; consumed: boolean }
interface Preparation { intake: AgentCommandIntake; binding: Readonly<WorkspaceRunBinding>; lease: WorkspaceSessionLease; requestId: string }
interface LiveRun extends Preparation { accepted: Readonly<AgentCommandRun>; command: AgentBoundaryCommand; grant: AgentCommandGrant; bound: boolean; permit?: WorkspaceRunPermit }
const intakes = new WeakMap<object, Intake>(), preparations = new WeakMap<object, Preparation>();
declare const claimProjectionBrand: unique symbol;
export interface AgentLifecycleClaimProjection { readonly [claimProjectionBrand]: true }
interface ClaimProjectionFacts {
  scope: AgentBoundaryCommand["context"]["scope"]; resourceBinding: AgentBoundaryCommand["context"]["resourceBinding"];
  agentId: string; taskId: string; sessionId: string; previousRunId: string; runId: string; claimRevision: number; requestId: string;
}
const claimProjections = new WeakMap<object, { facts: Readonly<ClaimProjectionFacts>; assertCurrent(): void }>();
/** Observation/publication only. The handle cannot execute, clear an ID or reset an arbitrary task. */
export function agentLifecycleClaimProjectionFacts(handle: unknown) {
  const row = handle && typeof handle === "object" ? claimProjections.get(handle) : undefined;
  if (!row) return fail("AUTHORITY_UNVERIFIED", "lifecycle.claimProjection"); row.assertCurrent(); return row.facts;
}
export function agentCommandIntakeFacts(handle: unknown, owner?: WorkspaceAgentCommandControl) {
  const state = handle && typeof handle === "object" ? intakes.get(handle) : undefined;
  if (!state || state.consumed || owner && state.owner !== owner) return fail("AUTHORITY_UNVERIFIED", "control.intake");
  return deepFreeze({ command: state.command, workspaceId: state.command.context.scope.workspaceId, ...(state.recovery ? { recovery: state.recovery } : {}), ...(state.routingChannelId ? { routingChannelId: state.routingChannelId } : {}) });
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
  private readonly pendingQuiescenceProofs = new Map<string, unknown>();
  private readonly preparedRuns = new Map<string, AgentCommandRunPreparation>();
  private readonly abandoning = new Set<string>();
  private readonly issuerId = randomUUID();
  constructor(private readonly authority: WorkspaceAgentBoundaryAuthority, private readonly now: () => number = Date.now) {}
  initialize(transport: Intake["transport"]) { return this.authority.initializeCommandControl(transport); }
  initializeLifecycle(transport: Intake["transport"]) { return this.authority.initializeAgentLifecycle(transport); }
  private intake(handle: unknown): Intake {
    const state = handle && typeof handle === "object" ? intakes.get(handle) : undefined;
    if (!state || state.owner !== this || state.consumed || !this.available && !restrictive(state.command.operation.action)) return fail("AUTHORITY_UNVERIFIED", "control.intake"); return state;
  }
  begin(transport: Intake["transport"], raw: unknown, input: { message?: string; proposal?: unknown; routing?: AgentRoutingClaim } = {}): { receipt: AgentBoundaryReceipt } | { intake: AgentCommandIntake } {
    const parsed = parseAgentBoundaryDocument(raw);
    if (parsed.kind !== "command") return fail("INVALID_DOCUMENT");
    const snapshot = this.authority.commandControlForReader(transport, parsed.agentId);
    assertAgentBoundaryContext(parsed, snapshot.context);
    if (this.authority.commandLifecycleConfigured() && !snapshot.lifecycle) return fail("AUTHORITY_UNVERIFIED", "lifecycle.bootstrap");
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
    if (snapshot.lifecycle?.retiredCommands.some(row => row.commandId === parsed.commandId)) {
      const archived = this.authority.lifecycleHistoricalCommand(snapshot.lifecycle, parsed.commandId);
      if (canonical(archived.record.command) !== canonical(parsed)) return fail("COMMAND_ID_CONFLICT", "control.command");
      const op = parsed.operation;
      if (input.message !== undefined && (op.action !== "task.dispatch" || !messageBody(input.message)
        || agentCommandMessageDigest(op.conversationId, input.message) !== op.messageDigest)) return fail("COMMAND_ID_CONFLICT", "control.message");
      if (input.proposal !== undefined && (op.action !== "duty.update" && op.action !== "boundary.update"
        || agentPolicyProposalDigest(input.proposal) !== (op.action === "duty.update" ? op.proposedDutyDigest : op.proposedBoundaryDigest))) return fail("COMMAND_ID_CONFLICT", "control.proposal");
      return { receipt: this.currentReceipt(parsed, archived.record.receipt, archived.control, archived.lifecycle) };
    }
    if (!this.authority.commandControlSourceHealthy()) this.available = false;
    if (!this.available && !restrictive(parsed.operation.action)) return fail("AUTHORITY_UNVERIFIED", "control.source");
    const command = this.authority.authenticateCommandIntent(transport, parsed);
    if (!restrictive(command.operation.action)) this.authority.assertLifecycleHistory();
    if (command.operation.action === "task.dispatch") {
      if (!messageBody(input.message) || agentCommandMessageDigest(command.operation.conversationId, input.message) !== command.operation.messageDigest) return fail("AUTHORITY_UNVERIFIED", "control.message");
    } else if (input.message !== undefined) return fail("INVALID_DOCUMENT", "control.message");
    this.authority.assertRoutingClaim(transport, input.routing, command);
    const handle = Object.freeze({}) as AgentCommandIntake;
    intakes.set(handle, { owner: this, transport, command, ...(input.proposal !== undefined ? { proposal: structuredClone(input.proposal) } : {}), ...(input.routing ? { routing: input.routing, routingChannelId: this.authority.routingClaimChannel(input.routing) } : {}), consumed: false });
    return { intake: handle };
  }
  private previousLifecycleRun(control: AgentCommandState, lifecycle: AgentLifecycleState, runId: string): { run: AgentCommandRun; execution: AgentLifecycleRun } {
    const run = control.runs.find(row => row.runId === runId), execution = lifecycle.executions.find(row => row.runId === runId);
    if (run && execution) return { run, execution };
    if (lifecycle.retiredRuns.some(row => row.runId === runId)) return this.authority.lifecycleHistoricalRun(lifecycle, runId);
    return fail("AUTHORIZATION_DENIED", "lifecycle.recoveryTarget");
  }
  private recoveryAnchor(control: AgentCommandState, lifecycle: AgentLifecycleState | undefined, recovery: AgentLifecycleRecoveryV1,
    rights: { manage: boolean; invoke: boolean; nodeUse: boolean } | null) {
    if (!lifecycle) return fail("AUTHORITY_UNVERIFIED", "lifecycle.recovery");
    if (!rights?.manage || !rights.invoke || !rights.nodeUse) return fail("AUTHORIZATION_DENIED", "lifecycle.recovery");
    const prior = this.previousLifecycleRun(control, lifecycle, recovery.previousRunId);
    if (prior.run.agentId !== recovery.agentId || prior.run.taskId !== recovery.taskId || prior.run.claimRevision !== recovery.expectedClaimRevision
      || prior.execution.phase !== "aborted_before_execution" || !prior.execution.terminal || !prior.execution.leaseReleased || prior.run.effect !== "none"
      || commandDigest(prior.execution.terminal) !== recovery.proofDigest) return fail("CONTROL_HELD", "lifecycle.recoveryProof");
    const latest = Math.max(0, ...control.runs.filter(row => row.agentId === recovery.agentId && row.taskId === recovery.taskId).map(row => row.claimRevision),
      ...lifecycle.retiredRuns.filter(row => row.agentId === recovery.agentId && row.taskId === recovery.taskId).map(row => row.claimRevision));
    if (latest !== recovery.expectedClaimRevision) return fail("STALE_REVISION", "lifecycle.claim");
    if (latest >= Number.MAX_SAFE_INTEGER) return fail("COUNTER_EXHAUSTED", "lifecycle.claim");
    return prior;
  }
  /** Proposed private recovery contract. A new authenticated intent, not an automatic task retry. */
  beginRecovery(transport: Intake["transport"], rawRecovery: unknown, rawCommand: unknown, input: { message: string }) {
    const recovery = parseAgentLifecycleRecovery(rawRecovery), command = parseAgentBoundaryDocument(rawCommand);
    if (command.kind !== "command" || command.operation.action !== "task.dispatch" || command.agentId !== recovery.agentId
      || command.commandId !== recovery.commandId || command.rootRequestId !== recovery.rootRequestId || command.operation.taskId !== recovery.taskId) return fail("CONTEXT_MISMATCH", "lifecycle.recovery");
    const snapshot = this.authority.commandControlForReader(transport, recovery.agentId), lifecycle = snapshot.lifecycle;
    if (!lifecycle) return fail("AUTHORITY_UNVERIFIED", "lifecycle.bootstrap");
    const digest = commandDigest(recovery), existing = lifecycle.executions.find(row => row.recovery?.operationId === recovery.operationId);
    if (existing) {
      if (existing.commandId !== command.commandId || existing.recovery?.requestDigest !== digest) return fail("COMMAND_ID_CONFLICT", "lifecycle.recovery");
      return this.begin(transport, command, input); // Original acceptance only, even after expiry/reconnect.
    }
    const retired = lifecycle.retiredRuns.find(row => row.recoveryOperationId === recovery.operationId);
    if (retired) {
      const historical = this.authority.lifecycleHistoricalRun(lifecycle, retired.runId);
      if (historical.execution.commandId !== command.commandId || historical.execution.recovery?.requestDigest !== digest) return fail("COMMAND_ID_CONFLICT", "lifecycle.recovery");
      return this.begin(transport, command, input);
    }
    this.recoveryAnchor(snapshot.control, lifecycle, recovery, this.authority.lifecycleRights(transport, recovery.agentId));
    const begun = this.begin(transport, command, input);
    if ("receipt" in begun) return fail("COMMAND_ID_CONFLICT", "lifecycle.recovery");
    intakes.get(begun.intake)!.recovery = deepFreeze(recovery); return begun;
  }
  draftRecovery(transport: Intake["transport"], agentId: string, input: {
    operationId: string; previousRunId: string; expectedClaimRevision: number; commandId: string; rootRequestId: string; message: string; lifetimeMs: number;
  }) {
    const keys = ["operationId", "previousRunId", "expectedClaimRevision", "commandId", "rootRequestId", "message", "lifetimeMs"];
    if (!plain(input)) return fail("INVALID_DOCUMENT", "lifecycle.recoveryDraft");
    const descriptors = Object.getOwnPropertyDescriptors(input), own = Reflect.ownKeys(descriptors);
    if (own.length !== keys.length || own.some(key => typeof key !== "string" || !keys.includes(key)
      || !descriptors[key]!.enumerable || !Object.hasOwn(descriptors[key]!, "value"))) return fail("INVALID_DOCUMENT", "lifecycle.recoveryDraft");
    const snapshot = this.authority.commandControlForReader(transport, agentId), lifecycle = snapshot.lifecycle;
    if (!lifecycle || !messageBody(input.message)) return fail("INVALID_DOCUMENT", "lifecycle.recovery");
    const prior = this.previousLifecycleRun(snapshot.control, lifecycle, input.previousRunId);
    if (!prior.execution.terminal) return fail("CONTROL_HELD", "lifecycle.recoveryProof");
    const recovery = parseAgentLifecycleRecovery({ schemaVersion: 1, kind: "agent-lifecycle-recovery", operationId: input.operationId,
      agentId, taskId: prior.run.taskId, previousRunId: prior.run.runId, expectedClaimRevision: input.expectedClaimRevision,
      proofDigest: commandDigest(prior.execution.terminal), commandId: input.commandId, rootRequestId: input.rootRequestId });
    this.recoveryAnchor(snapshot.control, lifecycle, recovery, this.authority.lifecycleRights(transport, agentId));
    const command = this.authority.draft(transport, agentId, { commandId: input.commandId, rootRequestId: input.rootRequestId, lifetimeMs: input.lifetimeMs,
      operation: { action: "task.dispatch", taskId: prior.run.taskId, conversationId: prior.run.binding.sessionId,
        messageDigest: agentCommandMessageDigest(prior.run.binding.sessionId, input.message) } });
    return deepFreeze({ recovery, command });
  }
  private conversationBlocked(control: AgentCommandState, lifecycle: AgentLifecycleState | undefined, agentId: string, sessionId: string): boolean {
    if (!lifecycle) return false;
    if (control.runs.some(run => run.agentId === agentId && run.binding.sessionId === sessionId
      && !lifecycle.executions.find(row => row.runId === run.runId)?.leaseReleased)) return true;
    return lifecycle.retiredRuns.filter(row => row.agentId === agentId && !row.leaseReleased).some(row => this.authority.lifecycleHistoricalRun(lifecycle, row.runId).run.binding.sessionId === sessionId);
  }
  assertConversationStart(handle: AgentCommandIntake): void {
    const intake = this.intake(handle), op = intake.command.operation, snapshot = this.authority.commandControlState();
    if (op.action !== "task.dispatch") return fail("INVALID_DOCUMENT");
    if (this.conversationBlocked(snapshot.control, snapshot.lifecycle, intake.command.agentId, op.conversationId)) return fail("CONTROL_HELD", "lifecycle.conversation");
  }
  /** Denials are committed before Host opens private model context or prepares an execution. */
  rejectBlocked(handle: AgentCommandIntake): AgentBoundaryReceipt | null {
    const intake = this.intake(handle), { command, transport } = intake, operation = command.operation;
    let grant: AgentCommandGrant | undefined;
    try {
      this.authority.assertRoutingClaim(transport, intake.routing, command);
      grant = this.authority.admit(transport, command);
      const snapshot = this.authority.commandControlState(), { control, lifecycle } = snapshot;
      if (intake.recovery) this.recoveryAnchor(control, lifecycle, intake.recovery, this.authority.lifecycleRights(transport, command.agentId));
      const agent = control.agents.find(row => row.agentId === command.agentId);
      const blockedDispatch = operation.action === "task.dispatch" && (agent?.hold || agent?.dismissed
        || control.runs.some(run => run.rootRequestId === command.rootRequestId || !intake.recovery && run.taskId === operation.taskId)
        || lifecycle?.retiredCommands.some(row => row.rootRequestId === command.rootRequestId)
        || !intake.recovery && lifecycle?.retiredRuns.some(run => run.taskId === operation.taskId));
      if (command.expected.controlEpoch !== agentCommandTargetEpoch(control, command) || blockedDispatch
        || operation.action === "task.dispatch" && this.conversationBlocked(control, lifecycle, command.agentId, operation.conversationId)) return this.accept(handle);
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
        const agent = agentControl(state, command.agentId), lifecycle = facts.lifecycle;
        let code = facts.authorizationError, oldEpoch = agent.epoch, targetRun: AgentCommandRun | undefined, applyPolicy = false;
        if (op.action === "task.stop") targetRun = state.runs.find(run => run.runId === op.runId && run.agentId === command.agentId && run.taskId === op.taskId && run.claimRevision === op.claimRevision);
        if (!code) {
          try { oldEpoch = agentCommandTargetEpoch(state, command); }
          catch (error) { code = error instanceof AgentBoundaryContractError ? error.code : "AUTHORITY_UNVERIFIED"; }
        }
        if (!code && command.expected.controlEpoch !== oldEpoch) code = "STALE_REVISION";
        if (!code && op.action === "agent.dismiss" && facts.agentKind === "main") code = "AUTHORIZATION_DENIED";
        if (!code && agent.dismissed && op.action !== "task.stop") code = "CONTROL_HELD";
        if (!code && op.action === "task.dispatch" && agent.hold) code = "CONTROL_HELD";
        if (!code && op.action === "task.dispatch") {
          if (this.conversationBlocked(state, lifecycle, command.agentId, op.conversationId)) code = "CONTROL_HELD";
          let claimRevision = 1;
          if (intake.recovery) {
            try { this.recoveryAnchor(state, lifecycle, intake.recovery, facts.rights); claimRevision = intake.recovery.expectedClaimRevision + 1; }
            catch (error) { code = error instanceof AgentBoundaryContractError ? error.code : "AUTHORITY_UNVERIFIED"; }
          }
          if (!code && (state.runs.some(run => run.rootRequestId === command.rootRequestId || !intake.recovery && run.taskId === op.taskId || preparation && run.runId === preparation.binding.runId)
            || lifecycle?.retiredCommands.some(row => row.rootRequestId === command.rootRequestId || row.commandId === command.commandId)
            || lifecycle?.retiredRuns.some(run => !intake.recovery && run.taskId === op.taskId || preparation && run.runId === preparation.binding.runId)
            || intake.recovery && lifecycle?.executions.some(row => row.recovery?.operationId === intake.recovery!.operationId)
            || intake.recovery && lifecycle?.retiredRuns.some(row => row.recoveryOperationId === intake.recovery!.operationId))) code = "COMMAND_ID_CONFLICT";
          if (!code && !preparation) code = "AUTHORITY_UNVERIFIED";
          if (!code && preparation) {
            this.authority.assertCommandRunBinding(preparation.binding); preparation.lease.assertCurrent();
            const run: AgentCommandRun = { commandId: command.commandId, rootRequestId: command.rootRequestId, agentId: command.agentId, taskId: op.taskId,
              runId: preparation.binding.runId, claimRevision, policyRevision: facts.policyRevision, requestId: preparation.requestId, leaseAttemptId: preparation.lease.attemptId, issuerId: this.issuerId,
              binding: preparation.binding, bindingDigest: commandDigest(preparation.binding), agentControlEpoch: agent.epoch, epoch: agent.epoch,
              hold: null, state: "accepted", effect: "none", effectId: null, drainProofRef: null };
            state.runs.push(run); targetRun = run; acceptedNew = true;
          }
        }
        if (!code && op.action === "agent.resume" && (!agent.hold || agent.hold.holdId !== op.holdId)) code = "STALE_REVISION";
        if (!code && lifecycle && op.action === "agent.resume") {
          const unresolved = state.runs.some(run => run.agentId === command.agentId && !lifecycle.executions.find(row => row.runId === run.runId)?.leaseReleased)
            || lifecycle.retiredRuns.some(run => run.agentId === command.agentId && !run.leaseReleased)
            || lifecycle.operations.some(row => row.agentId === command.agentId && (row.schedules === "pending" || row.targetRunIds.some(id => !row.revokedRunIds.includes(id))));
          if (unresolved) code = "CONTROL_HELD";
        }
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
        if (!code && lifecycle && op.action === "task.dispatch" && targetRun && preparation) {
          lifecycle.executions.push(newAgentLifecycleRun(targetRun, preparation.lease.captureOwner(), result, intake.recovery ? { operationId: intake.recovery.operationId,
            requestDigest: commandDigest(intake.recovery), previousRunId: intake.recovery.previousRunId, proofDigest: intake.recovery.proofDigest } : null));
        }
        if (!code && lifecycle && restrictive(op.action)) {
          const targetRunIds = op.action === "task.stop" ? targetRun ? [targetRun.runId] : [] : state.runs.filter(run => run.agentId === command.agentId).map(run => run.runId);
          lifecycle.operations.push({ commandId: command.commandId, agentId: command.agentId, action: op.action as AgentLifecycleOperation["action"],
            epoch: newEpoch, holdId: holdId!, targetRunIds, notifiedRunIds: [], revokedRunIds: [],
            schedules: op.action === "task.stop" ? "none" : "pending", archive: op.action === "agent.dismiss" ? "pending" : "not_requested",
            archiveExpected: op.action === "agent.dismiss" ? facts.agentResource : null, archivedResource: null });
        }
        assertAgentCommandCapacity(state, !code && drain);
        return { control: state, applyPolicy, ...(lifecycle ? { lifecycle } : {}) };
      }, intake.proposal, intake.routing);
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
        this.preparedRuns.set(preparation.binding.runId, prepared!);
        try {
          const grant = this.authority.admit(intake.transport, intake.command);
          this.live.set(preparation.binding.runId, { ...preparation, accepted: snapshot.control.runs.find(run => run.runId === preparation.binding.runId)!, command: intake.command, grant, bound: false });
        } catch (error) {
          if (this.authority.commandLifecycleConfigured()) {
            // Cleanup of the genuine original preparation, never a new dispatch or a counter-based guess.
            try { this.abortBeforeExecution(prepared!, error instanceof AgentBoundaryContractError ? error.code : "AUTHORITY_UNVERIFIED"); } catch { /* Original accepted/UNKNOWN and ownership remain. */ }
            if (!this.authority.commandControlSourceHealthy()) this.available = false;
          } else if (!this.authority.commandControlSourceHealthy() || !(error instanceof AgentBoundaryContractError)) this.available = false;
          // Older acceptances remain unknown; C4 adds only a genuine pre-issuance terminal proof.
        }
      }
      return record.receipt;
    } catch (error) {
      intake.consumed = true;
      if (!this.authority.commandControlSourceHealthy() || !(error instanceof AgentBoundaryContractError)) this.available = false;
      throw error;
    }
  }
  /** Only the original opaque preparation can prove no execution capability was ever issued. */
  abortBeforeExecution(handle: AgentCommandRunPreparation, reason: AgentBoundaryErrorCode = "AUTHORITY_UNVERIFIED") {
    const preparation = preparations.get(handle), intake = preparation && intakes.get(preparation.intake);
    if (!preparation || !intake || intake.owner !== this || !Object.hasOwn(AGENT_BOUNDARY_ERRORS, reason)) return fail("AUTHORITY_UNVERIFIED", "lifecycle.preparation");
    const runId = preparation.binding.runId;
    for (let attempt = 0; ; attempt++) {
      if (!this.authority.commandControlSourceHealthy()) return fail("AUTHORITY_UNVERIFIED", "lifecycle.source");
      const before = this.authority.commandControlState(), run = before.control.runs.find(row => row.runId === runId), row = before.lifecycle?.executions.find(row => row.runId === runId), live = this.live.get(runId);
      if (!run || !row || run.issuerId !== this.issuerId || run.commandId !== intake.command.commandId || run.requestId !== preparation.requestId
        || run.leaseAttemptId !== preparation.lease.attemptId || !workspaceRunBindingsEqual(run.binding, preparation.binding)) return fail("AUTHORITY_UNVERIFIED", "lifecycle.preparation");
      if (row.phase === "aborted_before_execution" && row.terminal) break;
      if (row.phase !== "prepared" || row.issuanceRef || row.quiescence || run.effect !== "none" || !["accepted", "draining"].includes(run.state)
        || live?.bound || live?.permit) return fail("CONTROL_HELD", "lifecycle.alreadyIssued");
      const owner = preparation.lease.captureOwner();
      if (canonical(owner) !== canonical(row.lease)) return fail("AUTHORITY_UNVERIFIED", "lifecycle.preparation");
      this.abandoning.add(runId);
      const terminal = { proofRef: `never_${randomUUID()}`, issuerId: this.issuerId, reason, lease: { ...owner } };
      try {
        this.authority.observeCommandControl(before.revision, (state, lifecycle) => {
          const current = state.runs.find(row => row.runId === runId)!, record = lifecycle?.executions.find(row => row.runId === runId);
          if (!record || record.phase !== "prepared" || record.issuanceRef || current.effect !== "none" || current.issuerId !== this.issuerId) return fail("CONTROL_HELD", "lifecycle.alreadyIssued");
          preparation.lease.assertCurrent(); record.phase = "aborted_before_execution"; record.terminal = terminal;
          if (!current.hold) { current.epoch = nextCommandEpoch(current.epoch); current.hold = { holdId: `hold_${randomUUID()}`, reason: "recovery", sequence: nextCommandEpoch(state.sequence) }; }
          addAudit(state, intake.command, { action: "runtime.aborted", decision: "observed", code: reason, oldEpoch: run.epoch, newEpoch: current.epoch, policyRevision: current.policyRevision, now: this.now() });
          assertAgentCommandCapacity(state, true); return state;
        }); break;
      } catch (error) { if (!(error instanceof AgentBoundaryContractError && error.code === "STALE_REVISION" && attempt < 2)) throw error; }
    }
    const live = this.live.get(runId); if (live) this.authority.retire(live.grant);
    this.live.delete(runId);
    // The durable terminal fact is already published. This genuine captured receipt closes only its original owner.
    preparation.lease.release();
    const before = this.authority.commandControlState();
    if (!before.lifecycle!.executions.find(row => row.runId === runId)!.leaseReleased) this.authority.observeCommandControl(before.revision, (state, lifecycle) => {
      const row = lifecycle!.executions.find(row => row.runId === runId)!;
      if (row.phase !== "aborted_before_execution" || !row.terminal) return fail("AUTHORITY_UNVERIFIED", "lifecycle.release");
      row.leaseReleased = true; return state;
    });
    const row = this.authority.commandControlState().lifecycle!.executions.find(row => row.runId === runId)!;
    return deepFreeze({ runId, claimRevision: row.claimRevision, phase: row.phase, proofDigest: commandDigest(row.terminal), leaseReleased: row.leaseReleased });
  }
  /** Host catch classification. Unreadable state is unknown, never an absent acceptance. */
  settlePreparationFailure(handle: AgentCommandRunPreparation, reason: AgentBoundaryErrorCode = "AUTHORITY_UNVERIFIED") {
    const preparation = preparations.get(handle), intake = preparation && intakes.get(preparation.intake);
    if (!preparation || !intake || intake.owner !== this) return fail("AUTHORITY_UNVERIFIED", "lifecycle.preparation");
    try {
      const snapshot = this.authority.commandControlState(), run = snapshot.control.runs.find(row => row.commandId === intake.command.commandId);
      if (!run) {
        if (snapshot.lifecycle?.retiredCommands.some(row => row.commandId === intake.command.commandId) || !this.authority.commandControlSourceHealthy()) return { acceptance: "unknown" as const };
        return { acceptance: "not_accepted" as const };
      }
      if (run.runId !== preparation.binding.runId || run.issuerId !== this.issuerId || run.leaseAttemptId !== preparation.lease.attemptId
        || !workspaceRunBindingsEqual(run.binding, preparation.binding)) return { acceptance: "accepted" as const, run };
      const execution = snapshot.lifecycle?.executions.find(row => row.runId === run.runId);
      if (execution?.phase === "issued") {
        this.abandoning.add(run.runId);
        // Once issuance crossed its durable barrier, a startup failure is UNKNOWN, not never-executed.
        // This hold is target-local and persists independently of the in-process deny above.
        for (let attempt = 0; ; attempt++) {
          const before = this.authority.commandControlState(), prior = before.control.runs.find(row => row.runId === run.runId)!;
          if (prior.hold?.reason === "recovery" && ["unknown", "drained"].includes(prior.state) && prior.effect === "unknown") break;
          try {
            this.authority.observeCommandControl(before.revision, state => {
              const current = state.runs.find(row => row.runId === run.runId)!;
              if (!current.hold) { current.epoch = nextCommandEpoch(current.epoch); current.hold = { holdId: `hold_${randomUUID()}`, reason: "recovery", sequence: nextCommandEpoch(state.sequence) }; }
              if (current.state !== "drained") current.state = "unknown";
              current.effect = "unknown"; current.effectId ??= `work_${current.runId}`;
              addAudit(state, intake.command, { action: "runtime.unknown", decision: "observed", code: "EFFECT_OUTCOME_UNKNOWN", oldEpoch: run.epoch, newEpoch: current.epoch, policyRevision: current.policyRevision, now: this.now() });
              assertAgentCommandCapacity(state, true); return state;
            }); break;
          } catch (error) { if (!(error instanceof AgentBoundaryContractError && error.code === "STALE_REVISION" && attempt < 2)) break; }
        }
      }
      if (execution && ["prepared", "aborted_before_execution"].includes(execution.phase)) {
        try { this.abortBeforeExecution(handle, reason); } catch { /* Keep the real acceptance and physical owner. */ }
      }
      const after = this.authority.commandControlState(), current = after.lifecycle?.executions.find(row => row.runId === run.runId);
      return { acceptance: "accepted" as const, run, execution: current };
    } catch { return { acceptance: "unknown" as const }; }
  }
  assertPreparedStart(handle: AgentCommandIntake): void {
    const intake = intakes.get(handle); if (!intake || intake.owner !== this) return fail("AUTHORITY_UNVERIFIED", "lifecycle.intake");
    const snapshot = this.authority.commandControlState(); if (!snapshot.lifecycle) return;
    const run = snapshot.control.runs.find(row => row.commandId === intake.command.commandId), execution = snapshot.lifecycle.executions.find(row => row.runId === run?.runId);
    if (!run || execution?.phase !== "prepared" || run.hold || this.abandoning.has(run.runId)) return fail("CONTROL_HELD", "lifecycle.notStarted");
  }
  claimProjection(handle: AgentCommandIntake): AgentLifecycleClaimProjection {
    const intake = intakes.get(handle); if (!intake || intake.owner !== this || !intake.recovery) return fail("AUTHORITY_UNVERIFIED", "lifecycle.claimProjection");
    const snapshot = this.authority.commandControlState(), run = snapshot.control.runs.find(row => row.commandId === intake.command.commandId);
    if (!run) return fail("AUTHORITY_UNVERIFIED", "lifecycle.claimProjection");
    const assertCurrent = () => {
      this.assertPreparedStart(handle);
      const current = this.authority.commandControlState(), execution = current.lifecycle?.executions.find(row => row.runId === run.runId);
      const live = this.live.get(run.runId); if (!live || execution?.recovery?.requestDigest !== commandDigest(intake.recovery)) return fail("AUTHORITY_UNVERIFIED", "lifecycle.claimProjection");
      this.authority.grantFacts(live.grant);
    };
    assertCurrent(); const projection = Object.freeze({}) as AgentLifecycleClaimProjection;
    claimProjections.set(projection, { assertCurrent, facts: deepFreeze({ scope: intake.command.context.scope, resourceBinding: intake.command.context.resourceBinding,
      agentId: run.agentId, taskId: run.taskId, sessionId: run.binding.sessionId, previousRunId: intake.recovery.previousRunId, runId: run.runId, claimRevision: run.claimRevision, requestId: run.requestId }) });
    return projection;
  }
  executionGrant(runId: string): AgentCommandGrant {
    if (this.abandoning.has(runId)) return fail("CONTROL_HELD", "lifecycle.abandoned");
    const live = this.live.get(runId); if (!this.available || !live) return fail("AUTHORITY_UNVERIFIED", "control.run");
    this.assertRunCurrent(live, false);
    const snapshot = this.authority.commandControlState(), execution = snapshot.lifecycle?.executions.find(row => row.runId === runId);
    if (execution?.phase === "prepared") this.authority.observeCommandControl(snapshot.revision, (state, lifecycle) => {
      const row = lifecycle?.executions.find(row => row.runId === runId), run = state.runs.find(run => run.runId === runId);
      if (!row || !run || row.phase !== "prepared" || row.issuanceRef || row.terminal) return fail("CONTROL_HELD", "lifecycle.issuance");
      this.assertRunCurrent(live, false); row.phase = "issued"; row.issuanceRef = `issued_${randomUUID()}`;
      // The immutable lifecycle issuanceRef is itself the durable issuance fact. Do not duplicate
      // it in the bounded C3 outbox and consume the slots reserved for actual closure/UNKNOWN.
      assertAgentCommandCapacity(state); return state;
    });
    this.assertRunCurrent(live); return live.grant;
  }
  private assertRunCurrent(live: LiveRun, requireIssued = true): AgentCommandRun {
    if (!this.available || !this.authority.commandControlSourceHealthy()) { this.available = false; return fail("AUTHORITY_UNVERIFIED", "control.source"); }
    if (this.abandoning.has(live.binding.runId)) return fail("CONTROL_HELD", "lifecycle.abandoned");
    live.lease.assertCurrent();
    let state: Readonly<AgentCommandState>, lifecycle: AgentLifecycleState | undefined;
    try { const snapshot = this.authority.commandControlState(); state = snapshot.control; lifecycle = snapshot.lifecycle; }
    catch (error) { this.available = false; throw error; }
    const record = state.commands.find(row => row.command.commandId === live.command.commandId);
    const run = state.runs.find(row => row.runId === live.binding.runId), agent = state.agents.find(row => row.agentId === live.command.agentId);
    if (!run && lifecycle?.retiredRuns.some(row => row.runId === live.binding.runId)) {
      this.authority.lifecycleHistoricalRun(lifecycle, live.binding.runId); return fail("CONTROL_HELD", "lifecycle.retired");
    }
    if (!run || !agent || !record || canonical(record.command) !== canonical(live.command)
      || canonical(agentCommandRunIdentity(run)) !== canonical(agentCommandRunIdentity(live.accepted)) || run.commandId !== live.command.commandId || run.issuerId !== this.issuerId || run.leaseAttemptId !== live.lease.attemptId
      || run.bindingDigest !== commandDigest(live.binding) || !workspaceRunBindingsEqual(run.binding, live.binding)) { this.available = false; return fail("AUTHORITY_UNVERIFIED", "control.run"); }
    if (lifecycle) {
      const execution = lifecycle.executions.find(row => row.runId === run.runId);
      if (!execution || !(requireIssued ? execution.phase === "issued" : ["prepared", "issued"].includes(execution.phase)) || execution.quiescence || execution.terminal || execution.leaseReleased)
        return fail("CONTROL_HELD", "lifecycle.issuance");
    }
    if (agent.hold || agent.dismissed || run.hold || ["draining", "drained", "unknown"].includes(run.state)) return fail("CONTROL_HELD", "control.hold");
    if (agent.epoch !== run.agentControlEpoch || run.epoch !== live.command.expected.controlEpoch) return fail("STALE_REVISION", "control.epoch");
    return run;
  }
  bind(command: AgentBoundaryCommand, binding: Readonly<WorkspaceRunBinding>) {
    const live = this.live.get(binding.runId);
    if (!live || live.bound || canonical(live.command) !== canonical(command) || !workspaceRunBindingsEqual(live.binding, binding)) return fail("AUTHORITY_UNVERIFIED", "control.binding");
    this.assertRunCurrent(live); live.bound = true;
    return Object.freeze({ commandId: command.commandId, runId: binding.runId, controlEpoch: command.expected.controlEpoch,
      assertCurrent: () => { this.assertRunCurrent(live); }, ...(this.authority.commandControlState().lifecycle ? { prepareQuiescence: (proof: unknown) => this.observeQuiescence(proof) } : {}) });
  }
  private currentReceipt(command: AgentBoundaryCommand, original: AgentBoundaryReceipt, state: AgentCommandState,
    lifecycle = this.authority.commandControlState().lifecycle): AgentBoundaryReceipt {
    const operation = command.operation;
    const found = operation.action === "task.dispatch" ? state.runs.find(run => run.commandId === command.commandId)
      : operation.action === "task.stop" ? state.runs.find(run => run.runId === operation.runId && run.agentId === command.agentId) : undefined;
    if (!found || original.status === "rejected") return original;
    const terminal = lifecycle?.executions.find(row => row.runId === found.runId);
    if (terminal?.phase === "aborted_before_execution") return receipt(command, found.epoch, found.hold?.holdId ?? null, "accepted", null, found);
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
    // Capture genuine runtime ownership even when a concurrent hold will deny admission below.
    // This gives the original Host a safe closer, never permission to start effects.
    live.permit = permit;
    this.assertRunCurrent(live);
    const snapshot = this.authority.commandControlState();
    this.authority.observeCommandControl(snapshot.revision, state => {
      const run = state.runs.find(run => run.runId === runId)!;
      run.state = "bound"; run.effect = "accepted"; run.effectId = `work_${runId}`;
      addAudit(state, live.command, { action: "runtime.bound", decision: "observed", oldEpoch: run.epoch, newEpoch: run.epoch, policyRevision: run.policyRevision, now: this.now() });
      const record = state.commands.find(record => record.command.commandId === live.command.commandId)!;
      record.receipt = this.currentReceipt(record.command, record.receipt, state);
      assertAgentCommandCapacity(state); return state;
    });
  }
  /** This proof is minted by the real retired runtime BEFORE the original physical lease release. */
  observeQuiescence(proof: unknown): void {
    const facts = workspaceRunQuiescenceFacts(proof), live = this.live.get(facts.binding.runId);
    const value = { proofRef: facts.proofRef, drainProofRef: facts.drainProofRef, effectDigest: facts.effectDigest, lease: { ...facts.lease } };
    if (!live?.permit) {
      // A genuine old closer can finish after explicit reconciliation retired its live entry.
      // This is a read-only duplicate of the exact published closure, never a new proof/permit.
      const snapshot = this.authority.commandControlState(), run = snapshot.control.runs.find(row => row.runId === facts.binding.runId);
      const row = snapshot.lifecycle?.executions.find(row => row.runId === facts.binding.runId);
      if (run?.issuerId === this.issuerId && run.state === "drained" && run.drainProofRef === facts.drainProofRef && row?.leaseReleased
        && workspaceRunBindingsEqual(run.binding, facts.binding) && canonical(row.quiescence) === canonical(value)) return;
      return fail("AUTHORITY_UNVERIFIED", "lifecycle.quiescenceOwner");
    }
    assertWorkspaceRunQuiescenceOwner(proof, live.permit);
    if (facts.attemptId !== live.lease.attemptId || !workspaceRunBindingsEqual(facts.binding, live.binding)) return fail("CONTEXT_MISMATCH", "lifecycle.quiescence");
    this.pendingQuiescenceProofs.set(facts.binding.runId, proof);
    for (let attempt = 0; ; attempt++) {
      const before = this.authority.commandControlState(), prior = before.lifecycle?.executions.find(row => row.runId === facts.binding.runId);

      if (!prior || prior.phase !== "issued" || canonical(prior.lease) !== canonical(facts.lease)) return fail("AUTHORITY_UNVERIFIED", "lifecycle.quiescence");
      if (prior.quiescence) { if (canonical(prior.quiescence) !== canonical(value)) return fail("COMMAND_ID_CONFLICT", "lifecycle.quiescence"); break; }
      try {
        this.authority.observeCommandControl(before.revision, (state, lifecycle) => {
          const run = state.runs.find(row => row.runId === facts.binding.runId), row = lifecycle?.executions.find(row => row.runId === facts.binding.runId);
          if (!run || !row || run.issuerId !== this.issuerId || row.quiescence || row.phase !== "issued") return fail("AUTHORITY_UNVERIFIED", "lifecycle.quiescence");
          row.quiescence = value; if (run.state !== "unknown") run.state = "draining";
          addAudit(state, live.command, { action: "runtime.quiescent", decision: "observed", oldEpoch: run.epoch, newEpoch: run.epoch, policyRevision: run.policyRevision, now: this.now() });
          assertAgentCommandCapacity(state, true); return state;
        }); break;
      } catch (error) { if (!(error instanceof AgentBoundaryContractError && error.code === "STALE_REVISION" && attempt < 2)) throw error; }
    }
    this.pendingQuiescenceProofs.delete(facts.binding.runId);
  }
  /** Per-owner notification facts, only for this exact genuine runtime. Not a stop/drain proof. */
  observeLifecycleNotification(commandId: string, runId: string, permit: WorkspaceRunPermit): void {
    const live = this.live.get(runId);
    if (!live || live.permit !== permit || !workspaceRunBindingsEqual(workspaceRunEffectFacts(permit).binding, live.binding)) return fail("AUTHORITY_UNVERIFIED", "lifecycle.notification");
    const before = this.authority.commandControlState(), operation = before.lifecycle?.operations.find(row => row.commandId === commandId);
    if (!operation || !operation.targetRunIds.includes(runId) || operation.agentId !== live.command.agentId) return fail("AUTHORIZATION_DENIED", "lifecycle.notification");
    if (!operation.notifiedRunIds.includes(runId)) this.authority.observeCommandControl(before.revision, (state, lifecycle) => {
      lifecycle!.operations.find(row => row.commandId === commandId)!.notifiedRunIds.push(runId); return state;
    });
  }
  /** Trusted local owner observer. It reads persisted targets; no caller supplies an allow decision. */
  lifecycleOperations() { return this.authority.commandControlState().lifecycle?.operations ?? []; }
  reconcileLifecycleOperation(commandId: string) {
    const operation = this.authority.reconcileLifecycleOperation(commandId);
    for (const id of operation.revokedRunIds) { const run = this.live.get(id); if (run) this.authority.retire(run.grant); }
    return operation;
  }
  /** Explicit publication/physical closure of positive persisted evidence; never creates work. */
  reconcileLifecycleLease(transport: Intake["transport"], runId: string) {
    const retained = this.pendingQuiescenceProofs.get(runId); if (retained) this.observeQuiescence(retained);
    WorkspaceSessionLease.reconcileQuiescentRelease(this.authorityStorage(), this.authority, transport, runId);
    const before = this.authority.commandControlState();
    this.authority.observeCommandControl(before.revision, (state, lifecycle) => {
      const row = lifecycle?.executions.find(row => row.runId === runId), run = state.runs.find(row => row.runId === runId);
      if (!row || !run || !row.quiescence && !row.terminal) return fail("CONTROL_HELD", "lifecycle.release");
      row.leaseReleased = true;
      if (row.quiescence) { run.state = "drained"; run.drainProofRef = row.quiescence.drainProofRef; if (run.effect !== "none") run.effect = "unknown"; }
      return state;
    });
    const live = this.live.get(runId); if (live) this.authority.retire(live.grant);
    this.live.delete(runId); return this.authority.commandControlState();
  }
  private authorityStorage() { return this.authority.lifecycleStorage(); }
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
    try { this.authority.observeCommandControl(before.revision, (state, lifecycle) => {
      const run = state.runs.find(run => run.runId === facts.binding.runId)!;
      if (lifecycle) {
        const row = lifecycle.executions.find(row => row.runId === run.runId);
        if (!row?.quiescence || row.quiescence.drainProofRef !== facts.proofRef) return fail("AUTHORITY_UNVERIFIED", "lifecycle.drain");
        row.leaseReleased = true;
      }
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
    } catch (error) {
      // A competing observation can win the CAS after the genuine physical drain. Keep the
      // original proof for publication retry; a normal rejection must not poison sibling runs.
      if (!this.authority.commandControlSourceHealthy() || !(error instanceof AgentBoundaryContractError)) this.available = false;
      throw error;
    }
    this.authority.retire(live.grant);
    this.pendingDrainProofs.delete(facts.binding.runId);
    this.live.delete(facts.binding.runId);
  }
  reconcileLifecycleObservations(transport: Intake["transport"], agentId: string) {
    this.authority.assertLifecycleManager(transport, agentId);
    const snapshot = this.authority.commandControlState();
    for (const run of snapshot.control.runs.filter(run => run.agentId === agentId)) {
      const preparation = this.preparedRuns.get(run.runId);
      if (preparation && this.abandoning.has(run.runId)) { try { this.abortBeforeExecution(preparation); } catch { /* Still pending; no business retry. */ } }
      const row = this.authority.commandControlState().lifecycle?.executions.find(row => row.runId === run.runId);
      if (row && !row.leaseReleased && (row.quiescence || row.terminal || this.pendingQuiescenceProofs.has(run.runId))) {
        try { this.reconcileLifecycleLease(transport, run.runId); } catch { /* Exact owner/proof/permission failure stays pending. */ }
      }
    }
    return this.lifecycleProjection(transport, agentId);
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
  /** Absence is explicit only for a healthy, complete ledger and an authenticated reader.
   * The early timestamp cannot turn a pre-expiry snapshot into a post-expiry proof.
   * Admission revalidates notAfter inside CAS, including an intake begun before this read. */
  lookupReceipt(transport: Intake["transport"], agentId: string, id: string): AgentCommandReceiptLookup {
    if (!commandId(id)) return fail("INVALID_DOCUMENT");
    const { observedAt, snapshot } = this.authority.commandReceiptObservation(transport, agentId);
    if (!this.available || !this.authority.commandControlSourceHealthy()) return fail("AUTHORITY_UNVERIFIED", "control.receiptSource");
    const live = snapshot.control.commands.find(row => row.command.commandId === id);
    const retired = snapshot.lifecycle?.retiredCommands.find(row => row.commandId === id);
    if (live && live.command.agentId !== agentId || retired && retired.agentId !== agentId) return fail("AUTHORIZATION_DENIED", "control.receipt");
    const base = { schemaVersion: 1 as const, kind: "command-receipt-lookup" as const, context: snapshot.context, agentId, commandId: id, observedAt };
    return live || retired ? deepFreeze({ ...base, state: "seen" as const, receipt: this.readReceipt(transport, agentId, id) })
      : deepFreeze({ ...base, state: "not_seen" as const, receipt: null });
  }
  readReceipt(transport: Intake["transport"], agentId: string, id: string): AgentBoundaryReceipt {
    if (!commandId(id)) return fail("INVALID_DOCUMENT");
    const snapshot = this.authority.commandControlForReader(transport, agentId), row = snapshot.control.commands.find(row => row.command.commandId === id && row.command.agentId === agentId);
    if (!row) {
      if (!snapshot.lifecycle?.retiredCommands.some(row => row.commandId === id && row.agentId === agentId)) return fail("AUTHORIZATION_DENIED", "control.receipt");
      const archived = this.authority.lifecycleHistoricalCommand(snapshot.lifecycle, id);
      return this.currentReceipt(archived.record.command, archived.record.receipt, archived.control, archived.lifecycle);
    }
    return this.currentReceipt(row.command, row.receipt, snapshot.control);
  }
  archiveLifecycleHistory(transport: Intake["transport"], agentId: string, maximum = 8) { return this.authority.archiveClosedLifecycle(transport, agentId, maximum); }
  lifecycleProjection(transport: Intake["transport"], agentId: string): Readonly<AgentLifecycleProjectionV1> {
    const snapshot = this.authority.commandControlForReader(transport, agentId), lifecycle = snapshot.lifecycle;
    if (!lifecycle) return fail("AUTHORITY_UNVERIFIED", "lifecycle.bootstrap");
    const agent = snapshot.control.agents.find(row => row.agentId === agentId);
    let permitted = false, management = false;
    try { const rights = this.authority.lifecycleRights(transport, agentId); permitted = rights.invoke && rights.nodeUse; management = rights.manage; } catch { /* Metadata never supplies a missing allow. */ }
    const canClaim = (run: AgentCommandRun, execution: AgentLifecycleRun) => permitted && management && !agent?.hold && !agent?.dismissed && this.available
      && this.authority.commandControlSourceHealthy() && execution.terminal !== null && execution.leaseReleased && run.effect === "none"
      && run.claimRevision === Math.max(...snapshot.control.runs.filter(row => row.agentId === agentId && row.taskId === run.taskId).map(row => row.claimRevision),
        ...lifecycle.retiredRuns.filter(row => row.agentId === agentId && row.taskId === run.taskId).map(row => row.claimRevision));
    return deepFreeze({ schemaVersion: 1, kind: "agent-lifecycle-projection", context: snapshot.context, agentId, revision: snapshot.revision, controlEpoch: agent?.epoch ?? 0,
      accepting: permitted && !agent?.hold && !agent?.dismissed && this.available && this.authority.commandControlSourceHealthy(), dismissed: agent?.dismissed ?? false, holdId: agent?.hold?.holdId ?? null,
      runs: snapshot.control.runs.filter(run => run.agentId === agentId).map(run => {
        const row = lifecycle.executions.find(row => row.runId === run.runId)!;
        const recovery: AgentLifecycleProjectionV1["runs"][number]["recovery"] = canClaim(run, row) ? ["query_original", "new_explicit_claim"]
          : management && !row.leaseReleased && (row.quiescence || row.terminal) ? ["query_original", "publish_observation"]
          : management && !row.leaseReleased ? ["query_original", "request_stop"] : ["query_original"];
        return { commandId: run.commandId, rootRequestId: run.rootRequestId, requestId: run.requestId, runId: run.runId, taskId: run.taskId, claimRevision: run.claimRevision,
          runEpoch: run.epoch, agentControlEpoch: run.agentControlEpoch, terminalReason: row.terminal?.reason ?? null, execution: row.phase,
          physical: row.leaseReleased ? "lease_released" as const : row.quiescence || row.terminal ? "quiescent_lease_pending" as const : "unconfirmed" as const, effect: run.effect, recovery };
      }), operations: lifecycle.operations.filter(row => row.agentId === agentId), archivedRuns: lifecycle.retiredRuns.filter(run => run.agentId === agentId).length,
      archived: this.authority.lifecycleHistoricalRuns(lifecycle, agentId).map(({ run, execution }) => ({ runId: run.runId, taskId: run.taskId, commandId: run.commandId,
        claimRevision: run.claimRevision, effect: run.effect, execution: execution.phase, leaseReleased: true as const,
        recovery: canClaim(run, execution) ? ["query_original", "new_explicit_claim"] as const : ["query_original"] as const })), productionEnabled: false });
  }
  inspect(transport: Intake["transport"], agentId: string) {
    const { control } = this.authority.commandControlForReader(transport, agentId), agent = control.agents.find(row => row.agentId === agentId);
    return deepFreeze({ ...(this.authority.commandLifecycleConfigured() ? { lifecycle: this.lifecycleProjection(transport, agentId) } : {}), sourceAvailableHere: this.available && this.authority.commandControlSourceHealthy(), pendingDrainObservations: this.pendingDrainProofs.size, agent: agent ?? { agentId, epoch: 0, hold: null, dismissed: false },
      runs: control.runs.filter(run => run.agentId === agentId).map(run => ({ runId: run.runId, taskId: run.taskId, commandId: run.commandId,
        claimRevision: run.claimRevision, epoch: run.epoch, state: run.state, effect: run.effect, controlledHere: this.live.has(run.runId), hold: run.hold, drainProofRef: run.drainProofRef,
        recovery: this.authority.commandLifecycleConfigured() ? ["query_original"] : run.effect === "unknown" || !run.drainProofRef && !this.live.has(run.runId) || ["unknown", "draining"].includes(run.state) ? ["query_original", "request_stop", "await_physical_drain"] : [] })) });
  }
  audit(transport: Intake["transport"], agentId: string) {
    const snapshot = this.authority.commandControlForReader(transport, agentId);
    return [...snapshot.control.audit.filter(row => row.agentId === agentId), ...(snapshot.lifecycle ? this.authority.lifecycleHistoricalAudit(snapshot.lifecycle, agentId) : [])].sort((a, b) => a.sequence - b.sequence);
  }
}
