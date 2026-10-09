import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import WebSocket from "ws";

// Actual Serve and tools, synthetic Provider, private fixture files and loopback WebSocket only.
// No model, video destination, external Agent, computer service or paid API is contacted.
const buildRoot = process.env.HARA_SERVE_TASK_CLOSEOUT_TEST_BUILD_ROOT ?? process.env.HARA_TASK_CLOSEOUT_TEST_BUILD_ROOT;
const { startServe, lastAssistantText, historyForClient } = await import(buildRoot
  ? pathToFileURL(join(resolve(buildRoot), "serve/server.js")).href : new URL("../dist/serve/server.js", import.meta.url).href);
const RECEIPT = "synthetic upload receipt REMOTE-482 saved in the private fixture";
const FALSE_CLAIM = "UNACCEPTED_ALL_UPLOAD_CHECKS_COMPLETE";

function connect(port) {
  return new Promise((connected, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const events = [];
    const pending = new Map();
    let sequence = 0;
    ws.once("error", reject);
    ws.on("message", raw => {
      const message = JSON.parse(String(raw));
      const finish = pending.get(message.id);
      if (finish) { pending.delete(message.id); finish(message); }
      else if (message.method) events.push(message);
    });
    ws.once("open", () => connected({ ws, events,
      call(method, params = {}) {
        return new Promise((finish, fail) => {
          const id = ++sequence;
          const timer = setTimeout(() => { pending.delete(id); fail(new Error(`RPC timed out: ${method}`)); }, 5_000);
          timer.unref();
          pending.set(id, message => { clearTimeout(timer); finish(message); });
          ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
        });
      },
    }));
  });
}

function memoryStore() {
  const records = new Map();
  return { records,
    load: id => records.get(id) ?? null,
    save: (meta, history, task) => records.set(meta.id, structuredClone({ meta, history, task })),
    list: () => [...records.values()].map(record => record.meta),
    acquire: () => ({ ok: true }), release() {}, delete: id => records.delete(id),
  };
}

async function fixture(t, mode) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "hara-serve-task-closeout-")));
  let server, client, calls = 0;
  t.after(async () => { client?.ws.terminate(); await server?.close(); rmSync(root, { recursive: true, force: true }); });
  const response = (toolUses, text = "") => ({ text, stop: "tool_use", toolUses, usage: { input: 3, output: 1 } });
  const provider = { id: "closeout-fixture", model: "closeout-fixture", async turn() {
    const index = calls++;
    assert.ok(index < 4, "synthetic closeout stays bounded");
    if (index === 0) return response([{ id: "brief", name: "task_intake", input: {
      intent: "change", goal: "write only the synthetic upload receipt exactly once and verify its accepted checks",
      constraints: ["private fixture only", "no network transfers", "never repeat delivery"],
      acceptance: ["the synthetic receipt confirms one delivery", ...(mode === "verified" ? [] : ["platform processing is verified before claiming full completion"])],
      steps: ["write receipt once", "verify platform processing", "record final status"],
    } }]);
    if (index === 1) return response([{ id: "upload", name: "write_file", input: { path: "upload-receipt.txt", content: `${RECEIPT}\n` } }]);
    if (index === 2) {
      if (mode === "provider_error") return { text: "", stop: "error", toolUses: [], errorMsg: "synthetic provider failed after receipt", usage: { input: 3, output: 1 } };
      const completion = mode === "manual" ? {
        state: "awaiting_user", evidence: ["fixture device awaits local confirmation"],
        dependency: { kind: "physical_action", detail: "Confirm the fixture device, then verify.", evidence: ["fixture device awaits local confirmation"],
          manual_action: { command: "fixture-device confirm", verify_command: "fixture-device status", resume_phrase: "Fixture device verified", hints: [{ term: "device", detail: "Use the local fixture device only." }] } },
        final_answer: "The fixture device requires confirmation before the task can finish.",
      } : mode === "awaiting" ? {
        state: "awaiting_user", evidence: ["fixture platform reports processing pending"],
        dependency: { kind: "external_state", detail: "Wait for fixture platform processing; do not upload again.", evidence: ["fixture platform reports processing pending"] },
      } : { state: "verified", evidence: [RECEIPT], ...(mode === "pending" ? { final_answer: FALSE_CLAIM } : {}) };
      return response([
        ...(mode === "pending" ? [{ id: "todo", name: "todo_write", input: { todos: [
          { text: "Verify fixture platform playback", status: "pending", activeForm: "Verifying fixture platform playback" },
        ] } }] : []),
        { id: "receipt", name: "task_checkpoint", input: { completion } },
      ], mode === "pending" ? FALSE_CLAIM : "");
    }
    return { text: "EXTRA_PROVIDER_ROUND_IS_A_CLOSEOUT_BUG", stop: "end", toolUses: [], usage: { input: 3, output: 1 } };
  } };
  const store = memoryStore();
  server = await startServe({ host: "127.0.0.1", port: 0, token: "synthetic-closeout-token", cwd: root }, {
    version: "0.0.0-test", providerId: provider.id, model: provider.model, buildSessionProvider: async () => provider,
    spawnSubagent: async () => "no child authority", sandbox: "off", approval: "full-auto", guardian: { enabled: false },
    store, quietDiscovery: true, discoveryHome: root, agentTeamHome: root, artifactHome: root,
    runLimits: () => ({ timeoutMs: 10_000, maxRounds: 6 }), autoCompact: () => ({ enabled: false }),
    computerSettings: () => ({ mode: "off", apps: [] }), saveComputerSettings: input => input,
    runtimeInfo: () => ({ providerId: provider.id, model: provider.model, profileId: "personal", spaceId: "personal" }),
  });
  client = await connect(server.port);
  assert.ok((await client.call("initialize", { token: "synthetic-closeout-token" })).result);
  const created = await client.call("session.create", { cwd: root });
  assert.ok(created.result, JSON.stringify(created));
  const sessionId = created.result.sessionId;
  const sent = await client.call("session.send", { sessionId, text: "Write the synthetic upload receipt exactly once and verify its accepted checks." });
  return { root, client, store, sessionId, sent, calls: () => calls };
}

