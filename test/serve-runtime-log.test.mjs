import assert from "node:assert/strict";
import test from "node:test";
import {
  createServeRuntimeLogger,
  serveRuntimeFailureCategory,
} from "../dist/serve/runtime-log.js";

test("Serve runtime diagnostics are structured, bounded, and never echo raw identities or errors", () => {
  const lines = [];
  const fakeSecret = "sk-runtimelog1234567890";
  const sessionId = `session-${fakeSecret}`;
  const log = createServeRuntimeLogger({
    write: (line) => lines.push(line),
    maxBytes: 1024,
    now: () => new Date("2026-08-28T00:00:00.000Z"),
  });
  log("turn.failed", {
    sessionId,
    method: `session.send/${fakeSecret}`,
    category: serveRuntimeFailureCategory(new Error(`provider rejected API_KEY=${fakeSecret}`)),
    durationMs: 12.6,
  });
  log("provider.started", { sessionId });
  log("provider.completed", { sessionId, durationMs: 8.6 });
  log("tool.started", { sessionId, tool: "write_file" });
  log("tool.completed", { sessionId, tool: "write_file", durationMs: 4.4 });
  for (let index = 0; index < 20; index += 1) log("rpc.failed", { method: "session.send", code: -32603 });

  const output = lines.join("");
  assert.doesNotMatch(output, new RegExp(fakeSecret));
  assert.doesNotMatch(output, new RegExp(sessionId));
  assert.match(output, /"session":"s_[a-f0-9]{12}"/);
  assert.match(output, /"method":"redacted"/);
  assert.match(output, /"category":"authentication"/);
  assert.match(output, /"durationMs":13/);
  assert.match(output, /"event":"provider\.completed"/);
  assert.match(output, /"event":"tool\.completed"/);
  assert.match(output, /"tool":"write_file"/);
  assert.equal((output.match(/"event":"log\.limit"/g) ?? []).length, 1);
  assert.ok(Buffer.byteLength(output, "utf8") <= 1024);
});

test("Serve runtime failure categories expose only stable diagnostics", () => {
  assert.equal(serveRuntimeFailureCategory(new Error("request timed out")), "timeout");
  assert.equal(serveRuntimeFailureCategory(new Error("permission denied")), "authorization");
  assert.equal(serveRuntimeFailureCategory(new Error("429 too many requests")), "rate_limit");
  assert.equal(serveRuntimeFailureCategory(new Error("opaque failure")), "internal");
});

test("Serve runtime diagnostics retain bounded provider retry facts and redact unsafe model ids", () => {
  const lines = [];
  const fakeSecret = "sk-retrylog1234567890";
  const log = createServeRuntimeLogger({
    write: (line) => lines.push(line),
    now: () => new Date("2026-09-06T00:00:00.000Z"),
  });
  log("provider.retry_scheduled", {
    sessionId: "retry-session",
    provider: "openai",
    model: `custom-${fakeSecret}`,
    retryKind: "rate_limit",
    attempt: 1,
    nextAttempt: 2,
    delayMs: 2_500.4,
    elapsedMs: 130.6,
    status: 429,
  });
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0].replace(/^\[hara-runtime\] /, ""));
  assert.equal(record.event, "provider.retry_scheduled");
  assert.equal(record.provider, "openai");
  assert.equal(record.model, "redacted");
  assert.equal(record.retryKind, "rate_limit");
  assert.equal(record.attempt, 1);
  assert.equal(record.nextAttempt, 2);
  assert.equal(record.delayMs, 2500);
  assert.equal(record.elapsedMs, 131);
  assert.equal(record.status, 429);
  assert.doesNotMatch(lines[0], new RegExp(fakeSecret));
});
