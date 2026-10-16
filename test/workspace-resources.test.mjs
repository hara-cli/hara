import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceResources } from "../dist/workspace/resources.js";
import { workspaceResourceScopeKey, parseWorkspaceResourceScope } from "../dist/workspace/resource-context.js";
import { saveSession, loadSession, listSessions } from "../dist/session/store.js";
import { appendMemory, memoryDigest } from "../dist/memory/store.js";
import { readRawConfig, updateRawConfig } from "../dist/config.js";
import { addProfile, getProfile } from "../dist/profile/profile.js";
import { SessionHub } from "../dist/serve/sessions.js";
import { syncBuiltinESMExports } from "node:module";
import fsPromises from "node:fs/promises";
import fsBuiltin from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const temporary = [];
after(() => { for (const target of temporary) rmSync(target, { recursive: true, force: true }); });
function dir() { const value = realpathSync.native(mkdtempSync(join(tmpdir(), "hara-resource-test-"))); temporary.push(value); return value; }
const workspaceId = "ws_10000000-0000-4000-8000-000000000001";
const local = (w = workspaceId, id = "20000000-0000-4000-8000-000000000001") => ({ schemaVersion: 1, workspaceId: w, authority: { kind: "local", localAuthorityId: id } });
const hosted = (accountRegion = "CN", issuer = "https://account.example.invalid", realmId = "30000000-0000-4000-8000-000000000001") => ({ schemaVersion: 1, workspaceId,
  authority: { kind: "account", accountRegion, issuer, realmId } });
function open(home, scope = local()) { const result = new WorkspaceResources(home, scope); result.initialize(); return result; }
const partition = (home, scope) => join(home, ".hara", "workspace-data", "v1", workspaceResourceScopeKey(scope));
function meta(id, cwd, title = "synthetic session") { return { id, cwd, provider: "openai", model: "synthetic-model", profileId: "synthetic-key", spaceId: "personal", title,
  createdAt: "2026-10-16T00:00:00Z", updatedAt: "2026-10-16T00:00:00Z" }; }
const history = text => [{ role: "user", content: text }];
const key = "synthetic-shared-key-not-a-real-secret";

test("strict scope tuple includes local authority, Account issuer/region and enrolled Realm", () => {
  const scopes = [local(), local(workspaceId, "20000000-0000-4000-8000-000000000002"), hosted(), hosted("GLOBAL"),
    hosted("CN", "https://other.example.invalid"), hosted("CN", undefined, "30000000-0000-4000-8000-000000000002")];
  assert.equal(new Set(scopes.map(workspaceResourceScopeKey)).size, scopes.length);
  for (const scope of scopes) assert.deepEqual(parseWorkspaceResourceScope(scope), scope);
  for (const value of [{ ...local(), schemaVersion: 2 }, { ...local(), workspaceId: "../foreign" },
    { ...local(), key }, { ...hosted(), authority: { ...hosted().authority, accountRegion: "cn" } },
    hosted("CN", "http://account.example.invalid"), hosted("CN", "https://account.example.invalid/path"),
    hosted("CN", `https://${"x".repeat(513)}.invalid`),
    hosted("CN", "https://user:password@account.example.invalid"), { ...local(), authority: { kind: "local", localAuthorityId: "../../state" } }]) {
    assert.throws(() => parseWorkspaceResourceScope(value), /scope/);
  }
});

test("construction is side-effect-free; explicit new storage has no inherited key, memory or sessions", async () => {
  const host = dir(), cwd = dir(), scope = local();
  const before = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, HARA_MEMORY: process.env.HARA_MEMORY };
  const resources = new WorkspaceResources(host, scope);
  assert.equal(existsSync(join(host, ".hara")), false);
  assert.throws(() => resources.sessions.list(), /not initialized/);
  resources.initialize();
  assert.deepEqual(resources.sessions.list(), []);
  assert.equal(resources.memory.digest(cwd), "");
  assert.equal(resources.connections.get("synthetic-key"), undefined);
  assert.ok(resources.connections.list().every(profile => !profile.apiKey && !profile.deviceToken));
  assert.deepEqual({ HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, HARA_MEMORY: process.env.HARA_MEMORY }, before);
  const marker = join(partition(host, scope), "scope.json");
  const exact = readFileSync(marker, "utf8");
  resources.initialize();
  assert.equal(readFileSync(marker, "utf8"), exact, "reopen keeps the immutable storage generation");
  if (process.platform !== "win32") {
    assert.equal(statSync(marker).mode & 0o777, 0o600);
    assert.equal(statSync(partition(host, scope)).mode & 0o777, 0o700);
  }
});

