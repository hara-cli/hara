import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addWorkspace, attachDirectWorkspaceConnection, bootstrapWorkspaceRegistry, isWorkspaceId,
  parseWorkspaceRegistry, reauthorizeWorkspaceConnection, revokeWorkspaceConnection, selectWorkspace,
  setWorkspaceDefault, workspaceConnections, workspaceDirectory,
} from "../dist/workspace/registry.js";
import {
  assertWorkspaceRunConnection, bindWorkspaceProvider, captureWorkspaceRunConnection,
  legacyWorkspaceConnection, workspaceRouteFingerprint,
} from "../dist/workspace/connections.js";
import { WorkspaceRegistryStore } from "../dist/workspace/store.js";

const homes = [];
after(() => { for (const home of homes) rmSync(home, { recursive: true, force: true }); });
function home() {
  const value = realpathSync.native(mkdtempSync(join(tmpdir(), "hara-workspace-registry-")));
  homes.push(value);
  return value;
}
function fixture() {
  const profiles = [
    { id: "personal", kind: "byok", label: "模型套餐不是空間名稱", provider: "openai", apiKey: "synthetic-direct-one", baseURL: "https://one.invalid/v1", model: "model-one" },
    { id: "second-key", kind: "byok", provider: "openai", apiKey: "synthetic-direct-two", model: "model-two" },
    { id: "org-a", kind: "gateway", label: "A", tenantName: "工作室", tenantId: "tenant-a", gatewayUrl: "https://a.invalid", deviceToken: "synthetic-managed-one", deviceId: "device-a", enrolledAt: "2026-01-01" },
    { id: "org-a-other-key", kind: "gateway", tenantId: "tenant-a", gatewayUrl: "https://a.invalid", deviceToken: "synthetic-managed-two", deviceId: "device-b", enrolledAt: "2026-01-02" },
    { id: "org-b", kind: "gateway", label: "B", tenantId: "tenant-b", gatewayUrl: "https://b.invalid", deviceToken: "synthetic-managed-three", deviceId: "device-c" },
  ];
  const legacy = profiles.map(legacyWorkspaceConnection);
  const registry = bootstrapWorkspaceRegistry(legacy, "second-key", "2026-10-14T00:00:00Z");
  const resolve = (id) => profiles.find((row) => row.id === id);
  const connection = (id) => registry.connections.find((row) => row.profileId === id);
  return { profiles, legacy, registry, resolve, connection };
}
function capture(f, profileId = "personal") {
  const row = f.connection(profileId);
  return captureWorkspaceRunConnection(f.registry, row.workspaceId, row.id, "model-one", f.resolve);
}

test("legacy keys stay together while managed Space boundaries and active default are preserved", () => {
  const f = fixture();
  assert.equal(f.registry.workspaces.length, 3);
  const personal = f.registry.workspaces.find((row) => row.legacySpaceId === "personal");
  assert.equal(personal.label, "我的空間");
  assert.equal(f.connection("personal").workspaceId, f.connection("second-key").workspaceId);
  assert.equal(f.connection("org-a").workspaceId, f.connection("org-a-other-key").workspaceId);
  assert.notEqual(f.connection("org-a").workspaceId, f.connection("org-b").workspaceId);
  assert.equal(f.registry.activeWorkspaceId, personal.id);
  assert.equal(personal.defaultConnectionId, f.connection("second-key").id);
  assert.ok(f.registry.workspaces.every((row) => isWorkspaceId(row.id) && !Object.hasOwn(row, "kind")));
});

test("new user and new Workspaces start without copied connections, defaults or aliases", () => {
  const empty = bootstrapWorkspaceRegistry([], null);
  assert.equal(empty.workspaces.length, 1);
  assert.equal(empty.connections.length, 0);
  const f = fixture();
  const next = addWorkspace(f.registry, "新工作室");
  const created = next.workspaces.at(-1);
  assert.equal(created.defaultConnectionId, null);
  assert.equal(created.legacySpaceId, undefined);
  assert.deepEqual(workspaceConnections(next, created.id), []);
  assert.equal(next.activeWorkspaceId, f.registry.activeWorkspaceId);
  assert.equal(f.registry.workspaces.length, 3, "input snapshot is not mutated");
});

test("ambiguous/missing legacy active identity never guesses from cwd, labels or first entry", () => {
  const f = fixture();
  assert.throws(() => bootstrapWorkspaceRegistry(f.legacy, "missing"), /needs confirmation/);
  assert.throws(() => bootstrapWorkspaceRegistry([...f.legacy, f.legacy[0]], "personal"), /invalid legacy/);
});

