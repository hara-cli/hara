import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntimeBindingStore, freezeTaskRuntimeBinding, isTaskRuntimeBinding } from "../dist/agent-runtime/bindings.js";
import { AgentRuntimeRegistry } from "../dist/agent-runtime/registry.js";
import { createTaskExecution, recoverTaskExecution, forkTaskExecution, isTaskExecution } from "../dist/session/task.js";
import { saveSession, loadSession, newSessionId } from "../dist/session/store.js";
import { isSensitiveFilePath } from "../dist/security/sensitive-files.js";

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "hara-runtime-binding-"));
  return { home, store: new AgentRuntimeBindingStore(home), file: join(home, ".hara", "agent-runtime-bindings.json") };
}

test("unbound legacy Agents keep Hara without writing a false Pi migration", () => {
  const { store, file } = fixture();
  assert.deepEqual(store.read("personal", "main"), { version: 1, spaceId: "personal", agentRef: "main", runtimeId: "hara", revision: 0 });
  assert.equal(existsSync(file), false);
  assert.equal(isSensitiveFilePath(file), true, "model filesystem tools must not rewrite the host's engine selection");
  for (const [spaceId, ref] of [["ws_unverified", "main"], ["personal", "../escape"], ["personal", "coder"]]) {
    assert.throws(() => store.read(spaceId, ref), /audience|ref/);
  }
});

test("trusted binding edits use private CAS and keep every Agent/Space independent", () => {
  const { store, file } = fixture();
  const initial = store.set("personal", "main", "pi", 0);
  assert.equal(initial.revision, 1);
  if (process.platform !== "win32") {
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(join(file, "..")).mode & 0o777, 0o700);
  }
  initial.runtimeId = "claude";
  assert.equal(store.read("personal", "main").runtimeId, "pi");
  const bytes = readFileSync(file, "utf8");
  assert.throws(() => store.set("personal", "main", "codex", 0), /changed/);
  assert.equal(readFileSync(file, "utf8"), bytes);
  store.set("org:fixture", "main", "opencode", 0);
  store.set("personal", "global:coder", "codex", 0);
  assert.equal(store.read("personal", "main").runtimeId, "pi");
  assert.equal(store.read("org:fixture", "main").runtimeId, "opencode");
  assert.equal(store.read("personal", "global:coder").runtimeId, "codex");
  assert.throws(() => store.set("personal", "main", "automatic", 1), /invalid/);
});

test("future, duplicate and credential-bearing binding state is refused without replacing it", () => {
  for (const mutate of [
    (value) => { value.version = 2; },
    (value) => { value.bindings.push(value.bindings[0]); },
    (value) => { value.bindings[0].apiKey = "fixture-not-a-real-key"; },
    (value) => { value.bindings[0].revision = 0; },
    (value) => { value.bindings[0].runtimeId = "unknown-driver"; },
  ]) {
    const { store, file } = fixture(); store.set("personal", "main", "pi", 0);
    const value = JSON.parse(readFileSync(file, "utf8")); mutate(value); const text = JSON.stringify(value);
    writeFileSync(file, text);
    assert.throws(() => store.read("personal", "main"), /invalid|unsupported|duplicate/);
    assert.throws(() => store.set("personal", "main", "hara", 1), /invalid|unsupported|duplicate/);
    assert.equal(readFileSync(file, "utf8"), text);
  }
});

test("task snapshots survive recovery but a fork does not inherit native Runtime ownership", () => {
  const { store } = fixture(); store.set("personal", "main", "pi", 0);
  const task = createTaskExecution("fixture task", "fixture-turn");
  task.runtimeBinding = freezeTaskRuntimeBinding(store.read("personal", "main"), task.id);
  assert.equal(Object.isFrozen(task.runtimeBinding), true);
  store.set("personal", "main", "codex", 1);
  assert.equal(task.runtimeBinding.runtimeId, "pi");
  assert.deepEqual(recoverTaskExecution(task).runtimeBinding, task.runtimeBinding);
  assert.equal(forkTaskExecution(task).runtimeBinding, undefined);
  assert.equal(isTaskExecution(task), true);
  assert.equal(isTaskExecution({ ...task, runtimeBinding: { ...task.runtimeBinding, taskId: "other-task" } }), false);
  assert.equal(isTaskRuntimeBinding({ ...task.runtimeBinding, toolGrant: true }), false);
});

test("unavailable general-Agent drivers never fall back or invoke the model", () => {
  let invoked = 0;
  const registry = new AgentRuntimeRegistry([{ id: "hara", async run() { invoked++; return { status: "completed" }; } }]);
  const task = createTaskExecution("fixture task", "fixture-turn");
  const binding = freezeTaskRuntimeBinding({ version: 1, spaceId: "personal", agentRef: "main", runtimeId: "pi", revision: 1 }, task.id);
  assert.throws(() => registry.run([], { ctx: { spaceId: "personal" }, taskIntake: { task } }, binding), /not available.*no fallback/);
  assert.equal(invoked, 0);
  const pi = registry.options().find((option) => option.id === "pi");
  assert.equal(pi.recommended, true); assert.equal(pi.available, false);
});

test("dispatch checks task/audience/cancellation and sends an immutable snapshot to the exact trusted driver", async () => {
  const observed = [];
  const registry = new AgentRuntimeRegistry([{ id: "pi", async run(history, options, binding) {
    observed.push(binding); assert.equal(Object.isFrozen(binding), true); return { status: "completed" };
  } }]);
  const task = createTaskExecution("fixture task", "fixture-turn");
  const binding = freezeTaskRuntimeBinding({ version: 1, spaceId: "personal", agentRef: "main", runtimeId: "pi", revision: 1 }, task.id);
  const options = { ctx: { spaceId: "personal" }, taskIntake: { task } };
  assert.throws(() => registry.run([], { ...options, ctx: { spaceId: "org:other" } }, binding), /audience/);
  assert.throws(() => registry.run([], { ...options, taskIntake: { task: { id: "other" } } }, binding), /audience/);
  assert.throws(() => registry.run([], { ...options, signal: AbortSignal.abort() }, binding), /cancelled/);
  assert.equal(observed.length, 0);
  assert.deepEqual(await registry.run([], options, binding), { status: "completed" });
  assert.deepEqual(observed, [binding]);
});

test("real session persistence keeps binding provenance and rejects a forged task audience", () => {
  const id = newSessionId(); const at = new Date().toISOString();
  const meta = { id, cwd: tmpdir(), provider: "fixture", model: "fixture-model", spaceId: "personal", title: "runtime fixture", createdAt: at, updatedAt: at };
  const task = createTaskExecution("fixture task", "fixture-turn");
  task.runtimeBinding = freezeTaskRuntimeBinding({ version: 1, spaceId: "personal", agentRef: "main", runtimeId: "hara", revision: 0 }, task.id);
  saveSession(meta, [], task);
  assert.deepEqual(loadSession(id).task.runtimeBinding, task.runtimeBinding);
  assert.throws(() => saveSession(meta, [], { ...task, runtimeBinding: { ...task.runtimeBinding, spaceId: "org:other" } }), /invalid|session/i);
  assert.deepEqual(loadSession(id).task.runtimeBinding, task.runtimeBinding);
});
