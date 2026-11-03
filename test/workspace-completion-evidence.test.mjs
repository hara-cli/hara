import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompletionEvidenceLedger, completionEvidenceScope } from "../dist/agent/completion-evidence.js";
import { createWorkspaceCompletionEvidence } from "../dist/workspace/completion-evidence-store.js";
import { WorkspaceResourceStorage, workspaceStateHome, currentWorkspaceResourceBinding } from "../dist/workspace/resource-context.js";
import { workspaceAgentBindingHash } from "../dist/workspace/run-binding.js";
import { createTaskExecution, applyTaskBrief, continueTaskExecution, recordTaskDecision } from "../dist/session/task.js";

const temporary = [];
after(() => { for (const owned of temporary) fs.rmSync(owned, { recursive: true, force: true }); });
const hash = value => createHash("sha256").update(value).digest("hex");
function fixture() {
  const home = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "hara-completion-journal-")));
  temporary.push(home); fs.chmodSync(home, 0o700);
  const scope = { schemaVersion: 1, workspaceId: "ws_" + randomUUID(), authority: { kind: "local", localAuthorityId: randomUUID() } };
  let revoked = false;
  const storage = new WorkspaceResourceStorage(home, scope, () => { if (revoked) throw new Error("synthetic authority revoked"); });
  storage.initialize();
  const task = applyTaskBrief(createTaskExecution("change the approved fixture", randomUUID()), {
    intent: "change", goal: "change the approved fixture", constraints: [], acceptance: ["fixture bytes verified"], steps: ["write", "verify"],
  }).task;
  const agent = { schemaVersion: 1, resourceBinding: storage.run(() => currentWorkspaceResourceBinding()), workspaceId: scope.workspaceId,
    agentId: "ag_" + randomUUID(), agentEpoch: 1, configRevision: 1, configHash: "a".repeat(64), runtimeId: "pi", taskId: task.id };
  const binding = { schemaVersion: 1, scope, agent, agentBindingHash: workspaceAgentBindingHash(agent),
    connection: { connectionId: "mc_" + randomUUID(), credentialGeneration: "gen_" + randomUUID(), connectionRevision: 1, model: "synthetic", reasoning: null },
    runtimeContract: "hara-governed-pi-v1", project: { root: home, dev: 1, ino: 2 }, sessionId: randomUUID(), runId: randomUUID(),
    lineage: { rootRunId: null, parentRunId: null, depth: 0 }, createdAt: new Date().toISOString(),
    host: { hostId: randomUUID(), hostEpoch: 1, grantId: randomUUID(), grantRevision: 1, actorId: randomUUID(), policyRevision: 1 },
    budget: { maxRounds: 12, maxToolCalls: 32, maxTokens: 128000, timeoutMs: 120000 } };
  task.workspaceRunBinding = binding; task.workspaceAgentBinding = agent;
  const path = storage.run(() => join(workspaceStateHome(), ".hara", "completion-" + hash(binding.runId) + ".json"));
  return { storage, binding, task, path, open: () => createWorkspaceCompletionEvidence(storage, binding), revoke: () => { revoked = true; } };
}
const checkpoint = id => ({ completion: { state: "verified", checks: [{ acceptance_index: 0,
  evidence: "exact fixture bytes were observed", tool_call_ids: [id] }] } });
