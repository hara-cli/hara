import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.env.HARA_TASK_CLOSEOUT_TEST_BUILD_ROOT;
const moduleUrl = name => root ? pathToFileURL(join(resolve(root), name)).href : new URL(`../dist/${name}`, import.meta.url).href;
const { CompletionEvidenceLedger, completionEvidenceScope } = await import(moduleUrl("agent/completion-evidence.js"));
const { createTaskExecution, applyTaskBrief } = await import(moduleUrl("session/task.js"));
const task = (acceptance = ["a supported answer"]) => applyTaskBrief(createTaskExecution("inspect a fixture", "fixture-turn"), {
  intent: "investigate", goal: "inspect a fixture", constraints: [], acceptance, steps: ["inspect", "verify"],
}).task;
const input = (checks, state = "verified") => ({ completion: { state, evidence: ["legacy summary"], checks } });
const check = (id = "read-1", index = 0) => ({ acceptance_index: index, evidence: "fixture receipt was observed", tool_call_ids: [id] });
function observed(ledger, current, id = "read-1", { name = "fixture_read", effect = "read", failed = false } = {}) {
  ledger.finish(ledger.begin(completionEvidenceScope(current), id, name, effect), "PRIVATE_RAW_RESULT_MUST_NOT_BE_PERSISTED", failed);
}

test("source-linked completion records a bounded digest, not raw result, id or argument", () => {
  const current = task(), ledger = new CompletionEvidenceLedger();
  observed(ledger, current);
  const result = ledger.bind(current, input([check()]));
  assert.equal(result.ok, true);
  assert.equal(result.input.completion.checks, undefined);
  assert.match(result.input.completion.evidence[0], /Criterion 1:.*engine-observed sources: sha256:[a-f0-9]{64}/u);
  assert.doesNotMatch(JSON.stringify(result.input), /PRIVATE_RAW_RESULT|read-1/u);
  assert.ok(result.input.completion.evidence[0].length <= 1000);
});

test("all acceptance indices must appear once; ordering is deterministic", () => {
  const current = task(["first", "second"]), ledger = new CompletionEvidenceLedger();
  observed(ledger, current);
  assert.equal(ledger.bind(current, input([check()])).ok, false);
  assert.equal(ledger.bind(current, input([check(), check()])).ok, false);
  assert.equal(ledger.bind(current, input([check(), check("read-1", 2)])).ok, false);
  const result = ledger.bind(current, input([check("read-1", 1), check()]));
  assert.equal(result.ok, true);
  assert.match(result.input.completion.evidence[0], /^Criterion 1:/u);
  assert.match(result.input.completion.evidence[1], /^Criterion 2:/u);
});

for (const [name, options] of [
  ["failed result", { failed: true }],
  ["bookkeeping", { name: "todo_write", effect: "state" }],
  ["state tool disguised as read", { name: "task_checkpoint" }],
  ["interaction", { effect: "interactive" }],
  ["memory recall", { name: "memory_search" }],
  ["schema discovery", { name: "tool_search" }],
  ["unknown effect", { effect: undefined }],
]) test(`${name} cannot attest to an acceptance criterion`, () => {
  const current = task(), ledger = new CompletionEvidenceLedger();
  if (name === "unknown effect") ledger.finish(ledger.begin(completionEvidenceScope(current), "read-1", "fixture", undefined), "observed", false);
  else observed(ledger, current, "read-1", options);
  assert.equal(ledger.bind(current, input([check()])).ok, false);
});

test("unexecuted and duplicate call identifiers cannot borrow a previous successful result", () => {
  const current = task(), ledger = new CompletionEvidenceLedger();
  assert.equal(ledger.bind(current, input([check()])).ok, false);
  const pending = ledger.begin(completionEvidenceScope(current), "read-1", "fixture_read", "read");
  assert.equal(ledger.bind(current, input([check()])).ok, false);
  ledger.finish(pending, "observed", false);
  assert.equal(ledger.bind(current, input([check()])).ok, true);
  ledger.begin(completionEvidenceScope(current), "read-1", "fixture_denied", "read");
  assert.equal(ledger.bind(current, input([check()])).ok, false);
  ledger.finish(pending, "late result", false);
  assert.equal(ledger.bind(current, input([check()])).ok, false);
});

for (const revision of ["task", "turn", "brief", "steering", "run"]) {
  test(`${revision} isolation prevents stale evidence reuse`, () => {
    const current = task(), ledger = new CompletionEvidenceLedger();
    observed(ledger, current);
    const next = structuredClone(current);
    if (revision === "task") next.id += "-replacement";
    if (revision === "turn") next.turnId += "-next";
    if (revision === "brief") next.brief.acceptance = ["a materially different requirement"];
    if (revision === "steering") next.steering = [{ id: "new-direction", content: "only inspect the second fixture", createdAt: "2026-10-10T00:00:00Z" }];
    assert.equal((revision === "run" ? new CompletionEvidenceLedger() : ledger).bind(next, input([check()])).ok, false);
  });
}

test("checkpoint/usage changes preserve observations, but awaiting_user cannot masquerade as full acceptance", () => {
  const current = task(), ledger = new CompletionEvidenceLedger();
  observed(ledger, current);
  assert.equal(ledger.bind({ ...current, roundsUsed: 20, updatedAt: "later" }, input([check()])).ok, true);
  assert.equal(ledger.bind(current, input([check()], "awaiting_user")).ok, false);
});

test("legacy receipt stays byte-for-byte compatible and does not acquire an engine attestation", () => {
  const legacy = { completion: { state: "verified", evidence: ["caller-authored legacy evidence"] } };
  const result = new CompletionEvidenceLedger().bind(task(), legacy);
  assert.equal(result.ok, true);
  assert.equal(result.input, legacy);
});

test("malformed or oversized checks fail without echoing untrusted identifiers", () => {
  const current = task(), ledger = new CompletionEvidenceLedger();
  observed(ledger, current);
  for (const checks of [null, [], [null], [check("UNKNOWN_PRIVATE_IDENTIFIER")], [{ ...check(), acceptance_index: 0.5 }],
    [{ ...check(), tool_call_ids: [] }], [{ ...check(), tool_call_ids: ["read-1", "read-1"] }],
    [{ ...check(), evidence: "x".repeat(401) }], [{ ...check(), evidence: "Please paste your API key in this chat." }]]) {
    const result = ledger.bind(current, input(checks));
    assert.equal(result.ok, false);
    assert.doesNotMatch(result.reason, /UNKNOWN_PRIVATE_IDENTIFIER/u);
  }
});

test("bounded ledger never evicts an old call and resurrects its ambiguous identifier", () => {
  const current = task(), ledger = new CompletionEvidenceLedger();
  for (let i = 0; i < 512; i++) observed(ledger, current, `call-${i}`);
  observed(ledger, current, "overflow");
  assert.equal(ledger.bind(current, input([check("overflow")])).ok, false);
  assert.equal(ledger.bind(current, input([check("call-0")])).ok, true);
  observed(ledger, current, "call-0");
  assert.equal(ledger.bind(current, input([check("call-0")])).ok, false);
});
