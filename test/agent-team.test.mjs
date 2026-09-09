import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentTeamStore,
  DurableAgentTeam,
} from "../dist/subagent/team.js";
import { AgentWorktreeManager } from "../dist/subagent/worktree.js";

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

const runGit = (cwd, ...args) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || `git ${args[0]} failed`);
};

const fixture = (executor, options = {}) => {
  const home = mkdtempSync(join(tmpdir(), "hara-agent-team-"));
  const sessionId = "fixture-session";
  const store = new AgentTeamStore(home);
  const team = new DurableAgentTeam({ sessionId, store, executor, ...options });
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

test("Agent mailbox commands are idempotent and fenced to the parent turn", async () => {
  let rootTurnId = "root-turn-a";
  let created;
  const state = fixture(async (request) => {
    await new Promise((resolve) => {
      if (request.signal.aborted) return resolve();
      request.signal.addEventListener("abort", resolve, { once: true });
    });
    return { status: "cancelled", text: "" };
  }, { currentRootTurnId: () => rootTurnId });
  try {
    const firstTurn = state.team.controller("/root", {
      parentTurnId: rootTurnId,
      rootTurnId,
    });
    created = await firstTurn.spawn({ taskName: "mailbox", message: "inspect" });
    await firstTurn.sendMessage(created.id, "same evidence", "provider-tool-call-1");
    await firstTurn.sendMessage(created.id, "same evidence", "provider-tool-call-1");
    assert.equal(state.team.list()[0].pendingMessages, 1, "an exact retry cannot enqueue twice");
    await assert.rejects(
      firstTurn.sendMessage(created.id, "different evidence", "provider-tool-call-1"),
      /already used with a different request/i,
    );

    rootTurnId = "root-turn-b";
    await assert.rejects(
      async () => firstTurn.followup(created.id, "late message", "provider-tool-call-2"),
      /previous parent turn/i,
    );
    const secondTurn = state.team.controller("/root", {
      parentTurnId: rootTurnId,
      rootTurnId,
    });
    await assert.rejects(
      async () => secondTurn.sendMessage(created.id, "cross-turn message", "provider-tool-call-3"),
      /different parent turn/i,
    );
  } finally {
    state.team.close();
    if (created) await state.team.controller().wait(created.id, 1_000);
    rmSync(state.home, { recursive: true, force: true });
  }
});

test("the whole Agent tree reserves and enforces generations, rounds, tools, tokens, and deadline", async () => {
  const observedBudgets = [];
  const state = fixture(async (request) => {
    observedBudgets.push(request.budget);
    const within = request.reportProgress({
      providerRounds: 1,
      toolCalls: 1,
      inputTokens: 300,
      outputTokens: 100,
    });
    assert.equal(within, true);
    return {
      status: "completed",
      text: "bounded",
      usage: { input: 300, output: 100 },
      metrics: { providerRounds: 1, toolCalls: 1, inputTokens: 300, outputTokens: 100 },
    };
  }, {
    limits: {
      maxGenerations: 2,
      maxProviderRounds: 2,
      maxToolCalls: 2,
      maxTokens: 1_000,
      maxActiveMs: 5_000,
      maxRoundsPerAgent: 1,
      maxToolsPerAgent: 1,
      maxTokensPerAgent: 500,
    },
  });
  try {
    const controller = state.team.controller();
    const first = await controller.spawn({ taskName: "budgeted", message: "first" });
    await controller.wait(first.id, 1_000);
    await controller.followup(first.id, "second");
    await controller.wait(first.id, 1_000);
    await assert.rejects(async () => controller.followup(first.id, "third"), /generation limit/i);
    assert.equal(observedBudgets.length, 2);
    assert.ok(observedBudgets.every((budget) => budget.maxProviderRounds === 1));
    const budget = state.team.budget();
    assert.equal(budget.generationsStarted, 2);
    assert.equal(budget.providerRounds, 2);
    assert.equal(budget.toolCalls, 2);
    assert.equal(budget.inputTokens + budget.outputTokens, 800);
    assert.equal(budget.exhausted, true);
    assert.deepEqual(budget.activeReservations, { providerRounds: 0, toolCalls: 0, tokens: 0 });
  } finally {
    state.cleanup();
  }
});

test("a generation crossing its reserved token slice is stopped before another model boundary", async () => {
  const state = fixture(async (request) => {
    assert.equal(request.reportProgress({
      providerRounds: 1,
      toolCalls: 0,
      inputTokens: 900,
      outputTokens: 200,
    }), false);
    return {
      status: "completed",
      text: "must not be accepted as complete",
      metrics: { providerRounds: 1, toolCalls: 0, inputTokens: 900, outputTokens: 200 },
    };
  }, {
    limits: {
      maxTokens: 1_000,
      maxTokensPerAgent: 1_000,
    },
  });
  try {
    const controller = state.team.controller();
    const created = await controller.spawn({ taskName: "token_cap", message: "bounded" });
    const settled = await controller.wait(created.id, 1_000);
    assert.notEqual(settled.agent.status, "completed");
    assert.match(settled.error, /tree execution budget/i);
    assert.equal(state.team.budget().inputTokens + state.team.budget().outputTokens, 1_100,
      "actual provider usage remains truthful even when one response crosses the ceiling");
  } finally {
    state.cleanup();
  }
});

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
  const mailboxEvents = [];
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
  }, { onMailbox: (event) => mailboxEvents.push(event) });
  try {
    const controller = state.team.controller();
    const created = await controller.spawn({ taskName: "research", message: "initial" });
    await controller.sendMessage(created.id, "new evidence");
    firstGate.resolve();
    const first = await controller.wait(created.id, 1_000);
    assert.equal(first.agent.generation, 1);
    assert.equal(first.result, "generation-1:new evidence");
    assert.deepEqual(mailboxEvents.slice(0, 3).map((event) => event.state), ["queued", "started", "completed"]);
    assert.ok(mailboxEvents.slice(0, 3).every((event) => event.id === mailboxEvents[0].id));

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

test("Serve handoff drains descendants without launching a queued follow-up generation", async () => {
  const releaseAfterAbort = deferred();
  let sawAbort;
  const aborted = new Promise((resolve) => { sawAbort = resolve; });
  const state = fixture(async (request) => {
    await new Promise((resolve) => {
      const onAbort = () => {
        sawAbort();
        resolve();
      };
      request.signal.addEventListener("abort", onAbort, { once: true });
      if (request.signal.aborted) onAbort();
    });
    await releaseAfterAbort.promise;
    return { status: "cancelled", text: "" };
  });
  try {
    const controller = state.team.controller();
    const created = await controller.spawn({ taskName: "handoff", message: "wait" });
    await controller.followup(created.id, "must stay queued during handoff", "handoff-followup");
    const timedOut = state.team.interruptAllAndWait(10);
    await aborted;
    assert.equal(await timedOut, false);
    assert.equal(state.team.isQuiescent(), false);
    await assert.rejects(
      controller.spawn({ taskName: "late", message: "must not start" }),
      /paused for a Serve handoff/,
    );
    releaseAfterAbort.resolve();
    const settled = await controller.wait(created.id, 1_000);
    assert.equal(settled.agent.status, "cancelled");
    assert.equal(settled.agent.generation, 1, "the queued follow-up does not become a new generation");
    assert.equal(await state.team.interruptAllAndWait(1_000), true);
    assert.equal(state.team.isQuiescent(), true);
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

test("writable Agent generations stay isolated until their owned Diff is manually applied or rejected", async () => {
  const root = mkdtempSync(join(tmpdir(), "hara-agent-team-worktree-"));
  const home = join(root, "home");
  const repo = join(root, "repo");
  mkdirSync(home);
  mkdirSync(repo);
  runGit(repo, "init", "-q");
  runGit(repo, "config", "user.email", "test@example.test");
  runGit(repo, "config", "user.name", "Hara Test");
  writeFileSync(join(repo, "owned.txt"), "source\n");
  runGit(repo, "add", "owned.txt");
  runGit(repo, "commit", "-qm", "base");
  const sessionId = "worktree-team-session";
  const worktreeManager = new AgentWorktreeManager(repo, home, sessionId);
  const team = new DurableAgentTeam({
    sessionId,
    store: new AgentTeamStore(home),
    worktreeManager,
    executor: async (request) => {
      assert.equal(request.workspace?.mode, "isolated-write");
      assert.notEqual(request.workspace?.cwd, repo);
      writeFileSync(join(request.workspace.cwd, "owned.txt"), "child\n");
      return { status: "completed", text: "implementation ready" };
    },
  });
  try {
    const controller = team.controller();
    const created = await controller.spawn({
      taskName: "implement",
      message: "change owned.txt",
      workspace: "isolated-write",
    });
    const settled = await controller.wait(created.id, 5_000);
    assert.equal(settled.agent.status, "completed");
    assert.equal(settled.agent.workspace.state, "changes");
    assert.equal(readFileSync(join(repo, "owned.txt"), "utf8"), "source\n");

    const reviewed = await controller.inspectDiff(created.id);
    assert.equal(reviewed.agentId, created.id);
    assert.match(reviewed.patch, /child/u);
    const appliedPath = worktreeManager.prepare(created.id).path;
    assert.equal(existsSync(appliedPath), true);
    const applied = await controller.applyDiff(created.id);
    assert.equal(applied.state, "applied");
    assert.equal(readFileSync(join(repo, "owned.txt"), "utf8"), "child\n");
    await assert.rejects(
      controller.followup(created.id, "make another change"),
      /Diff is already resolved/i,
    );

    const rejectedAgent = await controller.spawn({
      taskName: "rejectable",
      message: "change owned.txt in another workspace",
      workspace: "isolated-write",
    });
    await controller.wait(rejectedAgent.id, 5_000);
    await assert.rejects(
      controller.applyDiff(rejectedAgent.id),
      /Inspect the current Agent Diff/i,
    );
    const rejected = await controller.rejectDiff(rejectedAgent.id);
    assert.equal(rejected.state, "rejected");
    assert.equal(readFileSync(join(repo, "owned.txt"), "utf8"), "child\n");
    const rejectedPath = worktreeManager.prepare(rejectedAgent.id).path;
    assert.equal(existsSync(rejectedPath), true);
    assert.equal(team.removeStoredState(), true);
    assert.equal(existsSync(appliedPath), false);
    assert.equal(existsSync(rejectedPath), false);
  } finally {
    team.close();
    rmSync(root, { force: true, recursive: true });
  }
});
