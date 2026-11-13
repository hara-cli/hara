// Second half of the C3 command-control suite (capacity, real process CAS competition, legacy/downgrade
// fences), split from agent-command-control.test.mjs to keep each file within the per-file runner limit.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fork } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { LocalWorkspaceCatalog } from "../dist/workspace/local-catalog.js";
import { WorkspaceResources } from "../dist/workspace/resources.js";
import { WorkspaceResourceStorage, workspaceStateHome } from "../dist/workspace/resource-context.js";
import { WorkspaceConnectionStoreV2 } from "../dist/workspace/connections.js";
import { WorkspaceSessionLease } from "../dist/workspace/session-lease.js";
import { WorkspaceAgentBoundaryAuthority } from "../dist/workspace/agent-boundary-authority.js";
import { AgentBoundaryTransports } from "../dist/workspace/agent-boundary-transport.js";
import { AgentBoundaryContractError, agentBoundaryCommandSigningText } from "../dist/workspace/agent-boundaries-contract.js";
import { WorkspaceAgentCommandControl, agentCommandMessageDigest } from "../dist/workspace/agent-command-control.js";
import { agentPolicyProposalDigest, assertAgentCommandTransition } from "../dist/workspace/agent-command-state.js";
import { captureWorkspaceProjectIdentity, freezeWorkspaceRunBinding, workspaceAgentBindingHash } from "../dist/workspace/run-binding.js";
import { createTaskExecution } from "../dist/session/task.js";
import { localWorkspaceFileTools } from "../dist/workspace/local-tools.js";
import { createAgentBoundaryExecutionGate } from "../dist/workspace/agent-boundary-execution.js";
import { createWorkspaceRunPermit, bindWorkspaceRunOptions, beginWorkspaceGovernedRun, closeWorkspaceRunPermit, workspaceRunDrainProof, executeWorkspaceTool, assertWorkspaceRunContextCurrent } from "../dist/workspace/execution.js";

import { fixture, code, fixtureDocs } from "./helpers/agent-command-control-fixture.mjs";

test("C3 capacity refuses new work before effects and retains reserved slots for an authorized stop", async t => {
  const f = fixture(t), d = f.dispatch(); d.accept(); const runtime = d.runtime(), state = f.snapshot();
  // Preload valid retained historical rejections; then exercise actual disk CAS at the capacity edge.
  const source = state.control.commands[0];
  while (state.control.commands.length < 252) {
    const command = structuredClone(source.command); command.commandId = randomUUID(); command.rootRequestId = randomUUID();
    command.intentDigest = createHash("sha256").update(agentBoundaryCommandSigningText(command)).digest("hex");
    const receipt = { ...structuredClone(source.receipt), commandId: command.commandId, rootRequestId: command.rootRequestId,
      intentDigest: command.intentDigest, status: "rejected", error: { code: "AUTHORIZATION_DENIED", retry: "never" } };
    const sequence = ++state.control.sequence;
    state.control.commands.push({ command, receipt, sequence });
    state.control.audit.push({ ...structuredClone(state.control.audit[0]), eventId: `audit_${sequence}`, sequence, commandId: command.commandId,
      decision: "rejected", code: "AUTHORIZATION_DENIED" });
  }
  fs.writeFileSync(f.file, JSON.stringify(state)+"\n", { mode: 0o600 });
  const before = fs.readFileSync(f.file, "utf8"), blocked = f.dispatch("must not start a new model or effect");
  assert.throws(() => blocked.accept(), code("AUTHORITY_UNVERIFIED")); assert.equal(fs.readFileSync(f.file, "utf8"), before);
  assert.equal(f.authority.commandControlSourceHealthy(), true);
  assert.equal(f.control.inspect(f.transport, f.agent.agentId).sourceAvailableHere, true);
  await runtime.call("workspace_write", { path: "capacity-healthy.txt", content: "already admitted" });
  assert.equal(fs.readFileSync(join(f.project, "capacity-healthy.txt"), "utf8"), "already admitted");
  const stop = f.draft({ action: "task.stop", taskId: d.task.id, runId: d.binding.runId, claimRevision: 1 });
  const stopped = f.apply(stop); assert.notEqual(stopped.status, "rejected"); assert.ok(stopped.control.holdId);
  assert.ok(f.apply(f.draft({ action: "agent.pause", reason: "human_request" })).control.holdId);
  await closeWorkspaceRunPermit(runtime.permit); f.control.observeDrained(workspaceRunDrainProof(runtime.permit));
  assert.equal(f.control.readReceipt(f.transport, f.agent.agentId, stop.commandId).execution.drain, "observed");
});