function observe(ledger, task, id = "write-1", effect = "edit", failed = false, name = "fixture_write") {
  const observation = ledger.begin(completionEvidenceScope(task), id, name, effect);
  ledger.finish(observation, "PRIVATE_RAW_RESULT_AND_CREDENTIAL_SENTINEL", failed);
  return observation;
}
test("protected same-frozen-run dispatch journal survives restart without storing content or native evidence", () => {
  const f = fixture(), ledger = f.open();
  assert.equal(fs.existsSync(f.path), false);
  observe(ledger, f.task);
  assert.equal(f.open().bind(f.task, checkpoint("write-1")).ok, true);
  const raw = fs.readFileSync(f.path, "utf8");
  assert.doesNotMatch(raw, /PRIVATE_RAW_RESULT|write-1|fixture_write|change the approved fixture/);
  assert.equal(fs.statSync(f.path).mode & 0o777, 0o600);
  assert.equal(JSON.parse(raw).snapshot.observations.length, 1);
  assert.equal(new CompletionEvidenceLedger().bind(f.task, checkpoint("write-1")).ok, false, "history alone never seeds receipts");
});
test("persisted pending, failed, bookkeeping and read-only results cannot attest to a change", () => {
  for (const variant of ["pending", "failed", "bookkeeping", "read"]) {
    const f = fixture(), ledger = f.open();
    if (variant === "pending") ledger.begin(completionEvidenceScope(f.task), "write-1", "fixture_write", "edit");
    else observe(ledger, f.task, "write-1", variant === "read" ? "read" : "edit", variant === "failed",
      variant === "bookkeeping" ? "task_checkpoint" : "fixture_write");
    assert.equal(f.open().bind(f.task, checkpoint("write-1")).ok, false, variant);
  }
});
test("duplicate identifiers remain ambiguous across restarts, including late success", () => {
  const f = fixture(), original = f.open(), pending = observe(original, f.task);
  const resumed = f.open();
  resumed.begin(completionEvidenceScope(f.task), "write-1", "fixture_write", "edit");
  assert.equal(f.open().bind(f.task, checkpoint("write-1")).ok, false);
  assert.throws(() => original.finish(pending, "late success", false), /state changed/);
  assert.equal(original.bind(f.task, checkpoint("write-1")).ok, false, "failed persistence cannot retain an in-memory attestation");
});
test("a changed frozen authority or copied cross-run document is rejected and preserved", () => {
  const f = fixture(); observe(f.open(), f.task);
  const raw = fs.readFileSync(f.path, "utf8");
  for (const edit of [
    b => b.budget.maxRounds++, b => b.project.ino++, b => b.connection.connectionRevision++,
    b => b.host.policyRevision++, b => { b.agent.configRevision++; b.agentBindingHash = workspaceAgentBindingHash(b.agent); },
  ]) {
    const changed = structuredClone(f.binding); edit(changed);
    assert.throws(() => createWorkspaceCompletionEvidence(f.storage, changed), /private completion run binding/);
    assert.equal(fs.readFileSync(f.path, "utf8"), raw);
  }
  const next = { ...f.binding, runId: randomUUID() };
  const nextPath = join(f.path, "..", "completion-" + hash(next.runId) + ".json");
  fs.writeFileSync(nextPath, raw, { mode: 0o600 });
  assert.throws(() => createWorkspaceCompletionEvidence(f.storage, next), /private completion run binding/);
  assert.equal(fs.readFileSync(nextPath, "utf8"), raw);
});
test("changed brief, turn, task, start time or steering cannot borrow same-run receipts", () => {
  const f = fixture(); observe(f.open(), f.task);
  for (const edit of [
    t => t.brief.acceptance.push("another requirement"), t => t.turnId += "-next", t => t.id += "-next",
    t => t.startedAt = "2026-10-01T00:00:00.000Z",
    t => t.steering = [{ id: "direction", content: "inspect a different file", createdAt: "2026-11-01T00:00:00.000Z" }],
  ]) {
    const next = structuredClone(f.task); edit(next);
    assert.equal(f.open().bind(next, checkpoint("write-1")).ok, false);
  }
});
test("native diff remains attempt-local even after a durable Host write", () => {
  const f = fixture(), ledger = f.open(); observe(ledger, f.task);
  ledger.observeNative(completionEvidenceScope(f.task), { verified: true, nativeEventCount: 1, id: "native-proof", digest: "b".repeat(64) });
  const input = { completion: { state: "verified", checks: [{ acceptance_index: 0,
    evidence: "native file diff observed", native_evidence_ids: ["native-proof"] }] } };
  assert.equal(ledger.bind(f.task, input).ok, true);
  assert.equal(f.open().bind(f.task, input).ok, false);
  assert.doesNotMatch(fs.readFileSync(f.path, "utf8"), /native-proof|nativeEventCount|bbbbbbbbbbbb/);
});
test("closed schema, corrupt digest, excessive observations and symlinks never restore provenance", () => {
  const f = fixture(); observe(f.open(), f.task);
  const raw = fs.readFileSync(f.path, "utf8");
  for (const edit of [
    d => d.snapshot.history = [],
    d => d.snapshot.observations[0].receipt = "not-a-digest",
    d => d.snapshot.observations[0].rawResult = "PRIVATE_SENTINEL",
    d => d.snapshot.observations.push(d.snapshot.observations[0]),
    d => d.snapshot.observations = Array(513).fill(d.snapshot.observations[0]),
  ]) {
    const next = JSON.parse(raw); edit(next); fs.writeFileSync(f.path, JSON.stringify(next), { mode: 0o600 });
    assert.throws(() => f.open(), /Invalid private completion provenance/);
  }
  fs.writeFileSync(f.path, raw); const retained = f.path + ".retained"; fs.renameSync(f.path, retained); fs.symlinkSync(retained, f.path);
  assert.throws(() => f.open(), /symbolic link|symlink|private.*state|resource/i);
});
test("revoked resource authority prevents pending dispatch receipts from being persisted", () => {
  const f = fixture(), ledger = f.open(); f.revoke();
  assert.throws(() => observe(ledger, f.task), /authority revoked/);
  assert.equal(fs.existsSync(f.path), false);
  assert.equal(ledger.bind(f.task, checkpoint("write-1")).ok, false);
});

