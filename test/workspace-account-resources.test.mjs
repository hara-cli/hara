import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { AccountWorkspaceResources, WorkspaceAdmissionError } from "../dist/workspace/account-resources.js";
import { WorkspaceResources } from "../dist/workspace/resources.js";
import { WorkspaceResourceStorage, workspaceResourceScopeKey } from "../dist/workspace/resource-context.js";
import { createTaskExecution } from "../dist/session/task.js";

const temporary = [];
after(() => { for (const target of temporary) fs.rmSync(target, { recursive: true, force: true }); });
function dir() { const d = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "hara-account-resources-"))); temporary.push(d); return d; }
const W = "ws_10000000-0000-4000-8000-000000000001", B = "ws_10000000-0000-4000-8000-000000000002";
const R = "20000000-0000-4000-8000-000000000001";
const scope = (workspaceId = W) => ({ schemaVersion: 1, workspaceId, authority: { kind: "account", accountRegion: "CN",
  issuer: "https://account.example.invalid", realmId: R } });
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "synthetic-key-1", alg: "ES256", use: "sig" };
const json = body => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
const denied = code => error => error instanceof WorkspaceAdmissionError && error.code === code;
function fixture(identity = scope(), home = dir()) {
  let time = 2_000_000_000_000;
  let state = { account: { id: "account-a", region: "cn" }, desktop: { id: "desktop-a" },
    accessToken: "synthetic-private-access", accessTokenExpiresAt: time + 600_000 };
  let handler, policy = () => true;
  const requests = [], principals = [];
  function token(overrides = {}, headerOverrides = {}, key = privateKey) {
    const header = Buffer.from(JSON.stringify({ alg: "ES256", typ: "JWT", kid: jwk.kid, ...headerOverrides })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ iss: identity.authority.issuer, aud: "workspace-test-audience", sub: "account-a",
      iat: Math.floor(time / 1000), exp: Math.floor(time / 1000) + 300, jti: randomUUID(), token_use: "workspace_context",
      workspace_context_version: 1, workspace_id: identity.workspaceId, account_id: "account-a", account_region: "CN",
      principal_id: "human-a", realm_id: R, realm_role: "MEMBER", membership_id: "membership-a", membership_version: 1,
      policy_version: 1, ...overrides })).toString("base64url");
    return `${header}.${payload}.${sign("sha256", Buffer.from(`${header}.${payload}`), { key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
  }
  const envelope = (overrides = {}, jwt = token()) => ({ workspaceId: identity.workspaceId, token: jwt,
    tokenType: "Bearer", expiresInSeconds: 300, ...overrides });
  const options = { hostHome: home, scope: identity, contextAudience: "workspace-test-audience", loadState: () => state,
    now: () => time, authorize: (principal, action) => { principals.push({ principal, action }); return policy(principal, action); },
    fetcher: async (url, init) => { requests.push({ url, init }); if (handler) { const result = await handler(url, init); if (result !== undefined) return result; }
      return json(url.endsWith("/context") ? envelope() : { keys: [jwk] }); } };
  const access = new AccountWorkspaceResources(options);
  return { access, home, identity, options, requests, principals, token, envelope,
    getState: () => state, setState: value => { state = value; }, handler: value => { handler = value; },
    policy: value => { policy = value; }, now: () => time, tick: value => { time += value; } };
}
function raw(f) { const r = new WorkspaceResources(f.home, f.identity); r.initialize(); return r; }
function stateFile(f, name) { return join(f.home, ".hara", "workspace-data", "v1", workspaceResourceScopeKey(f.identity), "state", ".hara", name); }
const connection = { id: "same-key", provider: "openai", model: "synthetic-model", apiKey: "synthetic-private-model-key" };

test("fresh pinned Account assertion admits actual stores; tokens/JWKS never choose authority or carry credentials elsewhere", async () => {
  const f = fixture();
  assert.equal(fs.existsSync(join(f.home, ".hara")), false);
  const main = await f.access.run("configure", r => {
    assert.deepEqual(r.agents.list(), { revision: 0, mainAgentId: null, agents: [] });
    assert.equal(r.connections.addDirect(connection).ok, true);
    return r.agents.initializeMain();
  });
  assert.equal(main.runtime.id, "pi");
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[0].url, `${f.identity.authority.issuer}/v1/workspaces/${W}/context`);
  assert.equal(f.requests[0].init.method, "POST"); assert.equal(f.requests[0].init.body, "{}");
  assert.equal(f.requests[0].init.headers.Authorization, "Bearer synthetic-private-access");
  assert.equal(f.requests[1].url, `${f.identity.authority.issuer}/.well-known/jwks.json`);
  assert.equal(f.requests[1].init.headers.Authorization, undefined);
  assert.equal(f.requests.every(r => r.init.redirect === "error" && r.init.cache === "no-store"), true);
  assert.deepEqual(f.principals[0], { principal: { accountId: "account-a", principalId: "human-a", membershipId: "membership-a",
    membershipVersion: 1, policyVersion: 1, role: "MEMBER" }, action: "configure" });
  assert.ok(Object.isFrozen(f.principals[0].principal));
  assert.equal(await f.access.run("read", r => r.agents.get(main.agentId).agentId), main.agentId);
  assert.equal(f.requests.length, 4, "every operation requests current membership and trusted keys anew");
});

test("Account membership never supplies default host permission; policy denial creates no private partition", async () => {
  for (const policy of [() => false, () => undefined, async () => true]) {
    const f = fixture(); f.policy(policy); let called = false;
    await assert.rejects(f.access.run("configure", () => { called = true; }), denied("ACCESS_DENIED"));
    assert.equal(called, false); assert.equal(fs.existsSync(join(f.home, ".hara")), false);
  }
  const f = fixture();
  assert.throws(() => new AccountWorkspaceResources({ ...f.options, authorize: undefined }), /explicit policy/);
  assert.throws(() => new AccountWorkspaceResources({ ...f.options, scope: { ...scope(), authority: { kind: "local", localAuthorityId: R } } }), /pinned Account/);
  for (const testTransportOrigin of ["https://other.example.invalid", "http://example.invalid", "http://127.0.0.1/path", "http://a:b@localhost"]) {
    assert.throws(() => new AccountWorkspaceResources({ ...f.options, testTransportOrigin }));
  }
});

const badClaims = [
  { iss: "https://other.example.invalid" }, { aud: "access" }, { aud: ["workspace-test-audience"] },
  { sub: "account-b" }, { account_id: "account-b" }, { account_region: "GLOBAL" }, { workspace_id: B },
  { realm_id: "20000000-0000-4000-8000-000000000002" }, { token_use: "device" }, { workspace_context_version: 2 },
  { realm_role: "SUPERADMIN" }, { membership_id: undefined }, { principal_id: "human\n-a" },
  { membership_version: 0 }, { policy_version: Number.MAX_SAFE_INTEGER + 1 }, { jti: "short" },
  { iat: 2_000_000_000 - 6 }, { iat: 2_000_000_000 + 6 }, { exp: 2_000_000_000 },
  { exp: 2_000_000_601 }, { organization_id: [] }, { tools: ["shell"] },
];
test("cryptographically signed but foreign/future/old/invalid claims fail before callback or filesystem", async () => {
  for (const claims of badClaims) {
    const f = fixture(); f.handler(url => url.endsWith("/context") ? json(f.envelope({}, f.token(claims))) : undefined);
    await assert.rejects(f.access.run("read", () => assert.fail("must not be called")), denied("INVALID_ASSERTION"));
    assert.equal(fs.existsSync(join(f.home, ".hara")), false);
  }
});

test("signature, algorithm and keys are pinned; attacker-selected jku/jwk/crit and duplicate/private keys are refused", async () => {
  const other = generateKeyPairSync("ec", { namedCurve: "P-256" });
  for (const header of [{ alg: "none" }, { alg: "HS256" }, { kid: "other-key" }, { typ: "at+jwt" },
    { jku: "https://attacker.example.invalid/jwks" }, { jwk }, { crit: ["any"] }]) {
    const f = fixture(); f.handler(url => url.endsWith("/context") ? json(f.envelope({}, f.token({}, header))) : undefined);
    await assert.rejects(f.access.run("read", () => assert.fail()), denied("INVALID_ASSERTION"));
    assert.equal(f.requests.length, 2);
  }
  for (const keys of [[{ ...jwk, d: "private" }], [jwk, jwk], [{ ...jwk, crv: "P-384" }], [],
    [{ ...jwk, x: jwk.x + "=" }], Array.from({ length: 9 }, (_, i) => ({ ...jwk, kid: `key-${i}` }))]) {
    const f = fixture(); f.handler(url => url.endsWith("jwks.json") ? json({ keys }) : undefined);
    await assert.rejects(f.access.run("read", () => assert.fail()), denied("INVALID_ASSERTION"));
  }
  const f = fixture(); f.handler(url => url.endsWith("/context") ? json(f.envelope({}, f.token({}, {}, other.privateKey))) : undefined);
  await assert.rejects(f.access.run("read", () => assert.fail()), denied("INVALID_ASSERTION"));
});

test("malformed envelope and bounded streaming failures cannot initialize storage or reflect upstream secrets", async () => {
  for (const body of [{ workspaceId: B }, { expiresInSeconds: 601 }, { expiresInSeconds: 1 }, { tokenType: "Other" },
    { token: "malformed.synthetic.private" }, { realmId: R }]) {
    const f = fixture(); f.handler(url => url.endsWith("/context") ? json(f.envelope(body)) : undefined);
    await assert.rejects(f.access.run("read", () => assert.fail()), denied("INVALID_ASSERTION"));
    assert.equal(fs.existsSync(join(f.home, ".hara")), false);
  }
  for (const body of ["private-not-json", "x".repeat(65_537)]) {
    const f = fixture(); f.handler(() => new Response(body));
    await assert.rejects(f.access.run("read", () => assert.fail()), error => error.code === "AUTHORITY_UNAVAILABLE" && !error.message.includes("private"));
    assert.equal(fs.existsSync(join(f.home, ".hara")), false);
  }
});

test("live Account denial/unavailable always rechecks and never reuses a previous admission or falls back", async () => {
  const f = fixture(); await f.access.run("configure", r => r.agents.initializeMain());
  for (const [status, code] of [[401, "AUTH_REQUIRED"], [403, "ACCESS_DENIED"], [404, "ACCESS_DENIED"], [409, "ACCESS_DENIED"], [503, "AUTHORITY_UNAVAILABLE"]]) {
    f.handler(() => new Response("secret upstream error", { status }));
    const before = f.requests.length;
    await assert.rejects(f.access.run("configure", () => assert.fail()), denied(code));
    assert.equal(f.requests.length, before + 1, "no automatic request retry or cached-key fallback");
  }
  f.handler(() => { throw new Error("synthetic access token must not be reflected"); });
  await assert.rejects(f.access.run("read", () => assert.fail()), denied("AUTHORITY_UNAVAILABLE"));
});

test("local auth expiry/region/missing identity refuses before any Account request", async () => {
  for (const edit of [state => null, state => ({ ...state, accessTokenExpiresAt: 1 }),
    state => ({ ...state, account: { ...state.account, region: "global" } }), state => ({ ...state, desktop: {} })]) {
    const f = fixture(); f.setState(edit(f.getState()));
    await assert.rejects(f.access.run("read", () => assert.fail()), error => ["AUTH_REQUIRED", "SCOPE_CHANGED"].includes(error.code));
    assert.equal(f.requests.length, 0); assert.equal(fs.existsSync(join(f.home, ".hara")), false);
  }
});

test("late success, upstream error and thrown network error all prioritize sign-in drift", async () => {
  for (const response of [f => json(f.envelope()), () => new Response("private", { status: 503 }), () => { throw new Error("private"); }]) {
    const f = fixture(); f.handler(() => { f.setState({ ...f.getState(), accessToken: "other-private-login" }); return response(f); });
    await assert.rejects(f.access.run("read", () => assert.fail()), denied("SCOPE_CHANGED"));
    assert.equal(fs.existsSync(join(f.home, ".hara")), false);
  }
});

test("explicit A-B-A invalidation stops an old request even after login is restored; a new admission can proceed", async () => {
  const f = fixture(); let release;
  f.handler(url => url.endsWith("/context") ? new Promise(resolve => { release = () => resolve(json(f.envelope())); }) : undefined);
  const pending = f.access.run("read", () => assert.fail());
  assert.equal(typeof release, "function");
  f.access.invalidate(); f.access.invalidate(); release();
  await assert.rejects(pending, denied("SCOPE_CHANGED"));
  f.handler(undefined);
  assert.equal(await f.access.run("read", r => r.agents.list().revision), 0);
});

test("borrowed real stores expire when callback ends, and every old async mutation retains its original guard", async () => {
  const f = fixture(); let retained;
  await f.access.run("configure", r => { retained = r; return r.agents.initializeMain(); });
  for (const call of [() => retained.agents.list(), () => retained.connections.list(), () => retained.sessions.list()]) assert.throws(call, denied("SCOPE_CHANGED"));
  await assert.rejects(retained.memory.append("global", "memory", "never write", f.home), denied("SCOPE_CHANGED"));
  assert.equal(await f.access.run("read", r => r.agents.list().agents.length), 1);
});

test("actual scoped tasks retain signed-scope storage ownership; A/B same connection id never resolve outside their own store", async () => {
  const home = dir(), a = fixture(scope(), home), b = fixture(scope(B), home);
  const prepare = async (f, key) => {
    const main = await f.access.run("configure", r => { r.connections.addDirect({ ...connection, apiKey: key }); return r.agents.initializeMain(); });
    return f.access.run("task-binding", r => r.agents.bindTask(createTaskExecution("synthetic", "synthetic-turn"), main.agentId, main.configRevision, main.agentEpoch));
  };
  const [ta, tb] = await Promise.all([prepare(a, "key-a"), prepare(b, "key-b")]);
  assert.notEqual(ta.workspaceAgentBinding.resourceBinding.scopeKey, tb.workspaceAgentBinding.resourceBinding.scopeKey);
  await a.access.run("task-binding", r => { assert.throws(() => r.agents.resolveTask(tb.workspaceAgentBinding), /resource scope/);
    assert.equal(r.connections.get(connection.id).apiKey, "key-a"); });
  await b.access.run("read", r => assert.equal(r.connections.get(connection.id).apiKey, "key-b"));
});

test("five-second lease, backwards clock, external cancellation and local invalidation deny suspended real writes", async () => {
  for (const mode of ["expiry", "backwards", "cancel", "invalidate", "login"]) {
    const f = fixture(), signal = new AbortController(); let release, entered;
    const gate = new Promise(resolve => { entered = resolve; });
    const pending = f.access.run("configure", async r => {
      r.agents.initializeMain(); entered(); await new Promise(resolve => { release = resolve; });
      r.connections.addDirect(connection);
    }, signal.signal);
    await gate;
    if (mode === "expiry") f.tick(5000);
    if (mode === "backwards") f.tick(-1);
    if (mode === "cancel") signal.abort();
    if (mode === "invalidate") f.access.invalidate();
    if (mode === "login") f.setState(null);
    release();
    await assert.rejects(pending, denied(mode === "cancel" ? "CANCELLED" : ["expiry", "backwards"].includes(mode) ? "ACCESS_EXPIRED" : "SCOPE_CHANGED"));
    assert.equal(raw(f).connections.get(connection.id), undefined);
  }
});

test("profile staging and claim fences preserve original bytes on late local invalidation", async () => {
  for (const hook of ["open", "claim"]) {
    const f = fixture(); await f.access.run("configure", r => r.connections.addDirect(connection));
    const filename = stateFile(f, "profiles.json"), before = fs.readFileSync(filename, "utf8");
    const originalOpen = fs.openSync, originalRename = fs.renameSync; let fired = false;
    fs.openSync = function(target, ...args) {
      const fd = originalOpen.call(this, target, ...args);
      if (hook === "open" && !fired && typeof target === "string" && dirname(target) === dirname(filename) && target.includes(".hara-private-")) {
        fired = true; f.access.invalidate();
      }
      return fd;
    };
    fs.renameSync = function(from, to, ...args) {
      const result = originalRename.call(this, from, to, ...args);
      if (hook === "claim" && !fired && from === filename && String(to).includes(".hara-claim-")) { fired = true; f.access.invalidate(); }
      return result;
    };
    syncBuiltinESMExports();
    try { await assert.rejects(f.access.run("configure", r => r.connections.setModel(connection.id, "blocked-model")), denied("SCOPE_CHANGED")); }
    finally { fs.openSync = originalOpen; fs.renameSync = originalRename; syncBuiltinESMExports(); }
    assert.equal(fired, true, "the intended late-write boundary was actually reached");
    assert.equal(fs.readFileSync(filename, "utf8"), before);
  }
});

test("raw storage authority fences reject asynchronous callbacks without initialization", () => {
  const f = fixture();
  const storage = new WorkspaceResourceStorage(f.home, f.identity, async () => {});
  assert.throws(() => storage.initialize(), /synchronous/);
  assert.equal(fs.existsSync(join(f.home, ".hara")), false);
});

test("read/action labels cannot downgrade credential, Agent, history or memory mutations", async () => {
  const f = fixture();
  await f.access.run("configure", r => r.agents.initializeMain());
  f.policy((_principal, action) => action === "read" || action === "memory-write" || action === "task-binding");
  for (const [action, call] of [
    ["read", r => r.connections.addDirect(connection)],
    ["read", r => r.agents.create({ username: "forbidden", profile: { displayName: "Forbidden" } }, 1)],
    ["read", r => r.memory.append("global", "memory", "forbidden", f.home)],
    ["read", r => r.sessions.delete("forbidden-session")],
    ["memory-write", r => r.connections.addDirect(connection)],
    ["task-binding", r => r.connections.setModel("personal", "forbidden-model")],
  ]) await assert.rejects(f.access.run(action, call), denied("ACCESS_DENIED"));
  assert.equal(raw(f).connections.get(connection.id), undefined);
  assert.equal(raw(f).agents.list().agents.length, 1);
});

test("config claim denial must preserve the original configuration bytes and inode", async () => {
  const f = fixture();
  await f.access.run("configure", r => r.connections.setModel("personal", "original-model"));
  const filename = stateFile(f, "config.json"), before = fs.readFileSync(filename, "utf8"), inode = fs.statSync(filename).ino;
  const original = fs.renameSync; let fired = false;
  fs.renameSync = function(from, to, ...args) {
    const result = original.call(this, from, to, ...args);
    if (!fired && from === filename && String(to).includes(".hara-claim-")) { fired = true; f.access.invalidate(); }
    return result;
  };
  syncBuiltinESMExports();
  try { await assert.rejects(f.access.run("configure", r => r.connections.setModel("personal", "forbidden-model")), denied("SCOPE_CHANGED")); }
  finally { fs.renameSync = original; syncBuiltinESMExports(); }
  assert.equal(fired, true);
  assert.equal(fs.readFileSync(filename, "utf8"), before);
  assert.equal(fs.statSync(filename).ino, inode);
});

test("observed drift or backwards time cannot be swallowed to revive the same old lease", async () => {
  for (const mode of ["login", "clock"]) {
    const f = fixture(), original = f.getState();
    await assert.rejects(f.access.run("configure", r => {
      r.agents.initializeMain();
      if (mode === "login") f.setState({ ...original, accessToken: "different-private-login" }); else f.tick(-1);
      assert.throws(() => r.agents.list(), denied(mode === "login" ? "SCOPE_CHANGED" : "ACCESS_EXPIRED"));
      if (mode === "login") f.setState(original); else f.tick(1);
      r.connections.addDirect(connection);
    }), denied(mode === "login" ? "SCOPE_CHANGED" : "ACCESS_EXPIRED"));
    assert.equal(raw(f).connections.get(connection.id), undefined);
  }
});

test("host policy changes and Account denial invalidate an already admitted concurrent local lease", async () => {
  for (const mode of ["policy", "account"]) {
    const f = fixture(); let release, entered;
    const gate = new Promise(resolve => { entered = resolve; });
    const pending = f.access.run("configure", async r => {
      r.agents.initializeMain(); entered(); await new Promise(resolve => { release = resolve; }); r.connections.addDirect(connection);
    });
    await gate;
    if (mode === "policy") f.policy(() => false);
    else {
      f.handler(() => new Response("private remote denial", { status: 403 }));
      await assert.rejects(f.access.run("read", () => assert.fail()), denied("ACCESS_DENIED"));
    }
    release(); await assert.rejects(pending, denied(mode === "policy" ? "ACCESS_DENIED" : "SCOPE_CHANGED"));
    assert.equal(raw(f).connections.get(connection.id), undefined);
  }
});

test("network acquisition counts against the five-second lease; there is no new lease after slow key fetch", async () => {
  const f = fixture(); f.handler(url => { if (url.endsWith("jwks.json")) f.tick(5000); });
  await assert.rejects(f.access.run("configure", () => assert.fail()), denied("ACCESS_EXPIRED"));
  assert.equal(fs.existsSync(join(f.home, ".hara")), false);
});

test("observed HTTP denial revokes concurrent writes before a stalled response-body cleanup yields", async () => {
  const f = fixture(); let entered, release, cleanupEntered, cleanupRelease;
  const inside = new Promise(resolve => { entered = resolve; });
  const cleanup = new Promise(resolve => { cleanupEntered = resolve; });
  const old = f.access.run("configure", async r => {
    r.agents.initializeMain(); entered(); await new Promise(resolve => { release = resolve; }); r.connections.addDirect(connection);
  });
  await inside;
  f.handler(() => new Response(new ReadableStream({ cancel() {
    cleanupEntered(); return new Promise(resolve => { cleanupRelease = resolve; });
  } }), { status: 403 }));
  const denial = assert.rejects(f.access.run("read", () => assert.fail()), denied("ACCESS_DENIED"));
  await cleanup;
  release();
  try { await assert.rejects(old, denied("SCOPE_CHANGED")); assert.equal(raw(f).connections.get(connection.id), undefined); }
  finally { cleanupRelease(); }
  await denial;
});

test("real lease timer aborts stalled HTTP acquisition even with a frozen injected clock", async () => {
  const f = fixture();
  f.handler((_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new Error("private abort detail")), { once: true });
  }));
  await assert.rejects(f.access.run("read", () => assert.fail()), denied("ACCESS_EXPIRED"));
  assert.equal(f.requests.length, 1);
  assert.equal(fs.existsSync(join(f.home, ".hara")), false);
});

test("bounded admission refuses long-lived Session lock lifecycle before acquiring or deleting", async () => {
  for (const method of ["acquire", "release", "delete"]) {
    const f = fixture();
    await assert.rejects(f.access.run("history-write", r => r.sessions[method]("synthetic-long-lock")), denied("ACCESS_DENIED"));
    assert.equal(fs.existsSync(stateFile(f, "sessions/synthetic-long-lock.lock")), false);
  }
});

test("permitted bounded memory and Session save/read use original guards without long-lived locks", async () => {
  const f = fixture();
  const main = await f.access.run("configure", r => r.agents.initializeMain());
  const task = await f.access.run("task-binding", r => r.agents.bindTask(createTaskExecution("synthetic", "saved-turn"),
    main.agentId, main.configRevision, main.agentEpoch));
  await f.access.run("memory-write", r => r.memory.append("global", "memory", "authorized scoped fact", f.home));
  await f.access.run("history-write", r => r.sessions.save({ id: "bounded-save", cwd: f.home, provider: "openai", model: "synthetic-model",
    profileId: "same-key", spaceId: "personal", workspaceAgentId: main.agentId, title: "Synthetic",
    createdAt: "2026-10-16T00:00:00Z", updatedAt: "2026-10-16T00:00:00Z" }, [{ role: "user", content: "synthetic" }], task));
  await f.access.run("read", r => {
    assert.match(r.memory.digest(f.home), /authorized scoped fact/);
    assert.equal(r.sessions.load("bounded-save").meta.workspaceAgentId, main.agentId);
  });
  assert.equal(fs.existsSync(stateFile(f, "sessions/bounded-save.lock")), false);
});
