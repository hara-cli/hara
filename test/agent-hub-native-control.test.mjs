import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeHubAuth } from "../dist/agent-hub/native-control-auth.js";
import {
  NATIVE_HUB_LIMITS, NativeHubError, nativeAttachProof, nativeSha256,
} from "../dist/agent-hub/native-control-contract.js";
import { NativeControlJournal } from "../dist/agent-hub/native-control-journal.js";
import { NativeHubControl } from "../dist/agent-hub/native-control.js";

const hex = char => char.repeat(64);
const ownerCredential = hex("b"), workspaceToken = hex("a");
const agentId = "ext_codex_" + "d".repeat(24), instanceId = randomUUID(), launchRef = randomUUID();
const grantTarget = { kind: "grant", agentId, instanceId };
const launchTarget = { kind: "launch", engine: "codex", resourceId: "resource_demo", label: "Explicit builder" };
const cleanupTarget = { kind: "cleanup", targetBytes: 256 };
const reject = code => error => error instanceof NativeHubError && error.code === code;
const ref = ({ intent, intentDigest }) => ({ operationId: intent.operationId, intentDigest });
const approval = prepared => ({ ...ref(prepared), challenge: prepared.challenge });

function authFixture(monotonicNow, host = { installId: randomUUID(), hostInstanceId: randomUUID(), port: 19436 }) {
  const auth = new NativeHubAuth({ ...host, ownerCredential, workspaceToken, monotonicNow });
  function prove(hello, serverNonce, direction = "attach.client", owner = ownerCredential, workspace = workspaceToken) {
    return nativeAttachProof(owner, direction, hello, serverNonce, nativeSha256(workspace));
  }
  function attach() {
    const hello = { ...host, clientNonce: nativeSha256(randomUUID()) };
    const proof = auth.hello(workspaceToken, hello);
    assert.equal(proof.serverProof, prove(hello, proof.serverNonce, "attach.server"));
    const { sessionToken } = auth.finish(workspaceToken, { ...hello, serverNonce: proof.serverNonce,
      clientProof: prove(hello, proof.serverNonce) });
    return { session: auth.authenticate(workspaceToken, sessionToken), sessionToken, hello, proof };
  }
  return { auth, host, attach, prove };
}

