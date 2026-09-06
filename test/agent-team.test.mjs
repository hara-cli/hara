import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentTeamStore,
  DurableAgentTeam,
} from "../dist/subagent/team.js";

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

const fixture = (executor) => {
  const home = mkdtempSync(join(tmpdir(), "hara-agent-team-"));
  const sessionId = "fixture-session";
  const store = new AgentTeamStore(home);
  const team = new DurableAgentTeam({ sessionId, store, executor });
  return {
    home,
    sessionId,
    store,
    team,
    cleanup() {
      team.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
};

test("durable Agent team persists stable metadata, redacts prompts, and returns terminal output only from wait", async () => {
  const gate = deferred();
  const requests = [];
  const state = fixture(async (request) => {
    requests.push(request);
    await gate.promise;
    return {
      status: "completed",
      text: "review complete",
      model: "fixture-model",
      usage: { input: 12, output: 3 },
    };
  });
  try {
    const created = await state.team.controller().spawn({
      taskName: "review_api",
      message: "Inspect Authorization: Bearer secret-token-value",
      role: "explore",
    });
    assert.match(created.id, /^[0-9a-f-]{36}$/i);
    assert.equal(created.path, "/root/review_api");
    assert.equal(created.status, "working");
    assert.equal(state.team.list()[0].hasResult, false);
    assert.doesNotMatch(JSON.stringify(state.team.list()), /secret-token|Inspect Authorization|review complete/);

    const file = join(state.home, ".hara", "agent-teams", state.sessionId + ".json");
    const raw = readFileSync(file, "utf8");
    assert.doesNotMatch(raw, /secret-token-value/);
    assert.match(raw, /Bearer \*\*\*/);
    assert.equal(statSync(file).mode & 0o777, 0o600);

    gate.resolve();
    const settled = await state.team.controller().wait(created.id, 1_000);
    assert.equal(settled.settled, true);
    assert.equal(settled.agent.status, "completed");
    assert.equal(settled.result, "review complete");
    assert.deepEqual(settled.agent.usage, { input: 12, output: 3 });
    assert.equal(requests[0].id, created.id);

    const reloaded = new DurableAgentTeam({
      sessionId: state.sessionId,
      store: state.store,
      executor: async () => {
        throw new Error("completed Agents must not restart during load");
      },
    });
    assert.equal(reloaded.list()[0].id, created.id);
    assert.equal(reloaded.list()[0].status, "completed");
  } finally {
    state.cleanup();
  }
});

test("working Agents drain durable mailbox once and idle followups reuse identity with a new generation", async () => {
  const firstGate = deferred();
  const calls = [];
  const state = fixture(async (request) => {
    calls.push(request);
    if (request.generation === 1) await firstGate.promise;
    const messages = await request.pendingInput();
    const secondDrain = await request.pendingInput();
    assert.deepEqual(secondDrain, []);
    return {
      status: "completed",
      text: "generation-" + request.generation + ":" + messages.map(
        (message) => message.content,
      ).join(","),
    };
  });
  try {
    const controller = state.team.controller();
    const created = await controller.spawn({ taskName: "research", message: "initial" });
    await controller.sendMessage(created.id, "new evidence");
    firstGate.resolve();
    const first = await controller.wait(created.id, 1_000);
    assert.equal(first.agent.generation, 1);
    assert.equal(first.result, "generation-1:new evidence");

    const followed = await controller.followup(created.id, "check one more path");
    assert.equal(followed.id, created.id);
    const second = await controller.wait(created.id, 1_000);
    assert.equal(second.agent.generation, 2);
    assert.equal(second.agent.status, "completed");
    assert.match(calls[1].task, /check one more path/);
    assert.equal(calls[0].path, calls[1].path);
  } finally {
    state.cleanup();
  }
});

test("a followup accepted at the terminal publication boundary launches the queued generation", async () => {
  const home = mkdtempSync(join(tmpdir(), "hara-agent-followup-boundary-"));
  const sessionId = "followup-boundary-session";
  const store = new AgentTeamStore(home);
  let controller;
  let boundaryFollowup;
  let boundaryTriggered = false;
  let queuedAtBoundary = false;
  const team = new DurableAgentTeam({
    sessionId,
    store,
    executor: async (request) => ({ status: "completed", text: "generation-" + request.generation }),
    onChange(agent) {
      if (agent.status !== "completed" || agent.generation !== 1 || boundaryTriggered) return;
      // Mark the callback before invoking followup: followup itself publishes another state synchronously.
      boundaryTriggered = true;
      boundaryFollowup = controller.followup(agent.id, "continue exactly at completion").then((next) => {
        queuedAtBoundary = next.status === "queued" || next.status === "working";
        return next;
      });
    },
  });
  controller = team.controller();
  try {
    const created = await controller.spawn({ taskName: "boundary", message: "first generation" });
    await controller.wait(created.id, 1_000);
    await boundaryFollowup;
    const settled = await controller.wait(created.id, 1_000);
    assert.equal(queuedAtBoundary, true);
    assert.equal(settled.settled, true);
    assert.equal(settled.agent.generation, 2);
    assert.equal(settled.agent.status, "completed");
    assert.equal(settled.result, "generation-2");
  } finally {
    team.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("interrupt cooperatively cancels a live Agent without losing its stable record", async () => {
  const state = fixture(async (request) => {
    await new Promise((resolve) => {
      if (request.signal.aborted) return resolve();
      request.signal.addEventListener("abort", resolve, { once: true });
    });
    return { status: "cancelled", text: "" };
  });
  try {
    const controller = state.team.controller();
    const created = await controller.spawn({ taskName: "long_scan", message: "scan" });
    const stopping = await controller.interrupt(created.path);
    assert.equal(stopping.status, "stopping");
    const settled = await controller.wait(created.id, 1_000);
    assert.equal(settled.agent.id, created.id);
    assert.equal(settled.agent.status, "cancelled");
    assert.match(settled.error, /interrupted/i);
  } finally {
    state.cleanup();
  }
});

test("cold recovery marks abandoned work interrupted and resume keeps identity", async () => {
  const home = mkdtempSync(join(tmpdir(), "hara-agent-cold-"));
  const store = new AgentTeamStore(home);
  const sessionId = "cold-session";
  const abandoned = new DurableAgentTeam({
    sessionId,
    store,
    executor: async () => new Promise(() => {}),
  });
  try {
    const created = await abandoned.controller().spawn({ taskName: "audit", message: "inspect state" });
    assert.equal(created.status, "working");

    const resumedRuntime = new DurableAgentTeam({
      sessionId,
      store,
      executor: async (request) => ({
        status: "completed",
        text: "resumed:" + request.generation,
      }),
    });
    const recovered = resumedRuntime.list()[0];
    assert.equal(recovered.id, created.id);
    assert.equal(recovered.status, "interrupted");

    const resumed = await resumedRuntime.controller().resume(created.id);
    assert.equal(resumed.id, created.id);
    const settled = await resumedRuntime.controller().wait(created.id, 1_000);
    assert.equal(settled.agent.generation, 2);
    assert.equal(settled.result, "resumed:2");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("nested Agents receive a scoped controller and the durable tree enforces maximum depth", async () => {
  const state = fixture(async (request) => {
    const depth = request.path.split("/").filter(Boolean).length - 1;
    if (depth < 4) {
      const child = await request.controller.spawn({
        taskName: "level_" + String(depth + 1),
        message: "nested work",
      });
      const settled = await request.controller.wait(child.id, 1_000);
      assert.equal(settled.settled, true);
    } else {
      await assert.rejects(
        request.controller.spawn({ taskName: "too_deep", message: "blocked" }),
        /depth exceeds/i,
      );
    }
    return { status: "completed", text: "depth-" + String(depth) };
  });
  try {
    const root = await state.team.controller().spawn({ taskName: "level_1", message: "start" });
    const settled = await state.team.controller().wait(root.id, 2_000);
    assert.equal(settled.settled, true);
    const agents = state.team.list();
    assert.equal(agents.length, 4);
    assert.deepEqual(
      agents.map((agent) => agent.path),
      [
        "/root/level_1",
        "/root/level_1/level_2",
        "/root/level_1/level_2/level_3",
        "/root/level_1/level_2/level_3/level_4",
      ],
    );
  } finally {
    state.cleanup();
  }
});
