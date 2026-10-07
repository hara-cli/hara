import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import WebSocket from "ws";

// Optional compiler output used only by this hermetic loopback/mock test. Never start a real model,
// desktop, external Agent or tool service; all writes are approved synthetic files in a private tmp dir.
const buildRoot = process.env.HARA_SERVE_TASK_APPROVAL_TEST_BUILD_ROOT;
const { startServe } = await import(buildRoot
  ? pathToFileURL(join(resolve(buildRoot), "serve/server.js")).href : new URL("../dist/serve/server.js", import.meta.url).href);

const connect = (port) => new Promise((resolveConnection, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const events = [];
  const pending = new Map();
  let next = 0;
  ws.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    if (pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
    else if (message.method) events.push(message);
  });
  ws.once("error", reject);
  ws.once("open", () => resolveConnection({ ws, events,
    call(method, params = {}) {
      return new Promise((finish, fail) => {
        const id = ++next;
        const timer = setTimeout(() => { pending.delete(id); fail(new Error(`RPC timed out: ${method}`)); }, 5_000);
        timer.unref();
        pending.set(id, (message) => { clearTimeout(timer); finish(message); });
        ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      });
    },
    async event(method, predicate = () => true) {
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        const event = events.find((candidate) => candidate.method === method && predicate(candidate.params));
        if (event) return event.params;
        await new Promise((resolveTick) => setTimeout(resolveTick, 5));
      }
      throw new Error(`event timed out: ${method}`);
    },
  }));
});

function memoryStore() {
  const records = new Map();
  return { records,
    load: (id) => records.get(id) ?? null,
    save: (meta, history, task) => records.set(meta.id, structuredClone({ meta, history, task })),
    list: () => [...records.values()].map((record) => record.meta),
    acquire: () => ({ ok: true }), release() {}, delete: (id) => records.delete(id),
  };
}

async function fixture(t, { compatible = true, action = "write_file", approval = "suggest" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "hara-serve-task-grants-"));
  writeFileSync(join(root, "package.json"), "{}\n");
  let releaseHold;
  const hold = new Promise((resolveHold) => { releaseHold = resolveHold; });
  let round = 0;
  const tool = (id) => ({ id, name: action,
    input: action === "write_file" ? { path: `${id}.txt`, content: id }
      : action === "bash" ? { command: `printf ${id}` }
      : { code: `print('${id}')` } });
  const provider = { id: "mock", model: "mock-1", async turn(args) {
    assert.equal(JSON.stringify(args).includes("grantFromHuman"), false);
    const index = round++;
    if (index === 0) return { text: "", stop: "tool_use", toolUses: [{ id: "brief", name: "task_intake", input: {
      intent: "change", goal: "write only the synthetic fixture files", constraints: ["no network or user files"],
      acceptance: ["fixture files contain the requested text"], steps: ["write first", "write second", "verify"],
    } }] };
    if (index === 1) return { text: "", stop: "tool_use", toolUses: [tool("first")] };
    if (index === 2) {
      await Promise.race([hold, new Promise((resolveAbort) => {
        if (args.signal.aborted) resolveAbort();
        else args.signal.addEventListener("abort", resolveAbort, { once: true });
      })]);
      if (args.signal.aborted) throw new Error("synthetic provider interrupted");
      return { text: "", stop: "tool_use", toolUses: [tool("second")] };
    }
    if (index === 3) return { text: "", stop: "tool_use", toolUses: [{ id: "verified", name: "task_checkpoint", input: {
      completion: { state: "verified", evidence: ["synthetic fixture completed"], final_answer: "Done." },
    } }] };
    return { text: "Done.", stop: "end", toolUses: [] };
  } };
  const store = memoryStore();
  const server = await startServe({ host: "127.0.0.1", port: 0, token: "fixture-token", cwd: root }, {
    version: "0.0.0-test", providerId: "mock", model: "mock-1", buildSessionProvider: async () => provider,
    spawnSubagent: async () => "no child authority", sandbox: "off", approval, guardian: { enabled: false },
    store, quietDiscovery: true, discoveryHome: root, agentTeamHome: root, artifactHome: root,
    runLimits: () => ({ timeoutMs: 10_000, maxRounds: 10 }),
    computerSettings: () => ({ mode: "off", apps: [] }),
    saveComputerSettings: (input) => input,
    runtimeInfo: () => ({ providerId: "mock", model: "mock-1", profileId: "personal", spaceId: "personal" }),
  });
  const clients = [];
  const newClient = async (taskFeature = compatible) => {
    const client = await connect(server.port);
    clients.push(client);
    client.hello = await client.call("initialize", { token: "fixture-token", capabilities: {
      features: taskFeature ? ["task.approvals.v1"] : [],
    } });
    return client;
  };
  const client = await newClient();
  const created = await client.call("session.create", { cwd: root });
  assert.ok(created.result, JSON.stringify(created));
  const sessionId = created.result.sessionId;
  t.after(async () => { releaseHold(); await server.close(); for (const other of clients) other.ws.terminate(); rmSync(root, { recursive: true, force: true }); });
  return { root, server, client, sessionId, store, newClient, releaseHold,
    start: () => client.call("session.submit", { sessionId, text: "Write only the synthetic fixture files.", mode: "start_if_idle", commandId: randomUUID() }),
    card: (c = client, skipId) => c.event("approval.request", (card) => card.sessionId === sessionId && card.approvalId !== skipId),
    answer: (card, overrides = {}, c = client) => c.call("approval.reply", {
      approvalId: card.approvalId, sessionId, scope: "session", allow: true, forTask: true, commandId: randomUUID(), ...overrides,
    }),
    snapshot: (c = client) => c.call("events.snapshot", { sessionIds: [sessionId] }),
  };
}

