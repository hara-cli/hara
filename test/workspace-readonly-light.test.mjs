import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { LocalWorkspaceHost } from "../dist/workspace/local-host.js";
import { MemoryCredentialVault } from "../dist/workspace/credential-vault.js";
import { ReadOnlyAnswerTrace, READONLY_ANSWER_TOOLS, readOnlyAnswerObjective } from "../dist/agent/readonly-light.js";

const roots = [];
after(() => roots.forEach(path => fs.rmSync(path, { recursive: true, force: true })));
function root() { const path = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "hara-readonly-light-"))); roots.push(path); return path; }
function response(text, toolUses = []) { return { text, toolUses, stop: toolUses.length ? "tool_use" : "end", usage: { input: 5, output: 5 } }; }
function call(id, name, input = {}) { return { id, name, input }; }

test("a user-owned colleague-list answer closes in two model rounds with an engine receipt and survives reopen", async () => {
  const path = root(); let rounds = 0;
  const host = new LocalWorkspaceHost(path, { credentialVault: new MemoryCredentialVault(),
    providerFactory(_connection, binding) { return { id: "openai", model: binding.model, async turn() {
      rounds++;
      if (rounds === 1) return response("", [call("brief", "task_intake", { intent: "answer", goal: "list colleagues",
        constraints: [], acceptance: ["colleagues named"], steps: ["read roster", "answer"] }), call("roster", "agent_list")]);
      if (rounds === 2) return response("Hara has no other colleagues yet.");
      throw new Error("a separate checkpoint model round was started");
    } }; } });
  try {
    const ws = host.createWorkspace("Read only", host.list().revision); host.configureSynthetic(ws.workspaceId, 0);
    host.select("tester", ws.workspaceId, host.list().revision);
    const run = host.start("tester", ws.workspaceId, ws.selectedAgentId, "列出同事", randomUUID());
    await host.wait(run.runId);
    const view = host.snapshot(ws.workspaceId, ws.selectedAgentId, "tester").conversation;
    assert.equal(rounds, 2); assert.equal(view.taskState, "completed"); assert.equal(view.completion.state, "verified");
    assert.match(view.completion.evidence.join("\n"), /agent_list tool_call_id=roster result_sha256=[a-f0-9]{64}/);
    assert.equal(view.history.at(-1).role, "assistant");
    await host.close();
    const restored = new LocalWorkspaceHost(path, { credentialVault: new MemoryCredentialVault(), providerFactory() {
      throw new Error("reopening a completed read-only task must not call a model");
    } });
    try { assert.equal(restored.snapshot(ws.workspaceId, ws.selectedAgentId, "tester").conversation.taskState, "completed"); }
    finally { await restored.close(); }
  } finally { await host.close(); }
});

test("engine read-only decision rejects forged answer intent for a change request", async () => {
  const path = root(); let rounds = 0;
  const host = new LocalWorkspaceHost(path, { credentialVault: new MemoryCredentialVault(),
    providerFactory(_connection, binding) { return { id: "openai", model: binding.model, async turn() {
      rounds++;
      return rounds === 1 ? response("", [call("brief", "task_intake", { intent: "answer", goal: "list colleagues",
        constraints: [], acceptance: ["colleagues named"], steps: ["list"] }), call("roster", "agent_list")])
        : response("Here are the colleagues.");
    } }; } });
  try {
    const ws = host.createWorkspace("Forged", host.list().revision); host.configureSynthetic(ws.workspaceId, 0);
    host.select("tester", ws.workspaceId, host.list().revision);
    const run = host.start("tester", ws.workspaceId, ws.selectedAgentId, "创建同事并列出同事", randomUUID());
    await host.wait(run.runId);
    const view = host.snapshot(ws.workspaceId, ws.selectedAgentId, "tester").conversation;
    assert.equal(view.taskState, "paused"); assert.equal(view.completion, null);
  } finally { await host.close(); }
});

