import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { WorkspaceResources } from "../dist/workspace/resources.js";
import { WorkspaceAgentStore } from "../dist/workspace/agents.js";
import { workspaceResourceScopeKey, WorkspaceResourceStorage } from "../dist/workspace/resource-context.js";
import { walkFiles, walkFilesAsync, workspaceMemoryWalkOptions } from "../dist/fs-walk.js";
import { freezeWorkspaceAgentTaskBinding, isWorkspaceAgentTaskBinding } from "../dist/workspace/agent-binding.js";
import { AgentRuntimeBindingStore, freezeTaskRuntimeBinding } from "../dist/agent-runtime/bindings.js";
import { AgentRuntimeRegistry } from "../dist/agent-runtime/registry.js";
import { bindNewAgentTask, runConfiguredAgent } from "../dist/agent-runtime/dispatch.js";
import { runAgent } from "../dist/agent/loop.js";
import { runPiAgent } from "../dist/agent-runtime/pi.js";
import { createTaskExecution, recoverTaskExecution, forkTaskExecution, isTaskExecution } from "../dist/session/task.js";
import { loadSession, saveSession } from "../dist/session/store.js";
import { SessionHub } from "../dist/serve/sessions.js";
import { isSensitiveFilePath } from "../dist/security/sensitive-files.js";

const temporary = [];
after(() => { for (const target of temporary) fs.rmSync(target, { recursive: true, force: true }); });
function dir() { const result = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "hara-workspace-agent-"))); temporary.push(result); return result; }
const wsA = "ws_10000000-0000-4000-8000-000000000001", wsB = "ws_10000000-0000-4000-8000-000000000002";
const scope = (workspaceId = wsA, authority = { kind: "local", localAuthorityId: "20000000-0000-4000-8000-000000000001" }) => ({ schemaVersion: 1, workspaceId, authority });
const open = (home = dir(), identity = scope()) => { const result = new WorkspaceResources(home, identity); result.initialize(); return result; };
const state = (home, identity = scope()) => join(home, ".hara", "workspace-data", "v1", workspaceResourceScopeKey(identity), "state", ".hara");
const file = (home, identity = scope()) => join(state(home, identity), "workspace-agents.json");
const owner = (home, identity = scope()) => join(state(home, identity), "workspace-agents-owner.json");
const digest = target => createHash("sha256").update(fs.readFileSync(target)).digest("hex");
const persona = (name, instructions = `${name} private instructions`) => ({ profile: { displayName: name }, description: `${name} public description`, instructions });
function create(resources, username = "coder", name = "Coder") {
  return resources.agents.create({ username, ...persona(name) }, resources.agents.list().revision);
}
function bind(resources, agent, objective = "synthetic objective") {
  return resources.agents.bindTask(createTaskExecution(objective, "synthetic-turn"), agent.agentId, agent.configRevision, agent.agentEpoch);
}
function meta(task, cwd = dir(), id = "same-session") {
  return { id, cwd, provider: "openai", model: "synthetic-model", profileId: "synthetic-key", spaceId: "personal",
    workspaceAgentId: task.workspaceAgentBinding.agentId, title: "synthetic conversation", createdAt: "2026-10-16T00:00:00Z", updatedAt: "2026-10-16T00:00:00Z" };
}
const history = [{ role: "user", content: "synthetic user message" }];
function privateWrite(target, value) { fs.writeFileSync(target, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 }); }

test("new Agent storage is explicit and empty, never initializes legacy or ambient role sources", () => {
  const host = dir(), project = dir();
  for (const roleDir of [join(host, ".hara", "roles"), join(host, ".claude", "agents"), join(project, ".hara", "roles")]) {
    fs.mkdirSync(roleDir, { recursive: true }); privateWrite(join(roleDir, "coder.md"), "ambient persona must not be discovered");
  }
  new AgentRuntimeBindingStore(host).set("personal", "main", "hara", 0);
  const legacy = join(host, ".hara", "agent-runtime-bindings.json"), before = digest(legacy);
  const resources = new WorkspaceResources(host, scope());
  assert.throws(() => resources.agents.list(), /not initialized/);
  assert.equal(fs.existsSync(file(host)), false);
  resources.initialize();
  assert.deepEqual(resources.agents.list(), { revision: 0, mainAgentId: null, agents: [] });
  assert.equal(fs.existsSync(file(host)), false, "a read never invents a main identity");
  assert.throws(() => resources.agents.create({ username: "coder", ...persona("Coder") }, 1), /catalog changed/);
  assert.equal(digest(legacy), before);
  const rawStore = new WorkspaceAgentStore(scope());
  assert.throws(() => rawStore.initializeMain(), /exact resource context/);
  assert.throws(() => rawStore.create({ username: "coder", ...persona("Coder") }, 1), /exact resource context/);
  assert.equal(fs.existsSync(file(host)), false);
});

