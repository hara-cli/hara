import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { cliMcpFixture, until } from "./helpers/workspace-cli-mcp.mjs";
import { workspaceOperationSkill } from "../dist/workspace/operation-cards.js";

const done = view => ["completed", "blocked", "paused", "cancelled"].includes(view.conversation.state);
const standingState = f => {
  const file = fs.readdirSync(f.root, { recursive: true }).find(name => /(?:^|\/)codex-thread-[a-f0-9]+\.json$/.test(name));
  assert.ok(file); return JSON.parse(fs.readFileSync(join(f.root, file), "utf8"));
};

test("five different governed messages keep one loaded Codex thread, bounded greetings and no repeated standing in native history", async t => {
  const f = await cliMcpFixture(t, "reply"), hashes = [], pids = [];
  const messages = ["你好", "What is known about the video project?", "谢谢", "How do approvals work?", "Create a colleague for the video project"];
  const skill = workspaceOperationSkill(), card = skill.files["cards/create-colleague.md"];
  for (let i = 0; i < messages.length; i++) {
    // Preserve N1/C-lite: external/context answers and thanks still need an observed read.
    // Only the first greeting uses the existing narrow tool-free conversational path.
    f.mode(i === 0 ? "reply" : i === messages.length - 1 ? "create-direct" : "list");
    await f.send(messages[i]);
    if (i === messages.length - 1) {
      const pending = await until(f.read, view => view.approvals.some(value => value.kind === "agent_create"));
      assert.equal(pending.agents.length, 1); assert.equal(pending.conversation.runUsage.modelCalls, 1);
      const proposal = pending.approvals.find(value => value.kind === "agent_create");
      await assert.rejects(f.request("workspace.approval.respond", { ...f.scope, approvalId: "invalid", approved: true }));
      assert.equal((await f.read()).agents.length, 1);
      await f.request("workspace.approval.respond", { ...f.scope, approvalId: proposal.id, approved: false });
    }
    const view = await until(f.read, done);
    if (i < messages.length - 1) assert.equal(view.conversation.state, "completed", JSON.stringify({ messageIndex: i, blockReason: view.conversation.blockReason, completion: view.conversation.completion }));
    else {
      assert.equal(view.conversation.taskState, "paused", "a declined card stays uncompleted without another native follow-up");
      assert.doesNotMatch(view.conversation.blockReason ?? "", /runtime_failed|Native CLI ended|hara_runtime_failure_v1/);
    }
    assert.equal(view.agents.length, 1);
    hashes.push(standingState(f).standingPromptHash); pids.push(f.meta().pid);
  }
  assert.equal(new Set(hashes).size, 1); assert.match(hashes[0], /^[a-f0-9]{64}$/);
  assert.equal(new Set(pids).size, 1);
  const native = f.native(), starts = native.filter(row => ["thread/start", "thread/resume"].includes(row.method));
  const turns = native.filter(row => row.method === "turn/start"), inputs = turns.map(row => row.params.input[0].text);
  assert.deepEqual(starts.map(row => row.method), ["thread/start"]);
  assert.equal(turns.length, 5); assert.equal(new Set(turns.map(row => row.params.threadId)).size, 1);
  assert.equal(native.some(row => row.method === "thread/unsubscribe"), false);
  for (let i = 0; i < inputs.length; i++) {
    assert.ok(inputs[i].includes(messages[i]));
    assert.doesNotMatch(inputs[i], /Current Hara standing governance context|a clearly identified Hara AI colleague/);
    assert.equal("history" in turns[i].params, false);
  }
  for (const i of [0, 2]) assert.ok(Buffer.byteLength(inputs[i]) < 2048, "greeting/thanks input stays below2KB");
  assert.equal(inputs.slice(0, -1).some(value => value.includes(card)), false);
  assert.equal(inputs.at(-1).split(card).length - 1, 1); assert.ok(inputs.at(-1).includes(skill.version));
  assert.equal(starts[0].params.developerInstructions.includes(card), false);
  assert.match(starts[0].params.developerInstructions, /FIRST model response/);
  assert.match(starts[0].params.developerInstructions, /agent_create returns only AFTER the human has edited and approved/);
  t.diagnostic(JSON.stringify({ differentMessages: 5, nativeThreadStarts: 1, nativeResumes: 0,
    distinctStandingHashes: new Set(hashes).size, distinctPids: new Set(pids).size,
    turnInputBytes: inputs.map(value => Buffer.byteLength(value)), repeatedStanding: 0, creationCardCopies: 1, syntheticNativeTurns: 5, realModelCalls: 0 }));
});
