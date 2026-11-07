import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, dirname } from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { startLocalWorkspaceServe } from "../dist/serve/local-workspace.js";
import { WorkspaceResourceStorage } from "../dist/workspace/resource-context.js";
import { WorkspaceRuntimeInstaller } from "../dist/workspace/runtime-install.js";
import { WorkspaceRuntimeModels } from "../dist/workspace/runtime-models.js";
import { MemoryCredentialVault } from "../dist/workspace/credential-vault.js";
import { SYNTHETIC_CONNECTION } from "../dist/workspace/synthetic-provider.js";
import { runExternalCommandCapture } from "../dist/external-sessions/process.js";
import { registeredCliArgs } from "../dist/agent-runtime/registered-cli.js";
import { writeFakeCodex } from "./helpers/workspace-cli-mcp.mjs";

const roots = [];
after(() => roots.forEach(root => fs.rmSync(root, { recursive: true, force: true })));
function root() { const value = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "hara-login-effort-"))); roots.push(value); return value; }

/** Codex fixture: `app-server model/list` publishes reasoning capability, `debug models` never does. */
function binary(path) {
  fs.mkdirSync(dirname(path), { recursive: true });
  fs.writeFileSync(path, `#!/bin/sh
if [ "$1" = "--version" ]; then echo 'codex 1.2.3'; exit 0; fi
if [ "$1" = "--help" ]; then printf '  --effort <level>  Effort level (low, medium, high, xhigh, max)\\n'; exit 0; fi
printf '%s\\n' "$*" >> '${path}.calls'
if [ "$1" = "app-server" ]; then
  while IFS= read -r line; do
    case "$line" in
      *'"id":1,'*) echo '{"id":1,"result":{}}' ;;
      *'"id":2,'*)
        printf '{"id":2,"result":'; cat '${path}.appmodels'; printf '}\\n' ;;
    esac
  done
  exit 0
fi
if [ "$1" = "debug" ] && [ "$2" = "models" ]; then
  if [ -f '${path}.debugfail' ]; then exit 1; fi
  cat '${path}.models'; exit 0
fi
if [ "$1" = "exec" ]; then
  printf '%s\\n' "$@" > '${path}.argv'
  printf '%s\\n' "$HOME" > '${path}.home'
  printf '%s\\n' "\${CODEX_HOME-unset}" > '${path}.codexhome'
  if [ -f "$HOME/.codex/auth.json" ]; then echo 'login=present' >> '${path}.home'; else echo 'login=missing' >> '${path}.home'; fi
  echo 'exec reply'; exit 0
fi
exit 1
`, { mode: 0o755 });
  fs.writeFileSync(`${path}.appmodels`, JSON.stringify({ data: [
    { id: "gpt-5.6-sol", displayName: "GPT 5.6 Sol", isDefault: true,
      supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }, { reasoningEffort: "xhigh" }],
      defaultReasoningEffort: "medium" },
    { id: "plain-model", displayName: "Plain Model" },
  ] }));
  fs.writeFileSync(`${path}.models`, JSON.stringify({ models: [
    { slug: "gpt-5.6-sol", display_name: "GPT 5.6 Sol", isDefault: true },
    { slug: "plain-model", display_name: "Plain Model" },
  ] }));
}

async function fixture(loginSource) {
  const data = root(), host = root(), command = join(host, ".local/bin/codex"); binary(command);
  // The host's own Codex state must be readable in host mode but never copied by Hara.
  fs.mkdirSync(join(host, ".codex"), { mode: 0o700, recursive: true });
  fs.writeFileSync(join(host, ".codex", "auth.json"), '{"host":"credential"}');
  fs.writeFileSync(join(host, ".codex", "models_cache.json"), JSON.stringify({ models: [{ slug: "host-cached", display_name: "Host Cached" }] }));
  fs.mkdirSync(join(data, "home"), { recursive: true });
  const storage = new WorkspaceResourceStorage(join(data, "home"), { schemaVersion: 1, workspaceId: `ws_${randomUUID()}`,
    authority: { kind: "local", localAuthorityId: randomUUID() } });
  storage.initialize();
  const runtimes = new WorkspaceRuntimeInstaller(storage, { accountHome: () => host, discovery: { home: host, path: "/usr/bin:/bin", systemBins: [],
    run: async (_command, args) => args[0] === "-lic" ? null : "codex 1.2.3" } });
  await runtimes.discover();
  const detected = runtimes.list().options.find(row => row.runtimeId === "codex");
  runtimes.registerLocal("codex", detected.fingerprint, loginSource);
  const models = new WorkspaceRuntimeModels(storage, runtimes);
  return { data, host, command, storage, runtimes, models };
}