test("main Hara is one protected stable identity per scope with explicit Pi default and public brand", () => {
  const host = dir(), a = open(host), b = open(host, scope(wsB));
  const mainA = a.agents.initializeMain(), mainB = b.agents.initializeMain();
  assert.notEqual(mainA.agentId, mainB.agentId);
  assert.equal(mainA.runtime.id, "pi"); assert.equal(mainA.runtime.available, true); assert.equal(mainA.brand, "hara");
  const before = digest(file(host));
  assert.deepEqual(a.agents.initializeMain(persona("Do not replace main")), mainA);
  assert.equal(digest(file(host)), before);
  assert.equal(open(host).agents.list().mainAgentId, mainA.agentId);
  assert.throws(() => a.agents.setArchived(mainA.agentId, true, 1, 1), /main Hara cannot/);
  for (const username of ["main", "hara", "Hara", "../coder", "cÖder"]) {
    assert.throws(() => a.agents.create({ username, ...persona("Lookalike") }, 1), /invalid.*creation/);
  }
  assert.equal(a.agents.list().agents.length, 1);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(file(host)).mode & 0o777, 0o600);
    assert.equal(fs.statSync(owner(host)).mode & 0o777, 0o600);
    assert.equal(fs.statSync(state(host)).mode & 0o777, 0o700);
  }
});

test("same usernames and display names in A/B, authorities and regions never alias", () => {
  const host = dir(), authorities = [scope(), scope(wsB),
    scope(wsA, { kind: "local", localAuthorityId: "20000000-0000-4000-8000-000000000002" }),
    ...["CN", "GLOBAL"].map(accountRegion => scope(wsA, { kind: "account", accountRegion,
      issuer: "https://account.example.invalid", realmId: "30000000-0000-4000-8000-000000000001" }))];
  const resources = authorities.map(identity => open(host, identity));
  const agents = resources.map((r, i) => { r.agents.initializeMain(); return create(r, "coder", "Same name"); });
  const tasks = resources.map((r, i) => bind(r, agents[i]));
  assert.equal(new Set(agents.map(a => a.agentId)).size, agents.length);
  for (const [index, r] of resources.entries()) {
    assert.equal(r.agents.list().agents.length, 2);
    assert.equal(r.agents.resolveTask(tasks[index].workspaceAgentBinding).instructions, "Same name private instructions");
    for (const [other, task] of tasks.entries()) if (other !== index) {
      assert.throws(() => r.agents.resolveTask(task.workspaceAgentBinding), /resource scope/);
      assert.equal(r.agents.get(agents[other].agentId), null);
      assert.throws(() => r.agents.setRuntime(agents[other].agentId, "hara", 1, 1), /changed/);
    }
  }
  const duplicateDisplay = create(resources[0], "other", "Same name");
  assert.notEqual(duplicateDisplay.agentId, agents[0].agentId, "presentation names are not identity");
});

test("catalog projection never emits private persona, past snapshots, paths, hashes or grants", () => {
  const host = dir(), r = open(host); r.agents.initializeMain(persona("Hara", "private main sentinel"));
  const agent = create(r, "coder", "Coder"), task = bind(r, agent);
  const visible = JSON.stringify({ list: r.agents.list(), get: r.agents.get(agent.agentId) });
  for (const forbidden of ["private main sentinel", "Coder private instructions", "configurations", "configHash", "scopeKey", host, "apiKey", "instructions"]) {
    assert.ok(!visible.includes(forbidden), forbidden);
  }
  assert.equal(r.agents.resolveTask(task.workspaceAgentBinding).instructions, "Coder private instructions", "only the private host resolver receives the snapshot");
  assert.equal(isSensitiveFilePath(file(host)), true); assert.equal(isSensitiveFilePath(owner(host)), true);
  assert.equal(isSensitiveFilePath(join(host, ".hara", "workspace-data", "arbitrary", "snapshot.json")), true);
  assert.equal(isSensitiveFilePath(join(host, ".hara", "workspace-data", "arbitrary", "state", ".hara", "memory", "MEMORY.md")), true,
    "an inner .hara must not hide an outer private Workspace tree outside the ambient home");
});