// Phase-aware private child channel. Early exit/error is a phase failure, not a later generic IPC timeout.
function commandCompetitor(t, f, label, { controlled = false, fault } = {}) {
  const release = controlled ? join(f.home, `cas-${label}-release`) : undefined;
  const child = fork(new URL("./helpers/agent-command-competitor.mjs", import.meta.url), [], { execArgv: [], silent: true });
  const messages = [], waiters = new Set(), trace = [];
  let terminal, failure, stderr = "";
  const redact = text => String(text).split(f.credential).join("[redacted]");
  const diagnostic = (phase, reason) => new Error(`CAS competitor ${label} pid=${child.pid} phase=${phase}: ${reason}; trace=${trace.join(",")}; stderr=${redact(stderr)}`);
  const flush = () => {
    for (const waiter of [...waiters]) {
      const i = messages.findIndex(value => waiter.phase === "ready" ? value.ready === true : waiter.phase === "before-commit" ? value.phase === waiter.phase : Boolean(value.receipt));
      if (waiter.phase === "exit") { if (terminal) waiter.finish(null, terminal); continue; }
      if (i >= 0) waiter.finish(null, messages.splice(i, 1)[0]);
      else if (failure || terminal) waiter.finish(diagnostic(waiter.phase, failure ?? `exit code=${terminal.code} signal=${terminal.signal}`));
    }
  };
  child.stderr.on("data", data => { stderr = (stderr + redact(data)).slice(-2048); });
  child.on("message", value => {
    if (value?.error) { failure = `helper ${value.error.phase}/${value.error.code}`; trace.push("helper-error"); }
    else { messages.push(value); trace.push(value?.phase ?? (value?.ready ? "ready" : "receipt")); }
    flush();
  });
  child.on("error", error => { failure = `process error ${error.code ?? "unknown"}`; trace.push("process-error"); flush(); });
  child.once("close", (code, signal) => { terminal = { code, signal }; trace.push("closed"); flush(); });
  const next = phase => new Promise((resolve, reject) => {
    const waiter = { phase, finish(error, value) { clearTimeout(timer); waiters.delete(waiter); if (error) reject(error); else resolve(value); } };
    const timer = setTimeout(() => waiter.finish(diagnostic(phase, "10000ms IPC deadline")), 10000);
    waiters.add(waiter); flush();
  });
  child.stdin.on("error", error => { failure = `input error ${error.code ?? "unknown"}`; flush(); });
  child.stdin.end(JSON.stringify({ home: f.home, project: f.project, workspaceId: f.row.scope.workspaceId, credential: f.credential,
    agentId: f.agent.agentId, names: ["workspace_read", "workspace_write", "workspace_verify", "task_intake", "task_checkpoint", "todo_write", "ask_user"], release, fault }));
  const stop = async () => {
    if (!terminal) {
      child.kill();
      try { await next("exit"); }
      catch (error) { if (!terminal) { child.kill("SIGKILL"); await next("exit"); } else throw error; }
    }
    assert.ok(terminal, "private child must actually close before fixture cleanup");
    return terminal;
  };
  t.after(stop);
  return { child, next, stop, release() { assert.ok(release); fs.writeFileSync(release, "release", { flag: "wx", mode: 0o600 }); },
    go() { return new Promise((resolve, reject) => child.send("go", error => error ? reject(diagnostic("go", error.code ?? "IPC closed")) : resolve())); } };
}
for (const first of ["a", "b"]) test(`C3 independent processes compete through real private CAS; only one old-epoch pause wins (${first} commits first)`, async t => {
  const f = fixture(t), revision = f.snapshot().revision;
  const children = { a: commandCompetitor(t, f, "a", { controlled: true }), b: commandCompetitor(t, f, "b", { controlled: true }) };
  const { a, b } = children;
  assert.deepEqual(await a.next("ready"), { ready: true }); assert.deepEqual(await b.next("ready"), { ready: true });
  await Promise.all([a.go(), b.go()]);
  const snapshots = await Promise.all([a.next("before-commit"), b.next("before-commit")]);
  assert.deepEqual(snapshots.map(row => row.expectedRevision), [revision, revision]);
  const winner = children[first], loser = children[first === "a" ? "b" : "a"];
  winner.release(); const won = await winner.next("receipt");
  assert.equal(won.receipt.status, "accepted"); loser.release(); const lost = await loser.next("receipt");
  assert.deepEqual(won.attempts, [{ revision, outcome: "committed" }]);
  assert.deepEqual(lost.attempts, [{ revision, outcome: "STALE_REVISION" }, { revision: revision + 1, outcome: "committed" }]);
  const results = [won, lost];
  assert.deepEqual(await Promise.all([a.next("exit"), b.next("exit")]), [{ code: 0, signal: null }, { code: 0, signal: null }]);
  assert.equal(results.filter(row => row.receipt?.status === "accepted").length, 1);
  assert.equal(results.filter(row => row.receipt?.error?.code === "STALE_REVISION").length, 1);
  const state = f.snapshot(); assert.equal(state.control.agents[0].epoch, 1); assert.equal(state.control.commands.length, 2);
  assert.equal(state.control.audit.filter(row => row.decision === "allowed").length, 1);
  assert.equal(state.control.audit.filter(row => row.decision === "rejected").length, 1);
  assert.equal(new Set(state.control.audit.map(row => row.sequence)).size, 2);
});
for (const [fault, exitCode, phase] of [["before-ready", 42, "ready"], ["after-ready", 43, "receipt"]]) test(`C3 competitor early ${fault} exit retains the failing phase and leaves no command`, async t => {
  const f = fixture(t), child = commandCompetitor(t, f, "fault", { fault });
  if (phase === "receipt") await child.next("ready");
  await assert.rejects(child.next(phase), error => error.message.includes(`phase=${phase}`) && error.message.includes(`exit code=${exitCode}`) && !error.message.includes("IPC deadline") && !error.message.includes(f.credential));
  assert.deepEqual(await child.next("exit"), { code: exitCode, signal: null });
  assert.equal(f.snapshot().control.commands.length, 0); assert.equal(f.snapshot().control.agents[0].epoch, 0);
});