function fixture(t) {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "hara-native-control-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  let now = 0;
  const scenario = { clock: () => now, advance: ms => { now += ms; }, failAt: null, denyGrowth: false,
    preflight: async () => {}, calls: [], charges: [], publishCount: 0, catalog: null, handoff: null,
    minted: [], cleanupPlan: randomUUID(), selectionDigest: hex("c"), admissionEpoch: 0, viewEpoch: 1,
    maintenance: false, launchRejected: false };
  const binding = { schemaVersion: 1, scopeKey: hex("d"), generation: randomUUID() };
  const workspaceId = "ws_" + randomUUID();
  const journalFile = join(home, ".hara", "agent-hub-native", binding.scopeKey, binding.generation, "operations.json");
  const policy = {
    transaction: (_lane, action) => action(),
    admit(lane, previous, next) {
      scenario.charges.push({ lane, previous, next });
      if (lane === "reserved-revoke") assert.equal(previous, next);
      else if (scenario.denyGrowth) throw new NativeHubError("quota_exceeded");
    },
    publish(_previous, _next, write) {
      if (scenario.failAt === "no-write") return;
      write();
      scenario.publishCount++;
      if (scenario.failAt === "claim" && scenario.publishCount === 1
        || scenario.failAt === "ack" && scenario.publishCount === 4)
        throw new Error("synthetic interruption after publication");
    },
  };
  function interrupted(step) {
    if (scenario.failAt === step) throw new Error("synthetic interruption: secret paths must not leave the adapter");
  }
  function open(activeBinding = binding) {
    const { host, auth, attach } = authFixture(scenario.clock), { session, sessionToken } = attach();
    const journal = new NativeControlJournal(home, activeBinding, policy);
    const current = () => ({ workspaceId, journal, viewEpoch: scenario.viewEpoch, admissionEpoch: scenario.admissionEpoch,
      maintenance: scenario.maintenance });
    const ports = {
      current,
      preflight: (...args) => scenario.preflight(...args),
      facts(_view, target) {
        const connected = ["grant", "rotate", "revoke"].includes(target.kind);
        const { catalog, selectionDigest } = scenario;
        return { registryRevision: 3, grantEpoch: target.kind === "rotate" || target.kind === "revoke" ? catalog.epoch : null,
          catalogDigest: catalog ? nativeSha256(JSON.stringify(catalog)) : hex("e"), selectionDigest, policyDigest: hex("f"),
          subject: connected ? { agentId, instanceId } : null,
          launch: connected ? { launchRef, handoffLocationDigest: hex("1"), materialRootIdentityDigest: hex("2") } : null,
          cleanup: target.kind === "cleanup" ? { planId: scenario.cleanupPlan, planDigest: hex("5") } : null,
          summary: { label: "Synthetic session", details: ["Current workspace"], count: 1, bytes: 32 } };
      },
      assertEffectCurrent(_view, intent) {
        if (scenario.selectionDigest !== intent.facts.selectionDigest) throw new NativeHubError("stale_intent");
      },
      stageGrant(_intent, entry, token, fence) {
        fence(); assert.equal(entry.phase, "staged"); assert.equal(entry.tokenDigest, nativeSha256(token));
        scenario.calls.push("stage"); scenario.minted.push(token); interrupted("stage");
      },
      publishGrant(_intent, entry, fence) {
        fence(); scenario.calls.push("catalog");
        scenario.catalog = { id: entry.connectionId, epoch: entry.grantEpoch, digest: entry.tokenDigest, revoked: false };
        interrupted("catalog"); return nativeSha256(JSON.stringify(scenario.catalog));
      },
      publishHandoff(_intent, entry, fence) {
        fence(); assert.equal(entry.phase, "catalog_committed"); scenario.calls.push("handoff");
        scenario.handoff = scenario.minted.at(-1); interrupted("handoff"); return nativeSha256("verified fixture handoff");
      },
      invalidateGrant(_intent, entry, fence) {
        fence(); scenario.calls.push("invalidate"); assert.equal(entry.connectionId, scenario.catalog.id);
        scenario.catalog.revoked = true;
        return nativeSha256(JSON.stringify(scenario.catalog));
      },
      removeHandoff(_intent, entry, fence) {
        fence(); scenario.calls.push("remove"); assert.equal(scenario.catalog.revoked, true);
        assert.ok(entry.phase === "revoked" || entry.phase === "previous_revoked");
        interrupted("remove"); scenario.handoff = null; return "removed";
      },
      applyOther(intent, _entry, fence) {
        fence(); scenario.calls.push(intent.target.kind); interrupted("launch");
        if (scenario.launchRejected) return { rejected: "busy" };
        return intent.target.kind === "launch" ? { effect: { kind: "launch", agentId, instanceId } }
          : { effect: { kind: "cleanup", planId: scenario.cleanupPlan, complete: "complete", removedBytes: 32 } };
      },
    };
    const control = new NativeHubControl(auth, ports, scenario.clock);
    return { auth, host, attach, session, sessionToken, journal, control, ports, current, workspaceId,
      prepare: (target, handle = session) => control.prepare(handle, { workspaceId, viewEpoch: scenario.viewEpoch, target }),
      confirm: (prepared, handle = session) => control.confirm(handle, approval(prepared)),
      status: (prepared, handle = session) => control.status(handle, ref(prepared)),
    };
  }
  return { home, binding, journalFile, scenario, open };
}

test("Native attachment requires two credentials and binds both proofs to the current install, Host, port and nonces", () => {
  let now = 0;
  const { auth, host, attach, prove } = authFixture(() => now);
  assert.throws(() => new NativeHubAuth({ ...host, workspaceToken, ownerCredential: workspaceToken }), reject("unauthorized"));
  const { session, sessionToken } = attach();
  const hello = { ...host, clientNonce: hex("1") };
  assert.throws(() => auth.hello(ownerCredential, hello), reject("unauthorized"));
  for (const other of [{ port: 19437 }, { installId: randomUUID() }, { hostInstanceId: randomUUID() }])
    assert.throws(() => auth.hello(workspaceToken, { ...hello, ...other }), reject("unauthorized"));
  for (const change of [
    (hello, proof) => ({ clientProof: proof.serverProof }),
    (hello, proof) => ({ clientProof: prove(hello, proof.serverNonce, "attach.client", workspaceToken) }),
    (hello, proof) => ({ clientProof: prove(hello, proof.serverNonce, "attach.client", ownerCredential, hex("0")) }),
    () => ({ clientNonce: hex("3") }),
  ]) {
    const proof = auth.hello(workspaceToken, hello);
    const finish = { ...hello, serverNonce: proof.serverNonce, clientProof: prove(hello, proof.serverNonce) };
    assert.throws(() => auth.finish(workspaceToken, { ...finish, ...change(hello, proof) }), reject("unauthorized"));
    assert.throws(() => auth.finish(workspaceToken, finish), reject("unauthorized"));
  }
  const aged = auth.hello(workspaceToken, hello);
  now = 30_000;
  assert.throws(() => auth.finish(workspaceToken, { ...hello, serverNonce: aged.serverNonce,
    clientProof: prove(hello, aged.serverNonce) }), reject("unauthorized"));
  assert.equal(auth.authenticate(workspaceToken, sessionToken), session);
  assert.throws(() => auth.assertCurrent(JSON.parse(JSON.stringify(session))), reject("unauthorized"));
  const next = attach();
  assert.throws(() => auth.authenticate(workspaceToken, sessionToken), reject("unauthorized"));
  assert.throws(() => auth.authenticate(workspaceToken, workspaceToken), reject("unauthorized"));
  auth.detach(next.session);
  assert.throws(() => auth.authenticate(workspaceToken, next.sessionToken), reject("unauthorized"));
  auth.close();
  assert.throws(() => auth.hello(workspaceToken, hello), reject("unauthorized"));
});