test("same key/profile/session IDs in concurrent Workspace stores never share state or lock ownership", async () => {
  const host = dir(), cwd = dir();
  const a = open(host, local()), b = open(host, local("ws_10000000-0000-4000-8000-000000000002"));
  const add = resources => resources.connections.addDirect({ id: "synthetic-key", provider: "openai", apiKey: key, model: "model-a" }, { activate: true });
  assert.deepEqual(add(a), { ok: true }); assert.deepEqual(add(b), { ok: true });
  assert.deepEqual(a.connections.setModel("synthetic-key", "model-a-new"), { ok: true });
  assert.equal(b.connections.get("synthetic-key").model, "model-a");
  const id = "same-native-or-local-session";
  a.sessions.save(meta(id, cwd, "Workspace A"), history("A private body"));
  b.sessions.save(meta(id, cwd, "Workspace B"), history("B private body"));
  assert.equal(a.sessions.load(id).meta.title, "Workspace A");
  assert.equal(b.sessions.load(id).meta.title, "Workspace B");
  assert.equal(a.sessions.acquire(id).ok, true); assert.equal(b.sessions.acquire(id).ok, true);
  a.sessions.release(id);
  const lockB = join(partition(host, b.scope), "state", ".hara", "sessions", `${id}.lock`);
  assert.equal(existsSync(lockB), true, "releasing A must not release or lose proof of B's lock");
  b.sessions.release(id);
  assert.equal(existsSync(lockB), false);
  await Promise.all([a.memory.append("global", "memory", "A-only durable fact", cwd), b.memory.append("global", "memory", "B-only durable fact", cwd)]);
  assert.match(a.memory.digest(cwd), /A-only/); assert.doesNotMatch(a.memory.digest(cwd), /B-only/);
  assert.match(b.memory.digest(cwd), /B-only/); assert.doesNotMatch(b.memory.digest(cwd), /A-only/);
  assert.equal(a.connections.remove("synthetic-key").ok, true);
  assert.equal(b.connections.get("synthetic-key").apiKey, key);
  assert.equal(a.sessions.delete(id), true);
  assert.equal(b.sessions.load(id).history[0].content, "B private body");
});

test("project memory for the same checkout is partitioned, ignores legacy HARA_MEMORY, and searches only this scope", async () => {
  const host = dir(), cwd = dir(), legacy = dir();
  mkdirSync(join(cwd, ".hara", "memory"), { recursive: true });
  writeFileSync(join(cwd, ".hara", "memory", "MEMORY.md"), "legacy-project-do-not-adopt");
  writeFileSync(join(legacy, "MEMORY.md"), "legacy-global-do-not-adopt");
  const old = process.env.HARA_MEMORY; process.env.HARA_MEMORY = legacy;
  try {
    const a = open(host, local()), b = open(host, hosted());
    await Promise.all([a.memory.append("project", "memory", "blueprint A scoped fact", cwd), b.memory.append("project", "memory", "blueprint B scoped fact", cwd)]);
    const [left, right] = await Promise.all([a.memory.search("blueprint", cwd), b.memory.search("blueprint", cwd)]);
    assert.ok(left.length && right.length);
    assert.ok(left.every(hit => !hit.snippet.includes("B scoped")));
    assert.ok(right.every(hit => !hit.snippet.includes("A scoped")));
    assert.doesNotMatch(a.memory.digest(cwd), /legacy-|B scoped/);
    assert.doesNotMatch(b.memory.digest(cwd), /legacy-|A scoped/);
    assert.equal(readFileSync(join(cwd, ".hara", "memory", "MEMORY.md"), "utf8"), "legacy-project-do-not-adopt");
    assert.equal(readFileSync(join(legacy, "MEMORY.md"), "utf8"), "legacy-global-do-not-adopt");
    assert.notDeepEqual(a.memory.roots(cwd), b.memory.roots(cwd));
  } finally { if (old === undefined) delete process.env.HARA_MEMORY; else process.env.HARA_MEMORY = old; }
});

