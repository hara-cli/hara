import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { MemoryCredentialVault } from "../dist/workspace/credential-vault.js";
import { WorkspaceResources } from "../dist/workspace/resources.js";
import { LocalWorkspaceHost } from "../dist/workspace/local-host.js";
import { WorkspaceConversationStore } from "../dist/workspace/conversations.js";

import { hostFixture, tools } from "./helpers/workspace-user-interaction.mjs";

test("real personal mode prepares both personal-global and Workspace memory before the first provider request", async t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "hara-personal-context-host-"))), home = join(root, "owner"), source = join(root, "application");
  fs.mkdirSync(join(home, ".hara", "memory"), { recursive: true, mode: 0o700 }); fs.mkdirSync(source, { mode: 0o700 });
  fs.writeFileSync(join(home, ".hara", "memory", "MEMORY.md"), "PersonalAnchor: prefer concise weekly reports.\n", { mode: 0o600 });
  let observed;
  const host = new LocalWorkspaceHost(source, { mode: "workspace", hostHome: home, credentialVault: new MemoryCredentialVault(), providerFactory(_c, binding) { return {
    id: "openai", model: binding.model, async turn(args) { observed = args; return { text: "Hello", toolUses: [], stop: "end" }; } }; } });
  t.after(async () => { await host.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const w = host.createWorkspace("Synthetic", host.list().revision);
  const resources = new WorkspaceResources(host.home, host.catalog.resolve(w.workspaceId).scope); resources.initialize();
  await resources.memory.append("project", "memory", "ScopedAnchor: retain this Workspace's reporting period.", join(source, "project", w.workspaceId));
  host.configureConnection(w.workspaceId, { label: "Synthetic", provider: "openai", baseURL: "https://example.invalid/v1", defaultModel: "synthetic", apiKey: "fixture-only-key" }, 0);
  const run = host.start("client", w.workspaceId, w.selectedAgentId, "Hello", randomUUID()); await host.wait(run.runId);
  assert(observed); assert(observed.system.includes("PersonalAnchor")); assert(observed.system.includes("ScopedAnchor"));
  assert.equal(observed.system.includes(join(home, ".hara", "memory")), false);
});

test("an explicit question resumes after the saved write instead of repeating it", async t => {
  const sequence = [
    ["task_intake", { intent: "change", goal: "Update plan.txt, confirm the target and verify it", constraints: ["Synthetic local fixture only"], acceptance: ["plan.txt has the observed final content"], steps: ["Read", "Save", "Confirm", "Verify"] }],
    ["workspace_read", { path: "plan.txt" }],
    ["workspace_write", { path: "plan.txt", content: "after\n" }],
    ["task_checkpoint", { current_step: "Confirm the target before final verification", next_step: "Verify the saved plan.txt; do not write it again", artifacts: ["plan.txt"] }],
    ["ask_user", { question: "Which target should the final check use?", options: ["Beta"], default: "do not infer this" }],
    ["workspace_verify", { path: "plan.txt", expectedContent: "after\n" }],
  ];
  const a = hostFixture(t, (n, args) => {
    if (sequence[n - 1]) return tools(sequence[n - 1]);
    const result = args.history.flatMap(message => message.role === "tool" ? message.results : []).findLast(row => row.name === "workspace_verify" && !row.isError);
    return tools(["task_checkpoint", { completion: { state: "verified", checks: [{ acceptance_index: 0, evidence: "The current read-only verification succeeded", tool_call_ids: [result.id] }], final_answer: "Verified" } }]);
  });
  const file = join(a.root, "project", a.workspace.workspaceId, "plan.txt"); fs.writeFileSync(file, "before\n");
  const run = a.host.start("client", a.workspace.workspaceId, a.workspace.selectedAgentId, "Update plan.txt, confirm the target and verify it", randomUUID()); await a.host.wait(run.runId);
  const before = a.host.snapshot(a.workspace.workspaceId).conversation, saved = fs.statSync(file);
  assert(before.pendingQuestion); assert.equal(before.pendingQuestion.reason, "explicit"); assert.equal(fs.readFileSync(file, "utf8"), "after\n");
  const resumed = a.host.start("client", a.workspace.workspaceId, a.workspace.selectedAgentId, "Beta", randomUUID(), true, undefined, undefined, undefined, undefined, before.pendingQuestion.id);
  await a.host.wait(resumed.runId);
  const after = a.host.snapshot(a.workspace.workspaceId).conversation;
  assert.equal(after.taskId, before.taskId); assert.equal(after.runId, before.runId); assert.equal(after.taskState, "completed");
  assert.equal(after.pendingQuestion, null); assert.equal(fs.statSync(file).ino, saved.ino); assert.equal(fs.statSync(file).mtimeMs, saved.mtimeMs);
  const store = new WorkspaceConversationStore(a.storage, a.workspace.selectedAgentId).read();
  assert.equal(store.history.flatMap(message => message.role === "assistant" ? message.toolUses : []).filter(call => call.name === "workspace_write").length, 1);
  assert(after.runUsage.modelCalls > before.runUsage.modelCalls); assert(a.turns[5].system.includes("do not write it again"), "resume must carry the actual saved next step");
});


test("answering a startup reference question does not ask the original noun again or create a new run", async t => {
  const a = hostFixture(t, () => ({ text: "Resolved using the user's answer", toolUses: [], stop: "end" }));
  const run = a.host.start("client", a.workspace.workspaceId, a.workspace.selectedAgentId, "Where is UnknownColleague", randomUUID()); await a.host.wait(run.runId);
  const before = a.host.snapshot(a.workspace.workspaceId).conversation; assert.equal(a.turns.length, 0);
  const reply = a.host.start("client", a.workspace.workspaceId, a.workspace.selectedAgentId, "I mean Beta in the current roster.", randomUUID(), true, undefined, undefined, undefined, undefined, before.pendingQuestion.id);
  await a.host.wait(reply.runId);
  const after = a.host.snapshot(a.workspace.workspaceId).conversation;
  assert.equal(a.turns.length, 1); assert.equal(after.taskId, before.taskId); assert.equal(after.runId, before.runId); assert.equal(after.pendingQuestion, null);
});

test("continuing a kept-paused task reopens the original question before any model work", async t => {
  const a = hostFixture(t, () => tools(["ask_user", { question: "Which target?" }]));
  const run = a.host.start("client", a.workspace.workspaceId, a.workspace.selectedAgentId, "Clarify target", randomUUID()); await a.host.wait(run.runId);
  const q = a.host.snapshot(a.workspace.workspaceId).conversation.pendingQuestion;
  a.host.pauseUserQuestion("client", a.workspace.workspaceId, a.workspace.selectedAgentId, q.id);
  const next = a.host.start("client", a.workspace.workspaceId, a.workspace.selectedAgentId, "继续", randomUUID(), true); await a.host.wait(next.runId);
  assert.equal(a.turns.length, 1); assert.equal(a.host.snapshot(a.workspace.workspaceId).conversation.pendingQuestion.id, q.id);
});
