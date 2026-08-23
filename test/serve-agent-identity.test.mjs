import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
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
    saved,
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

test("serve persists Agent identity, lists offices, and runs the selected persona", async () => {
  const root = mkdtempSync(join(tmpdir(), "hara-serve-agent-"));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  const secondWorkspace = join(root, "second-workspace");
  const looseWorkspace = join(root, "loose-workspace");
  const roles = join(home, ".hara", "roles");
  const previousHome = process.env.HOME;
  const observedSystems = [];
  let handle;
  let client;
  try {
    process.env.HOME = home;
    mkdirSync(workspace, { recursive: true });
    mkdirSync(secondWorkspace, { recursive: true });
    mkdirSync(looseWorkspace, { recursive: true });
    mkdirSync(roles, { recursive: true });
    writeFileSync(join(roles, "architect.md"), [
      "---",
      "name: architect",
      "description: Designs reliable systems",
      "display-name: Ada",
      "role: Systems Architect",
      "vibe: Calm, rigorous, and evidence-led",
      "traits: [calm, rigorous]",
      "emoji: ◇",
      "accent: #4f9c8f",
      "character: architect",
      "model: fake-role",
      "---",
      "YOU ARE THE ARCHITECT PERSONA",
      "",
    ].join("\n"));
    mkdirSync(join(workspace, ".hara", "roles"), { recursive: true });
    writeFileSync(join(workspace, ".hara", "roles", "coder.md"), [
      "---",
      "name: coder",
      "description: Owns implementation",
      "model: fake-coder",
      "---",
      "YOU ARE THE CODER PERSONA",
      "",
    ].join("\n"));
    mkdirSync(join(secondWorkspace, ".hara", "roles"), { recursive: true });
    writeFileSync(join(secondWorkspace, ".hara", "roles", "designer.md"), [
      "---",
      "name: designer",
      "description: Owns product design",
      "---",
      "YOU ARE THE DESIGNER PERSONA",
      "",
    ].join("\n"));
    writeFileSync(join(home, ".hara", "projects.json"), JSON.stringify({
      projects: [
        { name: "alpha", path: workspace },
        { name: "beta", path: secondWorkspace },
      ],
    }));

    const providerFor = (model) => ({
      id: "fake",
      model,
      async turn({ system, onText }) {
        observedSystems.push(system);
        onText("done");
        return { text: "done", toolUses: [], stop: "end", usage: { input: 2, output: 1 } };
      },
    });
    const store = memoryStore();
    handle = await startServe(
      { host: "127.0.0.1", port: 0, token: "agent-test-token", cwd: workspace },
      {
        version: "0.0.0-test",
        providerId: "fake",
        model: "fake-main",
        buildSessionProvider: async () => providerFor("fake-main"),
        buildProviderFor: async (model) => providerFor(model),
        runtimeInfo: (_cwd, model) => ({
          providerId: "fake",
          model: model ?? "fake-main",
          profileId: "personal",
          spaceId: "personal",
          effortLevels: [],
        }),
        spawnSubagent: async () => "disabled",
        sandbox: "off",
        approval: "full-auto",
        store,
        quietDiscovery: true,
      },
    );
    client = await connect(handle.port);
    const initialized = await client.call("initialize", { token: "agent-test-token" });
    assert.ok(initialized.result.capabilities.methods.includes("agents.list"));
    assert.ok(initialized.result.capabilities.methods.includes("agents.update-profile"));

    const catalog = await client.call("agents.list", { cwd: workspace });
    assert.ok(catalog.result.agents.some((agent) => agent.ref === "main"));
    assert.ok(catalog.result.agents.some((agent) => agent.ref === "global:architect"));
    assert.ok(catalog.result.agents.some((agent) => agent.ref === "alpha:coder"));
    assert.ok(catalog.result.agents.some((agent) => agent.ref === "beta:designer"));
    assert.ok(catalog.result.offices.some((office) => office.id === "global"));
    assert.equal(catalog.result.currentOfficeId, "project:alpha");
    const architectIdentity = catalog.result.agents.find((agent) => agent.ref === "global:architect").identity;
    assert.equal(architectIdentity.displayName, "Ada");
    assert.equal(architectIdentity.title, "Systems Architect");
    assert.deepEqual(architectIdentity.traits, ["calm", "rigorous"]);
    assert.equal(architectIdentity.emoji, "◇");
    assert.equal(architectIdentity.accent, "#4f9c8f");
    assert.equal(architectIdentity.character, "architect");
    const architect = catalog.result.agents.find((agent) => agent.ref === "global:architect");
    assert.equal(architect.spaceId, "personal");
    assert.equal(architect.owner, "personal");
    assert.deepEqual(architect.allowedActions, ["chat", "edit_profile", "archive"]);
    assert.match(architect.revision, /^[a-f0-9]{32}$/);
    assert.doesNotMatch(JSON.stringify(catalog.result.agents), /YOU ARE THE ARCHITECT PERSONA/);
    assert.deepEqual(
      catalog.result.offices.find((office) => office.id === "project:alpha").agentRefs,
      ["main", "alpha:coder", "global:architect"],
    );

    const updatedProfile = await client.call("agents.update-profile", {
      ref: "global:architect",
      expectedRevision: architect.revision,
      cwd: workspace,
      profile: {
        displayName: "Ada Lin",
        title: "Principal Systems Architect",
        bio: "Designs calm, reliable systems.",
        traits: ["calm", "rigorous", "kind"],
        emoji: "◇",
        theme: "quiet systems studio",
        accent: "#4f9c8f",
        character: "architect",
      },
    });
    assert.equal(updatedProfile.result.agent.identity.displayName, "Ada Lin");
    assert.notEqual(updatedProfile.result.agent.revision, architect.revision);
    const updatedRoleText = readFileSync(join(roles, "architect.md"), "utf8");
    assert.match(updatedRoleText, /display-name: "Ada Lin"/);
    assert.match(updatedRoleText, /YOU ARE THE ARCHITECT PERSONA/);
    const staleUpdate = await client.call("agents.update-profile", {
      ref: "global:architect",
      expectedRevision: architect.revision,
      cwd: workspace,
      profile: { displayName: "Stale overwrite" },
    });
    assert.equal(staleUpdate.error.code, -32005);

    const hired = await client.call("agents.create", {
      id: "product-designer",
      cwd: workspace,
      description: "Owns product experience",
      instructions: "PRIVATE PRODUCT DESIGNER BRIEF",
      profile: {
        displayName: "Mina",
        title: "Product Designer",
        bio: "Owns product experience",
        traits: ["curious", "meticulous"],
        emoji: "✎",
        accent: "#4f9c8f",
        character: "designer",
      },
    });
    assert.ok(hired.result, `Agent hire failed: ${JSON.stringify(hired.error)}`);
    assert.ok(hired.result.agent, `newly hired Agent missing from catalog: ${JSON.stringify(hired.result.catalog)}`);
    assert.equal(hired.result.agent.ref, "global:product-designer");
    assert.doesNotMatch(JSON.stringify(hired.result.catalog), /PRIVATE PRODUCT DESIGNER BRIEF/);
    const hiredFile = join(roles, "product-designer.md");
    assert.match(readFileSync(hiredFile, "utf8"), /PRIVATE PRODUCT DESIGNER BRIEF/);
    const dismissed = await client.call("agents.archive", {
      ref: "global:product-designer",
      expectedRevision: hired.result.agent.revision,
      cwd: workspace,
    });
    assert.equal(dismissed.result.archived, true);
    assert.ok(!dismissed.result.catalog.agents.some((agent) => agent.ref === "global:product-designer"));
    assert.match(readFileSync(hiredFile, "utf8"), /^archived: true$/m);
    assert.deepEqual(
      catalog.result.offices.find((office) => office.id === "project:beta").agentRefs,
      ["main", "beta:designer", "global:architect"],
    );

    const looseCatalog = await client.call("agents.list", { cwd: looseWorkspace });
    assert.equal(looseCatalog.result.currentOfficeId, "workspace");
    assert.deepEqual(
      looseCatalog.result.offices.find((office) => office.id === "workspace").agentRefs,
      ["main", "global:architect"],
    );

    const created = await client.call("session.create", {
      cwd: workspace,
      agentRef: "global:architect",
    });
    assert.equal(created.result.agentRef, "global:architect");
    assert.equal(created.result.spaceId, "personal");
    assert.equal(created.result.model, "fake-role");
    const sessionId = created.result.sessionId;
    const sent = await client.call("session.send", { sessionId, text: "hello" });
    assert.equal(sent.result.reply, "done");
    assert.match(observedSystems[0], /YOU ARE THE ARCHITECT PERSONA/);

    const listed = await client.call("session.list", {});
    assert.equal(listed.result.sessions.find((session) => session.id === sessionId).agentRef, "global:architect");
    assert.equal(listed.result.sessions.find((session) => session.id === sessionId).spaceId, "personal");
    const resumed = await client.call("session.resume", { sessionId });
    assert.equal(resumed.result.agentRef, "global:architect");

    const designer = await client.call("session.create", {
      cwd: workspace,
      agentRef: "beta:designer",
    });
    const afterDesigner = await client.call("session.list", {});
    assert.equal(
      afterDesigner.result.sessions.find((session) => session.id === designer.result.sessionId).cwd,
      realpathSync.native(secondWorkspace),
    );

    const main = await client.call("session.create", { cwd: workspace, agentRef: "main" });
    assert.notEqual(main.result.sessionId, sessionId);
    assert.equal(main.result.agentRef, undefined);
    const missing = await client.call("session.create", { cwd: workspace, agentRef: "global:missing" });
    assert.equal(missing.error.code, -32602);
  } finally {
    client?.close();
    if (handle) await handle.close();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});