test("explicit new direct assignment supports multiple keys without reparenting an existing profile", () => {
  const f = fixture();
  let next = addWorkspace(f.registry, "新空間");
  const id = next.workspaces.at(-1).id;
  for (const profileId of ["new-one", "new-two"]) {
    next = attachDirectWorkspaceConnection(next, id, legacyWorkspaceConnection({ id: profileId, kind: "byok", provider: "openai", apiKey: "synthetic-new-key" }));
  }
  assert.equal(workspaceConnections(next, id).length, 2);
  assert.equal(next.workspaces.at(-1).defaultConnectionId, null);
  assert.throws(() => attachDirectWorkspaceConnection(next, id, f.legacy[0]), /unassigned/);
  assert.throws(() => attachDirectWorkspaceConnection(next, id, f.legacy[2]), /unassigned/);
});

test("renderer projections never disclose credential hashes, private profile refs or legacy aliases", () => {
  const f = fixture();
  const text = JSON.stringify({ directory: workspaceDirectory(f.registry), connections: workspaceConnections(f.registry, f.connection("personal").workspaceId) });
  for (const forbidden of ["profileId", "routeFingerprint", "credentialGeneration", "legacySpaceId", "synthetic-direct", "synthetic-managed", "deviceToken", "apiKey"]) {
    assert.equal(text.includes(forbidden), false, forbidden);
  }
  assert.equal(workspaceConnections(f.registry, f.connection("personal").workspaceId).length, 2);
  assert.throws(() => workspaceConnections(f.registry, "missing"), /unavailable/);
});

test("selection and default changes do not alter a frozen run, credential or model", () => {
  const f = fixture();
  const binding = capture(f);
  assert.ok(Object.isFrozen(binding));
  let next = selectWorkspace(f.registry, f.connection("org-b").workspaceId);
  next = setWorkspaceDefault(next, binding.workspaceId, f.connection("second-key").id);
  f.profiles[0].model = "new-default-model";
  f.profiles[0].label = "new label";
  assert.equal(assertWorkspaceRunConnection(next, binding, f.resolve).id, "personal");
  assert.equal(binding.model, "model-one");
  assert.equal(binding.connectionId, f.connection("personal").id);
});

test("foreign Workspace connections cannot become defaults or run bindings", () => {
  const f = fixture();
  const own = f.connection("personal");
  const foreign = f.connection("org-b");
  assert.throws(() => setWorkspaceDefault(f.registry, own.workspaceId, foreign.id), /unavailable/);
  assert.throws(() => captureWorkspaceRunConnection(f.registry, own.workspaceId, foreign.id, "model-one", f.resolve), /unavailable/);
  assert.throws(() => assertWorkspaceRunConnection(f.registry, { ...capture(f), workspaceId: foreign.workspaceId }, f.resolve), /unavailable/);
});

test("revocation clears the default but never picks another key or revives an existing run", () => {
  const f = fixture();
  const binding = capture(f, "second-key");
  const next = revokeWorkspaceConnection(f.registry, binding.workspaceId, binding.connectionId);
  assert.equal(next.workspaces.find((row) => row.id === binding.workspaceId).defaultConnectionId, null);
  assert.throws(() => assertWorkspaceRunConnection(next, binding, f.resolve), /revoked/);
  const restored = reauthorizeWorkspaceConnection(next, binding.workspaceId, binding.connectionId, f.legacy[1]);
  assert.throws(() => assertWorkspaceRunConnection(restored, binding, f.resolve), /revoked/);
  assert.equal(restored.workspaces.find((row) => row.id === binding.workspaceId).defaultConnectionId, null);
});

for (const [field, value] of [["apiKey", "synthetic-rotated"], ["baseURL", "https://changed.invalid/v1"], ["provider", "anthropic"], ["visionApiKey", "synthetic-vision"]]) {
  test(`direct ${field} changes fail closed, with no active-profile fallback`, () => {
    const f = fixture();
    const binding = capture(f);
    f.profiles[0][field] = value;
    assert.throws(() => assertWorkspaceRunConnection(f.registry, binding, f.resolve), /changed/);
  });
}

for (const [field, value] of [["deviceToken", "synthetic-reenrollment"], ["deviceId", "new-device"], ["tenantId", "new-tenant"], ["enrolledAt", "2026-10-14"]]) {
  test(`managed ${field} changes cannot reuse a frozen binding`, () => {
    const f = fixture();
    const binding = capture(f, "org-a");
    f.profiles[2][field] = value;
    assert.throws(() => assertWorkspaceRunConnection(f.registry, binding, f.resolve), /changed/);
  });
}

