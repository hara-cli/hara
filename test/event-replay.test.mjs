import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServeEventReplayBuffer } from "../dist/serve/event-replay.js";

const notification = (frame) => JSON.parse(frame);

test("event replay preserves an exact 10,000-event ordered tail without gaps or duplicates", () => {
  const replay = new ServeEventReplayBuffer("serve-a", {
    maxEvents: 10_000,
    maxBytes: 32 * 1024 * 1024,
  });
  for (let index = 1; index <= 10_000; index++) {
    replay.publish("event.test", { index });
  }

  const received = [];
  let after = 0;
  do {
    const page = replay.replay("serve-a", after, 137);
    assert.equal(page.snapshotRequired, false);
    received.push(...page.frames.map(notification));
    after = page.throughSequence;
    if (!page.hasMore) break;
  } while (true);

  assert.equal(received.length, 10_000);
  assert.deepEqual(received.map((event) => event.params.index), Array.from({ length: 10_000 }, (_, index) => index + 1));
  assert.deepEqual(
    received.map((event) => event.params.deliveryCursor.sequence),
    Array.from({ length: 10_000 }, (_, index) => index + 1),
  );
  assert.ok(received.every((event) => event.params.deliveryCursor.streamId === "serve-a"));
});

test("event replay fails closed when count eviction expires the requested cursor", () => {
  const replay = new ServeEventReplayBuffer("serve-b", { maxEvents: 3, maxBytes: 64 * 1024 });
  for (let index = 1; index <= 5; index++) replay.publish("event.test", { index });

  assert.deepEqual(replay.state(), {
    streamId: "serve-b",
    currentSequence: 5,
    earliestSequence: 3,
    retainedEvents: 3,
    retainedBytes: replay.state().retainedBytes,
  });
  const expired = replay.replay("serve-b", 1);
  assert.equal(expired.snapshotRequired, true);
  assert.equal(expired.resetReason, "cursor_expired");
  assert.deepEqual(expired.frames, []);

  const tail = replay.replay("serve-b", 2);
  assert.equal(tail.snapshotRequired, false);
  assert.deepEqual(tail.frames.map((frame) => notification(frame).params.index), [3, 4, 5]);
});

test("event replay requires a snapshot after a server restart or unretainable frame", () => {
  const replay = new ServeEventReplayBuffer("serve-c", { maxEvents: 10, maxBytes: 256 });
  replay.publish("event.test", { index: 1 });
  const oversized = replay.publish("event.test", { body: "x".repeat(1_000) });
  assert.equal(oversized.retained, false);
  replay.publish("event.test", { index: 3 });

  const lost = replay.replay("serve-c", 1);
  assert.equal(lost.snapshotRequired, true);
  assert.equal(lost.resetReason, "cursor_expired");
  const restarted = replay.replay("old-serve", 1);
  assert.equal(restarted.snapshotRequired, true);
  assert.equal(restarted.resetReason, "stream_changed");
  const ahead = replay.replay("serve-c", 4);
  assert.equal(ahead.snapshotRequired, true);
  assert.equal(ahead.resetReason, "cursor_ahead");
});

test("event replay restores a private redacted tail across Serve replacement", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-event-replay-"));
  try {
    const first = new ServeEventReplayBuffer("serve-first", {
      maxEvents: 20,
      maxBytes: 64 * 1024,
      persistence: { home },
    });
    first.publish("event.task_state", { sessionId: "session-a", phase: "working" });
    first.publish("event.notice", {
      sessionId: "session-a",
      text: "credential sk-1234567890abcdef must not survive",
    });
    assert.equal(first.checkpoint(true), 2);
    assert.equal(first.durableSequence, 2);

    const persisted = readFileSync(join(home, ".hara", "serve", "event-replay.json"), "utf8");
    assert.equal(persisted.includes("sk-1234567890abcdef"), false);

    const restarted = new ServeEventReplayBuffer("serve-second", {
      maxEvents: 20,
      maxBytes: 64 * 1024,
      persistence: { home },
    });
    assert.equal(restarted.streamId, "serve-first", "restart adopts the durable stream identity");
    assert.equal(restarted.currentSequence, 2);
    assert.equal(restarted.durableSequence, 2);
    const page = restarted.replay("serve-first", 0);
    assert.equal(page.snapshotRequired, false);
    assert.deepEqual(page.frames.map((frame) => notification(frame).params.deliveryCursor.sequence), [1, 2]);
    assert.equal(page.frames[1].includes("sk-1234567890abcdef"), false);

    restarted.publish("event.turn_end", { sessionId: "session-a", reply: "done" });
    assert.equal(restarted.checkpoint(true), 3);
    const third = new ServeEventReplayBuffer("serve-third", {
      maxEvents: 20,
      maxBytes: 64 * 1024,
      persistence: { home },
    });
    assert.equal(third.streamId, "serve-first");
    assert.deepEqual(
      third.replay("serve-first", 2).frames.map((frame) => notification(frame).method),
      ["event.turn_end"],
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
