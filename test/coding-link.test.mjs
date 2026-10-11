import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnectedCodingSessionTool, codingLinkCommandId, codingLinkTargetAvailable, isConversationCodingLink } from "../dist/serve/coding-link.js";
import { toolOperationTraits } from "../dist/tools/registry.js";
import { saveSession, loadSession } from "../dist/session/store.js";

const link = { sessionId: `ext_codex_${"a".repeat(24)}`, sourceId: "codex", workspaceId: "workspace-fixture",
  title: "Implementation", revision: randomUUID(), linkedAt: "2026-10-11T00:00:00.000Z" };
const target = () => ({ session: { id: link.sessionId, sourceId: link.sourceId, workspaceId: link.workspaceId,
  title: link.title, workspaceName: "repo", state: "working", createdAt: link.linkedAt, updatedAt: link.linkedAt, ephemeral: false },
  messages: [], readOnly: false, controlMode: "live", conversationLinkAvailable: true });
function fixture(overrides = {}) {
  const sent = [];
  const tool = createConnectedCodingSessionTool({ link, parentSessionId: "parent", turnId: "turn", targetLabel: link.title,
    assertCurrent() {}, read: async () => target(), send: async (text, commandId) => { sent.push({ text, commandId }); return { status: "accepted" }; }, ...overrides });
  return { sent, tool, run: async (input, ctx = {}) => JSON.parse(await tool.run(input, { cwd: "/fixture", toolCallId: "call-1", ...ctx })) };
}
test("a coding link is a validated durable address, not a guessed model or native session id", () => {
  assert.equal(isConversationCodingLink(link), true);
  for (const patch of [{ sourceId: "opencode" }, { sourceId: {} }, { sessionId: "native-thread" },
    { sessionId: `ext_claude_${"a".repeat(24)}` }, { revision: "-".repeat(36) }, { workspaceId: "" }, { linkedAt: "not a time" }]) {
    assert.equal(isConversationCodingLink({ ...link, ...patch }), false);
  }
  assert.equal(codingLinkTargetAvailable(target()), true);
  for (const patch of [{ conversationLinkAvailable: false }, { readOnly: true }, { controlMode: "history" },
    { session: { ...target().session, state: "unknown" } }, { session: { ...target().session, sourceId: "runtime", agentKind: "other" } }]) {
    assert.equal(codingLinkTargetAvailable({ ...target(), ...patch }), false);
  }
});
test("every message demands a fresh approval containing the exact selected address", () => {
  const { tool } = fixture();
  const operation = toolOperationTraits(tool, { action: "message", text: "Run tests" });
  assert.equal(operation.requiresExplicitApproval, true);
  assert.equal(operation.effect, "exec");
  assert.match(operation.approvalTarget, /Implementation/);
  assert.ok(operation.approvalTarget.includes(link.sessionId));
  assert.equal(toolOperationTraits(tool, { action: "read" }).requiresExplicitApproval, undefined);
});
test("target substitution, stale selection, private workers and cancellation never dispatch", async () => {
  const ordinary = fixture();
  assert.equal((await ordinary.run({ action: "message", text: "hello", sessionId: "another-session" })).reasonCode, "coding_link_invalid_input");
  assert.deepEqual(ordinary.sent, []);
  const changed = fixture({ read: async () => ({ ...target(), session: { ...target().session, workspaceId: "other" } }) });
  assert.equal((await changed.run({ action: "read" })).reasonCode, "coding_link_target_changed");
  const privateWorker = fixture({ read: async () => ({ ...target(), conversationLinkAvailable: false, messages: [{ role: "assistant", text: "private worker" }] }) });
  assert.equal((await privateWorker.run({ action: "read" })).reasonCode, "coding_link_target_not_shareable");
  assert.equal((await privateWorker.run({ action: "message", text: "hello" })).reasonCode, "coding_link_target_not_shareable");
  let current = true;
  const stale = fixture({ assertCurrent() { if (!current) throw new Error("coding_link_no_longer_current"); }, read: async () => { current = false; return target(); } });
  assert.equal((await stale.run({ action: "message", text: "hello" })).reasonCode, "coding_link_no_longer_current");
  const controller = new AbortController(); controller.abort();
  assert.equal((await ordinary.run({ action: "message", text: "hello" }, { signal: controller.signal })).reasonCode, "coding_link_cancelled");
  assert.deepEqual(ordinary.sent, []);
});
test("readback is recent, bounded and credential-redacted; adapter errors do not cross conversations", async () => {
  const secret = "sk-fixturecredential1234567890";
  const f = fixture({ read: async () => ({ ...target(), session: { ...target().session, title: `API_KEY=${secret}` },
    messages: Array.from({ length: 20 }, (_, i) => ({ id: `msg-${i}`, role: "assistant", text: `${i}: ${"x".repeat(2500)} API_KEY=${secret}` })) }) });
  const read = await f.run({ action: "read" });
  assert.ok(read.messages.length <= 12);
  assert.ok(read.messages.reduce((sum, message) => sum + message.text.length, 0) <= 12000);
  assert.ok(read.messages.every((message) => message.text.length <= 2000));
  assert.doesNotMatch(JSON.stringify(read), new RegExp(secret));
  assert.doesNotMatch(JSON.stringify(await f.run({ action: "status" })), new RegExp(secret));
  const failing = fixture({ send: async () => { throw new Error(`upstream request API_KEY=${secret}`); } });
  const receipt = await failing.run({ action: "message", text: "hello" });
  assert.equal(receipt.reasonCode, "coding_link_operation_failed");
  assert.doesNotMatch(JSON.stringify(receipt), /upstream request|sk-fixture/);
});
test("same model-call replay has a stable receipt id; a new turn or relink cannot reuse it", async () => {
  const f = fixture();
  assert.equal((await f.run({ action: "message", text: "hello" })).status, "accepted");
  await f.run({ action: "message", text: "hello" });
  assert.equal(f.sent[0].commandId, f.sent[1].commandId);
  assert.match(f.sent[0].commandId, /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.notEqual(codingLinkCommandId("parent", "turn-2", link.revision, "call-1"), f.sent[0].commandId);
  assert.notEqual(codingLinkCommandId("parent", "turn", randomUUID(), "call-1"), f.sent[0].commandId);
  assert.notEqual(codingLinkCommandId("another-parent", "turn", link.revision, "call-1"), f.sent[0].commandId);
});
test("coding links and Agent delegation provenance survive real session persistence", (t) => {
  const home = mkdtempSync(join(tmpdir(), "hara-coding-link-store-"));
  const previous = process.env.HOME; process.env.HOME = home;
  t.after(() => { process.env.HOME = previous; rmSync(home, { recursive: true, force: true }); });
  const cwd = join(home, "repo"); mkdirSync(cwd);
  const id = randomUUID(); const at = new Date().toISOString();
  const agentDelegation = { rootSessionId: randomUUID(), rootTurnId: randomUUID(), parentSessionId: randomUUID(), parentTurnId: randomUUID(),
    fromAgentRef: "global:fanli", toAgentRef: "global:coder", depth: 1 };
  saveSession({ id, cwd, provider: "fake", model: "fixture", title: "Test", createdAt: at, updatedAt: at,
    profileId: "personal", spaceId: "personal", agentRef: "global:coder", codingSessionLink: link, agentDelegation }, []);
  const restored = loadSession(id);
  assert.ok(restored);
  assert.deepEqual(restored.meta.codingSessionLink, link);
  assert.deepEqual(restored.meta.agentDelegation, agentDelegation);
});
