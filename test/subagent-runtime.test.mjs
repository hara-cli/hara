import test from "node:test";
import assert from "node:assert/strict";
import { SubagentRuntime, subagentResultText } from "../dist/subagent/runtime.js";

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

test("SubagentRuntime keeps FIFO admission and enforces the root concurrency budget", async () => {
  const runtime = new SubagentRuntime({ maxConcurrent: 1, maxQueued: 2 });
  const firstGate = deferred();
  const started = [];
  runtime.register({
    id: "fixture",
    async run(request) {
      started.push(request.task);
      if (request.task === "first") await firstGate.promise;
      return { status: "completed", text: request.task, model: "fixture-model", usage: { input: 1, output: 2 } };
    },
  });

  const first = runtime.run("fixture", { task: "first" });
  const second = runtime.run("fixture", { task: "second" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["first"]);
  firstGate.resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(started, ["first", "second"]);
  assert.equal(a.status, "completed");
  assert.equal(b.text, "second");
  assert.equal(b.providerId, "fixture");
  assert.equal(b.model, "fixture-model");
  assert.deepEqual(b.usage, { input: 1, output: 2 });
  assert.ok(b.id && b.startedAt && b.endedAt);
});

test("SubagentRuntime cancels queued work before provider execution", async () => {
  const runtime = new SubagentRuntime({ maxConcurrent: 1, maxQueued: 1 });
  const gate = deferred();
  let runs = 0;
  runtime.register({
    id: "fixture",
    async run(request) {
      runs += 1;
      if (request.task === "hold") await gate.promise;
      return { status: "completed", text: request.task };
    },
  });
  const hold = runtime.run("fixture", { task: "hold" });
  const controller = new AbortController();
  const queued = runtime.run("fixture", { task: "cancel me", signal: controller.signal });
  controller.abort();
  const result = await queued;
  assert.equal(result.status, "cancelled");
  assert.match(subagentResultText(result), /cancelled/i);
  assert.equal(runs, 1);
  gate.resolve();
  await hold;
});

test("SubagentRuntime bounds admission and redacts thrown credentials", async () => {
  const runtime = new SubagentRuntime({ maxConcurrent: 1, maxQueued: 0 });
  const gate = deferred();
  runtime.register({
    id: "fixture",
    async run(request) {
      if (request.task === "hold") await gate.promise;
      else throw new Error("Authorization: Bearer secret-token-value");
      return { status: "completed", text: "held" };
    },
  });
  const hold = runtime.run("fixture", { task: "hold" });
  const rejected = await runtime.run("fixture", { task: "overflow" });
  assert.equal(rejected.status, "error");
  assert.match(rejected.error, /queue is full/i);
  gate.resolve();
  await hold;

  const failed = await runtime.run("fixture", { task: "throw" });
  assert.equal(failed.status, "error");
  assert.match(failed.error, /Bearer \*\*\*/);
  assert.doesNotMatch(failed.error, /secret-token-value/);
});

test("SubagentRuntime rejects duplicate or unknown providers and closes pending admission", async () => {
  const runtime = new SubagentRuntime({ maxConcurrent: 1, maxQueued: 1 });
  const gate = deferred();
  const provider = {
    id: "fixture",
    async run() {
      await gate.promise;
      return { status: "completed", text: "ok" };
    },
  };
  runtime.register(provider);
  assert.throws(() => runtime.register(provider), /already registered/);
  const unknown = await runtime.run("missing", { task: "work" });
  assert.equal(unknown.status, "error");
  assert.match(unknown.error, /not registered/);

  const active = runtime.run("fixture", { task: "active" });
  const queued = runtime.run("fixture", { task: "queued" });
  runtime.dispose();
  const closed = await queued;
  assert.equal(closed.status, "error");
  assert.match(closed.error, /closed/);
  gate.resolve();
  assert.equal((await active).status, "completed", "dispose does not falsify an already-running provider settlement");
});

test("SubagentRuntime publishes metadata-only lifecycle without letting observers affect execution", async () => {
  const runtime = new SubagentRuntime({ maxConcurrent: 1 });
  runtime.register({
    id: "fixture",
    async run() {
      return { status: "completed", text: "private result that must not enter lifecycle" };
    },
  });
  const events = [];
  const result = await runtime.run(
    "fixture",
    { task: "private task that must not enter lifecycle", role: "research" },
    (event) => {
      events.push(event);
      if (event.state === "working") throw new Error("observer failure");
    },
  );
  assert.equal(result.status, "completed");
  assert.deepEqual(events.map((event) => event.state), ["queued", "working", "completed"]);
  assert.ok(events.every((event) => event.id === result.id));
  assert.ok(events.every((event) => event.role === "research"));
  assert.doesNotMatch(JSON.stringify(events), /private task|private result/);
});
