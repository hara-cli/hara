// Test-only independent process: actual private authority, actual authenticated transport, actual CAS.
import { LocalWorkspaceCatalog } from "../../dist/workspace/local-catalog.js";
import { WorkspaceResources } from "../../dist/workspace/resources.js";
import { WorkspaceResourceStorage, currentWorkspaceResourceBinding } from "../../dist/workspace/resource-context.js";
import { WorkspaceAgentBoundaryAuthority } from "../../dist/workspace/agent-boundary-authority.js";
import { AgentBoundaryTransports } from "../../dist/workspace/agent-boundary-transport.js";
import { WorkspaceAgentCommandControl } from "../../dist/workspace/agent-command-control.js";
import { captureWorkspaceProjectIdentity } from "../../dist/workspace/run-binding.js";
import { randomUUID } from "node:crypto";
let run;
process.on("message", message => { if (message === "go") run?.(); });
let input = ""; for await (const chunk of process.stdin) input += chunk;
const value = JSON.parse(input), catalog = new LocalWorkspaceCatalog(value.home), row = catalog.resolve(value.workspaceId);
const storage = new WorkspaceResourceStorage(value.home, row.scope), resources = new WorkspaceResources(value.home, row.scope);
resources.initialize(); storage.initialize();
const transports = new AgentBoundaryTransports(value.credential), transport = transports.connect(`competitor_${process.pid}`, value.credential);
const root = captureWorkspaceProjectIdentity(value.project), binding = storage.run(() => currentWorkspaceResourceBinding());
const authority = new WorkspaceAgentBoundaryAuthority({ catalog, storage, resources, transports, commandControl: true,
  toolsForAgent: () => value.names.map(toolId => ({ toolId, connectorId: null, catalogRevision: 1, assertCurrent() {} })),
  resourcesForAgent: () => [{ resourceId: "files", agentId: value.agentId, revision: 1, binding, project: root, access: ["read", "write"], assertCurrent() {} }] });
const control = new WorkspaceAgentCommandControl(authority);
const command = authority.draft(transport, value.agentId, { commandId: randomUUID(), rootRequestId: randomUUID(), lifetimeMs: 30000,
  operation: { action: "agent.pause", reason: "human_request" } });
run = () => {
  try { const intake = control.begin(transport, command).intake; const receipt = control.accept(intake); process.send({ receipt }); }
  catch (error) { process.send({ error: { code: error.code, message: error.message } }); }
  finally { authority.close(); transports.close(); process.disconnect(); }
};
process.send({ ready: true });
