import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { detectInstalledRuntimes, boundedRuntimeCommand } from "../dist/workspace/runtime-detect.js";
import { WorkspaceRuntimeInstaller } from "../dist/workspace/runtime-install.js";
import { WorkspaceResourceStorage } from "../dist/workspace/resource-context.js";
import { AgentRuntimeRegistry } from "../dist/agent-runtime/registry.js";

const roots = [], tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function directory() { const p = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "hara-copilot-probe-"))); roots.push(p); return p; }
function binary(path, body = "echo tool 1.0.105") { fs.mkdirSync(dirname(path), { recursive: true }); fs.writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 }); return path; }
after(() => roots.forEach(p => fs.rmSync(p, { recursive: true, force: true })));
function fixture(copilotRun, otherRun = () => "Claude 2.0.1") {
  const home = directory(), probeHome = directory(), calls = [], events = [];
  const command = binary(join(home, ".local/bin/copilot")), claude = binary(join(home, ".local/bin/claude"));
  let validAuthority = true, attempt = 0;
  const storage = new WorkspaceResourceStorage(directory(), { schemaVersion: 1, workspaceId: `ws_${randomUUID()}`,
    authority: { kind: "local", localAuthorityId: randomUUID() } }, () => { if (!validAuthority) throw new Error("Workspace retired"); });
  storage.initialize();
  const discovery = { home, probeHome, path: "/usr/bin:/bin", systemBins: [], run: async (path, args, env, timeout, control) => {
    if (args[0] === "-lic") return null;
    assert.deepEqual(args, ["--version"]);
    assert.equal(env.HOME, probeHome); assert.equal(env.USERPROFILE, probeHome);
    assert.equal(env.XDG_CONFIG_HOME, join(probeHome, ".config")); assert.equal(env.XDG_CACHE_HOME, join(probeHome, ".cache"));
    assert.equal(env.DISABLE_AUTOUPDATER, "1"); assert.equal(env.OPENCODE_DISABLE_MODELS_FETCH, "true");
    assert.equal(Object.keys(env).some(key => /API_KEY|TOKEN|SECRET/.test(key)), false);
    const row = { path, args, env, timeout, control }; calls.push(row);
    return path === command ? copilotRun({ ...row, attempt: ++attempt }) : otherRun(row);
  } };
  const installer = new WorkspaceRuntimeInstaller(storage, { discovery, onChange: () => events.push(installer.list()) });
  const registry = new AgentRuntimeRegistry(undefined, installer);
  return { installer, registry, discovery, command, claude, calls, events,
    copilotCalls: () => calls.filter(row => row.path === command), row: () => installer.list().options.find(row => row.runtimeId === "copilot"),
    authority: value => { validAuthority = value; } };
}
async function initialScan(f) {
  let complete = false;
  const scan = f.installer.discover().then(() => { complete = true; });
  await tick();
  assert.equal(complete, true, "initial scan must resolve before the controlled background result");
  await scan; await tick();
}
const timeout = control => { control.onTimeout(); return null; };

test("cold Copilot returns a pending choice before its one 5s retry, updates through onChange, and never auto-registers", async () => {
  const reply = deferred();
  const f = fixture(({ attempt, control }) => attempt === 1 ? timeout(control) : reply.promise);
  try {
    await initialScan(f);
    assert.deepEqual(f.copilotCalls().map(row => row.timeout), [1200, 5000]);
    assert.equal(f.row().state, "detecting"); assert.equal(f.row().installed, false);
    assert.equal(f.row().fingerprint, null); assert.equal(f.row().registered, false);
    assert.equal(f.registry.options().find(row => row.id === "copilot").reason, "detection_pending");
    assert.throws(() => f.installer.registerLocal("copilot", "0".repeat(64)));
    const claude = f.installer.list().options.find(row => row.runtimeId === "claude");
    assert.equal(claude.state, "detected"); assert.equal(claude.version, "2.0.1");
    assert.equal(f.calls.find(row => row.path === f.claude).timeout, 1200);
    await f.installer.discover(); await f.installer.discover();
    assert.equal(f.copilotCalls().length, 2, "rescans must not duplicate the in-flight retry");
    assert.equal(f.calls.filter(row => row.path === f.claude).length, 3, "other runtimes still rescan normally");
    assert.equal(f.events.length, 1);
    reply.resolve("GitHub Copilot CLI 1.0.105"); await tick();
    assert.equal(f.row().state, "detected"); assert.equal(f.row().version, "1.0.105");
    assert.equal(f.row().registered, false); assert.equal(f.row().generalAgentDriverAvailable, false);
    assert.equal(f.registry.options().find(row => row.id === "copilot").reason, "not_registered");
    assert.equal(f.events.length, 2);
    f.installer.registerLocal("copilot", f.row().fingerprint);
    assert.equal(f.row().state, "local_registered");
  } finally { reply.resolve(null); await f.installer.close(); }
});

