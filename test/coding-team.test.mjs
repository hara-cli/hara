import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { AgentTeamStore, DurableAgentTeam } from "../dist/subagent/team.js";
import { getTool } from "../dist/tools/registry.js";
import "../dist/tools/collaboration.js";

const coding = ["opencode", "pi", "codex", "claude"];
const providerId = (runtime, digit = "a") => `ext_${runtime}_${digit.repeat(24)}`;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function workspaceManager() {
  const counts = { prepare: 0 };
  const workspaceId = id => "aw_" + createHash("sha256").update(id).digest("hex").slice(0, 40);
  return { counts, sourceCwd: "/synthetic/source", assertWorkspaceId(id, actual) { assert.equal(actual, workspaceId(id)); },
    prepare(id) { counts.prepare++; return { ownerAgentId: id, workspaceId: workspaceId(id), baseCommit: "b".repeat(40), path: `/synthetic/worktree/${id}`, cwd: `/synthetic/worktree/${id}` }; },
    capture(id, baseCommit) { return { ownerAgentId: id, workspaceId: workspaceId(id), baseCommit, changedPaths: [], patchBytes: 0, patchSha256: "c".repeat(64), patch: "" }; },
  };
}
function fixture(t, executor, options = {}) {
  const home = mkdtempSync(join(tmpdir(), "hara-coding-team-"));
  const store = new AgentTeamStore(home);
  const manager = workspaceManager();
  const runs = [];
  const team = new DurableAgentTeam({ sessionId: "coding-team-fixture", store, executor, worktreeManager: manager,
    codingRuntimes: coding, onRun(run) { runs.push(run); void run.catch(() => {}); }, ...options });
  t.after(async () => { team.close(); await Promise.allSettled(runs); rmSync(home, { recursive: true, force: true }); });
  return { team, store, manager, sessionId: "coding-team-fixture", root: team.controller(), runs };
}
function untilReleased(request, wait) {
  return new Promise(resolve => {
    const done = () => { request.signal.removeEventListener("abort", done); resolve(); };
    if (request.signal.aborted) return done();
    request.signal.addEventListener("abort", done, { once: true });
    void wait.promise.then(done);
  });
}

for (const runtime of coding) {
  test(`${runtime}: provider identity is durable before any unfinished dispatch and survives follow-up`, async (t) => {
    const entered = deferred(); const release = deferred(); const requests = [];
    const state = fixture(t, async request => {
      requests.push(request);
      request.bindProviderSession(providerId(runtime));
      request.bindProviderSession(providerId(runtime));
      assert.equal(state.store.load(state.sessionId).agents.find(a => a.id === request.id).providerSessionId, providerId(runtime));
      entered.resolve();
      if (request.generation === 1) await untilReleased(request, release);
      return { status: "completed", text: "safe completion", providerSessionId: providerId(runtime) };
    });
    const child = await state.root.spawn({ taskName: "coding", message: "bounded work", runtime });
    await entered.promise;
    assert.equal(state.team.list()[0].status, "working");
    assert.equal(state.team.list()[0].providerSessionId, providerId(runtime));
    release.resolve(); await state.root.wait(child.id, 1_000);
    await state.root.followup(child.id, "continue explicitly"); await state.root.wait(child.id, 1_000);
    assert.equal(requests.length, 2);
    assert.equal(requests[1].providerSessionId, providerId(runtime));
    assert.equal(state.store.load(state.sessionId).agents[0].runtime, runtime);
  });
}

test("binding rejects native ids, a different runtime, replacement and late completion", async (t) => {
  let request; const release = deferred();
  const state = fixture(t, async value => { request = value; await untilReleased(value, release); return { status: "completed", text: "safe" }; });
  const child = await state.root.spawn({ taskName: "bound", message: "bounded", runtime: "opencode" });
  for (const id of ["raw-native-thread", providerId("codex"), "ext_opencode_" + "g".repeat(24), null]) {
    assert.throws(() => request.bindProviderSession(id), /binding is invalid/);
  }
  request.bindProviderSession(providerId("opencode"));
  assert.throws(() => request.bindProviderSession(providerId("opencode", "d")), /cannot be replaced/);
  assert.equal(state.store.load(state.sessionId).agents[0].providerSessionId, providerId("opencode"));
  release.resolve(); await state.root.wait(child.id, 1_000);
  assert.throws(() => request.bindProviderSession(providerId("opencode")), /no longer current/);
});

