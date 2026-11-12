import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createAgentDutyDraft, parseAgentDutyDraft, parseAgentDutyPublicProfile, agentDutyDraftProposal } from "../dist/workspace/agent-duty-draft.js";
import { WorkspaceAgentBoundaryAuthority } from "../dist/workspace/agent-boundary-authority.js";
import { AgentBoundaryContractError, parseAgentBoundaryDocument } from "../dist/workspace/agent-boundaries-contract.js";
import { emptyAgentRoutingState, parseAgentRoutingState, assertAgentRoutingTransition } from "../dist/workspace/agent-routing-state.js";
import { workspaceAgentCommandProtected } from "../dist/workspace/agent-command-protection.js";
import { lifecycleFixture } from "./helpers/agent-lifecycle-fixture.mjs";
const code = expected => error => error instanceof AgentBoundaryContractError && error.code === expected;
const profile = { title: "Finance", description: "Reconcile the approved books", owns: ["invoice"], rejects: ["publish"] };

test("C6 onboarding and C5 duties use exactly the canonical public profile, remaining unconfirmed data", t => {
  const f = lifecycleFixture(t), draft = createAgentDutyDraft(profile);
  assert.deepEqual(draft, { schemaVersion: 1, kind: "duty-draft", status: "unconfirmed", publicProfile: profile });
  assert.ok(Object.isFrozen(draft.publicProfile.owns));
  const before = fs.readFileSync(f.file, "utf8"), proposal = agentDutyDraftProposal(draft, f.duty.context, f.agent.agentId, 2);
  assert.equal(parseAgentBoundaryDocument(proposal).kind, "duty-profile"); assert.equal(proposal.dutyRevision, 2);
  assert.deepEqual(proposal.publicProfile, profile); assert.equal(fs.readFileSync(f.file, "utf8"), before);
  assert.throws(() => parseAgentDutyDraft({ ...draft, status: "confirmed" }), code("INVALID_DOCUMENT"));
  assert.throws(() => parseAgentDutyDraft({ ...draft, approved: true }), code("INVALID_DOCUMENT"));
  for (const key of ["instructions", "resources", "rights", "modelInvocable"]) assert.throws(() => parseAgentDutyPublicProfile({ ...profile, [key]: "all" }), code("INVALID_DOCUMENT"));
  assert.throws(() => parseAgentDutyPublicProfile({ ...profile, title: "x".repeat(161) }), code("INVALID_DOCUMENT"));
});

test("C6 duty draft and routing parsers reject getters without invoking them", t => {
  const f = lifecycleFixture(t); let reads = 0; const p = { ...profile };
  Object.defineProperty(p, "owns", { enumerable: true, get() { reads++; return ["secret"]; } });
  assert.throws(() => createAgentDutyDraft(p), code("INVALID_DOCUMENT"));
  const state = emptyAgentRoutingState("a".repeat(64), new Date().toISOString());
  Object.defineProperty(state, "records", { enumerable: true, get() { reads++; return []; } });
  assert.throws(() => parseAgentRoutingState(state, f.snapshot().control, f.duty.context.resourceBinding), code("AUTHORITY_UNVERIFIED")); assert.equal(reads, 0);
});

test("C6 explicit schema4 attachment retains C4 control, lifecycle, duty and boundary bytes", t => {
  const f = lifecycleFixture(t), before = f.snapshot();
  const authority = new WorkspaceAgentBoundaryAuthority({ ...f.authorityOptions, routingControl: true }); t.after(() => authority.close());
  authority.initializeAgentRouting(f.transport, f.agent.agentId); const after = f.snapshot();
  assert.equal(after.schemaVersion, 4); assert.deepEqual(after.control, before.control); assert.deepEqual(after.lifecycle, before.lifecycle); assert.deepEqual(after.policies, before.policies);
  assert.deepEqual(after.routing.records, []); assert.equal(after.routing.migration.fromSchema, 3);
  assert.equal(authority.commandLifecycleInitialized(), true); assert.equal(authority.commandRoutingInitialized(), true);
  assert.equal(f.storage.run(() => workspaceAgentCommandProtected(f.storage)), true);
  const bytes = fs.readFileSync(f.file, "utf8"); authority.initializeAgentRouting(f.transport, f.agent.agentId); assert.equal(fs.readFileSync(f.file, "utf8"), bytes);
});

