import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { jsonCliFixture } from "./helpers/json-cli-fixture.mjs";
import { runtimeFailureMessage } from "../dist/agent-runtime/failure-diagnostics.js";
const digest = path => createHash("sha256").update(fs.readFileSync(path)).digest("hex");
async function until(read) { const deadline = Date.now() + 10000; while (Date.now() < deadline) { if (read()) return; await new Promise(resolve => setTimeout(resolve, 20)); } throw Error("bounded Kimi fixture wait"); }

test("Kimi inherited diagnostics are code-owned even when callers omit or forge policy metadata", () => {
  for (const runtime of ["kimi", "gemini"]) {
    const raw = runtimeFailureMessage({ runtime, kind: "runtime_failed", version: "1.2.3", loginSource: "host", homeMatchesAccount: true, elapsedMs: 1, extensionsIsolation: "forged-private-value" });
    const row = JSON.parse(raw.slice(raw.indexOf("=") + 1));
    assert.equal(row.extensionsIsolation, runtime === "kimi" ? "inherited" : undefined); assert.ok(!raw.includes("forged-private-value"));
  }
});
test("Kimi classic full contract preserves host extensions, Hara receipts and protected launch", async t => {
  const f = await jsonCliFixture(t, "kimi"), sent = f.send(); await f.host.wait(sent.runId); const view = f.read(), meta = f.meta();
  assert.equal(view.conversation.state, "completed", JSON.stringify(view.conversation));
  assert.equal(meta.home, f.account); assert.equal(meta.yolo, true); assert.equal(meta.plan, false); assert.equal(meta.inheritedExtensions, true);
  assert.equal(meta.wrapped, true); assert.equal(meta.tokenInArgv, false); assert.deepEqual(meta.mcpNames, ["hara"]);
  const listed = JSON.parse(meta.listed.content[0].text);
  assert.ok(view.conversation.history.some(row => row.role === "tool" && row.results.some(result => result.name === "agent_list" && result.id === listed.receipt.toolCallId)));
  assert.equal(digest(f.fakeConfigPath), f.configDigest); assert.equal(fs.existsSync(f.extensionMarker), true);
  assert.equal(view.runtimes.options.find(row => row.runtimeId === "kimi").extensionsIsolation, "inherited");
  assert.equal(view.runtimes.options.find(row => row.runtimeId === "kimi").versionStatus.lastSuccessfulVersion, "1.2.3");
  assert.equal(f.policyCalls.at(-1).kind, "close"); await assert.rejects(fetch(meta.url));
});
test("Kimi default shared policy reuses fake host configuration under real controlled Seatbelt", { skip: process.platform !== "darwin" }, async t => {
  const f = await jsonCliFixture(t, "kimi", { productionPolicy: true, recordReceipt: false }), sent = f.send(); await f.host.wait(sent.runId); const view = f.read();
  assert.equal(view.conversation.state, "completed", JSON.stringify(view.conversation));
  assert.ok(view.conversation.history.some(row => row.role === "tool" && row.results.some(result => result.name === "agent_list")));
  assert.equal(fs.existsSync(f.extensionMarker), true); assert.equal(digest(f.fakeConfigPath), f.configDigest);
  assert.equal(f.policyCalls.length, 0); assert.equal(fs.existsSync(f.metaPath), false);
});
test("Kimi inherited extensions cannot bypass missing write protection", async t => {
  const f = await jsonCliFixture(t, "kimi", { protectedFactory: false }), sent = f.send(); await f.host.wait(sent.runId); const view = f.read();
  assert.equal(view.conversation.state, "blocked"); assert.equal(fs.existsSync(f.metaPath), false); assert.equal(fs.existsSync(f.extensionMarker), false);
  assert.ok(view.conversation.blockReason.includes('"kind":"runtime_permission_denied"')); assert.ok(view.conversation.blockReason.includes('"extensionsIsolation":"inherited"'));
});
test("Kimi error diagnostics record inherited extensions without raw output or successful version", async t => {
  const f = await jsonCliFixture(t, "kimi", { mode: "error" }), sent = f.send(); await f.host.wait(sent.runId); const view = f.read();
  assert.equal(view.conversation.state, "blocked"); assert.ok(view.conversation.blockReason.includes('"kind":"runtime_auth_rejected"'));
  assert.ok(view.conversation.blockReason.includes('"extensionsIsolation":"inherited"')); assert.ok(!JSON.stringify(view).includes("fixture-private"));
  assert.equal(view.runtimes.options.find(row => row.runtimeId === "kimi").versionStatus.lastSuccessfulVersion, null); assert.equal(digest(f.fakeConfigPath), f.configDigest);
  await assert.rejects(fetch(f.meta().url));
});
test("Kimi cancellation closes the physical model transport before policy and MCP cleanup", async t => {
  const f = await jsonCliFixture(t, "kimi", { mode: "cancel" }), sent = f.send(); await until(() => fs.existsSync(f.metaPath)); const url = f.meta().url;
  f.host.cancel(f.workspaceId, f.main, sent.runId); await f.host.wait(sent.runId);
  assert.equal(f.policyCalls.at(-1).kind, "close"); assert.notEqual(f.read().conversation.state, "running"); await assert.rejects(fetch(url));
});
