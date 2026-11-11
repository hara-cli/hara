// C4 immutable facts only. Neither a segment nor its exact index grants execution or release.
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { withPrivateStateLockSync, writePrivateStateFileSync } from "../security/private-state.js";
import { AgentBoundaryContractError, assertAgentBoundaryContext, type AgentBoundaryContext } from "./agent-boundaries-contract.js";
import { commandDigest, parseAgentCommandState, type AgentCommandState, type AgentCommandRetirement } from "./agent-command-state.js";
import { assertAgentLifecycleCapacity, parseAgentLifecycleState, LIFECYCLE_SEGMENT_BYTES, LIFECYCLE_SEGMENT_LIMIT,
  type AgentLifecycleState, type AgentLifecycleSegment, type AgentLifecycleRetiredRun } from "./agent-lifecycle-state.js";
import { canonical, exact, plain, UUID } from "./local-state.js";
import { inspectWorkspaceResourceFile, workspaceResourceCommitGuard, workspaceStateHome, type WorkspaceResourceStorage } from "./resource-context.js";

interface HistoryBody { schemaVersion: 1; kind: "agent-lifecycle-history"; segmentId: string; context: AgentBoundaryContext; control: AgentCommandState; lifecycle: AgentLifecycleState }
const fail = (field = "lifecycle.history"): never => { throw new AgentBoundaryContractError("AUTHORITY_UNVERIFIED", field); };
const bytesDigest = (text: string) => createHash("sha256").update(text).digest("hex");
const segmentName = (id: string) => { if (!UUID.test(id)) return fail(); return `workspace-agent-history-${id}.json`; };
function segmentId(value: Omit<HistoryBody, "segmentId">): string {
  const digest = commandDigest(value); return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
}
const sameIds = (a: readonly string[], b: readonly string[]) => canonical([...a].sort()) === canonical([...b].sort());
const complete = (operation: AgentLifecycleState["operations"][number]) => operation.schedules !== "pending" && operation.archive !== "pending"
  && operation.targetRunIds.every(id => operation.revokedRunIds.includes(id));
