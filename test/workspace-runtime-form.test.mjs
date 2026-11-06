import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { startLocalWorkspaceServe } from "../dist/serve/local-workspace.js";
import { WorkspaceResourceStorage } from "../dist/workspace/resource-context.js";
import { WorkspaceRuntimeInstaller } from "../dist/workspace/runtime-install.js";
import { WorkspaceRuntimeModels, ENGINE_DEFAULT_EFFORT } from "../dist/workspace/runtime-models.js";
import { detectInstalledRuntimes } from "../dist/workspace/runtime-detect.js";
import { launchableSavedEffort } from "../dist/workspace/default-effort.js";
import { AgentRuntimeRegistry } from "../dist/agent-runtime/registry.js";
import { MemoryCredentialVault } from "../dist/workspace/credential-vault.js";
import { SYNTHETIC_CONNECTION } from "../dist/workspace/synthetic-provider.js";
import { writeFakeCodex } from "./helpers/workspace-cli-mcp.mjs";

const roots = [];
after(() => roots.forEach(root => fs.rmSync(root, { recursive: true, force: true })));
function root() { const value = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "hara-runtime-form-"))); roots.push(value); return value; }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function exe(path, body = "#!/bin/sh\nexit 0\n") { fs.mkdirSync(dirname(path), { recursive: true }); fs.writeFileSync(path, body, { mode: 0o755 }); }
async function until(check, ms = 4000) {
  const deadline = Date.now() + ms;
  for (;;) { const value = check(); if (value) return value; if (Date.now() > deadline) return value; await sleep(25); }
}
const HELP = "Usage: claude [options]\n  --effort <level>  Effort level for the session (low, medium, high, max)\n";

function installerFixture() {
  const data = root(), account = root(), probe = root();
  const codex = join(account, ".local/bin/codex"), claude = join(account, ".local/bin/claude");
  exe(codex, "#!/bin/sh\necho codex\n"); exe(claude, "#!/bin/sh\necho claude\n");
  fs.mkdirSync(join(data, "home"), { recursive: true });
  const storage = new WorkspaceResourceStorage(join(data, "home"), { schemaVersion: 1, workspaceId: `ws_${randomUUID()}`,
    authority: { kind: "local", localAuthorityId: randomUUID() } });
  storage.initialize();
  const calls = [];
  const run = async (command, args, env) => {
    calls.push({ command, args, home: env.HOME, claudeConfig: env.CLAUDE_CONFIG_DIR, codexHome: env.CODEX_HOME });
    if (args[0] === "-lic") return null;
    if (args[0] === "--version") return command.endsWith("/claude") ? "2.3.1 (Claude Code)" : "codex-cli 0.163.0";
    if (args[0] === "--help") return HELP;
    return null;
  };
  const make = () => new WorkspaceRuntimeInstaller(storage, { accountHome: () => account,
    discovery: { home: account, probeHome: probe, path: "/usr/bin:/bin", systemBins: [], run } });
  return { data, account, probe, codex, claude, storage, calls, make };
}
const option = (runtimes, id) => runtimes.list().options.find(row => row.runtimeId === id);

test("a slow engine keeps the finished engines and is reported unfinished, not absent", async () => {
  const home = root();
  const codex = join(home, ".local/bin/codex"), slow = join(home, ".local/bin/claude"), second = join(home, ".nvm/versions/node/v22.0.0/bin/claude");
  exe(codex); exe(slow); exe(second);
  const run = async (command, args) => {
    if (args[0] === "-lic") return null;
    if (command === slow) { await sleep(1300); return null; }
    return command === codex ? "codex-cli 0.163.0" : null;
  };
  const incomplete = [];
  const found = await detectInstalledRuntimes({ home, path: "/usr/bin:/bin", systemBins: [], run,
    partial: { roundMs: 1000, onIncomplete: id => incomplete.push(id) } });
  assert.deepEqual(found.map(row => row.runtimeId), ["codex"]);
  assert.deepEqual(incomplete, ["claude"], "the unfinished engine is named, the finished one kept");
});