test("the 30s Native challenge starts after prepare, remains single-use and expires exactly at 30000ms", async t => {
  const { open, scenario } = fixture(t), f = open();
  scenario.preflight = async () => scenario.advance(60_000);
  const first = await f.prepare(launchTarget);
  scenario.preflight = async () => {};
  scenario.advance(29_999);
  assert.equal(await f.prepare(launchTarget), first);
  assert.equal(f.status(first).status, "pending");
  assert.equal((await f.confirm(first)).status, "applied");
  const second = await f.prepare(cleanupTarget);
  scenario.advance(30_000);
  await assert.rejects(f.confirm(second), reject("stale_intent"));
  assert.deepEqual(scenario.calls, ["launch"]);
  const third = await f.prepare(cleanupTarget);
  await assert.rejects(f.control.confirm(f.session, { ...approval(third), approved: true }), reject("invalid_request"));
  await assert.rejects(f.control.confirm(f.session, { ...approval(third), challenge: hex("0") }), reject("unauthorized"));
  assert.equal(f.control.cancel(f.session, ref(third)).status, "rejected");
  await assert.rejects(f.confirm(third), reject("stale_intent"));
});

test("scope/generation, view, maintenance and prepared witnesses are checked again after awaits", async t => {
  const { open, scenario, binding } = fixture(t), f = open();
  assert.throws(() => f.control.authorizeView(f.session, { workspaceId: "ws_" + randomUUID(), viewEpoch: 1 }), reject("scope_changed"));
  const first = await f.prepare(launchTarget);
  scenario.preflight = async () => { scenario.viewEpoch++; };
  await assert.rejects(f.confirm(first), reject("scope_changed"));
  scenario.preflight = async () => {};
  const admitted = await f.prepare(launchTarget);
  scenario.maintenance = true;
  await assert.rejects(f.confirm(admitted), reject("busy"));
  scenario.maintenance = false;
  scenario.admissionEpoch++;
  await assert.rejects(f.confirm(admitted), reject("scope_changed"));
  const changed = await f.prepare(launchTarget);
  scenario.selectionDigest = hex("9");
  await assert.rejects(f.confirm(changed), reject("stale_intent"));
  const original = f.ports.current;
  const newGeneration = open({ ...binding, generation: randomUUID() });
  const prepared = await f.prepare(cleanupTarget);
  f.ports.current = () => ({ ...original(), journal: newGeneration.journal });
  await assert.rejects(f.confirm(prepared), reject("scope_changed"));
  f.ports.current = original;
  const fresh = await f.prepare(launchTarget);
  const reattached = f.attach();
  await assert.rejects(f.confirm(fresh), reject("unauthorized"));
  await assert.rejects(f.confirm(fresh, reattached.session), reject("stale_intent"));
  assert.deepEqual(scenario.calls, []);
});

test("time and Native cancellation can change while pre-claim quota calibration is outstanding", async t => {
  const { open, scenario } = fixture(t), f = open();
  const prepared = await f.prepare(launchTarget);
  let finish;
  scenario.preflight = () => new Promise(resolve => { finish = resolve; });
  const confirming = f.confirm(prepared);
  assert.equal(f.control.cancel(f.session, ref(prepared)).status, "rejected");
  finish();
  await assert.rejects(confirming, reject("stale_intent"));
  scenario.preflight = async () => {};
  const almost = await f.prepare(launchTarget);
  scenario.advance(29_999);
  scenario.preflight = async () => { scenario.advance(1); };
  await assert.rejects(f.confirm(almost), reject("stale_intent"));
  assert.deepEqual(scenario.calls, []);
});

