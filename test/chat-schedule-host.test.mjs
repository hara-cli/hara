import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { parseChatScheduleTime } from "../dist/workspace/chat-schedule.js";
import { LocalWorkspaceHost } from "../dist/workspace/local-host.js";
import { MemoryCredentialVault } from "../dist/workspace/credential-vault.js";
import { createWorkspaceSyntheticProvider, SYNTHETIC_CONNECTION } from "../dist/workspace/synthetic-provider.js";
import { waitForHostApproval } from "./fixtures/host-approval.mjs";
import { scriptedWorkspaceProvider } from "./fixtures/scripted-workspace-provider.mjs";
const roots = [], dir = () => { const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "hara-chat-schedule-host-"))); roots.push(root); return root; };
after(() => roots.forEach(root => fs.rmSync(root, { recursive: true, force: true })));
function fixture(events, repeat) {
  const host = new LocalWorkspaceHost(dir(), { mode: "workspace", credentialVault: new MemoryCredentialVault(), onChange: value => events.emit("change", value),
    providerFactory(connection, binding, context) {
      const synthetic = createWorkspaceSyntheticProvider(connection, binding, context);
      return scriptedWorkspaceProvider({ ...synthetic, async turn(args) {
        if (context.objective === "Summarize fixture") return { text: "Fixture result returned to the anchored conversation.", toolUses: [], stop: "end" };
        const results = args.history.flatMap(row => row.role === "tool" ? row.results : []);
        if (results.some(item => item.name === "schedule_create")) return { text: "Schedule request settled.", toolUses: [], stop: "end" };
        if (!results.some(item => item.name === "task_intake")) return { text: "", toolUses: [{ id: randomUUID(), name: "task_intake", input: {
          intent: "change", goal: "Create the requested fixture schedule", constraints: ["Synthetic fixture only"],
          acceptance: ["Schedule is stored in the same Workspace"], steps: ["Create schedule", "Report result"] } }], stop: "tool_use" };
        return { text: "", toolUses: [{ id: randomUUID(), name: "schedule_create", input: { title: "Fixture check", task: "Summarize fixture", ...(repeat ? { repeat: "every:15m" } : { delay_seconds: 60 }), tz: "UTC" } }], stop: "tool_use" };
      } });
    } });
  const workspace = host.createWorkspace("Fixture", host.list().revision), workspaceId = workspace.workspaceId, agentId = workspace.selectedAgentId;
  host.configureConnection(workspaceId, { ...SYNTHETIC_CONNECTION }, 0); host.select("client", workspaceId, host.list().revision);
  return { host, workspaceId, agentId };
}
test("one-shot chat schedule creates without a Desk approval and retains the message anchor", async () => {
  const events = new EventEmitter(), f = fixture(events, false);
  try {
    const requestId = randomUUID(), started = f.host.start("client", f.workspaceId, f.agentId, "Remind me about fixture", requestId);
    await f.host.wait(started.runId);
    const rows = f.host.workspaceFeatures(f.workspaceId).schedules;
    assert.equal(rows.length, 1); assert.equal(rows[0].source, "chat"); assert.equal(rows[0].anchor.messageId, requestId);
    assert.equal(rows[0].anchor.agentId, f.agentId); assert.equal(f.host.snapshot(f.workspaceId, f.agentId, "client").approvals.length, 0);
    await f.host.tickSchedules(Date.now() + 70_000);
    const history = f.host.snapshot(f.workspaceId, f.agentId, "client").conversation.history;
    assert(history.some(row => row.role === "user" && row.content === "Summarize fixture"), "due run returns to the original conversation");
    const run = f.host.workspaceFeatures(f.workspaceId).scheduler.runs.find(row => row.scheduleId === rows[0].id);
    assert(run && run.state !== "unknown");
    assert(history.some(row => row.role === "assistant" && row.text.includes("Fixture result returned")));
  } finally { await f.host.close(); }
});
for (const approved of [true, false]) test(`repeating chat schedule ${approved ? "requires and consumes" : "respects rejection of"} a Desk card`, async t => {
  const events = new EventEmitter(), f = fixture(events, true);
  try {
    const { job, card } = await waitForHostApproval({ events, signal: t.signal,
      start: () => f.host.start("client", f.workspaceId, f.agentId, "Repeat fixture check", randomUUID()),
      read: () => f.host.snapshot(f.workspaceId, f.agentId, "client").approvals[0], wait: runId => f.host.wait(runId) });
    assert.equal(card.kind, "schedule_create"); assert.equal(f.host.workspaceFeatures(f.workspaceId).schedules.length, 0);
    f.host.answerApproval("client", f.workspaceId, card.id, approved); await f.host.wait(job.runId);
    assert.equal(f.host.workspaceFeatures(f.workspaceId).schedules.length, approved ? 1 : 0);
  } finally { await f.host.close(); }
});
test("a colleague cannot cancel another colleague's schedule; main Hara can", async () => {
  const events = new EventEmitter(); let targetId = "";
  const host = new LocalWorkspaceHost(dir(), { mode: "workspace", credentialVault: new MemoryCredentialVault(), onChange: value => events.emit("change", value),
    providerFactory(connection, binding, context) {
      const synthetic = createWorkspaceSyntheticProvider(connection, binding, context);
      return scriptedWorkspaceProvider({ ...synthetic, async turn(args) {
        const results = args.history.flatMap(row => row.role === "tool" ? row.results : []);
        if (results.some(row => row.name === "schedule_cancel")) return { text: "Cancellation checked.", toolUses: [], stop: "end" };
        if (!results.some(row => row.name === "task_intake")) return { text: "", toolUses: [{ id: randomUUID(), name: "task_intake", input: {
          intent: "change", goal: context.objective, constraints: ["Fixture only"], acceptance: ["Only authorized owner can cancel"], steps: ["Check schedule", "Cancel"] } }], stop: "tool_use" };
        if (!results.some(row => row.name === "schedule_list")) return { text: "", toolUses: [{ id: randomUUID(), name: "schedule_list", input: {} }], stop: "tool_use" };
        return { text: "", toolUses: [{ id: randomUUID(), name: "schedule_cancel", input: { id: targetId } }], stop: "tool_use" };
      } });
    } });
  try {
    const workspace = host.createWorkspace("Fixture", host.list().revision), workspaceId = workspace.workspaceId, main = workspace.selectedAgentId;
    host.configureConnection(workspaceId, { ...SYNTHETIC_CONNECTION }, 0); host.select("client", workspaceId, host.list().revision);
    const context = host.context(workspaceId), agents = context.resources.agents;
    const make = name => agents.create({ username: name, profile: { displayName: name, title: "Fixture colleague" }, instructions: "Synthetic fixture only", runtimeId: "pi" }, agents.list().revision);
    const first = make("first"), second = make("second"), connection = context.connections.capture();
    targetId = context.features.createChatSchedule({ title: "Owned", task: "Fixture", agentId: first.agentId,
      time: parseChatScheduleTime({ delay_seconds: 60 }, Date.now(), "UTC"),
      anchor: { workspaceId, conversationId: "fixture-session", messageId: randomUUID(), agentId: first.agentId,
        runtimeId: "pi", configRevision: first.configRevision, agentEpoch: first.agentEpoch, connection } });
    host.selectAgent("client", workspaceId, second.agentId);
    const denied = host.start("client", workspaceId, second.agentId, "Cancel another colleague's schedule", randomUUID()); await host.wait(denied.runId);
    const denial = host.snapshot(workspaceId, second.agentId, "client").conversation.history.flatMap(row => row.role === "tool" ? row.results : []).find(row => row.name === "schedule_cancel");
    const colleagueList = host.snapshot(workspaceId, second.agentId, "client").conversation.history.flatMap(row => row.role === "tool" ? row.results : []).find(row => row.name === "schedule_list");
    assert(colleagueList && !colleagueList.isError);
    assert.equal(JSON.parse(colleagueList.content).schedules.some(row => row.id === targetId), false);
    assert(denial && denial.isError); assert.equal(context.features.schedules().some(row => row.id === targetId), true);
    host.selectAgent("client", workspaceId, main);
    const allowed = host.start("client", workspaceId, main, "Cancel the schedule in this Workspace", randomUUID()); await host.wait(allowed.runId);
    const result = host.snapshot(workspaceId, main, "client").conversation.history.flatMap(row => row.role === "tool" ? row.results : []).find(row => row.name === "schedule_cancel");
    const mainList = host.snapshot(workspaceId, main, "client").conversation.history.flatMap(row => row.role === "tool" ? row.results : []).find(row => row.name === "schedule_list");
    assert(mainList && JSON.parse(mainList.content).schedules.some(row => row.id === targetId));
    assert(result && !result.isError); assert.equal(context.features.schedules().some(row => row.id === targetId), false);
  } finally { await host.close(); }
});

