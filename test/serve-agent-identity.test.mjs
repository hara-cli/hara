import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

    const hireInput = {
      id: "product-designer",
      cwd: workspace,
      description: "Owns product experience",
      instructions: "PRIVATE PRODUCT DESIGNER BRIEF",
      blueprint: {
        id: "agency-agents/design/ui-designer",
        version: "1.0.0",
        publisher: "Hara curated",
        source: "https://github.com/msitarzewski/agency-agents/blob/ebe9c99/design/design-ui-designer.md",
        sourceRevision: "ebe9c99",
        license: "MIT",
      },
      profile: {
        displayName: "Mina",
        title: "Product Designer",
        bio: "Owns product experience",
        traits: ["curious", "meticulous"],
        emoji: "✎",
        accent: "#4f9c8f",
        character: "designer",
      },
    };
    const hired = await client.call("agents.create", hireInput);
    assert.ok(hired.result, `Agent hire failed: ${JSON.stringify(hired.error)}`);
    assert.ok(hired.result.agent, `newly hired Agent missing from catalog: ${JSON.stringify(hired.result.catalog)}`);
    assert.equal(hired.result.agent.ref, "global:product-designer");
    assert.equal(hired.result.agent.blueprint.id, "agency-agents/design/ui-designer");
    assert.equal(hired.result.agent.blueprint.version, "1.0.0");
    assert.equal(hired.result.agent.blueprint.sourceRevision, "ebe9c99");
    assert.match(hired.result.agent.blueprint.digest, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(hired.result.catalog), /PRIVATE PRODUCT DESIGNER BRIEF/);
    const hiredFile = join(roles, "product-designer.md");
    const hiredText = readFileSync(hiredFile, "utf8");
    assert.match(hiredText, /PRIVATE PRODUCT DESIGNER BRIEF/);
    assert.match(hiredText, /^blueprint-id: "agency-agents\/design\/ui-designer"$/m);
    assert.match(hiredText, /^blueprint-license: "MIT"$/m);
    assert.match(hiredText, /^blueprint-digest: "[a-f0-9]{64}"$/m);
    writeFileSync(hiredFile, hiredText.replace("PRIVATE PRODUCT DESIGNER BRIEF", "LOCALLY MODIFIED BRIEF"), { mode: 0o600 });
    const modifiedCatalog = await client.call("agents.list", { cwd: workspace });
    assert.equal(
      modifiedCatalog.result.agents.find((agent) => agent.ref === "global:product-designer").blueprint,
      undefined,
      "a locally modified prompt must not retain verified blueprint provenance",
    );
    writeFileSync(hiredFile, hiredText, { mode: 0o600 });
    const rejectedBlueprint = await client.call("agents.create", {
      id: "untrusted-blueprint",
      cwd: workspace,
      instructions: "must not be installed",
      blueprint: {
        id: "agency-agents/design/untrusted",
        version: "1.0.0",
        publisher: "Untrusted",
        source: "http://user:secret@example.test/agent.md",
        sourceRevision: "bad-source",
        license: "MIT",
      },
      profile: { displayName: "Untrusted" },
    });
    assert.equal(rejectedBlueprint.error.code, -32602);
    assert.ok(!existsSync(join(roles, "untrusted-blueprint.md")));
    const rejectedQueryBlueprint = await client.call("agents.create", {
      id: "query-secret-blueprint",
      cwd: workspace,
      instructions: "must not be installed",
      blueprint: {
        id: "agency-agents/design/query-secret",
        version: "1.0.0",
        publisher: "Untrusted",
        source: "https://example.test/agent.md?api_key=must-not-persist",
        sourceRevision: "bad-query-source",
        license: "MIT",
      },
      profile: { displayName: "Query Secret" },
    });
    assert.equal(rejectedQueryBlueprint.error.code, -32602);
    assert.ok(!existsSync(join(roles, "query-secret-blueprint.md")));
    // A lower-priority Claude Code role with the same username must not spring back into Hara after the
    // native employee leaves. Hara's roster tombstone hides the qualified identity without changing
    // either source prompt, and an explicit market hire restores the same employee recoverably.
    const claudeRoles = join(home, ".claude", "agents");
    mkdirSync(claudeRoles, { recursive: true });
    const shadowFile = join(claudeRoles, "product-designer.md");
    const shadowText = [
      "---",
      "name: product-designer",
      "description: Claude-owned product designer",
      "---",
      "CLAUDE SOURCE MUST REMAIN UNCHANGED",
      "",
    ].join("\n");
    writeFileSync(shadowFile, shadowText, { mode: 0o600 });
    const hiredTextBeforeDismissal = readFileSync(hiredFile, "utf8");
    const dismissed = await client.call("agents.archive", {
      ref: "global:product-designer",
      expectedRevision: hired.result.agent.revision,
      cwd: workspace,
    });
    assert.equal(dismissed.result.archived, true);
    assert.ok(!dismissed.result.catalog.agents.some((agent) => agent.ref === "global:product-designer"));
    assert.ok(dismissed.result.catalog.dismissedAgentRefs.includes("global:product-designer"));
    assert.equal(readFileSync(hiredFile, "utf8"), hiredTextBeforeDismissal);
    assert.equal(readFileSync(shadowFile, "utf8"), shadowText);

    const externalFile = join(claudeRoles, "external-auditor.md");
    const externalText = [
      "---",
      "name: external-auditor",
      "description: Claude-owned audit role",
      "---",
      "EXTERNAL PRIVATE PROMPT",
      "",
    ].join("\n");
    writeFileSync(externalFile, externalText, { mode: 0o600 });
    const externalCatalog = await client.call("agents.list", { cwd: workspace });
    const external = externalCatalog.result.agents.find((agent) => agent.ref === "global:external-auditor");
    assert.equal(external.owner, "external");
    assert.deepEqual(external.allowedActions, ["chat", "archive"]);
    assert.match(external.revision, /^[a-f0-9]{32}$/);
    const externalSession = await client.call("session.create", {
      cwd: workspace,
      agentRef: external.ref,
    });
    await client.call("session.send", { sessionId: externalSession.result.sessionId, text: "audit this" });
    const externalDismissed = await client.call("agents.archive", {
      ref: external.ref,
      expectedRevision: external.revision,
      cwd: workspace,
    });
    assert.ok(!externalDismissed.result.catalog.agents.some((agent) => agent.ref === external.ref));
    assert.ok(externalDismissed.result.catalog.dismissedAgentRefs.includes(external.ref));
    assert.equal(readFileSync(externalFile, "utf8"), externalText);
    const preservedExternalHistory = await client.call("session.history", { sessionId: externalSession.result.sessionId });
    assert.equal(preservedExternalHistory.result.agentRef, external.ref);
    assert.ok(preservedExternalHistory.result.history.length >= 2);
    const blockedExternalTurn = await client.call("session.submit", {
      sessionId: externalSession.result.sessionId,
      text: "more work",
    });
    assert.equal(blockedExternalTurn.error.code, -32602);
    assert.match(blockedExternalTurn.error.message, /left the active staff directory/);

    const rehired = await client.call("agents.create", hireInput);
    assert.equal(rehired.result.restored, true);
    assert.equal(rehired.result.agent.ref, "global:product-designer");
    assert.ok(!rehired.result.catalog.dismissedAgentRefs.includes("global:product-designer"));
    assert.equal(readFileSync(hiredFile, "utf8"), hiredTextBeforeDismissal);
    assert.equal(readFileSync(shadowFile, "utf8"), shadowText);
    assert.deepEqual(
      catalog.result.offices.find((office) => office.id === "project:beta").agentRefs,
      ["main", "beta:designer", "global:architect"],
    );

    const looseCatalog = await client.call("agents.list", { cwd: looseWorkspace });
    assert.equal(looseCatalog.result.currentOfficeId, "workspace");
    assert.deepEqual(
      looseCatalog.result.offices.find((office) => office.id === "workspace").agentRefs,
      ["main", "global:architect", "global:product-designer"],
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
    assert.ok(observedSystems.some((system) => /YOU ARE THE ARCHITECT PERSONA/.test(system)));
    assert.ok(observedSystems.some((system) => /EXTERNAL PRIVATE PROMPT/.test(system)));

    const listed = await client.call("session.list", {});
    assert.equal(listed.result.sessions.find((session) => session.id === sessionId).agentRef, "global:architect");
    assert.equal(listed.result.sessions.find((session) => session.id === sessionId).spaceId, "personal");
    const resumed = await client.call("session.resume", { sessionId });
    assert.equal(resumed.result.agentRef, "global:architect");

    const designer = await client.call("session.create", {
      cwd: workspace,
      agentRef: "beta:designer",
    });
    const beforeDesignerTurn = await client.call("session.list", {});
    assert.ok(
      !beforeDesignerTurn.result.sessions.some((session) => session.id === designer.result.sessionId),
      "an untouched Agent draft must not create an empty history row",
    );
    const designerSent = await client.call("session.send", {
      sessionId: designer.result.sessionId,
      text: "review the experience",
    });
    assert.equal(designerSent.result.reply, "done");
    assert.match(observedSystems.at(-1), /YOU ARE THE DESIGNER PERSONA/);
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