test("a durable claim allows a single launch, including simultaneous confirms and later Native reattach", async t => {
  const { open, scenario } = fixture(t), f = open();
  let finish;
  const original = f.ports.applyOther;
  f.ports.applyOther = async (...args) => {
    await new Promise(resolve => { finish = resolve; });
    return original(...args);
  };
  const prepared = await f.prepare(launchTarget);
  const confirming = f.confirm(prepared);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.status(prepared).status, "pending");
  assert.equal((await f.confirm(prepared)).status, "pending");
  finish();
  const applied = await confirming;
  assert.equal(applied.status, "applied");
  assert.deepEqual((await f.confirm(prepared)), applied);
  assert.deepEqual(open().status(prepared), applied);
  assert.deepEqual(scenario.calls, ["launch"]);
  assert.throws(() => f.control.status(f.session, { ...ref(prepared), intentDigest: hex("0") }), reject("conflict"));
});

test("grant recovery keeps the single claim and its unknown or applied status across every publication boundary", async t => {
  const cases = [
    ["claim", "claimed", []], ["stage", "staged", ["stage"]],
    ["catalog", "staged", ["stage", "catalog"]], ["handoff", "catalog_committed", ["stage", "catalog", "handoff"]],
    ["ack", "handoff_committed", ["stage", "catalog", "handoff"]],
  ];
  for (const [fault, phase, calls] of cases) await t.test(fault, async t => {
    const { open, scenario, journalFile, binding } = fixture(t), f = open();
    scenario.failAt = fault;
    const prepared = await f.prepare(grantTarget);
    const receipt = await f.confirm(prepared);
    const restarted = open(), status = restarted.status(prepared);
    assert.notEqual(restarted.host.hostInstanceId, f.host.hostInstanceId);
    assert.equal(status.status, fault === "ack" ? "applied" : "unknown");
    assert.equal(restarted.journal.get(ref(prepared)).phase, phase);
    assert.deepEqual(receipt, status);
    assert.deepEqual(await restarted.confirm(prepared), status);
    assert.deepEqual(scenario.calls, calls);
    assert.equal(scenario.minted.length, fault === "claim" ? 0 : 1);
    const raw = readFileSync(journalFile, "utf8");
    for (const secret of [ownerCredential, workspaceToken, f.sessionToken, prepared.challenge, ...scenario.minted])
      assert.equal(raw.includes(secret), false);
    assert.equal(open({ ...binding, scopeKey: hex("4") }).status(prepared).status, "unknown");
    assert.equal(open({ ...binding, generation: randomUUID() }).status(prepared).status, "unknown");
  });
});

test("no launch can start when the claimed journal publication cannot be read back", async t => {
  const { open, scenario } = fixture(t), f = open();
  const prepared = await f.prepare(launchTarget);
  scenario.failAt = "no-write";
  await assert.rejects(f.confirm(prepared), reject("store_unavailable"));
  assert.deepEqual(scenario.calls, []);
  assert.equal(open().status(prepared).status, "unknown");
});

test("the unfinished-operation limit holds all earlier unknown claims and refuses a new effect", async t => {
  const { open, scenario } = fixture(t), f = open();
  scenario.failAt = "launch";
  const claims = [];
  for (let index = 0; index < NATIVE_HUB_LIMITS.pending; index++) {
    const prepared = await f.prepare({ ...launchTarget, resourceId: "fixture_" + index });
    assert.equal((await f.confirm(prepared)).status, "unknown");
    claims.push(prepared);
  }
  const extra = await f.prepare(launchTarget);
  await assert.rejects(f.confirm(extra), reject("busy"));
  const reopened = open();
  assert.ok(claims.every(prepared => reopened.status(prepared).status === "unknown"));
  assert.equal(scenario.calls.length, NATIVE_HUB_LIMITS.pending);
});

test("a started Agent that cannot be verified is never automatically relaunched", async t => {
  const { open, scenario } = fixture(t), f = open();
  const prepared = await f.prepare(launchTarget);
  scenario.failAt = "launch";
  assert.equal((await f.confirm(prepared)).status, "unknown");
  const restarted = open();
  assert.equal((await restarted.confirm(prepared)).status, "unknown");
  assert.deepEqual(scenario.calls, ["launch"]);
  // Fixture models an exact R1 admission rejection with a known and safe outcome.
  const other = await restarted.prepare(launchTarget);
  scenario.failAt = null;
  scenario.launchRejected = true;
  assert.equal((await restarted.confirm(other)).error, "busy");
  assert.equal(restarted.status(other).status, "rejected");
});

