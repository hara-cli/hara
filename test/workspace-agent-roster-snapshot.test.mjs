import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { WorkspaceResources } from "../dist/workspace/resources.js";
import { workspaceResourceScopeKey } from "../dist/workspace/resource-context.js";
import { createTaskExecution } from "../dist/session/task.js";

const temporary = [];
after(() => { for (const root of temporary) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const home = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "hara-roster-snapshot-"))); temporary.push(home);
  const scope = { schemaVersion: 1, workspaceId: `ws_${randomUUID()}`, authority: { kind: "local", localAuthorityId: randomUUID() } };
  let available = true, reads = 0, failure = false, authority = true, onRead;
  const installer = { list() {
    reads++;
    if (failure) throw new Error("fixture inventory unavailable");
    const current = available; onRead?.();
    return { options: [{ runtimeId: "codex", state: current ? "registered" : "integrity_failed", generalAgentDriverAvailable: current }] };
  } };
  const resources = new WorkspaceResources(home, scope, { runtimeInstaller: installer,
    assertCurrent() { if (!authority) throw new Error("fixture authority revoked"); } });
  resources.initialize();
  assert.deepEqual(resources.agents.list(), { revision: 0, mainAgentId: null, agents: [] });
  assert.equal(reads, 0, "an empty roster does not initialize or read optional runtimes");
  resources.agents.initializeMain();
  let revision = resources.agents.list().revision;
  const members = [];
  for (let index = 0; index < 13; index++) {
    members.push(resources.agents.create({ username: `member-${index}`, profile: { displayName: `Member ${index}` }, runtimeId: "codex" }, revision++));
  }
  return { home, scope, resources, members, get reads() { return reads; }, resetReads() { reads = 0; },
    available(value) { available = value; }, failure(value) { failure = value; }, authority(value) { authority = value; },
    onRead(value) { onRead = value; } };
}

test("one roster uses a coherent runtime inventory and independent mutable DTOs", () => {
  const f = fixture(); f.resetReads();
  // Simulate a runtime disappearing immediately after the inventory snapshot was read.
  f.onRead(() => f.available(false));
  const list = f.resources.agents.list(), colleagues = list.agents.filter(row => row.kind === "colleague");
  assert.equal(colleagues.length, 13);
  assert.equal(colleagues.every(row => row.runtime.id === "codex" && row.runtime.available), true,
    "one reply describes one inventory snapshot, rather than mixing later reads");
  assert.equal(f.reads, 1, "one roster must not repeat the durable inventory read for each colleague");
  colleagues[0].runtime.available = false;
  assert.equal(colleagues[1].runtime.available, true, "mutating one DTO cannot change another colleague");
  f.onRead(undefined);
  const next = f.resources.agents.list().agents.filter(row => row.kind === "colleague");
  assert.equal(next.every(row => !row.runtime.available && row.runtime.reason === "integrity_failed"), true,
    "a later list reads the now-revoked runtime instead of reusing the prior reply");
  assert.equal(f.reads, 2);
});

test("roster metadata cannot authorize a revoked runtime or hide an inventory failure", () => {
  const f = fixture(), agent = f.members[0], list = f.resources.agents.list();
  const bound = f.resources.agents.bindTask(createTaskExecution("bounded fixture", "snapshot"), agent.agentId, agent.configRevision, agent.agentEpoch);
  f.available(false);
  assert.equal(f.resources.agents.get(agent.agentId).runtime.available, false);
  assert.equal(f.resources.agents.list().agents.find(row => row.agentId === agent.agentId).runtime.available, false);
  assert.throws(() => f.resources.agents.bindTask(createTaskExecution("must not run", "revoked"), agent.agentId, agent.configRevision, agent.agentEpoch), /not available/);
  assert.throws(() => f.resources.agents.resolveTask(bound.workspaceAgentBinding), /not available/);
  assert.equal(list.agents.find(row => row.agentId === agent.agentId).runtime.available, true,
    "retained display metadata is not an execution grant");
  f.failure(true);
  assert.throws(() => f.resources.agents.list(), /inventory unavailable/);
  assert.throws(() => f.resources.agents.get(agent.agentId), /inventory unavailable/);
});

test("a warm roster still rejects resource authority and mid-read generation changes", () => {
  const f = fixture(); f.resources.agents.list();
  f.authority(false);
  assert.throws(() => f.resources.agents.list(), /authority revoked/);
  f.authority(true);
  const directory = join(f.home, ".hara", "workspace-data", "v1", workspaceResourceScopeKey(f.scope));
  const marker = join(directory, "scope.json"), original = fs.readFileSync(marker);
  const catalog = join(directory, "state", ".hara", "workspace-agents.json");
  const before = createHash("sha256").update(fs.readFileSync(catalog)).digest("hex");
  f.onRead(() => {
    const value = JSON.parse(original.toString()); value.generation = randomUUID();
    fs.writeFileSync(marker, JSON.stringify(value), { mode: 0o600 });
  });
  try { assert.throws(() => f.resources.agents.list(), /scope marker changed|generation/); }
  finally { f.onRead(undefined); fs.writeFileSync(marker, original, { mode: 0o600 }); }
  assert.equal(createHash("sha256").update(fs.readFileSync(catalog)).digest("hex"), before,
    "failed read does not mutate the persisted Agent catalog");
});