test("Hara generations cannot bind an external provider identity", async (t) => {
  let denied = false;
  const state = fixture(t, async request => {
    assert.throws(() => request.bindProviderSession(providerId("pi")), /binding is invalid/); denied = true;
    return { status: "completed", text: "read only" };
  });
  const child = await state.root.spawn({ taskName: "native", message: "review" });
  await state.root.wait(child.id, 1_000); assert.equal(denied, true);
  assert.equal(state.manager.counts.prepare, 0);
});

test("a mismatched final result cannot replace the early durable binding", async (t) => {
  const state = fixture(t, async request => {
    request.bindProviderSession(providerId("pi"));
    return { status: "completed", text: "must not be published", providerSessionId: providerId("pi", "e") };
  });
  const child = await state.root.spawn({ taskName: "identity", message: "bounded", runtime: "pi" });
  const result = await state.root.wait(child.id, 1_000);
  assert.equal(result.agent.status, "failed"); assert.equal(result.result, undefined);
  assert.equal(result.agent.providerSessionId, providerId("pi"));
  assert.match(result.error, /invalid or replaced provider session/);
});

test("reserve is read-only; only reserved, confirmed input is acknowledged exactly once", async (t) => {
  const release = deferred(); const events = []; let request;
  const state = fixture(t, async value => { request = value; await untilReleased(value, release); return { status: "completed", text: "safe" }; }, { onMailbox: event => events.push(event) });
  const child = await state.root.spawn({ taskName: "mail", message: "bounded", runtime: "codex" });
  await state.root.sendMessage(child.id, "first input"); await state.root.sendMessage(child.id, "second input");
  const revision = state.store.load(state.sessionId).revision;
  const input = await request.reserveInput();
  assert.equal(input.length, 2);
  assert.deepEqual(await request.reserveInput(), input);
  assert.equal(state.store.load(state.sessionId).revision, revision);
  assert.equal(state.team.list()[0].pendingMessages, 2);
  assert.equal(events.filter(e => e.state !== "queued").length, 0);
  await assert.rejects(request.acknowledgeInput("00000000-0000-4000-8000-000000000001"), /not reserved/);
  await request.acknowledgeInput(input[0].id); await request.acknowledgeInput(input[0].id);
  assert.equal(state.team.list()[0].pendingMessages, 1);
  assert.equal(events.filter(e => e.state === "started").length, 1);
  assert.equal(events.filter(e => e.state === "completed").length, 1);
  assert.deepEqual(await request.pendingInput(), [input[1]], "legacy external pendingInput does not auto-ACK");
  release.resolve(); await state.root.wait(child.id, 1_000);
  assert.equal(state.team.list()[0].pendingMessages, 1);
});

test("initial mail ids are immutable and match the exact prompt snapshot, not admission-time arrivals",async t=>{
  const requests=[];let injected;const state=fixture(t,async request=>{requests.push(request);return {status:"completed",text:"safe"};});
  const child=await state.root.spawn({taskName:"snapshot",message:"initial task",runtime:"pi"});await state.root.wait(child.id,1_000);
  assert.deepEqual(requests[0].initialInputIds,[]);assert.equal(Object.isFrozen(requests[0].initialInputIds),true);
  await state.root.sendMessage(child.id,"ordinary accepted context");
  const originalPrepare=state.manager.prepare;state.manager.prepare=(id,...args)=>{injected=state.root.sendMessage(id,"arrived during admission");return originalPrepare(id,...args);};
  await state.root.followup(child.id,"follow-up accepted context");await injected;await state.root.wait(child.id,1_000);
  const request=requests[1];const mailbox=state.store.load(state.sessionId).agents[0].mailbox;
  assert.match(request.task,/ordinary accepted context/);assert.match(request.task,/follow-up accepted context/);
  assert.doesNotMatch(request.task,/arrived during admission/);
  assert.deepEqual(request.initialInputIds,mailbox.filter(message=>message.content!=="arrived during admission").map(message=>message.id));
  assert.equal(Object.isFrozen(request.initialInputIds),true);assert.throws(()=>request.initialInputIds.push("forged"),TypeError);
  assert.equal(state.team.list()[0].pendingMessages,3,"capturing the prompt does not acknowledge any delivery");
});

