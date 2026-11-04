import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { hostFixture, storageFixture, tools } from "./helpers/workspace-user-interaction.mjs";
import { LocalWorkspaceCatalog } from "../dist/workspace/local-catalog.js";
import { WorkspaceJsonState } from "../dist/workspace/local-state.js";
import { WorkspaceConversationStore } from "../dist/workspace/conversations.js";
import { WorkspaceResourceStorage, workspaceStateHome, bindWorkspaceResourceFile } from "../dist/workspace/resource-context.js";
import { prepareWorkspaceManagementContext } from "../dist/workspace/management-context.js";

async function until(check) { for (let n = 0; n < 400; n++) { const value = check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error("synthetic state not reached"); }
const origin = { source: "ui", channel: "rpc", clientId: "client" };

test("startup catalog bounds complete JSON and redacts metadata without loading skill instructions", () => {
  const agents = Array.from({ length: 20 }, (_, n) => ({ agentId: `ag_${randomUUID()}`, state: "active", identity: { displayName: `Peer ${n}`, title: "Editor", bio: "PRIVATE_BIO" }, runtime: { id: "pi" }, instructions: "PRIVATE_INSTRUCTIONS" }));
  const skills = Array.from({ length: 100 }, (_, n) => ({ id: `skill-${n}`, description: "description ".repeat(200), version: "a".repeat(64), source: "private", enabled: n !== 0, files: { "SKILL.md": "NEVER_LOAD_USER_SKILL_INSTRUCTIONS_AUTOMATICALLY" } }));
  const { packet, prompt } = prepareWorkspaceManagementContext({ agents, skills, objective: "建立一个bot负责video" });
  assert.ok(Buffer.byteLength(JSON.stringify(packet)) <= 8000); assert.equal(packet.roster.agents.length, 20); assert.equal(packet.skills.truncated, true);
  assert.equal(packet.operations[0].id, "create-colleague"); assert.equal(packet.skills.items.some(row => row.id === "skill-0"), false);
  assert.equal(prompt.includes("PRIVATE_BIO"), false); assert.equal(prompt.includes("PRIVATE_INSTRUCTIONS"), false);
  assert.equal(prompt.includes("NEVER_LOAD_USER_SKILL_INSTRUCTIONS_AUTOMATICALLY"), false);
  assert.match(prompt, /no authority or completion evidence/); assert.match(prompt, /version-locked/);
});

test("startup help never grants an execution binding or creates an accepted brief", () => {
  const { packet } = prepareWorkspaceManagementContext({ agents: [], skills: [], objective: "你好" });
  assert.equal(packet.catalog_only, true); assert.deepEqual(packet.operations, []);
  assert.equal(packet.workspaceRunBinding, undefined); assert.equal(packet.brief, undefined);
});

test("preloaded roster/card/projects reach the original approval in one model round, without task_intake or lookup rounds", async t => {
  const a = hostFixture(t, n => n === 1 ? tools(["agent_create", { username: "video-new", displayName: "Video New", title: "video project", instructions: "Work on the user requested video project" }])
    : { text: "The human declined; nothing was created.", toolUses: [], stop: "end" });
  const context = a.host.context(a.workspace.workspaceId);
  for (let n = 0; n < 20; n++) context.resources.agents.create({ username: `peer-${n}`, profile: { displayName: `Peer ${n}`, bio: "Long private bio. ".repeat(100) }, instructions: "Never include these instructions. ".repeat(100) }, context.resources.agents.list().revision);
  const run = a.host.start("client", a.workspace.workspaceId, a.workspace.selectedAgentId, "建一個bot負責video項目", randomUUID(), false, undefined, undefined, origin);
  const card = await until(() => a.host.snapshot(a.workspace.workspaceId, a.workspace.selectedAgentId, "client").approvals[0]);
  assert.equal(a.turns.length, 1); assert.match(a.turns[0].system, /"create-colleague"/); assert.match(a.turns[0].system, /"projectLocations"/); assert.match(a.turns[0].system, /catalog_only/);
  const value = new WorkspaceConversationStore(a.storage, a.workspace.selectedAgentId).read(); assert.equal(value.task.brief.intent, "change");
  assert.equal(context.resources.agents.list().agents.length, 21); assert.equal(value.history.some(row => row.role === "assistant" && row.toolUses.some(call => call.name === "task_intake")), false);
  assert.throws(() => a.host.answerApproval("different-client", a.workspace.workspaceId, card.id, true), /approval/);
  a.host.answerApproval("client", a.workspace.workspaceId, card.id, false); await a.host.wait(run.runId);
  assert.equal(context.resources.agents.list().agents.length, 21);
});

test("preparing an answer brief cannot authorize a write", async t => {
  const a = hostFixture(t, n => n === 1 ? tools(["workspace_write", { path: "forbidden.txt", content: "must not write" }]) : { text: "Hello", toolUses: [], stop: "end" });
  const run = a.host.start("client", a.workspace.workspaceId, a.workspace.selectedAgentId, "你好", randomUUID(), false, undefined, undefined, origin); await a.host.wait(run.runId);
  assert.equal(fs.existsSync(join(a.host.context(a.workspace.workspaceId).project, "forbidden.txt")), false);
});

function stateFixture(t) {
  const a = storageFixture(t), state = new WorkspaceJsonState(a.storage, "cache-proof.json", value => value, () => ({ revision: 0, value: "empty" }));
  state.update(0, value => ({ ...value, value: "first" }));
  const file = a.storage.run(() => join(workspaceStateHome(), ".hara", "cache-proof.json")); return { ...a, state, file };
}
test("cached directory proofs still read fresh bytes and cannot be poisoned by callers", t => {
  const a = stateFixture(t); assert.equal(a.state.read().value, "first");
  const first = a.storage.run(() => bindWorkspaceResourceFile(a.file)); assert.equal(Object.isFrozen(first.directory), true);
  assert.throws(() => { first.directory.ino = -1; }, TypeError); first.path = "/untrusted/path";
  assert.equal(a.storage.run(() => bindWorkspaceResourceFile(a.file)).path, a.file);
  fs.writeFileSync(a.file, JSON.stringify({ revision: 2, value: "changed" }), { mode: 0o600 }); assert.equal(a.state.read().value, "changed");
});
for (const kind of ["symbolic", "hard", "directory", "permissions"]) test(`cached file proof refuses ${kind} replacement without changing the foreign file`, t => {
  const a = stateFixture(t); a.state.read();
  const foreign = join(a.root, "foreign.json"), text = JSON.stringify({ revision: 1, value: "foreign" }); fs.writeFileSync(foreign, text, { mode: 0o600 });
  if (kind === "permissions") fs.chmodSync(dirname(a.file), 0o755);
  else if (kind === "directory") { const dir = dirname(a.file); fs.renameSync(dir, dir + "-held"); fs.mkdirSync(dir, { mode: 0o700 }); fs.writeFileSync(a.file, text, { mode: 0o600 }); }
  else { fs.unlinkSync(a.file); if (kind === "symbolic") fs.symlinkSync(foreign, a.file); else fs.linkSync(foreign, a.file); }
  assert.throws(() => a.state.read(), /link|identity|changed|private|directory/i); assert.equal(fs.readFileSync(foreign, "utf8"), text);
});
test("cached bindings still consult the live authority fence", t => {
  const a = stateFixture(t); let revoked = false;
  const storage = new WorkspaceResourceStorage(a.root, a.storage.scope, () => { if (revoked) throw new Error("revoked authority"); }); storage.initialize();
  const state = new WorkspaceJsonState(storage, "cache-proof.json", value => value, () => ({ revision: 0 })); assert.equal(state.read().value, "first");
  revoked = true; assert.throws(() => state.read(), /revoked authority/);
});


test("catalog directory proofs keep grant data live rather than caching authority", t => {
  const a = storageFixture(t), catalog = new LocalWorkspaceCatalog(a.root); catalog.resolve(a.storage.scope.workspaceId);
  const file = join(a.root, ".hara/workspace-local-dev/catalog-v2.json"), raw = JSON.parse(fs.readFileSync(file)); raw.workspaces[0].grantRevision++;
  fs.writeFileSync(file, JSON.stringify(raw), { mode: 0o600 });
  assert.equal(catalog.resolve(a.storage.scope.workspaceId).grantRevision, raw.workspaces[0].grantRevision);
  catalog.revoke(a.storage.scope.workspaceId, catalog.read().revision); assert.throws(() => catalog.resolve(a.storage.scope.workspaceId), /unavailable|revoked/);
});
for (const target of ["private-root", "catalog-directory", "permissions"]) test(`catalog proof rejects ${target} replacement after warm reads`, t => {
  const a = storageFixture(t), catalog = new LocalWorkspaceCatalog(a.root); catalog.read();
  const root = join(a.root, ".hara"), directory = join(root, "workspace-local-dev"), file = join(directory, "catalog-v2.json"), original = fs.readFileSync(file);
  if (target === "permissions") fs.chmodSync(root, 0o755);
  else if (target === "private-root") { fs.renameSync(root, root + "-held"); fs.mkdirSync(root, { mode: 0o700 }); fs.mkdirSync(directory, { mode: 0o700 }); fs.writeFileSync(file, original, { mode: 0o600 }); }
  else { fs.renameSync(directory, directory + "-held"); fs.mkdirSync(directory, { mode: 0o700 }); fs.writeFileSync(file, original, { mode: 0o600 }); }
  assert.throws(() => catalog.read(), /private|identity|changed|unsafe|directory/i);
});
