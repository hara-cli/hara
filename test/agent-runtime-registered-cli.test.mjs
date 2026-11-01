import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { LocalWorkspaceCatalog } from "../dist/workspace/local-catalog.js";
import { WorkspaceResourceStorage } from "../dist/workspace/resource-context.js";
import { WorkspaceRuntimeInstaller } from "../dist/workspace/runtime-install.js";
import { WorkspaceRuntimeModels } from "../dist/workspace/runtime-models.js";
import { WorkspaceResources } from "../dist/workspace/resources.js";
import { WorkspaceConnectionStoreV2 } from "../dist/workspace/connections.js";
import { WorkspaceSessionLease } from "../dist/workspace/session-lease.js";
import { captureWorkspaceProjectIdentity, freezeWorkspaceRunBinding, workspaceAgentBindingHash } from "../dist/workspace/run-binding.js";
import { createWorkspaceRunPermit, bindWorkspaceRunOptions, closeWorkspaceRunPermit } from "../dist/workspace/execution.js";
import { AgentRuntimeRegistry } from "../dist/agent-runtime/registry.js";
import { runConfiguredAgent } from "../dist/agent-runtime/dispatch.js";
import { createTaskExecution } from "../dist/session/task.js";

const roots = [];
function root() { const path = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "hara-cli-driver-"))); roots.push(path); return path; }
after(() => roots.forEach(path => fs.rmSync(path, { recursive: true, force: true })));

