import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createServer } from "node:net";
import { jsonCliFixture } from "./helpers/json-cli-fixture.mjs";
async function until(read) { const deadline = Date.now() + 10000; while (Date.now() < deadline) { const value = read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 20)); } throw Error("bounded JSON CLI fixture wait"); }
for (const runtime of ["gemini"]) {
  test(`${runtime}: host binding, documented model source, MCP governor, stages and successful-version history`, async t => {
    const f = await jsonCliFixture(t, runtime), inventory = await f.host.listRuntimeModels(f.workspaceId, runtime);
    assert.equal(inventory.source, "documented"); assert.ok(inventory.sourceURL.startsWith("https://"));
    assert.ok(inventory.models.some(row => row.id === "default")); assert.ok(inventory.models.every(row => !row.supportedReasoningEfforts?.length));
    await assert.rejects(f.host.selectRuntimeModel(f.workspaceId, runtime, "default", 0, "high"), /does not report reasoning effort/);
    const sent = f.send(); await f.host.wait(sent.runId); const view = f.read(), meta = f.meta();
    assert.equal(view.conversation.state, "completed", JSON.stringify(view.conversation));
    assert.equal(meta.home, f.account); assert.equal(meta.yolo, true); assert.equal(meta.wrapped, true); assert.equal(meta.tokenInArgv, false); assert.deepEqual(meta.mcpNames, ["hara"]);
    const listed = JSON.parse(meta.listed.content[0].text); assert.deepEqual(listed.agents.map(row => row.agentId), [f.main]);
    assert.ok(view.conversation.history.some(row => row.role === "tool" && row.results.some(result => result.name === "agent_list" && result.id === listed.receipt.toolCallId)));
    assert.equal(meta.isolatedExtensions, true); assert.ok(f.policyCalls.some(row => row.kind === "begin" && row.attemptKey === sent.runId));
    assert.ok(f.policyCalls.some(row => row.kind === "wrap")); assert.ok(f.policyCalls.some(row => row.kind === "on-process")); assert.ok(f.policyCalls.some(row => row.kind === "drain-process")); assert.ok(f.policyCalls.filter(row => row.kind === "collect").length >= 2); assert.equal(f.policyCalls.at(-1).kind, "close");
    const stages = view.conversation.runtimeStages.at(-1); assert.equal(stages.runtime.id, runtime); assert.ok(stages.events.some(row => row.kind === "first_output"));
    assert.equal(view.runtimes.options.find(row => row.runtimeId === runtime).versionStatus.lastSuccessfulVersion, "1.2.3");
    await assert.rejects(fetch(meta.url));
  });
  test(`${runtime}: missing public protection denies the physical model process without fallback`, async t => {
    const f = await jsonCliFixture(t, runtime, { protectedFactory: false }), sent = f.send(); await f.host.wait(sent.runId);
    const view = f.read(); assert.equal(view.conversation.state, "blocked"); assert.equal(fs.existsSync(f.metaPath), false);
    assert.ok(view.conversation.blockReason.includes('"kind":"runtime_permission_denied"'));
    assert.equal(view.runtimes.options.find(row => row.runtimeId === runtime).versionStatus.lastSuccessfulVersion, null);
  });
  test(`${runtime}: error frames are diagnosed without raw payloads or version success`, async t => {
    const f = await jsonCliFixture(t, runtime, { mode: "error" }), sent = f.send(); await f.host.wait(sent.runId); const view = f.read();
    assert.equal(view.conversation.state, "blocked"); assert.ok(view.conversation.blockReason.includes('"kind":"runtime_auth_rejected"'));
    assert.ok(!JSON.stringify(view).includes("fixture-private")); assert.equal(view.runtimes.options.find(row => row.runtimeId === runtime).versionStatus.lastSuccessfulVersion, null);
    await assert.rejects(fetch(f.meta().url));
  });
  test(`${runtime}: cancellation drains the native process before policy close and closes MCP`, async t => {
    const f = await jsonCliFixture(t, runtime, { mode: "cancel" }), sent = f.send();
    await until(() => fs.existsSync(f.metaPath)); const url = f.meta().url;
    f.host.cancel(f.workspaceId, f.main, sent.runId); await f.host.wait(sent.runId);
    assert.equal(f.policyCalls.at(-1).kind, "close"); assert.notEqual(f.read().conversation.state, "running"); await assert.rejects(fetch(url));
  });
}
test("Gemini controlled adds plan, omits yolo and retains the outer policy before its MCP read", async t => {
  const f = await jsonCliFixture(t, "gemini", { tier: "controlled" }), sent = f.send(); await f.host.wait(sent.runId);
  assert.equal(f.read().conversation.state, "completed"); assert.equal(f.meta().yolo, false); assert.ok(f.policyCalls.some(row => row.kind === "wrap"));
});
test("Kimi host registration enables binding and advertises inherited extensions", async t => {
  const f = await jsonCliFixture(t, "kimi", { bind: false, productionPolicy: true }), view = f.read();
  const runtime = view.runtimes.options.find(row => row.runtimeId === "kimi");
  assert.equal(runtime.registered, true); assert.equal(runtime.loginSource, "host"); assert.equal(runtime.generalAgentDriverAvailable, true); assert.equal(runtime.extensionsIsolation, "inherited");
  const option = view.runtimeOptions.find(row => row.id === "kimi"); assert.equal(option.available, true);
  const main = view.agents.find(row => row.agentId === f.main);
  f.host.setAgentRuntime(f.workspaceId, f.main, "kimi", main.configRevision, main.agentEpoch);
  assert.equal(f.read().agents.find(row => row.agentId === f.main).runtime.id, "kimi");
  const models = await f.host.listRuntimeModels(f.workspaceId, "kimi"); assert.equal(models.source, "documented"); assert.ok(models.models.some(row => row.id === "default")); assert.ok(models.models.some(row => row.id === "kimi-code/kimi-for-coding")); assert.match(models.sourceURL, /kimi-code/);
  assert.equal(fs.existsSync(f.metaPath), false);
});

test("Gemini refuses an unreachable explicit Workspace proxy before physical launch", async t => {
  const server = createServer(); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`; await new Promise(resolve => server.close(resolve));
  const f = await jsonCliFixture(t, "gemini"); f.host.setRuntimeProxy(f.workspaceId, endpoint, 0);
  const sent = f.send(); await f.host.wait(sent.runId); const view = f.read();
  assert.equal(view.conversation.state, "blocked"); assert.ok(view.conversation.blockReason.includes('"kind":"runtime_proxy"'));
  assert.equal(fs.existsSync(f.metaPath), false); assert.equal(f.policyCalls.length, 0);
});

test("Gemini default factory runs the fake CLI under real Seatbelt with its frozen controlled tier", { skip: process.platform !== "darwin" }, async t => {
  const f = await jsonCliFixture(t, "gemini", { productionPolicy: true, recordReceipt: false, tier: "controlled" }), sent = f.send();
  await f.host.wait(sent.runId); const view = f.read();
  assert.equal(view.conversation.state, "completed", JSON.stringify(view.conversation));
  assert.ok(view.conversation.history.some(row => row.role === "tool" && row.results.some(result => result.name === "agent_list")));
  assert.ok(view.conversation.runtimeStages.at(-1).events.some(row => row.kind === "first_output"));
  assert.equal(f.policyCalls.length, 0, "the trusted synthetic policy seam was not used");
  assert.equal(fs.existsSync(f.metaPath), false);
});