test("a new binding reuses the account login without copied credentials", async () => {
  const f = await fixture("host");
  try {
    const resolved = f.runtimes.resolveBound("codex");
    assert.equal(resolved.loginSource, "host");
    // The engine's process HOME is not the account home (Desktop sets it to the private data home);
    // host mode must launch with the operator-supplied OS-account home instead.
    assert.notEqual(process.env.HOME, f.host, "fixture keeps the engine HOME distinct from the account home");
    assert.equal(resolved.env.HOME, f.host, "host mode launches with the OS-account home");
    assert.equal(resolved.env.USERPROFILE, f.host);
    assert.equal(resolved.env.CODEX_HOME, undefined);
    assert.equal(resolved.env.CLAUDE_CONFIG_DIR, undefined);
    assert.equal(f.runtimes.list().options.find(row => row.runtimeId === "codex").loginSource, "host");
    assert.match(f.runtimes.hostCodexModelCache(), /host-cached/, "the account's ~/.codex cache is read without inherited overrides");
    // Live model/list wins, and it carries the reasoning capability Hara needs for the effort picker.
    const listed = await f.models.list("codex");
    assert.deepEqual(listed.models[0].supportedReasoningEfforts, ["low", "medium", "high", "xhigh"]);
    assert.equal(listed.models[0].defaultReasoningEffort, "medium");
    assert.equal(listed.models[1].supportedReasoningEfforts, undefined, "a model without published levels stays unknown");
    // No private mirror of the host's cache or credential is created.
    const home = join(f.data, "home", ".hara");
    const runtimeHomes = fs.existsSync(join(home, "runtime-homes")) ? fs.readdirSync(join(home, "runtime-homes")) : [];
    assert.deepEqual(runtimeHomes.filter(name => name === "codex"), [], "host mode creates no private runtime home");
    assert.throws(() => f.runtimes.codexLoginInstructions(), /reuses the host login/);
  } finally { await f.runtimes.close(); }
});

test("isolated mode keeps the private home, reads only that cache, and keeps re-login guidance", async () => {
  const f = await fixture("isolated");
  try {
    const resolved = f.runtimes.resolveBound("codex");
    assert.equal(resolved.loginSource, "isolated");
    assert.ok(resolved.env.HOME.startsWith(join(f.data, "home")), "isolated mode owns HOME");
    assert.ok(resolved.env.CODEX_HOME.startsWith(join(f.data, "home")), "isolated mode owns CODEX_HOME");
    const guide = f.runtimes.codexLoginInstructions();
    assert.ok(guide.command.includes(resolved.env.CODEX_HOME));
    // Live inventory still succeeds; the host cache is never consulted.
    const listed = await f.models.list("codex");
    assert.equal(listed.models[0].id, "gpt-5.6-sol");
    const cache = join(resolved.env.CODEX_HOME, "models_cache.json");
    assert.ok(fs.existsSync(cache), "isolated mode warms its own cache");
    assert(!fs.readFileSync(cache, "utf8").includes("host-cached"));
    assert.equal(f.runtimes.hostCodexModelCache(), null, "the host cache is unreadable in isolated mode");
  } finally { await f.runtimes.close(); }
});

test("legacy state files without a login record stay isolated and are never silently widened", async () => {
  const f = await fixture("isolated");
  try {
    const files = fs.readdirSync(join(f.data, "home"), { recursive: true })
      .filter(name => name.endsWith("runtime-local-v1.json")).map(name => join(f.data, "home", name));
    assert.equal(files.length, 1);
    const legacy = JSON.parse(fs.readFileSync(files[0], "utf8"));
    delete legacy.loginSources;
    fs.writeFileSync(files[0], JSON.stringify(legacy));
    const reopened = new WorkspaceRuntimeInstaller(f.storage, { accountHome: () => f.host, discovery: { home: f.host, path: "/usr/bin:/bin", systemBins: [] } });
    assert.equal(reopened.loginSource("codex"), "isolated", "a missing field means isolated");
    assert.ok(reopened.resolveBound("codex").env.HOME.startsWith(join(f.data, "home")));
    // Present-but-null is damaged, not a legacy missing field.
    fs.writeFileSync(files[0], JSON.stringify({ ...legacy, loginSources: null }));
    assert.throws(() => reopened.list(), /unavailable or unsafe/);
    // A damaged record fails closed instead of being dropped.
    fs.writeFileSync(files[0], JSON.stringify({ ...legacy, loginSources: [{ runtimeId: "codex", source: "everyone", confirmedAt: new Date().toISOString() }] }));
    assert.throws(() => reopened.list(), /unavailable or unsafe/);
    await reopened.close();
  } finally { await f.runtimes.close(); }
});

