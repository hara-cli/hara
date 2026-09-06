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
  status: "working",
  generation: 1,
  createdAt: "2026-09-06T00:00:00.000Z",
  updatedAt: "2026-09-06T00:00:00.000Z",
  queuedAt: "2026-09-06T00:00:00.000Z",
  pendingMessages: 0,
  hasResult: false,
};

const fakeTeam = (calls) => ({
  path: "/root",
  async spawn(input) {
    calls.push(["spawn", input]);
    return baseAgent;
  },
  async sendMessage(target, message) {
    calls.push(["message", target, message]);
    return { ...baseAgent, pendingMessages: 1 };
  },
  async followup(target, message) {
    calls.push(["followup", target, message]);
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
});

test("collaboration tools use a scoped durable team and classify mailbox mutation as serial state", async () => {
  const calls = [];
  const ctx = { cwd: process.cwd(), agentTeam: fakeTeam(calls) };
  const spawn = getTool("spawn_agent");
  assert.ok(spawn);
  assert.deepEqual(toolOperationTraits(spawn, {}, ctx), { effect: "state", concurrencySafe: false });
  const created = JSON.parse(await spawn.run({ task_name: "audit", message: "inspect" }, ctx));
  assert.equal(created.path, "/root/audit");

  const message = getTool("send_message");
  const queued = JSON.parse(await message.run({ target: created.id, message: "new context" }, ctx));
  assert.equal(queued.pendingMessages, 1);

  const waited = JSON.parse(await getTool("wait_agent").run({ target: created.id, timeout_ms: 25 }, ctx));
  assert.equal(waited.result, "done");
  assert.deepEqual(calls[0], ["spawn", { taskName: "audit", message: "inspect" }]);
  assert.deepEqual(calls.at(-1), ["wait", created.id, 25]);
});

test("collaboration tools fail clearly outside a persistent Agent-team context", async () => {
  const result = await getTool("spawn_agent").run(
    { task_name: "audit", message: "inspect" },
    { cwd: process.cwd() },
  );
  assert.match(result, /durable Agent teams are unavailable/i);
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
  for (const tool of ["spawn_agent", "send_message", "followup_task", "interrupt_agent", "resume_agent", "list_agents", "wait_agent"]) {
    assert.equal(seen[0].includes(tool), false, `${tool} stays out of a direct-run prompt`);
    assert.equal(seen[1].includes(tool), true, `${tool} is visible in a persistent Agent-team run`);
  }
});
