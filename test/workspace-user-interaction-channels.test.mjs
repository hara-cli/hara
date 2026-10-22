import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { WorkspaceResourceStorage } from "../dist/workspace/resource-context.js";
import { WorkspaceConversationStore } from "../dist/workspace/conversations.js";
import { setup } from "./helpers/local-channels.mjs";

test("a channel question targets only its original colleague and resumes the same run in a new answer turn", async () => {
  let calls = 0;
  const f = await setup(2, (_connection, binding) => ({ id: "openai", model: binding.model, async turn() {
    calls++;
    return calls === 1 ? { text: "", toolUses: [{ id: randomUUID(), name: "ask_user", input: { question: "Which synthetic target?", options: ["Beta"] } }], stop: "tool_use" }
      : { text: "Continued from the saved point", toolUses: [], stop: "end" };
  } }));
  try {
    const channel = f.create(), agentId = f.members[0], requestId = randomUUID();
    f.host.sendChannel("client", f.id, channel, "Clarify the target", requestId, [agentId]); await f.host.waitChannel(f.id, channel);
    const before = f.host.channelSnapshot(f.id, channel, "client"), q = before.questions[0].conversation.pendingQuestion;
    assert.equal(before.questions.length, 1); assert.equal(before.questions[0].agentId, agentId); assert.equal(calls, 1);
    assert.equal(f.host.snapshot(f.id, agentId).conversation.pendingQuestion, null, "a channel question never enters private chat");
    assert.throws(() => f.host.answerChannel("client", f.id, channel, f.members[1], q.id, "Beta", randomUUID()), /changed/);
    const answerId = randomUUID(); f.host.answerChannel("client", f.id, channel, agentId, q.id, "Beta", answerId); await f.host.waitChannel(f.id, channel);
    const after = f.host.channelSnapshot(f.id, channel, "client");
    assert.equal(calls, 2); assert.equal(after.questions.length, 0); assert.equal(after.turns.length, 2);
    assert.deepEqual(after.turns[1].replies.map(row => row.agentId), [agentId]);
    assert.equal(after.messages.find(row => row.turnId === answerId && row.message.role === "user").message.content, "Beta");
    const storage = new WorkspaceResourceStorage(f.host.home, f.host.catalog.resolve(f.id).scope); storage.initialize();
    const value = new WorkspaceConversationStore(storage, agentId, channel).read();
    assert.equal(value.task.id, q.taskId); assert.equal(value.task.workspaceRunBinding.runId, q.runId);
    f.host.answerChannel("client", f.id, channel, agentId, q.id, "Beta", answerId); assert.equal(calls, 2);
    assert.throws(() => f.host.answerChannel("client", f.id, channel, agentId, q.id, "Different", answerId), /identity already used/);
    const other = f.create("Other"); assert.throws(() => f.host.answerChannel("client", f.id, other, agentId, q.id, "Beta", randomUUID()), /changed/);
    assert.equal(calls, 2);
  } finally { await f.host.close(); }
});