test("Agent inputs cannot smuggle runtime, Host, tool, key or imported-role authority", () => {
  const host = dir(), r = open(host); r.agents.initializeMain();
  const before = digest(file(host));
  for (const extra of [{ hostId: "host" }, { agentId: "ag_fake" }, { allowTools: ["bash"] }, { apiKey: "synthetic" },
    { command: "ignored" }, { source: "org" }, { home: host }, { file: "/foreign.md" }]) {
    assert.throws(() => r.agents.create({ username: "coder", ...persona("Coder"), ...extra }, 1), /invalid.*creation/);
  }
  assert.throws(() => r.agents.create({ username: "coder", ...persona("Coder"), profile: { displayName: "Coder", apiKey: "synthetic" } }, 1), /persona input/);
  for (const runtimeId of ["codex", "claude", "opencode"]) {
    assert.throws(() => r.agents.create({ username: "coder", ...persona("Coder"), runtimeId }, 1), /not available.*no fallback/);
    assert.equal(r.agents.runtimeOptions().find(row => row.id === runtimeId).available, false);
  }
  assert.equal(digest(file(host)), before);
  assert.throws(() => r.agents.create({ username: "coder", ...persona("Coder", "x".repeat(32_001)) }, 1), /safe limits/);
});

test("configuration edits retain the exact old private snapshot across restart and freeze new tasks only", () => {
  const host = dir(), r = open(host); r.agents.initializeMain();
  const agent = create(r), original = bind(r, agent), binding = original.workspaceAgentBinding;
  assert.ok(Object.isFrozen(binding) && Object.isFrozen(binding.resourceBinding));
  const edited = r.agents.updatePersona(agent.agentId, persona("Renamed", "new persona sentinel"), 1, 1);
  const changed = r.agents.setRuntime(agent.agentId, "hara", 2, 1);
  assert.equal(edited.agentId, agent.agentId); assert.equal(changed.configRevision, 3); assert.equal(changed.agentEpoch, 1);
  const restarted = open(host), oldConfig = restarted.agents.resolveTask(binding);
  assert.equal(oldConfig.instructions, "Coder private instructions"); assert.equal(oldConfig.runtimeId, "pi");
  assert.equal(oldConfig.identity.displayName, "Coder"); assert.equal(Object.isFrozen(oldConfig.identity), true);
  const fresh = bind(restarted, changed);
  assert.equal(fresh.workspaceAgentBinding.runtimeId, "hara"); assert.equal(fresh.workspaceAgentBinding.configRevision, 3);
  assert.equal(restarted.agents.resolveTask(fresh.workspaceAgentBinding).instructions, "new persona sentinel");
  assert.throws(() => restarted.agents.bindTask(createTaskExecution("stale", "turn"), agent.agentId, 1, 1), /changed/);
  assert.throws(() => restarted.agents.setRuntime(agent.agentId, "pi", 1, 1), /changed/);
  assert.equal(original.runtimeBinding, undefined); assert.deepEqual(recoverTaskExecution(original).workspaceAgentBinding, binding);
});

test("archive and restore advance lifecycle independently, preserving history but never reviving old tasks", () => {
  const host = dir(), r = open(host); r.agents.initializeMain();
  const agent = create(r), task = bind(r, agent), sessionMeta = meta(task);
  r.sessions.save(sessionMeta, history, task);
  const archived = r.agents.setArchived(agent.agentId, true, 1, 1);
  assert.equal(archived.agentEpoch, 2); assert.equal(archived.configRevision, 1);
  assert.throws(() => r.agents.resolveTask(task.workspaceAgentBinding), /lifecycle/);
  assert.equal(r.sessions.load(sessionMeta.id).task.id, task.id, "archive must not hide retained transcript or provenance");
  assert.throws(() => create(r), /username is retained/);
  const restored = r.agents.setArchived(agent.agentId, false, 1, 2);
  assert.equal(restored.agentId, agent.agentId); assert.equal(restored.agentEpoch, 3);
  assert.throws(() => r.agents.resolveTask(task.workspaceAgentBinding), /lifecycle/);
  assert.throws(() => r.agents.setArchived(agent.agentId, true, 1, 1), /changed/);
  assert.equal(r.agents.resolveTask(bind(r, restored).workspaceAgentBinding).instructions, "Coder private instructions");
  assert.equal(open(host).sessions.load(sessionMeta.id).history[0].content, history[0].content);
});