test("explicit credential rotation invalidates old generations and permits only a fresh binding", () => {
  const f = fixture();
  const old = capture(f);
  f.profiles[0].apiKey = "synthetic-rotated";
  const next = reauthorizeWorkspaceConnection(f.registry, old.workspaceId, old.connectionId, legacyWorkspaceConnection(f.profiles[0]));
  assert.throws(() => assertWorkspaceRunConnection(next, old, f.resolve), /revoked/);
  const fresh = captureWorkspaceRunConnection(next, old.workspaceId, old.connectionId, "new-model", f.resolve);
  assert.equal(assertWorkspaceRunConnection(next, fresh, f.resolve).apiKey, "synthetic-rotated");
  assert.notEqual(fresh.credentialGeneration, old.credentialGeneration);
});

test("reauthorization cannot change managed audience or swap direct/managed connection kinds", () => {
  const f = fixture();
  const row = f.connection("org-a");
  const otherTenant = legacyWorkspaceConnection({ ...f.profiles[2], tenantId: "tenant-b" });
  assert.throws(() => reauthorizeWorkspaceConnection(f.registry, row.workspaceId, row.id, otherTenant), /cannot change/);
  const direct = legacyWorkspaceConnection({ ...f.profiles[2], kind: "byok", provider: "openai" });
  assert.throws(() => reauthorizeWorkspaceConnection(f.registry, row.workspaceId, row.id, direct), /cannot change/);
});

test("deleted, mismatched, expired or malformed managed identities never fall back", () => {
  const f = fixture();
  const binding = capture(f, "org-a");
  assert.throws(() => assertWorkspaceRunConnection(f.registry, binding, () => undefined), /unavailable/);
  assert.throws(() => assertWorkspaceRunConnection(f.registry, binding, () => f.profiles[3]), /unavailable/);
  for (const tokenExpiresAt of ["2020-01-01", "not-a-date", ["2999-01-01"]]) {
    f.profiles[2].tokenExpiresAt = tokenExpiresAt;
    assert.throws(() => assertWorkspaceRunConnection(f.registry, binding, f.resolve), /expired|invalid expiry/);
  }
});

for (const [name, corrupt] of [
  ["future schema", (r) => { r.schemaVersion = 2; }],
  ["foreign default", (r) => { r.workspaces[0].defaultConnectionId = r.connections.at(-1).id; }],
  ["duplicate alias", (r) => { r.workspaces[1].legacySpaceId = r.workspaces[0].legacySpaceId; }],
  ["duplicate profile ownership", (r) => { r.connections[1].profileId = r.connections[0].profileId; }],
  ["credential-bearing field", (r) => { r.connections[0].apiKey = "synthetic-must-not-leak"; }],
  ["hierarchical/tier authority", (r) => { r.workspaces[0].parentWorkspaceId = r.workspaces[1].id; }],
  ["path as Workspace id", (r) => { r.workspaces[0].id = "../../foreign"; }],
]) {
  test(`registry rejects ${name} without echoing private input`, () => {
    const f = fixture();
    corrupt(f.registry);
    assert.throws(() => parseWorkspaceRegistry(f.registry), (error) => /invalid or unsupported/.test(error.message) && !error.message.includes("synthetic"));
  });
}

test("store initialization is explicit, private, repeatable, and leaves legacy bytes untouched", () => {
  const root = home();
  const store = new WorkspaceRegistryStore(root);
  assert.equal(existsSync(join(root, ".hara")), false, "constructor has no filesystem side effects");
  mkdirSync(join(root, ".hara"), { mode: 0o700 });
  const legacyPath = join(root, ".hara", "profiles.json");
  const legacyBytes = "synthetic-legacy-credential-store-must-not-change\n";
  writeFileSync(legacyPath, legacyBytes, { mode: 0o600 });
  const f = fixture();
  const saved = store.initialize(f.legacy, "second-key");
  assert.deepEqual(store.initialize([], null), saved, "no second implicit migration");
  assert.deepEqual(new WorkspaceRegistryStore(root).read(), saved, "opaque ids survive a new store instance");
  assert.equal(readFileSync(legacyPath, "utf8"), legacyBytes);
  assert.equal(readFileSync(join(root, ".hara", "workspaces.json"), "utf8").includes("synthetic-"), false);
  if (process.platform !== "win32") {
    assert.equal(statSync(join(root, ".hara", "workspaces.json")).mode & 0o777, 0o600);
    assert.equal(statSync(join(root, ".hara")).mode & 0o777, 0o700);
  }
});