test("no ACK is accepted before reserve, after interruption, or from an earlier generation", async (t) => {
  const requests = []; const release = deferred();
  const state = fixture(t, async request => { requests.push(request); await untilReleased(request, release); return { status: "completed", text: "safe" }; });
  const child = await state.root.spawn({ taskName: "fenced", message: "bounded", runtime: "claude" });
  await state.root.sendMessage(child.id, "pending input");
  const messageId = state.store.load(state.sessionId).agents[0].mailbox[0].id;
  await assert.rejects(requests[0].acknowledgeInput(messageId), /not reserved/);
  await requests[0].reserveInput();
  await state.root.interrupt(child.id); await state.root.wait(child.id, 1_000);
  await assert.rejects(requests[0].acknowledgeInput(messageId), /no longer current/);
  await assert.rejects(requests[0].reserveInput(), /no longer current/);
  assert.throws(() => requests[0].bindProviderSession(providerId("claude")), /no longer current/);
  await state.root.followup(child.id, "new explicit action");
  assert.equal(requests.length, 2);
  await assert.rejects(requests[0].acknowledgeInput(messageId), /no longer current/);
  assert.equal(state.team.list()[0].pendingMessages, 2);
  release.resolve(); await state.root.wait(child.id, 1_000);
});

test("authoritative root-turn loss invalidates reserve, ACK and provider binding without mutation", async (t) => {
  let rootTurn = "turn-a"; let request; const release = deferred();
  const state = fixture(t, async value => { request = value; await untilReleased(value, release); return { status: "completed", text: "safe" }; }, { currentRootTurnId: () => rootTurn });
  const root = state.team.controller("/root", { parentTurnId: rootTurn, rootTurnId: rootTurn });
  const child = await root.spawn({ taskName: "turn", message: "bounded", runtime: "pi" });
  await root.sendMessage(child.id, "pending"); const [message] = await request.reserveInput();
  const revision = state.store.load(state.sessionId).revision;
  for (const next of ["turn-b", undefined]) {
    rootTurn = next;
    await assert.rejects(request.reserveInput(), /no longer current/);
    await assert.rejects(request.acknowledgeInput(message.id), /no longer current/);
    assert.throws(() => request.bindProviderSession(providerId("pi")), /no longer current/);
  }
  assert.equal(state.store.load(state.sessionId).revision, revision);
  rootTurn = "turn-a"; release.resolve(); await root.wait(child.id, 1_000);
});

test("external follow-up input stays pending after failure, with no start-of-run ACK or automatic resubmit", async (t) => {
  let executions = 0; const batches = [];
  const state = fixture(t, async request => {
    executions++; batches.push(await request.reserveInput());
    return { status: request.generation === 1 ? "completed" : "error", text: "", error: "unsupported steer" };
  });
  const child = await state.root.spawn({ taskName: "no_retry", message: "bounded", runtime: "opencode" });
  await state.root.wait(child.id, 1_000);
  await state.root.followup(child.id, "explicit second action"); await state.root.wait(child.id, 1_000); await tick();
  assert.equal(executions, 2); assert.equal(batches[1].length, 1);
  assert.equal(state.team.list()[0].pendingMessages, 1);
  assert.equal(state.store.load(state.sessionId).agents[0].mailbox[0].state, "pending");
});

test("Hara pendingInput preserves its automatic delivery contract", async (t) => {
  const release = deferred(); let request;
  const state = fixture(t, async value => { request = value; await untilReleased(value, release); return { status: "completed", text: "safe" }; });
  const child = await state.root.spawn({ taskName: "native_mail", message: "read only" });
  await state.root.sendMessage(child.id, "native boundary input");
  assert.equal((await request.pendingInput()).length, 1);
  assert.equal(state.team.list()[0].pendingMessages, 0);
  assert.equal((await request.pendingInput()).length, 0);
  release.resolve(); await state.root.wait(child.id, 1_000);
});