test("strict provenance rejects malformed, future, dual and widened bindings without changing the task", () => {
  const r = open(); const main = r.agents.initializeMain(), task = bind(r, main), binding = task.workspaceAgentBinding;
  assert.equal(isTaskExecution(task), true); assert.equal(isWorkspaceAgentTaskBinding(binding), true);
  for (const replacement of [{ ...binding, schemaVersion: 2 }, { ...binding, hostGrant: "invented" }, { ...binding, runtimeId: "other" },
    { ...binding, agentEpoch: 0 }, { ...binding, configRevision: -1 }, { ...binding, configHash: "incorrect" },
    { ...binding, resourceBinding: { ...binding.resourceBinding, extra: true } }, { ...binding, taskId: "wrong-task" }]) {
    assert.equal(isTaskExecution({ ...task, workspaceAgentBinding: replacement }), false);
  }
  const legacy = freezeTaskRuntimeBinding({ version: 1, spaceId: "personal", agentRef: "main", runtimeId: "hara", revision: 0 }, task.id);
  assert.equal(isTaskExecution({ ...task, runtimeBinding: legacy }), false);
  assert.throws(() => r.agents.bindTask(task, main.agentId, 1, 1), /unbound/);
  assert.throws(() => freezeWorkspaceAgentTaskBinding({ ...binding, apiKey: "synthetic" }), /invalid/);
  assert.throws(() => forkTaskExecution(task), /explicit scoped admission/);
  assert.deepEqual(task.workspaceAgentBinding, binding);
});

test("scoped Session and real SessionHub persist exact provenance, rejecting cross-Agent/scope/task writes", () => {
  const host = dir(), a = open(host), b = open(host, scope(wsB));
  const mainA = a.agents.initializeMain(), mainB = b.agents.initializeMain();
  const taskA = bind(a, mainA), taskB = bind(b, mainB), metaA = meta(taskA), metaB = meta(taskB, metaA.cwd);
  a.sessions.save(metaA, history, taskA); b.sessions.save(metaB, history, taskB);
  const transcriptA = join(state(host), "sessions", `${metaA.id}.json`), transcriptB = join(state(host, scope(wsB)), "sessions", `${metaB.id}.json`);
  const beforeA = digest(transcriptA), beforeB = digest(transcriptB);
  const loaded = a.sessions.load(metaA.id), originalMeta = structuredClone(loaded.meta);
  assert.deepEqual(loaded.task.workspaceAgentBinding, taskA.workspaceAgentBinding);
  const hub = new SessionHub(a.sessions);
  assert.equal(hub.list()[0].workspaceAgentId, mainA.agentId);
  for (const [metadata, task] of [
    [{ ...originalMeta, workspaceAgentId: mainB.agentId }, taskA], [originalMeta, taskB],
    [originalMeta, { ...taskA, workspaceAgentBinding: { ...taskA.workspaceAgentBinding, workspaceId: wsB } }],
    [originalMeta, { ...taskA, workspaceAgentBinding: { ...taskA.workspaceAgentBinding, taskId: "other-task" } }],
    [originalMeta, { ...taskA, workspaceAgentBinding: undefined }],
    [{ ...originalMeta, agentRef: "global:coder" }, taskA],
  ]) assert.throws(() => a.sessions.save(metadata, history, task), /Workspace Agent task audience/);
  assert.equal(digest(transcriptA), beforeA); assert.equal(digest(transcriptB), beforeB);
  assert.throws(() => saveSession(originalMeta, history, taskA), /Workspace-bound sessions/);
  assert.equal(loadSession(metaA.id), null);
  const corrupt = JSON.parse(fs.readFileSync(transcriptA, "utf8"));
  corrupt.task.workspaceAgentBinding.workspaceId = wsB; privateWrite(transcriptA, corrupt);
  assert.equal(a.sessions.load(metaA.id), null, "read validation must also reject forged Workspace attribution");
});

