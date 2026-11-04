import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {setup} from "./helpers/local-channels.mjs";
import {WorkspaceConversationStore} from "../dist/workspace/conversations.js";
import {WorkspaceRuntimeStageStore} from "../dist/workspace/runtime-stage-events.js";
test("full-protected Pi channel retains native runtime proof for every ordered member", async () => {
  const f = await setup(2);
  try {
    const channel = f.create();
    f.host.sendChannel("client", f.id, channel, "hello group", randomUUID(), f.members);
    await f.host.waitChannel(f.id, channel);
    const view = f.host.channelSnapshot(f.id, channel, "client");
    assert.equal(view.state, "completed");
    assert.equal(view.messages.filter(row => row.message.role === "user").length, 1);
    assert.equal(view.messages.filter(row => row.message.role === "assistant").length, 2);
    assert.deepEqual(f.calls.map(row => row.agentId), f.members);
    for (const agentId of f.members) {
      const storage = f.host.context(f.id).storage;
      const conversation = new WorkspaceConversationStore(storage, agentId, channel).read();
      assert.equal(conversation.task.workspaceAgentBinding.permissionTier, "full-protected");
      assert.equal(conversation.attempt.state, "completed");
      assert.equal(conversation.task.workspaceAgentBinding.runtimeId, "pi");
      const stages = new WorkspaceRuntimeStageStore(storage, conversation.sessionId, agentId).list();
      const stage = stages.find(attempt => attempt.runId === conversation.task.workspaceRunBinding.runId);
      assert.equal(stage.runtime.id, "pi");
      assert.equal(stage.errorKind, null);
      assert.ok(stage.events.some(event => event.kind === "cold_start" && event.phase === "end" && event.outcome === "completed" && event.source === "native_event"));
      assert.ok(stage.events.some(event => event.kind === "model_roundtrip" && event.phase === "end" && event.outcome === "completed"));
    }
    assert.equal(f.host.activity().running, 0);
  } finally { await f.host.close(); }
});