test("switching an existing binding to the host login is an explicit, recorded operation", async () => {
  const f = await fixture("isolated");
  try {
    assert.equal(f.runtimes.loginSource("codex"), "isolated");
    assert.equal(f.runtimes.setLoginSource("codex", "host"), "host");
    assert.equal(f.runtimes.loginSource("codex"), "host");
    assert.equal(f.runtimes.resolveBound("codex").env.HOME, f.host);
    assert.equal(f.runtimes.setLoginSource("codex", "isolated"), "isolated");
    assert.ok(f.runtimes.resolveBound("codex").env.HOME.startsWith(join(f.data, "home")));
    assert.throws(() => f.runtimes.setLoginSource("codex", "sideload"), /Invalid runtime login source/);
    assert.throws(() => f.runtimes.setLoginSource("opencode", "host"), /unavailable or unsafe/);
  } finally { await f.runtimes.close(); }
});

test("Desktop-shaped engine: host mode escapes the private data HOME and never reads it as the login", async () => {
  // Reproduces the installed app: `workspace serve` runs with HOME=<root>/home (env_clear + private data
  // home) and HARA_WORKSPACE_DISCOVERY_HOME=<OS account home>. Before the fix, host mode inherited the
  // private HOME, Codex found no auth.json there, and the user was asked to sign in again.
  const f = await fixture("host");
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CODEX_HOME: process.env.CODEX_HOME,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  const privateDataHome = join(f.data, "home");
  try {
    process.env.HOME = privateDataHome; process.env.USERPROFILE = privateDataHome;
    process.env.CODEX_HOME = join(privateDataHome, ".codex");
    process.env.CLAUDE_CONFIG_DIR = join(privateDataHome, ".claude");
    const resolved = f.runtimes.resolveBound("codex");
    assert.equal(resolved.loginSource, "host");
    assert.equal(resolved.env.HOME, f.host, "the CLI sees the account home, not the engine's private HOME");
    assert.equal(resolved.env.USERPROFILE, f.host);
    assert.equal(resolved.env.CODEX_HOME, undefined, "private CODEX_HOME is removed");
    assert.equal(resolved.env.CLAUDE_CONFIG_DIR, undefined, "private Claude config override is removed");
    assert.ok(fs.existsSync(join(resolved.env.HOME, ".codex", "auth.json")), "the existing host login is where Codex will look");
    assert.match(f.runtimes.hostCodexModelCache(), /host-cached/);
    const wrongDiscovery = new WorkspaceRuntimeInstaller(f.storage, { accountHome: () => f.host,
      discovery: { home: privateDataHome, path: "/usr/bin:/bin", systemBins: [] } });
    assert.equal(wrongDiscovery.resolveBound("codex").env.HOME, f.host, "discovery home cannot redirect host login");
    assert.match(wrongDiscovery.hostCodexModelCache(), /host-cached/);
    await wrongDiscovery.close();
    // Spawn through the same launcher and bounded argv the registered-CLI driver uses.
    const launched = await runExternalCommandCapture({ command: resolved.command, env: resolved.env },
      registeredCliArgs({ id: "codex", prompt: "hi", cwd: f.host, model: null, effort: null, skipGitRepoCheck: true }),
      { cwd: f.host, failureKind: "registered-cli", timeoutMs: 10_000 });
    assert.equal(launched.ok, true);
    assert.deepEqual(fs.readFileSync(`${f.command}.home`, "utf8").trim().split("\n"), [f.host, "login=present"],
      "the spawned CLI runs in the account home and finds the existing login");
    assert.ok(!fs.existsSync(join(privateDataHome, ".codex")), "nothing is copied or linked into the private data home");
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await f.runtimes.close();
  }
});

test("host mode uses the OS account home even when discovery is absent and process HOME is private", async () => {
  const f = await fixture("host");
  const previousHome = process.env.HOME;
  try {
    process.env.HOME = join(f.data, "home");
    const bare = new WorkspaceRuntimeInstaller(f.storage, {});
    assert.equal(bare.loginSource("codex"), "host");
    assert.equal(bare.resolveBound("codex").env.HOME, userInfo().homedir);
    await bare.close();
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    await f.runtimes.close();
  }
});