test("negotiated foreground card restores safe descriptor and actual pending expiry without authority", async (t) => {
  const f = await fixture(t);
  assert.ok(f.client.hello.result.capabilities.features.includes("task.approvals.v1"));
  assert.ok(f.client.hello.result.capabilities.methods.includes("session.task-approval.revoke"));
  assert.ok(f.client.hello.result.capabilities.events.includes("event.task_approval_state"));
  const running = f.start();
  const card = await f.card();
  assert.equal(card.allowForTask, true);
  assert.equal(card.taskApproval.toolFamily, "file-change");
  assert.equal(card.taskApproval.durationMs, 900_000);
  assert.ok(Date.parse(card.expiresAt) > Date.now());
  assert.ok(card.deliveryCursor.sequence > 0);
  const snapshot = (await f.snapshot()).result;
  assert.deepEqual(snapshot.approvals[0].taskApproval, card.taskApproval);
  assert.equal(snapshot.approvals[0].expiresAt, card.expiresAt);
  assert.equal(snapshot.taskApprovalStates[0].active, false);
  assert.equal(JSON.stringify(snapshot).includes("grantFromHuman"), false);
  assert.equal(JSON.stringify(snapshot.taskStates).includes("taskApproval"), false);
  const resume = await f.client.call("session.resume", { sessionId: f.sessionId });
  assert.ok(resume.result, JSON.stringify(resume));
  assert.deepEqual(resume.result.pendingApprovals[0].taskApproval, card.taskApproval);
  assert.equal(resume.result.pendingApprovals[0].expiresAt, card.expiresAt);
  assert.ok((await f.client.call("session.resume", { sessionId: f.sessionId, approval: "full-auto" })).error,
    "busy foreground read does not permit policy changes");
  assert.equal(JSON.stringify([...f.store.records.values()]).includes("taskApproval"), false);
  await f.client.call("session.interrupt", { sessionId: f.sessionId });
  await running;
});

test("explicit task reply permits next same-family action, retries once, and completion withdraws state", async (t) => {
  const f = await fixture(t);
  const running = f.start();
  const card = await f.card();
  const commandId = randomUUID();
  const answer = await f.answer(card, { commandId });
  assert.equal(answer.result.taskApprovalState.active, true, JSON.stringify(answer));
  assert.deepEqual(answer.result.taskApprovalState.toolFamilies, ["file-change"]);
  const retry = await f.answer(card, { commandId });
  assert.equal(retry.result.taskApprovalState.active, true);
  assert.deepEqual(retry.result.taskApprovalState.toolFamilies, answer.result.taskApprovalState.toolFamilies);
  assert.equal((await f.answer(card)).error?.code, -32005, "new command cannot re-grant a resolved card");
  assert.ok((await f.answer(card, { commandId, allow: false, forTask: false })).error);
  assert.equal((await f.snapshot()).result.taskApprovalStates[0].active, true);
  f.releaseHold();
  assert.ok((await running).result);
  assert.equal(readFileSync(join(f.root, "second.txt"), "utf8"), "second");
  assert.equal(f.client.events.filter((event) => event.method === "approval.request").length, 1);
  assert.equal((await f.snapshot()).result.taskApprovalStates[0].active, false);
  assert.equal((await f.client.call("session.resume", { sessionId: f.sessionId })).result.taskApprovalState.active, false);
  assert.equal((await f.answer(card, { commandId })).result.taskApprovalState.active, false,
    "completed cached receipt replay projects fresh state and never invokes the old writer");
});

