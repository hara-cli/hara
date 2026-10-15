import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { startServe } from "../dist/serve/server.js";
import { WORKSPACE_COLLABORATION_METHODS } from "../dist/workspace/collaboration-client.js";

async function fixture(t, enabled = true, history = false, members = false, mentions = false) {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "hara-collab-rpc-")));
  const calls = [];
  const workspaceCollaboration = Object.fromEntries(["list", "bootstrap", "sync", "send", "createChannel"].map(method => [
    method, async params => { calls.push([method, params]); return { ok: true, value: { fixture: method } }; },
  ]));
  if (history) workspaceCollaboration.history = async params => { calls.push(["history", params]); return { ok: true, value: { fixture: "history" } }; };
  if (members) workspaceCollaboration.members = async params => { calls.push(["members", params]); return { ok: true, value: { fixture: "members" } }; };
  if (mentions) workspaceCollaboration.sendWithMentions = async params => { calls.push(["sendWithMentions", params]); return { ok: true, value: { fixture: "mentions" } }; };
  const server = await startServe({ host: "127.0.0.1", port: 0, token: "fixture-token", cwd: home }, {
    version: "test", providerId: "synthetic", model: "synthetic", buildSessionProvider: async () => null,
    spawnSubagent: async () => "unused", sandbox: "off", approval: "suggest", quietDiscovery: true,
    agentTeamHome: home, discoveryHome: home, serveStateHome: home,
    ...(enabled ? { workspaceCollaboration } : {}),
  });
  const ws = new WebSocket("ws://127.0.0.1:" + server.port);
  const pending = new Map(); let next = 0;
  ws.on("message", raw => { const response = JSON.parse(String(raw)), item = pending.get(response.id);
    if (item) { pending.delete(response.id); clearTimeout(item.timer); item.resolve(response); }
  });
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  t.after(async () => { ws.close(); await server.close(); rmSync(home, { recursive: true, force: true }); });
  return { calls, call(method, params = {}) { return new Promise((resolve, reject) => {
    const id = ++next, timer = setTimeout(() => reject(new Error("synthetic RPC timeout")), 5000);
    pending.set(id, { resolve, timer }); ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  }); } };
}
test("collaboration RPC requires local authentication and explicit feature negotiation", async t => {
  const f = await fixture(t);
  assert.ok((await f.call("workspace.collaboration.list")).error); assert.equal(f.calls.length, 0);
  const init = await f.call("initialize", { token: "fixture-token" });
  assert.ok(init.result.capabilities.features.includes("workspace.collaboration.v1"));
  for (const method of WORKSPACE_COLLABORATION_METHODS) assert.ok(init.result.capabilities.methods.includes(method));
  const parameters = { workspaceId: "frozen-workspace", accountScope: "frozen-scope" };
  for (const method of WORKSPACE_COLLABORATION_METHODS) assert.equal((await f.call(method, parameters)).result.ok, true);
  assert.deepEqual(f.calls.map(item => item[0]), ["list", "bootstrap", "sync", "send", "createChannel"]);
  assert.ok(f.calls.every(item => JSON.stringify(item[1]) === JSON.stringify(parameters)));
});
test("unconfigured engines keep local chat and expose no hosted collaboration capability", async t => {
  const f = await fixture(t, false);
  const init = await f.call("initialize", { token: "fixture-token" });
  assert.equal(init.result.capabilities.features.includes("workspace.collaboration.v1"), false);
  for (const method of WORKSPACE_COLLABORATION_METHODS) {
    assert.equal(init.result.capabilities.methods.includes(method), false);
    assert.equal((await f.call(method)).error.code, -32601);
  }
});
test("history support is negotiated independently and remains behind authenticated Serve", async t => {
  const old = await fixture(t);
  const previous = await old.call("initialize", { token: "fixture-token" });
  assert.equal(previous.result.capabilities.features.includes("workspace.collaboration.history.v1"), false);
  assert.equal((await old.call("workspace.collaboration.history")).error.code, -32601);
  const f = await fixture(t, true, true);
  assert.ok((await f.call("workspace.collaboration.history")).error);
  const init = await f.call("initialize", { token: "fixture-token" });
  assert.ok(init.result.capabilities.features.includes("workspace.collaboration.history.v1"));
  assert.ok(init.result.capabilities.methods.includes("workspace.collaboration.history"));
  const params = { workspaceId: "frozen-workspace", channelId: "channel", accountScope: "frozen", before: "signed" };
  assert.equal((await f.call("workspace.collaboration.history", params)).result.ok, true);
  assert.deepEqual(f.calls, [["history", params]]);
});
test("members are an independent authenticated optional capability, never a local Agent roster", async t => {
  const old = await fixture(t);
  assert.equal((await old.call("initialize", { token: "fixture-token" })).result.capabilities.features.includes("workspace.collaboration.members.v1"), false);
  assert.equal((await old.call("workspace.collaboration.members")).error.code, -32601);
  const f = await fixture(t, true, false, true);
  assert.ok((await f.call("workspace.collaboration.members")).error); assert.equal(f.calls.length, 0);
  const init = await f.call("initialize", { token: "fixture-token" });
  assert.ok(init.result.capabilities.features.includes("workspace.collaboration.members.v1"));
  assert.ok(init.result.capabilities.methods.includes("workspace.collaboration.members"));
  const params = { workspaceId: "frozen-workspace", accountScope: "scope", cursor: "opaque" };
  assert.equal((await f.call("workspace.collaboration.members", params)).result.ok, true);
  assert.deepEqual(f.calls, [["members", params]]);
});
test("typed mention writes are independently negotiated and require the local token", async t => {
  const old = await fixture(t);
  assert.equal((await old.call("initialize", { token: "fixture-token" })).result.capabilities.features.includes("workspace.collaboration.mentions.v1"), false);
  assert.equal((await old.call("workspace.collaboration.send-with-mentions")).error.code, -32601);
  const f = await fixture(t, true, false, false, true);
  assert.ok((await f.call("workspace.collaboration.send-with-mentions")).error); assert.equal(f.calls.length, 0);
  const init = await f.call("initialize", { token: "fixture-token" });
  assert.ok(init.result.capabilities.features.includes("workspace.collaboration.mentions.v1"));
  assert.ok(init.result.capabilities.methods.includes("workspace.collaboration.send-with-mentions"));
  const params = { workspaceId: "frozen-workspace", channelId: "channel", accountScope: "scope", body: "text", idempotencyKey: "frozen", mentions: [{ kind: "human", principalId: "target" }] };
  assert.equal((await f.call("workspace.collaboration.send-with-mentions", params)).result.ok, true);
  assert.deepEqual(f.calls, [["sendWithMentions", params]]);
});
