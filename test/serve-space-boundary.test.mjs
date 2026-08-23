import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { orgRolesDir } from "../dist/org/roles.js";
import { startServe } from "../dist/serve/server.js";

function connect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const pending = new Map();
    let nextId = 1;
    ws.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      const settle = pending.get(message.id);
      if (!settle) return;
      pending.delete(message.id);
      settle(message);
    });
    ws.on("open", () => resolve({
      call(method, params = {}) {
        return new Promise((settle) => {
          const id = nextId++;
          pending.set(id, settle);
          ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
        });
      },
      close: () => ws.close(),
    }));
    ws.on("error", reject);
  });
}

function memoryStore() {
  const saved = new Map();
  return {
    load: (id) => saved.get(id) ?? null,
    save: (meta, history, task) => saved.set(meta.id, {
      meta: { ...meta },
      history: structuredClone(history),
      ...(task ? { task: structuredClone(task) } : {}),
    }),
    list: () => [...saved.values()].map((entry) => entry.meta),
    acquire: () => ({ ok: true }),
    release: () => {},
    delete: (id) => saved.delete(id),
  };
}

test("serve isolates Personal and company Spaces and freezes the session audience", async () => {
  const root = mkdtempSync(join(tmpdir(), "hara-serve-spaces-"));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  const haraHome = join(home, ".hara");
  const previousHome = process.env.HOME;
  let handle;
  let client;
  let activeProfile = "personal";
  let activeSpace = "personal";
  let providerTurns = 0;
  try {
    process.env.HOME = home;
    mkdirSync(workspace, { recursive: true });
    mkdirSync(join(haraHome, "roles"), { recursive: true, mode: 0o700 });
    chmodSync(haraHome, 0o700);
    writeFileSync(join(haraHome, "config.json"), JSON.stringify({ provider: "openai", model: "fake" }), { mode: 0o600 });
    writeFileSync(join(haraHome, "profiles.json"), JSON.stringify({
      active: "personal",
      profiles: [
        { id: "personal", kind: "byok", label: "Personal", provider: "openai", defaultModel: "fake" },
        { id: "acme", kind: "gateway", label: "Acme local alias", tenantId: "tenant-acme", tenantName: "Acme", gatewayUrl: "https://control.example.test", deviceToken: "redacted-test-token", defaultModel: "fake" },
      ],
    }), { mode: 0o600 });
    writeFileSync(join(haraHome, "roles", "personal-helper.md"), [
      "---", "name: personal-helper", "description: Personal only", "---", "PERSONAL PRIVATE PERSONA", "",
    ].join("\n"));
    const managed = orgRolesDir("acme");
    mkdirSync(managed, { recursive: true, mode: 0o700 });
    writeFileSync(join(managed, "company-analyst.md"), [
      "---", "name: company-analyst", "description: Company managed", "display-name: Acme Analyst", "---", "COMPANY PERSONA", "",
    ].join("\n"));
    writeFileSync(join(managed, "_bundle.json"), JSON.stringify({
      version: 1,
      org_policy: {},
      roles: [{
        name: "company-analyst",
        description: "Company managed",
        system: "COMPANY PERSONA",
      }],
    }));

    const directory = () => ({
      activeId: activeSpace,
      activeProfileId: activeProfile,
      activeSource: "default",
      switchLocked: false,
      spaces: [
        { id: "personal", name: "Personal", kind: "personal", profileId: "personal", active: activeSpace === "personal", authoritative: true, agentProfilePermission: "edit" },
        { id: "org:tenant-acme", name: "Acme", kind: "organization", profileId: "acme", active: activeSpace === "org:tenant-acme", tenantId: "tenant-acme", authoritative: true, agentProfilePermission: "view" },
      ],
    });
    const provider = {
      id: "fake",
      model: "fake",
      async prepareTurn() { return { organizationPolicyVersion: 1 }; },
      async turn({ onText }) { providerTurns += 1; onText("ok"); return { text: "ok", toolUses: [], stop: "end", usage: { input: 1, output: 1 } }; },
    };
    handle = await startServe({ host: "127.0.0.1", port: 0, token: "space-token", cwd: workspace }, {
      version: "0.0.0-test",
      providerId: "fake",
      model: "fake",
      buildSessionProvider: async () => provider,
      buildProviderFor: async () => provider,
      runtimeInfo: (_cwd, model, requestedProfile) => {
        const profileId = requestedProfile ?? activeProfile;
        const spaceId = profileId === "acme" ? activeSpace : "personal";
        return { providerId: "fake", model: model ?? "fake", profileId, profileKind: profileId === "acme" ? "gateway" : "byok", spaceId, effortLevels: [] };
      },
      spaces: () => directory(),
      useSpace: (spaceId) => {
        activeSpace = spaceId;
        activeProfile = spaceId === "personal" ? "personal" : "acme";
        return directory();
      },
      spawnSubagent: async () => "disabled",
      sandbox: "off",
      approval: "full-auto",
      store: memoryStore(),
      quietDiscovery: true,
    });
    client = await connect(handle.port);
    const initialized = await client.call("initialize", { token: "space-token" });
    assert.ok(initialized.result.capabilities.methods.includes("spaces.list"));

    const personalCatalog = await client.call("agents.list", { cwd: workspace });
    assert.ok(personalCatalog.result.agents.some((agent) => agent.ref === "global:personal-helper"));
    assert.ok(!personalCatalog.result.agents.some((agent) => agent.ref === "global:company-analyst"));

    const switched = await client.call("spaces.use", { spaceId: "org:tenant-acme", cwd: workspace });
    assert.equal(switched.result.activeId, "org:tenant-acme");
    const companyCatalog = await client.call("agents.list", { cwd: workspace });
    assert.ok(companyCatalog.result.agents.some((agent) => agent.ref === "global:company-analyst"));
    assert.ok(!companyCatalog.result.agents.some((agent) => agent.ref === "global:personal-helper"));
    const companyAgent = companyCatalog.result.agents.find((agent) => agent.ref === "global:company-analyst");
    assert.equal(companyAgent.owner, "organization");
    assert.deepEqual(companyAgent.allowedActions, ["chat"]);

    const deniedEdit = await client.call("agents.update-profile", {
      ref: "global:company-analyst",
      expectedRevision: "0".repeat(32),
      cwd: workspace,
      profile: { displayName: "Unauthorized" },
    });
    assert.equal(deniedEdit.error.code, -32001);

    const created = await client.call("session.create", { cwd: workspace, agentRef: "global:company-analyst" });
    assert.equal(created.result.profileId, "acme");
    assert.equal(created.result.spaceId, "org:tenant-acme");
    const firstTurn = await client.call("session.send", { sessionId: created.result.sessionId, text: "company context" });
    assert.equal(firstTurn.result.reply, "ok");
    assert.equal(providerTurns, 1);

    // Simulate re-enrolling the same local connection into a different Control tenant. The old session
    // remains locally readable, but every live inference/configuration path must refuse the replacement.
    activeSpace = "org:tenant-other";
    const refusedSend = await client.call("session.send", { sessionId: created.result.sessionId, text: "do not disclose" });
    assert.equal(refusedSend.error.code, -32001);
    assert.match(refusedSend.error.message, /belongs to Space|across companies/i);
    const refusedSubmit = await client.call("session.submit", { sessionId: created.result.sessionId, text: "do not disclose either" });
    assert.equal(refusedSubmit.error.code, -32001);
    const refusedCompact = await client.call("session.compact", { sessionId: created.result.sessionId });
    assert.equal(refusedCompact.error.code, -32001);
    const refusedModel = await client.call("session.set-model", { sessionId: created.result.sessionId, model: "fake" });
    assert.equal(refusedModel.error.code, -32001);
    const refusedFork = await client.call("session.fork", { sessionId: created.result.sessionId });
    assert.equal(refusedFork.error.code, -32001);
    const refused = await client.call("session.resume", { sessionId: created.result.sessionId });
    assert.equal(refused.error.code, -32001);
    assert.match(refused.error.message, /belongs to Space|across companies/i);
    assert.equal(providerTurns, 1, "no provider turn may run after the profile moves to another Space");
    const history = await client.call("session.history", { sessionId: created.result.sessionId });
    assert.equal(history.result.spaceId, "org:tenant-acme");
  } finally {
    client?.close();
    if (handle) await handle.close();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test("serve keeps unverifiable legacy organization history read-only and defaults custom routes closed", async () => {
  const root = mkdtempSync(join(tmpdir(), "hara-serve-legacy-space-"));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  const previousHome = process.env.HOME;
  const store = memoryStore();
  const legacyId = "00000000-0000-4000-8000-000000000152";
  let handle;
  let client;
  let providerTurns = 0;
  let currentKind = "gateway";
  try {
    process.env.HOME = home;
    mkdirSync(join(home, ".hara"), { recursive: true, mode: 0o700 });
    mkdirSync(workspace, { recursive: true });
    store.save({
      id: legacyId,
      cwd: workspace,
      profileId: "acme",
      provider: "fake",
      model: "fake",
      title: "Legacy company conversation",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      source: "interactive",
    }, [{ role: "user", content: "tenant A private history" }]);
    const provider = {
      id: "fake",
      model: "fake",
      async turn({ onText }) {
        providerTurns += 1;
        onText("unexpected");
        return { text: "unexpected", toolUses: [], stop: "end", usage: { input: 1, output: 1 } };
      },
    };
    handle = await startServe({ host: "127.0.0.1", port: 0, token: "legacy-space-token", cwd: workspace }, {
      version: "0.0.0-test",
      providerId: "fake",
      model: "fake",
      buildSessionProvider: async () => provider,
      buildProviderFor: async () => provider,
      // Simulate an older/custom embedder that identifies a company profile but omits Space metadata.
      runtimeInfo: (_cwd, model, requestedProfile) => ({
        providerId: "fake",
        model: model ?? "fake",
        profileId: requestedProfile ?? "acme",
        profileKind: currentKind,
        ...(currentKind === "byok" ? { spaceId: "personal" } : {}),
        effortLevels: [],
      }),
      spawnSubagent: async () => "disabled",
      sandbox: "off",
      approval: "full-auto",
      store,
      quietDiscovery: true,
    });
    client = await connect(handle.port);
    await client.call("initialize", { token: "legacy-space-token" });

    const refused = await client.call("session.resume", { sessionId: legacyId });
    assert.equal(refused.error.code, -32001);
    assert.match(refused.error.message, /legacy organization session|read-only/i);
    const replay = await client.call("session.history", { sessionId: legacyId });
    assert.equal(replay.result.history[0].text, "tenant A private history");
    assert.equal(replay.result.spaceId, undefined);
    assert.equal(store.load(legacyId).meta.spaceId, undefined, "resume must not stamp the current company onto legacy history");
    assert.equal(providerTurns, 0);

    const deniedHire = await client.call("agents.create", {
      cwd: workspace,
      id: "unsafe-hire",
      profile: { displayName: "Unsafe" },
    });
    assert.equal(deniedHire.error.code, -32001);
    const fresh = await client.call("session.create", { cwd: workspace });
    assert.equal(fresh.result.profileId, "acme");
    assert.equal(fresh.result.spaceId, "org-profile:acme");

    // Deleting the old company route and recreating the same local id as BYOK is not evidence that the
    // old transcript was Personal. It must remain frozen instead of being stamped `personal`.
    currentKind = "byok";
    const refusedAfterRetype = await client.call("session.resume", { sessionId: legacyId });
    assert.equal(refusedAfterRetype.error.code, -32001);
    assert.match(refusedAfterRetype.error.message, /legacy organization session|read-only/i);
    assert.equal(store.load(legacyId).meta.spaceId, undefined);
    assert.equal(providerTurns, 0);
  } finally {
    client?.close();
    if (handle) await handle.close();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});