function closed(control: AgentCommandState, lifecycle: AgentLifecycleState, id: string) {
  const run = control.runs.find(row => row.runId === id), execution = lifecycle.executions.find(row => row.runId === id);
  return Boolean(run && execution?.leaseReleased && (execution.terminal || execution.quiescence || execution.phase === "legacy_unknown" && run.state === "drained" && run.drainProofRef));
}
function retiredRun(body: HistoryBody, segment: string, id: string): AgentLifecycleRetiredRun {
  const run = body.control.runs.find(row => row.runId === id)!, execution = body.lifecycle.executions.find(row => row.runId === id)!;
  return { runId: id, taskId: run.taskId, agentId: run.agentId, commandId: run.commandId, rootRequestId: run.rootRequestId, claimRevision: run.claimRevision,
    segmentId: segment, recordDigest: commandDigest(run), lifecycleDigest: commandDigest(execution),
    outcome: run.effect === "unknown" ? "unknown" : execution.terminal ? "aborted_before_execution" : "drained",
    terminalProofDigest: execution.terminal ? commandDigest(execution.terminal) : null, leaseReleased: execution.leaseReleased,
    recoveryOperationId: execution.recovery?.operationId ?? null, recoveryDigest: execution.recovery?.requestDigest ?? null };
}
/** Bound, link-rejecting private IO. Published segments are never rewritten or deleted here. */
export class WorkspaceAgentLifecycleHistory {
  constructor(private readonly storage: WorkspaceResourceStorage, private readonly context: AgentBoundaryContext) {}
  private parse(text: string, expected: AgentLifecycleSegment): HistoryBody {
    let raw: unknown; try { raw = JSON.parse(text); } catch { return fail(); }
    if (!plain(raw) || !exact(raw, ["schemaVersion", "kind", "segmentId", "context", "control", "lifecycle"])
      || raw.schemaVersion !== 1 || raw.kind !== "agent-lifecycle-history" || raw.segmentId !== expected.segmentId
      || canonical(raw.context) !== canonical(this.context)) return fail();
    const control = parseAgentCommandState(raw.control, this.context), lifecycle = parseAgentLifecycleState(raw.lifecycle, control);
    if (lifecycle.segments.length || lifecycle.retiredCommands.length || lifecycle.retiredRuns.length
      || control.runs.some(row => !closed(control, lifecycle, row.runId)) || lifecycle.operations.some(row => !complete(row))) return fail();
    const body: HistoryBody = { schemaVersion: 1, kind: "agent-lifecycle-history", segmentId: expected.segmentId, context: this.context, control, lifecycle };
    const { segmentId: _id, ...identity } = body;
    if (segmentId(identity) !== body.segmentId || Buffer.byteLength(text) !== expected.bytes || bytesDigest(text) !== expected.digest
      || !sameIds(expected.commandIds, control.commands.map(row => row.command.commandId)) || !sameIds(expected.runIds, control.runs.map(row => row.runId))
      || !sameIds(expected.auditIds, control.audit.map(row => row.eventId))) return fail();
    return body;
  }
  read(lifecycle: AgentLifecycleState, id: string): HistoryBody {
    const expected = lifecycle.segments.find(row => row.segmentId === id); if (!expected) return fail();
    try { return this.storage.run(() => {
      const file = inspectWorkspaceResourceFile(join(workspaceStateHome(), ".hara", segmentName(id)), LIFECYCLE_SEGMENT_BYTES);
      if (!file.snapshot) return fail(); const body = this.parse(file.snapshot.text, expected); file.assertCurrent();
      const commands = lifecycle.retiredCommands.filter(row => row.segmentId === id), runs = lifecycle.retiredRuns.filter(row => row.segmentId === id);
      if (commands.length !== body.control.commands.length || runs.length !== body.control.runs.length) return fail();
      for (const record of body.control.commands) {
        const row = commands.find(row => row.commandId === record.command.commandId);
        if (!row || row.rootRequestId !== record.command.rootRequestId || row.agentId !== record.command.agentId
          || row.commandDigest !== commandDigest(record.command) || row.recordDigest !== commandDigest(record)) return fail();
        assertAgentBoundaryContext(record.command, this.context);
      }
      for (const run of body.control.runs) if (canonical(runs.find(row => row.runId === run.runId)) !== canonical(retiredRun(body, id, run.runId))) return fail();
      return body;
    }); } catch (error) { if (error instanceof AgentBoundaryContractError) throw error; return fail("lifecycle.historyFile"); }
  }
  verify(lifecycle: AgentLifecycleState): HistoryBody[] { return lifecycle.segments.map(row => this.read(lifecycle, row.segmentId)); }
  historicalRun(lifecycle: AgentLifecycleState, id: string) {
    const index = lifecycle.retiredRuns.find(row => row.runId === id); if (!index) return fail(); const body = this.read(lifecycle, index.segmentId);
    return { run: body.control.runs.find(row => row.runId === id)!, execution: body.lifecycle.executions.find(row => row.runId === id)!, control: body.control, lifecycle: body.lifecycle };
  }
  historicalCommand(lifecycle: AgentLifecycleState, id: string) {
    const index = lifecycle.retiredCommands.find(row => row.commandId === id); if (!index) return fail(); const body = this.read(lifecycle, index.segmentId);
    return { record: body.control.commands.find(row => row.command.commandId === id)!, control: body.control, lifecycle: body.lifecycle };
  }
  /** One connected closed component, or a command with no run. Unconfirmed owners stay active;
   * archiving their mutable future observations as immutable history would be unsafe. */
  prepare(control: AgentCommandState, lifecycle: AgentLifecycleState, agentId: string) {
    this.verify(lifecycle);
    const eligible = new Set(control.runs.filter(row => row.agentId === agentId && closed(control, lifecycle, row.runId)).map(row => row.runId));
    let changed = true;
    while (changed) {
      changed = false;
      for (const operation of lifecycle.operations) if (!complete(operation) || operation.targetRunIds.some(id => !eligible.has(id))) {
        for (const id of operation.targetRunIds) if (eligible.delete(id)) changed = true;
      }
    }
    const selectedRuns = new Set<string>(), selectedCommands = new Set<string>();
    const first = control.runs.find(row => eligible.has(row.runId));
    if (first) {
      selectedRuns.add(first.runId); changed = true;
      while (changed) { changed = false;
        for (const operation of lifecycle.operations) if (operation.targetRunIds.some(id => selectedRuns.has(id))) {
          if (!complete(operation) || operation.targetRunIds.some(id => !eligible.has(id))) return fail("lifecycle.archivePending");
          selectedCommands.add(operation.commandId);
          for (const id of operation.targetRunIds) if (!selectedRuns.has(id)) { selectedRuns.add(id); changed = true; }
        }
      }
      for (const run of control.runs) if (selectedRuns.has(run.runId)) selectedCommands.add(run.commandId);
      for (const record of control.commands) if (record.command.agentId === agentId && record.command.operation.action === "task.stop" && selectedRuns.has(record.command.operation.runId)) selectedCommands.add(record.command.commandId);
    } else {
      const record = control.commands.find(row => row.command.agentId === agentId && !control.runs.some(run => run.commandId === row.command.commandId)
        && (!lifecycle.operations.some(op => op.commandId === row.command.commandId) || lifecycle.operations.some(op => op.commandId === row.command.commandId && complete(op) && !op.targetRunIds.length)));
      if (!record) return null; selectedCommands.add(record.command.commandId);
    }
    const archivedControl: AgentCommandState = { ...structuredClone(control), agents: control.agents.filter(row => row.agentId === agentId),
      runs: control.runs.filter(row => selectedRuns.has(row.runId)), commands: control.commands.filter(row => selectedCommands.has(row.command.commandId)), audit: control.audit.filter(row => selectedCommands.has(row.commandId)) };
    const archivedLifecycle: AgentLifecycleState = { schemaVersion: 1, migration: structuredClone(lifecycle.migration), executions: lifecycle.executions.filter(row => selectedRuns.has(row.runId)),
      operations: lifecycle.operations.filter(row => selectedCommands.has(row.commandId)), segments: [], retiredCommands: [], retiredRuns: [] };
    const identity = { schemaVersion: 1 as const, kind: "agent-lifecycle-history" as const, context: this.context, control: archivedControl, lifecycle: archivedLifecycle };
    const body: HistoryBody = { ...identity, segmentId: segmentId(identity) }, text = JSON.stringify(body) + "\n";
    const manifest: AgentLifecycleSegment = { segmentId: body.segmentId, digest: bytesDigest(text), bytes: Buffer.byteLength(text),
      commandIds: [...selectedCommands], runIds: [...selectedRuns], auditIds: archivedControl.audit.map(row => row.eventId) };
    if (manifest.bytes > LIFECYCLE_SEGMENT_BYTES) return fail("lifecycle.segmentCapacity"); this.parse(text, manifest);
    const nextControl: AgentCommandState = { ...structuredClone(control), commands: control.commands.filter(row => !selectedCommands.has(row.command.commandId)),
      runs: control.runs.filter(row => !selectedRuns.has(row.runId)), audit: control.audit.filter(row => !selectedCommands.has(row.commandId)) };
    const nextLifecycle: AgentLifecycleState = { ...structuredClone(lifecycle), executions: lifecycle.executions.filter(row => !selectedRuns.has(row.runId)), operations: lifecycle.operations.filter(row => !selectedCommands.has(row.commandId)),
      segments: [...lifecycle.segments, manifest], retiredCommands: [...lifecycle.retiredCommands, ...archivedControl.commands.map(record => ({ commandId: record.command.commandId,
        rootRequestId: record.command.rootRequestId, agentId: record.command.agentId, segmentId: body.segmentId, commandDigest: commandDigest(record.command), recordDigest: commandDigest(record) }))],
      retiredRuns: [...lifecycle.retiredRuns, ...archivedControl.runs.map(run => retiredRun(body, body.segmentId, run.runId))] };
    assertAgentLifecycleCapacity(nextLifecycle); parseAgentCommandState(nextControl, this.context); parseAgentLifecycleState(nextLifecycle, nextControl);
    return { body, text, manifest, control: nextControl, lifecycle: nextLifecycle };
  }
  publish(candidate: NonNullable<ReturnType<WorkspaceAgentLifecycleHistory["prepare"]>>): void {
    this.storage.run(() => withPrivateStateLockSync(workspaceStateHome(), [], "workspace-agent-history", () => {
      const file = inspectWorkspaceResourceFile(join(workspaceStateHome(), ".hara", segmentName(candidate.manifest.segmentId)), LIFECYCLE_SEGMENT_BYTES);
      if (file.snapshot) { if (file.snapshot.text !== candidate.text) return fail(); }
      else {
        // Include unpublished orphans. Repeated crashes cannot bypass the physical bound.
        const names = readdirSync(join(workspaceStateHome(), ".hara")).filter(name => /^workspace-agent-history-[a-f0-9-]{36}\.json$/.test(name));
        if (names.length >= LIFECYCLE_SEGMENT_LIMIT) return fail("lifecycle.segmentCapacity");
        const guard = workspaceResourceCommitGuard();
        writePrivateStateFileSync(file, candidate.text, { expectedMissing: true, assertCurrent() { guard?.(); file.assertCurrent(); } });
      }
      const check = inspectWorkspaceResourceFile(file.path, LIFECYCLE_SEGMENT_BYTES); if (!check.snapshot) return fail(); this.parse(check.snapshot.text, candidate.manifest); check.assertCurrent();
    }));
  }
  /** Only exact, already-persisted positive closure facts may leave the active aggregate. */
  retirement(beforeControl: AgentCommandState, before: AgentLifecycleState, nextControl: AgentCommandState, next: AgentLifecycleState): AgentCommandRetirement | undefined {
    if (next.segments.length === before.segments.length) return undefined;
    const commands = new Map<string, string>(), runs = new Map<string, string>(), audit = new Map<string, string>();
    for (const segment of next.segments.slice(before.segments.length)) {
      const body = this.read(next, segment.segmentId);
      if (canonical(body.control.origin) !== canonical(beforeControl.origin) || canonical(body.lifecycle.migration) !== canonical(before.migration)) return fail();
      for (const record of body.control.commands) {
        if (canonical(record) !== canonical(beforeControl.commands.find(row => row.command.commandId === record.command.commandId))
          || nextControl.commands.some(row => row.command.commandId === record.command.commandId)) return fail();
        commands.set(record.command.commandId, commandDigest(record));
      }
      for (const run of body.control.runs) {
        if (!closed(beforeControl, before, run.runId) || canonical(run) !== canonical(beforeControl.runs.find(row => row.runId === run.runId))
          || canonical(body.lifecycle.executions.find(row => row.runId === run.runId)) !== canonical(before.executions.find(row => row.runId === run.runId))
          || nextControl.runs.some(row => row.runId === run.runId)) return fail();
        runs.set(run.runId, commandDigest(run));
      }
      for (const operation of body.lifecycle.operations) if (canonical(operation) !== canonical(before.operations.find(row => row.commandId === operation.commandId))) return fail();
      for (const event of body.control.audit) { if (canonical(event) !== canonical(beforeControl.audit.find(row => row.eventId === event.eventId))) return fail(); audit.set(event.eventId, commandDigest(event)); }
    }
    return { commands, runs, audit };
  }
}