test("stale dialogs and invalid revisions cannot overwrite newer registry state", () => {
  const store = new WorkspaceRegistryStore(home());
  store.initialize([], null);
  const next = store.update(1, (r) => addWorkspace(r, "second"));
  assert.throws(() => store.update(1, (r) => addWorkspace(r, "stale")), /changed/);
  assert.throws(() => store.update(2, (r) => r), /exactly one/);
  assert.deepEqual(store.read(), next);
});

test("store refuses implicit/relative homes rather than writing metadata into cwd", () => {
  for (const value of [undefined, "", ".", "../other"]) {
    assert.throws(() => new WorkspaceRegistryStore(value), /explicit absolute home/);
  }
});

test("failed mutations and invalid names preserve the last complete registry", () => {
  const store = new WorkspaceRegistryStore(home());
  const initial = store.initialize([], null);
  assert.throws(() => store.update(1, (r) => { r.workspaces[0].label = "not committed"; throw new Error("synthetic failure"); }), /synthetic failure/);
  for (const label of ["", " leading", "name\nwith-control", "長".repeat(81)]) {
    assert.throws(() => store.update(1, (r) => addWorkspace(r, label)), /invalid Workspace/);
  }
  assert.deepEqual(store.read(), initial);
});

test("oversized disk state is bounded and never overwritten by initialization", () => {
  const root = home();
  mkdirSync(join(root, ".hara"), { mode: 0o700 });
  const path = join(root, ".hara", "workspaces.json");
  const oversized = " ".repeat(1024 * 1024 + 1);
  writeFileSync(path, oversized, { mode: 0o600 });
  assert.throws(() => new WorkspaceRegistryStore(root).initialize([], null));
  assert.equal(statSync(path).size, oversized.length);
});

test("filesystem CAS preserves an intervening writer, not a stale mutation", () => {
  const root = home();
  const store = new WorkspaceRegistryStore(root);
  store.initialize([], null);
  const path = join(root, ".hara", "workspaces.json");
  const intervening = JSON.stringify(addWorkspace(store.read(), "intervening")) + "\n";
  assert.throws(() => store.update(1, (r) => {
    writeFileSync(path, intervening, { mode: 0o600 });
    return addWorkspace(r, "stale");
  }), /expected version/);
  assert.equal(readFileSync(path, "utf8"), intervening);
});

test("two real processes cannot both commit the same registry revision", async () => {
  const root = home();
  const store = new WorkspaceRegistryStore(root);
  store.initialize([], null);
  const source = `import {WorkspaceRegistryStore} from ${JSON.stringify(new URL("../dist/workspace/store.js", import.meta.url).href)};
    import {addWorkspace} from ${JSON.stringify(new URL("../dist/workspace/registry.js", import.meta.url).href)};
    try { new WorkspaceRegistryStore(process.argv[1]).update(1, r => addWorkspace(r, process.argv[2])); process.stdout.write('committed'); }
    catch(e) { if (/registry changed/.test(e.message)) process.stdout.write('stale'); else throw e; }`;
  const exec = promisify(execFile);
  const results = await Promise.all(["child-one", "child-two"].map((label) => exec(process.execPath, ["--input-type=module", "-e", source, root, label], { timeout: 15000, maxBuffer: 4096 })));
  assert.deepEqual(results.map((row) => row.stdout).sort(), ["committed", "stale"]);
  assert.equal(store.read().workspaces.length, 2);
});

for (const bad of ["{invalid", JSON.stringify({ schemaVersion: 999, apiKey: "synthetic-private" })]) {
  test("corrupt/future disk state is preserved, never replaced by a first-run migration", () => {
    const root = home();
    mkdirSync(join(root, ".hara"), { mode: 0o700 });
    const path = join(root, ".hara", "workspaces.json");
    writeFileSync(path, bad, { mode: 0o600 });
    assert.throws(() => new WorkspaceRegistryStore(root).initialize([], null), /refusing|unsupported/);
    assert.equal(readFileSync(path, "utf8"), bad);
  });
}