test("C6 disabled/older readers cannot write or downgrade the schema4 attachment", t => {
  const f = lifecycleFixture(t), authority = new WorkspaceAgentBoundaryAuthority({ ...f.authorityOptions, routingControl: true }); t.after(() => authority.close());
  authority.initializeAgentRouting(f.transport, f.agent.agentId); const before = fs.readFileSync(f.file, "utf8");
  assert.throws(() => f.authority.commandControlState(), code("AUTHORITY_UNVERIFIED"));
  assert.throws(() => f.authority.draft(f.transport, f.agent.agentId, { commandId: "old", rootRequestId: "root", lifetimeMs: 1000, operation: { action: "agent.pause", reason: "human_request" } }), code("AUTHORITY_UNVERIFIED"));
  assert.equal(fs.readFileSync(f.file, "utf8"), before);
  const partial = JSON.parse(before); partial.schemaVersion = 3;
  fs.writeFileSync(f.file, JSON.stringify(partial)); assert.throws(() => f.storage.run(() => workspaceAgentCommandProtected(f.storage)), code("AUTHORITY_UNVERIFIED")); fs.writeFileSync(f.file, before);
});

test("C6 migration refuses a live physical lease without discarding or accepting its preparation", t => {
  const f = lifecycleFixture(t), d = f.dispatch(), before = fs.readFileSync(f.file, "utf8");
  const authority = new WorkspaceAgentBoundaryAuthority({ ...f.authorityOptions, routingControl: true }); t.after(() => authority.close());
  assert.throws(() => authority.initializeAgentRouting(f.transport, f.agent.agentId), code("CONTROL_HELD"));
  assert.equal(fs.readFileSync(f.file, "utf8"), before); d.lease.assertCurrent(); d.lease.release();
  authority.initializeAgentRouting(f.transport, f.agent.agentId); assert.deepEqual(f.snapshot().control, JSON.parse(before).control);
});

test("C6 observed schema downgrade is fenced even after original bytes are restored", t => {
  const f = lifecycleFixture(t), authority = new WorkspaceAgentBoundaryAuthority({ ...f.authorityOptions, routingControl: true }); t.after(() => authority.close());
  authority.initializeAgentRouting(f.transport, f.agent.agentId); const before = fs.readFileSync(f.file, "utf8"), snapshot = authority.commandControlState();
  const partial = JSON.parse(before); partial.schemaVersion = 3; delete partial.routing; fs.writeFileSync(f.file, JSON.stringify(partial));
  assert.throws(() => authority.observeCommandControl(snapshot.revision, state => state), code("AUTHORITY_UNVERIFIED")); fs.writeFileSync(f.file, before);
  assert.equal(authority.commandControlSourceHealthy(), false);
});

test("C6 private routing syntax has bounded state and immutable origin, no C0 enum changes", t => {
  const f = lifecycleFixture(t), state = emptyAgentRoutingState("a".repeat(64), new Date().toISOString()), control = f.snapshot().control;
  assert.deepEqual(parseAgentRoutingState(state, control, f.duty.context.resourceBinding), state);
  assert.throws(() => parseAgentRoutingState({ ...state, records: Array.from({ length: 129 }, () => ({})) }, control, f.duty.context.resourceBinding), code("AUTHORITY_UNVERIFIED"));
  assert.throws(() => assertAgentRoutingTransition(state, { ...state, migration: { ...state.migration, sourceDigest: "b".repeat(64) } }), code("AUTHORITY_UNVERIFIED"));
});