test("restoring a colleague does not run its chat schedule; an explicit enable rebinds only the unchanged owner", async () => {
  const f = fixture(new EventEmitter(), false);
  try {
    const context = f.host.context(f.workspaceId), agents = context.resources.agents;
    const agent = agents.create({ username: "scheduled", profile: { displayName: "Scheduled" }, runtimeId: "pi" }, agents.list().revision);
    const id = context.features.createChatSchedule({ title: "Retained", task: "Summarize fixture", agentId: agent.agentId,
      time: parseChatScheduleTime({ delay_seconds: 60 }, Date.now(), "UTC"),
      anchor: { workspaceId: f.workspaceId, conversationId: "retained-session", messageId: randomUUID(), agentId: agent.agentId,
        runtimeId: "pi", configRevision: agent.configRevision, agentEpoch: agent.agentEpoch, connection: context.connections.capture() } });
    const deleted = await f.host.setAgentArchived(f.workspaceId, agent.agentId, true, agent.configRevision, agent.agentEpoch);
    const restored = await f.host.setAgentArchived(f.workspaceId, agent.agentId, false, deleted.agent.configRevision, deleted.agent.agentEpoch);
    assert.equal(context.features.schedules().find(row => row.id === id).enabled, false);
    await f.host.tickSchedules(Date.now() + 70_000); assert.equal(f.host.workspaceFeatures(f.workspaceId).scheduler.runs.length, 0);
    f.host.updateFeature(f.workspaceId, "schedule", id, true, context.features.list().revision);
    assert.equal(context.features.schedules().find(row => row.id === id).definition.anchor.agentEpoch, restored.agent.agentEpoch);
    await f.host.tickSchedules(Date.now() + 70_000);
    assert(f.host.workspaceFeatures(f.workspaceId).scheduler.runs.some(row => row.scheduleId === id && row.state !== "unknown"));
    const second = context.features.createChatSchedule({ title: "Changed", task: "Summarize fixture", agentId: agent.agentId,
      time: parseChatScheduleTime({ delay_seconds: 60 }, Date.now(), "UTC"),
      anchor: { workspaceId: f.workspaceId, conversationId: "retained-session", messageId: randomUUID(), agentId: agent.agentId,
        runtimeId: "pi", configRevision: restored.agent.configRevision, agentEpoch: restored.agent.agentEpoch, connection: context.connections.capture() } });
    const archivedAgain = await f.host.setAgentArchived(f.workspaceId, agent.agentId, true, restored.agent.configRevision, restored.agent.agentEpoch);
    const restoredAgain = await f.host.setAgentArchived(f.workspaceId, agent.agentId, false, archivedAgain.agent.configRevision, archivedAgain.agent.agentEpoch);
    agents.rename(agent.agentId, "Changed persona", restoredAgain.agent.configRevision, restoredAgain.agent.agentEpoch);
    assert.throws(() => f.host.updateFeature(f.workspaceId, "schedule", second, true, context.features.list().revision), /configuration changed/);
    assert.equal(context.features.schedules().find(row => row.id === second).enabled, false);
  } finally { await f.host.close(); }
});

