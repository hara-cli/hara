import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentFollowupStore, processAgentFollowupDelivery } from "../dist/gateway/agent-followup.js";
import { createAgentFollowupTool } from "../dist/serve/agent-followup.js";
import { ControlLeaseRegistry } from "../dist/serve/control-lease.js";

const scope = "feishu-fixture", root = "om_root";
const source = (time, overrides = {}) => ({ chatId: "oc_group", userId: "ou_owner", userName: "Owner", messageId: root,
  text: "private body must not be retained before approval", createdAtMs: time, senderType: "user", chatType: "group",
  mentions: [{ isSelf: true }], ...overrides });
const reply = (time, overrides = {}) => source(time, { messageId: `om_follow_${time}`, text: "Please check this task",
  replyContext: { valid: true, rootMessageId: root, parentMessageId: root }, ...overrides });
function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "hara-followup-test-")), now = Date.now(), store = new AgentFollowupStore(home);
  t.after(() => rmSync(home, { force: true, recursive: true }));
  const target = { sessionId: "fixture-child", parentSessionId: "fixture-parent", agentRef: "global:colleague", profileId: "personal",
    spaceId: "personal", cwd: home };
  const grant = (time = now) => { store.observe(scope, source(time), true, time); return store.grant(store.candidates(time)[0].id, target, 10, 4, time); };
  return { home, now, store, target, grant, path: join(home, ".hara", "gateway", "agent-followups.json") };
}

test("observed candidates are bounded metadata, not a saved group-message body or human authority", (t) => {
  const f = fixture(t);
  for (const override of [{ senderType: "app" }, { senderType: "unknown" }, { chatType: "p2p" },
    { replyContext: { valid: false } }, { createdAtMs: f.now - 3_600_001 }, { mentions: [] }]) {
    f.store.observe(scope, source(f.now, override), true, f.now);
  }
  f.store.observe(scope, source(f.now), false, f.now);
  assert.deepEqual(f.store.candidates(f.now), []);
  f.grant();
  assert.equal(readFileSync(f.path, "utf8").includes("private body must"), false);
  f.store.observe(scope, source(f.now + 1, { messageId: "om_identity", userName: "ou_owner" }), true, f.now + 1);
  assert.equal(JSON.stringify(f.store.candidates(f.now + 1)).includes("ou_owner"), false);
  if (process.platform !== "win32") assert.equal(statSync(f.path).mode & 0o777, 0o600);
});

test("exact account, group, authenticated sender and reply ancestry route to a named Agent only", (t) => {
  const f = fixture(t), g = f.grant();
  for (const override of [{ senderType: "app" }, { senderType: "unknown" }, { userId: "ou_other" }, { chatId: "oc_other" },
    { replyContext: undefined }, { replyContext: { valid: false, rootMessageId: root } },
    { replyContext: { valid: true, rootMessageId: "om_elsewhere" } }]) {
    assert.equal(f.store.admit(scope, reply(f.now + 1, override), true, f.now + 1), "none");
  }
  assert.equal(f.store.admit("feishu-other-account", reply(f.now + 1), true, f.now + 1), "none");
  assert.equal(f.store.admit(scope, reply(f.now + 1), false, f.now + 1), "none");
  assert.equal(f.store.admit(scope, reply(f.now + 1), true, f.now + 1), "queued");
  assert.equal(f.store.get(g.id).agentRef, "global:colleague");
  assert.equal(f.store.admit(scope, reply(f.now + 1), true, f.now + 2), "duplicate");
  assert.equal(f.store.admit(scope, reply(f.now + 2), true, f.now + 2), "blocked");
  const e = f.store.claim(g.id, f.now + 2); assert.equal(e.text, "Please check this task");
  assert.equal(f.store.claim(g.id, f.now + 3), undefined);
  assert.equal(new AgentFollowupStore(f.home).claim(g.id, f.now + 50_000), undefined);
  assert.equal(f.store.admit(scope, reply(f.now + 50_000), true, f.now + 50_000), "blocked");
});

test("contradictory ancestry is ambiguous, never routed by a name or the most active session", (t) => {
  const f = fixture(t); f.grant();
  assert.equal(f.store.admit(scope, reply(f.now + 1, { replyContext: { valid: true, parentMessageId: root, rootMessageId: "om_other" } }), true, f.now + 1), "ambiguous");
  assert.throws(() => f.store.grant(f.store.candidates(f.now)[0].id, f.target, 10, 4, f.now + 1), /already has an owner/);
});

