/** Stable evidence categories. Native output is inspected here, never returned or retained. */
export const RUNTIME_FAILURE_KINDS = [
  "not_installed", "version_incompatible", "runtime_auth_required", "runtime_auth_rejected",
  "runtime_network", "runtime_proxy", "invalid_model", "runtime_quota", "runtime_rate_limit",
  "runtime_permission_denied", "runtime_crashed", "project_not_trusted", "timeout", "spawn_failed", "runtime_failed",
] as const;
export type RuntimeFailureKind = typeof RUNTIME_FAILURE_KINDS[number];
export interface RuntimeFailureContext {
  runtime: "codex" | "claude" | "opencode" | "pi";
  version: string | null;
  loginSource: "host" | "isolated" | "unknown";
  homeMatchesAccount: boolean | null;
}
export interface RuntimeFailureDiagnostic extends RuntimeFailureContext {
  kind: RuntimeFailureKind;
  elapsedMs: number;
  retryAtMs: number;
  consecutiveFailures: number;
}

const knownKind = (value: unknown): value is RuntimeFailureKind =>
  typeof value === "string" && (RUNTIME_FAILURE_KINDS as readonly string[]).includes(value);
const CODE_KINDS: Readonly<Record<string, RuntimeFailureKind>> = {
  enoent: "not_installed", command_not_found: "not_installed", not_registered: "not_installed", runtime_not_found: "not_installed",
  runtime_unavailable: "not_installed", runtime_version_too_old: "version_incompatible", unsupported_version: "version_incompatible",
  runtime_login_required: "runtime_auth_required", authentication_required: "runtime_auth_required", auth_required: "runtime_auth_required",
  not_logged_in: "runtime_auth_required", unauthorized: "runtime_auth_rejected", authentication_failed: "runtime_auth_rejected",
  auth_failed: "runtime_auth_rejected", invalid_api_key: "runtime_auth_rejected", eacces: "runtime_permission_denied",
  eperm: "runtime_permission_denied", permission_denied: "runtime_permission_denied", model_not_found: "invalid_model",
  model_not_configured: "invalid_model", unknown_model: "invalid_model", quota_exhausted: "runtime_quota",
  insufficient_quota: "runtime_quota", billing_error: "runtime_quota", rate_limit_exceeded: "runtime_rate_limit",
  econnrefused: "runtime_network", econnreset: "runtime_network", enotfound: "runtime_network", eai_again: "runtime_network",
  etimedout: "timeout", timed_out: "timeout", proxy_connect_failed: "runtime_proxy", spawn_error: "spawn_failed",
  runtime_proxy_invalid: "runtime_proxy", runtime_proxy_unreachable: "runtime_proxy", runtime_proxy_failed: "runtime_proxy",
};

export function classifyRuntimeFailure(input: {
  code?: string; stderr?: string; status?: number; timedOut?: boolean; signal?: string | null;
}): RuntimeFailureKind {
  const code = typeof input.code === "string" ? input.code.slice(0, 64).trim().toLowerCase() : "";
  if (knownKind(code)) return code;
  if (Object.hasOwn(CODE_KINDS, code)) return CODE_KINDS[code]!;
  if (input.timedOut) return "timeout";
  if (input.signal === "SIGSEGV" || input.signal === "SIGABRT" || input.signal === "SIGBUS") return "runtime_crashed";
  // Limit both the amount read and its UTF-8 representation, including malicious multibyte output.
  const text = typeof input.stderr === "string" ? Buffer.from(input.stderr.slice(0, 65_536)).subarray(0, 65_536).toString("utf8") : "";
  if (/not inside a trusted directory|--skip-git-repo-check was not specified|not a git repository/iu.test(text)) return "project_not_trusted";
  if (/unknown[ ._-]*model|unknown[ ._-]+provider|provider[ ._-]+not[ ._-]+found|model[ ._-]*not[ ._-]*found|model[ ._-]*not[ ._-]*configured|model.{0,100}(?:not recognized|not supported|unsupported|does not exist)|(?:plan|subscription|tier).{0,100}(?:does not (?:include|support)|not (?:include|support)).{0,50}model|(?:unsupported|unavailable)[ ._-]+model/iu.test(text)) return "invalid_model";
  if (input.status === 402 || /\b402\b|insufficient[ ._-]+(?:account[ ._-]+)?(?:quota|credits?|balance|funds)|(?:quota|credits?|balance|funds|allowance).{0,30}(?:exhausted|depleted|used up|run out)|(?:余额|餘額|额度|額度|配额|配額).{0,12}(?:不足|耗尽|耗盡|用尽|用盡)/iu.test(text)) return "runtime_quota";
  if (/proxy[ ._-]*(?:authentication|connect|connection|error|failed)|(?:connect|connection).{0,40}(?:proxy|socks)|socks.{0,40}(?:failed|refused|error)|\b407\b|tunnel.{0,30}(?:failed|refused)/iu.test(text)) return "runtime_proxy";
  if (input.status === 401 || /\b401\b|\bunauthori[sz]ed\b|invalid[ ._-]*(?:api[ ._-]*)?key|(?:authentication|credentials?)[ ._-]*(?:failed|rejected|invalid|expired)|(?:expired|invalid|rejected)[ ._-]+(?:authentication|credentials?|access[ ._-]+token)/iu.test(text)) return "runtime_auth_rejected";
  if (/not logged in|login[ ._-]+required|authentication[ ._-]+required|missing[ ._-]+(?:authentication|credentials?)|please[ ._-]+(?:log|sign)[ ._-]+in/iu.test(text)) return "runtime_auth_required";
  if (input.status === 403 || /\b403\b|permission[ ._-]*denied|access[ ._-]*denied|\bforbidden\b/iu.test(text)) return "runtime_permission_denied";
  if (input.status === 429 || /\b429\b|rate[ ._-]*limit|too many requests|requests per minute|tokens per minute/iu.test(text)) return "runtime_rate_limit";
  if (/\b(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN)\b|cannot[ ._-]*connect|(?:failed|unable) to connect|network[ ._-]*(?:connection[ ._-]*)?(?:error|unreachable|failed)|fetch[ ._-]*failed|connection[ ._-]*(?:refused|reset|closed)|socket[ ._-]*hang[ ._-]*up|DNS[ ._-]*(?:lookup|error)/iu.test(text)) return "runtime_network";
  if (/\bETIMEDOUT\b|\btimed[ ._-]*out\b|\btimeout\b/iu.test(text)) return "timeout";
  if (/(?:unknown|unrecognized|unsupported)[ ._-]+(?:cli[ ._-]+)?(?:option|flag)|unexpected argument.{0,100}found|(?:cli|runtime|codex|claude|opencode).{0,40}version.{0,40}(?:too old|not supported|unsupported|incompatible)|requires? (?:Node(?:\.js)?|runtime) (?:version )?\d/iu.test(text)) return "version_incompatible";
  if (/segmentation fault|\bSIGSEGV\b|\bSIGABRT\b|\bSIGBUS\b|thread.{0,80}panicked|fatal runtime panic|fatal error:.*(?:heap|memory)/iu.test(text)) return "runtime_crashed";
  return "runtime_failed";
}

