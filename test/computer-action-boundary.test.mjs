import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COMPUTER_OBSERVATION_MAX_AGE_MS,
  computerObservationError,
  computerPointError,
  computerSnapshotDigest,
} from "../dist/tools/computer-action-boundary.js";
import { createComputerRunScope, closeComputerRunScope } from "../dist/tools/computer-run.js";

const target = {
  app: "Fixture App", pid: 1234, windowId: "456",
  frame: { x: 100, y: 100, width: 600, height: 600 },
  screen: { x: 0, y: 0, width: 1000, height: 1000 },
};
const observationAt = 10_000;
const snapshot = Uint8Array.of(1, 2, 3, 4);
const digest = computerSnapshotDigest(snapshot);

function observedScope() {
  const scope = createComputerRunScope();
  scope.target = structuredClone(target);
  scope.observation = { id: `${scope.runId}:observation`, target: structuredClone(target), digest, at: observationAt };
  return scope;
}

test("computer snapshot digest binds exact bytes independently of buffer representation", () => {
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(computerSnapshotDigest(Buffer.from(snapshot)), digest);
  assert.notEqual(computerSnapshotDigest(Uint8Array.of(1, 2, 3, 5)), digest);
});

test("computer observations authorize only the current active run and its own latest opaque ID", () => {
  const scope = observedScope();
  const id = scope.observation.id;
  assert.equal(computerObservationError(scope, target, digest, id, observationAt), null);
  for (const invalidId of [undefined, null, 1, {}, "", "a historical observation ID", observedScope().observation.id]) {
    assert.match(computerObservationError(scope, target, digest, invalidId, observationAt), /observationId/);
  }
  const previousId = id;
  scope.observation = { ...scope.observation, id: "next observation" };
  assert.match(computerObservationError(scope, target, digest, previousId, observationAt), /observationId/);
  closeComputerRunScope(scope);
  assert.equal(scope.target, undefined);
  assert.equal(scope.observation, undefined);
  assert.match(computerObservationError(scope, target, digest, "next observation", observationAt), /ended or stopped/);
  const stopped = observedScope();
  stopped.halted = true;
  assert.match(computerObservationError(stopped, target, digest, stopped.observation.id, observationAt), /ended or stopped/);
  const unbound = createComputerRunScope();
  assert.match(computerObservationError(unbound, target, digest, id, observationAt), /bound app\/window/);
});

test("computer observation lifetime accepts the freshness boundary and refuses old or future evidence", () => {
  const scope = observedScope();
  const id = scope.observation.id;
  assert.equal(computerObservationError(scope, target, digest, id, observationAt + COMPUTER_OBSERVATION_MAX_AGE_MS), null);
  for (const now of [observationAt - 1, observationAt + COMPUTER_OBSERVATION_MAX_AGE_MS + 1, Infinity, NaN]) {
    assert.match(computerObservationError(scope, target, digest, id, now), /expired/);
  }
});

test("computer observations refuse app, PID, window, frame, screen, or screenshot changes", () => {
  const scope = observedScope();
  const id = scope.observation.id;
  for (const current of [
    { ...target, app: "Another App" },
    { ...target, pid: 1235 },
    { ...target, windowId: "457" },
    ...["x", "y", "width", "height"].map((field) => ({ ...target, frame: { ...target.frame, [field]: target.frame[field] + 1 } })),
    ...["x", "y", "width", "height"].map((field) => ({ ...target, screen: { ...target.screen, [field]: target.screen[field] + 1 } })),
  ]) {
    assert.match(computerObservationError(scope, current, digest, id, observationAt), /bound app\/window.*changed/);
  }
  assert.match(computerObservationError(scope, target, computerSnapshotDigest(Uint8Array.of(9)), id, observationAt), /visible screen changed/);
  scope.observation.target = { ...target, windowId: "457" };
  assert.match(computerObservationError(scope, target, digest, id, observationAt), /visible screen changed/);
});

test("computer point boundary refuses unit coercion, non-finite values, and out-of-window positions", () => {
  assert.equal(computerPointError(100, 100, target), null);
  assert.equal(computerPointError(699, 699, target), null);
  assert.equal(computerPointError(99.5, 99.5, target), null, "the actual rounded input point is checked");
  for (const [x, y] of [["100", 100], [100, "100"], [null, 100], [NaN, 100], [100, Infinity]]) {
    assert.match(computerPointError(x, y, target), /finite numbers/);
  }
  for (const [x, y] of [[99, 100], [100, 99], [700, 100], [100, 700], [699.5, 100]]) {
    assert.match(computerPointError(x, y, target), /outside the bound window/);
  }
  const spanning = { ...target, frame: { x: -500, y: -100, width: 3000, height: 1500 } };
  for (const [x, y] of [[-1, 0], [1000, 0], [0, 1000]]) {
    assert.match(computerPointError(x, y, spanning), /primary screenshot display/);
  }
});
