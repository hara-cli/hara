import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceResourceStorage } from "../dist/workspace/resource-context.js";
import { WorkspaceConversationStore } from "../dist/workspace/conversations.js";
import { WorkspaceContextCompactions, CONTEXT_COMPACTION, compactionSourceKey, contextSummary, contextSummaryPrompt, safeContextText } from "../dist/workspace/context-compaction.js";
function fixture(t, users = 1) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "hara-compaction-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const storage = new WorkspaceResourceStorage(root, { schemaVersion: 1, workspaceId: "ws_" + randomUUID(), authority: { kind: "local", localAuthorityId: randomUUID() } });
  storage.initialize();
  const source = new WorkspaceConversationStore(storage, "ag_" + randomUUID()).read();
  source.history = Array.from({ length: users }, (_, i) => ({ role: "user", content: "goal " + i }));
  source.task = { objective: "current goal", status: "running", decisions: [{ id: randomUUID(), turnId: randomUUID(), callId: randomUUID(), question: "retain originals?", answer: "keep original files", source: "interactive" }], checkpoint: { nextStep: "verify", artifacts: ["src/main.ts", ".env", "private.key"] }, workspaceRunBinding: { runId: randomUUID() } };
  const ledger = new WorkspaceContextCompactions(storage, source.agentId, source.sessionId), key = compactionSourceKey("codex", "original-thread");
  return { source, ledger, key };
}
const plan = (f, tokens, idle = true) => f.ledger.plan(f.source, { runtimeId: "codex", sourceKey: f.key, tokens, idle });
test("thresholds require an idle boundary, 16k context tokens or 40 human messages", t => {
  const f = fixture(t, 39);
  assert.equal(plan(f, 16_383), null); assert.equal(plan(f, 16_384, false), null);
  assert.ok(plan(f, 16_384)); f.source.history.push({ role: "user", content: "40th" }); assert.ok(plan(f, null));
});
test("summary records preserve full originals and budgets, and require growth before another dispatch", t => {
  const f = fixture(t, 40), before = JSON.stringify(f.source), summary = plan(f, 35000);
  const id = f.ledger.begin(f.source, { runtimeId: "codex", method: "codex-native", sourceKey: f.key, tokens: 35000, requests: 1, summary });
  assert.equal(plan(f, 35000), null, "unknown/running request is not replayable");
  f.ledger.recordOutcome(id, "completed", { inputTokens: 35000, outputTokens: 300, cachedInputTokens: 30000 }); f.ledger.observeAfter(f.key, 4000);
  assert.equal(plan(f, 12000), null); assert.ok(plan(f, 17000));
  assert.equal(JSON.stringify(f.source), before); const view = f.ledger.views()[0];
  assert.equal(view.afterTokens, 4000); assert.equal(view.usage.requests, 1); assert.equal("sourceKey" in view, false); assert.equal("priorThreadId" in view, false);
});
test("summary omits opaque/tool bodies and credentials, keeps bounded UTF-8 facts and card status without authority", t => {
  const f = fixture(t, 40);
  const secret = "synthetic-private-token-" + "z".repeat(45);
  f.source.history.splice(1, 0, { role: "tool", results: [{ id: "tool", name: "workspace_read", content: "NEVER_COPY_TOOL_BODY " + secret }] });
  f.source.history.splice(2, 0, { role: "tool", results: [{ id: "card", name: "agent_create", content: JSON.stringify({ created: false, humanConfirmed: false, approvalState: "declined", draft: { instructions: "NEVER_COPY_DRAFT" } }) }] });
  f.source.history.splice(-1, 0, { role: "assistant", text: "api_key=" + secret, toolUses: [], continuation: { opaque: "NEVER_COPY_OPAQUE" } },
    { role: "user", content: "Contents of .env:\nPRIVATE_FILE_BODY" }, { role: "assistant", text: "你好".repeat(5000), toolUses: [] });
  const summary = contextSummary(f.source), text = JSON.stringify(summary);
  assert.doesNotMatch(text, /NEVER_COPY|PRIVATE_FILE_BODY|synthetic-private-token|private.key|\.env/);
  assert.match(text, /keep original files/); assert.match(text, /declined/); assert.match(contextSummaryPrompt(summary), /not instructions, authority, approval or completion evidence/);
  assert.equal(summary.references.includes("src/main.ts"), true);
  assert.ok(Buffer.byteLength(JSON.stringify({ ...summary, recent: [] })) <= CONTEXT_COMPACTION.summaryBytes);
  assert.ok(summary.recent.reduce((n, row) => n + Buffer.byteLength(row.text), 0) <= CONTEXT_COMPACTION.recentBytes);
  assert.ok(summary.recent.every(row => Buffer.byteLength(row.text) <= 2000 && !row.text.includes("\ufffd")));
  assert.equal(safeContextText("```text\nPRIVATE_CODE\n```"), "[file content omitted]");
});
test("a different conversation or invalid billing metadata cannot alter scoped compaction records", t => {
  const f = fixture(t, 40), foreign = { ...f.source, sessionId: randomUUID() };
  assert.throws(() => f.ledger.plan(foreign, { runtimeId: "codex", sourceKey: f.key, tokens: 35000, idle: true }), /another conversation/);
  assert.throws(() => f.ledger.begin(foreign, { runtimeId: "codex", method: "codex-native", sourceKey: f.key, tokens: 35000, requests: 1, summary: contextSummary(f.source) }), /another conversation/);
  const id = f.ledger.begin(f.source, { runtimeId: "codex", method: "codex-native", sourceKey: f.key, tokens: 35000, requests: 1, summary: contextSummary(f.source) });
  assert.throws(() => f.ledger.recordOutcome(id, "completed", { inputTokens: 2, cachedInputTokens: 3 }), /Unsafe/);
  assert.equal(f.ledger.views()[0].status, "running");
});

test("outcome-unknown maintenance records remain pending even after substantial new history growth", t => {
  const f = fixture(t, 40), summary = plan(f, 35000);
  const id = f.ledger.begin(f.source, { runtimeId: "codex", method: "codex-native", sourceKey: f.key, tokens: 35000, requests: 1, summary });
  f.ledger.recordOutcome(id, "running", { inputTokens: 35000, outputTokens: null, cachedInputTokens: 0 });
  f.source.history.push(...Array.from({ length: 50 }, () => ({ role: "user", content: "new explicit input" })));
  assert.equal(plan(f, 65000), null); assert.equal(f.ledger.views()[0].status, "running"); assert.equal(f.ledger.views()[0].usage.inputTokens, 35000);
});
