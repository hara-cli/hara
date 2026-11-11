import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AgentBoundaryContractError, AGENT_HUB_ERRORS, parseAgentBoundaryDocument,
  parseAgentHubDocument, assertAgentHubBinding, createAgentHubBoundaryContract } from "../dist/workspace/agent-boundaries-contract.js";
const corpus = JSON.parse(readFileSync(new URL("./fixtures/agent-boundaries-v1.json", import.meta.url), "utf8"));
const byName = name => corpus.hubValid.find(item => item.name === name).document;
const binding = byName("saved").binding;
const facts = Object.fromEntries(["messageId", "requestId", "connectionId", "seq", "savedAt"].map(key => [key, byName("saved")[key]]));
const expectCode = (fn, code = "INVALID_DOCUMENT") => assert.throws(fn, error => error instanceof AgentBoundaryContractError && error.code === code);
for (const { name, document } of corpus.hubValid) test(`C0 Hub accepted fixture: ${name}`, () => {
  const parsed = parseAgentHubDocument(document);
  assert.deepEqual(parsed, document);
  assert.ok(Object.isFrozen(parsed) && Object.isFrozen(parsed.binding));
  assertAgentHubBinding(parsed, binding);
  expectCode(() => parseAgentBoundaryDocument(parsed));
  assert.equal("context" in parsed, false); assert.equal("actorChain" in parsed, false);
  assert.equal("permit" in parsed, false); assert.equal("execution" in parsed, false);
});
for (const { name, from, edits, errorCode } of corpus.hubInvalid) test(`C0 Hub refuses fixture: ${name}`, () => {
  const raw = structuredClone(byName(from));
  for (const edit of edits) {
    let target = raw; for (const key of edit.path.slice(0, -1)) target = target[key];
    const key = edit.path[edit.path.length - 1];
    if (edit.delete) delete target[key]; else target[key] = edit.value;
  }
  expectCode(() => parseAgentHubDocument(raw), errorCode);
});
test("C0 Hub factory matches the existing registered-agent and five-save-facts injection ports", () => {
  const contract = createAgentHubBoundaryContract(binding);
  const agent = { agentId: "registered-a", instanceId: "boot-a", alias: "not-an-id", displayName: "Synthetic", engine: "codex" };
  const source = contract.externalSource(agent);
  assert.deepEqual(source, byName("external-source"));
  assert.ok(Object.isFrozen(source.actor)); assert.ok(Object.isFrozen(contract));
  assert.equal("alias" in source, false); assert.equal("engine" in source, false);
  agent.agentId = "changed-after-snapshot"; assert.equal(source.actor.externalAgentId, "registered-a");
  assert.equal(contract.isExternalSource(source), true);
  const saved = contract.savedReceipt(facts); assert.deepEqual(saved, byName("saved"));
  assert.equal(contract.isSavedReceipt(saved), true);
  assert.equal(contract.isExternalSource(saved), false); assert.equal(contract.isSavedReceipt(source), false);
  assert.equal(contract.isSavedReceipt(byName("transport-delivered")), false);
});
test("C0 Hub validators fence exact scope and generation, and capture an immutable binding", () => {
  const mutable = structuredClone(binding); const contract = createAgentHubBoundaryContract(mutable);
  mutable.scopeKey = "f".repeat(64); mutable.generation = "44444444-4444-4444-8444-444444444444";
  assert.deepEqual(contract.savedReceipt(facts).binding, binding);
  for (const mutate of [v => v.binding.scopeKey = "f".repeat(64), v => v.binding.generation = mutable.generation]) {
    const source = structuredClone(byName("external-source")); mutate(source);
    assert.equal(contract.isExternalSource(source), false);
    expectCode(() => assertAgentHubBinding(source, binding), "CONTEXT_MISMATCH");
    const saved = structuredClone(byName("saved")); mutate(saved); assert.equal(contract.isSavedReceipt(saved), false);
  }
});
test("C0 Hub shape validation never authenticates an agent or proves a storage commit", () => {
  const forged = structuredClone(byName("external-source")); forged.actor.externalAgentId = "forged-registered-claim";
  assert.equal(parseAgentHubDocument(forged).actor.externalAgentId, "forged-registered-claim");
  assert.equal(createAgentHubBoundaryContract(binding).isExternalSource(forged), true);
  // The actual Hub authenticates the connection and compares its frozen registered pair separately.
  const saved = createAgentHubBoundaryContract(binding).savedReceipt(facts);
  assert.equal(saved.status, "saved"); assert.equal("authorized" in saved, false);
  assert.equal("applied" in saved, false); assert.equal("storageProof" in saved, false);
});
test("C0 Hub parser rejects human command documents and all executable transport states", () => {
  for (const fixture of corpus.valid) expectCode(() => parseAgentHubDocument(fixture.document));
  for (const status of ["applying", "applied", "draining", "drained", "read", "executed"]) {
    expectCode(() => parseAgentHubDocument({ ...byName("transport-delivered"), status }));
  }
});
test("C0 Hub recovery pairs preserve unknown outcome and redact free-form diagnostics", () => {
  for (const [code, retry] of Object.entries(AGENT_HUB_ERRORS)) {
    const receipt = structuredClone(byName(code === "dispatch_unknown" ? "transport-unknown" : "transport-rejected"));
    receipt.error = { code, retry };
    assert.deepEqual(parseAgentHubDocument(receipt).error, { code, retry });
  }
  const rejected = structuredClone(byName("transport-rejected"));
  rejected.error.private_token = "do-not-leak-synthetic-value";
  assert.throws(() => parseAgentHubDocument(rejected), error => error instanceof AgentBoundaryContractError
    && !error.message.includes("private_token") && !error.message.includes("do-not-leak"));
});
test("C0 Hub no getters, non-JSON values or credential fields cross parser or injected validators", () => {
  const contract = createAgentHubBoundaryContract(binding); let invoked = false;
  const getter = structuredClone(byName("external-source"));
  Object.defineProperty(getter.actor, "externalAgentId", { enumerable: true, get() { invoked = true; throw new Error("private-value"); } });
  expectCode(() => parseAgentHubDocument(getter)); assert.equal(contract.isExternalSource(getter), false); assert.equal(invoked, false);
  for (const raw of [null, undefined, NaN, new Date(), new Map(), Symbol("fixture")]) {
    assert.equal(contract.isExternalSource(raw), false); assert.equal(contract.isSavedReceipt(raw), false);
  }
  const wrongFacts = { ...facts, token: "synthetic-only" }; expectCode(() => contract.savedReceipt(wrongFacts));
  const agent = { instanceId: "boot-a" };
  Object.defineProperty(agent, "agentId", { enumerable: true, get() { invoked = true; return "forged"; } });
  expectCode(() => contract.externalSource(agent)); assert.equal(invoked, false);
  const polluted = JSON.parse('{"__proto__":{"humanPrincipal":"forged"}}'); expectCode(() => parseAgentHubDocument(polluted));
});
