import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { workspaceTaskHistory, workspaceTaskProjection, workspaceWakeBrief, WORKSPACE_CONTEXT_LIMITS } from "../dist/workspace/model-context.js";
import { messageBody, text } from "../dist/workspace/local-state.js";
import { LocalWorkspaceHost } from "../dist/workspace/local-host.js";
import { createWorkspaceSyntheticProvider } from "../dist/workspace/synthetic-provider.js";
import { WorkspaceContextReceipts } from "../dist/workspace/context-receipts.js";
import { WorkspaceResourceStorage, workspaceStateHome } from "../dist/workspace/resource-context.js";

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

test("oversized output is retained in full, latest previews keep head4k/tail1k and two-round-old output stays below2k", () => {
  const history = [{ role: "user", content: "current" }], retained = [];
  for (let i = 0; i < 4; i++) {
    history.push({ role: "assistant", text: "", toolUses: [{ id: `call${i}`, name: "fixture_read", input: {} }], continuation: { type: "chat_reasoning", text: `provider-exact-${i}` } });
    history.push({ role: "tool", results: [{ id: `call${i}`, name: "fixture_read", content: `${i}HEAD` + "x".repeat(20000) + `${i}TAIL` }] });
  }
  const before = JSON.stringify(history), retain = result => { retained.push(result); return `receipt-${"a".repeat(64)}.json`; };
  const projected = workspaceTaskProjection(history, 0, { retain });
  assert.equal(JSON.stringify(history), before); assert.equal(retained.length, 4);
  assert.ok(retained.every(result => result.content.length > 20000));
  const results = projected.history.filter(row => row.role === "tool").flatMap(row => row.results);
  assert.ok(results.slice(0, 2).every(row => row.content.length <= 2000));
  assert.ok(results.slice(-2).every(row => row.content.length <= 8000));
  assert.ok(results.at(-1).content.startsWith(history.at(-1).results[0].content.slice(0, 4000)));
  assert.ok(results.at(-1).content.endsWith(history.at(-1).results[0].content.slice(-1000)));
  assert.match(results.at(-1).content, /receipt-[a-f0-9]{64}\.json/);
  assert.equal(projected.stats.compacted, false); assert.ok(projected.stats.agedToolMaxChars <= 2000);
  assert.equal(projected.history[1].continuation.text, "provider-exact-0");
  history.at(-1).results[0] = { id: "error-call", name: "fixture_read", content: "Error: failed\nstack\nmore".repeat(900), isError: true };
  history.at(-2).toolUses[0].id = "error-call";
  const error = workspaceTaskProjection(history, 0, { retain }).history.at(-1).results[0].content;
  assert.equal(error.includes("\n"), false); assert.ok(error.length <= 2000);
});

test("72% shared-task usage triggers deterministic 2k summary plus approximately18% whole recent units, without resetting usage or stripping reasoning", () => {
  const history = [{ role: "user", content: "current objective" }];
  for (let i = 0; i < 30; i++) history.push({ role: "assistant", text: "observed", toolUses: [{ id: `call${i}`, name: "fixture_read", input: {} }], continuation: { type: "chat_reasoning", text: "exact" } },
    { role: "tool", results: [{ id: `call${i}`, name: "fixture_read", content: "data".repeat(400) }] });
  const before = JSON.stringify(history), options = { usedTokens: 57599, maxTokens: 80000, retain: () => `receipt-${"b".repeat(64)}.json` };
  assert.equal(workspaceTaskProjection(history, 0, options).stats.compacted, false);
  const projected = workspaceTaskProjection(history, 0, { ...options, usedTokens: 57600 });
  assert.equal(projected.stats.compacted, true); assert.ok(projected.stats.summaryChars > 0 && projected.stats.summaryChars <= 2000);
  assert.ok(projected.stats.recentChars / projected.stats.originalChars >= 0.15);
  assert.ok(projected.stats.recentChars / projected.stats.originalChars <= 0.22);
  for (let i = 1; i < projected.history.length; i += 2) {
    assert.equal(projected.history[i].role, "assistant"); assert.equal(projected.history[i + 1].role, "tool");
    assert.equal(projected.history[i].toolUses[0].id, projected.history[i + 1].results[0].id); assert.equal(projected.history[i].continuation.text, "exact");
  }
  assert.equal(JSON.stringify(history), before); assert.equal(options.usedTokens, 57599);
});

test("wake brief is below8k total and each data item below2k; full long checkpoint is retained for paging", () => {
  const task = { objective: "目標".repeat(2000), brief: { goal: "goal".repeat(2000) }, checkpoint: { facts: { source: "fact".repeat(8000) } }, decisions: ["yes".repeat(3000)] };
  const retained = [], brief = workspaceWakeBrief(task, result => { retained.push(result); return `receipt-${"c".repeat(64)}.json`; });
  assert.ok(brief.length <= 8000); assert.ok(brief.split("\n").every(line => line.length <= 2000));
  assert.equal(retained.length, 1); assert.deepEqual(JSON.parse(retained[0].content), [task.objective, task.brief, task.checkpoint, task.decisions]);
  assert.match(brief, /workspace_receipt_read/); assert.equal(WORKSPACE_CONTEXT_LIMITS.compactAt, 0.72);
});