test("a read-only answer that attempts a later write returns to the full intent gate", async () => {
  const path = root(); let rounds = 0;
  const host = new LocalWorkspaceHost(path, { credentialVault: new MemoryCredentialVault(),
    providerFactory(_connection, binding) { return { id: "openai", model: binding.model, async turn() {
      rounds++;
      if (rounds === 1) return response("", [call("brief", "task_intake", { intent: "answer", goal: "list colleagues",
        constraints: [], acceptance: ["colleagues named"], steps: ["list"] }), call("roster", "agent_list")]);
      if (rounds === 2) return response("", [call("write", "workspace_write", { path: "probe.txt", content: "unsafe" })]);
      return response("The attempted write was refused.");
    } }; } });
  try {
    const ws = host.createWorkspace("Read to change", host.list().revision); host.configureSynthetic(ws.workspaceId, 0);
    host.select("tester", ws.workspaceId, host.list().revision);
    const run = host.start("tester", ws.workspaceId, ws.selectedAgentId, "列出同事", randomUUID());
    await host.wait(run.runId);
    const view = host.snapshot(ws.workspaceId, ws.selectedAgentId, "tester").conversation;
    assert.equal(view.taskState, "paused"); assert.equal(view.completion, null);
    assert.equal(fs.existsSync(join(path, "project", ws.workspaceId, "probe.txt")), false);
    assert.match(JSON.stringify(view.history), /Understanding gate/);
  } finally { await host.close(); }
});

test("the engine allowlist excludes state-changing tools despite read-like classifications", () => {
  assert.deepEqual([...READONLY_ANSWER_TOOLS].sort(), ["agent_list", "channel_sync", "workspace_context_lookup",
    "workspace_memory_search", "workspace_read", "workspace_receipt_read", "workspace_skill", "workspace_verify"].sort());
  assert.equal(readOnlyAnswerObjective("列出同事"), true);
  assert.equal(readOnlyAnswerObjective("创建同事并列出同事"), false);
  const trace = new ReadOnlyAnswerTrace();
  trace.observe("agent_list", "r1", "read", { id: "r1", name: "agent_list", content: "{\"agents\":[]}" }, false);
  const task = { status: "running", objective: "列出同事", brief: { intent: "answer" }, decisions: [] };
  assert.equal(trace.evidence(task, false, false, false).length, 1);
  assert.equal(trace.evidence(task, true, false, false), null, "pending ask or confirmation card closes the light path");
  assert.equal(trace.evidence({ ...task, steering: [{ content: "also create a colleague" }] }, false, false, false), null,
    "later user steering must return to full governance even after an answer brief");
  trace.observe("channel_peer_wake", "wake", "state", { id: "wake", name: "channel_peer_wake", content: "ok" }, false);
  assert.equal(trace.evidence(task, false, false, false), null, "a hidden state mutation cannot pass as read-only");
});

test("truncated receipts require every page; ask_user and read-to-change transitions fall back", () => {
  const id = "a".repeat(64), task = { status: "running", objective: "列出同事", brief: { intent: "answer" }, decisions: [] };
  const trace = new ReadOnlyAnswerTrace();
  trace.observe("agent_list", "r1", "read", { id: "r1", name: "agent_list", content: "{\"agents\":[]}" }, false);
  trace.observeModelView(`Full receipt: receipt-${id}.json; use workspace_receipt_read`, []);
  assert.equal(trace.evidence(task, false, false, false), null);
  const first = { file: `receipt-${id}.json`, offset: 0, nextOffset: 1000, totalChars: 1500, content: "x".repeat(1000) };
  trace.observe("workspace_receipt_read", "page1", "state", { id: "page1", name: "workspace_receipt_read", content: JSON.stringify(first) }, false);
  assert.equal(trace.evidence(task, false, false, false), null);
  const second = { file: `receipt-${id}.json`, offset: 1000, nextOffset: null, totalChars: 1500, content: "x".repeat(500) };
  trace.observe("workspace_receipt_read", "page2", "state", { id: "page2", name: "workspace_receipt_read", content: JSON.stringify(second) }, false);
  assert.equal(trace.evidence(task, false, false, false).length, 3);
  const referencesOnly = new ReadOnlyAnswerTrace();
  referencesOnly.observe("workspace_skill", "skill", "read", { id: "skill", name: "workspace_skill", content: "instructions" }, false);
  assert.equal(referencesOnly.evidence(task, false, false, false), null, "instructions alone are not answer evidence");
  assert.equal(trace.evidence({ ...task, brief: { intent: "change" } }, false, false, false), null);
  trace.observe("ask_user", "ask", "interactive", { id: "ask", name: "ask_user", content: "pending" }, false);
  assert.equal(trace.evidence(task, false, false, false), null);
  const resumed = new ReadOnlyAnswerTrace();
  resumed.observe("agent_list", "r2", "read", { id: "r2", name: "agent_list", content: "{}" }, false);
  resumed.observeModelView("", [{ role: "assistant", text: "", toolUses: [call("old", "workspace_write", { path: "x" })] }]);
  assert.equal(resumed.evidence(task, false, false, false), null, "earlier non-read calls in the same attempt cannot disappear on resume");
});
