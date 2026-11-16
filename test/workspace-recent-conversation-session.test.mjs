// Recent private conversation: discussion closeout and native-session reset boundary (split for the per-file runner limit).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setup, until } from "./helpers/local-channels.mjs";
import { RECENT_CONVERSATION, recentConversation, recentConversationPrompt, contextSummaryPrompt, distinctiveConversationTerm } from "../dist/workspace/context-compaction.js";
import { recentConversationEligible } from "../dist/workspace/local-host.js";
import { workspaceTaskProjection } from "../dist/workspace/model-context.js";
import { discussionHandback, asksHumanQuestion } from "../dist/agent/loop.js";
import { UI, reply, call, unwrap, recentBlock, parseRecent, scripted, send } from "./helpers/recent-conversation.mjs";

test("a discussion reply that asks the human a question is not labelled paused without a receipt", async () => {
  const ask = "帮我规划团队岗位，再建几个同事", claim = "帮我规划岗位，然后建几个同事吧";
  const { factory } = scripted({ [ask]: [reply("建议先设三个岗位。你想先建哪两个？")], [claim]: [reply("已经建好了。")] });
  const f = await setup(0, factory), main = f.workspace.selectedAgentId;
  try {
    await send(f, main, ask);
    let view = f.host.snapshot(f.id, main).conversation;
    assert.equal(view.history.at(-1).text, "建议先设三个岗位。你想先建哪两个？");
    assert.equal(view.history.some(row => row.role === "assistant" && /任务已暂停|尚未取得操作回执/.test(row.text)), false);
    assert.notEqual(view.taskState, "completed", "a discussion never becomes a verified completion");
    await send(f, main, claim);
    view = f.host.snapshot(f.id, main).conversation;
    assert.match(view.history.at(-1).text, /尚未取得操作回执/, "prose without a question keeps the honest closeout");
  } finally { await f.host.close(); }
});

test("an explicit native-session reset is a hard boundary for the recent view", async () => {
  const { calls, factory } = scripted({});
  const f = await setup(1, factory), agent = f.members[0];
  try {
    await send(f, agent, "BEFORE-RESET-MARKER 旧话题");
    f.host.selectAgent("client", f.id, agent);
    const view = f.host.snapshot(f.id, agent, "client").conversation;
    assert.equal(view.nativeSession.runtimeId, "pi");
    await f.host.newNativeSession("client", f.id, agent, view.revision, view.nativeSession.revision, randomUUID());
    await send(f, agent, "AFTER-RESET-ONE 新话题");
    await send(f, agent, "那新话题还有什么");
    const last = calls.filter(row => row.objective === "那新话题还有什么")[0] ?? calls.at(-1);
    const block = recentBlock(last.history);
    assert.ok(block, "post-reset turns still form a recent view");
    assert.match(String(block.content), /AFTER-RESET-ONE/);
    for (const row of calls.filter(row => !row.objective.startsWith("BEFORE-RESET"))) assert.doesNotMatch(JSON.stringify(row.history), /BEFORE-RESET-MARKER/);
  } finally { await f.host.close(); }
});