test("all legacy execution/admission routes refuse valid, malformed, future or dual Workspace provenance before model/tools", async () => {
  const r = open(), main = r.agents.initializeMain(), task = bind(r, main), home = dir();
  let modelCalls = 0, driverCalls = 0;
  const options = current => ({ ctx: { cwd: home, spaceId: "personal", sandbox: "off" },
    provider: { id: "synthetic", model: "fixture", async turn() { modelCalls++; return { text: "must not run", toolUses: [], stop: "end" }; } },
    confirm: async () => false, approval: "suggest", approvalChannel: false, quiet: true, hooks: false,
    taskIntake: { task: current }, maxRounds: 1 });
  for (const newBinding of [task.workspaceAgentBinding, {}, { ...task.workspaceAgentBinding, schemaVersion: 2 },
    { ...task.workspaceAgentBinding, hostGrant: "invented" }]) {
    const current = { ...task, workspaceAgentBinding: newBinding }, opts = options(current);
    for (const runner of [runAgent, runPiAgent, runConfiguredAgent]) {
      const messages = structuredClone(history), before = JSON.stringify(messages);
      const result = await runner(messages, opts);
      assert.equal(result.status, "error"); assert.match(result.error, /Workspace Agent execution is not enabled/);
      assert.equal(JSON.stringify(messages), before);
    }
    assert.throws(() => bindNewAgentTask(current, "personal", "main", home), /Workspace Agent execution is not enabled/);
    const legacy = freezeTaskRuntimeBinding({ version: 1, spaceId: "personal", agentRef: "main", runtimeId: "hara", revision: 0 }, current.id);
    const registry = new AgentRuntimeRegistry([{ id: "hara", async run() { driverCalls++; return { status: "completed" }; } }]);
    assert.throws(() => registry.run([], options({ ...current, runtimeBinding: legacy }), legacy), /Workspace Agent execution is not enabled/);
  }
  const opts = options(task); opts.taskIntake.current = () => ({ ...task, workspaceAgentBinding: undefined });
  assert.equal((await runConfiguredAgent(structuredClone(history), opts)).status, "error", "a current() callback cannot hide the initial binding");
  assert.equal(modelCalls, 0); assert.equal(driverCalls, 0);
});

test("an existing scoped Agent transcript cannot remove or reassign its owner, even within the same Workspace", () => {
  const host = dir(), r = open(host), main = r.agents.initializeMain(), colleague = create(r), task = bind(r, main), saved = meta(task);
  r.sessions.save(saved, history, task);
  const original = r.sessions.load(saved.id), transcript = join(state(host), "sessions", `${saved.id}.json`), before = digest(transcript);
  const otherTask = bind(r, colleague);
  const journalBefore = JSON.stringify(r.sessions.readJournal(saved.id));
  assert.throws(() => r.sessions.save({ ...original.meta, workspaceAgentId: undefined }, history), /Agent.*owner|affiliation/);
  assert.throws(() => r.sessions.save({ ...original.meta, workspaceAgentId: colleague.agentId }, history, otherTask), /Agent.*owner|affiliation/);
  assert.equal(digest(transcript), before); assert.equal(JSON.stringify(r.sessions.readJournal(saved.id)), journalBefore);
  const unowned = { ...saved, id: "initially-unowned", workspaceAgentId: undefined, resourceBinding: undefined };
  r.sessions.save(unowned, history);
  assert.throws(() => r.sessions.save({ ...r.sessions.load(unowned.id).meta, workspaceAgentId: main.agentId }, history, task), /Agent.*owner|affiliation/);
});

test("SessionHub refuses taskless scoped-Agent forks before creating a legacy session or lock", () => {
  const host = dir(), r = open(host), main = r.agents.initializeMain(), task = bind(r, main), saved = meta(task);
  r.sessions.save(saved, history);
  const before = fs.readdirSync(join(state(host), "sessions")).sort(), transcript = join(state(host), "sessions", `${saved.id}.json`), hash = digest(transcript);
  const hub = new SessionHub(r.sessions);
  assert.throws(() => hub.fork(saved.id, { provider: { id: "synthetic", model: "synthetic-model" }, providerId: "openai", approval: "suggest" }), /scoped.*fork|Workspace Agent.*fork/);
  assert.deepEqual(fs.readdirSync(join(state(host), "sessions")).sort(), before);
  assert.equal(digest(transcript), hash); assert.equal(r.sessions.list().length, 1);
});

