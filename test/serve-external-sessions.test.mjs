import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import WebSocket from "ws";

import { startServe } from "../dist/serve/server.js";

const connect = (port) => new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  let nextId = 1;
  const pending = new Map();
  const events = [];
  const eventWaiters = [];
  ws.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    const finish = pending.get(message.id);
    if (finish) {
      pending.delete(message.id);
      finish(message);
      return;
    }
    if (typeof message.method === "string") {
      events.push(message);
      const waiterIndex = eventWaiters.findIndex((waiter) => waiter.method === message.method);
      if (waiterIndex >= 0) {
        const [waiter] = eventWaiters.splice(waiterIndex, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    }
  });
  ws.on("open", () => resolve({
    ws,
    call(method, params = {}) {
      return new Promise((finish) => {
        const id = nextId++;
        pending.set(id, finish);
        ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      });
    },
    events,
    waitFor(method, timeoutMs = 2_000) {
      const existing = events.find((event) => event.method === method);
      if (existing) return Promise.resolve(existing);
      return new Promise((finish, fail) => {
        const waiter = { method, resolve: finish, timer: undefined };
        waiter.timer = setTimeout(() => {
          const index = eventWaiters.indexOf(waiter);
          if (index >= 0) eventWaiters.splice(index, 1);
          fail(new Error(`timed out waiting for ${method}`));
        }, timeoutMs);
        eventWaiters.push(waiter);
      });
    },
  }));
  ws.on("error", reject);
});

const memStore = () => {
  const records = new Map();
  return {
    load: (id) => records.get(id) ?? null,
    save: (meta, history, task) => records.set(meta.id, { meta, history, task }),
    list: () => [...records.values()].map((entry) => entry.meta),
    acquire: () => ({ ok: true }),
    release: () => {},
    delete: (id) => records.delete(id),
  };
};

const provider = {
  id: "fake",
  model: "fake-1",
  async turn() {
    return { text: "", toolUses: [], stop: "end", usage: { input: 0, output: 0 } };
  },
};

const sourceResult = {
  sources: [{
    id: "codex",
    label: "Codex",
    state: "ready",
    capabilities: {
      listMetadata: true,
      read: true,
      create: false,
      fork: true,
      resume: true,
      observeLive: false,
      submit: true,
      steer: true,
      interrupt: true,
    },
  }],
};

const deps = (spaceId, externalSessions) => ({
  version: "0.0.0-test",
  providerId: "fake",
  model: "fake-1",
  buildSessionProvider: async () => provider,
  spawnSubagent: async () => "disabled",
  sandbox: "off",
  approval: "full-auto",
  store: memStore(),
  quietDiscovery: true,
  runtimeInfo: () => ({
    providerId: "fake",
    model: "fake-1",
    profileId: spaceId === "personal" ? "personal" : "company",
    spaceId,
  }),
  externalSessions,
});

