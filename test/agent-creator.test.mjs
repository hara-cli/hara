import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import WebSocket from "ws";

const root = mkdtempSync(join(tmpdir(), "hara-agent-creator-"));
const previousHome = process.env.HOME;
process.env.HOME = join(root, "home");
mkdirSync(process.env.HOME, { recursive: true, mode: 0o700 });
const { agentCreationProposal, createAgentCreationTool } = await import("../dist/serve/agent-creator.js");
const { runAgent } = await import("../dist/agent/loop.js");
const { toolOperationTraits } = await import("../dist/tools/registry.js");
const { startServe } = await import("../dist/serve/server.js");
after(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
});

const proposal = {
  username: "analyst",
  name: "Ada",
  role: "Research colleague",
  description: "Answers bounded research questions.",
  instructions: "Check evidence, cite sources, and say when information is missing. Never send messages without permission.",
};
const provider = () => {
  let round = 0;
  return {
    id: "fake", model: "fake",
    async turn() {
      return round++ === 0
        ? { text: "", stop: "tool_use", toolUses: [{ id: "create-1", name: "agent_create", input: proposal }] }
        : { text: "done", stop: "end", toolUses: [] };
    },
  };
};

test("Bot proposals are bounded and cannot attach authority or endpoints", () => {
  assert.deepEqual(agentCreationProposal(proposal), { kind: "agent-create", ...proposal });
  for (const input of [
    { ...proposal, username: "../escape" },
    { ...proposal, username: "main" },
    { ...proposal, instructions: "x".repeat(4_001) },
    { ...proposal, instructions: "bad\0instructions" },
    { ...proposal, runtimeGrants: ["codex"] },
    { ...proposal, endpoint: "https://untrusted.example" },
    { ...proposal, apiKey: "not-a-real-key" },
  ]) assert.throws(() => agentCreationProposal(input));
});

test("the engine retains a full single-use creation presentation", () => {
  const tool = createAgentCreationTool({ assertPersonalRoot() {}, async create() { throw new Error("not called"); } });
  const operation = toolOperationTraits(tool, proposal, { cwd: root });
  assert.equal(operation.effect, "edit");
  assert.equal(operation.requiresExplicitApproval, true);
  assert.equal(operation.approvalPresentation.instructions, proposal.instructions);
  assert.equal(toolOperationTraits(tool, { ...proposal, apiKey: "not-a-real-key" }, { cwd: root }).effect, "state");
});

for (const decision of [false, true]) {
  test(`creation ${decision ? "saves only after confirmation" : "does not write when declined"}, including full-auto`, async () => {
    let writes = 0;
    let confirmations = 0;
    const tool = createAgentCreationTool({
      assertPersonalRoot() {},
      async create(input) {
        writes++;
        assert.equal(input.profile.displayName, proposal.name);
        assert.equal(input.execution, undefined);
        return { ref: "global:analyst", name: "Ada", created: true };
      },
    });
    await runAgent([{ role: "user", content: "Create a research colleague" }], {
      provider: provider(), ctx: { cwd: root, spaceId: "personal" }, approval: "full-auto", approvalChannel: true,
      confirm: async (_question, _signal, options) => {
        confirmations++;
        assert.equal(writes, 0);
        assert.equal(options.allowAlways, false);
        assert.deepEqual(options.presentation, { kind: "agent-create", ...proposal });
        return decision;
      },
      extraTools: [tool], quiet: true, hooks: false,
    });
    assert.equal(confirmations, 1);
    assert.equal(writes, decision ? 1 : 0);
  });
}

test("a headless auto-yes callback cannot impersonate human creation consent", async () => {
  let writes = 0;
  let confirms = 0;
  const tool = createAgentCreationTool({ assertPersonalRoot() {}, async create() { writes++; return {}; } });
  await runAgent([{ role: "user", content: "Create a colleague" }], {
    provider: provider(), ctx: { cwd: root }, approval: "full-auto", approvalChannel: false,
    confirm: async () => { confirms++; return true; }, extraTools: [tool], quiet: true, hooks: false,
  });
  assert.equal(writes, 0);
  assert.equal(confirms, 0);
});

test("authority is checked again after a human wait", async () => {
  let allowed = true;
  let writes = 0;
  const tool = createAgentCreationTool({
    assertPersonalRoot() { if (!allowed) throw new Error("Personal root authority revoked"); },
    async create() { writes++; return {}; },
  });
  await runAgent([{ role: "user", content: "Create a colleague" }], {
    provider: provider(), ctx: { cwd: root }, approval: "full-auto", approvalChannel: true,
    confirm: async () => { allowed = false; return true; }, extraTools: [tool], quiet: true, hooks: false,
  });
  assert.equal(writes, 0);
});

function connect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const events = [];
    const pending = new Map();
    const listeners = new Set();
    let nextId = 1;
    ws.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      const settle = pending.get(message.id);
      if (settle) { pending.delete(message.id); settle(message); return; }
      events.push(message);
      for (const check of listeners) check();
    });
    ws.on("error", reject);
    ws.on("open", () => resolve({
      events,
      call(method, params = {}) {
        return new Promise((settle, fail) => {
          const id = nextId++;
          const timer = setTimeout(() => { pending.delete(id); fail(new Error(`No ${method} response; events: ${events.map((event) => event.method ?? "rpc").join(",")}`)); }, 8_000);
          pending.set(id, (message) => { clearTimeout(timer); settle(message); });
          ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
        });
      },
      wait(method) {
        return new Promise((settle, fail) => {
          const timer = setTimeout(() => { listeners.delete(check); fail(new Error(`No ${method} event`)); }, 8_000);
          function check() {
            const event = events.find((message) => message.method === method);
            if (!event) return;
            clearTimeout(timer); listeners.delete(check); settle(event.params);
          }
          listeners.add(check); check();
        });
      },
      close() { ws.close(); },
    }));
  });
}

