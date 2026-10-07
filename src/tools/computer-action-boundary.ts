import { createHash } from "node:crypto";
import { sameDesktopTarget, pointInTarget, type DesktopTarget } from "./computer-observation.js";
import type { ComputerRunScope } from "./computer-run.js";

export const COMPUTER_OBSERVATION_MAX_AGE_MS = 30_000;
export function computerSnapshotDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Fail closed on stale/foreign observations; no coordinate/unit guessing and no automatic target swap. */
export function computerObservationError(
  scope: ComputerRunScope,
  current: DesktopTarget,
  digest: string,
  observationId?: unknown,
  now = Date.now(),
): string | null {
  if (!scope.active || scope.halted) return "this computer-control run has ended or stopped";
  if (!scope.target || !sameDesktopTarget(scope.target, current)) return "the bound app/window or its geometry changed; activate the intended app again";
  const previous = scope.observation;
  if (!previous || observationId !== previous.id) return "a current observationId from this run's screenshot is required";
  if (!Number.isFinite(now) || now < previous.at || now - previous.at > COMPUTER_OBSERVATION_MAX_AGE_MS) {
    return "the observation expired; take a fresh screenshot";
  }
  if (!sameDesktopTarget(previous.target, current) || previous.digest !== digest) return "the visible screen changed since observation; take a fresh screenshot";
  return null;
}

export function computerPointError(x: unknown, y: unknown, target: DesktopTarget): string | null {
  if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) {
    return "pointer coordinates must be finite numbers";
  }
  return pointInTarget(Math.round(x), Math.round(y), target) ? null
    : "pointer coordinates are outside the bound window or primary screenshot display";
}