test("host runtime withdrawal refuses new spawn/follow-up/resume without queue or worktree side effects", async (t) => {
  let allowed = [...coding]; let executions = 0;
  const state = fixture(t, async () => { executions++; return { status: "completed", text: "safe" }; }, { codingRuntimes: () => allowed });
  const child = await state.root.spawn({ taskName: "policy", message: "bounded", runtime: "opencode" });
  await state.root.wait(child.id, 1_000);
  allowed = [];
  const snapshot = state.store.load(state.sessionId);
  const prepares = state.manager.counts.prepare;
  await assert.rejects(state.root.spawn({ taskName: "forbidden", message: "bounded", runtime: "pi" }), /unavailable/);
  await assert.rejects(state.root.followup(child.id, "must not queue"), /no longer available/);
  assert.equal(state.store.load(state.sessionId).revision, snapshot.revision);
  state.store.update(state.sessionId, draft => { draft.agents[0].status = "interrupted"; });
  const resumed = new DurableAgentTeam({sessionId:state.sessionId,store:state.store,codingRuntimes:()=>allowed,
    worktreeManager:state.manager,executor:async()=>{executions++;return {status:"completed",text:"unsafe"};}});
  t.after(()=>resumed.close());
  await assert.rejects(resumed.controller().resume(child.id), /no longer available/);
  assert.equal(state.manager.counts.prepare, prepares); assert.equal(executions, 1);
});

test("a grant withdrawn while queued never prepares a worktree or dispatches", async (t) => {
  let allowed = [...coding]; let executions = 0;
  const state = fixture(t, async () => { executions++; return { status: "completed", text: "unsafe" }; }, {
    codingRuntimes: () => allowed, onChange(agent) { if (agent.status === "queued") allowed = []; },
  });
  const child = await state.root.spawn({ taskName: "queued", message: "bounded", runtime: "pi" });
  await state.root.wait(child.id, 1_000);
  assert.equal(state.team.list()[0].status, "failed");
  assert.equal(executions, 0); assert.equal(state.manager.counts.prepare, 0);
});

test("a grant withdrawn during workspace preparation stops before the executor boundary", async (t) => {
  let allowed = [...coding]; let executions = 0;
  const manager = workspaceManager(); const prepare = manager.prepare;
  manager.prepare = id => { const result = prepare(id); allowed = []; return result; };
  const state = fixture(t, async () => { executions++; return { status: "completed", text: "unsafe" }; }, { codingRuntimes: () => allowed, worktreeManager: manager });
  const child = await state.root.spawn({ taskName: "pre_dispatch", message: "bounded", runtime: "opencode" });
  await state.root.wait(child.id, 1_000);
  assert.equal(state.team.list()[0].status, "failed"); assert.equal(executions, 0);
});

test("parent grant withdrawal is checked from locked current state before binding or ACK", async (t) => {
  let request; const release = deferred();
  const state = fixture(t, async value => { if (value.runtime === "hara") return { status: "completed", text: "review" };
    request = value; await untilReleased(value, release); return { status: "completed", text: "safe" }; });
  const parent = await state.root.spawn({ taskName: "parent", message: "coordinate", runtimeGrants: ["pi"] });
  await state.root.wait(parent.id, 1_000);
  const child = await state.team.controller(parent.path).spawn({ taskName: "child", message: "bounded", runtime: "pi" });
  await state.root.sendMessage(child.id, "pending"); const [input] = await request.reserveInput();
  state.store.update(state.sessionId, draft => { draft.agents.find(a => a.id === parent.id).runtimeGrants = []; });
  assert.throws(() => request.bindProviderSession(providerId("pi")), /grant was withdrawn/);
  await assert.rejects(request.acknowledgeInput(input.id), /grant was withdrawn/);
  assert.equal(state.store.load(state.sessionId).agents.find(a => a.id === child.id).mailbox[0].state, "pending");
  release.resolve(); await state.root.wait(child.id, 1_000);
});

test("four grants normalize and inherit, but coding children and ordinary children cannot re-grant", async (t) => {
  const state = fixture(t, async () => ({ status: "completed", text: "safe" }));
  const parent = await state.root.spawn({ taskName: "parent", message: "coordinate" }); await state.root.wait(parent.id, 1_000);
  assert.deepEqual(parent.runtimeGrants, coding);
  const scoped = state.team.controller(parent.path);
  assert.deepEqual(scoped.runtimeGrants, coding);
  await assert.rejects(scoped.spawn({taskName:"regant",message:"bad",runtimeGrants:["pi"]}), /Only \/root/);
  await assert.rejects(state.root.spawn({taskName:"external_grant",message:"bad",runtime:"pi",runtimeGrants:["codex"]}), /cannot re-delegate/);
  for (const runtime of ["auto","coding","runtime","unknown"]) await assert.rejects(state.root.spawn({taskName:"invalid",message:"bad",runtime}), /runtime must be/);
  for (const grants of [["auto"],["pi","pi","pi","pi","pi"]]) await assert.rejects(state.root.spawn({taskName:"invalid_grant",message:"bad",runtimeGrants:grants}), /grants/);
});

