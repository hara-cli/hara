import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { budgetedSmokeFetch, safeSmokeErrorClass, smokeFailureCategory, safeSmokeToolName } from "../scripts/model-latency-smoke.mjs";

const secret = "fixture-secret-https://fixture-user:fixture-password@fixture.invalid/private?token=fixture-query";
const request = { method: "POST", body: JSON.stringify({ model: "fixture", max_output_tokens: 32000, input: [] }) };

test("model smoke is opt-in and does not read config without --live", () => {
  const root = mkdtempSync(join(tmpdir(), "hara-latency-opt-in-"));
  try {
    const result = spawnSync(process.execPath, ["scripts/model-latency-smoke.mjs", `--provider=${secret}`, "--cache-only"], { cwd: process.cwd(), env: { ...process.env, HOME: root, USERPROFILE: root }, encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Usage:.*--live/);
    assert.doesNotMatch(result.stdout + result.stderr, /fixture-secret|fixture-user|fixture-password|fixture-query/);
    assert.equal(result.stderr, "");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("model smoke catches malformed private config without raw stack or JSON fragments", () => {
  const root = mkdtempSync(join(tmpdir(), "hara-latency-safe-config-"));
  try {
    mkdirSync(join(root, ".hara"));
    writeFileSync(join(root, ".hara", "config.json"), `{"apiKey": "${secret}", bad}`, { mode: 0o600 });
    const result = spawnSync(process.execPath, ["scripts/model-latency-smoke.mjs", "--live"], { cwd: process.cwd(), env: { ...process.env, HOME: root, USERPROFILE: root }, encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 1);
    const record = JSON.parse(result.stdout);
    assert.equal(record.errorClass, "SyntaxError");
    assert.equal(record.wireRequests, 0);
    assert.equal(result.stderr, "");
    assert.doesNotMatch(result.stdout, /fixture-secret|fixture-user|fixture-password|fixture-query|apiKey|config\.json/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("model smoke outputs fixed categories/classes and whitelists tool names", () => {
  const cases = [
    ["Responses stream ended before response.completed/response.incomplete/response.failed." + secret, "sse_missing_terminal"],
    ["Responses stream sequence_number " + secret, "sse_protocol"],
    ["Tool call dropped — " + secret, "function_json"],
    ["Responses generation was incomplete " + secret, "generation_incomplete"],
    ["model network request failed " + secret, "network_transport"],
    [secret, "provider_error"],
  ];
  for (const [errorMsg, expected] of cases) assert.equal(smokeFailureCategory({ stop: "error", errorMsg }), expected);
  assert.equal(smokeFailureCategory({ stop: "end", errorMsg: secret }), null);
  assert.equal(smokeFailureCategory({ stop: "error", errorMsg: secret, errorMetadata: { status: 401 } }), "http_auth");
  const error = Object.assign(new Error(secret), { name: secret });
  assert.equal(safeSmokeErrorClass(error), "Error");
  assert.equal(safeSmokeErrorClass(new SyntaxError(secret)), "SyntaxError");
  assert.equal(safeSmokeToolName(secret), "unknown_tool");
  assert.equal(safeSmokeToolName("fixture_verify"), "fixture_verify");
});

test("model smoke hard wire gate counts only transport calls and also blocks accidental retries", async () => {
  let calls = 0;
  const gate = budgetedSmokeFetch(async () => { calls++; return new Response("ok"); }, { wireApi: "responses", maxWireRequests: 2 });
  for (let i = 0; i < 2; i++) assert.equal(await (await gate.fetch("https://fixture.invalid", request)).text(), "ok");
  await assert.rejects(gate.fetch("https://fixture.invalid", request), (error) => safeSmokeErrorClass(error) === "SmokeBudgetError");
  assert.equal(calls, 2);
  assert.equal(gate.stats.wireRequests, 2);
  assert.equal(gate.stats.deniedRequests, 1);
  assert.equal(gate.stats.denial, "wire_budget_exceeded");
  assert.equal(gate.reports.length, 2);
});

test("model smoke input budget is explicitly after-response and missing usage remains unknown", async () => {
  let calls = 0;
  const gate = budgetedSmokeFetch(async () => { calls++; return new Response("ok"); }, { wireApi: "responses", maxReportedInput: 10 });
  gate.noteUsage(undefined);
  gate.noteUsage(0);
  assert.equal(gate.stats.reportedInput, 0);
  assert.equal(gate.stats.unknownUsageRequests, 2);
  await (await gate.fetch("https://fixture.invalid", request)).text();
  gate.noteUsage(11);
  assert.equal(gate.stats.reportedInput, 11, "reported usage may cross the threshold in the last request");
  await assert.rejects(gate.fetch("https://fixture.invalid", request));
  assert.equal(calls, 1);
  assert.equal(gate.stats.denial, "reported_input_budget_exceeded");
});

test("model smoke applies protocol output caps without changing caller body or proxy transport", async () => {
  for (const wireApi of ["responses", "chat", "anthropic"]) {
    let captured;
    const gate = budgetedSmokeFetch(async (_url, init) => { captured = init; return new Response("ok"); }, { wireApi });
    const original = JSON.stringify({ model: "fixture", max_tokens: 32000, max_completion_tokens: 32000, max_output_tokens: 32000 });
    await (await gate.fetch("https://fixture.invalid", { method: "POST", body: original, headers: { "x-fixture": "yes" } })).text();
    const field = wireApi === "responses" ? "max_output_tokens" : "max_tokens";
    assert.equal(JSON.parse(captured.body)[field], 1024);
    assert.equal(original, JSON.stringify({ model: "fixture", max_tokens: 32000, max_completion_tokens: 32000, max_output_tokens: 32000 }));
    assert.equal(captured.headers["x-fixture"], "yes");
    assert.equal(captured.redirect, "error", "redirects cannot add uncounted model requests");
    assert.ok(captured.signal instanceof AbortSignal);
    assert.equal(gate.reports[0].maxOutputTokens, 1024);
  }
});

test("model smoke observes first bytes without retaining or changing response content", async () => {
  const gate = budgetedSmokeFetch(async () => new Response(secret), { wireApi: "responses" });
  const response = await gate.fetch("https://fixture.invalid", request);
  assert.equal(await response.text(), secret);
  assert.equal(typeof gate.reports[0].firstBytesMs, "number");
  assert.equal(gate.reports[0].bodyComplete, true);
  assert.doesNotMatch(JSON.stringify(gate.reports), /fixture-secret|fixture-user|fixture-password|fixture-query|fixture\.invalid/);
});

test("model smoke aborts its supplied transport deadline without logging exception names", async () => {
  const gate = budgetedSmokeFetch(async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(Object.assign(new Error(secret), { name: secret })), { once: true });
  }), { wireApi: "responses", timeoutMs: 15 });
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(gate.fetch("https://fixture.invalid", request));
    assert.equal(gate.reports[0].errorClass, "Error");
    assert.doesNotMatch(JSON.stringify(gate.reports), /fixture-secret|fixture-user|fixture-password|fixture-query/);
  } finally { clearTimeout(keepAlive); }
});

test("model smoke rejects malformed bodies and incompatible thinking budgets before any wire", async () => {
  let calls = 0;
  const gate = budgetedSmokeFetch(async () => { calls++; return new Response("ok"); }, { wireApi: "anthropic" });
  for (const body of [undefined, "null", "[]", JSON.stringify({ thinking: { type: "enabled", budget_tokens: 4096 } })]) {
    await assert.rejects(gate.fetch("https://fixture.invalid", { body }));
  }
  assert.equal(calls, 0);
  assert.equal(gate.stats.wireRequests, 0);
});

test("model smoke does not count an already-aborted request as a transport call", async () => {
  let calls = 0;
  const gate = budgetedSmokeFetch(async () => { calls++; return new Response("ok"); }, { wireApi: "responses" });
  await assert.rejects(gate.fetch("https://fixture.invalid", { ...request, signal: AbortSignal.abort() }), (error) => safeSmokeErrorClass(error) === "AbortError");
  assert.equal(calls, 0);
  assert.equal(gate.stats.wireRequests, 0);
});

test("model smoke records stream failures using a fixed class without retaining body or cause", async () => {
  let reads = 0;
  const gate = budgetedSmokeFetch(async () => new Response(new ReadableStream({
    pull(controller) {
      if (reads++ === 0) controller.enqueue(new TextEncoder().encode(secret));
      else controller.error(Object.assign(new Error(secret), { name: secret }));
    },
  })), { wireApi: "responses" });
  const response = await gate.fetch("https://fixture.invalid", request);
  await assert.rejects(response.text());
  assert.equal(gate.reports[0].errorClass, "Error");
  assert.equal(typeof gate.reports[0].elapsedMs, "number");
  assert.doesNotMatch(JSON.stringify(gate.reports), /fixture-secret|fixture-user|fixture-password|fixture-query/);
});
