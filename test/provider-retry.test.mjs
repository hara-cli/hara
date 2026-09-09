import { test } from "node:test";
import assert from "node:assert/strict";
import { providerErrorMetadata, withProviderRetry } from "../dist/providers/retry.js";

const args = (overrides = {}) => ({
  system: "",
  history: [],
  tools: [],
  onText() {},
  ...overrides,
});

test("provider retry coordinator retries an empty transient failure with bounded deterministic backoff", async () => {
  let calls = 0;
  let clock = 1_000;
  const delays = [];
  const events = [];
  let activity = 0;
  const provider = {
    id: "fixture",
    model: "fixture-model",
    async turn() {
      calls += 1;
      return calls < 3
        ? { text: "", toolUses: [], stop: "error", errorMsg: "503 service unavailable", errorMetadata: { status: 503 } }
        : { text: "done", toolUses: [], stop: "end", usage: { input: 2, output: 1 } };
    },
  };
  const retrying = withProviderRetry(provider, { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000 }, {
    now: () => clock,
    random: () => 0.5,
    sleep: async (delay) => {
      delays.push(delay);
      clock += delay;
      return true;
    },
  });
  const result = await retrying.turn(args({
    onRetry: (event) => events.push(event),
    onActivity: () => { activity += 1; },
  }));
  assert.equal(result.text, "done");
  assert.equal(calls, 3);
  assert.deepEqual(delays, [100, 200]);
  assert.deepEqual(events.map(({ attempt, nextAttempt, kind }) => ({ attempt, nextAttempt, kind })), [
    { attempt: 1, nextAttempt: 2, kind: "overloaded" },
    { attempt: 2, nextAttempt: 3, kind: "overloaded" },
  ]);
  assert.equal(activity, 0, "a transport retry decision is not provider stream activity");
});

test("provider retry coordinator honors Retry-After but refuses a delay beyond the elapsed ceiling", async () => {
  let calls = 0;
  const delays = [];
  const provider = {
    id: "fixture",
    model: "fixture-model",
    async turn() {
      calls += 1;
      return { text: "", toolUses: [], stop: "error", errorMsg: "429", errorMetadata: { status: 429, retryAfterMs: 2_500 } };
    },
  };
  const retrying = withProviderRetry(provider, { maxAttempts: 3, maxElapsedMs: 2_000 }, {
    now: () => 0,
    sleep: async (delay) => {
      delays.push(delay);
      return true;
    },
  });
  const result = await retrying.turn(args());
  assert.equal(result.stop, "error");
  assert.equal(calls, 1);
  assert.deepEqual(delays, []);
});

test("provider retry coordinator never retries earlier than a Retry-After outside its bounded window", async () => {
  let calls = 0;
  const delays = [];
  const provider = {
    id: "fixture",
    model: "fixture-model",
    async turn() {
      calls += 1;
      return { text: "", toolUses: [], stop: "error", errorMsg: "429", errorMetadata: { status: 429, retryAfterMs: 45_000 } };
    },
  };
  const result = await withProviderRetry(provider, { maxDelayMs: 30_000 }, {
    sleep: async (delay) => {
      delays.push(delay);
      return true;
    },
  }).turn(args());
  assert.equal(result.stop, "error");
  assert.equal(calls, 1);
  assert.deepEqual(delays, []);
});

test("provider retry coordinator never replays after any stream activity, text, or tool call", async () => {
  for (const mode of ["activity", "text", "tool"]) {
    let calls = 0;
    const provider = {
      id: "fixture",
      model: "fixture-model",
      async turn(turnArgs) {
        calls += 1;
        if (mode === "activity") turnArgs.onActivity?.();
        if (mode === "text") turnArgs.onText("partial");
        return {
          text: mode === "text" ? "partial" : "",
          toolUses: mode === "tool" ? [{ id: "call-1", name: "bash", input: {} }] : [],
          stop: "error",
          errorMsg: "503 service unavailable",
          errorMetadata: { status: 503 },
        };
      },
    };
    const retrying = withProviderRetry(provider, { maxAttempts: 3, baseDelayMs: 0 }, { sleep: async () => true });
    await retrying.turn(args());
    assert.equal(calls, 1, `${mode} is not replay-safe`);
  }
});

test("provider retry coordinator cancels during backoff without starting another request", async () => {
  const controller = new AbortController();
  let calls = 0;
  const provider = {
    id: "fixture",
    model: "fixture-model",
    async turn() {
      calls += 1;
      return { text: "", toolUses: [], stop: "error", errorMsg: "network timeout" };
    },
  };
  const retrying = withProviderRetry(provider, { maxAttempts: 3 }, {
    sleep: async (_delay, signal) => {
      controller.abort();
      return !signal?.aborted;
    },
  });
  const result = await retrying.turn(args({ signal: controller.signal }));
  assert.equal(calls, 1);
  assert.equal(result.errorMsg, "interrupted");
});

test("provider retry coordinator does not start a request for an already-aborted turn", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const provider = {
    id: "fixture",
    model: "fixture-model",
    async turn() {
      calls += 1;
      return { text: "unexpected", toolUses: [], stop: "end" };
    },
  };
  const result = await withProviderRetry(provider).turn(args({ signal: controller.signal }));
  assert.equal(calls, 0);
  assert.equal(result.errorMsg, "interrupted");
});

test("providerErrorMetadata extracts only status, safe code, and Retry-After", () => {
  const metadata = providerErrorMetadata({
    status: 429,
    code: "RATE_LIMITED",
    headers: new Headers({ "retry-after": "3", authorization: "Bearer secret" }),
    request: { body: "secret" },
  }, 1_000);
  assert.deepEqual(metadata, { status: 429, code: "RATE_LIMITED", retryAfterMs: 3_000 });
  assert.equal(JSON.stringify(metadata).includes("secret"), false);
});
