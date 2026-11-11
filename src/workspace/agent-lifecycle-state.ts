// C4 Host-private persistence and projections. These JSON facts are never execution/release capabilities.
import { AGENT_BOUNDARY_ERRORS, AgentBoundaryContractError, parseAgentBoundaryDocument,
  type AgentBoundaryErrorCode, type AgentBoundaryReceipt, type AgentBoundaryContext } from "./agent-boundaries-contract.js";
import { commandDigest, commandEpoch, commandId, type AgentCommandRun, type AgentCommandState } from "./agent-command-state.js";
import { canonical, plain, positive, UUID } from "./local-state.js";

export const LIFECYCLE_OPERATION_LIMIT = 256;
export const LIFECYCLE_SEGMENT_LIMIT = 64;
export const LIFECYCLE_COMMAND_INDEX_LIMIT = 4096;
export const LIFECYCLE_RUN_INDEX_LIMIT = 2048;
export const LIFECYCLE_SEGMENT_BYTES = 512 * 1024;
export const LIFECYCLE_STATE_BYTES = 1024 * 1024;
export interface AgentLifecycleLease {
  sessionId: string; attemptId: string; ownerPid: number; processInstance: string; ownerDigest: string;
  dev: number; ino: number; ctimeMs: number; mtimeMs: number;
}
export interface AgentLifecycleTerminalFact {
  proofRef: string; issuerId: string; reason: AgentBoundaryErrorCode; lease: AgentLifecycleLease;
}
export interface AgentLifecycleQuiescenceFact {
  proofRef: string; drainProofRef: string; effectDigest: string; lease: AgentLifecycleLease;
}
export interface AgentLifecycleRecoveryV1 {
  schemaVersion: 1; kind: "agent-lifecycle-recovery"; operationId: string;
  agentId: string; taskId: string; previousRunId: string; expectedClaimRevision: number;
  proofDigest: string; commandId: string; rootRequestId: string;
}
export interface AgentLifecycleRun {
  runId: string; commandId: string; claimRevision: number; bindingDigest: string;
  phase: "legacy_unknown" | "prepared" | "issued" | "aborted_before_execution";
  issuanceRef: string | null; lease: AgentLifecycleLease | null; acceptedReceipt: AgentBoundaryReceipt | null;
  terminal: AgentLifecycleTerminalFact | null; quiescence: AgentLifecycleQuiescenceFact | null; leaseReleased: boolean;
  recovery: { operationId: string; requestDigest: string; previousRunId: string; proofDigest: string } | null;
}
export interface AgentLifecycleOperation {
  commandId: string; agentId: string; action: "task.stop" | "agent.pause" | "agent.dismiss";
  epoch: number; holdId: string; targetRunIds: string[]; notifiedRunIds: string[]; revokedRunIds: string[];
  schedules: "pending" | "paused" | "none"; archive: "not_requested" | "pending" | "archived";
  archiveExpected: { agentEpoch: number; configRevision: number } | null;
  archivedResource: { agentEpoch: number; configRevision: number } | null;
}
export interface AgentLifecycleSegment {
  segmentId: string; digest: string; bytes: number; commandIds: string[]; runIds: string[]; auditIds: string[];
}
export interface AgentLifecycleRetiredCommand {
  commandId: string; rootRequestId: string; agentId: string; segmentId: string; commandDigest: string; recordDigest: string;
}
export interface AgentLifecycleRetiredRun {
  runId: string; taskId: string; agentId: string; commandId: string; rootRequestId: string; claimRevision: number;
  segmentId: string; recordDigest: string; lifecycleDigest: string; outcome: "aborted_before_execution" | "drained" | "unknown";
  terminalProofDigest: string | null; leaseReleased: boolean; recoveryOperationId: string | null; recoveryDigest: string | null;
}
export interface AgentLifecycleState {
  schemaVersion: 1; migration: { fromSchema: 2; sourceDigest: string; at: string };
  executions: AgentLifecycleRun[]; operations: AgentLifecycleOperation[]; segments: AgentLifecycleSegment[];
  retiredCommands: AgentLifecycleRetiredCommand[]; retiredRuns: AgentLifecycleRetiredRun[];
}
export interface AgentLifecycleProjectionV1 {
  schemaVersion: 1; kind: "agent-lifecycle-projection"; context: AgentBoundaryContext; agentId: string; revision: number; controlEpoch: number;
  accepting: boolean; dismissed: boolean; holdId: string | null;
  runs: { commandId: string; rootRequestId: string; requestId: string; runId: string; taskId: string; claimRevision: number;
    runEpoch: number; agentControlEpoch: number; terminalReason: AgentBoundaryErrorCode | null; execution: AgentLifecycleRun["phase"];
    physical: "unconfirmed" | "quiescent_lease_pending" | "lease_released"; effect: AgentCommandRun["effect"];
    recovery: readonly ("query_original" | "request_stop" | "publish_observation" | "new_explicit_claim")[] }[];
  operations: AgentLifecycleOperation[]; archivedRuns: number;
  archived: { runId: string; taskId: string; commandId: string; claimRevision: number; effect: AgentCommandRun["effect"];
    execution: AgentLifecycleRun["phase"]; leaseReleased: true; recovery: readonly ("query_original" | "new_explicit_claim")[] }[];
  productionEnabled: false;
}
const fail = (field = "lifecycle.store"): never => { throw new AgentBoundaryContractError("AUTHORITY_UNVERIFIED", field); };
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const uuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);
function fields(value: unknown, expected: readonly string[]): asserts value is Record<string, unknown> {
  if (!plain(value)) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value), own = Reflect.ownKeys(descriptors);
  if (own.length !== expected.length || own.some(key => typeof key !== "string" || !expected.includes(key)
    || !descriptors[key]!.enumerable || !Object.hasOwn(descriptors[key]!, "value"))) return fail();
}
const ids = (raw: unknown, cap: number): raw is string[] => Array.isArray(raw) && raw.length <= cap
  && raw.every(commandId) && new Set(raw).size === raw.length;