test("existing legacy key/config/session/memory remain untouched and are not adopted by an explicit Workspace", async () => {
  const host = dir(), cwd = dir(), legacyMemory = dir();
  const oldOverride = process.env.HARA_MEMORY; process.env.HARA_MEMORY = legacyMemory;
  try {
    updateRawConfig(cfg => { cfg.apiKey = "synthetic-legacy-key"; cfg.provider = "openai"; cfg.model = "legacy-model"; });
    assert.equal(addProfile({ id: "legacy-only-key", kind: "byok", provider: "openai", apiKey: "synthetic-legacy-named-key" }).ok, true);
    saveSession(meta("legacy-only-session", cwd), history("legacy-only body"));
    await appendMemory("global", "memory", "legacy-only durable fact", cwd);
    const files = [join(homedir(), ".hara", "config.json"), join(homedir(), ".hara", "profiles.json"),
      join(homedir(), ".hara", "sessions", "legacy-only-session.json"), join(legacyMemory, "MEMORY.md")];
    const digest = () => files.map(file => createHash("sha256").update(readFileSync(file)).digest("hex"));
    const before = digest();
    const resources = open(host);
    assert.equal(resources.connections.get("legacy-only-key"), undefined);
    assert.equal(resources.connections.get("personal").apiKey, undefined);
    assert.equal(resources.sessions.load("legacy-only-session"), null);
    assert.deepEqual(resources.sessions.list(), []);
    assert.equal(resources.memory.digest(cwd), "");
    assert.deepEqual(await resources.memory.search("legacy", cwd), []);
    assert.deepEqual(resources.connections.addDirect({ id: "legacy-only-key", provider: "openai", apiKey: key }), { ok: true });
    await resources.memory.append("global", "memory", "new Workspace-only fact", cwd);
    resources.sessions.save(meta("legacy-only-session", cwd, "new scoped title"), history("new scoped body"));
    assert.deepEqual(digest(), before);
    assert.equal(readRawConfig().apiKey, "synthetic-legacy-key");
    assert.equal(getProfile("legacy-only-key").apiKey, "synthetic-legacy-named-key");
    assert.equal(loadSession("legacy-only-session").history[0].content, "legacy-only body");
    assert.match(memoryDigest(cwd), /legacy-only durable/);
    assert.doesNotMatch(memoryDigest(cwd), /Workspace-only/);
  } finally { if (oldOverride === undefined) delete process.env.HARA_MEMORY; else process.env.HARA_MEMORY = oldOverride; }
});

test("identical hosted Workspace IDs across regions/issuers/Realms and local authority have independent stores", async () => {
  const host = dir(), cwd = dir();
  const scopes = [local(), hosted(), hosted("GLOBAL"), hosted("CN", "https://other.example.invalid"),
    hosted("CN", undefined, "30000000-0000-4000-8000-000000000002")];
  const stores = scopes.map(scope => open(host, scope));
  await Promise.all(stores.map(async (resources, index) => {
    assert.deepEqual(resources.connections.addDirect({ id: "same-key-id", provider: "openai", apiKey: key, model: `model-${index}` }), { ok: true });
    resources.sessions.save(meta("same-session-id", cwd, `scope-${index}`), history(`body-${index}`));
    await resources.memory.append("project", "memory", `marker-${index} scoped memory`, cwd);
  }));
  for (const [index, resources] of stores.entries()) {
    assert.equal(resources.connections.get("same-key-id").model, `model-${index}`);
    assert.equal(resources.sessions.list()[0].title, `scope-${index}`);
    assert.equal(resources.sessions.load("same-session-id").history[0].content, `body-${index}`);
    assert.match(resources.memory.digest(cwd), new RegExp(`marker-${index}`));
    for (let other = 0; other < stores.length; other++) if (other !== index) assert.doesNotMatch(resources.memory.digest(cwd), new RegExp(`marker-${other}`));
  }
});

