import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { LocalWorkspaceHost } from "../dist/workspace/local-host.js";
import { MemoryCredentialVault } from "../dist/workspace/credential-vault.js";
import { WorkspaceChangeTrace, engineTaskBrief, simpleChangeObjective } from "../dist/agent/governance-c-lite.js";

const roots = [];
after(() => roots.forEach(path => fs.rmSync(path, { recursive: true, force: true })));
const root = () => { const path = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "hara-c-lite-"))); roots.push(path); return path; };
const response = (text, toolUses = []) => ({ text, toolUses, stop: toolUses.length ? "tool_use" : "end", usage: { input: 5, output: 5 } });
const call = (id, name, input = {}) => ({ id, name, input });

async function run(message, turns) {
  const path = root(); let rounds = 0;
  const host = new LocalWorkspaceHost(path, { credentialVault: new MemoryCredentialVault(),
    providerFactory(_connection, binding) { return { id: "openai", model: binding.model, async turn() {
      return turns[rounds++] ?? response("Still done.");
    } }; } });
  try {
    const ws = host.createWorkspace("C-lite", host.list().revision); host.configureSynthetic(ws.workspaceId, 0);
    host.select("tester", ws.workspaceId, host.list().revision);
    const receipt = host.start("tester", ws.workspaceId, ws.selectedAgentId, message, randomUUID());
    await host.wait(receipt.runId);
    return { rounds, view: host.snapshot(ws.workspaceId, ws.selectedAgentId, "tester").conversation,
      project: join(path, "project", ws.workspaceId) };
  } finally { await host.close(); }
}

test("engine creates brief and closes a simple verified write without model bookkeeping", async () => {
  const { rounds, view, project } = await run("写入 note.txt 内容 hello", [
    response("", [call("read", "workspace_read", { path: "note.txt" })]),
    response("", [call("write", "workspace_write", { path: "note.txt", content: "hello" })]),
    response("", [call("verify", "workspace_verify", { path: "note.txt", expectedContent: "hello" })]),
    response("已写入 note.txt。"),
  ]);
  assert.equal(rounds, 4);
  assert.equal(fs.readFileSync(join(project, "note.txt"), "utf8"), "hello");
  assert.equal(view.taskState, "completed");
  assert.equal(view.completion.state, "verified");
  assert.match(view.completion.evidence.join("\n"), /workspace_write toolCallId=write resultSummarySha256=[a-f0-9]{64} verify=passed/);
  assert.equal(view.history.filter(row => row.role === "assistant" && (row.tools ?? []).some(t => t.name === "task_intake" || t.name === "task_checkpoint")).length, 0);
});

test("engine creates an answer brief and closes a read-only response without bookkeeping", async () => {
  const { rounds, view } = await run("列出同事", [
    response("", [call("roster", "agent_list")]),
    response("当前只有主管理。"),
  ]);
  assert.equal(rounds, 2);
  assert.equal(view.taskState, "completed");
  assert.match(view.completion.evidence.join("\n"), /agent_list tool_call_id=roster/);
});

test("fabricated completion without write is corrected once and stays uncompleted", async () => {
  const { rounds, view } = await run("写入 note.txt 内容 hello", [response("完成了。"), response("已经完成。")]);
  assert.equal(rounds, 2);
  assert.notEqual(view.taskState, "completed");
  assert.equal(view.completion, null);
  assert.match(JSON.stringify(view.history), /未见实际修改回执/);
});

test("explicit checkpoint cannot verify a change from read receipts alone", async () => {
  const { view } = await run("写入 note.txt 内容 hello", [
    response("", [call("roster", "agent_list")]),
    response("", [call("claim", "task_checkpoint", { completion: { state: "verified", evidence: ["done"], final_answer: "done" } })]),
    response("完成了。"), response("完成了。"),
  ]);
  assert.notEqual(view.taskState, "completed");
  assert.equal(view.completion, null);
  assert.match(JSON.stringify(view.history), /no verified write, create, rename or delegation receipt/);
});

test("host receipt ledger requires matching verify and rejects forged results", () => {
  const task = { objective: "写入 note.txt 内容 hello" };
  assert.equal(engineTaskBrief(task, response("", [call("x", "workspace_write")])).intent, "change");
  assert.equal(simpleChangeObjective("写入 note.txt 内容 hello"), true);
  assert.equal(simpleChangeObjective("写入 note.txt，并删除 another.txt"), false);
  const trace = new WorkspaceChangeTrace();
  trace.observe({ id: "w", name: "workspace_write", content: JSON.stringify({ path: "note.txt", sha256: "a", written: true,
    receipt: { toolCallId: "w", toolName: "workspace_write" } }) }, false);
  assert.equal(trace.evidence(), null);
  trace.observe({ id: "v", name: "workspace_verify", content: JSON.stringify({ path: "note.txt", sha256: "b", verified: true,
    receipt: { toolCallId: "v", toolName: "workspace_verify" } }) }, false);
  assert.equal(trace.evidence(), null);
  trace.observe({ id: "v2", name: "workspace_verify", content: JSON.stringify({ path: "note.txt", sha256: "a", verified: true,
    receipt: { toolCallId: "v2", toolName: "workspace_verify" } }) }, false);
  assert.equal(trace.evidence().length, 1);
  const reversed = new WorkspaceChangeTrace();
  reversed.observe({ id: "v", name: "workspace_verify", content: JSON.stringify({ path: "note.txt", sha256: "a", verified: true,
    receipt: { toolCallId: "v", toolName: "workspace_verify" } }) }, false);
  reversed.observe({ id: "w", name: "workspace_write", content: JSON.stringify({ path: "note.txt", sha256: "a", written: true,
    receipt: { toolCallId: "w", toolName: "workspace_write" } }) }, false);
  assert.equal(reversed.evidence(), null, "a prior verification cannot validate a later write");
});