test("archive drains block a concurrent schedule create or enable only for that colleague", async () => {
 const f=fixture(new EventEmitter(),false);let release,pending;
 try{
  const context=f.host.context(f.workspaceId),agents=context.resources.agents;
  const target=agents.create({username:"draining",profile:{displayName:"Draining"},runtimeId:"pi"},agents.list().revision);
  const input=agentId=>({id:randomUUID(),name:"Synthetic future schedule",task:"Summarize fixture",agentId,enabled:true,schedule:{kind:"once",runAt:Date.now()+3600000,display:"Future fixture"}});
  const existing=input(target.agentId);f.host.saveSchedule(f.workspaceId,existing,context.features.list().revision,true);
  f.host.selectAgent("client",f.workspaceId,target.agentId);
  const started=f.host.start("client",f.workspaceId,target.agentId,"Summarize fixture",randomUUID()),job=f.host.jobs.get(started.runId);assert(job);
  const drained=job.promise,gate=new Promise(resolve=>release=resolve);job.promise=Promise.all([drained,gate]).then(()=>{});
  pending=f.host.setAgentArchived(f.workspaceId,target.agentId,true,target.configRevision,target.agentEpoch,[started.runId]);
  assert.equal(agents.get(target.agentId).state,"active");assert.equal(context.features.schedules().find(row=>row.id===existing.id).enabled,false);
  assert.throws(()=>f.host.saveSchedule(f.workspaceId,input(target.agentId),context.features.list().revision,true),/lifecycle/);
  assert.throws(()=>f.host.updateFeature(f.workspaceId,"schedule",existing.id,true,context.features.list().revision),/lifecycle/);
  const other=input(f.agentId);f.host.saveSchedule(f.workspaceId,other,context.features.list().revision,true);
  release();const deleted=await pending;await f.host.setAgentArchived(f.workspaceId,target.agentId,false,deleted.agent.configRevision,deleted.agent.agentEpoch);
  assert(context.features.schedules().filter(row=>row.definition.agentId===target.agentId).every(row=>!row.enabled));
  assert.equal(context.features.schedules().find(row=>row.id===other.id).enabled,true);
 }finally{release?.();await pending?.catch(()=>{});await f.host.close();}
});

