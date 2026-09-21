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

test("Agent rooms keep one bounded transcript and idempotently fan posts into participant mailboxes", async () => {
  const release = deferred();
  const deliveries = new Map();
  const state = fixture(async (request) => {
    await release.promise;
    deliveries.set(request.path, await request.pendingInput());
    return { status: "completed", text: "room checked" };
  });
  try {
    const controller = state.team.controller();
    const alpha = await controller.spawn({ taskName: "alpha", message: "wait for room" });
    const beta = await controller.spawn({ taskName: "beta", message: "wait for room" });
    const room = await controller.createRoom({ name: "design_review", members: [alpha.id, beta.path] }, "room-create-1");
    const retried = await controller.createRoom({ name: "design_review", members: [alpha.id, beta.path] }, "room-create-1");
    assert.equal(retried.id, room.id);
    assert.deepEqual(room.participantPaths, ["/root", alpha.path, beta.path]);

    await controller.postRoom({ room: room.id, message: "Compare the two approaches." }, "room-post-1");
    await controller.postRoom({ room: room.id, message: "Compare the two approaches." }, "room-post-1");
    assert.equal(controller.readRoom(room.id).messageCount, 1);
    assert.equal(state.team.list().find((agent) => agent.id === alpha.id).pendingMessages, 1);
    assert.equal(state.team.list().find((agent) => agent.id === beta.id).pendingMessages, 1);

    release.resolve();
    await Promise.all([
      controller.wait(alpha.id, 1_000),
      controller.wait(beta.id, 1_000),
    ]);
    assert.match(deliveries.get(alpha.path)[0].content, /Agent room design_review/u);
    assert.match(deliveries.get(beta.path)[0].content, /Compare the two approaches/u);
    assert.equal(controller.listRooms().length, 1);
    const closed = await controller.closeRoom(room.name);
    assert.ok(closed.closedAt);
    await assert.rejects(
      controller.postRoom({ room: room.id, message: "too late" }),
      /closed/i,
    );
  } finally {
    state.cleanup();
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

test("native Agents can delegate only to coding runtimes granted by root", async () => {
  const root = mkdtempSync(join(tmpdir(), "hara-agent-runtime-grants-"));
  const home = join(root, "home");
  const repo = join(root, "repo");
  mkdirSync(home);
  mkdirSync(repo);
  runGit(repo, "init", "-q");
  runGit(repo, "config", "user.email", "test@example.test");
  runGit(repo, "config", "user.name", "Hara Test");
  writeFileSync(join(repo, "fixture.txt"), "base\n");
  runGit(repo, "add", "fixture.txt");
  runGit(repo, "commit", "-qm", "base");

  const requests = [];
  const team = new DurableAgentTeam({
    sessionId: "runtime-grant-session",
    store: new AgentTeamStore(home),
    worktreeManager: new AgentWorktreeManager(repo, home, "runtime-grant-session"),
    executor: async (request) => {
      requests.push({ path: request.path, runtime: request.runtime });
      return { status: "completed", text: `${request.runtime} complete` };
    },
  });
  try {
    const rootController = team.controller();
    const delegator = await rootController.spawn({
      taskName: "delegator",
      message: "Coordinate coding work.",
      runtimeGrants: ["codex"],
    });
    await rootController.wait(delegator.id, 2_000);
    assert.deepEqual(delegator.runtimeGrants, ["codex"]);

    const scoped = team.controller(delegator.path);
    assert.deepEqual(scoped.runtimeGrants, ["codex"]);
    const codex = await scoped.spawn({
      taskName: "codex_worker",
      message: "Implement one bounded change.",
      runtime: "codex",
    });
    await scoped.wait(codex.id, 2_000);
    assert.equal(codex.runtime, "codex");
    assert.equal(codex.workspace.mode, "isolated-write");
    await assert.rejects(
      async () => scoped.applyDiff(codex.id),
      /only \/root may apply/i,
      "a background coordinator cannot silently merge its coding worker into the user's source checkout",
    );

    await assert.rejects(
      scoped.spawn({ taskName: "claude_worker", message: "Should be denied.", runtime: "claude" }),
      /has not been granted the claude coding runtime/i,
    );
    await assert.rejects(
      scoped.spawn({ taskName: "grant_forward", message: "Should be denied.", runtimeGrants: ["codex"] }),
      /only \/root may grant coding runtimes/i,
    );

    const ungranted = await rootController.spawn({ taskName: "observer", message: "Review only." });
    await rootController.wait(ungranted.id, 2_000);
    await assert.rejects(
      team.controller(ungranted.path).spawn({
        taskName: "ungranted_codex",
        message: "Should be denied.",
        runtime: "codex",
      }),
      /has not been granted the codex coding runtime/i,
    );
    assert.deepEqual(requests.map((request) => request.runtime), ["hara", "codex", "hara"]);
  } finally {
    team.close();
    rmSync(root, { force: true, recursive: true });
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
  const externalRequests = [];
  const team = new DurableAgentTeam({
    sessionId,
    store: new AgentTeamStore(home),
    worktreeManager,
    executor: async (request) => {
      assert.equal(request.workspace?.mode, "isolated-write");
      assert.notEqual(request.workspace?.cwd, repo);
      if (request.runtime === "codex") {
        externalRequests.push(request);
        return {
          status: "completed",
          text: "Codex implementation ready",
          runtimeSessionId: `ext_runtime_${"a".repeat(24)}`,
        };
      }
      assert.equal(request.runtime, "hara");
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

    const external = await controller.spawn({
      taskName: "codex_impl",
      message: "inspect the repository",
      runtime: "codex",
    });
    assert.equal(external.runtime, "codex");
    assert.equal(external.workspace.mode, "isolated-write");
    await controller.wait(external.id, 5_000);
    await controller.followup(external.id, "continue in the same coding session");
    await controller.wait(external.id, 5_000);
    assert.equal(externalRequests.length, 2);
    assert.equal(externalRequests[0].runtimeSessionId, undefined);
    assert.equal(externalRequests[1].runtimeSessionId, `ext_runtime_${"a".repeat(24)}`);
    assert.equal(team.removeStoredState(), true);
    assert.equal(existsSync(appliedPath), false);
    assert.equal(existsSync(rejectedPath), false);
  } finally {
    team.close();
    rmSync(root, { force: true, recursive: true });
  }
});
