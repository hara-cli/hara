import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import { once } from "node:events";
import { cliMcpFixture } from "./helpers/workspace-cli-mcp.mjs";

async function fixture(t, { held = false } = {}) {
  const f = await cliMcpFixture(t, "reply");
  const key = "pi-draft-fixture-key"; let requests = 0, respond, entered;
  const reached = new Promise(resolve => { entered = resolve; });
  const server = http.createServer((req, res) => {
    assert.equal(req.method, "GET", "catalog-only fixture never accepts a model submission");
    assert.equal(req.url, "/v1/models"); assert.equal(req.headers.authorization, "Bearer " + key); requests++;
    const reply = () => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ data: [{ id: "gpt-5.6-sol" }, { id: "gpt-5.6-luna" }, { id: "reflected-" + key }] })); };
    respond = reply; entered(); if (!held) reply();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  let view = await f.read();
  await f.request("workspace.connection.add", { ...f.scope, expectedRevision: view.connections.revision,
    input: { label: "Draft models fixture", provider: "openai", baseURL: "http://127.0.0.1:" + server.address().port + "/v1", apiKey: key, defaultModel: "gpt-5.6-sol" } });
  view = await f.read(); const connection = view.connections.connections.find(row => row.label === "Draft models fixture");
  await f.request("workspace.connection.select", { ...f.scope, connectionId: connection.id, expectedRevision: view.connections.revision });
  const agent = (await f.read()).agents.find(row => row.agentId === f.main.agentId); assert.equal(agent.runtime.id, "codex");
  return { f, key, connectionId: connection.id, agent, reached, release: () => respond(), requests: () => requests,
    list: () => f.request("workspace.connection.listModels", { ...f.scope, agentId: agent.agentId, connectionId: connection.id }),
    noNativeTurns() { const file = f.command + ".rpc.jsonl"; const rows = fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : []; assert.equal(rows.filter(row => ["turn/start", "thread/compact/start"].includes(row.method)).length, 0); } };
}

test("Codex to Pi draft lists connection models before Apply and persists the selected runtime/model/effort", async t => {
  const x = await fixture(t), { f, agent, connectionId } = x;
  const catalog = await x.list(); assert.deepEqual(catalog.models.map(row => row.id), ["gpt-5.6-luna", "gpt-5.6-sol"]);
  assert(!JSON.stringify(catalog).includes(x.key)); assert.equal((await f.read()).agents.find(row => row.agentId === agent.agentId).runtime.id, "codex", "reading draft models must never save the engine");
  const result = await f.request("workspace.agents.applyRuntimeForm", { ...f.scope, agentId: agent.agentId, runtimeId: "pi", configRevision: agent.configRevision, agentEpoch: agent.agentEpoch });
  assert.deepEqual(result.applied, ["runtime"]);
  await f.request("workspace.connection.select", { ...f.scope, connectionId, expectedRevision: catalog.revision, modelId: "gpt-5.6-luna", effort: "high" });
  await f.restart(); const after = await f.read(), saved = after.agents.find(row => row.agentId === agent.agentId);
  assert.equal(saved.runtime.id, "pi"); const row = after.connections.connections.find(row => row.id === connectionId);
  assert.equal(row.defaultModel, "gpt-5.6-luna"); assert.equal(row.defaultReasoning, "high"); x.noNativeTurns();
});

test("a draft model request still rejects an agent configuration changed while discovery is pending", async t => {
  const x = await fixture(t, { held: true }); const pending = x.list(); const rejected = assert.rejects(pending, /Workspace model view changed; refresh/);
  await x.reached; await x.f.request("workspace.agents.setPermissionTier", { ...x.f.scope, agentId: x.agent.agentId, permissionTier: "controlled", configRevision: x.agent.configRevision, agentEpoch: x.agent.agentEpoch });
  x.release(); await rejected; assert.equal((await x.f.read()).agents.find(row => row.agentId === x.agent.agentId).runtime.id, "codex"); x.noNativeTurns();
});

test("a draft model request still rejects a connection revision changed while discovery is pending", async t => {
  const x = await fixture(t, { held: true }); const pending = x.list(); const rejected = assert.rejects(pending, /Connection changed; refresh model list/);
  await x.reached; const view = await x.f.read(); await x.f.request("workspace.connection.select", { ...x.f.scope, connectionId: x.connectionId, expectedRevision: view.connections.revision, modelId: "gpt-5.6-sol", effort: "medium" });
  x.release(); await rejected; x.noNativeTurns();
});

test("draft catalog access still checks agent existence, connection scope and workspace generation before querying", async t => {
  const x = await fixture(t); const args = { ...x.f.scope, agentId: x.agent.agentId, connectionId: x.connectionId };
  await assert.rejects(x.f.request("workspace.connection.listModels", { ...args, agentId: "ag_00000000-0000-4000-8000-000000000000" }), /agent unavailable/i);
  await assert.rejects(x.f.request("workspace.connection.listModels", { ...args, connectionId: "mc_00000000-0000-4000-8000-000000000000" }), /Connection unavailable/);
  await assert.rejects(x.f.request("workspace.connection.listModels", { ...args, expectedGeneration: "stale-workspace-generation" }));
  assert.equal(x.requests(), 0); x.noNativeTurns();
});