function lease(raw: unknown): AgentLifecycleLease {
  fields(raw, ["sessionId", "attemptId", "ownerPid", "processInstance", "ownerDigest", "dev", "ino", "ctimeMs", "mtimeMs"]);
  if (!uuid(raw.sessionId) || !uuid(raw.attemptId) || !uuid(raw.processInstance) || !positive(raw.ownerPid) || !hash(raw.ownerDigest)
    || !positive(raw.dev) || !positive(raw.ino) || !Number.isFinite(raw.ctimeMs) || Number(raw.ctimeMs) < 0
    || !Number.isFinite(raw.mtimeMs) || Number(raw.mtimeMs) < 0) return fail();
  return structuredClone(raw) as unknown as AgentLifecycleLease;
}
export function parseAgentLifecycleRecovery(raw: unknown): AgentLifecycleRecoveryV1 {
  fields(raw, ["schemaVersion", "kind", "operationId", "agentId", "taskId", "previousRunId", "expectedClaimRevision", "proofDigest", "commandId", "rootRequestId"]);
  if (raw.schemaVersion !== 1 || raw.kind !== "agent-lifecycle-recovery" || !positive(raw.expectedClaimRevision) || !hash(raw.proofDigest)
    || ["operationId", "agentId", "taskId", "previousRunId", "commandId", "rootRequestId"].some(key => !commandId(raw[key]))) return fail("lifecycle.recovery");
  return structuredClone(raw) as unknown as AgentLifecycleRecoveryV1;
}
export function newAgentLifecycleRun(run: AgentCommandRun, owner: AgentLifecycleLease, acceptedReceipt: AgentBoundaryReceipt,
  recovery: AgentLifecycleRun["recovery"] = null): AgentLifecycleRun {
  return { runId: run.runId, commandId: run.commandId, claimRevision: run.claimRevision, bindingDigest: run.bindingDigest,
    phase: "prepared", issuanceRef: null, lease: structuredClone(owner), acceptedReceipt: structuredClone(acceptedReceipt),
    terminal: null, quiescence: null, leaseReleased: false, recovery: structuredClone(recovery) };
}
/** Historical accepted/no-live is NOT a never-issued proof. Migration never synthesizes one. */
export function migrateAgentLifecycleState(control: AgentCommandState, sourceDigest: string, at: string): AgentLifecycleState {
  return { schemaVersion: 1, migration: { fromSchema: 2, sourceDigest, at },
    executions: control.runs.map(run => ({ runId: run.runId, commandId: run.commandId, claimRevision: run.claimRevision, bindingDigest: run.bindingDigest,
      phase: "legacy_unknown", issuanceRef: null, lease: null, acceptedReceipt: null, terminal: null, quiescence: null,
      leaseReleased: run.state === "drained" && run.drainProofRef !== null, recovery: null })),
    operations: [], segments: [], retiredCommands: [], retiredRuns: [] };
}
export function assertAgentLifecycleCapacity(state: AgentLifecycleState, control?: AgentCommandState, reserveClosure = false): void {
  const unfenced = reserveClosure && control ? control.runs.filter(run => !run.hold && !["drained", "unknown", "draining"].includes(run.state)
    && control.agents.some(agent => agent.agentId === run.agentId && !agent.hold && !agent.dismissed && agent.epoch === run.agentControlEpoch)) : [];
  const slots = unfenced.length + new Set(unfenced.map(run => run.agentId)).size;
  const reserve = reserveClosure ? unfenced.length * 8192 + new Set(unfenced.map(run => run.agentId)).size * 4096 + 16384 : 0;
  if (state.executions.length > 128 || state.operations.length + slots > LIFECYCLE_OPERATION_LIMIT || state.segments.length > LIFECYCLE_SEGMENT_LIMIT
    || state.retiredCommands.length > LIFECYCLE_COMMAND_INDEX_LIMIT || state.retiredRuns.length > LIFECYCLE_RUN_INDEX_LIMIT
    || Buffer.byteLength(canonical(state)) + reserve > LIFECYCLE_STATE_BYTES) return fail("lifecycle.capacity");
}
export function parseAgentLifecycleState(raw: unknown, control: AgentCommandState): AgentLifecycleState {
  fields(raw, ["schemaVersion", "migration", "executions", "operations", "segments", "retiredCommands", "retiredRuns"]);
  fields(raw.migration, ["fromSchema", "sourceDigest", "at"]);
  if (raw.schemaVersion !== 1 || raw.migration.fromSchema !== 2 || !hash(raw.migration.sourceDigest) || typeof raw.migration.at !== "string"
    || !Number.isFinite(Date.parse(raw.migration.at)) || ["executions", "operations", "segments", "retiredCommands", "retiredRuns"].some(key => !Array.isArray(raw[key]))) return fail();
  const value = raw as unknown as AgentLifecycleState; assertAgentLifecycleCapacity(value);
  const segments = new Map<string, AgentLifecycleSegment>(), commands = new Set(control.commands.map(row => row.command.commandId)), runIds = new Set(control.runs.map(row => row.runId));
  for (const row of value.segments) {
    fields(row, ["segmentId", "digest", "bytes", "commandIds", "runIds", "auditIds"]);
    if (!uuid(row.segmentId) || segments.has(row.segmentId) || !hash(row.digest) || !positive(row.bytes) || row.bytes > LIFECYCLE_SEGMENT_BYTES
      || !ids(row.commandIds, 256) || !ids(row.runIds, 128) || !ids(row.auditIds, 768)) return fail();
    segments.set(row.segmentId, row);
  }
  for (const row of value.retiredCommands) {
    fields(row, ["commandId", "rootRequestId", "agentId", "segmentId", "commandDigest", "recordDigest"]);
    if (![row.commandId, row.rootRequestId, row.agentId].every(commandId) || commands.has(row.commandId) || !hash(row.commandDigest) || !hash(row.recordDigest)
      || !segments.get(row.segmentId)?.commandIds.includes(row.commandId)) return fail();
    commands.add(row.commandId);
  }
  const tasks = new Set<string>(), recoveries = new Set<string>();
  for (const row of value.retiredRuns) {
    fields(row, ["runId", "taskId", "agentId", "commandId", "rootRequestId", "claimRevision", "segmentId", "recordDigest", "lifecycleDigest", "outcome", "terminalProofDigest", "leaseReleased", "recoveryOperationId", "recoveryDigest"]);
    if (![row.runId, row.taskId, row.agentId, row.commandId, row.rootRequestId].every(commandId) || !positive(row.claimRevision) || runIds.has(row.runId)
      || !commands.has(row.commandId) || !hash(row.recordDigest) || !hash(row.lifecycleDigest) || !["aborted_before_execution", "drained", "unknown"].includes(row.outcome)
      || typeof row.leaseReleased !== "boolean" || !(row.terminalProofDigest === null || hash(row.terminalProofDigest))
      || row.outcome === "aborted_before_execution" && (row.terminalProofDigest === null || !row.leaseReleased)
      || !(row.recoveryOperationId === null && row.recoveryDigest === null || commandId(row.recoveryOperationId) && hash(row.recoveryDigest))
      || !segments.get(row.segmentId)?.runIds.includes(row.runId)) return fail();
    const task = canonical([row.agentId, row.taskId, row.claimRevision]); if (tasks.has(task)) return fail(); tasks.add(task); runIds.add(row.runId);
    if (row.recoveryOperationId) { if (recoveries.has(row.recoveryOperationId)) return fail(); recoveries.add(row.recoveryOperationId); }
  }
  const executions = new Set<string>();
  for (const row of value.executions) {
    fields(row, ["runId", "commandId", "claimRevision", "bindingDigest", "phase", "issuanceRef", "lease", "acceptedReceipt", "terminal", "quiescence", "leaseReleased", "recovery"]);
    const run = control.runs.find(run => run.runId === row.runId);
    if (!run || executions.has(row.runId) || row.commandId !== run.commandId || row.claimRevision !== run.claimRevision || row.bindingDigest !== run.bindingDigest
      || !["legacy_unknown", "prepared", "issued", "aborted_before_execution"].includes(row.phase) || typeof row.leaseReleased !== "boolean"
      || !(row.issuanceRef === null || commandId(row.issuanceRef)) || (row.phase === "issued") !== (row.issuanceRef !== null)
      || row.phase === "legacy_unknown" && (row.lease !== null || row.acceptedReceipt !== null || row.terminal !== null)
      || row.phase !== "legacy_unknown" && row.lease === null) return fail();
    if (row.lease !== null) {
      const owner = lease(row.lease);
      if (owner.sessionId !== run.binding.sessionId || owner.attemptId !== run.leaseAttemptId) return fail();
    }
    if (row.acceptedReceipt !== null) {
      const receipt = parseAgentBoundaryDocument(row.acceptedReceipt), original = control.commands.find(row => row.command.commandId === run.commandId)!;
      if (receipt.kind !== "command-receipt" || receipt.status !== "accepted" || receipt.commandId !== run.commandId || receipt.agentId !== run.agentId
        || receipt.rootRequestId !== run.rootRequestId || receipt.execution.effect !== "none" || receipt.execution.drain !== "not_requested" || receipt.error !== null
        || receipt.intentDigest !== original.command.intentDigest || canonical(receipt.context) !== canonical(original.command.context)
        || receipt.control.epoch !== original.command.expected.controlEpoch || receipt.control.holdId !== null) return fail();
    }
    if (row.terminal !== null) {
      fields(row.terminal, ["proofRef", "issuerId", "reason", "lease"]);
      if (!commandId(row.terminal.proofRef) || row.terminal.issuerId !== run.issuerId || !Object.hasOwn(AGENT_BOUNDARY_ERRORS, row.terminal.reason)
        || row.phase !== "aborted_before_execution" || run.effect !== "none" || !run.hold || canonical(lease(row.terminal.lease)) !== canonical(row.lease)) return fail();
    } else if (row.phase === "aborted_before_execution") return fail();
    if (row.quiescence !== null) {
      fields(row.quiescence, ["proofRef", "drainProofRef", "effectDigest", "lease"]);
      if (!commandId(row.quiescence.proofRef) || !commandId(row.quiescence.drainProofRef) || !hash(row.quiescence.effectDigest)
        || canonical(lease(row.quiescence.lease)) !== canonical(row.lease) || row.phase !== "issued") return fail();
    }
    if (row.leaseReleased && !row.terminal && !row.quiescence && !(row.phase === "legacy_unknown" && run.state === "drained" && run.drainProofRef)) return fail();
    if (row.phase !== "legacy_unknown" && row.claimRevision > 1 && row.recovery === null) return fail();
    if (row.recovery !== null) {
      fields(row.recovery, ["operationId", "requestDigest", "previousRunId", "proofDigest"]);
      if (!commandId(row.recovery.operationId) || !commandId(row.recovery.previousRunId) || !hash(row.recovery.requestDigest) || !hash(row.recovery.proofDigest)
        || recoveries.has(row.recovery.operationId) || row.claimRevision < 2) return fail();
      recoveries.add(row.recovery.operationId);
    }
    const task = canonical([run.agentId, run.taskId, run.claimRevision]); if (tasks.has(task)) return fail(); tasks.add(task); executions.add(row.runId);
  }
  if (executions.size !== control.runs.length) return fail();
  const operations = new Set<string>();
  for (const row of value.operations) {
    fields(row, ["commandId", "agentId", "action", "epoch", "holdId", "targetRunIds", "notifiedRunIds", "revokedRunIds", "schedules", "archive", "archiveExpected", "archivedResource"]);
    if (!commandId(row.commandId) || !commands.has(row.commandId) || operations.has(row.commandId) || !commandId(row.agentId) || !commandId(row.holdId)
      || !commandEpoch(row.epoch) || !["task.stop", "agent.pause", "agent.dismiss"].includes(row.action) || !ids(row.targetRunIds, 128)
      || row.targetRunIds.some(id => !runIds.has(id)) || !ids(row.notifiedRunIds, 128) || !ids(row.revokedRunIds, 128)
      || [...row.notifiedRunIds, ...row.revokedRunIds].some(id => !row.targetRunIds.includes(id))
      || !["pending", "paused", "none"].includes(row.schedules) || !["not_requested", "pending", "archived"].includes(row.archive)
      || (row.action === "agent.dismiss") !== (row.archive !== "not_requested")) return fail();
    if (row.archiveExpected !== null) {
      fields(row.archiveExpected, ["agentEpoch", "configRevision"]);
      if (row.action !== "agent.dismiss" || !positive(row.archiveExpected.agentEpoch) || !positive(row.archiveExpected.configRevision)) return fail();
    } else if (row.action === "agent.dismiss") return fail();
    if (row.archivedResource !== null) {
      fields(row.archivedResource, ["agentEpoch", "configRevision"]);
      if (row.action !== "agent.dismiss" || row.archive !== "archived" || !positive(row.archivedResource.agentEpoch) || !positive(row.archivedResource.configRevision)
        || row.archivedResource.agentEpoch !== row.archiveExpected!.agentEpoch + 1 || row.archivedResource.configRevision !== row.archiveExpected!.configRevision) return fail();
    } else if (row.archive === "archived") return fail();
    operations.add(row.commandId);
  }
  return structuredClone(value);
}
/** Append-only control evidence. Physical publication is verified separately before retirement. */
export function assertAgentLifecycleTransition(before: AgentLifecycleState, next: AgentLifecycleState): void {
  const deny = (): never => fail("lifecycle.transition");
  if (canonical(before.migration) !== canonical(next.migration)) return deny();
  for (const key of ["segments", "retiredCommands", "retiredRuns"] as const) {
    if (next[key].length < before[key].length) return deny();
    for (let i = 0; i < before[key].length; i++) if (canonical(before[key][i]) !== canonical(next[key][i])) return deny();
  }
  for (const old of before.executions) {
    const row = next.executions.find(row => row.runId === old.runId);
    if (!row) { if (!next.retiredRuns.some(row => row.runId === old.runId && row.lifecycleDigest === commandDigest(old))) return deny(); continue; }
    for (const key of ["runId", "commandId", "claimRevision", "bindingDigest", "lease", "acceptedReceipt", "recovery"] as const)
      if (canonical(old[key]) !== canonical(row[key])) return deny();
    if (old.phase !== row.phase && !(old.phase === "prepared" && ["issued", "aborted_before_execution"].includes(row.phase))) return deny();
    if (old.issuanceRef !== null && old.issuanceRef !== row.issuanceRef || old.terminal !== null && canonical(old.terminal) !== canonical(row.terminal)
      || old.quiescence !== null && canonical(old.quiescence) !== canonical(row.quiescence) || old.leaseReleased && !row.leaseReleased) return deny();
  }
  for (const old of before.operations) {
    const row = next.operations.find(row => row.commandId === old.commandId);
    if (!row) { if (!next.retiredCommands.some(row => row.commandId === old.commandId)) return deny(); continue; }
    for (const key of ["commandId", "agentId", "action", "epoch", "holdId", "targetRunIds", "archiveExpected"] as const) if (canonical(old[key]) !== canonical(row[key])) return deny();
    if (old.notifiedRunIds.some(id => !row.notifiedRunIds.includes(id)) || old.revokedRunIds.some(id => !row.revokedRunIds.includes(id))
      || old.schedules !== "pending" && old.schedules !== row.schedules || old.archive !== "pending" && old.archive !== row.archive
      || old.archivedResource !== null && canonical(old.archivedResource) !== canonical(row.archivedResource)) return deny();
  }
}