/** Accept only a version or a documented CLI's version banner, never free-form diagnostics. */
export function safeRuntimeVersion(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 128) return null;
  const match = /^(?:(?:codex-cli|opencode) )?(\d{1,4}\.\d{1,4}\.\d{1,4})(?: \(Claude Code\))?$/u.exec(value.trim());
  return match?.[1] ?? null;
}
const integer = (value: unknown, max: number): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(0, Math.floor(value))) : 0;
const MAX_DATE_MS = 8_640_000_000_000_000;

/** Whitelist projection: no native output, environment value, path, prompt or account data is copied. */
export function runtimeFailureMessage(input: RuntimeFailureContext & {
  kind: RuntimeFailureKind; elapsedMs: number; retryAtMs?: number; consecutiveFailures?: number;
}): string {
  if (!["codex", "claude", "opencode", "pi"].includes(input.runtime)) throw new Error("Invalid diagnostic runtime");
  const diagnostic: RuntimeFailureDiagnostic = {
    runtime: input.runtime,
    kind: knownKind(input.kind) ? input.kind : "runtime_failed",
    version: safeRuntimeVersion(input.version),
    loginSource: input.loginSource === "host" || input.loginSource === "isolated" ? input.loginSource : "unknown",
    homeMatchesAccount: typeof input.homeMatchesAccount === "boolean" ? input.homeMatchesAccount : null,
    elapsedMs: integer(input.elapsedMs, 600_000),
    retryAtMs: integer(input.retryAtMs, MAX_DATE_MS),
    consecutiveFailures: integer(input.consecutiveFailures, 1_000),
  };
  return "hara_runtime_failure_v1=" + JSON.stringify(diagnostic);
}

export interface RuntimeCooldownState {
  kind: RuntimeFailureKind;
  retryAtMs: number;
  consecutiveFailures: number;
}

/** An admission fence only: it never schedules, retries or changes the frozen runtime. */
export class RuntimeLaunchCooldown {
  private state: RuntimeCooldownState | null = null;

  blocked(now = Date.now()): RuntimeCooldownState | null {
    return this.state && integer(now, MAX_DATE_MS) < this.state.retryAtMs ? { ...this.state } : null;
  }

  failed(kind: RuntimeFailureKind, elapsedMs: number, now = Date.now()): void {
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs > 15_000) { this.succeeded(); return; }
    const consecutiveFailures = Math.min(1_000, (this.state?.consecutiveFailures ?? 0) + 1);
    const delayMs = Math.min(30_000, 1_000 * 2 ** Math.min(consecutiveFailures - 1, 5));
    this.state = { kind: knownKind(kind) ? kind : "runtime_failed", consecutiveFailures,
      retryAtMs: Math.min(MAX_DATE_MS, integer(now, MAX_DATE_MS) + delayMs) };
  }

  succeeded(): void { this.state = null; }
}
