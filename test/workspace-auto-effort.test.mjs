import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { defaultEffortForLevels, resolveReasoningEffort } from "../dist/workspace/default-effort.js";
import { connectionForObjective } from "../dist/workspace/connection-effort.js";
import { LocalWorkspaceHost } from "../dist/workspace/local-host.js";
import { scriptedWorkspaceProvider } from "./fixtures/scripted-workspace-provider.mjs";

const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
test("auto reuses Host objective classification for short replies versus change/investigation/multiple outcomes", () => {
  for (const objective of ["hello", "hello there", "hello, I'm Jeff", "Good morning!", "thanks", "谢谢", "早安", "你好", "你好，我是 Jeff", "Who are you?", "What is 2 + 2?", "What does investigate mean?", "只回复：“收到”"])
    for (const automatic of [undefined, null, "auto"])
      assert.equal(resolveReasoningEffort(automatic, levels, objective), "low", objective);
  for (const objective of ["Update README", "修改文案", "Thanks, update README", "你好，请修改 note.txt", "你好，我是 Jeff，调查一下测试错误", "Investigate a failing test", "Investigate why the tests fail?", "Can you debug this error?", "请调查这个错误，是什么原因？", "Read the logs then summarize the error", "What is X and also explain Y?", "What " + "a".repeat(500) + "?"])
    assert.equal(resolveReasoningEffort("auto", levels, objective), "medium", objective);
});
test("every explicit level survives automatic classification and no unsupported/high level is auto-invented", () => {
  for (const fixed of levels) for (const objective of ["hello", "Investigate the failure"])
    assert.equal(resolveReasoningEffort(fixed, [], objective), fixed);
  assert.equal(defaultEffortForLevels(["off", "minimal", "high"], "hello"), "minimal");
  assert.equal(defaultEffortForLevels(["low", "high"], "Investigate"), "low");
  assert.equal(defaultEffortForLevels(["off", "high"], "hello"), "off");
  for (const supported of [undefined, [], ["high", "max"]])
    assert.equal(resolveReasoningEffort("auto", supported, "hello"), null);
});
test("Pi connection resolution uses existing provider reasoning capabilities and leaves frozen provenance intact", () => {
  const connection = { provider: "openai", baseURL: "https://api.openai.com/v1" };
  const original = Object.freeze({ connectionId: "fixture", credentialGeneration: "fixture", connectionRevision: 1,
    model: "gpt-5.6-sol", reasoning: "auto" });
  assert.equal(connectionForObjective(connection, original, "hello").reasoning, "low");
  assert.equal(connectionForObjective(connection, original, "Investigate the error").reasoning, "medium");
  assert.equal(original.reasoning, "auto");
  assert.equal(connectionForObjective(connection, { ...original, reasoning: "max" }, "hello").reasoning, "max");
  assert.equal(connectionForObjective(connection, { ...original, model: "gpt-image-1" }, "hello").reasoning, null);
  const claude = { provider: "anthropic", baseURL: "https://api.anthropic.com" };
  assert.equal(connectionForObjective(claude, { ...original, model: "claude-sonnet-4-6" }, "hello").reasoning, "low");
});
test("Host freezes Pi's per-turn choice for main and colleague, preserving an explicit colleague connection and timing metadata", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "hara-auto-effort-"))), choices = [];
  const host = new LocalWorkspaceHost(root, { providerFactory(_connection, binding, context) {
    choices.push({ effort: binding.reasoning, agent: context.agent.agentId });
    return scriptedWorkspaceProvider({ id: "openai", model: binding.model, async turn() {
      return { text: "Hello", toolUses: [], stop: "end" };
    } });
  } });
  try {
    const workspace = host.createWorkspace("Auto effort", host.list().revision), workspaceId = workspace.workspaceId;
    host.configureConnection(workspaceId, { label: "Fixture", provider: "openai", baseURL: "http://127.0.0.1:1/v1",
      apiKey: "synthetic-not-a-real-key", defaultModel: "gpt-5.6-sol" }, 0);
    const resources = host.context(workspaceId).resources;
    const colleague = resources.agents.create({ username: "tester", profile: { displayName: "Tester" }, permissionTier: "controlled" }, resources.agents.list().revision);
    let main = resources.agents.get(workspace.selectedAgentId);
    main = host.setAgentPermissionTier(workspaceId, main.agentId, "controlled", main.configRevision, main.agentEpoch);
    for (const [agentId, message, effort] of [[main.agentId, "hello", "low"], [colleague.agentId, "Investigate failing tests", "medium"]]) {
      const run = host.start("client", workspaceId, agentId, message, randomUUID()); await host.wait(run.runId);
      assert.equal(choices.at(-1).effort, effort);
      assert.equal(host.snapshot(workspaceId, agentId).conversation.runtimeStages.at(-1).runtime.effort, effort);
    }
    let connections = host.snapshot(workspaceId).connections;
    assert.equal(connections.connections[0].defaultReasoning, null);
    host.selectConnection(workspaceId, connections.connections[0].id, connections.revision, "gpt-5.6-sol", "high");
    host.setAgentPermissionTier(workspaceId, colleague.agentId, "full-protected", colleague.configRevision, colleague.agentEpoch);
    const run = host.start("client", workspaceId, colleague.agentId, "hello", randomUUID()); await host.wait(run.runId);
    assert.deepEqual(choices.at(-1), { effort: "high", agent: colleague.agentId });
    assert.equal(host.snapshot(workspaceId, colleague.agentId).conversation.runtimeStages.at(-1).runtime.effort, "high");
    assert.equal(host.snapshot(workspaceId).connections.connections[0].defaultReasoning, "high");
    connections = host.snapshot(workspaceId).connections;
    host.selectConnection(workspaceId, connections.connections[0].id, connections.revision, "gpt-5.6-sol", "auto");
    const autoRun = host.start("client", workspaceId, colleague.agentId, "hello", randomUUID()); await host.wait(autoRun.runId);
    assert.equal(choices.at(-1).effort, "low");
    assert.equal(host.snapshot(workspaceId, colleague.agentId).conversation.runtimeStages.at(-1).runtime.effort, "low", "protected Pi preserves the Host's effective effort");
    assert.equal(host.snapshot(workspaceId).connections.connections[0].defaultReasoning, "auto");
  } finally { await host.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
