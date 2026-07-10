// hara serve end-to-end over a REAL WebSocket: auth, session lifecycle, streamed events, approval
// round-trip through the real agent loop (fake provider + hermetic in-memory store; write_file in a tmp
// dir under approval "suggest" forces the confirm gate).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { startServe } from "../dist/serve/server.js";

/** Tiny JSON-RPC-over-ws test client: request/response correlation + notification capture. */
function connect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const pending = new Map();
    const events = [];
    const waiters = [];
    let nextId = 1;
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      if (m.id !== undefined && m.id !== null && pending.has(m.id)) {
        const { res } = pending.get(m.id);
        pending.delete(m.id);
        res(m);
      } else if (m.method) {
        events.push(m);
        for (const w of waiters.splice(0)) w();
      }
    });
    ws.on("open", () =>
      resolve({
        ws,
        events,
        call: (method, params) =>
          new Promise((res) => {
            const id = nextId++;
            pending.set(id, { res });
            ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
          }),
        waitEvent: (method, timeoutMs = 5000) =>
          new Promise((res, rej) => {
            const scan = () => events.find((e) => e.method === method);
            const hit = scan();
            if (hit) return res(hit);
            const t = setTimeout(() => rej(new Error(`timeout waiting for ${method}`)), timeoutMs);
            const tick = () => {
              const h = scan();
              if (h) {
                clearTimeout(t);
                res(h);
              } else waiters.push(tick);
            };
            waiters.push(tick);
          }),
        close: () => ws.close(),
      }),
    );
    ws.on("error", reject);
  });
}

const memStore = () => {
  const files = new Map();
  return {
    saved: files,
    load: (id) => files.get(id) ?? null,
    save: (meta, history) => files.set(meta.id, { meta: { ...meta }, history: [...history] }),
    list: () => [...files.values()].map((d) => d.meta),
    acquire: () => ({ ok: true }),
    release: () => {},
  };
};

/** Fake provider: streams "hel"+"lo" and ends. */
const textProvider = {
  id: "fake",
  model: "fake-1",
  async turn({ onText }) {
    onText("hel");
    onText("lo");
    return { text: "hello", toolUses: [], stop: "end", usage: { input: 3, output: 2 } };
  },
};

/** Fake provider: first turn asks to write a file (forces the approval gate under "suggest"), second ends. */
const toolProvider = () => {
  let n = 0;
  return {
    id: "fake",
    model: "fake-1",
    async turn({ onText }) {
      if (n++ === 0) {
        return { text: "", toolUses: [{ id: "t1", name: "write_file", input: { path: "approved.txt", content: "hi" } }], stop: "tool_use", usage: { input: 1, output: 1 } };
      }
      onText("done");
      return { text: "done", toolUses: [], stop: "end", usage: { input: 1, output: 1 } };
    },
  };
};

const baseDeps = (provider, store, approval = "full-auto") => ({
  version: "0.0.0-test",
  providerId: "fake",
  model: "fake-1",
  buildSessionProvider: async () => provider,
  spawnSubagent: async () => "(subagents disabled in test)",
  sandbox: "off",
  approval,
  store,
  quietDiscovery: true,
});

test("serve e2e: auth gate → create → send streams text events and returns the reply", { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-serve-"));
  const store = memStore();
  const srv = await startServe({ host: "127.0.0.1", port: 0, token: "tok", cwd: dir }, baseDeps(textProvider, store));
  const c = await connect(srv.port);
  try {
    // unauthenticated calls bounce; bad token bounces
    const denied = await c.call("session.list", {});
    assert.equal(denied.error.code, -32001);
    const badTok = await c.call("initialize", { token: "wrong" });
    assert.equal(badTok.error.code, -32001);
    const init = await c.call("initialize", { token: "tok" });
    assert.equal(init.result.protocol, 1);
    assert.equal(init.result.model, "fake-1");

    const created = await c.call("session.create", {});
    const sid = created.result.sessionId;
    assert.ok(sid, "got a session id");

    const sent = await c.call("session.send", { sessionId: sid, text: "hi there" });
    assert.equal(sent.result.reply, "hello");
    assert.equal(sent.result.usage.input, 3);
    const deltas = c.events.filter((e) => e.method === "event.text").map((e) => e.params.delta).join("");
    assert.equal(deltas, "hello", "text streamed as events");
    await c.waitEvent("event.turn_end");

    // persisted through the (injected) store + listed
    assert.ok(store.saved.get(sid), "session persisted after the turn");
    const listed = await c.call("session.list", {});
    assert.equal(listed.result.sessions.length, 1);

    // unknown session / busy / params errors
    const nosess = await c.call("session.send", { sessionId: "nope", text: "x" });
    assert.equal(nosess.error.code, -32003);
    const badParams = await c.call("session.send", { sessionId: sid });
    assert.equal(badParams.error.code, -32602);

    // plugins/skills surface (P2): shape-only — contents depend on the machine's ~/.hara
    const plugins = await c.call("plugins.list", {});
    assert.ok(Array.isArray(plugins.result.plugins), "plugins.list returns an array");
    const badSet = await c.call("plugins.set", { name: "definitely-not-installed-xyz", enabled: false });
    assert.equal(badSet.error.code, -32602, "plugins.set on unknown plugin → params error (never writes config)");
    const skills = await c.call("skills.list", {});
    assert.ok(Array.isArray(skills.result.skills), "skills.list returns an array");
  } finally {
    c.close();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve e2e: approval round-trip — suggest mode write_file waits for approval.reply, then completes", { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-serve-"));
  const store = memStore();
  const srv = await startServe({ host: "127.0.0.1", port: 0, token: "tok", cwd: dir }, baseDeps(toolProvider(), store, "suggest"));
  const c = await connect(srv.port);
  try {
    await c.call("initialize", { token: "tok" });
    const { result } = await c.call("session.create", {});
    // answer the approval as soon as it arrives (concurrently with the running send)
    const approver = c.waitEvent("approval.request").then((ev) => c.call("approval.reply", { approvalId: ev.params.approvalId, allow: true }));
    const sent = await c.call("session.send", { sessionId: result.sessionId, text: "write it" });
    await approver;
    assert.equal(sent.result.reply, "done");
    assert.equal(c.events.filter((e) => e.method === "approval.request").length, 1, "exactly one approval asked");
    assert.equal(readFileSync(join(dir, "approved.txt"), "utf8"), "hi", "the approved tool actually ran");
  } finally {
    c.close();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve e2e: denied approval blocks the tool", { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-serve-"));
  const srv = await startServe({ host: "127.0.0.1", port: 0, token: "tok", cwd: dir }, baseDeps(toolProvider(), memStore(), "suggest"));
  const c = await connect(srv.port);
  try {
    await c.call("initialize", { token: "tok" });
    const { result } = await c.call("session.create", {});
    const denier = c.waitEvent("approval.request").then((ev) => c.call("approval.reply", { approvalId: ev.params.approvalId, allow: false }));
    const sent = await c.call("session.send", { sessionId: result.sessionId, text: "write it" });
    await denier;
    assert.equal(sent.result.reply, "done", "turn still completes (model told of the denial)");
    assert.equal(existsSync(join(dir, "approved.txt")), false, "denied tool did NOT run");
  } finally {
    c.close();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
