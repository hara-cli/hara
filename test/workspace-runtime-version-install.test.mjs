import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { WorkspaceRuntimeInstaller } from "../dist/workspace/runtime-install.js";
import { WorkspaceResourceStorage, workspaceStateHome } from "../dist/workspace/resource-context.js";
const roots = [];
const temporary = () => { const path = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "hara-version-install-"))); roots.push(path); return path; };
after(() => roots.forEach(path => fs.rmSync(path, { recursive: true, force: true })));
async function fixture(runtimeId = "codex", initial = "1.2.3") {
  const data = temporary(), account = temporary(), command = join(account, ".local/bin", runtimeId);
  const storage = new WorkspaceResourceStorage(data, { schemaVersion: 1, workspaceId: `ws_${randomUUID()}`,
    authority: { kind: "local", localAuthorityId: randomUUID() } }); storage.initialize();
  let version = initial;
  const replace = (value, suffix = "") => { version = value; fs.mkdirSync(dirname(command), { recursive: true });
    fs.writeFileSync(command, `#!/bin/sh\necho '${value}'\n# ${suffix}\n`, { mode: 0o755 }); };
  replace(initial);
  const installer = new WorkspaceRuntimeInstaller(storage, { discovery: { home: account, path: "/usr/bin:/bin", systemBins: [],
    run: async (_command, args) => args[0] === "-lic" ? null : `${runtimeId} ${version}` } });
  const row = () => installer.list().options.find(item => item.runtimeId === runtimeId);
  await installer.discover(); installer.registerLocal(runtimeId, row().fingerprint, runtimeId === "opencode" ? "host" : "isolated");
  return { storage, installer, row, command, replace };
}
test("only explicit completed-use callback persists the trusted binary/version, including a cold reopen", async () => {
  const f = await fixture(); try {
    const resolved = f.installer.resolveBound("codex"), complete = f.installer.captureSuccessfulUse("codex", resolved.command);
    assert.equal(f.row().versionStatus.change, "no_history", "discovery, registration and capture alone are not a successful use");
    complete();
    assert.equal(f.row().versionStatus.lastSuccessfulVersion, "1.2.3");
    assert.equal(f.row().versionStatus.compatibility, "previously_succeeded");
    const file = f.storage.run(() => join(workspaceStateHome(), ".hara/runtime-successful-versions-v1.json"));
    const text = fs.readFileSync(file, "utf8"); assert.doesNotMatch(text, /Users|HOME|prompt|reply|token|credential|local\/bin/);
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const reopened = new WorkspaceRuntimeInstaller(f.storage);
    try { assert.deepEqual(reopened.list().options.find(row => row.runtimeId === "codex").versionStatus, f.row().versionStatus); }
    finally { await reopened.close(); }
  } finally { await f.installer.close(); }
});
test("upgrade explanation never trusts a discovered replacement and success history changes only after confirmed new use", async () => {
  const f = await fixture(); try {
    f.installer.captureSuccessfulUse("codex", f.command)();
    const stale = f.installer.captureSuccessfulUse("codex", f.command);
    f.replace("2.0.0"); stale();
    assert.equal(f.row().versionStatus.currentVersion, null, "old version metadata is not attached to changed bytes");
    assert.equal(f.row().versionStatus.lastSuccessfulVersion, "1.2.3");
    assert.equal(f.row().versionStatus.compatibility, "unknown");
    assert.equal(f.row().versionStatus.requiresRetrust, true);
    assert.throws(() => f.installer.resolveBound("codex"), /unsafe/);
    await f.installer.discover();
    const detected = f.row();
    assert.equal(detected.versionStatus.change, "upgraded");
    assert.equal(detected.versionStatus.currentVersion, "2.0.0");
    assert.equal(detected.versionStatus.lastSuccessfulVersion, "1.2.3");
    assert.equal(detected.versionStatus.requiresRetrust, true);
    assert.equal(detected.registered, false); assert.equal(detected.generalAgentDriverAvailable, false);
    assert.throws(() => f.installer.resolveBound("codex"), /unsafe/);
    f.installer.registerLocal("codex", detected.fingerprint, "isolated");
    assert.equal(f.row().versionStatus.compatibility, "unverified");
    assert.equal(f.row().versionStatus.binaryChanged, true);
    assert.equal(f.row().versionStatus.requiresRetrust, false);
    f.installer.captureSuccessfulUse("codex", f.installer.resolveBound("codex").command)();
    assert.equal(f.row().versionStatus.lastSuccessfulVersion, "2.0.0");
    assert.equal(f.row().versionStatus.compatibility, "previously_succeeded");
    f.replace("0.9.0"); await f.installer.discover();
    assert.equal(f.row().versionStatus.change, "downgraded");
    assert.equal(f.row().versionStatus.lastSuccessfulVersion, "2.0.0");
  } finally { await f.installer.close(); }
});
test("same-version replacement and unknown versions never inherit previous successful compatibility", async () => {
  const f = await fixture(); try {
    f.installer.captureSuccessfulUse("codex", f.command)();
    f.replace("1.2.3", "different bytes"); await f.installer.discover();
    const changed = f.row();
    assert.equal(changed.versionStatus.change, "same"); assert.equal(changed.versionStatus.binaryChanged, true);
    assert.equal(changed.versionStatus.requiresRetrust, true); assert.equal(changed.versionStatus.compatibility, "unverified");
    assert.throws(() => f.installer.resolveBound("codex"), /unsafe/);
  } finally { await f.installer.close(); }
  const unknown = await fixture("claude", "1.2.3-beta"); try {
    unknown.installer.captureSuccessfulUse("claude", unknown.command)();
    const value = unknown.row().versionStatus;
    assert.equal(value.currentVersion, null); assert.equal(value.lastSuccessfulVersion, null);
    assert.equal(value.change, "unknown"); assert.equal(value.compatibility, "unknown");
  } finally { await unknown.installer.close(); }
});
test("a replaced/closed launch cannot record success and damaged history cannot break or repair the registry", async () => {
  const f = await fixture(); try {
    const complete = f.installer.captureSuccessfulUse("codex", f.command);
    f.replace("1.2.4"); complete(); assert.equal(f.row().versionStatus.lastSuccessfulVersion, null);
    await f.installer.discover(); f.installer.registerLocal("codex", f.row().fingerprint, "isolated");
    const file = f.storage.run(() => join(workspaceStateHome(), ".hara/runtime-successful-versions-v1.json"));
    fs.writeFileSync(file, "PRIVATE_DAMAGED_STATE", { mode: 0o600 });
    assert.equal(f.row().registered, true); assert.equal(f.row().versionStatus.change, "unknown");
    f.installer.captureSuccessfulUse("codex", f.command)();
    assert.equal(fs.readFileSync(file, "utf8"), "PRIVATE_DAMAGED_STATE");
    assert.doesNotMatch(JSON.stringify(f.row().versionStatus), /PRIVATE_DAMAGED_STATE/);
    assert.equal(f.installer.resolveBound("codex").command, f.command);
    const closed = f.installer.captureSuccessfulUse("codex", f.command); await f.installer.close(); closed();
    assert.equal(fs.readFileSync(file, "utf8"), "PRIVATE_DAMAGED_STATE");
  } finally { await f.installer.close(); }
});
