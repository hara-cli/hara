import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { buildLegacyInheritancePlan } from "../dist/workspace/legacy-plan.js";
import { planRetainedProjectAgent, retainedProjectAgentRoute, retainedProjectTaskRoutes } from "../dist/workspace/legacy-project-agent.js";
import { WorkspaceResourceStorage } from "../dist/workspace/resource-context.js";
import { WorkspaceResources } from "../dist/workspace/resources.js";
import { WorkspaceFeatures } from "../dist/workspace/features.js";
import { WorkspaceLegacyResources, planLegacyResources } from "../dist/workspace/legacy-resources.js";
import { legacyScheduleRows, legacySchedulesDomain } from "../dist/workspace/legacy-schedules.js";
import { WorkspaceScheduler } from "../dist/workspace/scheduler.js";
import { WorkspaceLegacyCommands } from "../dist/workspace/legacy-command.js";

function input() {
  const jobs = Array.from({ length: 4 }, (_, i) => ({ id: "fixture-" + i, name: "Fixture " + i, cwd: "/legacy/owner-project", task: "printf fixture-" + i,
    mode: "command", enabled: i !== 3, createdAt: 0, schedule: { kind: "cron", expr: "*/5 * * * *" }, tz: "Asia/Shanghai" }));
  const flows = [{ name: "fixture-intake", enabled: true, on: { platform: "feishu", chatType: "p2p", keyword: ["fixture"] }, do: "Return dispatch.agent=owner-project:finance-worker. No send permission." }];
  const approval = { agentRef: "owner-project:finance-worker", cwd: "/legacy/owner-project", sourceFingerprint: "a".repeat(64), approvalHash: "b".repeat(64),
    workspaceId: "ws_10000000-0000-4000-8000-000000000001", resourceBinding: { schemaVersion: 1, scopeKey: "c".repeat(64), generation: "20000000-0000-4000-8000-000000000001" },
    taskIds: jobs.map(row => row.id), flowNames: ["fixture-intake"] };
  const review = buildLegacyInheritancePlan({ sourceFingerprint: approval.sourceFingerprint, now: 120000, jobs, flows, roles: [], sessions: [], config: {}, profiles: {} });
  const source = { jobs, flows, taskPlan: review.tasks };
  return { jobs, flows, approval, source, review, target: { workspaceId: approval.workspaceId, resourceBinding: approval.resourceBinding }, plan: planRetainedProjectAgent(approval, source) };
}
test("a qualified project identity is retained, not re-created or silently assigned Pi/read-only policy", () => {
  const f = input(), before = JSON.stringify(f.source);
  assert.equal(f.plan.agentRef, f.approval.agentRef); assert.equal(f.plan.cwd, f.approval.cwd); assert.equal(f.plan.newColleague, false);
  assert.equal(f.plan.runtimeAuthority, "existing-owner-runtime"); assert.equal(f.plan.schedulingOwner, "main-hara");
  assert.equal(f.plan.tasks.length, 4); assert.equal(f.plan.flows[0].dispatchEvidence, "prompt-hint-only");
  assert.equal("toolPolicy" in f.plan, false); assert.equal("instructions" in f.plan, false); assert.equal("runtimeId" in f.plan, false);
  assert.equal(Object.isFrozen(f.plan.tasks[0]), true); assert.equal(JSON.stringify(f.source), before);
  assert.equal(JSON.stringify(f.plan).includes("printf fixture"), false);
});
test("bare names, global/external aliases, changed cwd and unreviewed task IDs never fall back to another identity", () => {
  const f = input();
  for (const patch of [{ agentRef: "finance-worker" }, { agentRef: "global:finance-worker" }, { agentRef: "claude:finance-worker" }, { agentRef: "codex:finance-worker" },
    { cwd: "/different/project" }, { taskIds: ["absent"] }, { taskIds: [f.jobs[0].id, f.jobs[0].id] }, { approvalHash: "unbound" }]) {
    assert.throws(() => planRetainedProjectAgent({ ...f.approval, ...patch }, f.source));
  }
  assert.throws(() => retainedProjectAgentRoute([f.plan], "finance-worker", f.approval.sourceFingerprint, f.target), /Exact/);
  assert.throws(() => retainedProjectAgentRoute([f.plan], "another:finance-worker", f.approval.sourceFingerprint, f.target), /unavailable/);
});
test("exact route lookup preserves the original cwd and does not infer a worker from flow.cwd", () => {
  const f = input(), route = retainedProjectAgentRoute([f.plan], f.approval.agentRef, f.approval.sourceFingerprint, f.target);
  assert.equal(route.cwd, "/legacy/owner-project"); assert.equal(route.agentRef, f.approval.agentRef); assert.equal(route.newColleague, false);
  assert.throws(() => retainedProjectAgentRoute([f.plan, f.plan], f.approval.agentRef, f.approval.sourceFingerprint, f.target), /ambiguous/);
  assert.throws(() => retainedProjectAgentRoute([f.plan], f.approval.agentRef, "c".repeat(64), f.target), /unavailable|source/);
});
test("source/task changes and duplicate flow rules stop before staging instead of rewriting them", () => {
  const f = input();
  assert.throws(() => planRetainedProjectAgent(f.approval, { ...f.source, jobs: f.jobs.map((row, i) => i ? row : { ...row, task: "changed" }) }), /source/);
  assert.throws(() => planRetainedProjectAgent(f.approval, { ...f.source, flows: [...f.flows, f.flows[0]] }), /ambiguous/);
  assert.throws(() => planRetainedProjectAgent(f.approval, { ...f.source, flows: [{ ...f.flows[0], do: "different target" }] }), /not demonstrated/);
  assert.throws(() => planRetainedProjectAgent(f.approval, { ...f.source, taskPlan: f.review.tasks.map(row => ({ ...row, definitionValidation: "reject" })) }), /source/);
});
test("static dispatch and model-prompt hints remain distinct; neither rewrites gateway permissions", () => {
  const f = input(), flows = [{ name: "fixture-intake", staticResult: { dispatch: { agent: f.approval.agentRef, task: "fixture" } }, enabled: false }];
  const plan = planRetainedProjectAgent(f.approval, { ...f.source, flows });
  assert.equal(plan.flows[0].dispatchEvidence, "static-result"); assert.equal(plan.flows[0].enabled, false);
  assert.equal(f.plan.flows[0].dispatchEvidence, "prompt-hint-only");
});
test("route metadata cannot be relabelled as a new colleague, readonly policy or another source generation", () => {
  const f = input();
  for (const patch of [{ newColleague: true }, { runtimeAuthority: "readonly" }, { runtimeAuthority: "pi" }, { sourceFingerprint: "c".repeat(64) }, { cwd: "/different/project" }]) {
    assert.throws(() => retainedProjectTaskRoutes([{ ...f.plan, ...patch }], f.jobs, f.approval.sourceFingerprint, f.target));
  }
  assert.throws(() => retainedProjectTaskRoutes([f.plan, f.plan], f.jobs, f.approval.sourceFingerprint, f.target), /conflict/);
  assert.throws(() => retainedProjectTaskRoutes([f.plan], f.jobs.map(row => ({ ...row, enabled: !row.enabled })), f.approval.sourceFingerprint, f.target), /source changed/);
  assert.throws(() => retainedProjectTaskRoutes([f.plan], f.jobs, f.approval.sourceFingerprint, { ...f.target, workspaceId: `ws_${randomUUID()}` }), /Workspace/);
  assert.throws(() => retainedProjectAgentRoute([f.plan], f.approval.agentRef, f.approval.sourceFingerprint,
    { ...f.target, resourceBinding: { ...f.target.resourceBinding, generation: randomUUID() } }), /Workspace/);
});
test("four original task definitions are staged with their qualified route, not a new Agent; restart/rollback preserve source", async t => {
  const f = input(), home = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "hara-retained-project-")));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const scope = { schemaVersion: 1, workspaceId: `ws_${randomUUID()}`, authority: { kind: "local", localAuthorityId: randomUUID() } }, storage = new WorkspaceResourceStorage(home, scope); storage.initialize();
  const resources = new WorkspaceResources(home, scope); resources.initialize(); const main = resources.agents.initializeMain();
  const features = new WorkspaceFeatures(storage, home, scope.workspaceId), folders = new WorkspaceLegacyResources(storage), before = JSON.stringify(f.source), roster = resources.agents.list();
  await folders.domain(f.approval.sourceFingerprint, planLegacyResources({ jobs: f.jobs, projects: [], legacyWorkspacePath: "/legacy/workspace" })).apply();
  const plan = planRetainedProjectAgent({ ...f.approval, workspaceId: scope.workspaceId, resourceBinding: folders.bindingForHost() }, f.source);
  const rows = legacyScheduleRows({ jobs: f.jobs, plan: f.review.tasks, sourceFingerprint: f.approval.sourceFingerprint, workspaceId: scope.workspaceId, mainAgentId: main.agentId,
    resources: folders, retainedProjectAgents: [plan] });
  const domain = () => legacySchedulesDomain(storage, features, f.approval.sourceFingerprint, rows);
  await domain().apply(); await domain().apply();
  const reopened = new WorkspaceFeatures(storage, home, scope.workspaceId);
  for (const row of reopened.schedules()) {
    const source = f.jobs.find(old => old.id === row.id);
    assert.equal(row.definition.task, source.task); assert.equal(row.definition.cwd, source.cwd); assert.equal(row.enabled, source.enabled); assert.deepEqual(row.schedule, source.schedule);
    assert.equal(row.definition.agentId, main.agentId); assert.equal(row.definition.legacy.projectAgent.agentRef, f.approval.agentRef);
    assert.equal(row.definition.legacy.projectAgent.runtimeAuthority, "existing-owner-runtime");
  }
  const scheduler = new WorkspaceScheduler(storage, reopened, { available: () => true, async execute() { assert.fail("metadata staging must not launch a task"); } });
  await scheduler.tick(main.agentId, 120000); assert(scheduler.list().schedules.every(row => row.awaitingHandoff));
  const ordinaryShell = new WorkspaceLegacyCommands(storage, reopened, folders, { authorize() { assert.fail("retained identity is not an ordinary shell grant"); }, async launch() { assert.fail("no owner/runtime bridge"); } });
  const blocked = await ordinaryShell.execute(f.jobs[0].id, randomUUID()); assert.equal(blocked.state, "blocked"); assert.equal(blocked.reason, "retained_project_runtime_pending");
  assert.deepEqual(resources.agents.list(), roster); assert.equal(JSON.stringify(f.source), before);
  await domain().rollback(); assert.equal(reopened.schedules().length, 0); await domain().apply(); assert.equal(reopened.schedules().length, 4);
  assert.deepEqual(resources.agents.list(), roster);
});
