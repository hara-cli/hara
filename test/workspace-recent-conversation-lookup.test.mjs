// Recent private conversation: the lookup gate through the real Host (split for the per-file runner limit).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setup, until } from "./helpers/local-channels.mjs";
import { RECENT_CONVERSATION, recentConversation, recentConversationPrompt, contextSummaryPrompt, distinctiveConversationTerm } from "../dist/workspace/context-compaction.js";
import { recentConversationEligible } from "../dist/workspace/local-host.js";
import { workspaceTaskProjection } from "../dist/workspace/model-context.js";
import { discussionHandback, asksHumanQuestion } from "../dist/agent/loop.js";
import { UI, reply, call, unwrap, recentBlock, parseRecent, scripted, send } from "./helpers/recent-conversation.mjs";

test("a lookup answered by a distinctive term in the recent conversation does not raise the missing-target card", async () => {
  const first = "我们在讨论岗位架构：产品经理、开发工程师、设计师，任务先按季度排";
  const { calls, factory } = scripted({
    [first]: [reply("好的，先列三个岗位。")],
    "还有开发工程师的任务": [call("workspace_memory_search", { query: "开发工程师" }), call("workspace_context_lookup", { query: "开发工程师" }),
      call("workspace_memory_search", { query: "开发工程师" }), reply("开发工程师的任务也放进去。")],
    "那个任务呢": [call("workspace_memory_search", { query: "任务" }), call("workspace_memory_search", { query: "任务" }), reply("不应到达")],
    "市场那边呢": [call("workspace_memory_search", { query: "市场营销" }), call("workspace_memory_search", { query: "市场营销" }), reply("不应到达")],
  });
  const f = await setup(1, factory), agent = f.members[0];
  try {
    await send(f, agent, first);
    await send(f, agent, "还有开发工程师的任务");
    let view = f.host.snapshot(f.id, agent).conversation;
    assert.equal(view.pendingQuestion, null);
    const lookup = view.history.filter(row => row.role === "tool").flatMap(row => row.results).find(result => result.name === "workspace_context_lookup");
    const parsed = JSON.parse(lookup.content.split("\n\n<system-reminder>")[0]);
    assert.equal(parsed.status, "resolved"); assert.ok(parsed.hits.some(hit => hit.source === "conversation"));
    assert.equal(calls.filter(row => row.objective === "还有开发工程师的任务").length, 4, "the run reached its reply");
  } finally { await f.host.close(); }
});

test("a common word found in the conversation, or a target it never mentioned, still raises the missing-target card", async () => {
  const first = "我们在讨论岗位架构：产品经理、开发工程师、设计师，任务先按季度排";
  const { factory } = scripted({
    [first]: [reply("好的，先列三个岗位。")],
    "那个任务呢": [call("workspace_memory_search", { query: "任务" }), call("workspace_memory_search", { query: "任务" }), reply("不应到达")],
    "市场那边呢": [call("workspace_memory_search", { query: "市场营销" }), call("workspace_memory_search", { query: "市场营销" }), reply("不应到达")],
  });
  const f = await setup(2, factory);
  try {
    // Each case on its own colleague: a pending card holds that colleague's conversation.
    for (const [other, message] of [[f.members[0], "那个任务呢"], [f.members[1], "市场那边呢"]]) {
      await send(f, other, first);
      f.host.start("client", f.id, other, message, randomUUID(), false, undefined, undefined, UI);
      const card = await until(() => { const value = f.host.snapshot(f.id, other).conversation; return value.pendingQuestion ? value : null; });
      assert.equal(card.pendingQuestion.reason, "lookup_missing", message);
    }
  } finally { await f.host.close(); }
});
