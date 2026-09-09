// App-level failover — what to do when a provider turn ENDS in an error after the central replay-safe
// transport retry policy has finished. runAgent first retries context overflow once with a tighter bounded
// snapshot; this module then decides whether a remaining error gets one fallback-model try.

export type ErrKind =
  | "context_overflow"
  | "quota_exhausted"
  | "region_unavailable"
  | "rate_limit"
  | "overloaded"
  | "auth"
  | "timeout"
  | "transient"
  | "circuit_open"
  | "interrupted"
  | "unknown";

/** Classify a provider error from its message (+ HTTP status if known). Message patterns include the
 *  Chinese strings DashScope/GLM/Qwen return, since hara targets those endpoints. */
export function classifyError(msg: string, status?: number, code?: string): ErrKind {
  const m = (msg || "").toLowerCase();
  const normalizedCode = (code || "").toUpperCase();
  if (m === "interrupted") return "interrupted";
  if (normalizedCode === "HARA_CIRCUIT_OPEN" || /connection circuit open/.test(m)) return "circuit_open";
  if (
    status === 402
    || /(?:insufficient|exhausted|exceeded).{0,20}(?:quota|credit|balance|allowance)/.test(m)
    || /(?:quota|credit|balance|allowance).{0,20}(?:exhausted|exceeded|insufficient)/.test(m)
    || /(?:额度|积分|余额).{0,12}(?:不足|耗尽|用尽|超限)/.test(m)
  ) return "quota_exhausted";
  if (
    /(?:model|service|endpoint).{0,30}(?:not available|unsupported).{0,20}(?:region|location)/.test(m)
    || /(?:region|location).{0,30}(?:not available|unsupported|not supported)/.test(m)
    || /(?:区域|地域|地区).{0,12}(?:不可用|不支持|未开放)/.test(m)
  ) return "region_unavailable";
  if (status === 401 || status === 403 || /unauthor|invalid api key|invalid.*key|forbidden|permission denied|无效|鉴权/.test(m)) return "auth";
  if (status === 429 || /rate.?limit|too many requests|\b429\b|请求过于频繁|限流/.test(m)) return "rate_limit";
  if (status === 529 || status === 503 || /overload|capacity|service unavailable|temporarily unavailable|\b503\b|\b529\b|繁忙|过载/.test(m)) return "overloaded";
  if (/context length|context window|maximum context|maximum.*token|too long|reduce the length|超过最大长度|上下文长度|输入过长/.test(m)) return "context_overflow";
  if (status === 408 || /timeout|timed out|etimedout|econnreset|socket hang up|network/.test(m)) return "timeout";
  if (typeof status === "number" && status >= 500) return "transient";
  return "unknown";
}

// Error kinds where retrying on a DIFFERENT model can plausibly help (it may not be overloaded / may differ).
const FALLBACKABLE = new Set<ErrKind>([
  "overloaded",
  "rate_limit",
  "timeout",
  "transient",
  "context_overflow",
  "quota_exhausted",
  "region_unavailable",
  "circuit_open",
  "unknown",
]);

export interface FailoverState {
  hasFallback: boolean;
  triedFallback: boolean;
  /** False after any provider stream activity, visible output, or tool call. */
  replaySafe?: boolean;
  /** Capability/health policy for the exact fallback connection. */
  compatible?: boolean;
  /** Auth failures may move only to another credential/endpoint/model generation. */
  differentConnection?: boolean;
}

/** Decide the recovery for an errored turn: retry once on the fallback model, or fail. Never auto-recovers
 *  `auth` (a config problem) or `interrupted` (the user). Context-overflow IS fallback-able — a
 *  larger-context fallback model may fit (and preemptive auto-compaction already prevents most overflows). */
export function failoverAction(kind: ErrKind, s: FailoverState): "fallback" | "fail" {
  if (kind === "interrupted" || s.replaySafe === false || s.compatible === false) return "fail";
  if (kind === "auth" && s.differentConnection !== true) return "fail";
  if (kind === "auth" && s.hasFallback && !s.triedFallback) return "fallback";
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
    case "quota_exhausted":
      return " — the provider reported this account allowance or balance is exhausted; select another authorized connection or wait for its reset";
    case "region_unavailable":
      return " — this model or service is unavailable in the connection's region; select an authorized compatible connection";
    case "circuit_open":
      return " — this exact connection is temporarily isolated after repeated failures; retry after its health probe or choose another connection";
    case "overloaded":
      return " — provider overloaded; set `fallbackModel` to auto-switch on errors";
    case "context_overflow":
      return " — context still too long after bounded retry; use `/compact` or `/new`";
    case "timeout":
      return " — network timeout; check connectivity";
    default:
      return "";
  }
}
