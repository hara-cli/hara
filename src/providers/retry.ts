import { classifyError, type ErrKind } from "../agent/failover.js";
import { retryAfterMs as parseRetryAfterMs } from "../network/throttle-signal.js";
import type { Provider, ProviderErrorMetadata, ProviderRetryEvent, TurnArgs, TurnResult } from "./types.js";

const RETRYABLE_KINDS = new Set<ErrKind>(["rate_limit", "overloaded", "timeout", "transient"]);

export interface ProviderRetryPolicy {
  /** Total wire attempts, including the initial request. */
  maxAttempts: number;
  /** Latest elapsed point at which another request may be scheduled, including provider time and backoff. */
  maxElapsedMs: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_PROVIDER_RETRY_POLICY: Readonly<ProviderRetryPolicy> = Object.freeze({
  maxAttempts: 3,
  maxElapsedMs: 60_000,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
});

interface RetryRuntime {
  now?: () => number;
  random?: () => number;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<boolean>;
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  return Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.trunc(value!)))
    : fallback;
}

function normalizedPolicy(policy: Partial<ProviderRetryPolicy> = {}): ProviderRetryPolicy {
  return {
    maxAttempts: boundedInteger(policy.maxAttempts, DEFAULT_PROVIDER_RETRY_POLICY.maxAttempts, 1, 10),
    maxElapsedMs: boundedInteger(policy.maxElapsedMs, DEFAULT_PROVIDER_RETRY_POLICY.maxElapsedMs, 0, 10 * 60_000),
    baseDelayMs: boundedInteger(policy.baseDelayMs, DEFAULT_PROVIDER_RETRY_POLICY.baseDelayMs, 0, 60_000),
    maxDelayMs: boundedInteger(policy.maxDelayMs, DEFAULT_PROVIDER_RETRY_POLICY.maxDelayMs, 0, 5 * 60_000),
  };
}

function errorMember(error: unknown, name: "status" | "code" | "headers"): unknown {
  const visited = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 6 && current && !visited.has(current); depth += 1) {
    visited.add(current);
    if (typeof current !== "object") return undefined;
    const candidate = current as Record<string, unknown>;
    if (candidate[name] !== undefined) return candidate[name];
    current = candidate.cause;
  }
  return undefined;
}

function retryAfterHeader(headers: unknown): string | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  const getter = (headers as { get?: unknown }).get;
  if (typeof getter === "function") {
    try {
      const value = getter.call(headers, "retry-after");
      return typeof value === "string" ? value : undefined;
    } catch {
      return undefined;
    }
  }
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() === "retry-after" && typeof value === "string") return value;
  }
  return undefined;
}

/** Extract only bounded transport facts. Request bodies, URLs, headers, and credentials never enter this
 * structure, so it is safe to pass through retry telemetry and renderer notices. */
export function providerErrorMetadata(error: unknown, at = Date.now()): ProviderErrorMetadata | undefined {
  const rawStatus = errorMember(error, "status");
  const status = typeof rawStatus === "number" && Number.isInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599
    ? rawStatus
    : undefined;
  const rawCode = errorMember(error, "code");
  const code = typeof rawCode === "string" && /^[A-Z][A-Z0-9_]{1,39}$/u.test(rawCode)
    ? rawCode
    : undefined;
  const retryAfter = parseRetryAfterMs(retryAfterHeader(errorMember(error, "headers")), at);
  return status !== undefined || code !== undefined || retryAfter !== undefined
    ? {
        ...(status !== undefined ? { status } : {}),
        ...(code !== undefined ? { code } : {}),
        ...(retryAfter !== undefined ? { retryAfterMs: retryAfter } : {}),
      }
    : undefined;
}

function replaySafeFailure(result: TurnResult, streamActivity: boolean): boolean {
  return result.stop === "error"
    && !streamActivity
    && result.text.length === 0
    && result.toolUses.length === 0
    && (result.usage?.output ?? 0) === 0;
}

function retryDelayMs(
  retryNumber: number,
  metadata: ProviderErrorMetadata | undefined,
  policy: ProviderRetryPolicy,
  random: () => number,
): number | undefined {
  if (metadata?.retryAfterMs !== undefined) {
    // Retrying before the provider's explicit boundary is worse than stopping: it can prolong throttling for
    // the user and the rest of a fleet. A server wait outside Hara's bounded window is therefore terminal.
    return metadata.retryAfterMs <= policy.maxDelayMs
      ? Math.max(0, metadata.retryAfterMs)
      : undefined;
  }
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, retryNumber - 1));
  // 0.8..1.2 jitter prevents a fleet from waking on one boundary. Tests inject a deterministic source.
  return Math.min(policy.maxDelayMs, Math.max(0, Math.round(exponential * (0.8 + random() * 0.4))));
}

async function cancellableSleep(delayMs: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false;
  if (delayMs <= 0) return true;
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (completed: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(completed);
    };
    const onAbort = (): void => finish(false);
    const timer = setTimeout(() => finish(true), delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Wrap one provider with a transport-neutral retry coordinator. A request becomes permanently
 * non-replayable as soon as ANY stream activity occurs; model/tool/file side effects therefore cannot be
 * duplicated by this layer. Provider-specific compatibility retries stay inside their adapter. */
export function withProviderRetry(
  provider: Provider,
  policyInput: Partial<ProviderRetryPolicy> = {},
  runtime: RetryRuntime = {},
): Provider {
  const policy = normalizedPolicy(policyInput);
  const now = runtime.now ?? (() => Date.now());
  const random = runtime.random ?? (() => Math.random());
  const sleep = runtime.sleep ?? cancellableSleep;
  return {
    ...provider,
    async turn(args: TurnArgs): Promise<TurnResult> {
      const startedAt = now();
      let attempt = 1;
      while (true) {
        if (args.signal?.aborted) {
          return { text: "", toolUses: [], stop: "error", errorMsg: "interrupted" };
        }
        let streamActivity = false;
        const markActivity = (): void => {
          streamActivity = true;
          args.onActivity?.();
        };
        const result = await provider.turn({
          ...args,
          onActivity: markActivity,
          onText(delta) {
            if (delta) streamActivity = true;
            args.onText(delta);
          },
          onReasoning(delta) {
            if (delta) streamActivity = true;
            args.onReasoning?.(delta);
          },
        });
        const kind = classifyError(result.errorMsg ?? "", result.errorMetadata?.status);
        if (
          attempt >= policy.maxAttempts
          || args.signal?.aborted
          || !replaySafeFailure(result, streamActivity)
          || !RETRYABLE_KINDS.has(kind)
        ) {
          return result;
        }

        const delayMs = retryDelayMs(attempt, result.errorMetadata, policy, random);
        if (delayMs === undefined) return result;
        const elapsedMs = Math.max(0, now() - startedAt);
        if (elapsedMs + delayMs > policy.maxElapsedMs) return result;
        const event: ProviderRetryEvent = {
          provider: provider.id,
          model: provider.model,
          attempt,
          nextAttempt: attempt + 1,
          kind: kind as ProviderRetryEvent["kind"],
          delayMs,
          elapsedMs,
          ...(result.errorMetadata?.status !== undefined ? { status: result.errorMetadata.status } : {}),
        };
        args.onRetry?.(event);
        // A retry decision is transport progress and keeps an outer silence watchdog from racing a valid
        // provider-directed wait. It does not relax replay safety for the next independent attempt.
        args.onActivity?.();
        if (!(await sleep(delayMs, args.signal))) {
          return { text: "", toolUses: [], stop: "error", errorMsg: "interrupted" };
        }
        attempt += 1;
      }
    },
  };
}