test("thread follow-ups cannot silently ingest attachments instead of visible text", (t) => {
  const f = fixture(t); f.grant();
  for (const override of [{ images: ["fixture.png"] }, { transientFiles: ["fixture.txt"] }, { text: "[图片]" }, { text: "[附件]" }]) {
    assert.equal(f.store.admit(scope, reply(f.now + 1, override), true, f.now + 1), "blocked");
  }
  assert.equal(f.store.admit(scope, reply(f.now + 1), true, f.now + 1), "queued");
});

test("new grants do not replay history; limits, expiry and revoked owners fence future messages", (t) => {
  const f = fixture(t), g = f.grant();
  assert.equal(f.store.admit(scope, reply(f.now - 1), true, f.now + 1), "blocked");
  assert.throws(() => f.store.stop(g.id, "another-parent", "revoked"), /not owned/);
  f.store.stop(g.id, f.target.parentSessionId, "revoked");
  assert.equal(f.store.admit(scope, reply(f.now + 1), true, f.now + 1), "blocked");
  const replacement = f.store.grant(f.store.candidates(f.now)[0].id, f.target, 1, 1, f.now + 2);
  assert.equal(f.store.admit(scope, reply(f.now + 3), true, f.now + 3), "queued");
  const e = f.store.claim(replacement.id, f.now + 3); f.store.finish(e.id, { reply: "done", outcome: "completed" }, f.now + 3);
  assert.equal(f.store.admit(scope, reply(f.now + 40_000), true, f.now + 40_000), "blocked");
  assert.equal(f.store.admit(scope, reply(f.now + 80_000), true, f.now + 80_000), "blocked");
  assert.throws(() => f.store.grant(f.store.candidates(f.now)[0].id, { ...f.target, spaceId: "company" }, 10, 4), /invalid/);
});

test("restart recovers completed delivery once, without re-executing or leaking message bodies in receipts", async (t) => {
  const f = fixture(t), g = f.grant(), sent = [], signal = new AbortController().signal;
  f.store.admit(scope, reply(f.now + 1), true, f.now + 1);
  const e = f.store.claim(g.id); f.store.finish(e.id, { reply: "Verified local result", outcome: "completed", taskId: "task-1", turnId: "turn-1" });
  const restored = new AgentFollowupStore(f.home);
  assert.equal(restored.claim(g.id), undefined);
  const adapter = { name: "feishu", reply: async (...args) => sent.push(args) };
  assert.equal(await processAgentFollowupDelivery(adapter, scope, signal, restored), true);
  assert.equal(await processAgentFollowupDelivery(adapter, scope, signal, restored), false);
  assert.equal(sent[0][0], "oc_group"); assert.equal(sent[0][1], e.messageId);
  assert.match(sent[0][2], /global:colleague.*本次处理结束/s);
  assert.equal(sent[0][4], `agent-followup:${e.id}`);
  const receipts = restored.receipts(f.target.parentSessionId); assert.equal(receipts[0].status, "delivered");
  assert.equal(JSON.stringify(receipts).includes("Please check"), false);
  assert.equal(JSON.stringify(receipts).includes("Verified local result"), false);
  assert.equal(JSON.stringify(receipts).includes("ou_owner"), false);
});

test("unknown delivery is quarantined across restart and never falls back to a new group send", async (t) => {
  const f = fixture(t), g = f.grant(), signal = new AbortController().signal; let attempts = 0;
  f.store.admit(scope, reply(f.now + 1), true, f.now + 1); const e = f.store.claim(g.id);
  f.store.finish(e.id, { reply: "result", outcome: "completed" });
  const adapter = { name: "feishu", reply: async () => { attempts++; throw Error("outcome unknown"); }, send: async () => assert.fail("no group-level fallback") };
  await processAgentFollowupDelivery(adapter, scope, signal, f.store);
  await processAgentFollowupDelivery(adapter, scope, signal, new AgentFollowupStore(f.home));
  assert.equal(attempts, 1); assert.equal(f.store.receipts(f.target.parentSessionId)[0].status, "delivery_unknown");
  assert.equal(f.store.get(g.id).status, "paused");
});

test("paused task closes its original thread once; revocation suppresses unsent private output", async (t) => {
  const f = fixture(t), g = f.grant(); f.store.admit(scope, reply(f.now + 1), true, f.now + 1);
  const e = f.store.claim(g.id); f.store.finish(e.id, { reply: "Needs a local decision", outcome: "paused" });
  f.store.stop(g.id, f.target.parentSessionId, "paused");
  assert.equal(f.store.get(g.id).status, "paused");
  assert.equal(f.store.nextDelivery(scope).event.id, e.id);
  f.store.delivered(e.id, true);
  f.store.stop(g.id, f.target.parentSessionId, "revoked");
  assert.equal(f.store.admit(scope, reply(f.now + 40_000), true, f.now + 40_000), "blocked");
  const second = f.store.grant(f.store.candidates(f.now)[0].id, f.target, 10, 4, f.now + 2);
  f.store.admit(scope, reply(f.now + 3), true, f.now + 3); const e2 = f.store.claim(second.id, f.now + 3);
  f.store.finish(e2.id, { reply: "Private result", outcome: "completed" }); f.store.stop(second.id, f.target.parentSessionId, "revoked");
  assert.equal(f.store.nextDelivery(scope), undefined);
});