test("foreign/unbound transcript copies cannot resume or overwrite a scoped session; legacy store rejects scoped transcripts", () => {
  const host = dir(), cwd = dir(), a = open(host, local()), b = open(host, hosted());
  a.sessions.save(meta("bound", cwd, "A"), history("A body"));
  b.sessions.save(meta("bound", cwd, "B"), history("B body"));
  const foreign = a.sessions.load("bound");
  assert.throws(() => b.sessions.save(foreign.meta, foreign.history), /resource scope/);
  assert.equal(b.sessions.load("bound").history[0].content, "B body");
  assert.throws(() => saveSession(foreign.meta, foreign.history), /legacy store/);
  const aFile = join(partition(host, a.scope), "state", ".hara", "sessions", "bound.json");
  const bCopied = join(partition(host, b.scope), "state", ".hara", "sessions", "copied.json");
  const copy = JSON.parse(readFileSync(aFile, "utf8")); copy.meta.id = "copied";
  writeFileSync(bCopied, JSON.stringify(copy));
  assert.equal(b.sessions.load("copied"), null);
  delete copy.meta.resourceBinding;
  writeFileSync(bCopied, JSON.stringify(copy));
  assert.equal(b.sessions.load("copied"), null, "legacy files need an explicit migration, not first-load adoption");
  const before = readFileSync(bCopied, "utf8");
  assert.throws(() => b.sessions.save(meta("copied", cwd), history("must not replace")), /resource scope/);
  assert.equal(readFileSync(bCopied, "utf8"), before);
  const legacyCopied = join(homedir(), ".hara", "sessions", "scoped-copy-in-legacy.json");
  mkdirSync(join(homedir(), ".hara", "sessions"), { recursive: true });
  copy.meta.id = "scoped-copy-in-legacy"; copy.meta.resourceBinding = foreign.meta.resourceBinding;
  writeFileSync(legacyCopied, JSON.stringify(copy));
  assert.equal(loadSession("scoped-copy-in-legacy"), null);
});

test("session indexes, paging cursors and journal transitions remain scope-bound after restart", async () => {
  const host = dir(), cwd = dir(), a = open(host, local()), b = open(host, hosted());
  for (let index = 0; index < 4; index++) {
    a.sessions.save(meta(`row-${index}`, cwd, `A-${index}`), history(`A-${index}`));
    b.sessions.save(meta(`row-${index}`, cwd, `B-${index}`), history(`B-${index}`));
  }
  await Promise.all([a.sessions.ensureIndex(), b.sessions.ensureIndex()]);
  const page = a.sessions.listPage({ limit: 1 });
  assert.equal(page.sessions.length, 1); assert.ok(page.nextCursor);
  assert.throws(() => b.sessions.listPage({ limit: 1, cursor: page.nextCursor }), /cursor.*scope/);
  const reopened = open(host, a.scope);
  const second = reopened.sessions.listPage({ limit: 1, cursor: page.nextCursor });
  assert.equal(second.sessions.length, 1); assert.notEqual(second.sessions[0].id, page.sessions[0].id);
  assert.ok(second.sessions.every(row => row.title.startsWith("A-")));
  assert.equal(a.sessions.recordRuntimeItem({ sessionId: "row-0", itemId: "scope-a-control", kind: "control", state: "completed" }), true);
  assert.equal(b.sessions.recordRuntimeItem({ sessionId: "row-0", itemId: "scope-b-control", kind: "control", state: "completed" }), true);
  assert.match(JSON.stringify(a.sessions.readJournal("row-0")), /scope-a-control/);
  assert.doesNotMatch(JSON.stringify(a.sessions.readJournal("row-0")), /scope-b-control/);
  assert.match(JSON.stringify(b.sessions.readJournal("row-0")), /scope-b-control/);
});

test("two real SessionHubs resume the same local ID through their independently bound stores", () => {
  const host = dir(), cwd = dir(), a = open(host, local()), b = open(host, hosted());
  for (const [resources, label] of [[a, "A"], [b, "B"]]) resources.sessions.save(meta("hub-shared-id", cwd, label), history(`${label} body`));
  const provider = { id: "openai", async infer() { throw new Error("model calls are forbidden in storage acceptance"); } };
  const hubA = new SessionHub(a.sessions), hubB = new SessionHub(b.sessions);
  try {
    const sa = hubA.resume("hub-shared-id", { provider, approval: "suggest" }).session;
    const sb = hubB.resume("hub-shared-id", { provider, approval: "suggest" }).session;
    assert.equal(sa.history[0].content, "A body"); assert.equal(sb.history[0].content, "B body");
    assert.equal(hubA.rename("hub-shared-id", "A renamed"), true);
    assert.equal(b.sessions.load("hub-shared-id").meta.title, "B");
    hubA.releaseAll();
    const lockB = join(partition(host, b.scope), "state", ".hara", "sessions", "hub-shared-id.lock");
    assert.equal(existsSync(lockB), true);
  } finally { hubA.releaseAll(); hubB.releaseAll(); }
});

