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
  let submittedCount = 0;
  let steeredCount = 0;
  let interrupted = 0;
  let terminalInput = "";
  let terminalKey = "";
  let terminalRawInput = "";
  let terminalResize = [];
  let terminalScroll = [];
  let terminalStreamReleased = 0;
  let nativeTerminalOpen = null;
  let failNativeTerminalOpen = false;
  let removed = 0;
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
      assert.deepEqual(input, {
        sourceId: "runtime",
        cwd: root,
        agentKind: "codex",
        title: "Release relay",
        launch: { model: "gpt-5.6-terra", effort: "high", sandboxMode: "read-only", serviceTier: "fast" },
      });
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
    async resumeSession(requestedSessionId) {
      assert.equal(requestedSessionId, sessionId);
      return {
        session: { ...(await this.listSessions()).sessions[0] },
        messages: [{ id: "msg_0123456789abcdef01234567", role: "assistant", text: "existing reply" }],
        readOnly: false,
        controlMode: "managed",
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
      assert.equal(requestedSessionId, sessionId);
      assert.equal(text, "continue safely");
      submittedCount += 1;
      sink.notice("Starting continuation");
      sink.tool("Command", "npm test");
      const verdict = await sink.confirm({ question: "Allow test command?", allowAlways: true }, new AbortController().signal);
      assert.equal(verdict, true);
      sink.text("hello ");
      await new Promise((resolve) => { finishAfterSteer = resolve; });
      sink.text("world");
      return {
        sessionId,
        turnId: "provider-turn-is-not-exposed",
        status: "completed",
        reply: "hello world",
      };
    },
    async steer(requestedSessionId, text) {
      assert.equal(requestedSessionId, sessionId);
      assert.equal(text, "add one focused check");
      steeredCount += 1;
      finishAfterSteer?.();
      return {
        sessionId,
        turnId: "adapter-private-turn-is-not-exposed",
        accepted: true,
      };
    },
    async interrupt(requestedSessionId) {
      assert.equal(requestedSessionId, sessionId);
      interrupted += 1;
    },
    async terminalSnapshot(requestedSessionId) {
      assert.equal(requestedSessionId, "ext_runtime_0123456789abcdef01234567");
      return { sessionId: requestedSessionId, text: "native screen", state: "idle", updatedAt: "2026-08-28T00:01:00.000Z" };
    },
    async terminalInput(requestedSessionId, text) {
      assert.equal(requestedSessionId, "ext_runtime_0123456789abcdef01234567");
      terminalInput = text;
    },
    async terminalKey(requestedSessionId, key) {
      assert.equal(requestedSessionId, "ext_runtime_0123456789abcdef01234567");
      terminalKey = key;
    },
    async openTerminalStream(requestedSessionId, input, sink) {
      assert.equal(requestedSessionId, "ext_runtime_0123456789abcdef01234567");
      assert.ok(input.mode === "control" || input.mode === "observe");
      queueMicrotask(() => sink.frame({
        seq: 4,
        encoding: "ansi-base64",
        width: input.cols,
        height: input.rows,
        full: true,
        bytes: Buffer.from(`${input.mode} stream frame`).toString("base64"),
      }));
      return {
        mode: input.mode,
        input(text) { terminalRawInput += text; },
        resize(cols, rows) { terminalResize = [cols, rows]; },
        scroll(direction, lines) { terminalScroll = [direction, lines]; },
        async release() { terminalStreamReleased += 1; },
      };
    },
    async openNativeTerminal(requestedSessionId, input) {
      assert.equal(requestedSessionId, "ext_runtime_0123456789abcdef01234567");
      if (failNativeTerminalOpen) throw new Error("WezTerm is not installed");
      nativeTerminalOpen = input;
      return { terminal: "wezterm", opened: true };
    },
    async removeSession(requestedSessionId) {
      assert.equal(requestedSessionId, "ext_runtime_0123456789abcdef01234567");
      removed += 1;
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
    assert.ok(initialized.result.capabilities.features.includes("external.sessions.native-resume.v1"));
    assert.ok(initialized.result.capabilities.features.includes("external.sessions.launch-options.v1"));
    assert.ok(initialized.result.capabilities.features.includes("external.sessions.command-idempotency.serve-lifetime.v1"));
    assert.ok(initialized.result.capabilities.features.includes("external.sessions.terminal-mirror.v1"));
    assert.ok(initialized.result.capabilities.features.includes("external.sessions.terminal-stream.v2"));
    assert.ok(initialized.result.capabilities.features.includes("external.sessions.terminal-input-sequence.v1"));
    assert.ok(initialized.result.capabilities.features.includes("external.sessions.runtime-remove.v1"));
    assert.ok(initialized.result.capabilities.methods.includes("external.sessions.create"));
    assert.ok(initialized.result.capabilities.methods.includes("external.sessions.resume"));
    assert.ok(initialized.result.capabilities.methods.includes("external.sessions.remove"));
    assert.equal(initialized.result.capabilities.limits.externalCommandReceipts, 64);
    assert.equal(initialized.result.capabilities.limits.externalCommandResultBytes, 256 * 1024);
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
      launch: { model: "gpt-5.6-terra", effort: "high", sandboxMode: "read-only", serviceTier: "fast" },
    });
    assert.equal(created.result.session.sourceId, "runtime");
    assert.equal(created.result.controlMode, "live");
    const terminalSessionId = created.result.session.id;
    const terminal = await client.call("external.sessions.terminal.snapshot", { sessionId: terminalSessionId });
    assert.equal(terminal.result.text, "native screen");
    await client.call("external.sessions.terminal.input", { sessionId: terminalSessionId, text: "/status" });
    await client.call("external.sessions.terminal.key", { sessionId: terminalSessionId, key: "esc" });
    assert.equal(terminalInput, "/status");
    assert.equal(terminalKey, "esc");
    const attached = await client.call("external.sessions.terminal.attach", {
      sessionId: terminalSessionId,
      mode: "control",
      cols: 96,
      rows: 31,
    });
    assert.equal(attached.result.mode, "control");
    assert.equal(attached.result.nextInputSeq, 1);
    assert.match(attached.result.streamId, /^terminal_/);
    const terminalFrame = await client.waitFor("external.event.terminal.frame");
    assert.equal(terminalFrame.params.streamId, attached.result.streamId);
    assert.equal(Buffer.from(terminalFrame.params.bytes, "base64").toString(), "control stream frame");
    await client.call("external.sessions.terminal.raw-input", { streamId: attached.result.streamId, text: "\u0003" });
    const firstSequencedInput = await client.call("external.sessions.terminal.raw-input", {
      streamId: attached.result.streamId,
      text: "x",
      inputSeq: 1,
    });
    assert.deepEqual(firstSequencedInput.result, {
      accepted: true,
      duplicate: false,
      inputSeq: 1,
      nextInputSeq: 2,
    });
    const duplicateInput = await client.call("external.sessions.terminal.raw-input", {
      streamId: attached.result.streamId,
      text: "x",
      inputSeq: 1,
    });
    assert.equal(duplicateInput.result.duplicate, true);
    const reusedInput = await client.call("external.sessions.terminal.raw-input", {
      streamId: attached.result.streamId,
      text: "different",
      inputSeq: 1,
    });
    assert.equal(reusedInput.error.code, -32005);
    const inputGap = await client.call("external.sessions.terminal.raw-input", {
      streamId: attached.result.streamId,
      text: "too early",
      inputSeq: 3,
    });
    assert.equal(inputGap.error.code, -32005);
    assert.match(inputGap.error.message, /expected 2/i);
    await client.call("external.sessions.terminal.raw-input", {
      streamId: attached.result.streamId,
      text: "z",
      inputSeq: 2,
    });
    await client.call("external.sessions.terminal.resize", { streamId: attached.result.streamId, cols: 101, rows: 33 });
    await client.call("external.sessions.terminal.scroll", { streamId: attached.result.streamId, direction: "down", lines: 5 });
    assert.equal(terminalRawInput, "\u0003xz", "duplicate, conflicting, and out-of-order input never reaches the PTY");
    assert.deepEqual(terminalResize, [101, 33]);
    assert.deepEqual(terminalScroll, ["down", 5]);
    const observerClient = await connect(personal.port);
    await observerClient.call("initialize", { token: "personal-token" });
    const deniedController = await observerClient.call("external.sessions.terminal.attach", {
      sessionId: terminalSessionId,
      mode: "control",
      cols: 80,
      rows: 24,
    });
    assert.ok(deniedController.error, "a second controller needs an explicit takeover");
    const observer = await observerClient.call("external.sessions.terminal.attach", {
      sessionId: terminalSessionId,
      mode: "observe",
      cols: 80,
      rows: 24,
    });
    const observerFrame = await observerClient.waitFor("external.event.terminal.frame");
    assert.equal(observerFrame.params.streamId, observer.result.streamId);
    assert.equal(Buffer.from(observerFrame.params.bytes, "base64").toString(), "observe stream frame");
    assert.equal(client.events.some((event) => event.params?.streamId === observer.result.streamId), false,
      "private terminal frames go only to the socket that attached that stream");
    await observerClient.call("external.sessions.terminal.release", { streamId: observer.result.streamId });
    observerClient.ws.close();
    const unconfirmedNativeTerminal = await client.call("external.sessions.terminal.open-wezterm", { sessionId: terminalSessionId });
    assert.ok(unconfirmedNativeTerminal.error, "even the current controller must explicitly confirm a native-terminal transfer");
    assert.equal(terminalStreamReleased, 1, "an unconfirmed native handoff keeps the in-app controller alive");
    failNativeTerminalOpen = true;
    const failedNativeTerminal = await client.call("external.sessions.terminal.open-wezterm", { sessionId: terminalSessionId, takeover: true });
    assert.ok(failedNativeTerminal.error, "a failed WezTerm launch remains visible to the requester");
    assert.equal(terminalStreamReleased, 1, "a failed WezTerm launch must not strand the in-app controller");
    failNativeTerminalOpen = false;
    const nativeTerminal = await client.call("external.sessions.terminal.open-wezterm", { sessionId: terminalSessionId, takeover: true });
    assert.deepEqual(nativeTerminal.result, { terminal: "wezterm", opened: true });
    assert.deepEqual(nativeTerminalOpen, { terminal: "wezterm", takeover: true });
    assert.equal(terminalStreamReleased, 2, "observers and the in-app controller release independently before WezTerm takes control");
    await client.call("external.sessions.remove", { sessionId: terminalSessionId });
    assert.equal(removed, 1);
    const resumed = await client.call("external.sessions.resume", { sessionId });
    assert.equal(resumed.result.session.id, sessionId);
    assert.equal(resumed.result.readOnly, false);
    assert.equal(resumed.result.controlMode, "managed");

    const submitCommandId = "11111111-1111-4111-8111-111111111111";
    const submitted = client.call("external.sessions.submit", {
      sessionId,
      text: "continue safely",
      commandId: submitCommandId,
    });
    const started = await client.waitFor("external.event.turn_start");
    const retryClient = await connect(personal.port);
    await retryClient.call("initialize", { token: "personal-token" });
    const submittedAfterReconnect = retryClient.call("external.sessions.submit", {
      commandId: submitCommandId,
      text: "continue safely",
      sessionId,
    });
    const conflictingSubmit = await retryClient.call("external.sessions.submit", {
      sessionId,
      text: "different input",
      commandId: submitCommandId,
    });
    assert.equal(conflictingSubmit.error.code, -32005);
    assert.equal(submittedCount, 1, "a reconnect retry must share the original provider submit");
    const approval = await client.waitFor("external.approval.request");
    assert.equal(approval.params.sessionId, sessionId);
    assert.equal(approval.params.question, "Allow test command?");
    const approvalReply = await client.call("approval.reply", { approvalId: approval.params.approvalId, allow: true });
    assert.deepEqual(approvalReply.result, {});
    await client.waitFor("external.event.text");
    const staleSteer = await client.call("external.sessions.steer", {
      sessionId,
      text: "add one focused check",
      expectedTurnId: "extturn_stale",
      commandId: "22222222-2222-4222-8222-222222222222",
    });
    assert.equal(staleSteer.error.code, -32005);
    assert.equal(steeredCount, 0, "stale input must not reach the provider adapter");
    const steerCommandId = "33333333-3333-4333-8333-333333333333";
    const steered = await client.call("external.sessions.steer", {
      sessionId,
      text: "add one focused check",
      expectedTurnId: started.params.turnId,
      commandId: steerCommandId,
    });
    const duplicateSteer = await retryClient.call("external.sessions.steer", {
      commandId: steerCommandId,
      expectedTurnId: started.params.turnId,
      text: "add one focused check",
      sessionId,
    });
    assert.equal(steered.result.accepted, true);
    assert.deepEqual(duplicateSteer.result, steered.result);
    assert.equal(steeredCount, 1);
    assert.equal(steered.result.turnId, started.params.turnId);
    assert.notEqual(steered.result.turnId, "adapter-private-turn-is-not-exposed");
    const completed = await submitted;
    const completedAfterReconnect = await submittedAfterReconnect;
    assert.equal(completed.result.sessionId, sessionId);
    assert.equal(completed.result.reply, "hello world");
    assert.deepEqual(completedAfterReconnect.result, completed.result);
    assert.notEqual(completed.result.turnId, "provider-turn-is-not-exposed");
    assert.ok(client.events.some((event) => event.method === "external.event.text" && event.params.delta === "hello "));
    assert.ok(client.events.some((event) => event.method === "external.event.turn_end" && event.params.status === "completed"));
    const interruptCommandId = "44444444-4444-4444-8444-444444444444";
    await client.call("external.sessions.interrupt", { sessionId, commandId: interruptCommandId });
    await retryClient.call("external.sessions.interrupt", { commandId: interruptCommandId, sessionId });
    assert.equal(interrupted, 1);
    const staleInterrupt = await retryClient.call("external.sessions.interrupt", {
      sessionId,
      expectedTurnId: started.params.turnId,
      commandId: "55555555-5555-4555-8555-555555555555",
    });
    assert.equal(staleInterrupt.error.code, -32005);
    assert.equal(interrupted, 1, "an interrupt for an ended turn must not hit the provider adapter");
    retryClient.ws.close();
    const forked = await client.call("external.sessions.fork", { sessionId });
    assert.equal(forked.result.sourceSessionId, sessionId);
    assert.equal(forked.result.session.id, forkedSessionId);
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
    const removeDenied = await companyClient.call("external.sessions.remove", {
      sessionId: "ext_runtime_0123456789abcdef01234567",
    });
    assert.equal(removeDenied.error.code, -32001);
    companyClient.ws.close();
  } finally {
    await personal?.close();
    await company?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