test("archive drain fences runtime, permissions and persona, and failed final validation restores only its own paused schedules", async t => {
 const f=fixture(new EventEmitter(),false);let release,pending;
 try{
  const context=f.host.context(f.workspaceId),agents=context.resources.agents;
  const target=agents.create({username:"rollback",profile:{displayName:"Rollback"},runtimeId:"pi"},agents.list().revision),otherAgent=agents.create({username:"other",profile:{displayName:"Other"},runtimeId:"pi"},agents.list().revision);
  const input=(agentId,enabled=true)=>({id:randomUUID(),name:"Synthetic future schedule",task:"Summarize fixture",agentId,enabled,schedule:{kind:"once",runAt:Date.now()+3600000,display:"Future fixture"}});
  const enabled=input(target.agentId),disabled=input(target.agentId,false);for(const row of[enabled,disabled])f.host.saveSchedule(f.workspaceId,row,context.features.list().revision,true);
  f.host.selectAgent("client",f.workspaceId,target.agentId);const started=f.host.start("client",f.workspaceId,target.agentId,"Summarize fixture",randomUUID()),job=f.host.jobs.get(started.runId),original=job.promise;job.promise=Promise.all([original,new Promise(resolve=>release=resolve)]).then(()=>{});
  t.mock.method(f.host,"assertGeneration",()=>{throw Error("Synthetic final generation validation rejected")});
  pending=f.host.setAgentArchived(f.workspaceId,target.agentId,true,target.configRevision,target.agentEpoch,[started.runId]);
  assert.throws(()=>f.host.setAgentRuntime(f.workspaceId,target.agentId,"pi",target.configRevision,target.agentEpoch),/lifecycle/);
  assert.throws(()=>f.host.setAgentPermissionTier(f.workspaceId,target.agentId,"controlled",target.configRevision,target.agentEpoch),/lifecycle/);
  assert.throws(()=>f.host.updateAgentPersona(f.workspaceId,target.agentId,{profile:{displayName:"Must not write"}},target.configRevision,target.agentEpoch),/lifecycle/);
  await assert.rejects(f.host.applyRuntimeForm(f.workspaceId,{agentId:target.agentId,runtimeId:"pi",configRevision:target.configRevision,agentEpoch:target.agentEpoch}),/lifecycle/);
  assert.throws(()=>f.host.updateFeature(f.workspaceId,"schedule",enabled.id,false,context.features.list().revision),/lifecycle/);
  assert.throws(()=>f.host.deleteSchedule(f.workspaceId,enabled.id,context.features.list().revision,true),/lifecycle/);
  f.host.updateAgentPersona(f.workspaceId,otherAgent.agentId,{profile:{displayName:"Other changed"}},otherAgent.configRevision,otherAgent.agentEpoch);
  const other=input(otherAgent.agentId);f.host.saveSchedule(f.workspaceId,other,context.features.list().revision,true);
  release();await assert.rejects(pending,error=>error.reason==="archive_cleanup_failed");t.mock.restoreAll();
  assert.equal(agents.get(target.agentId).state,"active");assert.equal(agents.get(target.agentId).agentEpoch,target.agentEpoch);
  const rows=context.features.schedules();assert.equal(rows.find(row=>row.id===enabled.id).enabled,true);assert.equal(rows.find(row=>row.id===disabled.id).enabled,false);assert.equal(rows.find(row=>row.id===other.id).enabled,true);
  assert(!f.host.lifecycleChanges.has(JSON.stringify([f.workspaceId,target.agentId])));
  const retry=await f.host.setAgentArchived(f.workspaceId,target.agentId,true,target.configRevision,target.agentEpoch);assert.equal(retry.agent.state,"archived");
 }finally{release?.();await pending?.catch(()=>{});t.mock.restoreAll();await f.host.close();}
});