test("Serve creation survives reconnect, preserves the full card, and joins the persistent roster", async (t) => {
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const saved = new Map();
  const store = {
    load: (id) => saved.get(id) ?? null,
    save: (meta, history, task) => saved.set(meta.id, { meta: { ...meta }, history: structuredClone(history), task: structuredClone(task) }),
    list: () => [...saved.values()].map((entry) => entry.meta),
    acquire: () => ({ ok: true }), release() {}, delete: (id) => saved.delete(id),
  };
  let round = 0;
  const offeredTools = new Map();
  const fake = {
    id: "fake", model: "fake",
    async turn({ history, tools }) {
      const prompt = [...history].reverse().find((message) => message.role === "user")?.content;
      offeredTools.set(prompt, tools.map((tool) => tool.name));
      if (round++ === 0) return { text: "", stop: "tool_use", toolUses: [{
        id: "intake", name: "task_intake", input: {
          intent: "change", goal: "Create the user's research Bot", constraints: ["no extra permissions"],
          acceptance: ["Bot is saved after a single human confirmation"], steps: ["confirm the proposal", "save the Bot"],
        },
      }] };
      if (round === 2) return { text: "", stop: "tool_use", toolUses: [{ id: "create", name: "agent_create", input: proposal }] };
      if (round === 3) {
        const receipt = history.filter((message) => message.role === "tool").flatMap((message) => message.results)
          .find((result) => result.name === "agent_create");
        assert.equal(JSON.parse(receipt.content).created, true);
        return { text: "", stop: "tool_use", toolUses: [{ id: "checkpoint", name: "task_checkpoint", input: {
          completion: { state: "verified", evidence: ["The confirmed Bot was saved and returned its persistent contact reference."] },
        } }] };
      }
      return { text: "The Bot is saved.", stop: "end", toolUses: [] };
    },
  };
  const handle = await startServe({ host: "127.0.0.1", port: 0, token: "creator-test-token", cwd: workspace }, {
    version: "test", providerId: "fake", model: "fake", buildSessionProvider: async () => fake,
    buildProviderFor: async () => fake,
    runtimeInfo: () => ({ providerId: "fake", model: "fake", profileId: "personal", spaceId: "personal", effortLevels: [] }),
    spawnSubagent: async () => "disabled", sandbox: "off", approval: "full-auto", store, quietDiscovery: true,
  });
  let client;
  let submittingClient;
  try {
    submittingClient = await connect(handle.port);
    await submittingClient.call("initialize", { token: "creator-test-token" });
    const session = await submittingClient.call("session.create", { cwd: workspace });
    assert.ok(session.result?.sessionId);
    // The submission RPC intentionally resolves only when this turn completes. Keep
    // it in flight while a separate UI reconnects and answers the approval card.
    const submission = submittingClient.call("session.submit", { sessionId: session.result.sessionId, text: "Create Ada as a research colleague", mode: "start_if_idle" });
    submission.catch(() => {});
    client = await connect(handle.port);
    await client.call("initialize", { token: "creator-test-token" });
    const request = await submittingClient.wait("approval.request");
    const file = join(process.env.HOME, ".hara", "roles", "analyst.md");
    assert.equal(existsSync(file), false);
    assert.equal(request.allowAlways, false);
    assert.equal(request.presentation.instructions, proposal.instructions);
    const waiting = submittingClient.events.filter((event) => event.method === "event.task_state" && event.params.approval).at(-1);
    assert.doesNotMatch(JSON.stringify(waiting.params), /Never send messages/,
      "standing instructions never leak into ambient task telemetry");
    client.close();
    client = await connect(handle.port);
    await client.call("initialize", { token: "creator-test-token" });
    const snapshot = await client.call("events.snapshot", { sessionIds: [session.result.sessionId] });
    assert.equal(snapshot.result.approvals[0].presentation.instructions, proposal.instructions);
    // Older clients may still send always:true. The engine downgrades it to a single decision,
    // rather than remembering permission to create more colleagues.
    const accepted = await client.call("approval.reply", { approvalId: request.approvalId, allow: true, always: true });
    assert.ok(!accepted.error);
    await client.wait("event.agents_changed");
    assert.match(readFileSync(file, "utf8"), /display-name: "Ada"/);
    assert.ok(readFileSync(file, "utf8").includes(proposal.instructions));
    const beforeDuplicate = readFileSync(file, "utf8");
    await client.call("approval.reply", { approvalId: request.approvalId, allow: true });
    assert.equal(readFileSync(file, "utf8"), beforeDuplicate, "a duplicate reply never creates or rewrites another Bot");
    const catalog = await client.call("agents.list", { sessionId: session.result.sessionId });
    assert.ok(catalog.result.agents.some((agent) => agent.ref === "global:analyst"));
    await client.wait("event.turn_end");
    const submitted = await submission;
    assert.equal(submitted.error, undefined, JSON.stringify(submitted.error));
    assert.ok(offeredTools.get("Create Ada as a research colleague").includes("agent_create"));
    const colleagueSession = await client.call("session.create", { cwd: workspace, agentRef: "global:analyst" });
    assert.ok(colleagueSession.result?.sessionId);
    await client.call("session.send", { sessionId: colleagueSession.result.sessionId, text: "Hello Ada" });
    assert.ok(!offeredTools.get("Hello Ada").includes("agent_create"),
      "creating a Bot does not grant it the main orchestrator's hiring authority");
  } finally {
    client?.close();
    submittingClient?.close();
    await handle.close();
  }
});
