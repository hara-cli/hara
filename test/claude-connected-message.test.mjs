import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeAgentSdkAdapter } from "../dist/external-sessions/claude.js";

async function fixture(t, frames) {
  const source = { sessionId: "selected-native-claude", cwd: "/fixture/repo", customTitle: "Selected Claude worker",
    createdAt: 1780000000000, lastModified: 1780000001000 };
  const queries = [], text = [], owned = new Set(); let closes = 0;
  const sdk = {
    async listSessions() { return [source]; }, async getSessionInfo() { return source; },
    async getSessionMessages() { return []; }, async forkSession() { throw new Error("must not fork"); },
    query(input) { queries.push(input); return { async *[Symbol.asyncIterator]() { yield* frames; }, close() { closes++; } }; },
  };
  const adapter = new ClaudeAgentSdkAdapter({ command: process.execPath, sdk, identityKey: Buffer.alloc(32, 13),
    authenticationStatus: async () => "authenticated",
    ownership: { has: (id) => owned.has(id), add: (_source, id) => owned.add(id) },
  });
  t.after(() => adapter.close());
  const sessionId = (await adapter.list({ limit: 10 })).sessions[0].id; await adapter.resume(sessionId);
  return { adapter, sessionId, queries, text, closes: () => closes,
    sink: { existingSessionMessage: true, text: (chunk) => text.push(chunk), notice() {}, tool() {}, confirm: async () => false } };
}

test("linked Claude continuation keeps the selected native identity and confirms completion only from its result", async (t) => {
  const f = await fixture(t, [
    { session_id: "selected-native-claude", type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "Verified result" }] } },
    { session_id: "selected-native-claude", type: "result", subtype: "success", result: "Verified result", errors: [] },
  ]);
  const result = await f.adapter.submit(f.sessionId, "Follow up", f.sink);
  assert.equal(result.status, "completed"); assert.deepEqual(f.text, ["Verified result"]);
  assert.equal(f.queries[0].options.resume, "selected-native-claude");
  assert.equal(f.queries[0].options.permissionMode, "default"); assert.equal(f.queries[0].options.sessionId, undefined);
  assert.equal(f.closes(), 1);
});

test("linked Claude never projects a frame from another native session", async (t) => {
  const f = await fixture(t, [
    { session_id: "another-native-session", type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "Unrelated private output" }] } },
  ]);
  await assert.rejects(f.adapter.submit(f.sessionId, "Follow up", f.sink), /coding_link_delivery_unconfirmed/);
  assert.deepEqual(f.text, []); assert.equal(f.closes(), 1);
});

test("linked Claude stream termination without a native result remains unconfirmed", async (t) => {
  const f = await fixture(t, []);
  await assert.rejects(f.adapter.submit(f.sessionId, "Follow up", f.sink), /coding_link_delivery_unconfirmed/);
  assert.equal(f.queries.length, 1); assert.equal(f.closes(), 1);
});
