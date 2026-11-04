import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { LocalWorkspaceHost } from "../dist/workspace/local-host.js";
import { MemoryCredentialVault } from "../dist/workspace/credential-vault.js";
import { workspaceOperationSkill } from "../dist/workspace/operation-cards.js";
import { SYNTHETIC_CONNECTION } from "../dist/workspace/synthetic-provider.js";
import { planLegacyResources, WorkspaceLegacyResources } from "../dist/workspace/legacy-resources.js";

async function fixture(t, count = 20, proposal = {
  username: "video-helper", displayName: "Video Helper", title: "Video project", instructions: "Manage video work." }) {
  const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "hara-chat-create-")));
  let calls = 0; const systems = [];
  const host = new LocalWorkspaceHost(root, { credentialVault: new MemoryCredentialVault(),
    providerFactory(_connection, binding) { return { id: "openai", model: binding.model, async turn(args) {
      calls++; systems.push(args.system);
      if (args.history.some(row => row.role === "tool" && row.results.some(result => result.name === "agent_create")))
        return { text: "已处理同事草稿。", stop: "end", toolUses: [] };
      assert.equal(args.tools.some(tool => tool.name === "agent_create"), true);
      return { text: "", stop: "tool_use", toolUses: [{ id: randomUUID(), name: "agent_create", input: proposal }] };
    } }; } });
  t.after(async () => { await host.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const ws = host.createWorkspace("Video workspace", host.list().revision), id = ws.workspaceId, main = ws.selectedAgentId;
  host.configureSynthetic(id, 0); const context = host.context(id), agent = context.resources.agents.get(main);
  context.resources.agents.setPermissionTier(main, "controlled", agent.configRevision, agent.agentEpoch);
  for (let index = 0; index < count; index++) context.resources.agents.create({ username: `existing-${index}`, profile: {
    displayName: index < 2 ? `Video Helper ${index + 1}` : `Existing ${index}`, title: "Video and design helper" }, instructions: "Long biography. ".repeat(50) }, context.resources.agents.list().revision);
  const rows = planLegacyResources({ jobs: [], projects: ["/known/video", "/known/design"].map(path => ({ path })), legacyWorkspacePath: "/known/resources" });
  await new WorkspaceLegacyResources(context.storage).domain("a".repeat(64), rows).apply();
  host.select("client", id, host.list().revision);
  return { host, id, main, calls: () => calls, systems: () => systems };
}
async function cardFor(f) {
  const run = f.host.start("client", f.id, f.main, "建一个负责 video 项目的同事", randomUUID());
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const card = f.host.snapshot(f.id, f.main, "client").approvals[0];
    if (card) return { run, card };
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const view = f.host.snapshot(f.id, f.main, "client");
  throw new Error("draft card was not shown: " + JSON.stringify({ calls: f.calls(), state: view.conversation.state, block: view.conversation.blockReason,
    history: view.conversation.history.map(row => row.role === "tool" ? row.results.map(result => ({ name: result.name, content: result.content.slice(0, 500), error: result.isError })) : row.role) }));
}

test("one model call reaches an editable scoped card with 20 long-bio colleagues and project choices", async t => {
  const f = await fixture(t), started = Date.now(), { run, card } = await cardFor(f);
  t.diagnostic(`model calls to card=${f.calls()}, elapsedMs=${Date.now() - started}`);
  assert.equal(f.calls(), 1); assert.equal(card.kind, "agent_create");
  assert.equal(card.draft.runtimeId, "pi"); assert.equal(card.draft.permissionTier, "full-protected");
  assert(card.projectOptions.some(option => option.endsWith(": /known/video")));
  assert(card.projectOptions.some(option => option.endsWith(": /known/design")));
  const pending = f.host.snapshot(f.id, f.main, "client");
  assert.equal(pending.conversation.history.some(row => row.role === "tool" && row.results.some(result => ["workspace_receipt_read", "ask_user"].includes(result.name))), false);
  const edited = { ...card.draft, username: "video-owner", displayName: "Video Owner", title: "Video lead", project: card.projectOptions.find(option => option.endsWith(": /known/video")), permissionTier: "controlled" };
  assert.throws(() => f.host.answerApproval("other", f.id, card.id, true, edited), /approval/);
  assert.throws(() => f.host.answerApproval("client", f.id, card.id, true, { ...edited, runtimeId: "agy" }), /unavailable/);
  assert.throws(() => f.host.answerApproval("client", f.id, card.id, true, { ...edited, permissionTier: "invalid" }), /Invalid/);
  const confirmed = Date.now(); f.host.answerApproval("client", f.id, card.id, true, edited);
  assert.throws(() => f.host.answerApproval("client", f.id, card.id, true, edited), /approval/);
  await f.host.wait(run.runId);
  t.diagnostic(`confirmation to rosterMs=${Date.now() - confirmed}`);
  const after = f.host.snapshot(f.id, f.main, "client");
  assert.equal(f.calls(), 1, "the Host closes the verified creation without asking the model again");
  assert.equal(after.agents.length, 22);
  const created = after.agents.find(row => row.username === "video-owner");
  assert.equal(created.identity.displayName, "Video Owner"); assert.equal(created.identity.title, "Video lead");
  assert.equal(created.runtime.id, "pi"); assert.equal(created.permissionTier, "controlled");
  assert.equal(f.host.context(f.id).resources.agents.currentPersona(created.agentId).instructions.includes("/known/video"), true);
});

test("a changed roster rejects the original draft without creating a colleague", async t => {
  const f = await fixture(t, 1), { run, card } = await cardFor(f);
  const agents = f.host.context(f.id).resources.agents;
  agents.create({ username: "other-new", profile: { displayName: "Other new", title: "Other" } }, agents.list().revision);
  assert.throws(() => f.host.answerApproval("client", f.id, card.id, true, card.draft), /roster changed/);
  assert.equal(f.host.snapshot(f.id, f.main, "client").agents.some(row => row.username === "video-helper"), false);
  f.host.answerApproval("client", f.id, card.id, false); await f.host.wait(run.runId);
});

test("invalid model fields become an empty human-editable draft", async t => {
  const f = await fixture(t, 0, {}), { run, card } = await cardFor(f);
  assert.equal(f.calls(), 1); assert.equal(card.draft.username, ""); assert.equal(card.draft.displayName, "");
  assert.match(card.draft.instructions, /video/);
  f.host.answerApproval("client", f.id, card.id, true, { ...card.draft,
    username: "video-owner", displayName: "Video Owner", title: "Video lead", instructions: "Own video work." });
  await f.host.wait(run.runId);
  assert.equal(f.calls(), 1); assert.equal(f.host.snapshot(f.id, f.main, "client").agents.length, 2);
});

test("active and archived usernames remain reserved", async t => {
  const f = await fixture(t, 1), agents = f.host.context(f.id).resources.agents;
  const duplicate = { username: "existing-0", profile: { displayName: "Another", title: "Another role" } };
  assert.throws(() => agents.create(duplicate, agents.list().revision), /retained/);
  const original = agents.list().agents.find(row => row.username === "existing-0");
  agents.setArchived(original.agentId, true, original.configRevision, original.agentEpoch);
  assert.throws(() => agents.create(duplicate, agents.list().revision), /retained/);
});

test("project candidate revoked after card publication cannot be confirmed", async t => {
  const f = await fixture(t, 1), { run, card } = await cardFor(f);
  const candidate = card.projectOptions.find(row => row.endsWith(": /known/video"));
  assert(candidate);
  const original = WorkspaceLegacyResources.prototype.directoryReferencesForHost;
  WorkspaceLegacyResources.prototype.directoryReferencesForHost = () => [];
  try { assert.throws(() => f.host.answerApproval("client", f.id, card.id, true, { ...card.draft, project: candidate }), /Project candidate changed/); }
  finally { WorkspaceLegacyResources.prototype.directoryReferencesForHost = original; }
  f.host.answerApproval("client", f.id, card.id, false); await f.host.wait(run.runId);
  assert.equal(f.host.snapshot(f.id, f.main, "client").agents.length, 2);
});



test("explicit colleague creation receives the complete version-locked card before its first model call", async t => {
  const f = await fixture(t, 0), { run, card } = await cardFor(f);
  const system = f.systems()[0], skill = workspaceOperationSkill(), file = "cards/create-colleague.md";
  assert.equal(f.calls(), 1);
  assert.equal(system.includes(skill.files[file]), true, "complete current card must already be available without index/card tool calls");
  assert.equal(system.includes(skill.version), true, "preloaded help is bound to the shipped version");
  assert.equal(system.includes(file), true);
  assert.equal(system.includes("load every page of instructions via workspace_skill before acting"), false,
    "generic preread must not contradict the first-response creation contract");
  for (const name of Object.keys(skill.files).filter(name => name !== "SKILL.md" && name !== file))
    assert.equal(system.includes(skill.files[name]), false, "unrelated operation cards remain on demand");
  assert.equal(card.kind, "agent_create");
  assert.equal(f.host.snapshot(f.id, f.main, "client").agents.length, 1, "preloaded instructions grant no creation authority");
  f.host.answerApproval("client", f.id, card.id, false); await f.host.wait(run.runId);
  assert.equal(f.host.snapshot(f.id, f.main, "client").agents.length, 1);
});
