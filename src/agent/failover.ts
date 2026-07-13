// App-level failover — what to do when a provider turn ENDS in an error (the SDK already retried transient
// 429/5xx via maxRetries; this handles what's left). Two recoveries: a context-overflow → compact + retry,
// and a persistent/overloaded error → retry once on a configured FALLBACK model. The decision is pure +
// tested here; runAgent just executes it (and guards each recovery to once, so no retry loops).

export type ErrKind = "context_overflow" | "rate_limit" | "overloaded" | "auth" | "timeout" | "transient" | "interrupted" | "unknown";

/** Classify a provider error from its message (+ HTTP status if known). Message patterns include the
 *  Chinese strings DashScope/GLM/Qwen return, since hara targets those endpoints. */
export function classifyError(msg: string, status?: number): ErrKind {
  const m = (msg || "").toLowerCase();
  if (m === "interrupted") return "interrupted";
  if (status === 401 || status === 403 || /unauthor|invalid api key|invalid.*key|forbidden|permission denied|无效|鉴权/.test(m)) return "auth";
  if (status === 429 || /rate.?limit|too many requests|\b429\b|请求过于频繁|限流/.test(m)) return "rate_limit";
  if (status === 529 || status === 503 || /overload|capacity|service unavailable|temporarily unavailable|\b503\b|\b529\b|繁忙|过载/.test(m)) return "overloaded";
  if (/context length|context window|maximum context|maximum.*token|too long|reduce the length|超过最大长度|上下文长度|输入过长/.test(m)) return "context_overflow";
  if (/timeout|timed out|etimedout|econnreset|socket hang up|network/.test(m)) return "timeout";
  if (typeof status === "number" && status >= 500) return "transient";
  return "unknown";
}

// Error kinds where retrying on a DIFFERENT model can plausibly help (it may not be overloaded / may differ).
const FALLBACKABLE = new Set<ErrKind>(["overloaded", "rate_limit", "timeout", "transient", "context_overflow", "unknown"]);

export interface FailoverState {
  hasFallback: boolean;
  triedFallback: boolean;
}

/** Decide the recovery for an errored turn: retry once on the fallback model, or fail. Never auto-recovers
 *  `auth` (a config problem) or `interrupted` (the user). Context-overflow IS fallback-able — a
 *  larger-context fallback model may fit (and preemptive auto-compaction already prevents most overflows). */
export function failoverAction(kind: ErrKind, s: FailoverState): "fallback" | "fail" {
  if (kind === "interrupted" || kind === "auth") return "fail";
  if (s.hasFallback && !s.triedFallback && FALLBACKABLE.has(kind)) return "fallback";
  return "fail";
}

/** A short actionable hint appended to the surfaced error message. */
export function errorHint(kind: ErrKind): string {
  switch (kind) {
    case "auth":
      return " — the configured credential was rejected or expired; update ~/.hara/config.json, the active profile, or its environment variable, then retry. Do not paste the key into chat";
    case "rate_limit":
      return " — rate-limited; wait a moment, or set `fallbackModel` to auto-switch";
    case "overloaded":
      return " — provider overloaded; set `fallbackModel` to auto-switch on errors";
    case "context_overflow":
      return " — context too long; `/compact` (or enable `autoCompact`)";
    case "timeout":
      return " — network timeout; check connectivity";
    default:
      return "";
  }
}
