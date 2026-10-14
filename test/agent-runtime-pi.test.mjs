import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../dist/tools/all.js";
import { runPiAgent, piRuntimeTurn } from "../dist/agent-runtime/pi.js";
import { createTaskExecution } from "../dist/session/task.js";
import { freezeTaskRuntimeBinding } from "../dist/agent-runtime/bindings.js";

const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const reply = (text) => ({ text, toolUses: [], stop: "end", usage: { input: 7, output: 3 } });
function options(turn, extra = {}) {
  const task = createTaskExecution("synthetic Pi task", "fixture-turn");
  task.runtimeBinding = freezeTaskRuntimeBinding({ version: 1, spaceId: "personal", agentRef: "main", runtimeId: "pi", revision: 1 }, task.id);
  const cwd = mkdtempSync(join(tmpdir(), "hara-governed-pi-"));
  return { provider: { id: "synthetic", model: "same-frozen-host-model", turn },
    ctx: { cwd, spaceId: "personal", sandbox: "off" }, approval: "suggest", approvalChannel: true,
    confirm: async () => false, hooks: false, quiet: true, maxRounds: 6, autoContinue: false,
    taskIntake: { task }, ...extra };
}

test("the actual Pi Runtime executes an ordinary governed turn once and preserves canonical history and usage", async () => {
  const calls = []; const stats = { input: 0, output: 0 };
  const history = [{ role: "user", content: "hello" }];
  const outcome = await runPiAgent(history, options(async (args) => { calls.push(args); return reply("你好，Hara 在这里。"); }, { stats }));
  assert.equal(outcome.status, "completed"); assert.equal(calls.length, 1);
  assert.ok(calls[0].history.some((message) => message.role === "user" && message.content === "hello"));
  assert.ok(calls[0].system.includes("Hara"));
  assert.equal(history.at(-1).text, "你好，Hara 在这里。");
  assert.equal(stats.input, 7); assert.equal(stats.output, 3);
});

test("Pi yields tools to the real governor and waits for the original question card, without an extra planner", async () => {
  const entered = deferred(), answer = deferred(); let calls = 0;
  const history = [{ role: "user", content: "Please ask me A or B." }];
  const opts = options(async (args) => {
    calls++;
    if (calls === 1) return { text: "", toolUses: [{ id: "choice1", name: "ask_user", input: { question: "A or B?", options: ["A", "B"] } }],
      stop: "tool_use", usage: { input: 7, output: 3 } };
    assert.ok(args.history.some((message) => message.role === "tool" && message.results.some((result) => result.content === "B")));
    return reply("B selected.");
  });
  opts.ctx.ask = async (question, choices) => { assert.equal(question, "A or B?"); assert.deepEqual(choices, ["A", "B"]); entered.resolve(); return answer.promise; };
  const run = runPiAgent(history, opts); await entered.promise;
  assert.equal(calls, 1); answer.resolve("B");
  assert.equal((await run).status, "completed"); assert.equal(calls, 2);
  assert.equal(history.at(-1).text, "B selected.");
});

test("Pi cannot execute a tool directly or bypass the host's understanding and approval boundaries", async () => {
  let calls = 0, writes = 0;
  const opts = options(async (args) => {
    calls++;
    if (calls === 1) return { text: "", toolUses: [{ id: "mutate1", name: "fixture_write", input: {} }], stop: "tool_use" };
    assert.ok(args.history.some((message) => message.role === "tool" && message.results.some((result) => /understand|task_intake|brief/i.test(result.content))));
    return reply("I cannot claim a write occurred.");
  }, { extraTools: [{ name: "fixture_write", description: "Synthetic mutation", kind: "edit", input_schema: { type: "object", properties: {} },
    async run() { writes++; return "must not execute"; } }] });
  await runPiAgent([{ role: "user", content: "Write a file." }], opts);
  assert.equal(writes, 0); assert.ok(calls <= 6);
});

test("the Pi step preserves exact host context, media, model, cache metadata and opaque continuation", async () => {
  const continuation = { type: "chat_reasoning", text: "synthetic-private-reasoning" };
  const result = { ...reply(""), stop: "tool_use", continuation, toolUses: [{ id: "read1", name: "read_file", input: { path: "example.txt" } }] };
  const args = { system: "Frozen host persona", systemParts: [{ id: "stable", stability: "static", source: "core", content: "Frozen host persona", digest: "fixture" }],
    history: [{ role: "user", content: "Read the attached image", images: [{ path: "/synthetic/user/image.png", mediaType: "image/png" }] }],
    tools: [{ name: "read_file", description: "read", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }],
    onText() {}, signal: new AbortController().signal };
  let calls = 0;
  const returned = await piRuntimeTurn({ id: "host", model: "host-model", async turn(received) { calls++; assert.equal(received, args); return result; } }, args);
  assert.equal(calls, 1); assert.equal(returned, result); assert.equal(returned.continuation, continuation);
});

test("Pi cancellation does not release a non-cooperative physical model request early", async () => {
  const entered = deferred(), drain = deferred(); const controller = new AbortController(); let settled = false;
  const run = piRuntimeTurn({ id: "fixture", model: "fixture", async turn() { entered.resolve(); await drain.promise; return reply("late"); } },
    { system: "fixture", history: [{ role: "user", content: "hello" }], tools: [], onText() {}, signal: controller.signal });
  void run.finally(() => { settled = true; });
  await entered.promise; controller.abort(); await new Promise((done) => setTimeout(done, 30));
  assert.equal(settled, false); drain.resolve();
  assert.equal((await run).errorMsg, "interrupted"); assert.equal(settled, true);
});

test("Pi requires the exact frozen task Runtime and never starts a model on missing or different provenance", async () => {
  let calls = 0; const opts = options(async () => { calls++; return reply("no"); });
  const history = [{ role: "user", content: "hello" }];
  assert.equal((await runPiAgent(history, { ...opts, taskIntake: undefined })).status, "error");
  opts.taskIntake.task.runtimeBinding = { ...opts.taskIntake.task.runtimeBinding, runtimeId: "codex" };
  assert.equal((await runPiAgent(history, opts)).status, "error");
  assert.equal(calls, 0); assert.equal(history.length, 1);
});
