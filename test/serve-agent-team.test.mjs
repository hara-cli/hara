import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { startServe } from "../dist/serve/server.js";

const memStore = () => {
  const files = new Map();
  return {
    load: (id) => files.get(id) ?? null,
    save: (meta, history, task) => files.set(meta.id, {
      meta: { ...meta },
      history: structuredClone(history),
      ...(task ? { task: structuredClone(task) } : {}),
    }),
    list: () => [...files.values()].map((entry) => entry.meta),
    acquire: () => ({ ok: true }),
    release: () => {},
    delete: (id) => files.delete(id),
  };
};

function connect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket("ws://127.0.0.1:" + String(port));
    const pending = new Map();
    const events = [];
    let nextId = 1;
    ws.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      if (message.id !== undefined && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      } else if (message.method) {
        events.push(message);
      }
    });
    ws.on("open", () => resolve({
      ws,
      events,
      call(method, params = {}) {
        return new Promise((done) => {
          const id = nextId++;
          pending.set(id, done);
          ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
        });
      },
    }));
    ws.on("error", reject);
  });
}

const rootProvider = () => {
  let round = 0;
  return {
    id: "fake",
    model: "fake-1",
    async turn({ onText }) {
      round += 1;
      if (round === 1) {
        return {
          text: "",
          toolUses: [{
            id: "spawn-1",
            name: "spawn_agent",
            input: { task_name: "research", message: "Inspect the durable runtime" },
          }],
          stop: "tool_use",
          usage: { input: 1, output: 1 },
        };
      }
      if (round === 2) {
        return {
          text: "",
          toolUses: [{
            id: "wait-1",
            name: "wait_agent",
            input: { target: "/root/research", timeout_ms: 1_000 },
          }],
          stop: "tool_use",
          usage: { input: 1, output: 1 },
        };
      }
      onText("delegation complete");
      return {
        text: "delegation complete",
        toolUses: [],
        stop: "end",
        usage: { input: 1, output: 1 },
      };
    },
  };
};

const deps = (provider, store, home, spawned) => ({
  version: "0.0.0-test",
  providerId: "fake",
  model: "fake-1",
  buildSessionProvider: async () => provider,
  spawnSubagent: async () => "(legacy adapter)",
  spawnSubagentResult: async (
    _provider,
    _cwd,
    _context,
    _stats,
    task,
    _role,
    _signal,
    _observers,
    _profileId,
    _spaceId,
    durable,
  ) => {
    spawned.push({ task, durable });
    const now = new Date().toISOString();
    return {
      id: durable.id,
      providerId: "native-readonly",
      queuedAt: now,
      startedAt: now,
      endedAt: now,
      durationMs: 0,
      status: "completed",
      text: "child conclusion",
      model: "fake-child",
      usage: { input: 4, output: 2 },
    };
  },
  sandbox: "off",
  approval: "full-auto",
  store,
  quietDiscovery: true,
  agentTeamHome: home,
  spaces: () => ({
    activeId: "personal",
    activeProfileId: "personal",
    activeSource: "default",
    switchLocked: false,
    spaces: [{
      id: "personal",
      name: "Personal",
      kind: "personal",
      profileId: "personal",
      active: true,
      authoritative: true,
      agentProfilePermission: "edit",
    }],
    vision: {
      enabled: false,
      apiKeyConfigured: false,
      usesManagedCredential: false,
      editable: true,
      authorized: true,
    },
  }),
  useSpace: () => ({
    activeId: "personal",
    activeProfileId: "personal",
    activeSource: "default",
    switchLocked: false,
    spaces: [{
      id: "personal",
      name: "Personal",
      kind: "personal",
      profileId: "personal",
      active: true,
      authoritative: true,
      agentProfilePermission: "edit",
    }],
  }),
});

test("Serve exposes a durable Agent tree and restores it after reconnect", { timeout: 20_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "hara-serve-agent-team-"));
  const store = memStore();
  const spawned = [];
  let server;
  let client;
  try {
    server = await startServe(
      { host: "127.0.0.1", port: 0, token: "tok", cwd: home },
      deps(rootProvider(), store, home, spawned),
    );
    client = await connect(server.port);
    const initialized = await client.call("initialize", { token: "tok" });
    assert.ok(initialized.result.capabilities.methods.includes("session.agents.list"));
    assert.ok(initialized.result.capabilities.events.includes("event.agent_state"));
    assert.ok(initialized.result.capabilities.features.includes("agents.durable-team.v1"));

    const created = await client.call("session.create");
    const sessionId = created.result.sessionId;
    const sent = await client.call("session.send", { sessionId, text: "delegate an inspection" });
    assert.equal(sent.error, undefined);
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].durable.id.length, 36);
    assert.equal(spawned[0].durable.agentTeam.path, "/root/research");

    const listed = await client.call("session.agents.list", { sessionId });
    assert.equal(listed.result.agents.length, 1);
    assert.equal(listed.result.agents[0].status, "completed");
    assert.equal(listed.result.agents[0].path, "/root/research");
    assert.equal(listed.result.agents[0].hasResult, true);
    assert.equal(typeof listed.result.agents[0].rootTurnId, "string");
    assert.equal(listed.result.agents[0].parentTurnId, listed.result.agents[0].rootTurnId);
    assert.equal(listed.result.budget.limits.maxTokens, 400_000,
      "unknown models use the conservative 200k context fallback and a two-window tree cap");
    assert.equal(listed.result.budget.limits.maxTokensPerAgent, 100_000);
    assert.equal(listed.result.budget.inputTokens + listed.result.budget.outputTokens, 6);
    assert.doesNotMatch(JSON.stringify(listed.result), /child conclusion|Inspect the durable runtime/);
    assert.ok(client.events.some((event) => event.method === "event.agent_state"));

    const stateFile = join(home, ".hara", "agent-teams", sessionId + ".json");
    assert.equal(existsSync(stateFile), true);
    assert.match(readFileSync(stateFile, "utf8"), /child conclusion/);
    const stableId = listed.result.agents[0].id;

    client.ws.close();
    await server.close();
    server = await startServe(
      { host: "127.0.0.1", port: 0, token: "tok", cwd: home },
      deps(rootProvider(), store, home, spawned),
    );
    client = await connect(server.port);
    await client.call("initialize", { token: "tok" });
    const resumed = await client.call("session.resume", { sessionId });
    assert.equal(resumed.error, undefined);
    const restored = await client.call("session.agents.list", { sessionId });
    assert.equal(restored.result.agents[0].id, stableId);
    assert.equal(restored.result.agents[0].status, "completed");

    const deleted = await client.call("session.delete", { sessionId });
    assert.equal(deleted.error, undefined);
    assert.equal(existsSync(stateFile), false, "permanent session deletion removes private Agent-team state");
  } finally {
    client?.ws.close();
    await server?.close();
    rmSync(home, { recursive: true, force: true });
  }
});