test("trusted unchanged continuation combines durable prior effect with fresh verification, never old reads alone", () => {
  const f = fixture(), old = f.open(); observe(old, f.task);
  observe(old, f.task, "old-read", "read");
  const next = continueTaskExecution(structuredClone(f.task), { kind: "steer", expectedTurnId: f.task.turnId, turnId: randomUUID() }).task;
  const resumed = createWorkspaceCompletionEvidence(f.storage, f.binding, { previousTask: f.task, currentTask: next });
  assert.equal(resumed.bind(next, checkpoint("old-read")).ok, false);
  observe(resumed, next, "fresh-verify", "read");
  const bound = resumed.bind(next, checkpoint("fresh-verify"));
  assert.equal(bound.ok, true); assert.match(bound.input.completion.evidence[0], /Host-linked previous dispatch.*current state re-observed/);
  const unlinked = createWorkspaceCompletionEvidence(f.storage, f.binding);
  assert.equal(unlinked.bind(next, checkpoint("fresh-verify")).ok, false, "reopening without the trusted continuation link cannot borrow the old effect");
});
test("continuation cannot carry a failed, pending, ambiguous or native-only prior effect", () => {
  for (const variant of ["failed", "pending", "ambiguous", "native"]) {
    const f = fixture(), old = f.open();
    if (variant === "pending") old.begin(completionEvidenceScope(f.task), "write-1", "fixture_write", "edit");
    else if (variant === "native") old.observeNative(completionEvidenceScope(f.task), { verified: true, nativeEventCount: 1, id: "native", digest: "b".repeat(64) });
    else { observe(old, f.task, "write-1", "edit", variant === "failed"); if (variant === "ambiguous") old.begin(completionEvidenceScope(f.task), "write-1", "fixture_write", "edit"); }
    const next = continueTaskExecution(structuredClone(f.task), { kind: "steer", expectedTurnId: f.task.turnId, turnId: randomUUID() }).task;
    const resumed = createWorkspaceCompletionEvidence(f.storage, f.binding, { previousTask: f.task, currentTask: next });
    observe(resumed, next, "fresh-verify", "read");
    assert.equal(resumed.bind(next, checkpoint("fresh-verify")).ok, false, variant);
  }
});
test("changed task authority and forged binding cannot create a continuation link", () => {
  const f = fixture(); observe(f.open(), f.task);
  for (const edit of [
    t => t.brief.acceptance.push("new requirement"),
    t => t.objective += " and another scope",
    t => t.steering = [{ id: "new-direction", content: "change a different file", createdAt: new Date().toISOString() }],
    t => t.workspaceRunBinding = { ...t.workspaceRunBinding, runId: randomUUID() },
  ]) {
    const next = continueTaskExecution(structuredClone(f.task), { kind: "steer", expectedTurnId: f.task.turnId, turnId: randomUUID() }).task; edit(next);
    assert.throws(() => createWorkspaceCompletionEvidence(f.storage, f.binding, { previousTask: f.task, currentTask: next }), /private completion run binding/);
  }
});

test("an actual pending-question answer preserves prior effects only with the exact Host question and fresh verification", () => {
  const f = fixture(), old = f.open(); observe(old, f.task);
  const questionId = randomUUID();
  const answered = recordTaskDecision(f.task, { turnId: f.task.turnId, callId: questionId, question: "Which target?", answer: "Beta", source: "interactive" });
  assert.equal(answered.ok, true);
  const next = continueTaskExecution(answered.task, { kind: "steer", expectedTurnId: f.task.turnId, turnId: randomUUID() }).task;
  const resumed = createWorkspaceCompletionEvidence(f.storage, f.binding, { previousTask: f.task, currentTask: next, answeredQuestionId: questionId });
  assert.equal(resumed.bind(next, checkpoint("write-1")).ok, false);
  observe(resumed, next, "fresh-after-answer", "read");
  assert.equal(resumed.bind(next, checkpoint("fresh-after-answer")).ok, true);
  for (const bad of [undefined, randomUUID(), "not-a-question"]) assert.throws(() =>
    createWorkspaceCompletionEvidence(f.storage, f.binding, { previousTask: f.task, currentTask: next, answeredQuestionId: bad }), /private completion run binding/);
});
test("defaults, changed decision history and changed scope cannot acquire the pending-question recovery link", () => {
  const f = fixture(); observe(f.open(), f.task);
  const questionId = randomUUID();
  for (const variant of ["default", "rewritten", "scope", "wrong-turn", "extra-answer"]) {
    const answered = recordTaskDecision(f.task, { turnId: f.task.turnId, callId: questionId, question: "Which target?", answer: "Beta", source: "interactive" }).task;
    const next = continueTaskExecution(answered, { kind: "steer", expectedTurnId: f.task.turnId, turnId: randomUUID() }).task;
    if (variant === "default") next.decisions[0].source = "default";
    if (variant === "rewritten") next.decisions.unshift({ ...next.decisions[0], id: randomUUID(), callId: randomUUID() });
    if (variant === "scope") next.brief = { ...next.brief, constraints: ["a different authorized scope"] };
    if (variant === "wrong-turn") next.decisions[0].turnId = randomUUID();
    if (variant === "extra-answer") next.decisions.push({ ...next.decisions[0], id: randomUUID() });
    assert.throws(() => createWorkspaceCompletionEvidence(f.storage, f.binding,
      { previousTask: f.task, currentTask: next, answeredQuestionId: questionId }), /private completion run binding/, variant);
  }
});
