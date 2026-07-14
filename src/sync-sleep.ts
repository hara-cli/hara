// Cross-runtime synchronous short wait for the tiny retry delays used by file locks.
//
// Bun standalone binaries do not guarantee that SharedArrayBuffer exists, so never construct one at
// module evaluation time. Prefer Bun's native primitive, use Atomics only in Node, and retain a bounded
// last resort so a missing/disabled runtime primitive cannot make lock acquisition crash or spin forever.

const MAX_SHORT_WAIT_MS = 100;
const MAX_FALLBACK_SPINS = 5_000_000;

type BunRuntime = {
  sleepSync?: (milliseconds: number) => unknown;
};

type WaitGlobals = {
  Bun?: BunRuntime;
  SharedArrayBuffer?: typeof SharedArrayBuffer;
  Atomics?: typeof Atomics;
};

let nodeWaitCell: Int32Array | undefined;

function boundedDelay(milliseconds: number): number {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return 0;
  return Math.min(MAX_SHORT_WAIT_MS, Math.ceil(milliseconds));
}

/** Block for a small, bounded retry delay without assuming SharedArrayBuffer is available. */
export function sleepSync(milliseconds: number): void {
  const delay = boundedDelay(milliseconds);
  if (delay === 0) return;

  const runtime = globalThis as unknown as WaitGlobals;

  if (typeof runtime.Bun?.sleepSync === "function") {
    try {
      runtime.Bun.sleepSync(delay);
      return;
    } catch {
      // A partially implemented Bun runtime still gets the bounded fallback below.
    }
  }

  // Atomics.wait is a dependable synchronous sleep on Node's main thread. Do not use this branch in
  // Bun: a compiled Bun executable may expose part of the Node compatibility surface without SAB.
  if (!runtime.Bun && typeof runtime.SharedArrayBuffer === "function" && typeof runtime.Atomics?.wait === "function") {
    try {
      nodeWaitCell ??= new Int32Array(new runtime.SharedArrayBuffer(4));
      runtime.Atomics.wait(nodeWaitCell, 0, 0, delay);
      return;
    } catch {
      nodeWaitCell = undefined;
      // Some embedders disable blocking Atomics even when the globals exist. Fall through safely.
    }
  }

  const deadline = Date.now() + delay;
  for (let spins = 0; spins < MAX_FALLBACK_SPINS && Date.now() < deadline; spins++) {
    // Intentionally empty: both time and iteration ceilings bound this compatibility fallback.
  }
}