test("corrupt or linked private state fails closed instead of replacing receipts", (t) => {
  const f = fixture(t); f.grant(); const original = readFileSync(f.path, "utf8");
  writeFileSync(f.path, "malformed", { mode: 0o600 });
  assert.throws(() => f.store.candidates()); assert.equal(readFileSync(f.path, "utf8"), "malformed");
  rmSync(f.path); const other = join(f.home, "outside.json"); writeFileSync(other, original);
  symlinkSync(other, f.path); assert.throws(() => f.store.candidates()); assert.equal(readFileSync(other, "utf8"), original);
});

test("removing a sender's authorization suppresses queued work and its unsent result", (t) => {
  const f = fixture(t), g = f.grant(); f.store.admit(scope, reply(f.now + 1), true, f.now + 1);
  f.store.revalidate("another-account", () => false); assert.equal(f.store.get(g.id).status, "active");
  f.store.revalidate(scope, () => false); assert.equal(f.store.get(g.id).status, "paused");
  assert.equal(f.store.claim(g.id), undefined); assert.deepEqual(f.store.candidates(), []);
  assert.equal(f.store.receipts(f.target.parentSessionId)[0].status, "suppressed");
});

test("sender revocation also suppresses an already-paused task's unsent closure", (t) => {
  const f = fixture(t), g = f.grant(); f.store.admit(scope, reply(f.now + 1), true, f.now + 1);
  const e = f.store.claim(g.id); f.store.finish(e.id, { reply: "Private paused result", outcome: "paused" });
  f.store.revalidate(scope, () => false);
  assert.equal(f.store.nextDelivery(scope), undefined);
  assert.equal(f.store.receipts(f.target.parentSessionId)[0].status, "suppressed");
  assert.equal(readFileSync(f.path, "utf8").includes("Private paused result"), false);
});

test("missing or non-string restored scope is rejected, never regex-coerced into an identity", (t) => {
  const f = fixture(t); f.grant(); const state = JSON.parse(readFileSync(f.path, "utf8"));
  delete state.grants[0].origin.scope; writeFileSync(f.path, JSON.stringify(state));
  assert.throws(() => f.store.list(f.target.parentSessionId), /invalid/);
});

test("follow-up tool never accepts model-authored account/session/permission authority", async (t) => {
  const f = fixture(t); f.store.observe(scope, source(f.now), true, f.now); let activated = 0;
  const tool = createAgentFollowupTool({ store: f.store, parentSessionId: f.target.parentSessionId, agentRef: f.target.agentRef,
    assertCurrent() {}, grant: (id, minutes, max) => { activated++; return f.store.grant(id, f.target, minutes, max); }, stop: (id) => f.store.stop(id, f.target.parentSessionId, "revoked") });
  const input = { action: "grant", candidateId: f.store.candidates()[0].id, minutes: 5, maxMessages: 2 };
  assert.equal(tool.classify(input).requiresExplicitApproval, true);
  for (const key of ["sessionId", "senderId", "spaceId", "autoApprove", "nativeSessionId"]) {
    await assert.rejects(tool.run({ ...input, [key]: "forged" }, {}), /invalid/);
  }
  await assert.rejects(tool.run(input, { signal: AbortSignal.abort() }), /cancelled/); assert.equal(activated, 0);
  const receipt = JSON.parse(await tool.run(input, {})); assert.equal(receipt.ownerAgentRef, f.target.agentRef); assert.equal(activated, 1);
  assert.equal(JSON.parse(await tool.run({ action: "status" }, {})).grants[0].status, "requires_confirmation",
    "persisted active state cannot claim execution is live after a restart");
  assert.match(tool.classify(input).approvalTarget, new RegExp(root));
});

test("capturing a control lease neither creates one nor takes another socket's authority", () => {
  const leases = new ControlLeaseRegistry(), owner = {}, observer = {};
  assert.equal(leases.captureOwned("root", owner), undefined);
  assert.equal(leases.authorize("root", observer), "legacy");
  const first = leases.acquire("root", owner).lease; assert.deepEqual(leases.captureOwned("root", owner), first);
  assert.throws(() => leases.captureOwned("root", observer), /another device/);
  leases.acquire("root", observer, true); assert.throws(() => leases.authorize("root", owner, first), /changed/);
});
