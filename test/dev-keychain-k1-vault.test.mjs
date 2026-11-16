import test from "node:test";
import assert from "node:assert/strict";
import { OP, NO_UI, FixtureError, encodeRequest, decodeReply } from "../native/dev-keychain-fixture/protocol.mjs";
import { FakeSecurity, FakeLocks, FakeDevVault, DEV_SERVICE, fixtureContext, helperEnvironment } from "../native/dev-keychain-fixture/fake-vault.mjs";
const nonce = Buffer.alloc(16, 7), ref = "scope:c1:g1", neighbor = "scope:c2:g1";
const req = (op, entries = [{ ref, key: "" }]) => ({ op, flags: NO_UI, nonce, entries });
const set = entries => req(OP.SET_MANY, entries);
const item = (account, data, service = DEV_SERVICE, id = account) => ({ id, service, account, data });
const group = values => item("vault.scope", JSON.stringify({ schemaVersion: 1, values }));
const isCode = code => error => error instanceof FixtureError && error.code === code;
const writes = backend => backend.calls.filter(c => ["add", "update", "delete"].includes(c.op));
test("fake lifecycle preserves neighbor and never queries the formal service", async () => {
  const formal = item("vault.scope", "synthetic-formal-sentinel", "tech.nanhara.hara.workspace.credentials.v1");
  const s = new FakeSecurity([formal]), v = new FakeDevVault(s);
  assert.equal(await v.execute(req(OP.GET)), undefined);
  await v.execute(set([{ ref, key: "synthetic-a" }, { ref: neighbor, key: "synthetic-b" }]));
  assert.equal(writes(s).length, 1); assert.equal(await v.execute(req(OP.GET)), "synthetic-a");
  await v.execute(req(OP.REMOVE)); assert.equal(await v.execute(req(OP.GET)), undefined);
  assert.equal(await v.execute(req(OP.GET, [{ ref: neighbor, key: "" }])), "synthetic-b");
  assert.deepEqual(s.items.find(i => i.service === formal.service), formal);
  assert.ok(s.calls.filter(c => c.service).every(c => c.service === DEV_SERVICE && c.matchLimit !== "one"));
  assert.ok(s.sessions.every(session => session.interactionAllowed));
  assert.equal(s.interactionAllowed, true);
  assert.equal(JSON.stringify(s.calls).includes("synthetic-a"), false);
});
test("legacy-only get/remove neither creates group nor copies the key", async () => {
  const s = new FakeSecurity([item(ref, "synthetic-legacy")]), v = new FakeDevVault(s);
  assert.equal(await v.execute(req(OP.GET)), "synthetic-legacy"); assert.equal(writes(s).length, 0);
  await v.execute(req(OP.REMOVE)); assert.equal(s.items.length, 0);
  assert.deepEqual(writes(s).map(x => x.op), ["delete"]);
  await v.execute(req(OP.REMOVE)); assert.equal(s.items.length, 0);
});
test("a malformed frame has zero backend operations", async () => {
  const s = new FakeSecurity(), v = new FakeDevVault(s);
  await assert.rejects(v.frame(Buffer.alloc(4)), isCode("invalid_request")); assert.equal(s.calls.length, 0);
});
for (const mutate of [c => { c.env.HOME = "/fixture/user/.hara-dev-home"; }, c => { c.env.CFFIXED_USER_HOME = ""; }, c => { c.env.USERPROFILE = "/fixture/user"; }, c => { c.identity.uid = 0; }, c => { c.identity.euid = 999; }, c => { c.identity.realPwDir = "/alias"; }, c => { c.identity.devDirectory.mode = 0o755; }, c => { c.identity.devDirectory.symlink = true; }, c => { c.identity = undefined; }]) {
  test("unsafe helper context rejects before any fake Keychain operation", async () => {
    const context = fixtureContext(); mutate(context); const s = new FakeSecurity();
    await assert.rejects(new FakeDevVault(s, { context }).execute(req(OP.GET)), isCode("unavailable"));
    assert.equal(s.calls.length, 0);
  });
}
test("real-pw-dir HOME is allowed and parent runtime secrets are not inherited", async () => {
  const context = fixtureContext(); context.env.HOME = context.identity.pwDir;
  const s = new FakeSecurity(); await new FakeDevVault(s, { context }).execute(req(OP.GET));
  assert.deepEqual(helperEnvironment({ HOME: "private", CFFIXED_USER_HOME: "private", API_KEY: "sentinel" }), { LANG: "en_US.UTF-8", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" });
});
test("slice one has no interactive path", async () => {
  const s = new FakeSecurity(); await assert.rejects(new FakeDevVault(s).execute({ ...req(OP.GET), flags: 0 }), isCode("access_denied"));
  assert.equal(s.calls.length, 0);
});
for (const [items, operation] of [[[group({ [ref]: "a" }), { ...group({ [ref]: "b" }), id: "other" }], OP.SET_MANY], [[item(ref, "a"), item(ref, "b", DEV_SERVICE, "other")], OP.GET], [[item("vault.scope", "not-json")], OP.SET_MANY], [[group({ "other:c1:g1": "synthetic" })], OP.SET_MANY]]) {
  test("duplicate or corrupt records reject without changing original items", async () => {
    const s = new FakeSecurity(items), before = structuredClone(s.items);
    await assert.rejects(new FakeDevVault(s).execute(operation === OP.GET ? req(OP.GET) : set([{ ref, key: "synthetic" }])), isCode("credential_unreadable"));
    assert.deepEqual(s.items, before); assert.equal(writes(s).length, 0); assert.ok(s.sessions.every(x => x.interactionAllowed));
  });
}
test("post-write readback failure is uncertain and never replays a write", async () => {
  const s = new FakeSecurity(); s.injectFailure("query", 2, "unavailable");
  await assert.rejects(new FakeDevVault(s).execute(set([{ ref, key: "synthetic" }])), isCode("write_unconfirmed"));
  assert.equal(writes(s).length, 1); assert.equal(s.items.length, 1);
  assert.ok(s.sessions.every(x => x.interactionAllowed));
});
test("partial group/legacy cleanup failure remains explicit", async () => {
  const s = new FakeSecurity([group({ [ref]: "a", [neighbor]: "b" }), item(ref, "legacy")]); s.injectFailure("delete", 1);
  await assert.rejects(new FakeDevVault(s).execute(req(OP.REMOVE)), isCode("cleanup_unconfirmed"));
  assert.ok(s.items.some(i => i.account === ref));
  assert.equal(JSON.parse(s.items.find(i => i.account === "vault.scope").data).values[ref], undefined);
});
for (const [op, nth, code] of [["getUI", 1, "unavailable"], ["setUI", 1, "unavailable"], ["setUI", 2, "unavailable"], ["query", 1, "access_denied"]]) {
  test("UI-state and permission failures stay fixed and do not fall back", async () => {
    const s = new FakeSecurity(); s.injectFailure(op, nth, code);
    await assert.rejects(new FakeDevVault(s).execute(req(OP.GET)), isCode(code));
    assert.equal(writes(s).length, 0); assert.ok(s.calls.filter(c => c.service).every(c => c.service === DEV_SERVICE));
  });
}
test("NO_UI restores a prior disabled state rather than enabling it", async () => {
  const s = new FakeSecurity(); s.interactionAllowed = false; await new FakeDevVault(s).execute(req(OP.GET));
  assert.equal(s.sessions[0].interactionAllowed, false); assert.equal(s.interactionAllowed, false);
});
test("shared per-group lock avoids lost fake updates across independent clients", async () => {
  const s = new FakeSecurity(), locks = new FakeLocks();
  const a = new FakeDevVault(s, { locks }), b = new FakeDevVault(s, { locks });
  await Promise.all([a.execute(set([{ ref, key: "a" }])), b.execute(set([{ ref: neighbor, key: "b" }]))]);
  assert.equal(await a.execute(req(OP.GET)), "a");
  assert.equal(await b.execute(req(OP.GET, [{ ref: neighbor, key: "" }])), "b");
  assert.ok(s.sessions.every(x => x.interactionAllowed));
});
test("group UTF-8 byte bound is checked before a write", async () => {
  const s = new FakeSecurity(), entries = Array.from({ length: 256 }, (_, i) => ({ ref: `scope:c${i}:1`, key: "漢".repeat(16384) }));
  await assert.rejects(new FakeDevVault(s).execute(set(entries)), isCode("invalid_request"));
  assert.equal(writes(s).length, 0);
});
test("encoded errors carry no secret data", async () => {
  const s = new FakeSecurity(); s.injectFailure("query", 1, "access_denied");
  const result = await new FakeDevVault(s).frame(encodeRequest(req(OP.GET)));
  assert.deepEqual(decodeReply(result, nonce, OP.GET), { code: "access_denied" });
});

test("default fake clients share the fixed-path group lock", async () => {
  const s = new FakeSecurity(), a = new FakeDevVault(s), b = new FakeDevVault(s);
  await Promise.all([a.execute(set([{ ref, key: "a" }])), b.execute(set([{ ref: neighbor, key: "b" }]))]);
  assert.equal(await a.execute(req(OP.GET)), "a");
  assert.equal(await b.execute(req(OP.GET, [{ ref: neighbor, key: "" }])), "b");
});
for (const mode of [0, 0o600, 0o750, 0o777]) test("fake context requires exactly a private directory", async () => {
  const context = fixtureContext(); context.identity.devDirectory.mode = mode;
  const s = new FakeSecurity(); await assert.rejects(new FakeDevVault(s, { context }).execute(req(OP.GET)), isCode("unavailable")); assert.equal(s.calls.length, 0);
});
