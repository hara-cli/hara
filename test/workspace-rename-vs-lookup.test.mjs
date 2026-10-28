import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { LocalWorkspaceHost } from "../dist/workspace/local-host.js";
import { WorkspaceResources } from "../dist/workspace/resources.js";
import { prepareWorkspaceStartContext, workspaceRenameIntent } from "../dist/workspace/start-context.js";
import { WorkspaceColleagueReferences } from "../dist/workspace/colleague-references.js";
import { storageFixture, gate } from "./helpers/workspace-user-interaction.mjs";

const RENAME = "把负责程序的同事改名嘉夫";
function roster(t, colleagues) {
  const { root, storage } = storageFixture(t), resources = new WorkspaceResources(root, storage.scope); resources.initialize();
  resources.agents.initializeMain();
  const created = colleagues.map(([username, displayName, title]) =>
    resources.agents.create({ username, profile: { displayName, title } }, resources.agents.list().revision));
  const references = () => new WorkspaceColleagueReferences(storage, () => resources.agents.references()).read();
  return { storage, resources, created, references };
}

test("rename intent separates the existing colleague from the user-supplied new name", () => {
  assert.deepEqual(workspaceRenameIntent(RENAME), { target: "负责程序的同事", newName: "嘉夫" });
  assert.deepEqual(workspaceRenameIntent("把 Coder 重命名为「嘉夫」"), { target: "Coder", newName: "嘉夫" });
  assert.deepEqual(workspaceRenameIntent("Please rename the coding colleague to Jiafu."), { target: "the coding colleague", newName: "Jiafu" });
  for (const objective of ["Mori 是谁", "找一下 Mori 的笔记", "改一下 README.md"]) assert.equal(workspaceRenameIntent(objective), null);
});

test("a descriptive rename target resolves by roster title and the new name never counts as a miss", t => {
  const r = roster(t, [["coder", "Coder", "负责程序开发"], ["designer", "Designer", "负责视觉设计"]]);
  const packet = prepareWorkspaceStartContext({ storage: r.storage, workspaceRoots: [], references: r.references(), objective: RENAME });
  assert.equal(packet.initialQuestion, null);
  assert.deepEqual(packet.rename, { target: "负责程序的同事", newName: "嘉夫" });
  const target = packet.lookup("负责程序的同事");
  assert.equal(target.status, "resolved"); assert.equal(target.candidates[0].agentId, r.created[0].agentId);
  const newName = packet.lookup("嘉夫");
  assert.equal(newName.status, "rename_new_name");
  assert.ok(packet.prompt.includes('"renameRequest"') && packet.prompt.includes('"title":"负责程序开发"'));
  const a = gate(t); a.interaction.prepared();
  for (const result of [newName, newName]) a.interaction.observe("workspace_context_lookup", JSON.stringify(result), false);
  a.interaction.observe("workspace_context_lookup", JSON.stringify(target), false);
  assert.equal(a.interaction.question(), null, "rename lookups must not trip lookup_missing");
});

test("a role shared by several colleagues asks which one instead of a generic missing-target pause", t => {
  const r = roster(t, [["coder", "Coder", "负责程序开发"], ["backend", "Backend", "后端程序"]]);
  const packet = prepareWorkspaceStartContext({ storage: r.storage, workspaceRoots: [], references: r.references(), objective: RENAME });
  const result = packet.lookup("负责程序的同事");
  assert.equal(result.status, "ambiguous"); assert.equal(result.candidates.length, 2);
  const a = gate(t); a.interaction.prepared();
  a.interaction.observe("workspace_context_lookup", JSON.stringify(result), false);
  assert.equal(a.interaction.question().reason, "lookup_ambiguous");
  assert.equal(a.interaction.question().options.length, 2);
});

test("a genuinely unknown name still pauses with lookup_missing after two misses, even in a rename request", t => {
  const r = roster(t, [["coder", "Coder", "负责程序开发"]]);
  for (const objective of ["Mori 去哪了", "把 Mori 改名嘉夫"]) {
    const packet = prepareWorkspaceStartContext({ storage: r.storage, workspaceRoots: [], references: r.references(), objective });
    const missing = packet.lookup("Mori");
    assert.notEqual(missing.status, "resolved"); assert.notEqual(missing.status, "rename_new_name");
    const a = gate(t); a.interaction.prepared();
    a.interaction.observe("workspace_context_lookup", JSON.stringify(missing), false);
    a.interaction.observe("workspace_memory_search", JSON.stringify({ hits: [] }), false);
    assert.equal(a.interaction.question().reason, "lookup_missing");
  }
  const plain = prepareWorkspaceStartContext({ storage: r.storage, workspaceRoots: [], references: r.references(), objective: "Mori 去哪了" });
  assert.notEqual(plain.lookup("嘉夫").status, "rename_new_name", "only an explicit rename request exempts its new name");
});

