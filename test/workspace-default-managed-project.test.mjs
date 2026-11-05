import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import "../dist/tools/all.js";
import { cliMcpFixture, until } from "./helpers/workspace-cli-mcp.mjs";
import { RuntimeExecutionPolicy, createRuntimeExecutionPolicy, runtimeExecutionPolicyKey } from "../dist/agent-runtime/execution-policy.js";
import { LocalWorkspaceHost } from "../dist/workspace/local-host.js";
import { MemoryCredentialVault } from "../dist/workspace/credential-vault.js";
import { createWorkspaceSyntheticProvider, SYNTHETIC_CONNECTION } from "../dist/workspace/synthetic-provider.js";

const terminal = value => ["completed", "blocked", "paused", "cancelled"].includes(value.conversation.state);
async function exchange(f, message) { await f.send(message); return until(f.read, terminal); }
async function setTier(f, permissionTier) {
  const view = await f.read(), agent = view.agents.find(row => row.agentId === f.main.agentId);
  await f.request("workspace.agents.setPermissionTier", { ...f.scope, agentId: agent.agentId,
    permissionTier, configRevision: agent.configRevision, agentEpoch: agent.agentEpoch });
}
function sentinel(file, content = "synthetic host state") {
  fs.mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 }); fs.writeFileSync(file, content, { mode: 0o600 });
}
test("default App Hara project is granted only by the live opaque Host permit; S3 retains its root and other state remains protected", async t => {
  if (process.platform !== "darwin") return t.skip("macOS Seatbelt required");
  const f = await cliMcpFixture(t, "reply", { productionLayout: true });
  assert.equal(f.workspaceRoot, join(f.account, ".hara", "workspaces-v1"));
  const globalState = join(f.account, ".hara", "protected-global.txt");
  const hostState = join(f.workspaceRoot, "home", ".hara", "protected-host.txt");
  const sibling = join(f.workspaceRoot, "project", "ws_" + randomUUID(), "protected-sibling.txt");
  const foreignCredential = join(f.account, ".claude", ".credentials.json");
  for (const file of [globalState, hostState, sibling, foreignCredential]) sentinel(file);
  const alias = join(f.project, "alias-to-host-state"); fs.symlinkSync(hostState, alias);
  const protectedPaths = [globalState, hostState, sibling, foreignCredential, alias];
  const probes = { productionLayout: true, boundaryWriteProbes: protectedPaths, boundaryReadProbes: protectedPaths };
  const captured = [], wrap = RuntimeExecutionPolicy.prototype.wrap;
  RuntimeExecutionPolicy.prototype.wrap = function(launch) {
    if (this.workRoot === f.project) {
      const input = this.input;
      assert.ok(input.managedProjectPermit, "the trusted factory must carry the existing Host capability");
      assert.equal(runtimeExecutionPolicyKey(input), this.key);
      assert.throws(() => createRuntimeExecutionPolicy({ ...input, managedProjectPermit: undefined }), /protected Hara state/);
      assert.throws(() => createRuntimeExecutionPolicy({ ...input, managedProjectPermit: structuredClone(input.managedProjectPermit) }), /trusted Host permit/);
      assert.throws(() => createRuntimeExecutionPolicy({ ...input, workRoot: join(sibling, "..") }), /differs from the admitted binding/);
      assert.throws(() => createRuntimeExecutionPolicy({ ...input, tier: input.tier === "controlled" ? "full-protected" : "controlled" }), /differs from the admitted binding/);
      assert.throws(() => createRuntimeExecutionPolicy({ ...input, runtimeId: "claude" }), /differs from the admitted binding/);
      captured.push(input);
    }
    return wrap.call(this, launch);
  };
  t.after(() => { RuntimeExecutionPolicy.prototype.wrap = wrap; });
  f.mode({ ...probes, mode: "reply" });
  let view = await exchange(f, "Hello.");
  assert.equal(view.conversation.state, "completed", view.conversation.blockReason);
  assert.equal(view.conversation.completion.state, "verified");
  const firstPid = f.meta().pid;
  assert.deepEqual(f.meta().boundaryWrites.map(row => row.allowed), protectedPaths.map(() => false));
  assert.deepEqual(f.meta().boundaryReads.map(row => row.allowed), protectedPaths.map(() => false));
  f.mode({ ...probes, mode: "native-write" });
  view = await exchange(f, "Write native-result.txt");
  assert.equal(view.conversation.state, "completed", view.conversation.blockReason);
  assert.equal(view.conversation.completion.state, "verified");
  assert.match(view.conversation.completion.evidence.join(" "), /native-workspace-diff/);
  assert.equal(fs.readFileSync(join(f.project, "native-result.txt"), "utf8"), "native file result");
  assert.equal(f.meta().pid, firstPid, "a new permit/task must not change the resident policy key");
  for (const file of [globalState, hostState, sibling, foreignCredential]) assert.equal(fs.readFileSync(file, "utf8"), "synthetic host state");
  await setTier(f, "controlled");
  const controlledFile = join(f.project, "controlled-must-not-write.txt");
  f.mode({ mode: "reply", productionLayout: true, boundaryWriteProbes: [...protectedPaths, controlledFile],
    boundaryReadProbes: [join(f.project, "native-result.txt"), ...protectedPaths] });
  view = await exchange(f, "Hello.");
  assert.equal(view.conversation.state, "completed", view.conversation.blockReason);
  assert.equal(view.conversation.permissionTier, "controlled");
  assert.notEqual(f.meta().pid, firstPid);
  assert.deepEqual(f.meta().boundaryWrites.map(row => row.allowed), [...protectedPaths, controlledFile].map(() => false));
  assert.deepEqual(f.meta().boundaryReads.map(row => row.allowed), [true, ...protectedPaths.map(() => false)]);
  assert.equal(fs.existsSync(controlledFile), false);
  const threads = f.native().filter(row => ["thread/start", "thread/resume"].includes(row.method));
  assert.deepEqual(threads.map(row => row.method), ["thread/start", "thread/resume"]);
  const turns = f.native().filter(row => row.method === "turn/start");
  assert.equal(turns.length, 3);
  assert.ok(turns.every(row => row.params.threadId === turns[0].params.threadId));
  assert.equal(threads.at(-1).params.threadId, turns[0].params.threadId);
  assert.ok(captured.length >= 2);
  await until(async () => { try { runtimeExecutionPolicyKey(captured[0]); return false; } catch { return true; } }, Boolean);
  assert.throws(() => runtimeExecutionPolicyKey(captured[0]), /cancelled|expired/);
});