test("a same-Workspace Agent cannot replace another Agent's existing transcript owner and task together", () => {
  const host = dir(), r = open(host), main = r.agents.initializeMain(), colleague = create(r), original = bind(r, main), saved = meta(original);
  r.sessions.save(saved, history, original);
  const loaded = r.sessions.load(saved.id), target = join(state(host), "sessions", `${saved.id}.json`), before = digest(target);
  assert.throws(() => r.sessions.save({ ...loaded.meta, workspaceAgentId: colleague.agentId }, history, bind(r, colleague)), /Agent.*owner|affiliation/);
  assert.equal(digest(target), before);
});

test("taskless scoped-Agent resume is refused without hiding readable history or retaining a live lock", () => {
  const host = dir(), r = open(host), main = r.agents.initializeMain(), saved = meta(bind(r, main));
  r.sessions.save(saved, history);
  const target = join(state(host), "sessions", `${saved.id}.json`), before = digest(target), hub = new SessionHub(r.sessions);
  assert.throws(() => hub.resume(saved.id, { provider: { id: "synthetic", model: "synthetic-model" }, approval: "suggest" }), /Workspace Agent.*scoped admission/);
  assert.equal(hub.get(saved.id), undefined); assert.equal(digest(target), before);
  assert.equal(r.sessions.load(saved.id).history[0].content, history[0].content);
  assert.equal(fs.existsSync(join(state(host), "sessions", `${saved.id}.lock`)), false);
});

test("publication locks cannot collide with a legal live Session ID", () => {
  const host = dir(), r = open(host), main = r.agents.initializeMain(), task = bind(r, main), saved = meta(task);
  const oldCollision = `workspace-owner-${createHash("sha256").update(saved.id).digest("hex")}`;
  assert.equal(r.sessions.acquire(oldCollision).ok, true);
  try {
    assert.doesNotThrow(() => r.sessions.save(saved, history, task));
    assert.equal(r.sessions.load(saved.id).meta.workspaceAgentId, main.agentId);
    assert.equal(fs.existsSync(join(state(host), "sessions", `${oldCollision}.lock`)), true, "publication must not consume an unrelated live lock");
  } finally { r.sessions.release(oldCollision); }
});

test("private memory inventory is bounded and unforgeable by public options or a foreign resource context", async () => {
  const host = dir(), cwd = dir(), a = open(host), b = open(host, scope(wsB));
  await a.memory.append("global", "memory", "private inventory sentinel", cwd);
  await a.memory.append("global", "user", "bounded inventory fact", cwd);
  const rootA = join(state(host), "memory", "global"), rootB = join(state(host, scope(wsB)), "memory", "global");
  b.memory.roots(cwd);
  assert.deepEqual(walkFiles(rootA), [], "generic tool walker remains denied outside the ambient home");
  const storageA = new WorkspaceResourceStorage(host, scope()), storageB = new WorkspaceResourceStorage(host, scope(wsB));
  storageA.initialize(); storageB.initialize();
  const permit = storageA.run(() => workspaceMemoryWalkOptions(rootA));
  assert.throws(() => walkFiles(rootA, 10, permit), /another resource context/);
  assert.throws(() => storageB.run(() => walkFiles(rootA, 10, permit)), /another resource context/);
  assert.throws(() => storageA.run(() => walkFiles(rootB, 10, permit)), /another root/);
  assert.deepEqual(storageA.run(() => walkFiles(rootA, 10, { ...permit })), [], "copying public options cannot copy the private identity permit");
  assert.throws(() => storageA.run(() => workspaceMemoryWalkOptions(state(host))), /exact bound memory bucket/);
  const inventory = await storageA.run(() => walkFilesAsync(rootA, workspaceMemoryWalkOptions(rootA, { maxFiles: 1 })));
  assert.equal(inventory.files.length, 1); assert.equal(inventory.reason, "file_limit");
  const cancelled = new AbortController(); cancelled.abort(new Error("synthetic inventory cancelled"));
  await assert.rejects(storageA.run(() => walkFilesAsync(rootA, workspaceMemoryWalkOptions(rootA, { signal: cancelled.signal }))), /inventory cancelled/);
  assert.ok((await a.memory.search("inventory", cwd)).some(hit => hit.snippet.includes("sentinel")));
});