test("symlink and hardlink preseeded registry files are refused without changing their targets", { skip: process.platform === "win32" }, () => {
  for (const kind of ["symbolic", "hard"]) {
    const root = home();
    mkdirSync(join(root, ".hara"), { mode: 0o700 });
    const target = join(root, "target.json");
    writeFileSync(target, "synthetic-target-do-not-change", { mode: 0o600 });
    const path = join(root, ".hara", "workspaces.json");
    if (kind === "symbolic") symlinkSync(target, path); else linkSync(target, path);
    assert.throws(() => new WorkspaceRegistryStore(root).initialize([], null));
    assert.equal(readFileSync(target, "utf8"), "synthetic-target-do-not-change");
  }
});

test("provider guard preserves existing policy preflight, capabilities, arguments and results", async () => {
  const f = fixture();
  const events = [];
  const inner = {
    id: "test", model: "model-one", supportsToolImages: true, trailingTurnContext: true,
    connection: { synthetic: true },
    async prepareTurn(history, signal) { events.push(["prepare", history, signal]); return { organizationPolicyVersion: 7 }; },
    async turn(args) { assert.equal(args.organizationPolicyVersion, 7); events.push(["turn", args]); return { text: "done", toolUses: [], stop: "end" }; },
  };
  const provider = bindWorkspaceProvider(inner, capture(f), () => f.registry, f.resolve);
  const history = [];
  assert.deepEqual(await provider.prepareTurn(history), { organizationPolicyVersion: 7 });
  const args = { history, system: "test", tools: [], onText() {}, organizationPolicyVersion: 7 };
  assert.equal((await provider.turn(args)).text, "done");
  assert.equal(events[1][1], args);
  assert.equal(provider.connection, inner.connection);
  assert.equal(provider.supportsToolImages, true);
});

test("provider guard checks revocation before and after every preflight/request with no replay", async () => {
  for (const phase of ["before", "prepare", "turn", "registry-unavailable"]) {
    const f = fixture();
    const binding = capture(f);
    let current = f.registry;
    let calls = 0;
    let unavailable = false;
    const revoke = () => { current = revokeWorkspaceConnection(current, binding.workspaceId, binding.connectionId); };
    const provider = bindWorkspaceProvider({
      id: "test", model: "model-one",
      async prepareTurn() { if (phase === "prepare") revoke(); },
      async turn() { calls++; if (phase === "turn") revoke(); return { text: "accepted", stop: "end", toolUses: [] }; },
    }, binding, () => { if (unavailable) throw new Error("registry unavailable"); return current; }, f.resolve);
    if (phase === "before") revoke();
    if (phase === "registry-unavailable") unavailable = true;
    if (phase === "prepare") await assert.rejects(provider.prepareTurn([]), /revoked/);
    else await assert.rejects(provider.turn({ history: [], system: "", tools: [], onText() {} }), /revoked|unavailable/);
    assert.equal(calls, phase === "turn" ? 1 : 0);
  }
});

test("guard owns a binding copy and rejects a provider model changed after construction", async () => {
  const f = fixture();
  const mutable = { ...capture(f) };
  let calls = 0;
  const inner = { id: "test", model: "model-one", async turn() { calls++; return { text: "ok", stop: "end", toolUses: [] }; } };
  const provider = bindWorkspaceProvider(inner, mutable, () => f.registry, f.resolve);
  mutable.workspaceId = f.connection("org-b").workspaceId;
  assert.equal((await provider.turn({ history: [], system: "", tools: [], onText() {} })).text, "ok");
  inner.model = "unapproved-model";
  await assert.rejects(provider.turn({ history: [], system: "", tools: [], onText() {} }), /model does not match/);
  assert.equal(calls, 1);
});

test("Workspace wrapping does not swallow or retry an existing provider's authorization rejection", async () => {
  const f = fixture();
  let calls = 0;
  const provider = bindWorkspaceProvider({
    id: "test", model: "model-one",
    async prepareTurn() { throw new Error("existing Control policy denied"); },
    async turn() { calls++; throw new Error("existing Control policy denied"); },
  }, capture(f), () => f.registry, f.resolve);
  await assert.rejects(provider.prepareTurn([]), /existing Control policy denied/);
  await assert.rejects(provider.turn({ history: [], system: "", tools: [], onText() {} }), /existing Control policy denied/);
  assert.equal(calls, 1);
});

test("fingerprints exclude mutable defaults/catalogs but include credential and route boundaries", () => {
  const f = fixture();
  const first = workspaceRouteFingerprint(f.profiles[0]);
  assert.equal(workspaceRouteFingerprint({ ...f.profiles[0], model: "other", defaultModel: "another", reasoningEffort: "high", availableModels: ["new"] }), first);
  assert.notEqual(workspaceRouteFingerprint({ ...f.profiles[0], apiKey: "synthetic-new" }), first);
});