for (const [mode, expectedState] of [["awaiting", "paused"], ["manual", "paused"], ["pending", "paused"], ["verified", "completed"]]) {
  test(`Serve ${mode} closeout has one nonempty consistent reply and final ${expectedState} state without another model request`, { timeout: 15_000 }, async t => {
    const f = await fixture(t, mode);
    assert.equal(f.sent.error, undefined, JSON.stringify(f.sent));
    assert.equal(f.calls(), 3, "a receipt without final prose must not incur a fourth provider request");
    assert.equal(f.sent.result.usage.requests, 3);
    const reply = f.sent.result.reply;
    assert.ok(reply.trim(), "request/response clients receive the same Engine-owned closing message");
    const events = f.client.events.filter(event => event.params.sessionId === f.sessionId);
    const ends = events.filter(event => event.method === "event.turn_end");
    assert.equal(ends.length, 1);
    assert.equal(ends[0].params.error, undefined);
    assert.equal(ends[0].params.reply, reply);
    assert.equal(ends[0].params.usage.requests, 3);
    assert.equal(events.filter(event => event.method === "event.text").map(event => event.params.delta).join(""), reply);
    const taskState = events.filter(event => event.method === "event.task_state").at(-1).params;
    assert.equal(taskState.phase, "finished");
    assert.equal(taskState.state, expectedState);
    assert.equal(taskState.taskStatus, expectedState);
    const saved = f.store.records.get(f.sessionId);
    assert.equal(saved.task.status, expectedState);
    assert.equal(lastAssistantText(saved.history), reply);
    assert.equal(historyForClient(saved.history).filter(row => row.role === "assistant").at(-1)?.text, reply);
    assert.equal(events.filter(event => event.method === "event.tool" && event.params.name === "write_file").length, 1, "closeout never repeats the synthetic delivery");
    assert.equal(readFileSync(join(f.root, "upload-receipt.txt"), "utf8"), `${RECEIPT}\n`);
    assert.doesNotMatch(reply, /EXTRA_PROVIDER_ROUND|UNACCEPTED_ALL_UPLOAD_CHECKS_COMPLETE/u);
    if (expectedState === "paused") {
      assert.equal(f.sent.result.status, "paused");
      assert.equal(ends[0].params.status, "paused");
      assert.match(reply, /not fully complete|unfinished|paused|暂停|未.*完成/iu);
      assert.match(reply, mode === "awaiting" ? /processing/iu : mode === "manual" ? /fixture device/iu : /playback/iu);
      if (mode === "manual") {
        for (const field of ["fixture-device confirm", "fixture-device status", "Fixture device verified", "Use the local fixture device only."]) assert.ok(reply.includes(field), field);
        assert.match(reply, /copy only|copy-only|not executed/iu);
      }
    } else {
      assert.equal(f.sent.result.status, undefined);
      assert.notEqual(ends[0].params.status, "paused");
      assert.ok(reply.includes(RECEIPT));
    }
  });
}

test("Serve provider failure preserves the stopped handoff in events and history without turning RPC failure into success", { timeout: 15_000 }, async t => {
  const f = await fixture(t, "provider_error");
  assert.ok(f.sent.error, "provider failure remains an RPC error");
  assert.equal(f.sent.result, undefined);
  assert.equal(f.calls(), 3, "no extra summary request after failure");
  const events = f.client.events.filter(event => event.params.sessionId === f.sessionId);
  const ends = events.filter(event => event.method === "event.turn_end");
  assert.equal(ends.length, 1);
  assert.equal(ends[0].params.status, "error");
  assert.match(ends[0].params.error, /synthetic provider failed/);
  const reply = ends[0].params.reply;
  assert.ok(reply.trim(), "the terminal error does not erase an already delivered handoff");
  assert.match(reply, /blocked|stopped/iu);
  assert.doesNotMatch(reply, /task is paused|\/continue/iu);
  assert.equal(events.filter(event => event.method === "event.text").map(event => event.params.delta).join(""), reply);
  const saved = f.store.records.get(f.sessionId);
  assert.equal(saved.task.status, "blocked");
  assert.equal(lastAssistantText(saved.history), reply);
  assert.equal(historyForClient(saved.history).filter(row => row.role === "assistant").at(-1)?.text, reply);
  assert.equal(events.filter(event => event.method === "event.task_state").at(-1).params.taskStatus, "blocked");
  assert.equal(events.filter(event => event.method === "event.tool" && event.params.name === "write_file").length, 1);
  assert.equal(readFileSync(join(f.root, "upload-receipt.txt"), "utf8"), `${RECEIPT}\n`);
});
