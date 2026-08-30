// Why a slow turn is slow.
//
// Provider SDKs retry a 429 internally with backoff: several silent minutes can pass with no stream
// event, and Hara's spinner says only "waiting for the model". Being throttled and being slow to think
// then look identical, so a plan-tier rate limit reads as "Hara is slow". This records the throttle at
// the one layer that sees the HTTP status — Hara's own model fetch — so the UI can name the cause.
//
// Deliberately a process-local signal in the shape of activity.ts: it is a transient transport
// observation, never user state, and it must not outlive the condition it describes.

/** Statuses a provider uses for "come back later". 408/5xx are transport faults, not quota decisions. */
const THROTTLE_STATUSES = new Set([429, 503, 529]);

/** A throttle older than this is stale: the SDK gave up, the turn ended, or the limit cleared without
 *  another request. Expiring on read keeps a leftover from sticking to an unrelated later turn. */
export const THROTTLE_STALE_MS = 90_000;

export interface ThrottleState {
  /** How many throttled responses this episode has seen — the SDK's retry count as the user feels it. */
  attempts: number;
  status: number;
  /** Server-provided wait, when it sent one. */
  retryAfterMs?: number;
  /** When the most recent throttled response arrived. */
  at: number;
}

let state: ThrottleState | null = null;
let listener: (() => void) | null = null;
let now: () => number = () => Date.now();

/** Parse `Retry-After`, which is either delta-seconds or an HTTP date. Undefined when absent/nonsense. */
export function retryAfterMs(header: string | null | undefined, from = Date.now()): number | undefined {
  const raw = header?.trim();
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) return Number(raw) * 1000;
  const at = Date.parse(raw);
  return Number.isFinite(at) && at > from ? at - from : undefined;
}

export const throttleSignal = {
  /** The active throttle, or null. Expires itself rather than reporting a stale cause. */
  get current(): ThrottleState | null {
    if (state && now() - state.at > THROTTLE_STALE_MS) state = null;
    return state;
  },
  /** A provider answered "come back later". Repeated hits are one episode with a rising attempt count. */
  hit(status: number, header?: string | null): void {
    if (!THROTTLE_STATUSES.has(status)) return;
    const at = now();
    const stale = !state || at - state.at > THROTTLE_STALE_MS;
    state = {
      attempts: stale ? 1 : state!.attempts + 1,
      status,
      ...(retryAfterMs(header, at) !== undefined ? { retryAfterMs: retryAfterMs(header, at) } : {}),
      at,
    };
    listener?.();
  },
  /** A request got through. The cause is gone, so stop naming it. */
  clear(): void {
    if (!state) return;
    state = null;
    listener?.();
  },
  onChange(fn: (() => void) | null): void {
    listener = fn;
  },
  /** Test seam for deterministic staleness; production never sets this. */
  _setClock(fn: () => number): void {
    now = fn;
  },
};

/** One line naming the cause, for the spinner that would otherwise say only "waiting". */
export function throttleNotice(s: ThrottleState | null): string | undefined {
  if (!s) return undefined;
  const label = s.status === 429 ? "rate-limited by the provider" : "provider is overloaded";
  const wait = s.retryAfterMs ? ` · asked to wait ${Math.ceil(s.retryAfterMs / 1000)}s` : "";
  return `${label} · retrying (${s.attempts})${wait}`;
}