test("engine states: first use, ready, updated in place, unsafe and removed", async () => {
  const f = installerFixture(), runtimes = f.make();
  try {
    assert.equal(option(runtimes, "codex").use, "detecting", "before the first round nothing is called missing");
    await runtimes.discover();
    assert.equal(runtimes.list().detection.completedAt !== null, true);
    let codex = option(runtimes, "codex");
    assert.equal(codex.use, "confirm_first_use");
    assert.equal(option(runtimes, "gemini").use, "unavailable");
    assert.equal(option(runtimes, "gemini").unavailableReason, "not_installed");
    const registry = new AgentRuntimeRegistry(undefined, runtimes);
    let row = registry.options().find(value => value.id === "codex");
    assert.deepEqual([row.available, row.selectable, row.confirmation], [false, true, "first_use"], "selectable is not execution authority");
    assert.throws(() => registry.assertAvailable("codex"), /not available/);
    assert.deepEqual(registry.options().find(value => value.id === "pi").confirmation, "none");

    runtimes.registerLocal("codex", codex.fingerprint, "host");
    codex = option(runtimes, "codex");
    assert.equal(codex.use, "ready");
    row = registry.options().find(value => value.id === "codex");
    assert.deepEqual([row.available, row.selectable, row.confirmation], [true, true, "none"]);

    // An auto-update rewrites the same path. One automatic recheck offers it for confirmation;
    // until a person confirms, the new bytes are not executed.
    fs.appendFileSync(f.codex, "# 0.164.0\n");
    assert.equal(option(runtimes, "codex").use, "detecting");
    assert.equal(await until(() => option(runtimes, "codex").use === "confirm_update"), true);
    row = registry.options().find(value => value.id === "codex");
    assert.deepEqual([row.available, row.selectable, row.confirmation], [false, true, "update"]);
    assert.throws(() => runtimes.resolveBound("codex"), /unavailable or unsafe/);

    // A restart before detection says "checking", never "unsafe".
    const restarted = f.make();
    assert.equal(option(restarted, "codex").use, "detecting");
    await restarted.close();

    fs.chmodSync(f.codex, 0o777);
    await runtimes.discover();
    assert.deepEqual([option(runtimes, "codex").use, option(runtimes, "codex").unavailableReason], ["unavailable", "unsafe_file"]);
    fs.rmSync(f.codex);
    await runtimes.discover();
    assert.deepEqual([option(runtimes, "codex").use, option(runtimes, "codex").unavailableReason], ["unavailable", "not_installed"]);
  } finally { await runtimes.close(); }
});

test("an unconfirmed engine is only probed in the isolated environment; Codex lists nothing before confirmation", async () => {
  const f = installerFixture(), runtimes = f.make(), models = new WorkspaceRuntimeModels(f.storage, runtimes);
  try {
    await runtimes.discover();
    const claude = await models.formOptions("claude");
    assert.equal(claude.use, "confirm_first_use");
    assert.equal(claude.modelSource, "official");
    assert.equal(claude.defaultModelId, "sonnet");
    assert.deepEqual(claude.models.find(model => model.id === "opus").supportedReasoningEfforts, ["low", "medium", "high", "max"]);
    assert.equal(claude.effortSupported, true);
    const help = f.calls.filter(call => call.args[0] === "--help");
    assert.equal(help.length, 1);
    assert.equal(help[0].home, f.probe, "--help runs with the probe Home, not the account Home");
    assert.notEqual(help[0].home, f.account);
    assert.equal(help[0].claudeConfig, undefined); assert.equal(help[0].codexHome, undefined);

    const codex = await models.formOptions("codex");
    assert.deepEqual([codex.use, codex.modelSource, codex.models.length, codex.defaultModelId, codex.effortSupported],
      ["confirm_first_use", "engine_default", 0, null, false]);
    assert.ok(!f.calls.some(call => call.command === f.codex && call.args[0] !== "--version"), "no Codex app-server or model list before confirmation");

    const gemini = await models.formOptions("gemini");
    assert.deepEqual([gemini.use, gemini.unavailableReason, gemini.models.length], ["unavailable", "not_installed", 0]);
    // A replaced file between detection and --help yields no capability claims.
    fs.appendFileSync(f.claude, "# changed\n");
    const changed = await models.formOptions("claude");
    assert.ok(!changed.models.some(model => model.supportedReasoningEfforts), "no levels from a file that changed");
  } finally { await runtimes.close(); }
});

