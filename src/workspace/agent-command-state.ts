// C3 private persistence. Portable C0 remains v1; this module issues no transport/runtime capability.
import { createHash } from "node:crypto";
import { AGENT_BOUNDARY_ERRORS, AgentBoundaryContractError, assertAgentBoundaryContext, parseAgentBoundaryDocument,
  type AgentBoundaryAction, type AgentBoundaryCommand, type AgentBoundaryContext, type AgentBoundaryErrorCode, type AgentBoundaryReceipt } from "./agent-boundaries-contract.js";
import { canonical, exact, plain, UUID } from "./local-state.js";
import { freezeWorkspaceRunBinding, type WorkspaceRunBinding } from "./run-binding.js";

export const COMMAND_LIMIT = 256;
export const COMMAND_RUN_LIMIT = 128;
export const COMMAND_AUDIT_LIMIT = 768;
const CONTROL_BYTES = 2 * 1024 * 1024;
export type AgentCommandHoldReason = "task_stop" | "agent_pause" | "dismissed" | "recovery";
export interface AgentCommandHold { holdId: string; reason: AgentCommandHoldReason; sequence: number }
export interface AgentCommandControl { agentId: string; epoch: number; hold: AgentCommandHold | null; dismissed: boolean }
export interface AgentCommandRun {
  commandId: string; rootRequestId: string; agentId: string; taskId: string; runId: string; claimRevision: number; policyRevision: number;
  requestId: string; leaseAttemptId: string; issuerId: string; binding: Readonly<WorkspaceRunBinding>; bindingDigest: string;
  agentControlEpoch: number; epoch: number; hold: AgentCommandHold | null;
  state: "accepted" | "bound" | "running" | "draining" | "drained" | "unknown";
  effect: "none" | "accepted" | "completed" | "unknown"; effectId: string | null; drainProofRef: string | null;
}
export interface AgentCommandRecord { command: AgentBoundaryCommand; receipt: AgentBoundaryReceipt; sequence: number }
export interface AgentCommandAudit {
  eventId: string; sequence: number; commandId: string; agentId: string; action: AgentBoundaryAction | "runtime.bound" | "runtime.started" | "runtime.drained" | "runtime.unknown" | "recovery.ack";
  decision: "allowed" | "rejected" | "observed"; code: AgentBoundaryErrorCode | null;
  actorId: string; nodeId: string; at: string; oldEpoch: number; newEpoch: number; policyRevision: number; acknowledged: boolean;
}
export interface AgentCommandOrigin { sourceRevision: number; sourceDigest: string; initializedAt: string; humanSubjectId: string; nodeId: string }
export interface AgentCommandState {
  schemaVersion: 1; origin: AgentCommandOrigin; sequence: number; agents: AgentCommandControl[]; runs: AgentCommandRun[]; commands: AgentCommandRecord[]; audit: AgentCommandAudit[];
}
const invalid = (): never => { throw new AgentBoundaryContractError("AUTHORITY_UNVERIFIED", "control.store"); };
export const commandId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value);
export const commandEpoch = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const uuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);
export const commandDigest = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");
export const agentPolicyProposalDigest = (value: unknown): string => createHash("sha256").update("hara-agent-policy-proposal-v1\0").update(canonical(value)).digest("hex");
export function nextCommandEpoch(epoch: number): number {
  if (!commandEpoch(epoch) || epoch >= Number.MAX_SAFE_INTEGER) throw new AgentBoundaryContractError("COUNTER_EXHAUSTED", "control.epoch"); return epoch + 1;
}
export function emptyAgentCommandState(agentIds: readonly string[], origin: AgentCommandOrigin): AgentCommandState {
  return { schemaVersion: 1, origin, sequence: 0, agents: agentIds.map(agentId => ({ agentId, epoch: 0, hold: null, dismissed: false })), runs: [], commands: [], audit: [] };
}
function hold(value: unknown, sequence: number): value is AgentCommandHold | null {
  return value === null || plain(value) && exact(value, ["holdId", "reason", "sequence"]) && commandId(value.holdId)
    && ["task_stop", "agent_pause", "dismissed", "recovery"].includes(String(value.reason))
    && commandEpoch(value.sequence) && Number(value.sequence) > 0 && Number(value.sequence) <= sequence;
}
export function parseAgentCommandState(raw: unknown, context: AgentBoundaryContext): AgentCommandState {
  if (!plain(raw) || !exact(raw, ["schemaVersion", "origin", "sequence", "agents", "runs", "commands", "audit"]) || raw.schemaVersion !== 1 || !commandEpoch(raw.sequence)
    || !Array.isArray(raw.agents) || raw.agents.length > 4096 || !Array.isArray(raw.runs) || raw.runs.length > COMMAND_RUN_LIMIT
    || !Array.isArray(raw.commands) || raw.commands.length > COMMAND_LIMIT || !Array.isArray(raw.audit) || raw.audit.length > COMMAND_AUDIT_LIMIT) return invalid();
  if (!plain(raw.origin) || !exact(raw.origin, ["sourceRevision", "sourceDigest", "initializedAt", "humanSubjectId", "nodeId"])
    || !commandEpoch(raw.origin.sourceRevision) || !hash(raw.origin.sourceDigest) || typeof raw.origin.initializedAt !== "string" || !Number.isFinite(Date.parse(raw.origin.initializedAt))
    || raw.origin.humanSubjectId !== context.humanSubjectId || raw.origin.nodeId !== context.nodeId) return invalid();
  const sequence = Number(raw.sequence), agents = new Set<string>(), runs = new Set<string>(), commands = new Map<string, AgentBoundaryCommand>(), commandSequences = new Set<number>();
  for (const item of raw.agents) {
    if (!plain(item) || !exact(item, ["agentId", "epoch", "hold", "dismissed"]) || !commandId(item.agentId) || agents.has(item.agentId)
      || !commandEpoch(item.epoch) || !hold(item.hold, sequence) || typeof item.dismissed !== "boolean" || item.dismissed && item.hold === null) return invalid();
    agents.add(item.agentId);
  }
  for (const item of raw.commands) {
    if (!plain(item) || !exact(item, ["command", "receipt", "sequence"]) || !commandEpoch(item.sequence) || Number(item.sequence) < 1 || Number(item.sequence) > sequence) return invalid();
    if (commandSequences.has(Number(item.sequence))) return invalid(); commandSequences.add(Number(item.sequence));
    const command = parseAgentBoundaryDocument(item.command), receipt = parseAgentBoundaryDocument(item.receipt);
    if (command.kind !== "command" || receipt.kind !== "command-receipt" || commands.has(command.commandId)
      || receipt.commandId !== command.commandId || receipt.agentId !== command.agentId || receipt.rootRequestId !== command.rootRequestId || receipt.intentDigest !== command.intentDigest) return invalid();
    assertAgentBoundaryContext(command, context); assertAgentBoundaryContext(receipt, context); commands.set(command.commandId, command);
  }
  for (const item of raw.runs) {
    if (!plain(item) || !exact(item, ["commandId", "rootRequestId", "agentId", "taskId", "runId", "claimRevision", "policyRevision", "requestId", "leaseAttemptId", "issuerId", "binding", "bindingDigest", "agentControlEpoch", "epoch", "hold", "state", "effect", "effectId", "drainProofRef"])
      || !commandId(item.commandId) || !commandId(item.rootRequestId) || !commandId(item.agentId) || !commandId(item.taskId) || !commandId(item.runId)
      || !commandEpoch(item.policyRevision) || Number(item.policyRevision) < 1
      || runs.has(item.runId) || !commandEpoch(item.claimRevision) || Number(item.claimRevision) < 1 || !uuid(item.requestId) || !uuid(item.leaseAttemptId) || !uuid(item.issuerId)
      || !hash(item.bindingDigest) || !commandEpoch(item.agentControlEpoch) || !commandEpoch(item.epoch) || !hold(item.hold, sequence)
      || !["accepted", "bound", "running", "draining", "drained", "unknown"].includes(String(item.state))
      || !["none", "accepted", "completed", "unknown"].includes(String(item.effect)) || !(item.effectId === null || commandId(item.effectId))
      || (item.effect === "none") !== (item.effectId === null) || !(item.drainProofRef === null || commandId(item.drainProofRef))
      || item.state === "drained" && item.drainProofRef === null) return invalid();
    const binding = freezeWorkspaceRunBinding(item.binding as WorkspaceRunBinding), command = commands.get(item.commandId);
    if (!command || command.operation.action !== "task.dispatch" || command.agentId !== item.agentId || command.rootRequestId !== item.rootRequestId
      || command.operation.taskId !== item.taskId || command.operation.conversationId !== binding.sessionId || binding.runId !== item.runId
      || binding.agent.agentId !== item.agentId || binding.agent.taskId !== item.taskId || !agents.has(item.agentId)
      || item.agentControlEpoch !== command.expected.controlEpoch || Number(item.epoch) < Number(item.agentControlEpoch)
      || binding.host.hostId !== context.nodeId || binding.host.actorId !== context.humanSubjectId
      || binding.host.grantId !== context.localGrant.grantId || binding.host.grantRevision !== context.localGrant.grantRevision
      || commandDigest(binding) !== item.bindingDigest || canonical(binding.scope) !== canonical(context.scope)
      || canonical(binding.agent.resourceBinding) !== canonical(context.resourceBinding)) return invalid();
    runs.add(item.runId);
  }
  const eventIds = new Set<string>(); let previousSequence = 0;
  for (const item of raw.audit) {
    if (!plain(item) || !exact(item, ["eventId", "sequence", "commandId", "agentId", "action", "decision", "code", "actorId", "nodeId", "at", "oldEpoch", "newEpoch", "policyRevision", "acknowledged"])
      || !commandId(item.eventId) || eventIds.has(item.eventId) || !commandEpoch(item.sequence) || Number(item.sequence) <= previousSequence || Number(item.sequence) > sequence
      || !commandId(item.commandId) || !commands.has(item.commandId) || !commandId(item.agentId) || !agents.has(item.agentId)
      || !["allowed", "rejected", "observed"].includes(String(item.decision)) || !(item.code === null || typeof item.code === "string" && Object.hasOwn(AGENT_BOUNDARY_ERRORS, item.code))
      || item.actorId !== context.humanSubjectId || item.nodeId !== context.nodeId || typeof item.at !== "string" || !Number.isFinite(Date.parse(item.at))
      || !commandEpoch(item.oldEpoch) || !commandEpoch(item.newEpoch) || !commandEpoch(item.policyRevision) || typeof item.acknowledged !== "boolean") return invalid();
    const command = commands.get(item.commandId)!;
    if (item.action !== command.operation.action && !["runtime.bound", "runtime.started", "runtime.drained", "runtime.unknown", "recovery.ack"].includes(String(item.action))) return invalid();
    previousSequence = Number(item.sequence); eventIds.add(item.eventId);
  }
  if (Buffer.byteLength(canonical(raw)) > CONTROL_BYTES) return invalid();
  return structuredClone(raw) as unknown as AgentCommandState;
}
/** Keep first restrictive-control receipts possible when business capacity is exhausted. Existing
 * accepted/unknown IDs are never evicted. Only stop/pause/dismiss may consume the reserved slots. */