for (const [runtimeId, managed, failure, hasGit = false] of [["codex", false, null], ["claude", false, null],
  ["codex", true, null], ["codex", true, null, true], ["codex", true, "project_not_trusted"], ["codex", true, "runtime_auth_required"], ["codex", true, "command_failed"]]) test(`${runtimeId} managed=${managed} git=${hasGit} failure=${failure} stays confined with no fallback`, async () => {
  const data = root(), home = managed ? join(data, "home") : data, account = root();
  fs.mkdirSync(home, { recursive: true });
  const catalog = new LocalWorkspaceCatalog(home), row = catalog.create("Local", 1);
  const project = managed ? join(data, "project", row.scope.workspaceId) : root();
  fs.mkdirSync(project, { recursive: true });
  if (hasGit) fs.mkdirSync(join(project, ".git"));
  const storage = new WorkspaceResourceStorage(home, row.scope); storage.initialize();
  const command = join(account, ".local", "bin", runtimeId), argv = join(account, "argv.txt");
  fs.mkdirSync(dirname(command), { recursive: true });
  fs.writeFileSync(command, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo '${runtimeId} 1.2.3'; exit 0; fi\nif [ "$1" = "app-server" ]; then exit 1; fi\nif [ "$1" = "debug" ]; then echo '{"models":[{"slug":"fixture-model","display_name":"Fixture"}]}'; exit 0; fi\nprintf '%s\\n' "$@" > '${argv}'\n${managed && !hasGit ? `case " $* " in *' --skip-git-repo-check '*) ;; *) echo 'Not inside a trusted directory and --skip-git-repo-check was not specified.' >&2; exit 1;; esac` : ''}\n${failure ? `echo '${failure === 'project_not_trusted' ? 'Not inside a trusted directory' : failure === 'runtime_auth_required' ? 'websocket 401 Unauthorized PRIVATE_ACCOUNT_DETAIL' : 'PRIVATE_ACCOUNT_DETAIL'}' >&2; exit 1` : ''}\necho 'registered ${runtimeId} reply'\n`, { mode: 0o755 });
  const installer = new WorkspaceRuntimeInstaller(storage, { discovery: { home: account, path: "/usr/bin:/bin", systemBins: [],
    run: async (_command, args) => args[0] === "-lic" ? null : `${runtimeId} 1.2.3` } });
  const resources = new WorkspaceResources(home, row.scope, { runtimeInstaller: installer }); resources.initialize();
  const main = resources.agents.initializeMain();
  assert.equal(resources.agents.runtimeOptions().find(option => option.id === runtimeId).reason, "not_installed");
  await installer.discover();
  const detected = installer.list().options.find(option => option.runtimeId === runtimeId);
  assert.equal(detected.state, "detected");
  assert.equal(resources.agents.runtimeOptions().find(option => option.id === runtimeId).available, false);
  installer.registerLocal(runtimeId, detected.fingerprint);
  const models = new WorkspaceRuntimeModels(storage, installer);
  const modelId = runtimeId === "codex" ? "fixture-model" : "claude-sonnet-4-5";
  await models.select(runtimeId, modelId, 0);
  assert.equal(models.selected(runtimeId), modelId);
  assert.equal(installer.list().options.find(option => option.runtimeId === runtimeId).generalAgentDriverAvailable, true);
  assert.equal(resources.agents.runtimeOptions().find(option => option.id === runtimeId).available, true);
  assert.equal(resources.agents.runtimeOptions().find(option => option.id === "opencode").available, false);
  assert.equal(new AgentRuntimeRegistry([{ id: "opencode", async run() { throw new Error("must not run"); } }])
    .options().find(option => option.id === "opencode").available, false, "P0.5 stays unavailable even with a stray injected driver");
  const selected = resources.agents.setRuntime(main.agentId, runtimeId, main.configRevision, main.agentEpoch);
  assert.equal(selected.kind, "main");
  assert.throws(() => resources.agents.setArchived(main.agentId, true, selected.configRevision, selected.agentEpoch), /cannot be archived/);
  let task = resources.agents.bindTask(createTaskExecution("hello", randomUUID()), main.agentId, selected.configRevision, selected.agentEpoch);
  assert.equal(task.workspaceAgentBinding.runtimeId, runtimeId);
  const nextPreference = resources.agents.setRuntime(main.agentId, "pi", selected.configRevision, selected.agentEpoch);
  assert.equal(nextPreference.runtime.id, "pi");
  assert.equal(task.workspaceAgentBinding.runtimeId, runtimeId, "in-flight task keeps its frozen Runtime");
  const connections = new WorkspaceConnectionStoreV2(storage);
  connections.add({ label: "Fixture", provider: "openai", baseURL: "http://127.0.0.1:1/v1", apiKey: "fixture", defaultModel: "fixture" }, 0);
  const binding = freezeWorkspaceRunBinding({ schemaVersion: 1, scope: row.scope, agent: task.workspaceAgentBinding,
    agentBindingHash: workspaceAgentBindingHash(task.workspaceAgentBinding), connection: connections.capture(), runtimeContract: "hara-governed-runtime-v1",
    project: captureWorkspaceProjectIdentity(project), sessionId: randomUUID(), runId: randomUUID(),
    lineage: { rootRunId: null, parentRunId: null, depth: 0 }, createdAt: new Date().toISOString(),
    host: { hostId: catalog.read().hostId, hostEpoch: 1, grantId: row.grantId, grantRevision: 1, actorId: row.actorId, policyRevision: 1 },
    budget: { maxRounds: 12, maxToolCalls: 32, maxTokens: 32000, timeoutMs: 60000 } });
  task.workspaceRunBinding = binding;
  const lease = WorkspaceSessionLease.acquire(storage, binding.sessionId), controller = new AbortController();
  const permitInput = { binding, catalog, resources, storage, connections, lease, cwd: project, ...(managed ? { managedProjectRoot: project } : {}), signal: controller.signal,
    provider: { id: "openai", model: binding.connection.model, async turn() { throw new Error("unexpected fallback"); } },
    toolNames: [], usage: { modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0 }, updateUsage() {} };
  if (!managed) assert.throws(() => createWorkspaceRunPermit({ ...permitInput, managedProjectRoot: project }), /managed Workspace project proof/);
  const permit = createWorkspaceRunPermit(permitInput);
  const options = bindWorkspaceRunOptions(permit, { ctx: { cwd: project, sessionId: binding.sessionId, sandbox: "off" },
    signal: controller.signal, approval: "auto-edit", approvalChannel: true, confirm: async () => false, hooks: false,
    systemOverride: "Reply concisely", taskIntake: { task, current: () => task } });
  try {
    const history = [{ role: "user", content: "hello" }];
    const result = await storage.run(() => runConfiguredAgent(history, options, new AgentRuntimeRegistry(undefined, installer, models)));
    assert.equal(result.status, failure ? "error" : "completed", result.error);
    if (failure) {
      assert.ok(result.error.includes(`(${failure})`));
      assert.ok(result.error.includes("no fallback was selected"));
      assert.ok(!result.error.includes("PRIVATE_ACCOUNT_DETAIL"));
      assert.equal(history.length, 1);
    } else assert.equal(history.at(-1).text, `registered ${runtimeId} reply`);
    const args = fs.readFileSync(argv, "utf8");
    assert.match(args, runtimeId === "codex" ? /read-only/ : /plan/);
    assert.equal(args.includes("--skip-git-repo-check"), managed && !hasGit);
    assert.equal(fs.existsSync(join(project, ".git")), hasGit);
    const privateEnv = installer.resolveBound(runtimeId).env;
    assert.ok(privateEnv.HOME.startsWith(home));
    assert.equal(fs.existsSync(join(account, ".codex")), false);
    if (runtimeId === "codex") {
      const guide = installer.codexLoginInstructions();
      assert.equal(guide.runtimeId, "codex");
      assert.ok(guide.command.includes(privateEnv.CODEX_HOME));
      assert.ok(guide.command.endsWith(" login"));
      assert.ok(!guide.command.includes("--skip-git-repo-check"));
    }
    assert.ok(args.includes(modelId), "spawn uses the existing Workspace runtime model selection");
    assert.ok(!args.includes("danger-full-access") && !args.includes("bypassPermissions"));
    fs.appendFileSync(command, "# changed after registration\n");
    assert.equal(resources.agents.runtimeOptions().find(option => option.id === runtimeId).available, false);
    assert.equal(installer.list().options.find(option => option.runtimeId === runtimeId).state, "integrity_failed");
    assert.throws(() => new AgentRuntimeRegistry(undefined, installer).assertAvailable(runtimeId), /no fallback/);
  } finally { await closeWorkspaceRunPermit(permit); await installer.close(); }
});