test("ordinary allow never invokes the task writer or skips the next confirmation", async (t) => {
  const f = await fixture(t);
  const running = f.start();
  const first = await f.card();
  assert.ok((await f.answer(first, { forTask: false })).result);
  assert.equal((await f.snapshot()).result.taskApprovalStates[0].active, false);
  f.releaseHold();
  const second = await f.card(f.client, first.approvalId);
  assert.notEqual(first.approvalId, second.approvalId);
  await f.answer(second, { forTask: false });
  assert.ok((await running).result);
});

test("legacy original submission cannot acquire task authority when a capable observer joins", async (t) => {
  const f = await fixture(t, { compatible: false });
  const running = f.start();
  const first = await f.card();
  assert.equal(first.allowForTask, undefined);
  const capable = await f.newClient(true);
  assert.equal((await f.snapshot(capable)).result.approvals[0].taskApproval, undefined);
  assert.ok((await f.answer(first, {}, capable)).error);
  assert.equal(existsSync(join(f.root, "first.txt")), false);
  await f.answer(first, { forTask: false });
  f.releaseHold();
  const second = await f.card(f.client, first.approvalId);
  assert.equal(second.allowForTask, undefined);
  await f.answer(second, { forTask: false });
  assert.ok((await running).result);
});

test("malformed, simultaneous always, wrong-session and unnegotiated task choices do not consume pending", async (t) => {
  const f = await fixture(t);
  const running = f.start();
  const card = await f.card();
  const observer = await f.newClient(false);
  for (const overrides of [{ always: true }, { forTask: "true" }, { allow: "yes" }, { allow: false },
    { commandId: undefined }, { scope: "external" }, { sessionId: "different-session" }]) {
    assert.ok((await f.answer(card, overrides)).error, JSON.stringify(overrides));
  }
  assert.ok((await f.answer(card, {}, observer)).error);
  assert.equal((await f.snapshot()).result.approvals.length, 1);
  assert.equal(existsSync(join(f.root, "first.txt")), false);
  await f.answer(card);
  f.releaseHold();
  assert.ok((await running).result);
});

for (const change of ["revoke", "policy", "disconnect", "control"]) {
  test(`${change} invalidates an outstanding task choice but leaves ordinary approval possible`, async (t) => {
    const f = await fixture(t);
    const running = f.start();
    const card = await f.card();
    let current = f.client;
    let lease;
    if (change === "revoke") assert.ok((await current.call("session.task-approval.revoke", { sessionId: f.sessionId, commandId: randomUUID() })).result);
    if (change === "policy") assert.ok((await current.call("settings.computer.save", { mode: "off", apps: [] })).result);
    if (change === "disconnect") {
      running.catch(() => {});
      await new Promise((finish) => { current.ws.once("close", finish); current.ws.close(); });
      current = await f.newClient();
    }
    if (change === "control") lease = (await current.call("session.control.acquire", { sessionId: f.sessionId })).result.lease;
    const snapshot = (await f.snapshot(current)).result;
    assert.equal(snapshot.approvals[0].allowForTask, undefined);
    assert.equal(snapshot.taskApprovalStates[0].active, false);
    assert.ok((await f.answer(card, { ...(lease ? { controlLease: lease } : {}) }, current)).error);
    assert.equal(existsSync(join(f.root, "first.txt")), false);
    await f.answer(card, { forTask: false, ...(lease ? { controlLease: lease } : {}) }, current);
    f.releaseHold();
    const second = await f.card(current, card.approvalId);
    assert.equal(second.allowForTask, undefined, "same stale execution cannot mint another task grant");
    await f.answer(second, { forTask: false, ...(lease ? { controlLease: lease } : {}) }, current);
    if (change === "disconnect") await current.event("event.turn_end", (event) => event.sessionId === f.sessionId);
    else await running;
  });
}

