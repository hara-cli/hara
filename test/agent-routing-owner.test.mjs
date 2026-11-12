import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { nominateAgentOwner, parseAgentRoutingInput } from "../dist/workspace/agent-routing-owner.js";
import { createAgentDutyDraft, agentDutyDraftProposal } from "../dist/workspace/agent-duty-draft.js";
import { WorkspaceAgentBoundaryAuthority } from "../dist/workspace/agent-boundary-authority.js";
import { WorkspaceAgentCommandControl } from "../dist/workspace/agent-command-control.js";
import { agentPolicyProposalDigest } from "../dist/workspace/agent-command-state.js";
import { lifecycleFixture } from "./helpers/agent-lifecycle-fixture.mjs";
const input = (message, extras = {}) => parseAgentRoutingInput({ channelId: randomUUID(), workItemId: "item", requestId: "request", message, explicitAgentIds: [], leadAgentId: null, businessBindingRef: null, expectedWorkRevision: 0, ...extras });
const row = (agentId, owns, rejects = []) => ({ agentId, dutyRevision: 1, policyRevision: 1, agentEpoch: 1, configRevision: 1,
  publicProfile: { title: agentId, description: "Confirmed public duty", owns, rejects }, available: true, automatic: true });
const directory = [row("finance", ["invoice", "发票"], ["publish"]), row("engineer", ["compile"]), row("designer", ["layout"])];

test("C6 unique public duty nomination is invariant under candidate order, with no first-candidate fallback", () => {
  for (const roster of [directory, [...directory].reverse(), [directory[1], directory[0], directory[2]]]) {
    assert.deepEqual(nominateAgentOwner(input("invoice status"), roster), { ownerAgentId: "finance", method: "duty_match", reason: "selected", classificationCandidateIds: [] });
    const no = nominateAgentOwner(input("nothing understood"), roster); assert.equal(no.ownerAgentId, null); assert.equal(no.reason, "no_match");
    const tie = nominateAgentOwner(input("invoice compile"), roster); assert.equal(tie.ownerAgentId, null); assert.equal(tie.reason, "ambiguous"); assert.deepEqual(tie.classificationCandidateIds, []);
  }
  assert.equal(nominateAgentOwner(input("发票状态"), directory).ownerAgentId, "finance");
});

test("C6 rejects precede scores; duplicate terms and partial English words do not invent a winner", () => {
  assert.equal(nominateAgentOwner(input("publish invoice"), directory).ownerAgentId, null);
  const duplicate = [row("a", ["invoice", "invoice"]), row("b", ["invoice"])]; assert.equal(nominateAgentOwner(input("invoice"), duplicate).reason, "ambiguous");
  assert.equal(nominateAgentOwner(input("concatenate"), [row("a", ["cat"])]).reason, "no_match");
  assert.equal(nominateAgentOwner(input("invoice"), directory.map(r => ({ ...r, automatic: false }))).ownerAgentId, null);
});

test("C6 structured human selection needs one lead, never derives authority from quoted @ text", () => {
  assert.equal(nominateAgentOwner(input("hello @finance"), directory).ownerAgentId, null);
  assert.equal(nominateAgentOwner(input("hello", { explicitAgentIds: ["finance", "engineer"] }), directory).reason, "ambiguous");
  const lead = nominateAgentOwner(input("hello", { explicitAgentIds: ["finance", "engineer"], leadAgentId: "engineer" }), directory); assert.equal(lead.ownerAgentId, "engineer"); assert.equal(lead.method, "explicit_human");
  assert.equal(nominateAgentOwner(input("hello", { explicitAgentIds: ["finance"], leadAgentId: "outsider" }), directory).reason, "scope_denied");
  assert.equal(nominateAgentOwner(input("publish", { explicitAgentIds: ["finance"] }), directory).reason, "responsibility_rejected");
});

test("C6 human-confirmed business bindings cannot silently fall back or resolve conflicts", () => {
  assert.equal(nominateAgentOwner(input("new work"), directory, ["finance"]).method, "business_mapping");
  assert.equal(nominateAgentOwner(input("invoice"), directory, ["outsider"]).reason, "scope_denied");
  assert.equal(nominateAgentOwner(input("invoice"), directory, ["finance", "engineer"]).reason, "ambiguous");
});

test("C6 request syntax refuses actor/provenance overrides and accessor-backed recipient lists", () => {
  const raw = input("invoice"); assert.throws(() => parseAgentRoutingInput({ ...raw, provenance: { channel: "local_human" } }));
  let reads = 0; const bad = { ...raw }; Object.defineProperty(bad, "explicitAgentIds", { enumerable: true, get() { reads++; return []; } });
  assert.throws(() => parseAgentRoutingInput(bad)); assert.equal(reads, 0);
});

test("C6 routing directory exports only confirmed C0 public duty; a G3 draft activates only through C3", t => {
  const f = lifecycleFixture(t), authority = new WorkspaceAgentBoundaryAuthority({ ...f.authorityOptions, routingControl: true }); t.after(() => authority.close());
  authority.initializeAgentRouting(f.transport, f.agent.agentId); const before = authority.routingDirectory(f.transport, [f.agent.agentId], [f.agent.agentId]);
  const draft = createAgentDutyDraft({ title: "Finance", description: "Review approved books", owns: ["invoice"], rejects: ["publish"] });
  assert.deepEqual(authority.routingDirectory(f.transport, [f.agent.agentId], [f.agent.agentId]), before);
  const current = authority.view(f.transport, f.agent.agentId), duty = agentDutyDraftProposal(draft, current.context, f.agent.agentId, current.policy.duty.dutyRevision + 1);
  const proposal = { duty, boundary: current.policy.boundary, rights: current.policy.rights }, control = new WorkspaceAgentCommandControl(authority);
  const command = authority.draft(f.transport, f.agent.agentId, { commandId: randomUUID(), rootRequestId: randomUUID(), lifetimeMs: 1000,
    operation: { action: "duty.update", proposedDutyDigest: agentPolicyProposalDigest(proposal) } });
  const begun = control.begin(f.transport, command, { proposal }); assert.ok(begun.intake); assert.equal(control.accept(begun.intake).status, "applied");
  const after = authority.routingDirectory(f.transport, [f.agent.agentId], [f.agent.agentId]); assert.deepEqual(after[0].publicProfile, draft.publicProfile);
  assert.equal(after[0].dutyRevision, 2); assert.equal(after[0].automatic, true); assert.ok(!JSON.stringify(after).includes("instructions"));
  assert.deepEqual(authority.view(f.transport, f.agent.agentId).policy.boundary, current.policy.boundary);
});
