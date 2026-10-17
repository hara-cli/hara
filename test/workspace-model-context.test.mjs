import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { workspaceTaskHistory } from "../dist/workspace/model-context.js";
import { messageBody, text } from "../dist/workspace/local-state.js";
import { LocalWorkspaceHost } from "../dist/workspace/local-host.js";
import { createWorkspaceSyntheticProvider } from "../dist/workspace/synthetic-provider.js";

const temporary = [];
after(() => { for (const path of temporary) fs.rmSync(path, { recursive: true, force: true }); });
function root() { const path = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "hara-context-synthetic-"))); temporary.push(path); return path; }
async function until(check) { for (let i = 0; i < 300; i++) { const value = check(); if (value) return value; await new Promise(r => setTimeout(r, 10)); } throw new Error("synthetic context state wait expired"); }

test("model view excludes earlier failures/recovery reasoning, preserves exact current tool pairs and canonical history", () => {
  const prefix = [{ role: "user", content: "OLD_FAILURE_SECRET_MARKER" }, { role: "assistant", text: "failed recovery ".repeat(8000), toolUses: [], continuation: { type: "chat_reasoning", text: "OLD_PRIVATE_REASONING" } }];
  const current = [{ role: "user", content: "current\nmessage" }, { role: "assistant", text: "", toolUses: [{ id: "actual", name: "workspace_read", input: { path: "hello.md" } }], continuation: { type: "chat_reasoning", text: "current exact provider continuation" } }, { role: "tool", results: [{ id: "actual", name: "workspace_read", content: "observed bytes" }] }];
  const history = [...prefix, ...current], before = JSON.stringify(history), view = workspaceTaskHistory(history, prefix.length);
  assert.deepEqual(view, current); assert.equal(JSON.stringify(view).includes("OLD_"), false);
  view[0].content = "provider mutation"; assert.equal(JSON.stringify(history), before);
  for (const anchor of [-1, 0.5, history.length, 1, 3]) assert.throws(() => workspaceTaskHistory(history, anchor), /boundary/);
  assert.throws(() => workspaceTaskHistory(history.slice(0, -1), 2), /open tool batch/);
});

test("message bodies preserve LF/CRLF/tab and whitespace; IDs/metadata and other controls remain strict", () => {
  for (const body of ["line 1\nline 2", "a\r\nb", "a\tb", "\n  你好\n"]) { assert.equal(messageBody(body), true); assert.equal(text(body), false); }
  for (const body of ["", " \r\n\t", "a\0b", "a\x1bb", "a\x7fb", "a\x85b", "x".repeat(4001)]) assert.equal(messageBody(body), false);
  for (const id of ["ag_id\n", "ag_\nid", "id\tvalue", " name "]) assert.equal(text(id), false);
});