export function assertAgentCommandCapacity(state: AgentCommandState, restrictive = false): void {
  const unfenced = state.runs.filter(run => !run.hold && !["drained", "unknown", "draining"].includes(run.state)
    && state.agents.some(agent => agent.agentId === run.agentId && !agent.hold && !agent.dismissed && agent.epoch === run.agentControlEpoch));
  const reserve = restrictive ? 0 : unfenced.length + new Set(unfenced.map(run => run.agentId)).size + 2;
  if (state.commands.length + reserve > COMMAND_LIMIT || state.runs.length > COMMAND_RUN_LIMIT || state.audit.length + reserve > COMMAND_AUDIT_LIMIT
    || Buffer.byteLength(canonical(state)) + reserve * 8192 > CONTROL_BYTES) throw new AgentBoundaryContractError("AUTHORITY_UNVERIFIED", "control.capacity");
}
export function agentCommandTargetEpoch(state: AgentCommandState, command: Pick<AgentBoundaryCommand, "agentId" | "operation">): number {
  if (command.operation.action === "task.stop") {
    const operation = command.operation, run = state.runs.find(run => run.runId === operation.runId && run.agentId === command.agentId && run.taskId === operation.taskId && run.claimRevision === operation.claimRevision);
    if (!run) throw new AgentBoundaryContractError("AUTHORIZATION_DENIED", "control.target"); return run.epoch;
  }
  return state.agents.find(agent => agent.agentId === command.agentId)?.epoch ?? 0;
}