test("a legacy isolated registration can switch to host after restart without discovery", async () => {
  const f = await fixture("isolated");
  try {
    const registered = f.runtimes.list().options.find(row => row.runtimeId === "codex");
    const reopened = new WorkspaceRuntimeInstaller(f.storage, { accountHome: () => f.host, discovery: { home: f.host, path: "/usr/bin:/bin", systemBins: [] } });
    assert.equal(reopened.loginSource("codex"), "isolated");
    reopened.registerLocal("codex", registered.fingerprint, "host");
    assert.equal(reopened.resolveBound("codex").loginSource, "host");
    await reopened.close();
  } finally { await f.runtimes.close(); }
});

test("effort selection accepts only a level the model published and persists it", async () => {
  const f = await fixture("host");
  try {
    // The live inventory is available through the fixture's app-server, so a published level is accepted.
    await f.models.select("codex", "gpt-5.6-sol", 0, "high");
    const listed = await f.models.list("codex");
    assert.equal(listed.selectedModelId, "gpt-5.6-sol");
    assert.equal(listed.selectedEffort, "high");
    assert.equal(f.models.selectedEffort("codex"), "high");
    // Unknown level for a model that publishes levels.
    await assert.rejects(f.models.select("codex", "gpt-5.6-sol", 1, "ultra"), /Invalid runtime effort/);
    // A model with no published capability must refuse, not silently reset.
    await assert.rejects(f.models.select("codex", "plain-model", 1, "high"), /does not report reasoning effort/);
    // Switching model without effort clears the previous level instead of leaking it.
    await f.models.select("codex", "plain-model", 1);
    assert.equal(f.models.selectedEffort("codex"), null);
    // An explicit null clears it too.
    await f.models.select("codex", "gpt-5.6-sol", 2, "low");
    await f.models.select("codex", "gpt-5.6-sol", 3, null);
    assert.equal(f.models.selectedEffort("codex"), null);
  } finally { await f.runtimes.close(); }
});