test("revocation is ownership checked and idempotent; revoked planned reuse requires a new approval", async (t) => {
  const f = await fixture(t);
  const lease = (await f.client.call("session.control.acquire", { sessionId: f.sessionId })).result.lease;
  const observer = await f.newClient();
  const running = f.client.call("session.submit", { sessionId: f.sessionId, text: "Write the fixture files.",
    mode: "start_if_idle", commandId: randomUUID(), controlLease: lease });
  const card = await f.card();
  assert.ok((await f.answer(card, {}, observer)).error);
  assert.ok((await f.answer(card, { controlLease: lease })).result);
  assert.ok((await observer.call("session.task-approval.revoke", { sessionId: f.sessionId, commandId: randomUUID() })).error);
  assert.equal((await f.snapshot()).result.taskApprovalStates[0].active, true);
  const params = { sessionId: f.sessionId, commandId: randomUUID(), controlLease: lease };
  const revoked = await f.client.call("session.task-approval.revoke", params);
  assert.equal(revoked.result.taskApprovalState.active, false);
  const duplicate = await f.client.call("session.task-approval.revoke", params);
  assert.deepEqual(duplicate.result, revoked.result);
  f.releaseHold();
  const second = await f.card(f.client, card.approvalId);
  await f.answer(second, { forTask: false, controlLease: lease });
  await running;
});

test("last disconnect withdraws an accepted grant immediately, without extending approval reconnect grace", async (t) => {
  const f = await fixture(t);
  const running = f.start();
  const card = await f.card();
  await f.answer(card);
  await new Promise((finish) => { f.client.ws.once("close", finish); f.client.ws.close(); });
  const current = await f.newClient();
  assert.equal((await f.snapshot(current)).result.taskApprovalStates[0].active, false);
  f.releaseHold();
  const second = await f.card(current, card.approvalId);
  assert.equal(second.allowForTask, undefined);
  await f.answer(second, { forTask: false }, current);
  await current.event("event.turn_end", (event) => event.sessionId === f.sessionId);
  // The disconnected caller cannot receive its terminal response; do not wait for its RPC timeout.
  running.catch(() => {});
});

test("originating human socket disconnect withdraws a grant even while another authenticated observer stays", async (t) => {
  const f = await fixture(t);
  const observer = await f.newClient();
  const running = f.start();
  running.catch(() => {});
  const card = await f.card();
  await f.answer(card);
  assert.equal((await f.snapshot(observer)).result.taskApprovalStates[0].active, true);
  await new Promise((finish) => { f.client.ws.once("close", finish); f.client.ws.close(); });
  await observer.event("event.task_approval_state", (event) => event.sessionId === f.sessionId && event.active === false);
  assert.equal((await f.snapshot(observer)).result.taskApprovalStates[0].active, false);
  f.releaseHold();
  const second = await f.card(observer, card.approvalId);
  assert.equal(second.allowForTask, undefined);
  await f.answer(second, { forTask: false }, observer);
  await observer.event("event.turn_end", (event) => event.sessionId === f.sessionId);
});

test("conservative Python operation is one-action approved and cannot be task granted", async (t) => {
  const f = await fixture(t, { action: "python" });
  const running = f.start();
  const first = await f.card();
  assert.equal(first.allowForTask, undefined);
  assert.equal(first.taskApproval, undefined);
  assert.ok((await f.answer(first)).error);
  await f.answer(first, { allow: false, forTask: false });
  f.releaseHold();
  const second = await f.card(f.client, first.approvalId);
  assert.equal(second.allowForTask, undefined);
  await f.answer(second, { allow: false, forTask: false });
  await running;
});

test("Bash uses its own task family, not a file-change grant", async (t) => {
  const f = await fixture(t, { action: "bash" });
  const running = f.start();
  const first = await f.card();
  assert.equal(first.taskApproval.toolFamily, "bash");
  const accepted = await f.answer(first);
  assert.deepEqual(accepted.result.taskApprovalState.toolFamilies, ["bash"]);
  f.releaseHold();
  assert.ok((await running).result);
  assert.equal(f.client.events.filter((event) => event.method === "approval.request").length, 1);
});

test("full-auto does not advertise a human task choice or create reusable task state", async (t) => {
  const f = await fixture(t, { approval: "full-auto" });
  const running = f.start();
  f.releaseHold();
  assert.ok((await running).result);
  assert.equal(f.client.events.filter((event) => event.method === "approval.request").length, 0);
  assert.equal((await f.snapshot()).result.taskApprovalStates[0].active, false);
});

