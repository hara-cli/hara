import test from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import { colleagueEvents } from "./fixtures/colleague-events.mjs";

test("colleague fixture returns an already received matching card without adding a listener", () => {
  const controller = new AbortController(), inbox = colleagueEvents(controller.signal);
  inbox.push({ method: "card", params: { owner: "other" } });
  inbox.push({ method: "card", params: { owner: "selected" } });
  return inbox.wait("card", (p) => p.owner === "selected").then((card) => {
    assert.deepEqual(card, { owner: "selected" });
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  });
});

test("colleague fixture awaits the actual matching event past the old polling window", { timeout: 1000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 123000 });
  const controller = new AbortController(), inbox = colleagueEvents(controller.signal);
  let settled = false;
  const waiting = inbox.wait("card", (p) => p.owner === "selected").then((card) => { settled = true; return card; });
  t.mock.timers.tick(10_001); await nextTurn();
  assert.equal(settled, false, "the enclosing test, not an internal 10 s poll, bounds this wait");
  inbox.push({ method: "card", params: { owner: "other" } }); await nextTurn();
  assert.equal(settled, false, "another colleague's card cannot satisfy the waiter");
  inbox.push({ method: "card", params: { owner: "selected" } });
  assert.deepEqual(await waiting, { owner: "selected" });
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("colleague fixture abort removes its waiter without fabricating a card", async () => {
  const controller = new AbortController(), inbox = colleagueEvents(controller.signal);
  const waiting = inbox.wait("card"); controller.abort(Error("test aborted"));
  await assert.rejects(waiting, /test aborted/);
  assert.deepEqual(inbox.events, []); assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("colleague fixture disconnect fails pending and future missing events without leaking listeners", async () => {
  const controller = new AbortController(), inbox = colleagueEvents(controller.signal);
  const waiting = inbox.wait("card"); inbox.close();
  await assert.rejects(waiting, /fixture disconnected before card/);
  await assert.rejects(inbox.wait("card"), /fixture disconnected before card/);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});