test("missing, foreign, corrupt or future catalog/owner never repairs or adopts old roles", () => {
  for (const mutate of [
    (host) => fs.unlinkSync(file(host)), (host) => fs.unlinkSync(owner(host)),
    (host) => privateWrite(file(host), "{bad json"),
    (host) => { const raw = JSON.parse(fs.readFileSync(file(host), "utf8")); raw.schemaVersion = 2; privateWrite(file(host), raw); },
    (host) => { const raw = JSON.parse(fs.readFileSync(file(host), "utf8")); raw.agents[0].configurations[0].instructions = "tampered without digest"; privateWrite(file(host), raw); },
    (host) => { const raw = JSON.parse(fs.readFileSync(owner(host), "utf8")); raw.mainAgentId = "ag_99999999-0000-4000-8000-000000000001"; privateWrite(owner(host), raw); },
  ]) {
    const host = dir(), r = open(host); r.agents.initializeMain(); mutate(host);
    const surviving = [file(host), owner(host)].filter(fs.existsSync).map(target => [target, digest(target)]);
    for (const resources of [r, open(host)]) {
      assert.throws(() => resources.agents.list(), /invalid|unsupported|missing|mismatch/);
      assert.throws(() => resources.agents.initializeMain(), /invalid|unsupported|missing|mismatch/);
    }
    for (const [target, before] of surviving) assert.equal(digest(target), before);
  }
  const host = dir(), a = open(host), b = open(host, scope(wsB));
  a.agents.initializeMain(); b.agents.initializeMain();
  privateWrite(file(host), fs.readFileSync(file(host, scope(wsB)), "utf8"));
  assert.throws(() => a.agents.list(), /invalid/);
});

test("retained configuration capacity never evicts a referenced old snapshot", () => {
  const host = dir(), r = open(host); let agent = r.agents.initializeMain(), task = bind(r, agent);
  for (let revision = 1; revision < 64; revision++) agent = r.agents.setRuntime(agent.agentId, revision % 2 ? "hara" : "pi", revision, 1);
  const before = digest(file(host));
  assert.throws(() => r.agents.setRuntime(agent.agentId, "pi", 64, 1), /history is full/);
  assert.equal(digest(file(host)), before);
  assert.equal(open(host).agents.resolveTask(task.workspaceAgentBinding).runtimeId, "pi");
});

test("two real host processes CAS the same Agent configuration; one loses without altering the other", async () => {
  const host = dir(), r = open(host), main = r.agents.initializeMain();
  const script = `import { WorkspaceResources } from ${JSON.stringify(new URL("../dist/workspace/resources.js", import.meta.url).href)};
    const r = new WorkspaceResources(process.argv[1], JSON.parse(process.argv[2])); r.initialize();
    try { r.agents.setRuntime(process.argv[3], "hara", 1, 1); process.stdout.write("updated"); }
    catch (error) { if (!/changed/.test(error.message)) throw error; process.stdout.write("stale"); }`;
  const childEnv = { PATH: process.env.PATH, HOME: host, USERPROFILE: host, TMPDIR: tmpdir(),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}) };
  const child = () => promisify(execFile)(process.execPath, ["--input-type=module", "-e", script, host, JSON.stringify(scope()), main.agentId], { env: childEnv, timeout: 30_000 });
  const outputs = await Promise.all([child(), child()]);
  assert.deepEqual(outputs.map(result => result.stdout).sort(), ["stale", "updated"]);
  assert.equal(open(host).agents.get(main.agentId).configRevision, 2);
});

