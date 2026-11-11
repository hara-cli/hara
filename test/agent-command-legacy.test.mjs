import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { businessFixture, hash } from "./helpers/legacy-business-fixture.mjs";
import { LocalWorkspaceHost } from "../dist/workspace/local-host.js";
import { WorkspaceLegacyBusiness } from "../dist/workspace/legacy-business.js";
import { WorkspaceAgentBoundaryAuthority } from "../dist/workspace/agent-boundary-authority.js";
import { WorkspaceAgentCommandControl } from "../dist/workspace/agent-command-control.js";
import { AgentBoundaryTransports } from "../dist/workspace/agent-boundary-transport.js";
import { captureWorkspaceProjectIdentity } from "../dist/workspace/run-binding.js";
import { currentWorkspaceResourceBinding } from "../dist/workspace/resource-context.js";
const docs = JSON.parse(fs.readFileSync(new URL("./fixtures/agent-boundaries-v1.json", import.meta.url), "utf8"));
const code = name => error => error.code === name;
async function fixture(t, initialize = true) {
  const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "hara-c3-legacy-")));
  const jobs = [{ id: "one", name: "fixture", task: "printf fixture", mode: "command", cwd: "/copy/fixture", enabled: true, createdAt: 0,
    schedule: { kind: "cron", expr: "* * * * *" }, deliver: "feishu:synthetic-local-only", alertAfter: 3 }];
  const f = await businessFixture(root, jobs), closers = [];
  // Use a fresh trusted credential; this fixture never sends a real message.
  const credential = randomBytes(32).toString("hex"), owner = new AgentBoundaryTransports(credential), transport = owner.connect("owner", credential);
  const binding = f.storage.run(() => currentWorkspaceResourceBinding()), project = captureWorkspaceProjectIdentity(f.cwd);
  const authority = new WorkspaceAgentBoundaryAuthority({ catalog: f.catalog, resources: f.resources, storage: f.storage, transports: owner, commandControl: true,
    resourcesForAgent: () => [{ resourceId: "files", agentId: f.main.agentId, revision: 1, binding, project, access: ["read"], assertCurrent() {} }] });
  const view = authority.view(transport, f.main.agentId), copy = name => structuredClone(docs.valid.find(row => row.name === name).document);
  const duty = copy("duty"), boundary = copy("boundary"); for (const doc of [duty, boundary]) { doc.context = view.context; doc.agentId = f.main.agentId; }
  boundary.resources = [{ resourceId: "files", access: ["read"] }]; boundary.tools = { allow: [], deny: [], readOnly: true }; boundary.approvalRequired = [];
  authority.configure(transport, f.main.agentId, { expectedRevision: view.revision, duty, boundary, rights: { manage: true, invoke: true, privateRead: true, nodeUse: true } });
  const control = new WorkspaceAgentCommandControl(authority); if (initialize) control.initialize(transport);
  let launches = 0, sends = 0;
  const make = patch => new WorkspaceLegacyBusiness(f.storage, f.features, f.folders, {
    commands: { authorize: f.grant, async launch() { launches++; return { code: 0, terminated: true }; }, ...patch },
    notifications: { authorize: review => ({ review, assertCurrent() {}, async send() { sends++; return { state: "sent", receiptId: "synthetic-only" }; } }) } });
  const outcome = () => ({ requestId: randomUUID(), runId: randomUUID(), scheduleId: "one", definitionHash: hash(f.rows[0]), status: "ok", output: "fixture", hadStdout: true, finishedAt: Date.now() });
  t.after(async () => { for (const close of closers) await close(); authority.close(); owner.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { ...f, root, authority, control, transport, make, outcome, closers, launches: () => launches, sends: () => sends };
}

test("C3 protected legacy command and notification entrypoints refuse before launcher or transport", async t => {
  const f = await fixture(t), business = f.make();
  await assert.rejects(business.execute("one", randomUUID()), code("RUNTIME_UNSUPPORTED")); assert.equal(f.launches(), 0);
  const [id] = business.outcomes.record(f.outcome());
  assert.throws(() => business.outcomes.flush(id), code("RUNTIME_UNSUPPORTED")); assert.equal(f.sends(), 0);
  assert.deepEqual(business.commands.list(), []); assert.equal(business.outcomes.list().effects[0].state, "pending");
});

test("C3 first migration cannot cross a genuinely pending legacy command", async t => {
  const f = await fixture(t, false); let release, entered;
  const ready = new Promise(resolve => { entered = resolve; }), pending = new Promise(resolve => { release = resolve; });
  const business = f.make({ async launch() { entered(); await pending; return { code: 0, terminated: true }; } });
  const running = business.commands.execute("one", randomUUID());
  try { await ready; assert.throws(() => f.control.initialize(f.transport), code("CONTROL_HELD")); }
  finally { release(); await running; }
  assert.equal(business.commands.list()[0].state, "completed"); f.control.initialize(f.transport);
  assert.equal(f.control.inspect(f.transport, f.main.agentId).agent.epoch, 0);
});

test("C3 first migration retains queued notification recovery until the original synthetic delivery settles", async t => {
  const f = await fixture(t, false), business = f.make(), [id] = business.outcomes.record(f.outcome());
  assert.throws(() => f.control.initialize(f.transport), code("CONTROL_HELD"));
  assert.equal(business.outcomes.list().effects[0].state, "pending"); await business.outcomes.flush(id);
  assert.equal(f.sends(), 1); f.control.initialize(f.transport); assert.equal(business.outcomes.list().effects[0].state, "sent");
});

test("C3 a default Host skips protected legacy schedules without creating their business adapter", async t => {
  const f = await fixture(t); let factories = 0;
  const host = new LocalWorkspaceHost(f.root, { legacyBusinessFactory() { factories++; return f.make(); } });
  f.closers.push(() => host.close()); await host.initialize();
  await host.tickSchedules(120000); assert.equal(factories, 0); assert.equal(f.launches(), 0); assert.equal(f.sends(), 0);
});