test("wall-clock jumps cannot hide an active monotonic grant or its revoke affordance", async (t) => {
  const f = await fixture(t);
  const running = f.start();
  await f.answer(await f.card());
  const original = Date.now;
  try {
    Date.now = () => original() + 3_600_000;
    const state = (await f.snapshot()).result.taskApprovalStates[0];
    assert.equal(state.active, true);
    assert.equal(state.canRevoke, true);
    assert.ok(Date.parse(state.expiresAt) > Date.now());
  } finally { Date.now = original; }
  f.releaseHold();
  assert.ok((await running).result);
});

test("losing original operation validity revokes hidden family authority before projecting inactive", async (t) => {
  const f = await fixture(t, { action: "bash" });
  const running = f.start();
  const first = await f.card();
  await f.answer(first);
  mkdirSync(join(f.root, ".hara"), { recursive: true });
  writeFileSync(join(f.root, ".hara", "permissions.json"), JSON.stringify({ deny: ["printf first"] }));
  assert.equal((await f.snapshot()).result.taskApprovalStates[0].active, false);
  f.releaseHold();
  const second = await f.card(f.client, first.approvalId);
  assert.equal(second.allowForTask, undefined);
  await f.answer(second, { forTask: false });
  await running;
});

test("a capable observer without a lease cannot invoke the originating human's task writer", async (t) => {
  const f = await fixture(t);
  const observer = await f.newClient();
  const running = f.start();
  const first = await f.card();
  const observed = await f.card(observer);
  assert.equal(observed.allowForTask, undefined);
  assert.equal((await f.snapshot(observer)).result.approvals[0].taskApproval, undefined);
  assert.ok((await f.answer(first, {}, observer)).error);
  assert.equal((await f.snapshot()).result.approvals[0].allowForTask, true, "unauthorized observer cannot consume or revoke the pending choice");
  assert.equal(existsSync(join(f.root, "first.txt")), false);
  const commandId = randomUUID();
  await f.answer(first, { commandId });
  await f.client.call("session.task-approval.revoke", { sessionId: f.sessionId, commandId: randomUUID() });
  const oldReceipt = await f.answer(first, { commandId });
  assert.equal(oldReceipt.result.taskApprovalState.active, false, "a receipt cannot resurrect revoked authority");
  f.releaseHold();
  const second = await f.card(f.client, first.approvalId);
  await f.answer(second, { forTask: false });
  await running;
});

test("expired grant receipt retry projects inactive state without resurrecting its writer", async (t) => {
  const f = await fixture(t);
  const running = f.start();
  const first = await f.card();
  const commandId = randomUUID();
  await f.answer(first, { commandId });
  const monotonicAt = performance.now();
  const clock = t.mock.method(performance, "now", () => monotonicAt + 900_001);
  try {
    const retried = await f.answer(first, { commandId });
    assert.equal(retried.result.taskApprovalState.active, false);
    assert.equal(retried.result.taskApprovalState.canRevoke, false);
  } finally { clock.mock.restore(); }
  f.releaseHold();
  const second = await f.card(f.client, first.approvalId);
  assert.equal(second.allowForTask, undefined);
  await f.answer(second, { forTask: false });
  await running;
});

test("old revoke receipt retry preserves a later explicit grant and projects its active state", async (t) => {
  const f = await fixture(t);
  const revokeParams = { sessionId: f.sessionId, commandId: randomUUID() };
  const initialRevoke = await f.client.call("session.task-approval.revoke", revokeParams);
  assert.equal(initialRevoke.result.taskApprovalState.active, false);
  const running = f.start();
  const first = await f.card();
  assert.equal((await f.answer(first)).result.taskApprovalState.active, true);
  const oldRevokeRetry = await f.client.call("session.task-approval.revoke", revokeParams);
  assert.equal(oldRevokeRetry.result.taskApprovalState.active, true,
    "retry projects actual state instead of the old inactive receipt");
  assert.equal((await f.snapshot()).result.taskApprovalStates[0].active, true,
    "idempotent replay did not re-run revocation against the later grant");
  f.releaseHold();
  assert.ok((await running).result);
  assert.equal(readFileSync(join(f.root, "second.txt"), "utf8"), "second");
  assert.equal(f.client.events.filter((event) => event.method === "approval.request").length, 1);
});
