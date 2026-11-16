/** Closed, content-free Runtime evidence categories. These do not authorize provider recovery. */
export const RUNTIME_FAILURE_KINDS = [
  "not_installed", "version_incompatible", "runtime_auth_required", "runtime_auth_rejected",
  "runtime_network", "runtime_proxy", "invalid_model", "runtime_quota", "runtime_rate_limit",
  "runtime_permission_denied", "runtime_crashed", "project_not_trusted", "timeout", "spawn_failed", "runtime_failed",
] as const;
export type RuntimeFailureKind = typeof RUNTIME_FAILURE_KINDS[number];
const KINDS: ReadonlySet<string> = new Set(RUNTIME_FAILURE_KINDS);
const FAILURE_MARKER = "hara_runtime_failure_v1=";
export function isRuntimeFailureKind(value: unknown): value is RuntimeFailureKind {
  return typeof value === "string" && KINDS.has(value);
}

/** Undefined means no Runtime marker. A present but invalid envelope remains a Runtime failure;
 * never send its diagnostic fields, numeric timings or trailing prose to provider regexes.
 * Historical envelopes may have a human hint after their one flat object. Only kind is consumed. */
export function runtimeFailureKind(message: string | undefined): RuntimeFailureKind | undefined {
  if (!message) return undefined;
  const marker = message.indexOf(FAILURE_MARKER);
  if (marker < 0) return undefined;
  if (message.length >= 4096 || message.indexOf(FAILURE_MARKER, marker + FAILURE_MARKER.length) >= 0) return "runtime_failed";
  const source = message.slice(marker + FAILURE_MARKER.length);
  if (source[0] !== "{") return "runtime_failed";
  let quoted = false, escaped = false, start = 0;
  const keys = new Set<string>();
  for (let i = 1; i < source.length; i++) {
    const c = source[i];
    if (c === "\n" || c === "\r") break;
    if (quoted) {
      if (escaped) { escaped = false; continue; }
      if (c === "\\") { escaped = true; continue; }
      if (c === '"') {
        quoted = false;
        if (/^\s*:/.test(source.slice(i + 1))) {
          try {
            const key: string = JSON.parse(source.slice(start, i + 1));
            if (keys.has(key)) return "runtime_failed";
            keys.add(key);
          } catch { return "runtime_failed"; }
        }
      }
    } else if (c === '"') { quoted = true; start = i; }
    else if (c === "{" || c === "[") break;
    else if (c === "}") {
      try {
        const data = JSON.parse(source.slice(0, i + 1));
        if (isRuntimeFailureKind(data?.kind)) return data.kind;
      } catch { /* A malformed Runtime diagnostic cannot become a provider failure. */ }
      break;
    }
  }
  return "runtime_failed";
}
