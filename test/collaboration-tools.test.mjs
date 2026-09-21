import test from "node:test";
import assert from "node:assert/strict";
import "../dist/tools/collaboration.js";
import { getTool, toolOperationTraits } from "../dist/tools/registry.js";
import { runAgent } from "../dist/agent/loop.js";

const baseAgent = {
  id: "d94efdb0-3142-4fef-a3bf-395ed0a8be21",
  path: "/root/audit",
  name: "audit",
  parentPath: "/root",
  runtime: "hara",
  runtimeGrants: [],
  status: "working",
  generation: 1,
  createdAt: "2026-09-06T00:00:00.000Z",
  updatedAt: "2026-09-06T00:00:00.000Z",
  queuedAt: "2026-09-06T00:00:00.000Z",
  pendingMessages: 0,
  hasResult: false,
};

const fakeTeam = (calls, options = {}) => ({
  path: options.path ?? "/root",
  runtimeGrants: options.runtimeGrants ?? ["codex", "claude"],
  async spawn(input) {
    calls.push(["spawn", input]);
    return baseAgent;
  },
  async sendMessage(target, message, commandId) {
    calls.push(["message", target, message, commandId]);
    return { ...baseAgent, pendingMessages: 1 };
  },
  async followup(target, message, commandId) {
    calls.push(["followup", target, message, commandId]);
    return { ...baseAgent, generation: 2 };
  },
  async interrupt(target) {
    calls.push(["interrupt", target]);
    return { ...baseAgent, status: "stopping" };
  },
  async resume(target) {
    calls.push(["resume", target]);
    return { ...baseAgent, generation: 2 };
  },
  list() {
    calls.push(["list"]);
    return [baseAgent];
  },
  async wait(target, timeoutMs) {
    calls.push(["wait", target, timeoutMs]);
    return { agent: { ...baseAgent, status: "completed", hasResult: true }, settled: true, result: "done" };
  },
  async inspectDiff(target) {
    calls.push(["inspect-diff", target]);
    return {
      agentId: baseAgent.id,
      agentPath: baseAgent.path,
      mode: "isolated-write",
      state: "changes",
      patch: "diff --git a/a b/a\n",
    };
  },
  async applyDiff(target) {
    calls.push(["apply-diff", target]);
    return { mode: "isolated-write", state: "applied" };
  },
  async rejectDiff(target) {
    calls.push(["reject-diff", target]);
    return { mode: "isolated-write", state: "rejected" };
  },
  async createRoom(input, commandId) {
    calls.push(["room-create", input, commandId]);
    return {
      id: "5af25ec8-d2e1-42ba-9971-362b10d99692",
      name: input.name,
      ownerPath: "/root",
      participantPaths: ["/root", baseAgent.path],
      createdAt: "2026-09-20T00:00:00.000Z",
      updatedAt: "2026-09-20T00:00:00.000Z",
      messageCount: 0,
    };
  },
  async postRoom(input, commandId) {
    calls.push(["room-post", input, commandId]);
    return {
      id: "5af25ec8-d2e1-42ba-9971-362b10d99692",
      name: "review",
      ownerPath: "/root",
      participantPaths: ["/root", baseAgent.path],
      createdAt: "2026-09-20T00:00:00.000Z",
      updatedAt: "2026-09-20T00:00:01.000Z",
      messageCount: 1,
      messages: [{
        id: "57af19a8-3249-4846-b8c1-b74c9b392829",
        sourcePath: "/root",
        recipientPaths: [baseAgent.path],
        content: input.message,
        createdAt: "2026-09-20T00:00:01.000Z",
      }],
    };
  },
  listRooms() {
    calls.push(["room-list"]);
    return [];
  },
  readRoom(room, limit) {
    calls.push(["room-read", room, limit]);
    return { id: room, name: "review", participantPaths: ["/root"], messageCount: 0, messages: [] };
  },
  async closeRoom(room) {
    calls.push(["room-close", room]);
    return { id: room, name: "review", participantPaths: ["/root"], messageCount: 0 };
  },
});