test("missing, changed, oversized, foreign and future scope markers fail closed without recreating or replacing data", () => {
  for (const corruption of ["missing", "invalid", "future", "foreign", "generation", "oversized"]) {
    const host = dir(), cwd = dir(), resources = open(host);
    resources.sessions.save(meta("preserve", cwd), history("preserve body"));
    const marker = join(partition(host, resources.scope), "scope.json");
    const oldMarker = readFileSync(marker, "utf8");
    if (corruption === "missing") unlinkSync(marker);
    else if (corruption === "invalid") writeFileSync(marker, "{broken");
    else if (corruption === "oversized") writeFileSync(marker, " ".repeat(4097));
    else {
      const parsed = JSON.parse(oldMarker);
      if (corruption === "future") parsed.schemaVersion = 2;
      if (corruption === "foreign") parsed.scope = hosted();
      if (corruption === "generation") parsed.generation = "40000000-0000-4000-8000-000000000001";
      writeFileSync(marker, JSON.stringify(parsed));
    }
    const snapshot = existsSync(marker) ? readFileSync(marker, "utf8") : null;
    assert.throws(() => resources.sessions.list(), /scope|limit|large/i);
    assert.throws(() => resources.initialize(), /scope|limit|large/i);
    assert.throws(() => new WorkspaceResources(host, resources.scope).initialize(), /scope|limit|large|generation|binding/i);
    assert.equal(existsSync(marker) ? readFileSync(marker, "utf8") : null, snapshot);
    const transcript = join(partition(host, resources.scope), "state", ".hara", "sessions", "preserve.json");
    assert.match(readFileSync(transcript, "utf8"), /preserve body/);
  }
});

test("private path aliases and file aliases cannot read or modify a foreign Workspace", async t => {
  if (process.platform === "win32") return t.skip("POSIX alias fixture; Windows coverage remains separate");
  const host = dir(), cwd = dir(), foreign = dir(), a = open(host), b = open(host, hosted());
  await b.memory.append("global", "memory", "foreign-hidden-fact", cwd);
  const rootA = a.memory.roots(cwd)[1], rootB = b.memory.roots(cwd)[1];
  const target = join(rootB, "MEMORY.md"), alias = join(rootA, "MEMORY.md"), original = readFileSync(target, "utf8");
  for (const type of ["symbolic", "hard"]) {
    if (type === "symbolic") symlinkSync(target, alias); else linkSync(target, alias);
    assert.doesNotMatch(a.memory.digest(cwd), /foreign-hidden/);
    assert.deepEqual(await a.memory.search("foreign-hidden", cwd), []);
    await assert.rejects(a.memory.append("global", "memory", "must not append", cwd), /link|alias|regular/i);
    unlinkSync(alias);
    assert.equal(readFileSync(target, "utf8"), original);
  }
  const rootParent = join(partition(host, a.scope), "state", ".hara", "memory");
  renameSync(rootParent, `${rootParent}-preserved`);
  symlinkSync(join(partition(host, b.scope), "state", ".hara", "memory"), rootParent, "dir");
  assert.throws(() => a.memory.roots(cwd), /real directory|symbolic|identity changed/i);
  await assert.rejects(a.memory.append("global", "memory", "must not append", cwd), /real directory|symbolic|identity changed/i);
  assert.equal(readFileSync(target, "utf8"), original);
  const host2 = dir(); mkdirSync(join(host2, ".hara")); symlinkSync(foreign, join(host2, ".hara", "workspace-data"), "dir");
  assert.throws(() => open(host2), /real directory|symbolic/i);
  assert.deepEqual(Object.keys(readRawConfig()).filter(key => key === "foreign-hidden-fact"), []);
});

test("renaming the bound state directory cannot retarget an existing store object", () => {
  const host = dir(), cwd = dir(), a = open(host), state = join(partition(host, a.scope), "state");
  a.sessions.save(meta("retained", cwd), history("retained body"));
  renameSync(state, `${state}-preserved`); mkdirSync(state);
  assert.throws(() => a.connections.list(), /identity changed/);
  assert.throws(() => a.initialize(), /identity changed/);
  assert.match(readFileSync(join(`${state}-preserved`, ".hara", "sessions", "retained.json"), "utf8"), /retained body/);
});

