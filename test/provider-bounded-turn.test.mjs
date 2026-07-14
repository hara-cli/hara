import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { boundedProviderTurn } from "../dist/providers/bounded-turn.js";

const execFileAsync = promisify(execFile);

const args = { system: "test", history: [], tools: [], onText: () => {} };

test("boundedProviderTurn returns a normal provider result", async () => {
  const provider = {
    id: "test",
    model: "test",
    async turn() {
      return { text: "ok", toolUses: [], stop: "end" };
    },
  };
  const result = await boundedProviderTurn(provider, args, { timeoutMs: 100, label: "test turn" });
  assert.equal(result.stop, "end");
  assert.equal(result.text, "ok");
});

test("boundedProviderTurn hard-stops a provider that ignores AbortSignal", async () => {
  let requestSignal;
  const provider = {
    id: "stuck",
    model: "stuck",
    turn(input) {
      requestSignal = input.signal;
      return new Promise(() => {});
    },
  };
  const started = Date.now();
  const result = await boundedProviderTurn(provider, args, { timeoutMs: 25, label: "planner" });
  assert.equal(result.stop, "error");
  assert.match(result.errorMsg, /planner timed out after 25ms/);
  assert.equal(requestSignal.aborted, true, "cooperative providers are aborted too");
  assert.ok(Date.now() - started < 500, "the caller does not inherit the provider's permanent wait");
});

test("boundedProviderTurn hard-stops on parent cancellation", async () => {
  const parent = new AbortController();
  const provider = { id: "stuck", model: "stuck", turn: () => new Promise(() => {}) };
  setTimeout(() => parent.abort(), 20);
  const result = await boundedProviderTurn(provider, args, { timeoutMs: 5_000, signal: parent.signal, label: "vision" });
  assert.equal(result.stop, "error");
  assert.match(result.errorMsg, /vision cancelled/);
});

test("boundedProviderTurn does not start a provider cancelled before its microtask", async () => {
  const parent = new AbortController();
  let calls = 0;
  const provider = {
    id: "unused",
    model: "unused",
    async turn() {
      calls++;
      return { text: "late", toolUses: [], stop: "end" };
    },
  };
  const pending = boundedProviderTurn(provider, args, { timeoutMs: 5_000, signal: parent.signal, label: "naming" });
  parent.abort();
  const result = await pending;
  assert.equal(result.stop, "error");
  assert.match(result.errorMsg, /naming cancelled/);
  assert.equal(calls, 0, "cancelled work never reaches the provider");
});

test("boundedProviderTurn converts synchronous and asynchronous provider failures", async () => {
  for (const turn of [() => { throw new Error("sync failure"); }, async () => { throw new Error("async failure"); }]) {
    const result = await boundedProviderTurn({ id: "bad", model: "bad", turn }, args, { timeoutMs: 100 });
    assert.equal(result.stop, "error");
    assert.match(result.errorMsg, /failure/);
  }
});

test("boundedProviderTurn keeps a headless process alive until its hard timeout", async () => {
  const moduleUrl = new URL("../dist/providers/bounded-turn.js", import.meta.url).href;
  const script = `
    import { boundedProviderTurn } from ${JSON.stringify(moduleUrl)};
    const provider = { id: "stuck", model: "stuck", turn: () => new Promise(() => {}) };
    const result = await boundedProviderTurn(provider, { system: "", history: [], tools: [], onText() {} }, { timeoutMs: 25 });
    process.stdout.write(result.stop + ":" + result.errorMsg);
  `;
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script], { timeout: 2_000 });
  assert.match(stdout, /^error:model call timed out after 25ms$/);
});