test("spawn tool keeps all four coding executors Personal-only and explicitly approved; auto is not a runtime", async () => {
  const tool = getTool("spawn_agent"); assert.ok(tool);
  assert.deepEqual(tool.input_schema.properties.runtime.enum, ["hara", "coding", "codex", "claude", "opencode", "pi"]);
  let spawned = 0;
  const team = { runtimeGrants: coding, async spawn(input) { spawned++; return {runtime: input.runtime}; } };
  for (const runtime of coding) {
    assert.equal(tool.classify({runtime},{spaceId:"personal"}).requiresExplicitApproval,true);
    assert.equal(tool.classify({runtime},{spaceId:"personal"}).effect,"exec");
    assert.match(await tool.run({task_name:"coding",message:"bounded",runtime},{spaceId:"company:fixture",agentTeam:team}), /only in Personal Space/);
    assert.equal(spawned,0);
    assert.match(await tool.run({task_name:"coding",message:"bounded",runtime},{spaceId:"personal",agentTeam:team}), new RegExp(runtime));
    spawned = 0;
  }
  assert.match(await tool.run({task_name:"coding",message:"bounded",runtime:"auto"},{spaceId:"personal",agentTeam:team}), /runtime must be/);
  assert.equal(spawned,0);
});

test("generic coding resolves two host preferences only for new spawns and stores the exact executor", async (t) => {
  let preference = "opencode"; const executions = [];
  const state = fixture(t, async request => { executions.push({runtime:request.runtime,generation:request.generation});
    return {status:"completed",text:"safe"}; }, {preferredCodingRuntime:()=>preference});
  const tool = getTool("spawn_agent");
  assert.equal(tool.classify({runtime:"coding"},{spaceId:"personal"}).requiresExplicitApproval,true);
  const context = {spaceId:"personal",agentTeam:state.root};
  const first = JSON.parse(await tool.run({task_name:"preferred_one",message:"bounded",runtime:"coding"},context));
  await state.root.wait(first.id,1_000);
  assert.equal(first.runtime,"opencode"); assert.equal(state.root.preferredCodingRuntime,"opencode");
  preference = "pi";
  const second = JSON.parse(await tool.run({task_name:"preferred_two",message:"bounded",runtime:"coding"},context));
  await state.root.wait(second.id,1_000);
  assert.equal(second.runtime,"pi"); assert.equal(state.root.preferredCodingRuntime,"pi");
  await state.root.followup(first.id,"continue original executor"); await state.root.wait(first.id,1_000);
  assert.deepEqual(executions,[{runtime:"opencode",generation:1},{runtime:"pi",generation:1},{runtime:"opencode",generation:2}]);
  assert.deepEqual(state.store.load(state.sessionId).agents.map(a=>a.runtime),["opencode","pi"]);
});

test("generic coding refuses an unavailable or missing preference, with no fallback or Company read", async (t) => {
  let reads=0;let executions=0;
  const state = fixture(t,async()=>{executions++;return {status:"completed",text:"unsafe"};},{codingRuntimes:["opencode"],
    preferredCodingRuntime:()=>{reads++;return "pi";}});
  const tool = getTool("spawn_agent"); const input={task_name:"no_fallback",message:"bounded",runtime:"coding"};
  assert.match(await tool.run(input,{spaceId:"personal",agentTeam:state.root}),/pi coding runtime is unavailable/);
  assert.equal(executions,0);assert.equal(state.team.list().length,0);assert.equal(state.manager.counts.prepare,0);
  assert.equal(reads,1);
  assert.match(await tool.run(input,{spaceId:"company:fixture",agentTeam:state.root}),/only in Personal Space/);
  assert.equal(reads,1,"Company cannot read the personal preference through this tool");
  const noPreference = fixture(t,async()=>{executions++;return {status:"completed",text:"unsafe"};});
  assert.match(await tool.run(input,{spaceId:"personal",agentTeam:noPreference.root}),/preferred coding executor is unavailable/);
  assert.equal(noPreference.team.list().length,0);assert.equal(executions,0);
});