test("a valid outer generation replacement cannot relabel existing keys, warm metadata caches, cursors or locks", () => {
  const host = dir(), cwd = dir(), a = open(host);
  a.connections.addDirect({ id: "preserve-key", provider: "openai", apiKey: key });
  a.sessions.save(meta("generation-owner", cwd, "generation-one"), history("original body"));
  assert.equal(a.sessions.list()[0].title, "generation-one"); // warm the actual process cache
  assert.equal(a.sessions.acquire("generation-owner").ok, true);
  const marker = join(partition(host, a.scope), "scope.json"), original = readFileSync(marker, "utf8");
  const changed = JSON.parse(original); changed.generation = "40000000-0000-4000-8000-000000000002";
  writeFileSync(marker, JSON.stringify(changed));
  try {
    const newer = new WorkspaceResources(host, a.scope);
    assert.throws(() => newer.initialize(), /generation|binding/);
    assert.throws(() => newer.sessions.list(), /not initialized/);
    assert.throws(() => newer.sessions.acquire("generation-owner"), /not initialized/);
    assert.throws(() => newer.connections.get("preserve-key"), /not initialized/);
    const lock = join(partition(host, a.scope), "state", ".hara", "sessions", "generation-owner.lock");
    const locked = readFileSync(lock, "utf8");
    assert.throws(() => newer.sessions.release("generation-owner"), /not initialized/);
    assert.equal(readFileSync(lock, "utf8"), locked);
  } finally { writeFileSync(marker, original); a.sessions.release("generation-owner"); }
  assert.equal(a.connections.get("preserve-key").apiKey, key);
});

test("an awaited memory write rechecks the frozen storage authority before committing, and restores the old inode", async t => {
  const host = dir(), cwd = dir(), a = open(host);
  await a.memory.append("global", "memory", "original fact must remain", cwd);
  const target = join(a.memory.roots(cwd)[1], "MEMORY.md"), originalFile = readFileSync(target, "utf8");
  const marker = join(partition(host, a.scope), "scope.json"), originalMarker = readFileSync(marker, "utf8");
  const originalOpen = fsPromises.open;
  let reached; const paused = new Promise(resolve => { reached = resolve; });
  let resume; const gate = new Promise(resolve => { resume = resolve; });
  t.mock.method(fsPromises, "open", async (...args) => {
    const handle = await originalOpen(...args);
    if (args[1] === "wx" && String(args[0]).includes(".hara-") && String(args[0]).includes("memory")) {
      const originalWrite = handle.writeFile.bind(handle);
      handle.writeFile = async (...writeArgs) => { const result = await originalWrite(...writeArgs); reached(); await gate; return result; };
    }
    return handle;
  });
  syncBuiltinESMExports();
  const write = a.memory.replace("global", "memory", "forbidden late replacement", cwd);
  // Attach the rejection handler before releasing the deliberately suspended filesystem operation.
  const denied = assert.rejects(write, /scope marker changed|binding changed/);
  try {
    await paused;
    const changed = JSON.parse(originalMarker); changed.generation = "40000000-0000-4000-8000-000000000003";
    writeFileSync(marker, JSON.stringify(changed));
    resume(); await denied;
    assert.equal(readFileSync(target, "utf8"), originalFile);
  } finally {
    resume(); t.mock.restoreAll(); syncBuiltinESMExports(); writeFileSync(marker, originalMarker);
  }
  assert.match(a.memory.digest(cwd), /original fact/);
  assert.doesNotMatch(a.memory.digest(cwd), /forbidden late/);
});

test("a memory root swapped while lexical search awaits cannot return another Workspace's snippets", async t => {
  if (process.platform === "win32") return t.skip("POSIX directory-alias race fixture");
  const host = dir(), cwd = dir(), a = open(host), b = open(host, hosted());
  await a.memory.append("global", "memory", "A harmless memory", cwd);
  await b.memory.append("global", "memory", "race-only-foreign-secret-marker", cwd);
  const rootA = a.memory.roots(cwd)[1], rootB = b.memory.roots(cwd)[1];
  const originalOpendir = fsPromises.opendir;
  let swapped = false;
  t.mock.method(fsPromises, "opendir", async (...args) => {
    if (String(args[0]) === rootA && !swapped) {
      swapped = true; renameSync(rootA, `${rootA}-preserved`); symlinkSync(rootB, rootA, "dir");
    }
    return originalOpendir(...args);
  });
  syncBuiltinESMExports();
  try {
    let hits = [];
    try { hits = await a.memory.search("race-only-foreign", cwd); }
    catch (error) { assert.match(error.message, /directory|identity changed|alias/i); }
    assert.equal(swapped, true, "the actual async directory walk reached the race gate");
    assert.deepEqual(hits, []);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); if (swapped) { unlinkSync(rootA); renameSync(`${rootA}-preserved`, rootA); } }
});