test("rename keeps the persona, makes the former name an alias, and refuses the main agent", t => {
  const r = roster(t, [["coder", "Coder", "负责程序开发"]]), before = r.created[0];
  const after = r.resources.agents.rename(before.agentId, "嘉夫", before.configRevision, before.agentEpoch);
  assert.equal(after.identity.displayName, "嘉夫"); assert.equal(after.identity.title, "负责程序开发"); assert.equal(after.username, "coder");
  const packet = prepareWorkspaceStartContext({ storage: r.storage, workspaceRoots: [], references: r.references(), objective: "Coder 是谁" });
  assert.equal(packet.lookup("Coder").candidates[0].name, "嘉夫");
  const main = r.resources.agents.list().agents.find(agent => agent.kind === "main");
  assert.throws(() => r.resources.agents.rename(main.agentId, "Other", main.configRevision, main.agentEpoch), /only a Workspace colleague/);
  assert.throws(() => r.resources.agents.rename(after.agentId, "Again", before.configRevision, before.agentEpoch), /changed/);
});

const call = (name, input = {}) => ({ text: "", toolUses: [{ id: randomUUID(), name, input }], stop: "tool_use", usage: { input: 20, output: 5 } });
test("end to end: 把负责程序的同事改名嘉夫 renames the colleague without a lookup_missing question", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "hara-rename-gate-")));
  let requests = 0, coderId;
  const host = new LocalWorkspaceHost(root, { providerFactory(_connection, binding) { return { id: "openai", model: binding.model, async turn(args) {
    requests++;
    assert.ok(args.tools.some(tool => tool.name === "agent_rename"));
    if (requests === 1) return call("workspace_context_lookup", { query: "嘉夫" });
    if (requests === 2) return call("workspace_context_lookup", { query: "负责程序的同事" });
    if (requests === 3) {
      const resolved = JSON.parse(args.history.flatMap(row => row.role === "tool" ? row.results : []).at(-1).content);
      assert.equal(resolved.status, "resolved"); coderId = resolved.candidates[0].agentId;
      const turn = call("task_intake", { intent: "change", goal: RENAME, constraints: ["synthetic only"], acceptance: ["colleague display name is 嘉夫"], steps: ["rename", "reply"] });
      turn.toolUses.push(call("agent_rename", { agentId: coderId, displayName: "嘉夫" }).toolUses[0]); return turn;
    }
    return { text: "已把负责程序的同事改名为嘉夫。", toolUses: [], stop: "end", usage: { input: 20, output: 5 } };
  } }; } });
  try {
    const workspace = host.createWorkspace("Synthetic", host.list().revision), workspaceId = workspace.workspaceId;
    host.configureSynthetic(workspaceId, 0); host.select("client", workspaceId, host.list().revision);
    const resources = new WorkspaceResources(host.home, host.catalog.resolve(workspaceId).scope); resources.initialize();
    resources.agents.create({ username: "coder", profile: { displayName: "Coder", title: "负责程序开发" } }, resources.agents.list().revision);
    const run = host.start("client", workspaceId, workspace.selectedAgentId, RENAME, randomUUID()); await host.wait(run.runId);
    const conversation = host.snapshot(workspaceId, workspace.selectedAgentId, "client").conversation;
    assert.equal(conversation.pendingQuestion ?? null, null, "no lookup_missing card");
    assert.equal(JSON.stringify(conversation).includes("两次查找仍未确认目标"), false);
    const renamed = resources.agents.get(coderId);
    assert.equal(renamed.identity.displayName, "嘉夫"); assert.equal(renamed.identity.title, "负责程序开发");
    const result = conversation.history.flatMap(row => row.role === "tool" ? row.results : []).find(row => row.name === "agent_rename");
    assert.equal(result.isError ?? false, false); assert.equal(JSON.parse(result.content).previousName, "Coder");
  } finally { await host.close(); rmSync(root, { recursive: true, force: true }); }
});