test("Serve advertises a Personal-only external session interaction surface", async () => {
  const root = mkdtempSync(join(tmpdir(), "hara-serve-external-"));
  const sessionId = "ext_codex_0123456789abcdef01234567";
  const forkedSessionId = "ext_codex_89abcdef0123456789abcdef";
  let interrupted = 0;
  let closed = 0;
  const externalSessions = {
    async listSources() { return sourceResult; },
    async listSessions() {
      return {
        ...sourceResult,
        sessions: [{
          id: sessionId,
          sourceId: "codex",
          title: "Session",
          workspaceName: "hara",
          workspaceId: "ws_opaque",
          state: "idle",
          createdAt: "2026-08-28T00:00:00.000Z",
          updatedAt: "2026-08-28T00:01:00.000Z",
          ephemeral: false,
        }],
        page: { limit: 50, hasMore: false },
      };
    },
    async readSession(requestedSessionId) {
      assert.equal(requestedSessionId, sessionId);
      return {
        session: { ...(await this.listSessions()).sessions[0] },
        messages: [{ id: "msg_0123456789abcdef01234567", role: "assistant", text: "existing reply" }],
        readOnly: true,
        controlMode: "history",
      };
    },
    async createSession(input) {
      assert.deepEqual(input, { sourceId: "runtime", cwd: root, agentKind: "codex", title: "Release relay" });
      return {
        session: {
          id: "ext_runtime_0123456789abcdef01234567",
          sourceId: "runtime",
          title: "Release relay",
          workspaceName: "hara",
          workspaceId: "ws_runtime_opaque",
          state: "idle",
          createdAt: "2026-08-28T00:00:00.000Z",
          updatedAt: "2026-08-28T00:01:00.000Z",
          origin: "haraRuntime",
          agentKind: "codex",
          ephemeral: false,
        },
        messages: [],
        readOnly: false,
        controlMode: "live",
      };
    },
    async forkSession(requestedSessionId) {
      assert.equal(requestedSessionId, sessionId);
      const source = (await this.listSessions()).sessions[0];
      return {
        sourceSessionId: sessionId,
        session: { ...source, id: forkedSessionId, title: "Session · Hara fork" },
        messages: [{ id: "msg_0123456789abcdef01234567", role: "assistant", text: "existing reply" }],
        readOnly: false,
        controlMode: "managed",
      };
    },
    async submit(requestedSessionId, text, sink) {
      assert.equal(requestedSessionId, forkedSessionId);
      assert.equal(text, "continue safely");
      sink.notice("Starting continuation");
      sink.tool("Command", "npm test");
      const verdict = await sink.confirm({ question: "Allow test command?", allowAlways: true }, new AbortController().signal);
      assert.equal(verdict, true);
      sink.text("hello ");
      await new Promise((resolve) => { finishAfterSteer = resolve; });
      sink.text("world");
      return {
        sessionId: forkedSessionId,
        turnId: "provider-turn-is-not-exposed",
        status: "completed",
        reply: "hello world",
      };
    },
    async steer(requestedSessionId, text) {
      assert.equal(requestedSessionId, forkedSessionId);
      assert.equal(text, "add one focused check");
      finishAfterSteer?.();
      return {
        sessionId: forkedSessionId,
        turnId: "adapter-private-turn-is-not-exposed",
        accepted: true,
      };
    },
    async interrupt(requestedSessionId) {
      assert.equal(requestedSessionId, forkedSessionId);
      interrupted += 1;
    },
    async close() { closed += 1; },
  };
  let personal;
  let company;
  let finishAfterSteer;
  try {
    personal = await startServe(
      { host: "127.0.0.1", port: 0, token: "personal-token", cwd: root },
      deps("personal", externalSessions),
    );
    const client = await connect(personal.port);
    const initialized = await client.call("initialize", { token: "personal-token" });
    assert.ok(initialized.result.capabilities.methods.includes("external.sources.list"));
    assert.ok(initialized.result.capabilities.features.includes("external.sessions.metadata.v1"));
    assert.ok(initialized.result.capabilities.features.includes("external.sessions.interaction.v1"));
    assert.ok(initialized.result.capabilities.features.includes("external.sessions.live-control.v1"));
    assert.ok(initialized.result.capabilities.features.includes("external.sessions.runtime.v1"));
    assert.ok(initialized.result.capabilities.methods.includes("external.sessions.create"));
    const listed = await client.call("external.sessions.list", { sourceId: "codex" });
    assert.equal(listed.result.sessions[0].id, sessionId);
    const read = await client.call("external.sessions.read", { sessionId });
    assert.equal(read.result.messages[0].text, "existing reply");
    assert.equal(read.result.readOnly, true);
    const created = await client.call("external.sessions.create", {
      sourceId: "runtime",
      cwd: root,
      agentKind: "codex",
      title: "Release relay",
    });
    assert.equal(created.result.session.sourceId, "runtime");
    assert.equal(created.result.controlMode, "live");
    const forked = await client.call("external.sessions.fork", { sessionId });
    assert.equal(forked.result.sourceSessionId, sessionId);
    assert.equal(forked.result.session.id, forkedSessionId);

    const submitted = client.call("external.sessions.submit", { sessionId: forkedSessionId, text: "continue safely" });
    const started = await client.waitFor("external.event.turn_start");
    const approval = await client.waitFor("external.approval.request");
    assert.equal(approval.params.sessionId, forkedSessionId);
    assert.equal(approval.params.question, "Allow test command?");
    const approvalReply = await client.call("approval.reply", { approvalId: approval.params.approvalId, allow: true });
    assert.deepEqual(approvalReply.result, {});
    await client.waitFor("external.event.text");
    const steered = await client.call("external.sessions.steer", {
      sessionId: forkedSessionId,
      text: "add one focused check",
    });
    assert.equal(steered.result.accepted, true);
    assert.equal(steered.result.turnId, started.params.turnId);
    assert.notEqual(steered.result.turnId, "adapter-private-turn-is-not-exposed");
    const completed = await submitted;
    assert.equal(completed.result.sessionId, forkedSessionId);
    assert.equal(completed.result.reply, "hello world");
    assert.notEqual(completed.result.turnId, "provider-turn-is-not-exposed");
    assert.ok(client.events.some((event) => event.method === "external.event.text" && event.params.delta === "hello "));
    assert.ok(client.events.some((event) => event.method === "external.event.turn_end" && event.params.status === "completed"));
    await client.call("external.sessions.interrupt", { sessionId: forkedSessionId });
    assert.equal(interrupted, 1);
    client.ws.close();
    await personal.close();
    personal = null;
    assert.equal(closed, 1);

    company = await startServe(
      { host: "127.0.0.1", port: 0, token: "company-token", cwd: root },
      deps("org:company", externalSessions),
    );
    const companyClient = await connect(company.port);
    await companyClient.call("initialize", { token: "company-token" });
    const denied = await companyClient.call("external.sessions.list", { sourceId: "codex" });
    assert.equal(denied.error.code, -32001);
    companyClient.ws.close();
  } finally {
    await personal?.close();
    await company?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