test("synthetic six-step flow uses per-task context, accepts multiline delegation and restarts without changing history or usage", async () => {
  const path = root(), calls = [];
  const host = new LocalWorkspaceHost(path, { providerFactory(connection, binding, context) {
    const provider = createWorkspaceSyntheticProvider(connection, binding, context);
    return { ...provider, async turn(args) {
      calls.push({ objective: context.objective, history: structuredClone(args.history), system: args.system });
      const result = await provider.turn(args);
      if (context.objective === "OLD_CHAT_MARKER") return { ...result, text: "OLD_ASSISTANT_MARKER ".repeat(2000) };
      for (const use of result.toolUses) if (use.name === "agent_contact") use.input.task = "生成 hello.md\n內容必須為 hello workspace\\n\n讀取並驗證後回報";
      return result;
    } };
  } });
  try {
    const workspace = host.createWorkspace("Context synthetic", host.list().revision), id = workspace.workspaceId, main = workspace.selectedAgentId;
    assert.equal(workspace.agents.length, 1); host.configureSynthetic(id, 0); host.select("native", id, host.list().revision);
    let run = host.start("native", id, main, "OLD_CHAT_MARKER", randomUUID()); await host.wait(run.runId);
    const old = host.snapshot(id).conversation.history;
    run = host.start("native", id, main, "建立同事 Coder\n只建立一次，等卡片確認", randomUUID());
    const card = await until(() => host.snapshot(id, main, "native").approvals[0]); host.answerApproval("native", id, card.id, true); await host.wait(run.runId);
    assert.equal(host.snapshot(id).agents.length, 2); assert.equal(host.snapshot(id).conversation.taskState, "completed");
    run = host.start("native", id, main, "委派 Coder 生成 hello.md\n核驗後結案", randomUUID()); await host.wait(run.runId);
    const mainState = host.snapshot(id).conversation, colleague = host.snapshot(id).agents.find(a => a.kind === "colleague"), child = host.snapshot(id, colleague.agentId).conversation;
    assert.equal(mainState.taskState, "completed"); assert.equal(mainState.completion.state, "verified");
    assert.equal(child.taskState, "completed"); assert.equal(colleague.runtime.id, "pi");
    assert.ok(child.history.some(m => m.role === "user" && m.content.includes("\n")));
    assert.equal(fs.readFileSync(join(path, "project", id, "hello.md"), "utf8"), "hello workspace\n");
    assert.deepEqual(mainState.history.slice(0, old.length), old);
    for (const call of calls.filter(c => c.objective !== "OLD_CHAT_MARKER")) {
      assert.equal(JSON.stringify(call.history).includes("OLD_CHAT_MARKER"), false);
      assert.equal(JSON.stringify(call.history).includes("OLD_ASSISTANT_MARKER"), false);
    }
    await host.close(); let modelCalls = 0;
    const reopened = new LocalWorkspaceHost(path, { providerFactory() { modelCalls++; throw new Error("read-only restart must not call a model"); } });
    try { assert.deepEqual(reopened.snapshot(id).conversation, mainState); assert.deepEqual(reopened.snapshot(id, colleague.agentId).conversation, child); assert.equal(modelCalls, 0); }
    finally { await reopened.close(); }
  } finally { await host.close(); }
});

test("recovery projects a fresh attempt but retains frozen task/budget, blocked transcript and exact body deduplication", async () => {
  let entered, release; const ready = new Promise(r => entered = r), gate = new Promise(r => release = r), seen = [];
  const path = root(); let generation = 0;
  const host = new LocalWorkspaceHost(path, { providerFactory(_connection, binding) {
    const first = generation++ === 0;
    return { id: "openai", model: binding.model, async turn(args) {
      seen.push({ history: structuredClone(args.history), system: args.system }); if (first) { entered(); await gate; }
      return { text: "ok", toolUses: [], stop: "end", usage: { input: 10, output: 2 } };
    } };
  } });
  try {
    const ws = host.createWorkspace("Resume", host.list().revision); host.configureSynthetic(ws.workspaceId, 0);
    const message = "ORIGINAL_BLOCKED_OBJECTIVE\nsecond line", requestId = randomUUID();
    const run = host.start("test", ws.workspaceId, ws.selectedAgentId, message, requestId); await ready;
    host.cancel(ws.workspaceId, ws.selectedAgentId, run.runId); release(); await host.wait(run.runId);
    const before = host.snapshot(ws.workspaceId).conversation;
    assert.equal(before.state, "cancelled");
    assert.equal(host.start("test", ws.workspaceId, ws.selectedAgentId, message, requestId).duplicate, true);
    assert.throws(() => host.start("test", ws.workspaceId, ws.selectedAgentId, message.replace("\n", "\r\n"), requestId), /another request/);
    const resumed = host.start("test", ws.workspaceId, ws.selectedAgentId, "/continue\n只讀確認", randomUUID(), true); await host.wait(resumed.runId);
    const afterState = host.snapshot(ws.workspaceId).conversation;
    assert.equal(afterState.runId, before.runId); assert.equal(afterState.taskId, before.taskId);
    assert.equal(afterState.runUsage.modelCalls, before.runUsage.modelCalls + 1);
    assert.deepEqual(afterState.history.slice(0, before.history.length), before.history);
    assert.equal(JSON.stringify(seen.at(-1).history).includes("ORIGINAL_BLOCKED_OBJECTIVE"), false);
    assert.ok(seen.at(-1).system.includes("ORIGINAL_BLOCKED_OBJECTIVE"), "the frozen objective is in the task tier, not lost on pre-intake recovery");
  } finally { release(); await host.close(); }
});
