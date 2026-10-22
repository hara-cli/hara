import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { LocalWorkspaceHost } from "../../dist/workspace/local-host.js";
import { LocalWorkspaceCatalog } from "../../dist/workspace/local-catalog.js";
import { WorkspaceResourceStorage } from "../../dist/workspace/resource-context.js";
import { WorkspaceUserInteraction } from "../../dist/workspace/user-interaction.js";

function storageFixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "hara-user-interaction-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const catalog = new LocalWorkspaceCatalog(root), scope = catalog.create("Synthetic", 1).scope;
  const storage = new WorkspaceResourceStorage(root, scope); storage.initialize();
  return { root, storage };
}
function gate(t) {
  const fixture = storageFixture(t), binding = { runId: randomUUID(), budget: { maxRounds: 10, maxToolCalls: 10, maxTokens: 100, timeoutMs: 1000 } }, taskId = randomUUID();
  const open = () => new WorkspaceUserInteraction(fixture.storage, binding, taskId, false);
  return { ...fixture, binding, open, interaction: open() };
}
const emptyUsage = () => ({ modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0 });
function hostFixture(t, responder) {
  const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "hara-user-question-host-"))), turns = [];
  const options = { providerFactory(_connection, binding) { return { id: "openai", model: binding.model, async turn(args) {
    turns.push(args); return { usage: { input: 100, output: 20 }, ...responder(turns.length, args) };
  } }; } };
  const host = new LocalWorkspaceHost(root, options);
  t.after(async () => { await host.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const workspace = host.createWorkspace("Synthetic", host.list().revision);
  host.configureSynthetic(workspace.workspaceId, 0); host.select("client", workspace.workspaceId, host.list().revision);
  const storage = new WorkspaceResourceStorage(host.home, host.catalog.resolve(workspace.workspaceId).scope); storage.initialize();
  return { root, host, workspace, storage, turns, options };
}
const tools = (...calls) => ({ text: "", toolUses: calls.map(([name, input]) => ({ id: randomUUID(), name, input })), stop: "tool_use" });
const lookup = query => ["workspace_context_lookup", { query }];

export { storageFixture, gate, emptyUsage, hostFixture, tools, lookup };
