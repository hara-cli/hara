import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { WorkspaceResourceStorage } from "../dist/workspace/resource-context.js";
import { WorkspaceRuntimeInstaller } from "../dist/workspace/runtime-install.js";
import { createJsonCliExecutionPolicy } from "../dist/agent-runtime/json-cli-policy.js";
import { createRuntimeExecutionPolicy } from "../dist/agent-runtime/execution-policy.js";

function temp(t) { const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "hara-json-isolation-"))); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
function installer(t, account, run) {
  const data = temp(t), storage = new WorkspaceResourceStorage(data, { schemaVersion: 1, workspaceId: `ws_${randomUUID()}`, authority: { kind: "local", localAuthorityId: randomUUID() } }); storage.initialize();
  const runtime = new WorkspaceRuntimeInstaller(storage, { accountHome: () => account, discovery: { home: account, probeHome: data, path: dirname(process.execPath), systemBins: [], run } });
  t.after(() => runtime.close()); return runtime;
}
test("absent Gemini and Kimi are not_installed with manual guides and never acquire packages", async t => {
  const account = temp(t), calls = [], runtime = installer(t, account, async (_command, args) => { calls.push(args); return null; });
  await runtime.discover();
  for (const id of ["gemini", "kimi"]) {
    const row = runtime.list().options.find(row => row.runtimeId === id);
    assert.equal(row.state, "not_installed"); assert.equal(row.generalAgentDriverAvailable, false); assert.ok(row.manualInstallation.url.startsWith("https://"));
    await assert.rejects(runtime.propose(id, "fixture", () => {}), /manual installation/);
  }
  assert.ok(calls.every(args => args[0] === "-lic" || args[0] === "--version" || JSON.stringify(args) === JSON.stringify(["config", "get", "prefix"])));
  // All are injected metadata probes; no package manager or shell command is executed by this fixture.
});
test("new runtimes bind only the proven account HOME and refuse isolated sign-in", async t => {
  const account = temp(t), bin = join(account, ".local/bin"); fs.mkdirSync(bin, { recursive: true });
  for (const id of ["gemini", "kimi"]) fs.writeFileSync(join(bin, id), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const runtime = installer(t, account, async (_command, args) => args[0] === "--version" ? "1.2.3" : null); await runtime.discover();
  for (const id of ["gemini", "kimi"]) {
    const row = runtime.list().options.find(row => row.runtimeId === id);
    assert.throws(() => runtime.registerLocal(id, row.fingerprint, "isolated"), /unavailable or unsafe/);
    runtime.registerLocal(id, row.fingerprint, "host");
    assert.throws(() => runtime.setLoginSource(id, "isolated"), /Invalid runtime login source/);
    const launch = runtime.resolveBound(id); assert.equal(launch.env.HOME, account); assert.equal(launch.loginSource, "host");
    assert.equal(runtime.executionPolicyRoots(id, launch).runtimeHome, join(account, id === "gemini" ? ".gemini" : ".kimi"));
    assert.throws(() => runtime.executionPolicyRoots(id, { ...launch, env: { ...launch.env, HOME: tmpdir() } }));
  }
});
test("Kimi inherited extensions do not bypass frozen Workspace permit admission", async () => {
  let rootsCalled = false;
  await assert.rejects(createJsonCliExecutionPolicy({ runtimeId: "kimi", permit: {}, installer: { executionPolicyRoots() { rootsCalled = true; throw Error("untrusted roots"); } } }));
  assert.equal(rootsCalled, false);
});

for (const id of ["gemini", "kimi"]) test(`${id}: real Seatbelt enforces fake-home state and foreign credential boundaries`, { skip: process.platform !== "darwin" }, async t => {
  const root = temp(t), home = join(root, "account"), work = join(root, "work"), own = id === "gemini" ? ".gemini" : ".kimi";
  for (const dir of [work, join(root, "outside"), join(home, ".hara"), join(home, ".gemini/tmp"), join(home, ".gemini/history"), join(home, ".kimi/sessions"), join(home, ".kimi/logs"), join(home, ".kimi/credentials"), join(home, ".kimi-code/credentials")]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(join(home, ".gemini/oauth_creds.json"), "FAKE_GEMINI"); fs.writeFileSync(join(home, ".kimi/config.toml"), "FAKE_KIMI"); fs.writeFileSync(join(home, ".kimi/credentials/kimi-code.json"), "FAKE_KIMI_OAUTH"); fs.writeFileSync(join(home, ".kimi/credentials/custom.json"), "FAKE_CUSTOM_OAUTH"); fs.writeFileSync(join(home, ".kimi-code/credentials/kimi-code.json"), "FAKE_NEW_DIALECT");
  const policy = createRuntimeExecutionPolicy({ runtimeId: id, tier: "full-protected", workRoot: work, accountHome: home, loginSource: "host" });
  try {
    policy.beginAttempt("fixture-attempt");
    const ownAuth = join(home, own, id === "gemini" ? "oauth_creds.json" : "config.toml"), foreign = join(home, id === "gemini" ? ".kimi/config.toml" : ".gemini/oauth_creds.json");
    const paths = { work: join(work, "yes.txt"), state: join(home, own, id === "gemini" ? "tmp" : "sessions", "yes"), hara: join(home, ".hara/no"), outside: join(root, "outside/no"), ownAuth, foreign, kimiOAuth: join(home, ".kimi/credentials/kimi-code.json"), kimiCustom: join(home, ".kimi/credentials/custom.json"), kimiCode: join(home, ".kimi-code/credentials/kimi-code.json") };
    const script = `const f=require('fs'),p=${JSON.stringify(paths)},out={}; for(const k of ['work','state','hara','outside']) {try {f.writeFileSync(p[k],'fixture');out[k]=true}catch{out[k]=false}} for(const k of ['ownAuth','foreign','kimiOAuth','kimiCustom','kimiCode']) {try {f.readFileSync(p[k]);out[k]=true}catch{out[k]=false}} try{f.writeFileSync(p.ownAuth,'no');out.authWrite=true}catch{out.authWrite=false} console.log(JSON.stringify(out));`;
    const launch = policy.wrap({ command: process.execPath, args: ["-e", script], env: { ...process.env, HOME: home } });
    const out = spawnSync(launch.command, launch.args, { env: launch.env, cwd: work, encoding: "utf8", timeout: 5000 }); assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(JSON.parse(out.stdout), { work: true, state: true, hara: false, outside: false, ownAuth: true, foreign: false, kimiOAuth: id === "kimi", kimiCustom: id === "kimi", kimiCode: false, authWrite: false });
    const evidence = policy.collectWorkspaceEvidence(); assert.equal(evidence.attemptKey, "fixture-attempt"); assert.equal(evidence.changes[0].path, "yes.txt");
    assert.ok(policy.profile.includes('global-name "com.apple.securityd"')); // Profile text only, never a service call.
  } finally { const path = policy.tempRoot; await policy.close(); assert.equal(fs.existsSync(path), false); }
});
