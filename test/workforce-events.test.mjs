import test from "node:test";
import assert from "node:assert/strict";
import {
  WORKFORCE_ACTOR_LIMIT,
  WorkforceStateLedger,
  capabilityForRole,
} from "../dist/serve/workforce-events.js";

const taskEvent = (overrides = {}) => ({
  version: 1,
  streamId: "task-stream",
  sequence: 1,
  sessionId: "session-1",
  taskId: "task-1",
  turnId: "turn-1",
  objective: "secret customer objective",
  state: "running",
  taskStatus: "running",
  phase: "thinking",
  at: "2026-08-15T00:00:00.000Z",
  updatedAt: "2026-08-15T00:00:00.000Z",
  checkpoint: { done: 0, total: 0 },
  ...overrides,
});

test("workforce snapshots expose ordered safe actor state without task content", () => {
  const ledger = new WorkforceStateLedger("workforce-stream");
  const root = ledger.recordTask(taskEvent());
  const queued = ledger.recordSubagent("session-1", "task-1", "turn-1", {
    id: "agent-1",
    providerId: "private-provider",
    role: "research",
    state: "queued",
    queuedAt: "2026-08-15T00:00:01.000Z",
  });
  const working = ledger.recordSubagent("session-1", "task-1", "turn-1", {
    id: "agent-1",
    providerId: "private-provider",
    role: "research",
    state: "working",
    queuedAt: "2026-08-15T00:00:01.000Z",
    startedAt: "2026-08-15T00:00:02.000Z",
  });
  assert.equal(root.actors[0].kind, "root");
  assert.equal(queued.actors[1].state, "queued");
  assert.equal(working.actors[1].capability, "research");
  assert.ok(root.sequence < queued.sequence && queued.sequence < working.sequence);
  const encoded = JSON.stringify(working);
  assert.doesNotMatch(encoded, /secret customer objective|private-provider/);
});

test("workforce ledger rejects late child events and resets actors on a new turn", () => {
  const ledger = new WorkforceStateLedger("workforce-stream");
  ledger.recordTask(taskEvent());
  assert.equal(ledger.recordSubagent("session-1", "task-1", "old-turn", {
    id: "late",
    providerId: "fixture",
    state: "working",
    queuedAt: "2026-08-15T00:00:01.000Z",
  }), null);
  ledger.recordSubagent("session-1", "task-1", "turn-1", {
    id: "agent-1",
    providerId: "fixture",
    state: "working",
    queuedAt: "2026-08-15T00:00:01.000Z",
  });
  const next = ledger.recordTask(taskEvent({ taskId: "task-2", turnId: "turn-2", sequence: 2 }));
  assert.equal(next.actors.length, 1);
  assert.equal(next.actors[0].actorId, "root:session-1");
});

test("workforce role mapping is bounded and actor snapshots are capped", () => {
  assert.equal(capabilityForRole("ui-design"), "design");
  assert.equal(capabilityForRole("explore"), "research");
  assert.equal(capabilityForRole("unsafe role with spaces"), "other");
  const ledger = new WorkforceStateLedger("workforce-stream");
  ledger.recordTask(taskEvent());
  let snapshot;
  for (let index = 0; index < WORKFORCE_ACTOR_LIMIT + 5; index++) {
    snapshot = ledger.recordSubagent("session-1", "task-1", "turn-1", {
      id: `agent-${index}`,
      providerId: "fixture",
      role: "code",
      state: "completed",
      queuedAt: `2026-08-15T00:00:${String(index).padStart(2, "0")}.000Z`,
      startedAt: `2026-08-15T00:00:${String(index).padStart(2, "0")}.000Z`,
      endedAt: `2026-08-15T00:00:${String(index).padStart(2, "0")}.500Z`,
    });
  }
  assert.equal(snapshot.actors.length, WORKFORCE_ACTOR_LIMIT);
  assert.equal(snapshot.actors[0].kind, "root");
  assert.ok(snapshot.actors.some((actor) => actor.actorId === `agent-${WORKFORCE_ACTOR_LIMIT + 4}`));
  assert.ok(!snapshot.actors.some((actor) => actor.actorId === "agent-0"));
});

test("workforce ledger never evicts a live actor to display overflow", () => {
  const ledger = new WorkforceStateLedger("workforce-stream");
  ledger.recordTask(taskEvent());
  let snapshot;
  for (let index = 0; index < WORKFORCE_ACTOR_LIMIT - 1; index++) {
    snapshot = ledger.recordSubagent("session-1", "task-1", "turn-1", {
      id: `live-${index}`,
      providerId: "fixture",
      state: "working",
      queuedAt: `2026-08-15T00:00:${String(index).padStart(2, "0")}.000Z`,
      startedAt: `2026-08-15T00:00:${String(index).padStart(2, "0")}.000Z`,
    });
  }
  assert.equal(snapshot.actors.length, WORKFORCE_ACTOR_LIMIT);
  assert.equal(ledger.recordSubagent("session-1", "task-1", "turn-1", {
    id: "overflow",
    providerId: "fixture",
    state: "working",
    queuedAt: "2026-08-15T00:01:00.000Z",
    startedAt: "2026-08-15T00:01:00.000Z",
  }), null);
  assert.equal(
    snapshot.actors.filter((actor) => actor.kind === "subagent" && actor.state === "working").length,
    WORKFORCE_ACTOR_LIMIT - 1,
  );
});