test("direct-connection validation and capacity failures preserve existing private state", async () => {
  const host = dir(), cwd = dir(), a = open(host);
  assert.deepEqual(a.connections.addDirect({ id: "valid-key", provider: "openai", apiKey: key }), { ok: true });
  const file = join(partition(host, a.scope), "state", ".hara", "profiles.json"), before = readFileSync(file, "utf8");
  for (const value of [null, { id: "personal", provider: "openai", apiKey: key },
    { id: "bad", provider: "hara-gateway", apiKey: key }, { id: "bad", provider: "openai", apiKey: key, deviceToken: "forbidden" },
    { id: "bad", provider: "openai", apiKey: "x".repeat(16_385) }, { id: "bad", provider: "openai", apiKey: "line\nbreak" }]) {
    assert.throws(() => a.connections.addDirect(value), /direct Workspace connection/);
  }
  assert.equal(readFileSync(file, "utf8"), before);
  await a.memory.append("global", "memory", "preserved small fact", cwd);
  const memoryFile = join(a.memory.roots(cwd)[1], "MEMORY.md"), prior = readFileSync(memoryFile, "utf8");
  await assert.rejects(a.memory.replace("global", "memory", "x".repeat(256 * 1024 + 1), cwd), /too large/);
  await assert.rejects(a.memory.append("global", "memory", "x".repeat(256 * 1024), cwd), /too large/);
  assert.equal(readFileSync(memoryFile, "utf8"), prior);
  if (process.platform !== "win32") assert.equal(statSync(memoryFile).mode & 0o777, 0o600);
});

test("missing or future data-side binding cannot be auto-repaired or relabeled on reopen", () => {
  for (const change of ["missing", "future", "foreign"]) {
    const host = dir(), a = open(host);
    a.connections.addDirect({ id: "held-key", provider: "openai", apiKey: key });
    const dataMarker = join(partition(host, a.scope), "state", ".hara", "resource-binding.json");
    if (change === "missing") unlinkSync(dataMarker);
    else { const value = JSON.parse(readFileSync(dataMarker, "utf8")); if (change === "future") value.schemaVersion = 2;
      else value.scopeKey = "f".repeat(64); writeFileSync(dataMarker, JSON.stringify(value)); }
    const before = existsSync(dataMarker) ? readFileSync(dataMarker, "utf8") : null;
    assert.throws(() => a.connections.get("held-key"), /binding changed/);
    assert.throws(() => new WorkspaceResources(host, a.scope).initialize(), /binding.*missing|binding mismatch/);
    assert.equal(existsSync(dataMarker) ? readFileSync(dataMarker, "utf8") : null, before);
  }
});

test("real child processes share only their exact Workspace lock and can run the same ID in another scope", async () => {
  const host = dir(), a = open(host), b = open(host, hosted()), id = "process-lock";
  assert.equal(a.sessions.acquire(id).ok, true);
  const source = new URL("../dist/workspace/resources.js", import.meta.url).href;
  const script = `import {WorkspaceResources} from ${JSON.stringify(source)};
    const r=new WorkspaceResources(process.argv[1],JSON.parse(process.argv[2]));r.initialize();
    const result=r.sessions.acquire(process.argv[3]);if(result.ok)r.sessions.release(process.argv[3]);
    process.stdout.write(JSON.stringify(result));`;
  try {
    const invoke = scope => promisify(execFile)(process.execPath, ["--input-type=module", "-e", script, host, JSON.stringify(scope), id], { timeout: 15_000 });
    const [same, other] = await Promise.all([invoke(a.scope), invoke(b.scope)]);
    assert.equal(JSON.parse(same.stdout).ok, false);
    assert.equal(JSON.parse(same.stdout).pid, process.pid);
    assert.equal(JSON.parse(other.stdout).ok, true);
    assert.equal(existsSync(join(partition(host, a.scope), "state", ".hara", "sessions", `${id}.lock`)), true);
  } finally { a.sessions.release(id); }
});

