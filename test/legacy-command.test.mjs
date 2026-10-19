import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { WorkspaceResourceStorage, workspaceStateHome } from "../dist/workspace/resource-context.js";
import { WorkspaceResources } from "../dist/workspace/resources.js";
import { WorkspaceFeatures } from "../dist/workspace/features.js";
import { WorkspaceLegacyResources, planLegacyResources } from "../dist/workspace/legacy-resources.js";
import { buildLegacyInheritancePlan } from "../dist/workspace/legacy-plan.js";
import { legacyScheduleRows, legacySchedulesDomain } from "../dist/workspace/legacy-schedules.js";
import { WorkspaceLegacyCommands } from "../dist/workspace/legacy-command.js";
import { terminateSubprocessTree } from "../dist/security/subprocess-env.js";

async function fixture(t, overrides = {}, extraJobs = []) {
  const home = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "hara-legacy-command-")));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const cwd = join(home, "approved-fixture"), isolatedHome = join(home, "child-home");
  fs.mkdirSync(cwd, { mode: 0o700 }); fs.mkdirSync(isolatedHome, { mode: 0o700 });
  const scope = { schemaVersion: 1, workspaceId: `ws_${randomUUID()}`, authority: { kind: "local", localAuthorityId: randomUUID() } };
  const storage = new WorkspaceResourceStorage(home, scope); storage.initialize();
  const resources = new WorkspaceResources(home, scope); resources.initialize(); const main = resources.agents.initializeMain();
  const features = new WorkspaceFeatures(storage, home, scope.workspaceId), folders = new WorkspaceLegacyResources(storage);
  const job = (id, patch = {}) => ({ id, name: id, task: "printf fixture", mode: "command", cwd: "/old/readonly/project", createdAt: 0, enabled: true,
    schedule: { kind: "cron", expr: "* * * * *" }, ...patch });
  const jobs = [job("one", overrides), ...extraJobs.map((row, i) => job(`other-${i}`, row))];
  const input = { sourceFingerprint: "a".repeat(64), now: 120000, jobs, roles: [], sessions: [], flows: [], profiles: {}, config: {} };
  const plan = buildLegacyInheritancePlan(input);
  await folders.domain(input.sourceFingerprint, planLegacyResources({ jobs, projects: [], legacyWorkspacePath: "/old/readonly/workspace" })).apply();
  const rows = legacyScheduleRows({ jobs, plan: plan.tasks, sourceFingerprint: input.sourceFingerprint, workspaceId: scope.workspaceId, mainAgentId: main.agentId, resources: folders });
  await legacySchedulesDomain(storage, features, input.sourceFingerprint, rows).apply();
  let calls = 0, authorized = 0;
  const options = {
    authorize(review) { authorized++; return { resourceBinding: review.resourceBinding, definitionHash: review.definitionHash, resourceId: review.resourceId,
      cwd, isolatedHome, searchPath: "/usr/bin:/bin", assertCurrent() {} }; },
    async launch(invocation) { calls++; invocation.onOutput("stdout", "fixture output\n"); return { code: 0, terminated: true }; },
  };
  const adapter = patch => new WorkspaceLegacyCommands(storage, features, folders, { ...options, ...patch });
  return { home, cwd, isolatedHome, scope, storage, resources, features, folders, rows, adapter, options, calls: () => calls, authorized: () => authorized };
}

// The production boundary has no launcher. This opt-in TEST launcher runs only freshly authored
// synthetic shell text with a private HOME and an owned process group; never the copied old jobs.
function fixtureProcess(invocation) {
  return new Promise(resolve => {
    const child = spawn("/bin/bash", ["--noprofile", "--norc", "-c", invocation.command], {
      cwd: invocation.cwd, env: invocation.env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
    });
    const stop = () => terminateSubprocessTree(child, { force: true, processGroup: process.platform !== "win32" });
    invocation.signal.addEventListener("abort", stop, { once: true }); if (invocation.signal.aborted) stop();
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => invocation.onOutput("stdout", chunk)); child.stderr.on("data", chunk => invocation.onOutput("stderr", chunk));
    child.once("error", () => resolve({ code: null, terminated: false }));
    child.once("close", code => { invocation.signal.removeEventListener("abort", stop); resolve({ code, terminated: true }); });
  });
}

