import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { LocalWorkspaceHost } from "../dist/workspace/local-host.js";
import { WorkspaceResourceStorage, workspaceStateHome } from "../dist/workspace/resource-context.js";
import { createWorkspaceSyntheticProvider } from "../dist/workspace/synthetic-provider.js";
import { channelSessionId } from "../dist/workspace/channel-session.js";
import { WorkspaceRequestJournal } from "../dist/workspace/request-journal.js";
import { WorkspaceConversationStore } from "../dist/workspace/conversations.js";
import { setup, until } from "./helpers/local-channels.mjs";

test("local channels support more than ten colleagues, one user turn and ordered replies without cloud login", async () => {
  const f = await setup(13);
  try {
    const channel = f.create(); f.host.sendChannel("client", f.id, channel, "hello group", randomUUID(), f.members);
    await f.host.waitChannel(f.id, channel); const view = f.host.channelSnapshot(f.id, channel, "client");
    assert.equal(view.channel.memberIds.length, 13); assert.equal(view.state, "completed");
    assert.equal(view.messages.filter(row => row.message.role === "user").length, 1);
    assert.equal(view.messages.filter(row => row.message.role === "assistant").length, 13);
    assert.deepEqual(f.calls.map(row => row.agentId), f.members);
    assert.ok(f.calls[1].system.includes("Colleague 0: hello group"), "later colleagues see earlier group responses");
    assert.equal(f.host.activity().running, 0);
  } finally { await f.host.close(); }
});
