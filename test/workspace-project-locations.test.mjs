import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { LocalWorkspaceHost } from "../dist/workspace/local-host.js";
import { MemoryCredentialVault } from "../dist/workspace/credential-vault.js";
import { prepareWorkspaceProjectLocations } from "../dist/workspace/project-locations.js";
import { prepareWorkspaceStartContext } from "../dist/workspace/start-context.js";
import { WorkspaceLegacyResources, planLegacyResources } from "../dist/workspace/legacy-resources.js";
import { storageFixture } from "./helpers/workspace-user-interaction.mjs";

async function seed(storage, paths = ["/known/video", "/known/design"]) {
  const rows = planLegacyResources({ jobs: [], projects: paths.map(path => ({ path })), legacyWorkspacePath: "/known/resources" });
  await new WorkspaceLegacyResources(storage).domain("a".repeat(64), rows).apply(); return rows;
}
function observed(path, changes = {}) {
  return { id: "read", name: "workspace_read", content: JSON.stringify({ path, exists: true, sha256: "b".repeat(64), receipt: { toolCallId: "read", toolName: "workspace_read" } }), ...changes };
}
for (const [objective, projectLabel, other] of [["Which video project or directory?", "Project", "Other (type an answer)"],
  ["哪个 video 项目或目录？", "项目", "其它（输入）"], ["哪個 video 專案或目錄？", "專案", "其它（輸入）"]]) {
  test("project, resource and recent-directory choices are scoped metadata in " + other, async t => {
    const f = storageFixture(t); await seed(f.storage);
    const locations = prepareWorkspaceProjectLocations({ storage: f.storage, project: "/managed", objective,
      history: [{ role: "tool", results: [observed("edits/clip.txt")] }] });
    assert.equal(locations.options[0], projectLabel + ": /known/video");
    assert(locations.options.some(option => option.endsWith(": /known/resources")));
    assert(locations.options.some(option => option.endsWith(": /managed/edits")));
    assert(locations.options.some(option => option.endsWith(": /managed")));
    assert.equal(locations.options.at(-1), other); assert.equal(locations.otherOption, other);
    assert.equal(locations.access, "catalog_only"); assert.equal(locations.historicalContextOnly, true);
    assert(locations.options.length <= 8 && locations.options.every(option => option.length <= 300));
    const packet = prepareWorkspaceStartContext({ storage: f.storage, workspaceRoots: [], references: [], objective, projectLocations: locations });
    assert.deepEqual(packet.lookup("video").projectLocations, locations);
    const json = JSON.parse(packet.prompt.split("\n").at(-1)); assert.deepEqual(json.projectLocations, locations);
    assert(Buffer.byteLength(packet.prompt) <= 4096);
    const otherScope = { ...f.storage.scope, workspaceId: "ws_10000000-0000-4000-8000-000000000002" };
    const { WorkspaceResourceStorage } = await import("../dist/workspace/resource-context.js");
    const isolated = new WorkspaceResourceStorage(f.root, otherScope); isolated.initialize();
    const hidden = prepareWorkspaceProjectLocations({ storage: isolated, project: "/other-managed", history: [], objective });
    assert.equal(JSON.stringify(hidden).includes("/known/"), false);
  });
}

test("invalid, failed, credential-like and unreceipted file results never become recent directories", t => {
  const f = storageFixture(t);
  const bad = [observed("../outside/file.txt"), observed("/absolute/file.txt"), observed(".private/file.txt"), observed("node_modules/package/file.txt"),
    observed("failed/file.txt", { isError: true }), observed("wrong/file.txt", { id: "other-id" }),
    observed("forged/file.txt", { content: JSON.stringify({ path: "forged/file.txt", exists: true, sha256: "b".repeat(64) }) })];
  const locations = prepareWorkspaceProjectLocations({ storage: f.storage, project: "/managed", objective: "Which directory?", history: [{ role: "tool", results: bad }] });
  assert.deepEqual(locations.options, ["Current Workspace directory: /managed", "Other (type an answer)"]);
});

test("many and long registered paths stay bounded without inventing or cutting a path", async t => {
  const f = storageFixture(t); await seed(f.storage, Array.from({ length: 20 }, (_, i) => "/known/" + String(i).padStart(2, "0") + "x".repeat(235)));
  const locations = prepareWorkspaceProjectLocations({ storage: f.storage, project: "/managed", history: [], objective: "Which project?" });
  assert.equal(locations.truncated, true); assert(locations.options.includes("Current Workspace directory: /managed"));
  assert(Buffer.byteLength(JSON.stringify(locations)) < 1700); assert.equal(locations.options.length, 3);
});