for (const scenario of [
  { configured: "xhigh", message: "Reply with a short greeting.", actual: "xhigh", state: "blocked" },
  { configured: "auto", message: "hello", actual: "low", state: "completed" },
  { configured: null, message: "Investigate failing tests", actual: "medium", state: "blocked" },
]) test(`main-bot native wire freezes ${scenario.configured ?? "unset"} as ${scenario.actual}`, async () => {
  const data = root(), host = root(), command = join(host, ".codex/tmp/bin/codex"); binary(command);
  writeFakeCodex(command, { mode: "reply", recordHome: true, inventory: JSON.parse(fs.readFileSync(`${command}.appmodels`, "utf8")) });
  fs.mkdirSync(join(host, ".codex"), { recursive: true });
  fs.writeFileSync(join(host, ".codex", "auth.json"), '{"fixture":true}');
  const handle = await startLocalWorkspaceServe({ host: "127.0.0.1", port: 0 }, { root: data, mode: "workspace", version: "fixture", credentialVault: new MemoryCredentialVault(),
    runtimeInstallerOptions: { accountHome: () => host, discovery: { home: host, path: dirname(command) + ":/usr/bin:/bin", systemBins: [],
      run: async (_command, args) => args[0] === "-lic" ? null : "codex 1.2.3" } } });
  const socket = new WebSocket(`ws://127.0.0.1:${handle.port}`); await once(socket, "open"); let nextId = 0;
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId, timer = setTimeout(() => reject(new Error("RPC timeout")), 5000);
    function receive(raw) { const response = JSON.parse(String(raw)); if (response.id !== id) return;
      clearTimeout(timer); socket.off("message", receive); response.error ? reject(new Error(response.error.message)) : resolve(response.result); }
    socket.on("message", receive); socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
  try {
    const init = await request("initialize", { token: handle.token });
    assert(init.capabilities.includes("workspace.runtime-login-effort.v1"));
    const workspace = await request("workspace.create", { label: "Main", expectedRevision: init.workspace.revision });
    const scope = { workspaceId: workspace.workspaceId, expectedGeneration: workspace.resourceGeneration };
    await request("workspace.connection.add", { ...scope, input: { ...SYNTHETIC_CONNECTION }, expectedRevision: 0 });
    const catalog = await request("workspace.list");
    await request("workspace.select", { workspaceId: scope.workspaceId, expectedRevision: catalog.revision });
    const snapshot = await request("workspace.snapshot", { workspaceId: scope.workspaceId, agentId: null });
    const main = snapshot.agents.find(agent => agent.kind === "main");
    assert(main, "the Workspace has a main Hara agent");
    const detected = await request("workspace.runtime.detect", scope);
    const codex = detected.options.find(row => row.runtimeId === "codex");
    assert.equal(codex.state, "detected");
    // No loginSource field means the new-binding default: reuse the host login.
    await request("workspace.runtime.registerLocal", { ...scope, runtimeId: "codex", fingerprint: codex.fingerprint, approved: true });
    const runtimes = (await request("workspace.snapshot", { workspaceId: scope.workspaceId, agentId: null })).runtimes;
    assert.equal(runtimes.options.find(row => row.runtimeId === "codex").loginSource, "host");
    const bound = await request("workspace.agents.setRuntime", { ...scope, agentId: main.agentId, runtimeId: "codex",
      configRevision: main.configRevision, agentEpoch: main.agentEpoch });
    assert.equal(bound.runtime.id, "codex", "the main bot can bind a runtime exactly like a colleague");
    const listed = await request("workspace.runtime.listModels", { ...scope, runtimeId: "codex" });
    assert.deepEqual(listed.models[0].supportedReasoningEfforts, ["low", "medium", "high", "xhigh"]);
    assert.deepEqual(await request("workspace.runtime.selectModel", { ...scope, runtimeId: "codex", modelId: "plain-model", expectedRevision: 0 }), { selected: true });
    await assert.rejects(request("workspace.runtime.selectModel", { ...scope, runtimeId: "codex", modelId: "plain-model", expectedRevision: 1, effort: "high" }), /does not report reasoning effort/);
    await assert.rejects(request("workspace.runtime.selectModel", { ...scope, runtimeId: "codex", modelId: "gpt-5.6-sol", expectedRevision: 1, effort: "../../x" }), /Invalid runtime effort/);
    await request("workspace.runtime.selectModel", { ...scope, runtimeId: "codex", modelId: "gpt-5.6-sol", expectedRevision: 1, effort: "xhigh" });
    const chosen = await request("workspace.runtime.listModels", { ...scope, runtimeId: "codex" });
    assert.equal(chosen.selectedModelId, "gpt-5.6-sol");
    assert.equal(chosen.selectedEffort, "xhigh");
    // Registering with an unknown login source is refused.
    await assert.rejects(request("workspace.runtime.registerLocal", { ...scope, runtimeId: "codex", fingerprint: codex.fingerprint, approved: true, loginSource: "ambient" }), /Invalid runtime login source/);
    await assert.rejects(request("workspace.runtime.registerLocal", { ...scope, runtimeId: "codex", fingerprint: codex.fingerprint, approved: false }), /Explicit local runtime approval/);
    if (scenario.configured !== "xhigh") await request("workspace.runtime.selectModel", { ...scope, runtimeId: "codex",
      modelId: "gpt-5.6-sol", expectedRevision: 2, effort: scenario.configured });
    // Exercise main-bot RPC -> local-host -> governed runtime -> registered native app-server.
    const accepted = await request("workspace.session.send", { ...scope, agentId: main.agentId,
      message: scenario.message, requestId: randomUUID(), source: "ui" });
    assert.equal(typeof accepted.runId, "string");
    let finished;
    for (let attempt = 0; attempt < 100; attempt++) {
      const current = await request("workspace.snapshot", { workspaceId: scope.workspaceId, agentId: main.agentId });
      if (["completed", "blocked"].includes(current.conversation.state)) { finished = current; break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(finished?.conversation.state, scenario.state);
    const stage = finished.conversation.runtimeStages.at(-1);
    assert.equal(stage.runtime.effort, scenario.actual, "hidden timing details report the actual native effort");
    assert.equal((await request("workspace.runtime.listModels", { ...scope, runtimeId: "codex" })).selectedEffort, scenario.configured);
    assert.deepEqual(fs.readFileSync(`${command}.home`, "utf8").trim().split("\n"), [host, "login=present"]);
    assert.equal(fs.readFileSync(`${command}.codexhome`, "utf8").trim(), "unset");
    const requests = fs.readFileSync(`${command}.rpc.jsonl`, "utf8").trim().split("\n").map(line => JSON.parse(line));
    const thread = requests.find(row => row.method === "thread/start"), turn = requests.find(row => row.method === "turn/start");
    assert.equal(thread.params.model, "gpt-5.6-sol", "selected model reaches the native thread");
    assert.equal(thread.params.config.model_reasoning_effort, scenario.actual, "selected effort reaches the native thread");
    assert.equal(turn.params.model, "gpt-5.6-sol"); assert.equal(turn.params.effort, scenario.actual);
    assert.equal(thread.params.sandbox, "danger-full-access"); assert.equal(thread.params.approvalPolicy, "never");
  } finally { const closed = once(socket, "close"); socket.close(); await closed; await handle.close(); }
});
