// Test-only processes: the original private authority, authenticated transport, lock and CAS remain real.
import { LocalWorkspaceCatalog } from "../../dist/workspace/local-catalog.js";
import { WorkspaceResources } from "../../dist/workspace/resources.js";
import { WorkspaceResourceStorage, currentWorkspaceResourceBinding } from "../../dist/workspace/resource-context.js";
import { WorkspaceAgentBoundaryAuthority } from "../../dist/workspace/agent-boundary-authority.js";
import { AgentBoundaryTransports } from "../../dist/workspace/agent-boundary-transport.js";
import { WorkspaceAgentCommandControl } from "../../dist/workspace/agent-command-control.js";
import { captureWorkspaceProjectIdentity } from "../../dist/workspace/run-binding.js";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
let run, authority, transports, phase = "input";
const send = value => new Promise((done, reject) => process.send(value, error => error ? reject(error) : done()));
const close = () => { authority?.close(); transports?.close(); if (process.connected) process.disconnect(); };
process.on("message", message => { if (message === "go" && run) { const action = run; run = null; void action(); } });
async function main() {
  let input = ""; for await (const chunk of process.stdin) input += chunk;
  const value = JSON.parse(input);
  if (value.fault === "before-ready") { process.exitCode = 42; close(); return; }
  phase = "authority";
  const catalog = new LocalWorkspaceCatalog(value.home), row = catalog.resolve(value.workspaceId);
  const storage = new WorkspaceResourceStorage(value.home, row.scope), resources = new WorkspaceResources(value.home, row.scope);
  resources.initialize(); storage.initialize();
  transports = new AgentBoundaryTransports(value.credential);
  const transport = transports.connect(`competitor_${process.pid}`, value.credential);
  const root = captureWorkspaceProjectIdentity(value.project), binding = storage.run(() => currentWorkspaceResourceBinding());
  authority = new WorkspaceAgentBoundaryAuthority({ catalog, storage, resources, transports, commandControl: true,
    toolsForAgent: () => value.names.map(toolId => ({ toolId, connectorId: null, catalogRevision: 1, assertCurrent() {} })),
    resourcesForAgent: () => [{ resourceId: "files", agentId: value.agentId, revision: 1, binding, project: root, access: ["read", "write"], assertCurrent() {} }] });
  const control = new WorkspaceAgentCommandControl(authority);
  const command = authority.draft(transport, value.agentId, { commandId: randomUUID(), rootRequestId: randomUUID(), lifetimeMs: 30000,
    operation: { action: "agent.pause", reason: "human_request" } });
  const attempts = [], originalUpdate = authority.update.bind(authority);
  // Interpose ONLY in this helper, after the real transactCommand snapshot and before its real update/lock.
  // No fixture state or approval is fabricated. Both processes must reach the same stale revision first.
  authority.update = (...args) => {
    if (attempts.length === 0 && value.release) {
      if (dirname(resolve(value.release)) !== resolve(value.home)) throw new Error("invalid private gate");
      phase = "before-commit"; process.send({ phase, expectedRevision: args[0] });
      const deadline = Date.now() + 10000, wake = new Int32Array(new SharedArrayBuffer(4));
      while (!existsSync(value.release)) {
        if (Date.now() >= deadline) throw new Error("private commit gate deadline");
        Atomics.wait(wake, 0, 0, 10); // Poll an explicit parent release, never guess the other process's timing.
      }
    }
    phase = "commit";
    try { const result = originalUpdate(...args); attempts.push({ revision: args[0], outcome: "committed" }); return result; }
    catch (error) { attempts.push({ revision: args[0], outcome: error.code ?? "error" }); throw error; }
  };
  run = async () => {
    try {
      phase = "begin"; const intake = control.begin(transport, command).intake;
      phase = "accept"; const receipt = control.accept(intake);
      await send({ receipt, attempts }); // Wait for actual IPC flush before disconnecting.
    } catch (error) { await send({ error: { phase, code: error.code ?? "COMPETITOR_FAILED" } }); process.exitCode = 1; }
    finally { close(); }
  };
  phase = "ready"; await send({ ready: true });
  if (value.fault === "after-ready") { run = null; process.exitCode = 43; close(); }
  if (value.fault === "reported-failure") { run = null; await send({ error: { phase: "accept", code: "SYNTHETIC_FAILURE" } }); }
}
main().catch(async () => {
  try { await send({ error: { phase, code: "COMPETITOR_FAILED" } }); } catch { /* Parent already closed. No private input is printed. */ }
  process.exitCode = 1; close();
});