test("two real host processes cannot first-publish the same Session ID for different scoped Agents", async () => {
  const host = dir(), r = open(host), main = r.agents.initializeMain(), colleague = create(r), cwd = dir();
  const tasks = [bind(r, main), bind(r, colleague)];
  const script = `import { WorkspaceResources } from ${JSON.stringify(new URL("../dist/workspace/resources.js", import.meta.url).href)};
    const r = new WorkspaceResources(process.argv[1], JSON.parse(process.argv[2])); r.initialize();
    const task=JSON.parse(process.argv[4]);
    try { r.sessions.save(JSON.parse(process.argv[3]), [{role:"user",content:task.workspaceAgentBinding.agentId}], task); process.stdout.write("saved"); }
    catch (error) { if (!/owner affiliation/.test(error.message)) throw error; process.stdout.write("refused"); }`;
  const childEnv = { PATH: process.env.PATH, HOME: host, USERPROFILE: host, TMPDIR: tmpdir(),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}) };
  const child = task => promisify(execFile)(process.execPath, ["--input-type=module", "-e", script, host, JSON.stringify(scope()),
    JSON.stringify({ ...meta(task, cwd, "simultaneous-first-session"), resourceBinding: task.workspaceAgentBinding.resourceBinding }),
    JSON.stringify(task)], { env: childEnv, timeout: 30_000 });
  const outputs = await Promise.all(tasks.map(child));
  assert.deepEqual(outputs.map(result => result.stdout).sort(), ["refused", "saved"]);
  const saved = open(host).sessions.load("simultaneous-first-session");
  assert.equal(saved.meta.workspaceAgentId, saved.task.workspaceAgentBinding.agentId);
  assert.equal(saved.history[0].content, saved.meta.workspaceAgentId);
  assert.equal(r.sessions.list().length, 1);
});

test("late generation denial after staging open writes no replacement persona", () => {
  const host = dir(), r = open(host), main = r.agents.initializeMain(), before = digest(file(host));
  const marker = join(dirname(dirname(state(host))), "scope.json"), originalMarker = fs.readFileSync(marker, "utf8");
  const original = fs.openSync; let fired = false;
  fs.openSync = function(target, ...args) {
    const fd = original.call(this, target, ...args);
    if (!fired && typeof target === "string" && dirname(target) === state(host) && target.includes(".hara-private-")) {
      fired = true; const raw = JSON.parse(originalMarker); raw.generation = "40000000-0000-4000-8000-000000000001"; privateWrite(marker, raw);
    }
    return fd;
  };
  syncBuiltinESMExports();
  try { assert.throws(() => r.agents.updatePersona(main.agentId, persona("Blocked", "never publish this persona"), 1, 1), /scope marker changed/); }
  finally { fs.openSync = original; syncBuiltinESMExports(); privateWrite(marker, originalMarker); }
  assert.equal(fired, true); assert.equal(digest(file(host)), before);
  for (const name of fs.readdirSync(state(host)).filter(name => name.startsWith(".hara-private-"))) {
    assert.equal(fs.readFileSync(join(state(host), name), "utf8"), "", "no body written before the post-open fence");
  }
});

test("owner-marker change after claiming catalog restores the exact old catalog, without new persona", () => {
  const host = dir(), r = open(host), main = r.agents.initializeMain(), before = digest(file(host)), originalOwner = fs.readFileSync(owner(host), "utf8");
  const original = fs.renameSync; let fired = false;
  fs.renameSync = function(from, to) {
    const result = original.call(this, from, to);
    if (!fired && from === file(host) && to.includes(".hara-claim-")) {
      fired = true; const raw = JSON.parse(originalOwner); raw.mainAgentId = "ag_99999999-0000-4000-8000-000000000001"; privateWrite(owner(host), raw);
    }
    return result;
  };
  syncBuiltinESMExports();
  try { assert.throws(() => r.agents.updatePersona(main.agentId, persona("Blocked", "never publish after claim"), 1, 1), /invalid|unsupported/); }
  finally { fs.renameSync = original; syncBuiltinESMExports(); privateWrite(owner(host), originalOwner); }
  assert.equal(fired, true); assert.equal(digest(file(host)), before);
  assert.equal(r.agents.get(main.agentId).configRevision, 1);
});

test("catalog hard-links and parent aliases fail without mutating the foreign Workspace", () => {
  const host = dir(), a = open(host), b = open(host, scope(wsB)); a.agents.initializeMain(); b.agents.initializeMain();
  const beforeB = digest(file(host, scope(wsB))), held = join(host, "retained-a-catalog.json");
  fs.renameSync(file(host), held); fs.linkSync(file(host, scope(wsB)), file(host));
  assert.throws(() => a.agents.list(), /hard.link|multiple links/);
  assert.throws(() => a.agents.initializeMain(), /hard.link|multiple links/);
  fs.unlinkSync(file(host)); fs.renameSync(held, file(host));
  const heldDir = join(host, "retained-a-state"); fs.renameSync(state(host), heldDir);
  fs.symlinkSync(state(host, scope(wsB)), state(host), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => a.agents.list(), /directory identity changed|real directory/);
  assert.equal(digest(file(host, scope(wsB))), beforeB);
});