const answer = text => ({ text, toolUses: [], stop: "end", usage: { input: 1, output: 1 } });
const call = (id, name, input) => ({ text: "", toolUses: [{ id, name, input }], stop: "tool_use", usage: { input: 1, output: 1 } });
async function waitFor(read, accept) {
  const end = Date.now() + 15000;
  while (Date.now() < end) { const value = read(); if (accept(value)) return value; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error("bounded fixture approval wait");
}
for (const useOptions of [false, true]) {
  test("answering " + (useOptions ? "a supplied project option" : "a zero-option project question") + " continues the original task and still requires the create card", async t => {
    const f = { root: fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "hara-project-question-"))) }; let rounds = 0, menu;
    const host = new LocalWorkspaceHost(f.root, { credentialVault: new MemoryCredentialVault(), providerFactory(_connection, binding) { return { id: "openai", model: binding.model, async turn(args) {
      rounds++;
      if (rounds === 1) {
        menu = JSON.parse(args.system.split("\n").find(line => line.startsWith('{"untrustedContextOnly":'))).projectLocations;
        assert(menu.options.some(option => option.endsWith(": /known/video")));
        return call("ask-project", "ask_user", { question: "你說的 video 項目具體是哪個專案或目錄？", options: useOptions ? menu.options : [] });
      }
      if (rounds === 2) {
        assert(args.history.some(row => row.role === "user" && row.content.includes("/known/video")));
        return call("create-video", "agent_create", { username: "video-helper", displayName: "Video Helper", title: "Video", instructions: "Handle the video project identified by the user." });
      }
      if (rounds === 3) return call("complete", "task_checkpoint", { completion: { state: "verified", checks: [{ acceptance_index: 0, evidence: "The human confirmed the colleague creation and the Host returned its successful receipt.", tool_call_ids: ["create-video"] }], final_answer: "已建立负责 video 的同事。" } });
      if (rounds === 4) return answer("已建立负责 video 的同事。");
      throw new Error("unexpected synthetic model round");
    } }; } });
    t.after(async () => { await host.close(); fs.rmSync(f.root, { recursive: true, force: true }); });
    const ws = host.createWorkspace("Question fixture", host.list().revision), context = host.context(ws.workspaceId);
    host.configureSynthetic(ws.workspaceId, 0); const agent = context.resources.agents.get(ws.selectedAgentId);
    context.resources.agents.setPermissionTier(agent.agentId, "controlled", agent.configRevision, agent.agentEpoch);
    await seed(context.storage); host.select("tester", ws.workspaceId, host.list().revision);
    const run = host.start("tester", ws.workspaceId, ws.selectedAgentId, "可以建一個bot了嗎…負責video項目", randomUUID()); await host.wait(run.runId);
    const before = host.snapshot(ws.workspaceId, ws.selectedAgentId, "tester").conversation;
    assert.equal(before.state, "awaiting_user"); assert(before.pendingQuestion); assert.equal(rounds, 1);
    assert.deepEqual(before.pendingQuestion.options, useOptions ? menu.options : []);
    assert.throws(() => host.start("tester", ws.workspaceId, ws.selectedAgentId, "/known/video", randomUUID(), true, undefined, undefined, undefined, undefined, randomUUID()), /question/);
    const response = useOptions ? menu.options.find(option => option.endsWith(": /known/video")) : "/known/video";
    const resumed = host.start("tester", ws.workspaceId, ws.selectedAgentId, response, randomUUID(), true, undefined, undefined, undefined, undefined, before.pendingQuestion.id);
    let pending;
    try { pending = await waitFor(() => host.snapshot(ws.workspaceId, ws.selectedAgentId, "tester"), view => view.approvals.length === 1); }
    catch (error) {
      const diagnostic = host.snapshot(ws.workspaceId, ws.selectedAgentId, "tester").conversation;
      t.diagnostic(JSON.stringify({ rounds, state: diagnostic.state, taskState: diagnostic.taskState, blockReason: diagnostic.blockReason,
        userMessages: diagnostic.history.filter(row => row.role === "user").map(row => row.content),
        tools: diagnostic.history.flatMap(row => row.role === "tool" ? row.results.map(result => ({ name: result.name, isError: result.isError, content: result.content.slice(0, 1000) })) : []) }));
      throw error;
    }
    assert.equal(pending.agents.length, 1); assert.equal(pending.approvals[0].kind, "agent_create");
    assert.equal(host.snapshot(ws.workspaceId, ws.selectedAgentId, "other-client").approvals.length, 0);
    host.answerApproval("tester", ws.workspaceId, pending.approvals[0].id, true); await host.wait(resumed.runId);
    const after = host.snapshot(ws.workspaceId, ws.selectedAgentId, "tester");
    assert.equal(after.conversation.taskId, before.taskId); assert.equal(after.conversation.runId, before.runId);
    assert.equal(after.conversation.taskState, "completed"); assert.equal(after.conversation.pendingQuestion, null);
    assert.equal(after.agents.length, 2); assert.equal(after.conversation.completion.state, "verified");
    assert(after.conversation.runUsage.modelCalls > before.runUsage.modelCalls); assert(rounds <= 4);
    await host.close();
  });
}
