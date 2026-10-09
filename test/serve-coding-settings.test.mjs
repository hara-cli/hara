import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { startServe } from "../dist/serve/server.js";

async function fixture(t, { personal = true, supported = true } = {}) {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "hara-coding-settings-serve-")));
  let value = { version: 1, revision: 0, executor: "auto", effectiveExecutor: "opencode",
    recommendedExecutor: "opencode", executorEditable: true, experimental: false };
  let writes = 0, reads = 0;
  const server = await startServe({ host: "127.0.0.1", port: 0, token: "fixture-token", cwd: home }, {
    version: "test", providerId: "fixture", model: "fixture", buildSessionProvider: async () => null,
    spawnSubagent: async () => "unused", sandbox: "off", approval: "suggest", quietDiscovery: true,
    agentTeamHome: home, discoveryHome: home, serveStateHome: home,
    runtimeInfo: () => ({ providerId: "fixture", model: "fixture", profileId: "fixture", spaceId: personal ? "personal" : "organization:fixture" }),
    ...(supported ? {
      codingSettings: () => { reads++; return { ...value }; },
      saveCodingSettings(input) {
        if (input.expectedRevision !== value.revision) throw new Error("conflict");
        writes++;
        value = { ...value, revision: value.revision + 1, executor: input.executor,
          effectiveExecutor: input.executor === "auto" ? "opencode" : input.executor, experimental: input.executor === "pi" };
        return { ...value };
      },
    } : {}),
  });
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
  const pending = new Map(); let next = 1;
  ws.on("message", raw => { const message = JSON.parse(String(raw)); if (pending.has(message.id)) {
    const item = pending.get(message.id); pending.delete(message.id); clearTimeout(item.timer); item.resolve(message);
  } });
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  t.after(async () => { ws.close(); await server.close(); rmSync(home, { recursive: true, force: true }); });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = next++; const timer = setTimeout(() => reject(new Error("fixture RPC timeout")), 5_000);
    pending.set(id, { resolve, timer }); ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
  return { call, writes: () => writes, reads: () => reads };
}

test("coding preferences require authentication, negotiate explicitly and save by revision", async t => {
  const f = await fixture(t);
  assert.ok((await f.call("settings.coding.update", { executor: "pi", expectedRevision: 0 })).error);
  const initialized = await f.call("initialize", { token: "fixture-token" });
  assert.ok(initialized.result.capabilities.features.includes("coding.settings.v1"));
  assert.ok(initialized.result.capabilities.methods.includes("settings.coding.get"));
  assert.equal((await f.call("settings.coding.get")).result.effectiveExecutor, "opencode");
  const changed = await f.call("settings.coding.update", { executor: "pi", expectedRevision: 0 });
  assert.equal(changed.result.effectiveExecutor, "pi"); assert.equal(changed.result.revision, 1);
  assert.ok((await f.call("settings.coding.update", { executor: "opencode", expectedRevision: 0 })).error);
  assert.equal((await f.call("settings.coding.get")).result.executor, "pi");
  assert.equal(f.writes(), 1);
});

test("coding settings reject unknown inputs and cannot accept a package, command or API key", async t => {
  const f = await fixture(t); await f.call("initialize", { token: "fixture-token" });
  for (const input of [{ executor: "auto" }, { executor: "other", expectedRevision: 0 },
    { executor: "pi", expectedRevision: -1 }, { executor: "pi", expectedRevision: 0, command: "untrusted" },
    { executor: "pi", expectedRevision: 0, apiKey: "synthetic-not-a-key" }]) {
    assert.ok((await f.call("settings.coding.update", input)).error);
  }
  assert.ok((await f.call("settings.coding.get", { profileId: "foreign" })).error);
  assert.equal(f.writes(), 0);
});

test("Company clients neither advertise nor read or mutate Personal executor settings", async t => {
  const f = await fixture(t, { personal: false });
  const initialized = await f.call("initialize", { token: "fixture-token" });
  assert.equal(initialized.result.capabilities.features.includes("coding.settings.v1"), false);
  assert.equal(initialized.result.capabilities.methods.includes("settings.coding.get"), false);
  assert.ok((await f.call("settings.coding.get")).error);
  assert.ok((await f.call("settings.coding.update", { executor: "pi", expectedRevision: 0 })).error);
  assert.equal(f.reads(), 0); assert.equal(f.writes(), 0);
});

test("older embedders without both callbacks advertise no executor settings capability", async t => {
  const f = await fixture(t, { supported: false });
  const initialized = await f.call("initialize", { token: "fixture-token" });
  assert.equal(initialized.result.capabilities.features.includes("coding.settings.v1"), false);
  assert.ok((await f.call("settings.coding.get")).error);
});
