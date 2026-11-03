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
const roots = [], dir = () => { const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "hara-chat-schedule-host-"))); roots.push(root); return root; };
after(() => roots.forEach(root => fs.rmSync(root, { recursive: true, force: true })));
function fixture(events, repeat) {
  const host = new LocalWorkspaceHost(dir(), { mode: "workspace", credentialVault: new MemoryCredentialVault(), onChange: value => events.emit("change", value),
    providerFactory(connection, binding, context) {
      const synthetic = createWorkspaceSyntheticProvider(connection, binding, context);
      return { ...synthetic, async turn(args) {
        if (context.objective === "Summarize fixture") return { text: "Fixture result returned to the anchored conversation.", toolUses: [], stop: "end" };
        const results = args.history.flatMap(row => row.role === "tool" ? row.results : []);
        if (results.some(item => item.name === "schedule_create")) return { text: "Schedule request settled.", toolUses: [], stop: "end" };
        if (!results.some(item => item.name === "task_intake")) return { text: "", toolUses: [{ id: randomUUID(), name: "task_intake", input: {
          intent: "change", goal: "Create the requested fixture schedule", constraints: ["Synthetic fixture only"],
          acceptance: ["Schedule is stored in the same Workspace"], steps: ["Create schedule", "Report result"] } }], stop: "tool_use" };
        return { text: "", toolUses: [{ id: randomUUID(), name: "schedule_create", input: { title: "Fixture check", task: "Summarize fixture", ...(repeat ? { repeat: "every:15m" } : { delay_seconds: 60 }), tz: "UTC" } }], stop: "tool_use" };
      } };
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
      return { ...synthetic, async turn(args) {
        const results = args.history.flatMap(row => row.role === "tool" ? row.results : []);
        if (results.some(row => row.name === "schedule_cancel")) return { text: "Cancellation checked.", toolUses: [], stop: "end" };
        if (!results.some(row => row.name === "task_intake")) return { text: "", toolUses: [{ id: randomUUID(), name: "task_intake", input: {
          intent: "change", goal: context.objective, constraints: ["Fixture only"], acceptance: ["Only authorized owner can cancel"], steps: ["Check schedule", "Cancel"] } }], stop: "tool_use" };
        if (!results.some(row => row.name === "schedule_list")) return { text: "", toolUses: [{ id: randomUUID(), name: "schedule_list", input: {} }], stop: "tool_use" };
        return { text: "", toolUses: [{ id: randomUUID(), name: "schedule_cancel", input: { id: targetId } }], stop: "tool_use" };
      } };
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