test("a late parent alias before the first memory snapshot cannot leak digest text or redirect a write", async t => {
  if (process.platform === "win32") return t.skip("POSIX parent-alias snapshot race fixture");
  const host = dir(), cwd = dir(), a = open(host), b = open(host, hosted());
  await a.memory.append("global", "memory", "A original fact", cwd);
  await b.memory.append("global", "memory", "late-parent-foreign-marker", cwd);
  const rootA = a.memory.roots(cwd)[1], rootB = b.memory.roots(cwd)[1];
  const fileA = join(rootA, "MEMORY.md"), fileB = join(rootB, "MEMORY.md"), originalB = readFileSync(fileB, "utf8");
  const originalLstat = fsBuiltin.lstatSync;
  for (const operation of ["digest", "append"]) {
    let swapped = false;
    t.mock.method(fsBuiltin, "lstatSync", (...args) => {
      if (String(args[0]) === fileA && !swapped) {
        swapped = true; renameSync(rootA, `${rootA}-preserved`); symlinkSync(rootB, rootA, "dir");
      }
      return originalLstat(...args);
    });
    syncBuiltinESMExports();
    try {
      if (operation === "digest") {
        try { assert.doesNotMatch(a.memory.digest(cwd), /late-parent-foreign-marker/); }
        catch (error) { assert.match(error.message, /directory|alias|scope/i); }
      } else {
        let denied;
        try { await a.memory.append("global", "memory", "must never reach B", cwd); } catch (error) { denied = error; }
        assert.equal(createHash("sha256").update(readFileSync(fileB)).digest("hex"), createHash("sha256").update(originalB).digest("hex"));
        assert.match(denied?.message ?? "write was not refused", /directory|alias|scope/i);
      }
      assert.equal(swapped, true);
      assert.equal(readFileSync(fileB, "utf8"), originalB);
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); if (swapped) { unlinkSync(rootA); renameSync(`${rootA}-preserved`, rootA); } }
  }
});

test("a sessions-directory alias introduced at staging open cannot overwrite another Workspace's transcript", t => {
  if (process.platform === "win32") return t.skip("POSIX staging-parent alias fixture");
  const host = dir(), cwd = dir(), a = open(host), b = open(host, hosted()), id = "alias-target";
  a.sessions.save(meta(id, cwd, "A original"), history("A original body"));
  b.sessions.save(meta(id, cwd, "B must remain"), history("B must remain body"));
  const replacementMeta = a.sessions.load(id).meta;
  replacementMeta.title = "forbidden A replacement";
  const dirA = join(partition(host, a.scope), "state", ".hara", "sessions");
  const dirB = join(partition(host, b.scope), "state", ".hara", "sessions");
  const fileB = join(dirB, `${id}.json`), originalB = readFileSync(fileB, "utf8"), originalOpen = fsBuiltin.openSync;
  let swapped = false;
  t.mock.method(fsBuiltin, "openSync", (...args) => {
    if (String(args[0]).startsWith(`${dirA}/`) && String(args[0]).includes(".tmp") && !swapped) {
      swapped = true; renameSync(dirA, `${dirA}-preserved`); symlinkSync(dirB, dirA, "dir");
    }
    return originalOpen(...args);
  });
  syncBuiltinESMExports();
  try {
    try { a.sessions.save(replacementMeta, history("must not overwrite B")); } catch { /* refusal is expected */ }
    assert.equal(swapped, true);
    assert.equal(createHash("sha256").update(readFileSync(fileB)).digest("hex"), createHash("sha256").update(originalB).digest("hex"));
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); if (swapped) { unlinkSync(dirA); renameSync(`${dirA}-preserved`, dirA); } }
});

test("a parent replacement at scoped removal cannot delete another Workspace's same-ID transcript", t => {
  if (process.platform === "win32") return t.skip("POSIX scoped-removal claim fixture");
  const host = dir(), cwd = dir(), a = open(host), b = open(host, hosted()), id = "remove-same-id";
  a.sessions.save(meta(id, cwd), history("A retained body")); b.sessions.save(meta(id, cwd), history("B retained body"));
  const dirA = join(partition(host, a.scope), "state", ".hara", "sessions"), dirB = join(partition(host, b.scope), "state", ".hara", "sessions");
  const fileA = join(dirA, `${id}.json`), fileB = join(dirB, `${id}.json`), originalB = readFileSync(fileB, "utf8");
  const nativeRemove = fsBuiltin.rmSync, nativeRename = fsBuiltin.renameSync;
  let swapped = false;
  const swap = path => { if (String(path) === fileA && !swapped) { swapped = true; nativeRename(dirA, `${dirA}-preserved`); symlinkSync(dirB, dirA, "dir"); } };
  t.mock.method(fsBuiltin, "rmSync", (...args) => { swap(args[0]); return nativeRemove(...args); });
  t.mock.method(fsBuiltin, "renameSync", (...args) => { swap(args[0]); return nativeRename(...args); });
  syncBuiltinESMExports();
  try {
    try { a.sessions.delete(id); } catch { /* a changed source scope is refused */ }
    assert.equal(swapped, true);
    assert.equal(existsSync(fileB), true);
    assert.equal(readFileSync(fileB, "utf8"), originalB);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); if (swapped) { unlinkSync(dirA); nativeRename(`${dirA}-preserved`, dirA); } }
});