/** Append-only identity/recovery facts. A trusted observation may advance an outcome, never erase
 * the original acceptance, clear UNKNOWN or resume a held Agent behind the human command path. */
export function assertAgentCommandTransition(before: AgentCommandState, next: AgentCommandState, action?: AgentBoundaryAction): void {
  const deny = (): never => { throw new AgentBoundaryContractError("AUTHORITY_UNVERIFIED", "control.transition"); };
  if (canonical(before.origin) !== canonical(next.origin) || next.sequence < before.sequence || next.commands.length < before.commands.length
    || next.runs.length < before.runs.length || next.audit.length < before.audit.length) return deny();
  for (let i = 0; i < before.commands.length; i++) {
    const old = before.commands[i]!, row = next.commands[i];
    if (!row || canonical(old.command) !== canonical(row.command) || old.sequence !== row.sequence
      || old.receipt.status === "rejected" && canonical(old.receipt) !== canonical(row.receipt)) return deny();
  }
  const runIdentity = (run: AgentCommandRun) => {
    const { epoch: _epoch, hold: _hold, state: _state, effect: _effect, effectId: _effectId, drainProofRef: _drainProofRef, ...identity } = run; return identity;
  };
  for (let i = 0; i < before.runs.length; i++) {
    const old = before.runs[i]!, row = next.runs[i];
    if (!row || canonical(runIdentity(old)) !== canonical(runIdentity(row)) || row.epoch < old.epoch
      || old.hold !== null && canonical(row.hold) !== canonical(old.hold)
      || old.state === "drained" && row.state !== "drained" || old.effect === "unknown" && row.effect !== "unknown"
      || old.effectId !== null && row.effectId !== old.effectId || old.drainProofRef !== null && row.drainProofRef !== old.drainProofRef) return deny();
  }
  for (const old of before.agents) {
    const row = next.agents.find(row => row.agentId === old.agentId);
    if (!row || row.epoch < old.epoch || old.dismissed && !row.dismissed
      || old.hold !== null && row.hold === null && (action !== "agent.resume" || row.epoch <= old.epoch)) return deny();
  }
  for (let i = 0; i < before.audit.length; i++) {
    const old = before.audit[i]!, row = next.audit[i]; if (!row) return deny();
    const { acknowledged: oldAck, ...a } = old, { acknowledged: nextAck, ...b } = row;
    if (canonical(a) !== canonical(b) || oldAck && !nextAck) return deny();
  }
}