test("archive cleanup deadline releases the fence, restores schedules and never increments epoch", async t => {
 const f=fixture(new EventEmitter(),false);let release,pending;
 try{
  const context=f.host.context(f.workspaceId),agents=context.resources.agents,target=agents.create({username:"timeout",profile:{displayName:"Timeout"},runtimeId:"pi"},agents.list().revision);
  const schedule={id:randomUUID(),name:"Synthetic schedule",task:"Summarize fixture",agentId:target.agentId,enabled:true,schedule:{kind:"once",runAt:Date.now()+3600000,display:"Fixture"}};f.host.saveSchedule(f.workspaceId,schedule,context.features.list().revision,true);
  f.host.selectAgent("client",f.workspaceId,target.agentId);const started=f.host.start("client",f.workspaceId,target.agentId,"Summarize fixture",randomUUID()),job=f.host.jobs.get(started.runId),original=job.promise;job.promise=Promise.all([original,new Promise(resolve=>release=resolve)]).then(()=>{});
  t.mock.timers.enable({apis:["setTimeout"]});pending=f.host.setAgentArchived(f.workspaceId,target.agentId,true,target.configRevision,target.agentEpoch,[started.runId]);
  const rejected=assert.rejects(pending,error=>error.reason==="archive_drain_timeout");t.mock.timers.tick(10000);await rejected;t.mock.timers.reset();
  assert(!f.host.lifecycleChanges.has(JSON.stringify([f.workspaceId,target.agentId])));assert.equal(agents.get(target.agentId).state,"active");assert.equal(agents.get(target.agentId).agentEpoch,target.agentEpoch);assert.equal(context.features.schedules().find(row=>row.id===schedule.id).enabled,true);
  release();await job.promise;const retry=await f.host.setAgentArchived(f.workspaceId,target.agentId,true,target.configRevision,target.agentEpoch);assert.equal(retry.agent.state,"archived");
 }finally{t.mock.timers.reset();release?.();await pending?.catch(()=>{});await f.host.close();}
});