test("C3 competitor cleanup waits for its exact live child after a reported failure", async t => {
  const f = fixture(t), child = commandCompetitor(t, f, "cleanup", { fault: "reported-failure" });
  await child.next("ready");
  await assert.rejects(child.next("receipt"), /helper accept\/SYNTHETIC_FAILURE/);
  assert.equal(child.child.exitCode, null); assert.equal(child.child.signalCode, null);
  const terminal = await child.stop(); assert.ok(terminal.signal);
  assert.equal(child.child.signalCode, terminal.signal); assert.equal(child.child.exitCode, terminal.code);
  assert.equal(f.snapshot().control.commands.length, 0);
});

test("C3 first migration refuses any physical lease and preserves the v1 policy until actual release", t => {
  const f = fixture(t, { noInitialize: true }), lease = f.trackLease(WorkspaceSessionLease.acquire(f.storage, randomUUID()));
  const before = fs.readFileSync(f.file, "utf8");
  assert.throws(() => f.control.initialize(f.transport), code("CONTROL_HELD")); assert.equal(fs.readFileSync(f.file, "utf8"), before);
  lease.release(); f.control.initialize(f.transport); assert.equal(f.snapshot().schemaVersion, 2);
});

test("C3 persisted protection revokes a legacy opaque RunPermit and cannot be disabled by omitting C3", async t => {
  const f = fixture(t), d = f.dispatch(); d.accept(); const protectedState = fs.readFileSync(f.file, "utf8"), legacy = JSON.parse(protectedState);
  legacy.schemaVersion = 1; delete legacy.control; fs.writeFileSync(f.file, JSON.stringify(legacy)+"\n", { mode: 0o600 });
  const abort = new AbortController(); let modelCalls = 0;
  const permit = createWorkspaceRunPermit({ binding: d.binding, catalog: f.catalog, resources: f.resources, storage: f.storage,
    connections: f.connections, lease: d.lease, cwd: f.project, signal: abort.signal,
    provider: { id: "openai", model: d.binding.connection.model, async turn() { modelCalls++; throw new Error("must not dispatch"); } },
    toolNames: [], usage: { modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0 }, updateUsage() {} });
  const options = bindWorkspaceRunOptions(permit, { ctx: { cwd: f.project, sessionId: d.binding.sessionId }, signal: abort.signal, hooks: false, approval: "auto-edit",
    taskIntake: { task: d.task, current: () => d.task } }); beginWorkspaceGovernedRun(permit, options, "pi");
  // Independent fence even if a legacy permit already exists in another process's memory.
  fs.writeFileSync(f.file, protectedState, { mode: 0o600 });
  assert.throws(() => assertWorkspaceRunContextCurrent(permit), code("AUTHORITY_UNVERIFIED"));
  assert.throws(() => executeWorkspaceTool(permit, "workspace_write", async () => { throw new Error("must not enter"); }, undefined,
    { path: "legacy-no.txt", content: "no" }, "legacy-no"), code("AUTHORITY_UNVERIFIED"));
  assert.equal(modelCalls, 0); assert.equal(fs.existsSync(join(f.project, "legacy-no.txt")), false);
  await closeWorkspaceRunPermit(permit);
});

