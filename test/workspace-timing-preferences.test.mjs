import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { WebSocket } from "ws";
import { WorkspacePreferences } from "../dist/workspace/preferences.js";
import { startLocalWorkspaceServe } from "../dist/serve/local-workspace.js";
import { MemoryCredentialVault } from "../dist/workspace/credential-vault.js";
function root(t) { const path = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "hara-timing-prefs-"))); t.after(() => fs.rmSync(path, { recursive: true, force: true })); return path; }

test("timing diagnostics default off for new and old v2 settings without rewriting the old file on read", t => {
  const home = root(t), prefs = new WorkspacePreferences(home); assert.equal(prefs.read().alwaysShowTimingDiagnostics, false);
  prefs.save("dark", 0); const path = join(home, ".hara/ui-preferences-v1.json"), raw = JSON.parse(fs.readFileSync(path));
  delete raw.alwaysShowTimingDiagnostics; fs.writeFileSync(path, JSON.stringify(raw)); const before = fs.readFileSync(path);
  assert.equal(new WorkspacePreferences(home).read().alwaysShowTimingDiagnostics, false); assert.deepEqual(fs.readFileSync(path), before);
});
test("an explicit timing switch survives reopening and unrelated preference writes; stale or non-boolean writes fail", t => {
  const home = root(t), prefs = new WorkspacePreferences(home);
  prefs.save("dark", 0, { alwaysShowTimingDiagnostics: true }); assert.equal(new WorkspacePreferences(home).read().alwaysShowTimingDiagnostics, true);
  prefs.save("light", 1, { executionDetails: "detailed" }); assert.equal(prefs.read().alwaysShowTimingDiagnostics, true);
  const path = join(home, ".hara/ui-preferences-v1.json"), before = fs.readFileSync(path);
  assert.throws(() => prefs.save("light", 1, { alwaysShowTimingDiagnostics: false }));
  for (const value of [1, "true", null]) assert.throws(() => prefs.save("light", 2, { alwaysShowTimingDiagnostics: value }), /display preference/);
  assert.deepEqual(fs.readFileSync(path), before); prefs.save("light", 2, { alwaysShowTimingDiagnostics: false });
  assert.equal(new WorkspacePreferences(home).read().alwaysShowTimingDiagnostics, false);
});
test("the authenticated preference RPC accepts only the timing boolean and retains revision checks", async () => {
  const home = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "hara-timing-rpc-")));
  const handle = await startLocalWorkspaceServe({ host: "127.0.0.1", port: 0, cwd: home }, { root: home, version: "fixture", credentialVault: new MemoryCredentialVault(),
    providerFactory() { throw new Error("preference changes cannot dispatch a model"); } });
  const socket = new WebSocket("ws://127.0.0.1:" + handle.port), pending = new Map(); let serial = 0;
  socket.on("message", raw => { const row = JSON.parse(raw); const waiter = pending.get(row.id); if (waiter) { pending.delete(row.id); clearTimeout(waiter.timer); row.error ? waiter.reject(new Error(row.error.message)) : waiter.resolve(row.result); } });
  const request = (method, params) => new Promise((resolve, reject) => { const id = ++serial, timer = setTimeout(() => { pending.delete(id); reject(new Error("fixture RPC deadline")); }, 10000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params })); });
  try {
    await once(socket, "open"); await assert.rejects(request("workspace.preferences.get", {}), /unauthorized/);
    await request("initialize", { token: handle.token }); const initial = await request("workspace.preferences.get", {});
    assert.equal(initial.alwaysShowTimingDiagnostics, false);
    const saved = await request("workspace.preferences.set", { theme: initial.theme, expectedRevision: initial.revision, alwaysShowTimingDiagnostics: true });
    assert.equal(saved.alwaysShowTimingDiagnostics, true);
    await assert.rejects(request("workspace.preferences.set", { theme: saved.theme, expectedRevision: initial.revision, alwaysShowTimingDiagnostics: false }), /changed|revision/);
    await assert.rejects(request("workspace.preferences.set", { theme: saved.theme, expectedRevision: saved.revision, alwaysShowTimingDiagnostics: "true" }), /display preference/);
    await assert.rejects(request("workspace.preferences.set", { theme: saved.theme, expectedRevision: saved.revision, alwaysShowTimingDiagnostics: false, forged: true }), /unsupported/);
    assert.equal((await request("workspace.preferences.get", {})).alwaysShowTimingDiagnostics, true);
  } finally { socket.close(); await once(socket, "close"); await handle.close(); fs.rmSync(home, { recursive: true, force: true }); }
});
