// Recent private conversation: audience wiring through the real Host (split for the per-file runner limit).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setup, until } from "./helpers/local-channels.mjs";
import { RECENT_CONVERSATION, recentConversation, recentConversationPrompt, contextSummaryPrompt, distinctiveConversationTerm } from "../dist/workspace/context-compaction.js";
import { recentConversationEligible } from "../dist/workspace/local-host.js";
import { workspaceTaskProjection } from "../dist/workspace/model-context.js";
import { discussionHandback, asksHumanQuestion } from "../dist/agent/loop.js";
import { UI, reply, call, unwrap, recentBlock, parseRecent, scripted, send } from "./helpers/recent-conversation.mjs";

test("wiring: group channels, resumes and internal starts carry no recent view; a human private follow-up does", async () => {
  const { calls, factory } = scripted({});
  const f = await setup(2, factory), agent = f.members[0];
  try {
    await send(f, agent, "PRIVATE_DM_MARKER 只在私聊里说");
    // Two turns in one group channel: the second has earlier channel history, yet carries no view.
    const channel = f.create("Group");
    for (const text of ["group question one", "group question two"]) { f.host.sendChannel("client", f.id, channel, text, randomUUID(), [agent]); await f.host.waitChannel(f.id, channel); }
    const group = calls.filter(row => row.objective.includes("group question"));
    assert.ok(group.length >= 2);
    for (const row of group) {
      assert.equal(recentBlock(row.history), undefined); assert.doesNotMatch(JSON.stringify(row.history), /hara-recent-conversation/);
      assert.doesNotMatch(JSON.stringify(row.history) + row.system, /PRIVATE_DM_MARKER/);
    }
    // A resume continues its own run transcript and carries no view. (On this Pi fixture a resumed native
    // session prompts only with its durable continuation, so the call-site resume input is guarded by the
    // eligibility table above; a fresh-process Claude resume would read the projection.)
    const beforeResume = calls.length;
    await send(f, agent, "继续");
    const resumeCalls = calls.slice(beforeResume);
    assert.ok(resumeCalls.length >= 1, "the resume reached the model");
    for (const row of resumeCalls) assert.equal(recentBlock(row.history), undefined, "resume");
    const before = calls.length;
    // Host-internal starts (delegation/wake/schedule paths) are not a human's private follow-up.
    await send(f, agent, "internal follow-up", { source: "host", channel: "internal", clientId: "client" });
    for (const row of calls.slice(before)) assert.equal(recentBlock(row.history), undefined, "internal origin");
    // Positive control: a human follow-up in the private conversation does receive it.
    await send(f, agent, "human follow-up");
    assert.match(String(recentBlock(calls.find(row => row.objective === "human follow-up").history)?.content), /PRIVATE_DM_MARKER/);
  } finally { await f.host.close(); }
});