test("retained full-output files are scoped to Workspace/Agent/run, survive reopen, and paginate below8k without global HOME access", async () => {
  const path = root(), host = new LocalWorkspaceHost(path);
  try {
    const ws = host.createWorkspace("Receipts", host.list().revision), row = host.catalog.resolve(ws.workspaceId), storage = new WorkspaceResourceStorage(host.home, row.scope); storage.initialize();
    const runId = randomUUID(), receipts = new WorkspaceContextReceipts(storage, runId, ws.selectedAgentId, () => {});
    const result = { id: "actual-id", name: "fixture_read", content: "line\n".repeat(4000) + "exact tail" };
    const file = receipts.retain(result), id = file.slice(8, -5), tool = receipts.tool();
    assert.equal(tool.classify().effect, "state"); assert.match(file, /^receipt-[a-f0-9]{64}\.json$/);
    const pieces = []; let offset = 0;
    while (offset !== null) { const pageRaw = await tool.run({ id, offset }, {}); assert.ok(pageRaw.length <= 8000);
      const page = JSON.parse(pageRaw); pieces.push(page.content); offset = page.nextOffset; }
    assert.deepEqual(JSON.parse(pieces.join("")), result);
    assert.equal(new WorkspaceContextReceipts(storage, runId, ws.selectedAgentId, () => {}).retain(result), file);
    const other = host.createWorkspace("Other", host.list().revision), otherStorage = new WorkspaceResourceStorage(host.home, host.catalog.resolve(other.workspaceId).scope); otherStorage.initialize();
    await assert.rejects(new WorkspaceContextReceipts(otherStorage, runId, ws.selectedAgentId, () => {}).tool().run({ id, offset: 0 }, {}), /unavailable/);
    await assert.rejects(new WorkspaceContextReceipts(storage, randomUUID(), ws.selectedAgentId, () => {}).tool().run({ id, offset: 0 }, {}), /ownership/);
    await assert.rejects(tool.run({ id: "../secret", offset: 0 }, {}), /invalid/);
    const revoked = new WorkspaceContextReceipts(storage, runId, ws.selectedAgentId, () => { throw new Error("revoked"); });
    assert.throws(() => revoked.retain(result), /revoked/);
    assert.equal(fs.existsSync(join(host.home, ".hara/tool-results")), false);
  } finally { await host.close(); }
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

test("a verbose colleague completion returns at most2k characters with its full handoff retained privately", async () => {
  const path = root(), host = new LocalWorkspaceHost(path, { providerFactory(connection, binding, context) {
    const provider = createWorkspaceSyntheticProvider(connection, binding, context);
    return { ...provider, async turn(args) {
      const result = await provider.turn(args);
      if (context.agent.kind === "colleague") for (const use of result.toolUses) {
        if (use.name === "task_intake") use.input.acceptance = Array.from({ length: 8 }, (_, i) => `Exact file criterion ${i}`);
        if (use.name === "task_checkpoint" && use.input.completion?.checks) {
          const check = use.input.completion.checks[0]; use.input.completion.checks = Array.from({ length: 8 }, (_, acceptance_index) => ({ ...check, acceptance_index, evidence: "Observed exact file bytes ".repeat(12) }));
        }
      }
      return result;
    } };
  } });
  try {
    const ws = host.createWorkspace("Handoff", host.list().revision); host.configureSynthetic(ws.workspaceId, 0); host.select("test", ws.workspaceId, host.list().revision);
    let run = host.start("test", ws.workspaceId, ws.selectedAgentId, "建立同事 Coder", randomUUID());
    const card = await until(() => host.snapshot(ws.workspaceId, ws.selectedAgentId, "test").approvals[0]); host.answerApproval("test", ws.workspaceId, card.id, true); await host.wait(run.runId);
    run = host.start("test", ws.workspaceId, ws.selectedAgentId, "委派 Coder 生成 hello.md 並驗證", randomUUID()); await host.wait(run.runId);
    const view = host.snapshot(ws.workspaceId), response = view.conversation.history.flatMap(row => row.role === "tool" ? row.results : []).find(row => row.name === "agent_contact");
    assert.equal(view.conversation.taskState, "completed"); assert.ok(response.content.length <= 2000);
    const handoff = JSON.parse(response.content); assert.equal(handoff.completed, true); assert.equal(handoff.completion.state, "verified");
    assert.match(handoff.fullReceiptFile, /^receipt-[a-f0-9]{64}\.json$/);
    const child = host.snapshot(ws.workspaceId, handoff.agentId); assert.equal(child.conversation.completion.evidence.length, 8);
    assert.ok(JSON.stringify(child.conversation.completion).length > 2000, "the full completion was not replaced by its handoff preview");
  } finally { await host.close(); }
});

test("actual governed Host compacts at72% without an extra Provider or a usage reset, then closes with fresh verification", async () => {
  const path = root(); let calls = 0;
  const host = new LocalWorkspaceHost(path, { providerFactory(_connection, binding) {
    return { id: "openai", model: binding.model, trailingTurnContext: true, async turn() {
      const index = calls++, steps = [
        [{ id: "intake", name: "task_intake", input: { intent: "change", goal: "write hello.md", constraints: [], acceptance: ["exact bytes verified"], steps: ["write", "verify"] } }],
        [{ id: "write", name: "workspace_write", input: { path: "hello.md", content: "hello workspace\n" } }],
        [{ id: "verify", name: "workspace_verify", input: { path: "hello.md", expectedContent: "hello workspace\n" } }],
        [{ id: "complete", name: "task_checkpoint", input: { completion: { state: "verified", checks: [{ acceptance_index: 0, evidence: "exact file bytes verified", tool_call_ids: ["verify"] }], final_answer: "verified" } } }],
      ];
      assert.ok(index < 4); return { text: "", toolUses: steps[index], stop: "tool_use", usage: { input: index < 2 ? 11520 : 10, output: 1 } };
    } };
  } });
  try {
    const ws = host.createWorkspace("Compaction", host.list().revision); host.configureSynthetic(ws.workspaceId, 0);
    const run = host.start("test", ws.workspaceId, ws.selectedAgentId, "write hello.md and verify", randomUUID()); await host.wait(run.runId);
    const view = host.snapshot(ws.workspaceId); assert.equal(view.conversation.taskState, "completed"); assert.equal(view.conversation.completion.state, "verified");
    assert.equal(calls, 4); assert.equal(view.conversation.runUsage.modelCalls, 4); assert.equal(view.conversation.runUsage.inputTokens + view.conversation.runUsage.outputTokens, 23064);
    const storage = new WorkspaceResourceStorage(host.home, host.catalog.resolve(ws.workspaceId).scope); storage.initialize();
    const audit = JSON.parse(fs.readFileSync(storage.run(() => join(workspaceStateHome(), ".hara", `context-${run.runId}.json`)), "utf8"));
    assert.equal(audit.observations.length, 4); assert.equal(audit.observations[1].compacted, false); assert.equal(audit.observations[2].compacted, true);
    assert.ok(audit.observations.every(row => row.wakeChars <= 8000 && row.toolMaxChars <= 8000 && row.agedToolMaxChars <= 2000 && row.summaryChars <= 2000));
    assert.ok(view.conversation.history.some(row => row.role === "assistant" && row.tools.includes("task_intake")), "compaction did not delete the original history");
  } finally { await host.close(); }
});

test("actual scoped80k output remains complete in local history but enters the model as a bounded private-file preview", async () => {
  const path = root(); let calls = 0, preview = "";
  const host = new LocalWorkspaceHost(path, { providerFactory(_connection, binding) {
    return { id: "openai", model: binding.model, async turn(args) {
      const index = calls++;
      if (index === 0) return { text: "", stop: "tool_use", toolUses: [{ id: "intake-large", name: "task_intake", input: { intent: "investigate", goal: "read large fixture", constraints: ["read only"], acceptance: ["actual file observed"], steps: ["read"] } }] };
      if (index === 1) return { text: "", stop: "tool_use", toolUses: [{ id: "read-large", name: "workspace_read", input: { path: "large.md" } }] };
      assert.equal(index, 2); preview = args.history.filter(m => m.role === "tool").flatMap(m => m.results).find(r => r.id === "read-large").content;
      assert.ok(preview.length <= 8000); assert.match(preview, /receipt-[a-f0-9]{64}\.json/);
      return { text: "", stop: "tool_use", toolUses: [{ id: "done-large", name: "task_checkpoint", input: { completion: { state: "verified", checks: [{ acceptance_index: 0, evidence: "actual file read was observed", tool_call_ids: ["read-large"] }], final_answer: "observed" } } }] };
    } };
  } });
  try {
    const ws = host.createWorkspace("Large output", host.list().revision); host.configureSynthetic(ws.workspaceId, 0);
    const content = "abcdefg\n".repeat(10000); fs.writeFileSync(join(path, "project", ws.workspaceId, "large.md"), content);
    const run = host.start("test", ws.workspaceId, ws.selectedAgentId, "read large.md only", randomUUID()); await host.wait(run.runId);
    const view = host.snapshot(ws.workspaceId); assert.equal(view.conversation.taskState, "completed");
    const full = view.conversation.history.flatMap(m => m.role === "tool" ? m.results : []).find(r => r.id === "read-large").content;
    assert.ok(full.length > 80000); assert.equal(JSON.parse(full).text, content); assert.ok(preview.length < full.length);
    assert.equal(fs.existsSync(join(host.home, ".hara/tool-results")), false);
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
