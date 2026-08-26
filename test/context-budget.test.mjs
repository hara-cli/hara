import test from "node:test";
import assert from "node:assert/strict";
import { historyChars, prepareHistoryForModel } from "../dist/agent/context-budget.js";
import { runAgent } from "../dist/agent/loop.js";

test("context budget bounds old payloads while preserving durable input and tool identities", () => {
  const history = [
    { role: "user", content: "old image request", images: [{ path: "/tmp/old.png", mediaType: "image/png" }] },
    { role: "assistant", text: "planning", toolUses: [{ id: "call-1", name: "read_file", input: { path: "/tmp/a", note: "x".repeat(20_000) } }] },
    { role: "tool", results: [{ id: "call-1", name: "read_file", content: "A".repeat(80_000) }] },
    { role: "user", content: "middle" },
    { role: "assistant", text: "B".repeat(40_000), toolUses: [] },
    { role: "user", content: "latest exact request", images: [{ path: "/tmp/new.png", mediaType: "image/png" }] },
  ];
  const before = structuredClone(history);
  const prepared = prepareHistoryForModel(history, { model: "fake", maxChars: 18_000 });

  assert.equal(prepared.changed, true);
  assert.ok(prepared.preparedChars <= prepared.budgetChars, `${prepared.preparedChars} <= ${prepared.budgetChars}`);
  assert.deepEqual(history, before, "durable history is not mutated");
  assert.equal(prepared.omittedImages, 1);
  assert.ok(prepared.history.some((message) => message.role === "user" && message.content.includes("latest exact request")));
  const assistant = prepared.history.find((message) => message.role === "assistant" && message.toolUses.length);
  const tool = prepared.history.find((message) => message.role === "tool");
  assert.equal(assistant.toolUses[0].id, "call-1");
  assert.equal(tool.results[0].id, "call-1");
});

test("small context is semantically unchanged and needs no guard note", () => {
  const history = [{ role: "user", content: "hello" }, { role: "assistant", text: "hi", toolUses: [] }];
  const prepared = prepareHistoryForModel(history, { model: "fake", maxChars: 20_000 });
  assert.equal(prepared.changed, false);
  assert.deepEqual(prepared.history, history);
  assert.equal(prepared.preparedChars, historyChars(history));
});

test("context normalization never orphans retained parallel tool results", () => {
  const calls = Array.from({ length: 96 }, (_, index) => ({
    id: `call-${index}`,
    name: "read_file",
    input: { path: `/tmp/${index}`, note: "x".repeat(2_000) },
  }));
  const results = calls.map((call) => ({ id: call.id, name: call.name, content: "ok" }));
  const prepared = prepareHistoryForModel([
    { role: "user", content: "inspect the files" },
    { role: "assistant", text: "", toolUses: calls },
    { role: "tool", results },
    { role: "user", content: "summarize" },
  ], { model: "fake", maxChars: 80_000 });
  const keptCalls = prepared.history.flatMap((message) => message.role === "assistant" ? message.toolUses.map((use) => use.id) : []);
  const keptResults = prepared.history.flatMap((message) => message.role === "tool" ? message.results.map((result) => result.id) : []);
  assert.deepEqual(keptResults, keptCalls);
});

test("context budget retains a bounded latest request even for structure-heavy histories", () => {
  const history = [];
  for (let index = 0; index < 200; index++) {
    history.push({ role: "user", content: `request-${index} ${"u".repeat(200)}` });
    history.push({ role: "assistant", text: "a".repeat(1_000), toolUses: [] });
  }
  const prepared = prepareHistoryForModel(history, { model: "fake", maxChars: 6_000 });
  assert.ok(prepared.preparedChars <= 6_000);
  assert.ok(prepared.history.some((message) => message.role === "user" && message.content.includes("request-199")));
});

test("tight context preserves the latest narrow tool evidence instead of making re-read loop forever", () => {
  const history = [];
  for (let index = 0; index < 18; index++) {
    history.push({ role: "user", content: `inspect old region ${index}` });
    history.push({
      role: "assistant",
      text: "",
      toolUses: [{ id: `old-call-${index}`, name: "read_file", input: { path: `/tmp/old-${index}.mjs` } }],
    });
    history.push({
      role: "tool",
      results: [{ id: `old-call-${index}`, name: "read_file", content: `OLD-${index}-START\n${"o".repeat(9_000)}\nOLD-${index}-END` }],
    });
  }
  history.push({ role: "user", content: "continue from a narrow exact read" });
  history.push({
    role: "assistant",
    text: "",
    toolUses: [{ id: "latest-call", name: "read_file", input: { path: "/tmp/current.mjs", offset: 40, limit: 80 } }],
  });
  history.push({
    role: "tool",
    results: [{ id: "latest-call", name: "read_file", content: `LATEST-START\n${"n".repeat(8_000)}\nLATEST-END` }],
  });

  const prepared = prepareHistoryForModel(history, { model: "fake", maxChars: 18_000 });
  const retainedTools = prepared.history.filter((message) => message.role === "tool");
  const latest = retainedTools.at(-1).results[0].content;
  const oldest = retainedTools[0].results[0].content;
  const guard = prepared.history.find((message) => message.role === "user" && message.content.includes("Hara context guard"));

  assert.ok(prepared.preparedChars <= prepared.budgetChars);
  assert.match(latest, /LATEST-START/);
  assert.match(latest, /LATEST-END/);
  assert.ok(latest.length >= 4_000, `latest exact evidence retained ${latest.length} chars`);
  assert.ok(oldest.length < latest.length, "older tool payloads yield budget to the newest read");
  assert.match(guard.content, /not a tool outage or a human dependency/);
  assert.match(guard.content, /do not ask the user to rerun a command or paste Hara's tool output/);
});

test("agent retries context overflow once on the same provider before considering fallback", async () => {
  let calls = 0;
  const seen = [];
  const provider = {
    id: "primary",
    model: "fake-model",
    async turn({ history }) {
      calls++;
      seen.push(historyChars(history));
      if (calls === 1) return { text: "", toolUses: [], stop: "error", errorMsg: "maximum context length exceeded" };
      return { text: "recovered", toolUses: [], stop: "end" };
    },
  };
  const history = [{ role: "user", content: "work from the current state" }];
  const outcome = await runAgent(history, {
    provider,
    ctx: { cwd: process.cwd() },
    approval: "full-auto",
    confirm: async () => true,
    quiet: true,
  });
  assert.equal(outcome.status, "completed");
  assert.equal(calls, 2);
  assert.equal(history.at(-1).text, "recovered");
  assert.equal(seen.length, 2);
});
