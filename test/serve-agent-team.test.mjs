import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
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
    const eventWaiters = [];
    let nextId = 1;
    ws.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      if (message.id !== undefined && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      } else if (message.method) {
        events.push(message);
        for (let index = eventWaiters.length - 1; index >= 0; index--) {
          if (eventWaiters[index].method !== message.method) continue;
          const [waiter] = eventWaiters.splice(index, 1);
          clearTimeout(waiter.timer);
          waiter.resolve(message);
        }
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
      waitEvent(method, timeoutMs = 5_000) {
        const existing = events.find((event) => event.method === method);
        if (existing) return Promise.resolve(existing);
        return new Promise((done, fail) => {
          const waiter = {
            method,
            resolve: done,
            timer: setTimeout(() => {
              const index = eventWaiters.indexOf(waiter);
              if (index >= 0) eventWaiters.splice(index, 1);
              fail(new Error(`timed out waiting for ${method}`));
            }, timeoutMs),
          };
          eventWaiters.push(waiter);
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
            id: "brief-1",
            name: "task_intake",
            input: {
              intent: "change",
              goal: "apply the reviewed isolated Agent Diff",
              constraints: ["preserve unrelated source changes"],
              acceptance: ["owned.txt contains the child implementation"],
              steps: ["spawn the isolated Agent", "wait and review", "apply the owned Diff", "verify"],
            },
          }],
          stop: "tool_use",
          usage: { input: 1, output: 1 },
        };
      }
      if (round === 2) {
        return {
          text: "",
          toolUses: [{
            id: "spawn-1",
            name: "spawn_agent",
            input: {
              task_name: "research",
              message: "Implement the durable runtime fixture",
              workspace: "isolated-write",
            },
          }],
          stop: "tool_use",
          usage: { input: 1, output: 1 },
        };
      }
      if (round === 3) {
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
      if (round === 4) {
        return {
          text: "",
          toolUses: [{
            id: "inspect-1",
            name: "inspect_agent_diff",
            input: { target: "/root/research" },
          }],
          stop: "tool_use",
          usage: { input: 1, output: 1 },
        };
      }
      if (round === 5) {
        return {
          text: "",
          toolUses: [{
            id: "apply-1",
            name: "apply_agent_diff",
            input: { target: "/root/research" },
          }],
          stop: "tool_use",
          usage: { input: 1, output: 1 },
        };
      }
      if (round === 6) {
        return {
          text: "",
          toolUses: [{
            id: "receipt-1",
            name: "task_checkpoint",
            input: {
              completion: {
                state: "verified",
                evidence: ["the owned Agent Diff passed strict apply checks and was applied"],
              },
            },
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
    if (durable.workspace) {
      writeFileSync(join(durable.workspace.cwd, "owned.txt"), "child implementation\n");
    }
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
  const root = mkdtempSync(join(tmpdir(), "hara-serve-agent-team-"));
  const home = join(root, "home");
  const repo = join(root, "repo");
  mkdirSync(home);
  mkdirSync(repo);
  const runGit = (...args) => {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || `git ${args[0]} failed`);
  };
  runGit("init", "-q");
  runGit("config", "user.email", "test@example.test");
  runGit("config", "user.name", "Hara Test");
  writeFileSync(join(repo, "owned.txt"), "source\n");
  runGit("add", "owned.txt");
  runGit("commit", "-qm", "base");
  const store = memStore();
  const spawned = [];
  let server;
  let client;
  try {
    server = await startServe(
      { host: "127.0.0.1", port: 0, token: "tok", cwd: repo },
      deps(rootProvider(), store, home, spawned),
    );
    client = await connect(server.port);
    const initialized = await client.call("initialize", { token: "tok" });
    assert.ok(initialized.result.capabilities.methods.includes("session.agents.list"));
    assert.ok(initialized.result.capabilities.events.includes("event.agent_state"));
    assert.ok(initialized.result.capabilities.features.includes("agents.durable-team.v1"));

    const created = await client.call("session.create");
    const sessionId = created.result.sessionId;
    const sending = client.call("session.send", { sessionId, text: "implement and apply the isolated fixture change" });
    const approval = await client.waitEvent("approval.request");
    assert.match(approval.params.question, /apply_agent_diff/u);
    await client.call("approval.reply", { approvalId: approval.params.approvalId, allow: true });
    const sent = await sending;
    assert.equal(sent.error, undefined, JSON.stringify(sent));
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].durable.id.length, 36);
    assert.equal(spawned[0].durable.agentTeam.path, "/root/research");
    assert.equal(spawned[0].durable.workspace.mode, "isolated-write");
    assert.equal(
      readFileSync(join(repo, "owned.txt"), "utf8"),
      "child implementation\n",
      JSON.stringify({ sent, events: client.events }),
    );

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
    assert.doesNotMatch(JSON.stringify(listed.result), /child conclusion|Implement the durable runtime fixture/);
    assert.ok(client.events.some((event) => event.method === "event.agent_state"));
    const diffItems = client.events
      .filter((event) => event.method === "event.runtime_item"
        && event.params.kind === "diff"
        && event.params.name === "agent_worktree_diff")
      .map((event) => event.params);
    assert.deepEqual(diffItems.map((item) => item.state), ["queued", "started", "paused", "resumed", "completed"]);
    assert.ok(diffItems.every((item) => item.name === "agent_worktree_diff" && item.effect === "edit"));
    assert.doesNotMatch(JSON.stringify(diffItems), /owned\.txt|child implementation/);

    const stateFile = join(home, ".hara", "agent-teams", sessionId + ".json");
    assert.equal(existsSync(stateFile), true);
    assert.match(readFileSync(stateFile, "utf8"), /child conclusion/);
    const stableId = listed.result.agents[0].id;

    client.ws.close();
    await server.close();
    server = await startServe(
      { host: "127.0.0.1", port: 0, token: "tok", cwd: repo },
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
    rmSync(root, { recursive: true, force: true });
  }
});
