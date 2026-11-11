import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { AGENT_BOUNDARIES_CONTRACT, AGENT_BOUNDARIES_ACTION_PHASE, AgentBoundaryContractError,
  parseAgentBoundaryDocument, assertAgentBoundaryContext, agentBoundaryCommandSigningText, draftAgentBoundaryMigration } from "../dist/workspace/agent-boundaries-contract.js";
const fixtures = JSON.parse(readFileSync(new URL("./fixtures/agent-boundaries-v1.json", import.meta.url), "utf8"));
const byName = name => fixtures.valid.find(item => item.name === name).document;
const sha = text => createHash("sha256").update(text).digest("hex");
function expectCode(fn, code) {
  assert.throws(fn, error => error instanceof AgentBoundaryContractError && error.code === code);
}
for (const { name, document } of fixtures.valid) test(`C0 accepted wire fixture: ${name}`, () => {
  const value = parseAgentBoundaryDocument(document);
  assert.deepEqual(value, document);
  assert.ok(Object.isFrozen(value) && Object.isFrozen(value.context) && Object.isFrozen(value.context.collaboration));
  assertAgentBoundaryContext(value, document.context);
  if (value.kind === "command") assert.equal(sha(agentBoundaryCommandSigningText(value)), value.intentDigest);
});
for (const { name, from, edits, errorCode } of fixtures.invalid) test(`C0 refuses malformed/deferred fixture: ${name}`, () => {
  const raw = structuredClone(byName(from));
  for (const edit of edits) {
    let target = raw; for (const key of edit.path.slice(0, -1)) target = target[key];
    const key = edit.path[edit.path.length - 1];
    if (edit.delete) delete target[key]; else target[key] = edit.value;
  }
  expectCode(() => parseAgentBoundaryDocument(raw), errorCode);
});
test("C0 scope comparison includes authority, resource generation, human, node and grant revision", () => {
  const value = parseAgentBoundaryDocument(byName("dispatch"));
  const mutations = [ctx => ctx.scope.authority.localAuthorityId = "33333333-3333-4333-8333-333333333333",
    ctx => ctx.resourceBinding.generation = "33333333-3333-4333-8333-333333333333",
    ctx => { ctx.humanSubjectId = "other-human"; ctx.localGrant.humanSubjectId = "other-human"; },
    ctx => { ctx.nodeId = "other-node"; ctx.localGrant.nodeId = "other-node"; }, ctx => ctx.localGrant.grantRevision++,
    ctx => ctx.scope.authority = { kind: "account", accountRegion: "CN", issuer: "https://accounts.example.test", realmId: "33333333-3333-4333-8333-333333333333" }];
  for (const mutate of mutations) {
    const expected = structuredClone(value.context); mutate(expected);
    expectCode(() => assertAgentBoundaryContext(value, expected), "CONTEXT_MISMATCH");
  }
});
test("C0 parser does not authenticate a consistently forged human or create any permit", () => {
  const raw = structuredClone(byName("dispatch"));
  raw.context.humanSubjectId = raw.context.localGrant.humanSubjectId = raw.actorChain.requestedBy = "forged-human";
  const syntaxOnly = parseAgentBoundaryDocument(raw);
  // Correct syntax is deliberately insufficient: the trusted C1 composition must supply the actual context/proof.
  expectCode(() => assertAgentBoundaryContext(syntaxOnly, byName("dispatch").context), "CONTEXT_MISMATCH");
  assert.equal("permit" in syntaxOnly, false);
  assert.equal("authorized" in syntaxOnly, false);
  assert.notEqual(sha(agentBoundaryCommandSigningText(syntaxOnly)), syntaxOnly.intentDigest);
});
test("C0 command signing input is deterministic and binds context, source, revisions, root and exact operation", () => {
  const value = structuredClone(byName("dispatch"));
  const original = agentBoundaryCommandSigningText(value);
  const reordered = Object.fromEntries(Object.entries(value).reverse());
  assert.equal(agentBoundaryCommandSigningText(reordered), original);
  const changes = [v => v.rootRequestId = "other-root", v => v.operation.messageDigest = "f".repeat(64),
    v => v.expected.controlEpoch++, v => v.provenance.proofRef = "other-proof",
    v => v.context.resourceBinding.generation = "33333333-3333-4333-8333-333333333333"];
  for (const change of changes) { const next = structuredClone(value); change(next); assert.notEqual(agentBoundaryCommandSigningText(next), original); }
  const next = structuredClone(value); next.intentDigest = "e".repeat(64);
  assert.equal(agentBoundaryCommandSigningText(next), original); // No self-referential digest.
});
test("C0 preserves unknown effects even after physical drain; no transport ACK is terminal evidence", () => {
  const offline = parseAgentBoundaryDocument(byName("stop-offline")); assert.equal(offline.status, "queued");
  const uncertain = parseAgentBoundaryDocument(byName("process-drained-effect-unknown"));
  assert.equal(uncertain.status, "unknown"); assert.equal(uncertain.execution.drain, "observed");
  assert.equal(uncertain.error.retry, "original_receipt_only");
  expectCode(() => parseAgentBoundaryDocument({ ...byName("stop-drained"), delivered: true }), "INVALID_DOCUMENT");
});
test("C0 rejects non-JSON inputs without evaluating getters, and errors do not leak input values", () => {
  let invoked = false; const withGetter = structuredClone(byName("dispatch"));
  Object.defineProperty(withGetter, "leaked", { enumerable: true, get() { invoked = true; throw new Error("private-sentinel"); } });
  expectCode(() => parseAgentBoundaryDocument(withGetter), "INVALID_DOCUMENT"); assert.equal(invoked, false);
  for (const value of [NaN, Infinity, -0, undefined, new Date(), new Map(), Symbol("fixture")]) {
    const raw = structuredClone(byName("dispatch")); raw.expected.controlEpoch = value;
    expectCode(() => parseAgentBoundaryDocument(raw), "INVALID_DOCUMENT");
  }
  const secret = { ...byName("dispatch"), private_sentinel: "never-log-this-value" };
  assert.throws(() => parseAgentBoundaryDocument(secret), error => !error.message.includes("sentinel") && !error.message.includes("never-log"));
  const polluted = JSON.parse('{"__proto__":{"authorized":true}}'); expectCode(() => parseAgentBoundaryDocument(polluted), "INVALID_DOCUMENT");
  const sparse = structuredClone(byName("boundary")); sparse.resources = new Array(1); expectCode(() => parseAgentBoundaryDocument(sparse), "INVALID_DOCUMENT");
});
for (const source of fixtures.migrationSources) test(`C0 migration draft preserves bytes and grants nothing: ${source.name}`, async () => {
  const original = source.sourceText;
  const draft = await draftAgentBoundaryMigration(original, source.sourceRef, byName("dispatch").context);
  assert.deepEqual(draft, byName(source.expectedDocument)); assert.equal(source.sourceText, original);
  assert.equal(draft.sourceDigest, sha(original)); assert.equal(draft.runnable, false); assert.equal(draft.issuedGrant, null);
  assert.equal("sourceText" in draft, false); assert.equal("resources" in draft, false);
  const changedWhitespace = await draftAgentBoundaryMigration(original + "\n", source.sourceRef, byName("dispatch").context);
  assert.notEqual(changedWhitespace.sourceDigest, draft.sourceDigest);
});
test("C0 corrupt/future legacy state is refused, never replaced with empty/default permissions", async () => {
  for (const source of ['{broken', '{"schemaVersion":99}', '[]']) {
    await assert.rejects(draftAgentBoundaryMigration(source, "fixture", byName("dispatch").context), error => error.code === "INVALID_DOCUMENT");
  }
});
test("C0 Core/Desktop mirror and fixtures are pinned to the same contract lock", () => {
  const lock = JSON.parse(readFileSync(new URL("../docs/contracts/agent-boundaries-v1.lock.json", import.meta.url), "utf8"));
  assert.equal(lock.contract, AGENT_BOUNDARIES_CONTRACT); assert.equal(lock.runtimeEnabled, false);
  assert.equal(sha(readFileSync(new URL("../src/workspace/agent-boundaries-contract.ts", import.meta.url))), lock.sourceSha256);
  assert.equal(sha(readFileSync(new URL("./fixtures/agent-boundaries-v1.json", import.meta.url))), lock.fixturesSha256);
});
test("C0 full command taxonomy reserves deferred actions without accepting them", () => {
  assert.equal(Object.keys(AGENT_BOUNDARIES_ACTION_PHASE).length, 14);
  for (const action of ["task.reprioritize", "task.handoff", "agent.memory.read", "approval.decide", "agent.share", "task.report.route"]) assert.equal(AGENT_BOUNDARIES_ACTION_PHASE[action], "1.3.x");
});
test("C0 contract types compile for this consumer and reject a permit, team mode, mutation and incomplete stop", () => {
  execFileSync(process.execPath, [fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url)),
    "--project", "test/fixtures/agent-boundaries.tsconfig.json"], { cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: "pipe" });
});

test("C0 scope tuple and binding hash remain compatible with existing Core resource identity", async () => {
  const { parseWorkspaceResourceScope, workspaceResourceScopeKey } = await import("../dist/workspace/resource-context.js");
  for (const row of fixtures.valid) {
    assert.deepEqual(parseWorkspaceResourceScope(row.document.context.scope), row.document.context.scope);
    assert.equal(workspaceResourceScopeKey(row.document.context.scope), row.document.context.resourceBinding.scopeKey);
  }
});