test("warm Copilot keeps the original 1.2s path with no retry and leaves other runtimes unchanged", async () => {
  const f = fixture(() => "GitHub Copilot CLI 1.0.105");
  try {
    await f.installer.discover(); await tick();
    assert.deepEqual(f.copilotCalls().map(row => row.timeout), [1200]);
    assert.equal(f.row().state, "detected"); assert.equal(f.row().version, "1.0.105");
    assert.equal(f.events.length, 0);
    assert.equal(f.installer.list().options.find(row => row.runtimeId === "claude").version, "2.0.1");
    assert.equal(f.calls.find(row => row.path === f.claude).timeout, 1200);
  } finally { await f.installer.close(); }
});

test("a failed bounded retry stays unconfirmed instead of missing; only a later explicit scan retries discovery", async () => {
  const reply = deferred(); let warm = false;
  const f = fixture(({ attempt, control }) => warm ? "Copilot 1.0.105" : attempt === 1 ? timeout(control) : reply.promise);
  try {
    await initialScan(f); reply.resolve(null); await tick();
    assert.equal(f.row().state, "detection_failed"); assert.equal(f.row().version, null);
    assert.equal(f.registry.options().find(row => row.id === "copilot").reason, "detection_failed");
    await tick(); assert.equal(f.copilotCalls().length, 2);
    warm = true; await f.installer.discover();
    assert.equal(f.row().state, "detected"); assert.equal(f.copilotCalls().length, 3);
  } finally { reply.resolve(null); await f.installer.close(); }
});

test("non-timeout Copilot exits do not gain a longer retry", async () => {
  const f = fixture(() => null);
  try { await f.installer.discover(); await tick(); assert.equal(f.copilotCalls().length, 1); assert.equal(f.row().state, "not_installed"); }
  finally { await f.installer.close(); }
});

test("standalone discovery reports unknown absence when a timed-out Copilot has no background owner", async () => {
  const f = fixture(({ control }) => timeout(control));
  try { await assert.rejects(detectInstalledRuntimes(f.discovery), /absence is not confirmed/); assert.equal(f.copilotCalls().length, 1); }
  finally { await f.installer.close(); }
});

test("the deferred probe is single-use and rechecks the exact executable before starting", async () => {
  let probe;
  const f = fixture(({ control }) => timeout(control));
  try {
    await detectInstalledRuntimes({ ...f.discovery, onCopilotProbeTimeout: value => { probe = value; } });
    assert.ok(probe); binary(f.command, "echo changed 9.9.9");
    assert.equal(await probe.retry(new AbortController().signal), null);
    assert.equal(await probe.retry(new AbortController().signal), null);
    assert.equal(f.copilotCalls().length, 1);
  } finally { await f.installer.close(); }
});

test("a binary replaced during the retry cannot publish a version or register the old fingerprint", async () => {
  const reply = deferred(), f = fixture(({ attempt, control }) => attempt === 1 ? timeout(control) : reply.promise);
  try {
    await initialScan(f); binary(f.command, "echo replacement 9.9.9");
    reply.resolve("Copilot 1.0.105"); await tick();
    assert.equal(f.row().state, "detection_failed"); assert.equal(f.row().fingerprint, null);
    assert.throws(() => f.installer.registerLocal("copilot", "0".repeat(64)));
  } finally { reply.resolve(null); await f.installer.close(); }
});