test("collaboration tools use a scoped durable team and classify mailbox mutation as serial state", async () => {
  const calls = [];
  const ctx = { cwd: process.cwd(), spaceId: "personal", agentTeam: fakeTeam(calls), toolCallId: "provider-call-1" };
  const spawn = getTool("spawn_agent");
  assert.ok(spawn);
  assert.deepEqual(toolOperationTraits(spawn, {}, ctx), { effect: "state", concurrencySafe: false });
  const created = JSON.parse(await spawn.run({ task_name: "audit", message: "inspect" }, ctx));
  assert.equal(created.path, "/root/audit");
  assert.deepEqual(toolOperationTraits(spawn, { runtime: "codex" }, ctx), {
    effect: "exec",
    concurrencySafe: false,
    approvalKind: "exec",
    requiresExplicitApproval: true,
  });

  const message = getTool("send_message");
  const queued = JSON.parse(await message.run({ target: created.id, message: "new context" }, ctx));
  assert.equal(queued.pendingMessages, 1);
  assert.deepEqual(calls[1], ["message", created.id, "new context", "provider-call-1"]);

  const waited = JSON.parse(await getTool("wait_agent").run({ target: created.id, timeout_ms: 25 }, ctx));
  assert.equal(waited.result, "done");
  assert.deepEqual(calls[0], ["spawn", { taskName: "audit", message: "inspect", runtime: "hara" }]);
  assert.deepEqual(calls.at(-1), ["wait", created.id, 25]);

  const inspected = JSON.parse(await getTool("inspect_agent_diff").run({ target: created.id }, ctx));
  assert.match(inspected.patch, /diff --git/u);
  const applied = JSON.parse(await getTool("apply_agent_diff").run({ target: created.id }, ctx));
  assert.equal(applied.state, "applied");
  assert.deepEqual(toolOperationTraits(getTool("apply_agent_diff"), { target: created.id }, ctx), {
    effect: "edit",
    concurrencySafe: false,
    requiresExplicitApproval: true,
  });
  const rejected = JSON.parse(await getTool("reject_agent_diff").run({ target: created.id }, ctx));
  assert.equal(rejected.state, "rejected");

  const room = JSON.parse(await getTool("agent_room").run({
    action: "create",
    name: "review",
    members: [created.id],
  }, ctx));
  assert.equal(room.name, "review");
  const posted = JSON.parse(await getTool("agent_room").run({
    action: "post",
    room: room.id,
    message: "compare findings",
  }, ctx));
  assert.equal(posted.messageCount, 1);
  assert.deepEqual(calls.find((entry) => entry[0] === "room-create"), [
    "room-create",
    { name: "review", members: [created.id] },
    "provider-call-1",
  ]);
  assert.deepEqual(calls.find((entry) => entry[0] === "room-post"), [
    "room-post",
    { room: room.id, message: "compare findings" },
    "provider-call-1",
  ]);
});

test("collaboration tools fail clearly outside a persistent Agent-team context", async () => {
  const result = await getTool("spawn_agent").run(
    { task_name: "audit", message: "inspect" },
    { cwd: process.cwd() },
  );
  assert.match(result, /durable Agent teams are unavailable/i);
});

test("local coding runtimes fail closed outside Personal Space without requesting execution approval", async () => {
  const calls = [];
  const ctx = {
    cwd: process.cwd(),
    spaceId: "org:company",
    agentTeam: fakeTeam(calls),
    toolCallId: "provider-call-company",
  };
  const spawn = getTool("spawn_agent");
  assert.deepEqual(toolOperationTraits(spawn, { runtime: "codex" }, ctx), {
    effect: "state",
    concurrencySafe: false,
  });
  const result = await spawn.run({
    task_name: "review",
    message: "inspect company source",
    runtime: "codex",
  }, ctx);
  assert.match(result, /only in Personal Space/i);
  assert.equal(calls.length, 0);
});

test("a Hara Agent can invoke only explicitly granted coding runtimes", async () => {
  const calls = [];
  const ctx = {
    cwd: process.cwd(),
    spaceId: "personal",
    agentTeam: fakeTeam(calls, { path: "/root/reviewer", runtimeGrants: ["codex"] }),
    toolCallId: "provider-call-granted",
  };
  const spawn = getTool("spawn_agent");
  assert.deepEqual(toolOperationTraits(spawn, { runtime: "codex" }, ctx), {
    effect: "exec",
    concurrencySafe: false,
    approvalKind: "exec",
  }, "the user's durable per-Agent grant authorizes bounded child launches without a fake headless prompt");
  const codex = JSON.parse(await spawn.run({
    task_name: "codex_fix",
    message: "Implement the bounded fix.",
    runtime: "codex",
  }, ctx));
  assert.equal(codex.path, baseAgent.path);
  assert.deepEqual(calls[0], ["spawn", {
    taskName: "codex_fix",
    message: "Implement the bounded fix.",
    runtime: "codex",
  }]);

  const claude = await spawn.run({
    task_name: "claude_fix",
    message: "Implement the bounded fix.",
    runtime: "claude",
  }, ctx);
  assert.match(claude, /has not been granted the claude coding runtime/i);
  assert.equal(calls.length, 1, "an ungranted runtime never reaches the team controller");
});

test("durable collaboration schemas are advertised only when the host supplies a team", async () => {
  const seen = [];
  const provider = {
    id: "fake",
    model: "fake-model",
    async turn({ tools }) {
      seen.push(tools.map((tool) => tool.name));
      return { text: "done", toolUses: [], stop: "end" };
    },
  };
  await runAgent([{ role: "user", content: "inspect" }], {
    provider,
    ctx: { cwd: process.cwd() },
    approval: "full-auto",
    confirm: async () => true,
    quiet: true,
  });
  await runAgent([{ role: "user", content: "inspect" }], {
    provider,
    ctx: { cwd: process.cwd(), agentTeam: fakeTeam([]) },
    approval: "full-auto",
    confirm: async () => true,
    quiet: true,
  });
  for (const tool of [
    "spawn_agent", "send_message", "agent_room", "followup_task", "interrupt_agent", "resume_agent", "list_agents", "wait_agent",
    "inspect_agent_diff", "apply_agent_diff", "reject_agent_diff",
  ]) {
    assert.equal(seen[0].includes(tool), false, `${tool} stays out of a direct-run prompt`);
    assert.equal(seen[1].includes(tool), true, `${tool} is visible in a persistent Agent-team run`);
  }
});