test("background detection is scheduled, reports a change, and is cancelled by close", async () => {
  const f = installerFixture();
  let changes = 0;
  const runtimes = new WorkspaceRuntimeInstaller(f.storage, { accountHome: () => f.account, onChange: () => { changes += 1; },
    discovery: { home: f.account, probeHome: f.probe, path: "/usr/bin:/bin", systemBins: [], run: async (command, args) => args[0] === "--version" ? "codex-cli 0.163.0" : null } });
  runtimes.scheduleDiscovery(10);
  assert.equal(await until(() => option(runtimes, "codex").use === "confirm_first_use"), true);
  assert.ok(changes >= 1);
  await runtimes.close();
  const idle = f.make(); idle.scheduleDiscovery(50); await idle.close(); await sleep(120);
  assert.equal(idle.list().detection.completedAt, null, "a closed installer never runs its scheduled round");
});

test("saved efforts reaching a launch without inventory: only a fixed level passes", () => {
  assert.equal(launchableSavedEffort(ENGINE_DEFAULT_EFFORT), null);
  assert.equal(launchableSavedEffort("auto"), null);
  assert.equal(launchableSavedEffort(null), null);
  assert.equal(launchableSavedEffort("high"), "high");
});

test("one Apply: validates before writing, confirms, switches, then saves the engine-default effort", async () => {
  const data = root(), host = root(), command = join(host, ".codex/tmp/bin/codex");
  const inventory = { data: [
    { id: "gpt-6.1-sol", displayName: "GPT 6.1 Sol", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }], defaultReasoningEffort: "medium" },
    { id: "plain-model", displayName: "Plain Model" }] };
  writeFakeCodex(command, { mode: "reply", recordHome: true, inventory });
  fs.mkdirSync(join(host, ".codex"), { recursive: true });
  fs.writeFileSync(join(host, ".codex", "auth.json"), '{"fixture":true}');
  const handle = await startLocalWorkspaceServe({ host: "127.0.0.1", port: 0 }, { root: data, mode: "workspace", version: "fixture", credentialVault: new MemoryCredentialVault(),
    runtimeInstallerOptions: { accountHome: () => host, discovery: { home: host, path: dirname(command) + ":/usr/bin:/bin", systemBins: [],
      run: async (_command, args) => args[0] === "-lic" ? null : "codex 1.2.3" } } });
  const socket = new WebSocket(`ws://127.0.0.1:${handle.port}`); await once(socket, "open"); let nextId = 0;
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId, timer = setTimeout(() => reject(new Error("RPC timeout")), 8000);
    function receive(raw) { const response = JSON.parse(String(raw)); if (response.id !== id) return;
      clearTimeout(timer); socket.off("message", receive); response.error ? reject(new Error(response.error.message)) : resolve(response.result); }
    socket.on("message", receive); socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
  try {
    const init = await request("initialize", { token: handle.token });
    assert(init.capabilities.includes("workspace.runtime-form.v1"));
    const workspace = await request("workspace.create", { label: "Main", expectedRevision: init.workspace.revision });
    const scope = { workspaceId: workspace.workspaceId, expectedGeneration: workspace.resourceGeneration };
    await request("workspace.connection.add", { ...scope, input: { ...SYNTHETIC_CONNECTION }, expectedRevision: 0 });
    const catalog = await request("workspace.list");
    await request("workspace.select", { workspaceId: scope.workspaceId, expectedRevision: catalog.revision });
    const snap = async () => request("workspace.snapshot", { workspaceId: scope.workspaceId, agentId: null });
    const main = (await snap()).agents.find(agent => agent.kind === "main");
    await request("workspace.runtime.detect", scope);
    const before = await request("workspace.runtime.formOptions", { ...scope, runtimeId: "codex", agentId: main.agentId });
    assert.deepEqual([before.use, before.modelSource, before.sharedWith.length], ["confirm_first_use", "engine_default", 0]);
    const form = { ...scope, agentId: main.agentId, runtimeId: "codex", configRevision: main.configRevision, agentEpoch: main.agentEpoch };
    const unchanged = async () => {
      const current = await snap();
      assert.equal(current.agents.find(agent => agent.agentId === main.agentId).runtime.id, main.runtime.id, "no runtime write");
      assert.equal(current.runtimes.options.find(row => row.runtimeId === "codex").registered, false, "no confirmation write");
    };
    await assert.rejects(request("workspace.agents.applyRuntimeForm", form), /runtime_confirmation_required/);
    await unchanged();
    await assert.rejects(request("workspace.agents.applyRuntimeForm", { ...form, confirm: { fingerprint: "0".repeat(64), loginSource: "host" } }), /Engine file changed/);
    await unchanged();
    await assert.rejects(request("workspace.agents.applyRuntimeForm", { ...form, configRevision: main.configRevision + 1,
      confirm: { fingerprint: before.fingerprint, loginSource: "host" } }), /changed; refresh/);
    await unchanged();
    await assert.rejects(request("workspace.agents.applyRuntimeForm", { ...form, confirm: { fingerprint: before.fingerprint, loginSource: "host" },
      model: { modelId: "plain-model", expectedRevision: 7 } }), /revision changed/);
    await unchanged();

    // Codex lists models only after confirmation, so an unknown model is caught after the first two steps.
    const partial = await request("workspace.agents.applyRuntimeForm", { ...form, confirm: { fingerprint: before.fingerprint, loginSource: "host" },
      model: { modelId: "not-listed", expectedRevision: 0 } });
    assert.deepEqual(partial.applied, ["confirm", "runtime"]);
    assert.equal(partial.failed.step, "model");
    assert.equal(partial.agent.runtime.id, "codex");
    assert.equal(partial.agent.runtime.available, true);

    const ready = await request("workspace.runtime.formOptions", { ...scope, runtimeId: "codex" });
    assert.deepEqual([ready.use, ready.modelSource, ready.defaultModelId], ["ready", "live", "gpt-6.1-sol"]);
    assert.deepEqual(ready.sharedWith.map(row => row.agentId), [main.agentId], "colleagues on the same engine share the setting");
    const agent = partial.agent;
    const saved = await request("workspace.agents.applyRuntimeForm", { ...scope, agentId: main.agentId, runtimeId: "codex",
      configRevision: agent.configRevision, agentEpoch: agent.agentEpoch, model: { modelId: "gpt-6.1-sol", expectedRevision: 0, effort: ENGINE_DEFAULT_EFFORT } });
    assert.deepEqual(saved.applied, ["model"], "unchanged engine is not rewritten");
    const listed = await request("workspace.runtime.listModels", { ...scope, runtimeId: "codex" });
    assert.deepEqual([listed.selectedModelId, listed.selectedEffort], ["gpt-6.1-sol", ENGINE_DEFAULT_EFFORT]);
    // A model without declared levels may still follow the engine default; a fixed level is refused.
    await assert.rejects(request("workspace.agents.applyRuntimeForm", { ...scope, agentId: main.agentId, runtimeId: "codex",
      configRevision: agent.configRevision, agentEpoch: agent.agentEpoch, model: { modelId: "plain-model", expectedRevision: 1, effort: "high" } }), /Invalid runtime effort/);

    const accepted = await request("workspace.session.send", { ...scope, agentId: main.agentId, message: "Investigate failing tests", requestId: randomUUID(), source: "ui" });
    assert.equal(typeof accepted.runId, "string");
    let finished;
    for (let attempt = 0; attempt < 100 && !finished; attempt++) {
      const current = await request("workspace.snapshot", { workspaceId: scope.workspaceId, agentId: main.agentId });
      if (["completed", "blocked"].includes(current.conversation.state)) finished = current; else await sleep(100);
    }
    assert.ok(finished, "the run finished");
    const stage = finished.conversation.runtimeStages.at(-1);
    assert.equal(stage.runtime.effort, "medium", "persistent Codex receives its declared catalog default");
    assert.equal(stage.runtime.effortSource, "default");
    const requests = fs.readFileSync(`${command}.rpc.jsonl`, "utf8").trim().split("\n").map(line => JSON.parse(line));
    const thread = requests.find(row => row.method === "thread/start"), turn = requests.find(row => row.method === "turn/start");
    assert.equal(thread.params.model, "gpt-6.1-sol");
    assert.equal(thread.params.config.model_reasoning_effort, "medium");
    assert.equal(turn.params.effort, "medium");
  } finally { socket.close(); await handle.close(); }
});
