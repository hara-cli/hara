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
import { finishTaskExecution, createTaskExecution } from "../dist/session/task.js";

const roots = [];
function root() { const path = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "hara-cli-driver-"))); roots.push(path); return path; }
after(() => roots.forEach(path => fs.rmSync(path, { recursive: true, force: true })));

for (const [runtimeId, managed, failure, hasGit = false] of [["codex", false, null], ["claude", false, null],
  ["codex", true, null], ["codex", true, null, true], ["codex", true, "project_not_trusted"], ["codex", true, "runtime_auth_required"], ["codex", true, "command_failed"], ["claude", true, "runtime_network"], ["claude", true, "runtime_proxy"], ["claude", true, "version_incompatible"], ["codex", true, "runtime_auth_event"], ["codex", true, "runtime_auth_event_nonzero"], ["codex", true, "runtime_auth_recovered"]]) test(`${runtimeId} managed=${managed} git=${hasGit} failure=${failure} stays confined with no fallback`, async () => {
  const expectedFailure = failure && failure !== "runtime_auth_recovered";
  const data = root(), home = managed ? join(data, "home") : data, account = root();
  fs.mkdirSync(home, { recursive: true });
  const catalog = new LocalWorkspaceCatalog(home), row = catalog.create("Local", 1);
  const project = managed ? join(data, "project", row.scope.workspaceId) : root();
  fs.mkdirSync(project, { recursive: true });
  if (hasGit) fs.mkdirSync(join(project, ".git"));
  const storage = new WorkspaceResourceStorage(home, row.scope); storage.initialize();
  const command = join(account, ".local", "bin", runtimeId), argv = join(account, "argv.txt");
  fs.mkdirSync(dirname(command), { recursive: true });
  fs.writeFileSync(command, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo '${runtimeId} 1.2.3'; exit 0; fi\nif [ "$1" = "app-server" ]; then exit 1; fi\nif [ "$1" = "debug" ]; then echo '{"models":[{"slug":"fixture-model","display_name":"Fixture"}]}'; exit 0; fi\nprintf 'launch\\n' >> '${argv}.launches'\nprintf '%s\\n' "$@" > '${argv}'\n${runtimeId === "codex" && managed && !hasGit ? `case " $* " in *' --skip-git-repo-check '*) ;; *) echo 'Not inside a trusted directory and --skip-git-repo-check was not specified.' >&2; exit 1;; esac` : ''}\n${failure === 'runtime_auth_recovered' ? `echo '{"type":"error","message":"temporary network error PRIVATE_ACCOUNT_DETAIL"}'; echo '{"type":"item.completed","item":{"type":"agent_message","text":"registered codex reply"}}'; echo '{"type":"turn.completed"}'; exit 0` : failure?.startsWith('runtime_auth_event') ? `echo '{"type":"turn.failed","error":{"message":"401 Unauthorized PRIVATE_ACCOUNT_DETAIL"}}'; exit ${failure === 'runtime_auth_event' ? 0 : 1}` : failure ? `echo '${failure === 'project_not_trusted' ? 'Not inside a trusted directory' : failure === 'runtime_auth_required' ? 'websocket 401 Unauthorized PRIVATE_ACCOUNT_DETAIL' : failure === 'runtime_network' ? 'ECONNRESET PRIVATE_ACCOUNT_DETAIL' : failure === 'runtime_proxy' ? 'proxy connect failed PRIVATE_ACCOUNT_DETAIL' : failure === 'version_incompatible' ? 'unrecognized option --fixture PRIVATE_ACCOUNT_DETAIL' : 'PRIVATE_ACCOUNT_DETAIL'}' >&2; exit 1` : ''}\necho 'registered ${runtimeId} reply'\n`, { mode: 0o755 });
  const installer = new WorkspaceRuntimeInstaller(storage, { discovery: { home: account, path: "/usr/bin:/bin", systemBins: [],
    run: async (_command, args) => args[0] === "-lic" ? null : `${runtimeId} 1.2.3` } });
  const resources = new WorkspaceResources(home, row.scope, { runtimeInstaller: installer }); resources.initialize();
  const main = resources.agents.initializeMain();
  assert.equal(resources.agents.runtimeOptions().find(option => option.id === runtimeId).reason, "not_installed");
  await installer.discover();
  const detected = installer.list().options.find(option => option.runtimeId === runtimeId);
  assert.equal(detected.state, "detected");
  assert.equal(resources.agents.runtimeOptions().find(option => option.id === runtimeId).available, false);
  installer.registerLocal(runtimeId, detected.fingerprint, "isolated");
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
    assert.equal(result.status, expectedFailure ? "error" : "completed", result.error);
    if (expectedFailure) {
      const match = /hara_runtime_failure_v1=(\{[^{}]+\})/.exec(result.error);
      assert.ok(match, "a fixed-field diagnostic survives the common governor");
      const diagnostic = JSON.parse(match[1]);
      const expected = failure === "runtime_auth_required" || failure.startsWith("runtime_auth_event") ? "runtime_auth_rejected"
        : failure === "command_failed" ? "runtime_failed" : failure;
      assert.equal(diagnostic.kind, expected);
      assert.equal(diagnostic.runtime, runtimeId);
      assert.equal(diagnostic.version, "1.2.3");
      assert.equal(diagnostic.loginSource, "isolated");
      assert.equal(diagnostic.homeMatchesAccount, false);
      assert.ok(diagnostic.elapsedMs >= 0 && diagnostic.elapsedMs <= 600000);
      assert.equal(diagnostic.consecutiveFailures, 1);
      assert.ok(diagnostic.retryAtMs > Date.now() - 1000);
      assert.equal(Object.keys(diagnostic).length, 8);
      const checkpoint = finishTaskExecution(task, result).checkpoint;
      const persisted = JSON.parse(/hara_runtime_failure_v1=(\{[^{}]+\})/.exec(checkpoint.blockReason)[1]);
      assert.deepEqual(persisted, diagnostic, "the persisted task block reason keeps the complete safe payload");
      assert.ok(!JSON.stringify(diagnostic).includes(home));
      assert.ok(!JSON.stringify(diagnostic).includes(account));
      assert.ok(!result.error.includes("PRIVATE_ACCOUNT_DETAIL"));
      assert.ok(history.slice(1).every(row => row.role === "assistant" && row.text === "" && row.toolUses.length === 0),
        "a failed native run leaves no fabricated text or tool result; the common governor may retain an empty assistant boundary");
      assert.doesNotMatch(JSON.stringify(history), /PRIVATE_ACCOUNT_DETAIL/);
      if (failure === "runtime_auth_required") {
        // New registry + new attempt permit must still observe the same colleague's cooldown.
        const retryBinding = freezeWorkspaceRunBinding({ ...binding, sessionId: randomUUID(), runId: randomUUID() });
        const retryTask = { ...task, workspaceRunBinding: retryBinding };
        const retryLease = WorkspaceSessionLease.acquire(storage, retryBinding.sessionId);
        const retryPermit = createWorkspaceRunPermit({ ...permitInput, binding: retryBinding, lease: retryLease });
        const retryOptions = bindWorkspaceRunOptions(retryPermit, { ctx: { cwd: project, sessionId: retryBinding.sessionId, sandbox: "off" },
          signal: controller.signal, approval: "auto-edit", approvalChannel: true, confirm: async () => false, hooks: false,
          systemOverride: "Reply concisely", taskIntake: { task: retryTask, current: () => retryTask } });
        const realNow = Date.now;
        try {
          Date.now = () => diagnostic.retryAtMs - 500;
          const repeated = await storage.run(() => runConfiguredAgent([{ role: "user", content: "hello" }], retryOptions,
            new AgentRuntimeRegistry(undefined, installer, models)));
          assert.equal(repeated.status, "error");
          const held = JSON.parse(/hara_runtime_failure_v1=(\{[^{}]+\})/.exec(repeated.error)[1]);
          assert.equal(held.retryAtMs, diagnostic.retryAtMs, "blocked retries do not extend or clear the failure");
          assert.equal(held.consecutiveFailures, 1);
          assert.equal(fs.readFileSync(`${argv}.launches`, "utf8").trim().split("\n").length, 1, "no second inference process");
        } finally { Date.now = realNow; await closeWorkspaceRunPermit(retryPermit); }
      }
    } else {
      assert.equal(history.at(-1).text, `registered ${runtimeId} reply`);
      assert.doesNotMatch(JSON.stringify(history), /PRIVATE_ACCOUNT_DETAIL/);
    }
    const args = fs.readFileSync(argv, "utf8");
    assert.match(args, runtimeId === "codex" ? /read-only/ : /plan/);
    assert.equal(args.includes("--skip-git-repo-check"), runtimeId === "codex" && managed && !hasGit);
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

test("registered CLI args project model and effort without widening write or shell authority", async () => {
  const { registeredCliArgs } = await import("../dist/agent-runtime/registered-cli.js");
  const codex = registeredCliArgs({ id: "codex", prompt: "hi", cwd: "/fixture/project", model: "gpt-5.6-sol", effort: "xhigh", skipGitRepoCheck: true });
  assert.deepEqual(codex, ["exec", "hi", "--cd", "/fixture/project", "--skip-git-repo-check", "-m", "gpt-5.6-sol",
    "-c", 'model_reasoning_effort="xhigh"', "--sandbox", "read-only"]);
  assert(!codex.includes("danger-full-access") && !codex.includes("--yolo"));
  const claude = registeredCliArgs({ id: "claude", prompt: "hi", cwd: "/fixture/project", model: "claude-sonnet-4-5", effort: "high", skipGitRepoCheck: false });
  assert.deepEqual(claude, ["-p", "hi", "--output-format", "text", "--model", "claude-sonnet-4-5", "--effort", "high", "--permission-mode", "plan"]);
  assert(!claude.includes("bypassPermissions"));
  // No selected model and no effort must not invent either flag.
  const bare = registeredCliArgs({ id: "codex", prompt: "hi", cwd: "/fixture/project", model: null, effort: null, skipGitRepoCheck: false });
  assert.deepEqual(bare, ["exec", "hi", "--cd", "/fixture/project", "--sandbox", "read-only"]);
  assert(!bare.includes("-c") && !bare.includes("-m"));
});