test("revocation uses its paid slot at full ordinary capacity and remains queryable under quota denial", async t => {
  const { open, scenario, journalFile } = fixture(t), f = open();
  const grant = await f.confirm(await f.prepare(grantTarget));
  const launch = await f.confirm(await f.prepare(launchTarget));
  assert.equal(launch.status, "applied");
  const state = JSON.parse(readFileSync(journalFile, "utf8"));
  const filler = state.entries.find(row => row.kind === "launch");
  for (let index = state.entries.length; index < NATIVE_HUB_LIMITS.terminal; index++) {
    const operationId = randomUUID();
    state.entries.push({ ...filler, operationId, outcome: { ...filler.outcome, operationId } });
  }
  // Deliberately fill the real journal to its cap using synthetic terminal rows.
  const slot = JSON.stringify(state.revocations[0]).padEnd(1024, " ");
  writeFileSync(journalFile, JSON.stringify(state).replace(JSON.stringify(state.revocations), "[" + slot + "]"));
  const extra = await f.prepare(cleanupTarget);
  await assert.rejects(f.confirm(extra), reject("busy"));
  scenario.denyGrowth = true;
  const size = statSync(journalFile).size;
  const revoked = await f.prepare({ kind: "revoke", connectionId: grant.effect.connectionId });
  assert.equal((await f.confirm(revoked)).effect.handoff, "removed");
  assert.equal(open().status(revoked).status, "applied");
  assert.equal(scenario.catalog.revoked, true);
  assert.equal(statSync(journalFile).size, size);
  assert.deepEqual(scenario.charges.slice(-3).map(row => row.lane), Array(3).fill("reserved-revoke"));
});

test("a second prepared grant for an already bound launch cannot publish another token", async t => {
  const { open, scenario } = fixture(t), f = open();
  const first = await f.confirm(await f.prepare(grantTarget));
  assert.equal(first.status, "applied");
  const duplicate = await f.prepare(grantTarget);
  await assert.rejects(f.confirm(duplicate), reject("conflict"));
  assert.equal(scenario.minted.length, 1);
  const wrong = await f.prepare({ kind: "revoke", connectionId: randomUUID() });
  await assert.rejects(f.confirm(wrong), reject("stale_intent"));
  assert.equal(scenario.catalog.revoked, false);
});

test("failed rotation cannot re-enable the old grant or replace its token; a removal error after revoke is visible", async t => {
  const { open, scenario } = fixture(t), f = open();
  const result = await f.confirm(await f.prepare(grantTarget));
  const { connectionId } = result.effect, old = scenario.handoff;
  const rotate = await f.prepare({ kind: "rotate", connectionId });
  scenario.failAt = "remove";
  assert.equal((await f.confirm(rotate)).status, "unknown");
  assert.equal(scenario.catalog.revoked, true);
  assert.equal(scenario.handoff, old);
  assert.equal(scenario.minted.length, 1);
  assert.equal((await open().confirm(rotate)).status, "unknown");
  const revoke = await f.prepare({ kind: "revoke", connectionId });
  assert.deepEqual((await f.confirm(revoke)).effect, { kind: "revoke", connectionId, handoff: "unknown" });
  assert.equal(open().status(revoke).effect.handoff, "unknown");
});

test("scope change during a Host effect prevents publication and hides even a stored result from the old view", async t => {
  const { open, scenario } = fixture(t), f = open();
  const prepared = await f.prepare(grantTarget);
  f.ports.stageGrant = async () => { scenario.viewEpoch++; };
  await assert.rejects(f.confirm(prepared), reject("scope_changed"));
  assert.deepEqual(scenario.calls, []);
  assert.equal(open().status(prepared).status, "unknown");
});

test("a retained private replacement claim cannot be mistaken for a new scope journal", async t => {
  const { open, journalFile } = fixture(t), f = open();
  const prepared = await f.prepare(launchTarget);
  const directory = join(journalFile, "..");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const orphan = join(directory, ".hara-claim-synthetic.tmp");
  writeFileSync(orphan, "previous-state-witness", { mode: 0o600 });
  await assert.rejects(f.confirm(prepared), reject("store_unavailable"));
  assert.equal(readFileSync(orphan, "utf8"), "previous-state-witness");
});