test("copied metadata alone never authorizes launch; durable refusal survives restart", async t => {
  const f = await fixture(t), request = randomUUID(), a = f.adapter({ authorize: () => undefined });
  const receipt = await a.execute("one", request); assert.equal(receipt.state, "blocked"); assert.equal(receipt.reason, "host_execution_grant_required");
  assert.equal(f.calls(), 0); assert.deepEqual(await f.adapter().execute("one", request), receipt); assert.equal(f.authorized(), 0);
});
test("one request executes once across concurrent callers and restart; changed payload conflicts", async t => {
  const f = await fixture(t, {}, [{}]), a = f.adapter(), request = randomUUID();
  const [one, two] = await Promise.all([a.execute("one", request), a.execute("one", request)]);
  assert.deepEqual(one, two); assert.equal(one.state, "completed"); assert.equal(f.calls(), 1);
  assert.deepEqual(await f.adapter().execute("one", request), one); assert.equal(f.calls(), 1);
  await assert.rejects(f.adapter().execute("other-0", request), /conflicts/);
});
test("unknown/active work prevents new request identities from replaying the same task", async t => {
  const f = await fixture(t), request = randomUUID();
  const a = f.adapter({ async launch() { throw new Error("opaque secret must not enter receipts"); } });
  const receipt = await a.execute("one", request); assert.equal(receipt.state, "unknown");
  assert.equal(JSON.stringify(receipt).includes("opaque secret"), false);
  await assert.rejects(f.adapter().execute("one", randomUUID()), /unconfirmed/); assert.equal(f.calls(), 0);
});
test("pre-cancelled admission creates no receipt or grant call", async t => {
  const f = await fixture(t), a = f.adapter(), abort = new AbortController(); abort.abort();
  await assert.rejects(a.execute("one", randomUUID(), abort.signal), /before admission/); assert.equal(a.list().length, 0); assert.equal(f.authorized(), 0);
});
test("another Workspace/resource generation cannot borrow a command or environment grant", async t => {
  const f = await fixture(t), normal = f.options.authorize;
  const receipt = await f.adapter({ authorize(review) { return { ...normal(review), resourceBinding: { ...review.resourceBinding, generation: randomUUID() } }; } }).execute("one", randomUUID());
  assert.equal(receipt.state, "blocked"); assert.equal(f.calls(), 0);
  const other = new WorkspaceResourceStorage(f.home, { ...f.scope, workspaceId: `ws_${randomUUID()}` }); other.initialize();
  const adapter = new WorkspaceLegacyCommands(other, f.features, f.folders, f.options);
  assert.throws(() => adapter.execute("one", randomUUID()), /unavailable/); assert.equal(adapter.list().length, 0);
});
test("a newer disabled or quarantined source cannot execute, even if an old plan was valid", async t => {
  const f = await fixture(t); f.features.setScheduleEnabled("one", false, f.features.list().revision);
  assert.throws(() => f.adapter().execute("one", randomUUID()), /unavailable/); assert.equal(f.calls(), 0);
  const unsafe = await fixture(t, { task: "command --api-key fake-never-copy", enabled: false });
  assert.throws(() => unsafe.adapter().execute("one", randomUUID()), /unavailable/); assert.equal(unsafe.calls(), 0);
});
test("asynchronous/invalid grant lookup cannot leave a waiting approval or start a late command", async t => {
  const f = await fixture(t), normal = f.options.authorize;
  const asyncGrant = await f.adapter({ authorize: async () => { throw new Error("fixture denied vault"); } }).execute("one", randomUUID());
  assert.equal(asyncGrant.state, "blocked"); assert.equal(f.calls(), 0);
  for (const patch of [{ searchPath: ".:/usr/bin" }, { isolatedHome: "/" }, { assertCurrent() { return true; } }, { feishu: { appId: "fixture", appSecret: "short", domain: "feishu" } }]) {
    assert.equal((await f.adapter({ authorize(review) { return { ...normal(review), ...patch }; } }).execute("one", randomUUID())).state, "blocked");
  }
  assert.equal(f.calls(), 0); assert.equal(f.resources.agents.list().agents.length, 1);
});
test("command argv and only the task's scoped environment reach the Host; ambient pools are absent", async t => {
  const f = await fixture(t), normal = f.options.authorize;
  const receipt = await f.adapter({ authorize(review) { return { ...normal(review), feishu: { appId: "cli_fixture", appSecret: "fixture-opaque-secret", domain: "feishu" } }; },
    async launch(input) {
      assert.equal(input.cwd, f.cwd); assert.equal(input.command, "printf fixture"); assert.equal(input.env.HOME, f.isolatedHome);
      assert.equal(input.env.USERPROFILE, f.isolatedHome); assert.equal(input.env.PATH, "/usr/bin:/bin"); assert.equal(input.env.TZ, "Asia/Shanghai");
      assert.equal(input.env.HARA_FEISHU_APP_SECRET, "fixture-opaque-secret");
      for (const name of ["OPENAI_API_KEY", "ANTHROPIC_AUTH_TOKEN", "NODE_OPTIONS", "BASH_ENV", "ENV", "HARA_SUBPROCESS_ENV_ALLOW", "SSH_AUTH_SOCK", "HARA_WORKSPACE_HOST_HOME"]) assert.equal(input.env[name], undefined);
      assert.equal(Object.isFrozen(input.env), true); input.onOutput("stdout", input.env.HARA_FEISHU_APP_SECRET.slice(0, 8));
      input.onOutput("stdout", input.env.HARA_FEISHU_APP_SECRET.slice(8) + "\n"); return { code: 0, terminated: true };
    } }).execute("one", randomUUID());
  assert.equal(receipt.state, "completed"); assert.equal(receipt.output.includes("fixture-opaque-secret"), false); assert.match(receipt.output, /\*\*\*/);
  assert.equal(fs.readdirSync(f.isolatedHome).length, 0);
});
test("an edited Host grant cannot redirect a deferred launch to another cwd/environment", async t => {
  const f = await fixture(t), normal = f.options.authorize; let original;
  const receipt = await f.adapter({ authorize(review) {
    original = { ...normal(review), feishu: { appId: "cli_fixture", appSecret: "fixture-original-secret", domain: "feishu" } };
    queueMicrotask(() => { original.cwd = "/not-the-approved-mount"; original.feishu.appSecret = "fixture-foreign-secret"; }); return original;
  }, async launch(i) {
    assert.equal(i.cwd, f.cwd); assert.equal(i.env.HARA_FEISHU_APP_SECRET, "fixture-original-secret"); return { code: 0, terminated: true };
  } }).execute("one", randomUUID());
  assert.equal(receipt.state, "completed"); assert.equal(original.cwd, "/not-the-approved-mount");
});
test("nonzero exit, bounded output and overlong lines remain distinct from successful completion", async t => {
  const f = await fixture(t);
  const failed = await f.adapter({ async launch(i) { i.onOutput("stderr", "fixture failed\n"); return { code: 17, terminated: true }; } }).execute("one", randomUUID());
  assert.equal(failed.state, "failed"); assert.equal(failed.code, 17); assert.equal(failed.reason, "command_failed");
  const clipped = await f.adapter({ async launch(i) { for (let n = 0; n < 20; n++) i.onOutput("stdout", "f".repeat(600) + "\n"); i.onOutput("stderr", "x".repeat(10000)); return { code: 0, terminated: true }; } }).execute("one", randomUUID());
  assert.equal(clipped.output.length, 8000); assert.equal(clipped.truncated, true); assert.equal(clipped.output.includes("x".repeat(100)), false);
  const longLine = await f.adapter({ async launch(i) { i.onOutput("stdout", "x".repeat(10000)); return { code: 0, terminated: true }; } }).execute("one", randomUUID());
  assert.equal(longLine.truncated, true); assert.match(longLine.output, /output line omitted/);
  const overflow = await f.adapter({ async launch(i) { for (let n = 0; n < 400; n++) i.onOutput("stdout", "f".repeat(1000) + "\n"); return { code: null, terminated: true }; } }).execute("one", randomUUID());
  assert.equal(overflow.state, "failed"); assert.equal(overflow.reason, "command_output_limit"); assert(overflow.output.length <= 8000);
});
test("timeout/cancellation need positive tree-termination confirmation; ignoring abort becomes unknown", async t => {
  const f = await fixture(t), cooperative = input => new Promise(resolve => input.signal.addEventListener("abort", () => resolve({ code: null, terminated: true }), { once: true }));
  const timed = await f.adapter({ timeoutMs: 25, terminationGraceMs: 25, launch: cooperative }).execute("one", randomUUID());
  assert.equal(timed.state, "timed_out"); assert.equal(timed.reason, "command_timed_out");
  const abort = new AbortController(), cancel = f.adapter({ launch(input) { queueMicrotask(() => abort.abort()); return cooperative(input); } });
  assert.equal((await cancel.execute("one", randomUUID(), abort.signal)).state, "cancelled");
  const unknown = await f.adapter({ timeoutMs: 25, terminationGraceMs: 25, launch: () => new Promise(() => {}) }).execute("one", randomUUID());
  assert.equal(unknown.state, "unknown"); assert.equal(unknown.reason, "execution_outcome_unconfirmed");
  await assert.rejects(f.adapter().execute("one", randomUUID()), /unconfirmed/);
});
test("scope/grant revocation while executing is unknown and is never retried", async t => {
  const f = await fixture(t), normal = f.options.authorize; let revoked = false;
  const receipt = await f.adapter({ authorize(review) { return { ...normal(review), assertCurrent() { if (revoked) throw new Error("fixture revoke"); } }; },
    launch(input) { revoked = true; return new Promise(resolve => input.signal.addEventListener("abort", () => resolve({ code: 0, terminated: true }), { once: true })); } }).execute("one", randomUUID());
  assert.equal(receipt.state, "unknown"); assert.equal(receipt.reason, "authority_changed"); assert.equal(receipt.code, null);
  await assert.rejects(f.adapter().execute("one", randomUUID()), /unconfirmed/);
});
test("hara CLI and structured send/alert tasks stay blocked until their separate adapters exist", async t => {
  for (const patch of [{ task: "true;hara org fixture" }, { task: "/old/private/bin/hara send fixture" }, { task: "$(hara status)" }, { deliver: "feishu:fixture-target" }, { alertAfter: 3 }]) {
    const f = await fixture(t, patch), receipt = await f.adapter().execute("one", randomUUID());
    assert.equal(receipt.state, "blocked"); assert.equal(f.calls(), 0); assert.equal(f.authorized(), 0);
    assert.equal(receipt.reason, patch.task ? "hara_cli_adapter_pending" : "notification_adapter_pending");
  }
});
test("a durable running claim survives a separately constructed adapter without launching twice", async t => {
  const f = await fixture(t), request = randomUUID(); let finish;
  const a = f.adapter({ launch() { return new Promise(resolve => { finish = resolve; }); } }), pending = a.execute("one", request);
  await new Promise(resolve => setImmediate(resolve)); const restarted = f.adapter(), receipt = await restarted.execute("one", request);
  assert.equal(receipt.state, "unknown"); assert.equal(restarted.list()[0].state, "unknown"); assert.equal(f.calls(), 0);
  await assert.rejects(restarted.execute("one", randomUUID()), /unconfirmed/); finish({ code: 0, terminated: true }); await pending;
});
test("full receipt retention fails closed rather than forgetting old dedupe identities", async t => {
  const f = await fixture(t), a = f.adapter(), request = randomUUID(), first = await a.execute("one", request);
  const file = f.storage.run(() => join(workspaceStateHome(), ".hara/workspace-legacy-command-runs-v1.json"));
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  state.runs = [first, ...Array.from({ length: 255 }, () => ({ ...first, requestId: randomUUID(), runId: randomUUID() }))];
  fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
  await assert.rejects(f.adapter().execute("one", randomUUID()), /capacity/); assert.deepEqual(await f.adapter().execute("one", request), first);
  assert.equal(f.calls(), 1); assert.equal(f.adapter().list().length, 256);
});
test("a harmless real fixture command uses non-login shell/private HOME and preserves exit code", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t, { task: "printf 'safe fixture\\n'; printf 'stderr fixture\\n' >&2; exit 7" });
  const receipt = await f.adapter({ launch: fixtureProcess }).execute("one", randomUUID());
  assert.equal(receipt.state, "failed"); assert.equal(receipt.code, 7); assert.match(receipt.output, /safe fixture/); assert.match(receipt.output, /stderr fixture/);
  assert.equal(fs.readdirSync(f.isolatedHome).length, 0);
});
test("a synthetic running fixture process is killed on cancellation, not replayed", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t, { task: "printf 'fixture started\\n'; while :; do sleep 1; done" }), abort = new AbortController();
  const launched = input => fixtureProcess({ ...input, onOutput(stream, chunk) { input.onOutput(stream, chunk); abort.abort(); } });
  const receipt = await f.adapter({ launch: launched }).execute("one", randomUUID(), abort.signal);
  assert.equal(receipt.state, "cancelled"); assert.equal(receipt.reason, "command_cancelled");
});