test("a retired Workspace discards its late probe result and publishes no late change", async () => {
  const reply = deferred(), f = fixture(({ attempt, control }) => attempt === 1 ? timeout(control) : reply.promise);
  try {
    await initialScan(f); assert.equal(f.events.length, 1); f.authority(false);
    reply.resolve("Copilot 1.0.105"); await tick(); f.authority(true);
    assert.equal(f.events.length, 1); assert.equal(f.row().state, "detecting");
    assert.equal(f.row().version, null); assert.equal(f.row().registered, false);
  } finally { f.authority(true); reply.resolve(null); await f.installer.close(); }
});

test("closing owns and aborts the metadata retry without publishing a late result", async () => {
  let aborted = 0;
  const f = fixture(({ attempt, control }) => attempt === 1 ? timeout(control) : new Promise(resolve => {
    control.signal.addEventListener("abort", () => { aborted++; resolve("Copilot 1.0.105"); }, { once: true });
  }));
  await initialScan(f); const events = f.events.length;
  await f.installer.close(); await tick();
  assert.equal(aborted, 1); assert.equal(f.events.length, events);
  assert.equal(f.row().registered, false); assert.equal(f.row().version, null);
});

test("bounded metadata command distinguishes timeout from exit, output overflow and owner cancellation", async () => {
  const env = { PATH: "/usr/bin:/bin", HOME: directory() }; let expirations = 0;
  const control = { onTimeout: () => { expirations++; } };
  assert.equal(await boundedRuntimeCommand("/bin/sh", ["-c", "sleep 3"], env, 50, control), null);
  assert.equal(expirations, 1); expirations = 0;
  assert.equal(await boundedRuntimeCommand("/bin/sh", ["-c", "exit 1"], env, 5000, control), null);
  assert.equal(await boundedRuntimeCommand("/bin/sh", ["-c", "printf '%20000s' x"], env, 5000, control), null);
  const controller = new AbortController();
  const running = boundedRuntimeCommand("/bin/sh", ["-c", "sleep 3"], env, 5000, { ...control, signal: controller.signal });
  controller.abort(); assert.equal(await running, null); assert.equal(expirations, 0);
});

test("a different runtime timeout keeps its original behavior and receives no longer budget", async () => {
  const f = fixture(() => "Copilot 1.0.105", ({ control }) => timeout(control));
  try {
    await f.installer.discover(); await tick();
    assert.equal(f.installer.list().options.find(row => row.runtimeId === "claude").state, "not_installed");
    assert.deepEqual(f.calls.filter(row => row.path === f.claude).map(row => row.timeout), [1200]);
    assert.deepEqual(f.copilotCalls().map(row => row.timeout), [1200]);
    assert.equal(f.events.length, 0);
  } finally { await f.installer.close(); }
});

test("a slower rescan of other runtimes cannot erase a completed Copilot retry", async () => {
  const reply = deferred(), otherReply = deferred(); let blockOther = false;
  const f = fixture(({ attempt, control }) => attempt === 1 ? timeout(control) : reply.promise,
    () => blockOther ? otherReply.promise : "Claude 2.0.1");
  try {
    await initialScan(f); blockOther = true; const rescan = f.installer.discover(); await tick();
    assert.equal(f.calls.filter(row => row.path === f.claude).length, 2);
    reply.resolve("Copilot 1.0.105"); await tick(); assert.equal(f.row().state, "detected");
    otherReply.resolve("Claude 2.0.2"); await rescan;
    assert.equal(f.row().state, "detected"); assert.equal(f.row().version, "1.0.105");
    assert.equal(f.copilotCalls().length, 2);
    assert.equal(f.installer.list().options.find(row => row.runtimeId === "claude").version, "2.0.2");
  } finally { reply.resolve(null); otherReply.resolve(null); await f.installer.close(); }
});
