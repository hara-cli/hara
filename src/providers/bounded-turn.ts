import type { Provider, TurnArgs, TurnResult } from "./types.js";

export interface BoundedTurnOptions {
  /** A hard wall-clock bound. The Promise settles at this deadline even when a provider ignores abort. */
  timeoutMs: number;
  /** Optional parent lifecycle (agent run, TUI turn, gateway shutdown, and so on). */
  signal?: AbortSignal;
  /** Static, non-sensitive operation name used in the returned error. */
  label?: string;
  /** Observe the provider Promise's physical lifetime. Persistent hosts use this to delay cooperative
   * shutdown even when the logical bounded call has already timed out and returned. */
  onProviderTurn?: (turn: Promise<unknown>) => void;
}

const errorResult = (message: string): TurnResult => ({ text: "", toolUses: [], stop: "error", errorMsg: message });

/**
 * Execute a one-shot provider call behind both cooperative cancellation and a hard Promise boundary.
 *
 * Passing only an AbortSignal is insufficient: third-party SDKs and custom providers may ignore it and
 * leave their Promise pending forever. This helper aborts the request for cooperative providers while also
 * resolving the caller independently. The abandoned provider Promise always retains rejection handling.
 */
export async function boundedProviderTurn(
  provider: Provider,
  args: TurnArgs,
  options: BoundedTurnOptions,
): Promise<TurnResult> {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, Math.trunc(options.timeoutMs)) : 60_000;
  const label = options.label?.trim() || "model call";
  const parent = options.signal ?? args.signal;
  if (parent?.aborted) return errorResult(`${label} cancelled`);

  const controller = new AbortController();
  let stopResolve!: (result: TurnResult) => void;
  const stopped = new Promise<TurnResult>((resolve) => (stopResolve = resolve));
  let stopSettled = false;
  const stop = (message: string): void => {
    if (stopSettled) return;
    stopSettled = true;
    controller.abort(new Error(message));
    stopResolve(errorResult(message));
  };
  const onParentAbort = (): void => stop(`${label} cancelled`);
  parent?.addEventListener("abort", onParentAbort, { once: true });

  // Keep this timer referenced. In a short-lived headless process it may be the only active handle keeping
  // the hard boundary alive while a deliberately non-cooperative test/provider returns a handle-less Promise.
  const timer = setTimeout(() => stop(`${label} timed out after ${timeoutMs}ms`), timeoutMs);
  const turn = Promise.resolve()
    // Cancellation may happen synchronously after this async function returns but before its provider
    // microtask starts. Re-check here so an already-cancelled auxiliary call never incurs a request/cost.
    .then(() => controller.signal.aborted ? errorResult(`${label} cancelled`) : provider.turn({ ...args, signal: controller.signal }))
    .catch((error: unknown) => errorResult(error instanceof Error ? error.message : String(error)));
  try {
    options.onProviderTurn?.(turn);
  } catch {
    // Observability must never weaken the provider boundary.
  }

  const result = await Promise.race([turn, stopped]);
  clearTimeout(timer);
  parent?.removeEventListener("abort", onParentAbort);
  stopSettled = true;
  // A parent cancellation remains authoritative if it raced a provider's late success.
  return parent?.aborted ? errorResult(`${label} cancelled`) : result;
}
