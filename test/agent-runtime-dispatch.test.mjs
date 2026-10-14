import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntimeBindingStore } from "../dist/agent-runtime/bindings.js";
import { bindNewAgentTask, runConfiguredAgent } from "../dist/agent-runtime/dispatch.js";
import { createTaskExecution } from "../dist/session/task.js";

test("CLI task admission freezes the exact selected Agent Runtime before a new task is published", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-cli-runtime-")), store = new AgentRuntimeBindingStore(home);
  store.set("personal", "global:colleague", "pi", 0);
  const original = createTaskExecution("fixture", "fixture-turn");
  const task = bindNewAgentTask(original, "personal", "global:colleague", home);
  assert.equal(original.runtimeBinding, undefined); assert.equal(task.runtimeBinding.runtimeId, "pi");
  assert.equal(task.runtimeBinding.agentRef, "global:colleague"); assert.equal(Object.isFrozen(task.runtimeBinding), true);
  store.set("personal", "global:colleague", "hara", 1);
  assert.equal(task.runtimeBinding.runtimeId, "pi");
  store.set("personal", "global:colleague", "codex", 2);
  assert.throws(() => bindNewAgentTask(original, "personal", "global:colleague", home), /not available.*no fallback/);
  assert.equal(original.runtimeBinding, undefined);
  assert.equal(bindNewAgentTask(original, "org:fixture", "main", home).runtimeBinding.runtimeId, "hara");
});

test("shared headless dispatch uses actual Pi for a bound task and leaves old unbound recovery on Hara", async () => {
  const home = mkdtempSync(join(tmpdir(), "hara-headless-pi-"));
  new AgentRuntimeBindingStore(home).set("personal", "main", "pi", 0);
  const task = bindNewAgentTask(createTaskExecution("hello", "fixture-turn"), "personal", "main", home);
  let calls = 0;
  const opts = { provider: { id: "synthetic", model: "fixture", async turn() { calls++; return { text: "Hello.", toolUses: [], stop: "end" }; } },
    ctx: { cwd: home, sandbox: "off", spaceId: "personal" }, approval: "suggest", approvalChannel: false, confirm: async () => false,
    quiet: true, hooks: false, maxRounds: 2, taskIntake: { task } };
  const history = [{ role: "user", content: "hello" }];
  assert.equal((await runConfiguredAgent(history, opts)).status, "completed"); assert.equal(calls, 1);
  const legacy = createTaskExecution("old unfinished task", "old-turn");
  assert.equal((await runConfiguredAgent([{ role: "user", content: "hello again" }], { ...opts, taskIntake: { task: legacy } })).status, "completed");
  assert.equal(legacy.runtimeBinding, undefined); assert.equal(calls, 2);
});
