import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { LocalWorkspaceHost } from "../dist/workspace/local-host.js";
import { MemoryCredentialVault } from "../dist/workspace/credential-vault.js";
import { engineTaskBrief, requestedReplyText } from "../dist/agent/governance-c-lite.js";
import { ReadOnlyAnswerTrace } from "../dist/agent/readonly-light.js";

const reply = (text, toolUses = []) => ({ text, toolUses, stop: toolUses.length ? "tool_use" : "end", usage: { input: 5, output: 5 } });
const call = (id, name, input = {}) => ({ id, name, input });
const longReply = "请直接回答“就绪”。这是无需工具的简单问候，请不要调用任何工具，回复后结束。";
const claudeQuery = "请只使用一次 Hara 的 agent_list 工具并简要列出当前 Workspace 同事。此任务是只读查询，工具回执后即结束。";
async function fixture(t, objective, turns) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "hara-investigate-pause-")));
  let rounds = 0;
  const host = new LocalWorkspaceHost(root, { credentialVault: new MemoryCredentialVault(),
    providerFactory(_connection, binding) { return { id: "openai", model: binding.model, async turn(args) {
      const next = turns[rounds++];
      if (!next) throw new Error("unexpected synthetic model round");
      return typeof next === "function" ? next(args) : next;
    } }; } });
  t.after(async () => { await host.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const ws = host.createWorkspace("Investigate pause fixture", host.list().revision); host.configureSynthetic(ws.workspaceId, 0);
  const agent = host.context(ws.workspaceId).resources.agents.get(ws.selectedAgentId);
  // Exercise the real Host/governor/tool receipts with an in-process synthetic provider.
  host.context(ws.workspaceId).resources.agents.setPermissionTier(agent.agentId, "controlled", agent.configRevision, agent.agentEpoch);
  host.select("tester", ws.workspaceId, host.list().revision);
  const accepted = host.start("tester", ws.workspaceId, ws.selectedAgentId, objective, randomUUID());
  return { host, ws, root, project: join(root, "project", ws.workspaceId), rounds: () => rounds,
    read: () => host.snapshot(ws.workspaceId, ws.selectedAgentId, "tester"),
    wait: () => host.wait(accepted.runId) };
}
async function until(read, accept) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const value = read(); if (accept(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("bounded synthetic approval wait");
}

for (const objective of ["你好", "請用一句話介紹你自己。", longReply]) {
  test("a short greeting or longer fixed reply completes without a checkpoint round: " + objective, async t => {
    const answer = objective === longReply ? "就绪" : "你好，我是 Hara，可以协助完成已授权的工作。";
    const f = await fixture(t, objective, [reply(answer)]); await f.wait();
    const view = f.read().conversation;
    assert.equal(f.rounds(), 1); assert.equal(view.state, "completed");
    assert.equal(view.taskState, "completed"); assert.equal(view.completion.state, "verified");
    assert.match(view.completion.evidence.join("\n"), /(?:conversational-answer|requested-reply) result_sha256=/);
  });
}

for (const objective of [claudeQuery, "麻煩幫我列出目前的同事好嗎？", "分析当前同事清单并说明观察结果"]) {
  test("a normal read request completes from actual read receipts even if intake says investigate: " + objective, async t => {
    const f = await fixture(t, objective, [reply("", [call("roster", "agent_list")]), reply("当前只有 Hara 一位同事。")]);
    await f.wait(); const view = f.read().conversation;
    assert.equal(f.rounds(), 2); assert.equal(view.state, "completed"); assert.equal(view.taskState, "completed");
    assert.equal(view.completion.state, "verified");
    assert.match(view.completion.evidence.join("\n"), /agent_list tool_call_id=roster result_sha256=/);
    if (objective === claudeQuery) {
      assert.equal(engineTaskBrief({ objective }, reply("", [call("roster", "agent_list")])).intent, "investigate");
      await f.host.close();
      const reopened = new LocalWorkspaceHost(f.root, { credentialVault: new MemoryCredentialVault(),
        providerFactory() { throw new Error("completed task was replayed"); } });
      try { assert.equal(reopened.snapshot(f.ws.workspaceId, f.ws.selectedAgentId).conversation.taskState, "completed"); }
      finally { await reopened.close(); }
    }
  });
}

test("an explicit investigate brief can close from its read result and answer", async t => {
  const f = await fixture(t, "检查当前同事清单", [
    reply("", [call("intake", "task_intake", { intent: "investigate", goal: "Check the current roster",
      constraints: ["Read only"], acceptance: ["The roster is observed"], steps: ["Read roster", "Report findings"] }),
      call("roster", "agent_list")]), reply("已核对清单，当前只有 Hara。")]);
  await f.wait(); const view = f.read().conversation;
  assert.equal(f.rounds(), 2); assert.equal(view.taskState, "completed");
  assert.match(view.completion.evidence.join("\n"), /agent_list tool_call_id=roster/);
});

for (const objective of ["可以建一個bot了嗎…負責video項目", "能帮我新建一个 bot 吗？", "請建立負責 video 的同事", "请问可以修改 note.txt 吗？"]) {
  test("a question mark or Traditional Chinese cannot turn requested mutation into answer: " + objective, () => {
    assert.equal(engineTaskBrief({ objective }, reply("我可以处理。")).intent, "change");
  });
}

test("the actual bot request waits for its exact confirmation card before creating and completing", async t => {
  const objective = "可以建一個bot了嗎…負責video項目";
  const f = await fixture(t, objective, [
    reply("", [call("create-video", "agent_create", { username: "video-helper", displayName: "Video Helper",
      title: "Video", instructions: "Handle this fixture's video project tasks." })]),
    reply("已建立 Video Helper，负责 video 项目。")]);
  const pending = await until(f.read, view => view.approvals.length === 1);
  assert.equal(pending.agents.length, 1); assert.equal(pending.approvals[0].kind, "agent_create");
  assert.throws(() => f.host.answerApproval("tester", f.ws.workspaceId, randomUUID(), true), /approval/);
  assert.equal(f.read().agents.length, 1);
  f.host.answerApproval("tester", f.ws.workspaceId, pending.approvals[0].id, true);
  await f.wait(); const view = f.read();
  assert.equal(view.agents.length, 2); assert.equal(view.conversation.taskState, "completed");
  assert.equal(view.conversation.completion.state, "verified");
  assert.match(view.conversation.completion.evidence.join("\n"), /agent_create toolCallId=create-video/);
});

test("a real file change still needs the successful write and matching verify receipt", async t => {
  const f = await fixture(t, "請寫入 note.txt 內容 hello", [
    reply("", [call("read-file", "workspace_read", { path: "note.txt" })]),
    reply("", [call("write-file", "workspace_write", { path: "note.txt", content: "hello" })]),
    reply("", [call("verify-file", "workspace_verify", { path: "note.txt", expectedContent: "hello" })]),
    reply("已寫入 note.txt 並驗證內容。")]);
  await f.wait(); const view = f.read().conversation;
  assert.equal(fs.readFileSync(join(f.project, "note.txt"), "utf8"), "hello");
  assert.equal(view.taskState, "completed");
  assert.match(view.completion.evidence.join("\n"), /workspace_write toolCallId=write-file.*verify=passed/);
});

test("read receipts and a forged answer/checkpoint cannot complete a requested file change", async t => {
  const f = await fixture(t, "請寫入 note.txt 內容 hello", [
    reply("", [call("roster", "agent_list")]),
    reply("", [call("claim", "task_checkpoint", { completion: { state: "verified", checks: [
      { acceptance_index: 0, evidence: "The roster was read", tool_call_ids: ["roster"] }], final_answer: "文件已经完成。" } })]),
    reply("文件已经完成。"), reply("文件已经完成。")]);
  await f.wait(); const view = f.read().conversation;
  assert.notEqual(view.taskState, "completed"); assert.equal(view.completion, null);
  assert.equal(fs.existsSync(join(f.project, "note.txt")), false);
  const denied = view.history.flatMap(row => row.role === "tool" ? row.results : []).find(row => row.id === "claim");
  assert(denied, "the attempted checkpoint has a real tool result");
  assert.match(denied.content, /^Error: task checkpoint rejected/u);
  assert.match(denied.content, /write|change|effect/iu);
  assert.equal(f.rounds(), 4, "no unexpected synthetic model turn can stand in for the rejection");
});

test("a fixed reply is exact and cannot swallow another request", () => {
  assert.equal(requestedReplyText(longReply), "就绪");
  for (const objective of ["请直接回答“就绪”，并列出同事", "请直接回答“就绪”，然后删除 note.txt"]) assert.equal(requestedReplyText(objective), null);
  const trace = new ReadOnlyAnswerTrace(), task = { status: "running", objective: longReply, brief: { intent: "investigate" } };
  assert.equal(trace.evidence(task, false, false, false, { answer: "其他答案", noTools: true }), null);
  assert.equal(trace.evidence(task, false, false, false, { answer: "就绪", noTools: false }), null);
  trace.observe("agent_list", "read", "read", { id: "read", name: "agent_list", content: '{"agents":[]}' }, false);
  assert.equal(trace.evidence(task, false, false, false, { answer: "其他答案", noTools: false }), null,
    "an unrelated read cannot launder the wrong fixed reply");
});

test("investigate still pauses on missing reads, outstanding work, failed tools and mutation", () => {
  const task = { status: "running", objective: "检查当前同事清单", brief: { intent: "investigate" } };
  const answer = { answer: "当前只有 Hara。", noTools: true }, trace = new ReadOnlyAnswerTrace();
  assert.equal(trace.evidence(task, false, false, false, answer), null);
  trace.observe("agent_list", "roster", "read", { id: "roster", name: "agent_list", content: '{"agents":[]}' }, false);
  assert(trace.evidence(task, false, false, false, answer));
  for (const flags of [[true,false,false], [false,true,false], [false,false,true]]) assert.equal(trace.evidence(task, ...flags, answer), null);
  assert.equal(trace.evidence({ ...task, brief: { intent: "change" } }, false, false, false, answer), null);
  assert.equal(trace.evidence({ ...task, objective: "可以建一個bot了嗎…" }, false, false, false, answer), null);
  assert.equal(trace.evidence(task, false, false, false, { ...answer, answer: "***" }), null);
  trace.observe("workspace_read", "failed", "read", { id: "failed", name: "workspace_read", content: "Error: unavailable", isError: true }, false);
  assert.equal(trace.evidence(task, false, false, false, answer), null);
});