for (const altered of ["claimRevision", "requestId", "originalIntent"]) test(`C3 each effect rejects a structurally valid altered original ${altered}`, async t => {
  const f = fixture(t), d = f.dispatch(); d.accept(); const runtime = d.runtime(), state = f.snapshot();
  if (altered === "claimRevision") state.control.runs[0].claimRevision++;
  else if (altered === "requestId") state.control.runs[0].requestId = randomUUID();
  else {
    const record = state.control.commands[0]; record.command.operation.messageDigest = "b".repeat(64);
    record.command.intentDigest = createHash("sha256").update(agentBoundaryCommandSigningText(record.command)).digest("hex");
    record.receipt.intentDigest = record.command.intentDigest;
  }
  fs.writeFileSync(f.file, JSON.stringify(state)+"\n", { mode: 0o600 });
  await assert.rejects(runtime.call("workspace_write", { path: "altered-no.txt", content: "no" }), code("AUTHORITY_UNVERIFIED"));
  assert.equal(fs.existsSync(join(f.project, "altered-no.txt")), false);
});

test("C3 downgrade observed only inside CAS stays fenced after the original file is restored", async t => {
  const f = fixture(t), healthy = f.dispatch(); healthy.accept(); const runtime = healthy.runtime(), next = f.dispatch("after cut");
  const before = fs.readFileSync(f.file, "utf8"), update = f.authority.state.update.bind(f.authority.state);
  // Inject the cross-file cut after preflight reads and restore before the caller catches it.
  f.authority.state.update = (revision, change) => {
    fs.writeFileSync(f.file, JSON.stringify({ ...JSON.parse(f.beforeMigration), revision })+"\n", { mode: 0o600 });
    try { return update(revision, change); }
    finally { fs.writeFileSync(f.file, before, { mode: 0o600 }); f.authority.state.update = update; }
  };
  assert.throws(() => next.accept(), code("AUTHORITY_UNVERIFIED"));
  assert.equal(fs.readFileSync(f.file, "utf8"), before); assert.equal(f.authority.commandControlSourceHealthy(), false);
  await assert.rejects(runtime.call("workspace_write", { path: "restored-cut-no.txt", content: "no" }), code("AUTHORITY_UNVERIFIED"));
  assert.equal(fs.existsSync(join(f.project, "restored-cut-no.txt")), false);
  assert.ok(f.apply(f.draft({ action: "task.stop", taskId: healthy.task.id, runId: healthy.binding.runId, claimRevision: 1 })).control.holdId);
});

test("C3 an invalid trusted transition still permanently fences the source and healthy effects", async t => {
  const f = fixture(t), d = f.dispatch(); d.accept(); const runtime = d.runtime();
  const before = fs.readFileSync(f.file, "utf8"), snapshot = f.authority.commandControlState();
  assert.throws(() => f.authority.observeCommandControl(snapshot.revision, state => {
    state.runs[0].requestId = randomUUID(); return state;
  }), code("AUTHORITY_UNVERIFIED"));
  assert.equal(fs.readFileSync(f.file, "utf8"), before); assert.equal(f.authority.commandControlSourceHealthy(), false);
  await assert.rejects(runtime.call("workspace_write", { path: "invalid-transition-no.txt", content: "no" }), code("AUTHORITY_UNVERIFIED"));
  assert.equal(fs.existsSync(join(f.project, "invalid-transition-no.txt")), false);
});

test("C3 a real private-lock publication failure preserves the ledger and permanently fences old effects", async t => {
  const f = fixture(t), d = f.dispatch(); d.accept(); const runtime = d.runtime();
  const pause = f.draft({ action: "agent.pause", reason: "human_request" }), lockPath = join(f.file, "..", "workspace-agent-authority-v1.lock"), before = fs.readFileSync(f.file, "utf8");
  // The real CAS writer must refuse a non-file in its exact private lock slot.
  fs.mkdirSync(lockPath, { mode: 0o700 });
  try { assert.throws(() => f.apply(pause), code("AUTHORITY_UNVERIFIED")); }
  finally { fs.rmdirSync(lockPath); }
  assert.equal(fs.readFileSync(f.file, "utf8"), before); assert.equal(f.authority.commandControlSourceHealthy(), false);
  await assert.rejects(runtime.call("workspace_write", { path: "failed-writer-no.txt", content: "no" }), code("AUTHORITY_UNVERIFIED"));
  assert.equal(fs.existsSync(join(f.project, "failed-writer-no.txt")), false);
  const stop = f.draft({ action: "task.stop", taskId: d.task.id, runId: d.binding.runId, claimRevision: 1 });
  assert.ok(f.apply(stop).control.holdId); assert.equal(f.control.inspect(f.transport, f.agent.agentId).sourceAvailableHere, false);
});