test("actual full Pi greeting and verified file task work in the native App default layout with only synthetic credentials", async t => {
  if (process.platform !== "darwin") return t.skip("macOS Seatbelt required");
  const owned = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "hara-managed-default-pi-")));
  const account = join(owned, "account"), root = join(account, ".hara", "workspaces-v1");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const host = new LocalWorkspaceHost(root, { mode: "workspace", hostHome: account, discoveryHome: account, legacySourceHome: account,
    credentialVault: new MemoryCredentialVault(), providerFactory: createWorkspaceSyntheticProvider,
    runtimeInstallerOptions: { accountHome: () => account, discovery: { home: account, path: "/usr/bin:/bin", systemBins: [], run: async () => null } } });
  t.after(async () => { await host.close(); fs.rmSync(owned, { recursive: true, force: true }); });
  await host.initialize();
  const workspace = host.createWorkspace("Default path synthetic fixture", host.list().revision);
  host.configureConnection(workspace.workspaceId, { ...SYNTHETIC_CONNECTION }, 0);
  const project = join(root, "project", workspace.workspaceId);
  assert.ok(project.startsWith(join(account, ".hara") + "/"));
  for (const message of ["你好，请用一句话介绍你自己", "生成 hello.md 並驗證"]) {
    const started = host.start("native-default-layout-fixture", workspace.workspaceId, workspace.selectedAgentId, message, randomUUID());
    await host.wait(started.runId);
    const view = host.snapshot(workspace.workspaceId).conversation;
    assert.equal(view.taskState, "completed", view.blockReason);
    assert.equal(view.completion.state, "verified");
    assert.equal(view.permissionTier, "full-protected");
  }
  assert.equal(fs.readFileSync(join(project, "hello.md"), "utf8"), "hello workspace\n");
});
