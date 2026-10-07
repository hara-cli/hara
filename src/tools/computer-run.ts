import { randomUUID } from "node:crypto";
import type { DesktopTarget } from "./computer-observation.js";

/** Host-owned, ephemeral turn state. Neither model input nor persisted history grants control. */
export interface ComputerRunScope {
  readonly runId: string;
  active: boolean;
  target?: DesktopTarget;
  observation?: { id: string; target: DesktopTarget; digest: string; at: number };
  failures: number;
  halted: boolean;
}

export function createComputerRunScope(): ComputerRunScope {
  return { runId: randomUUID(), active: true, failures: 0, halted: false };
}

export function closeComputerRunScope(scope: ComputerRunScope): void {
  scope.active = false;
  scope.target = undefined;
  scope.observation = undefined;
}
