import { connect as connectTcp, type Socket } from "node:net";
import { connect as connectTls } from "node:tls";

export type RuntimeProxyFailure = "runtime_proxy_invalid" | "runtime_proxy_unreachable" | "runtime_proxy_failed";
export class RuntimeProxyError extends Error {
  constructor(readonly code: RuntimeProxyFailure) { super(code); this.name = "RuntimeProxyError"; }
}
export function runtimeProxyFailure(error: unknown): RuntimeProxyFailure | undefined {
  return error instanceof RuntimeProxyError ? error.code : undefined;
}
/** Explicit Workspace endpoints carry no credentials, paths or provider query parameters. */
export function normalizeRuntimeProxyUrl(raw: unknown): string | null {
  if (raw === null || raw === "") return null;
  if (typeof raw !== "string" || !/^https?:\/\//u.test(raw) || raw.length > 2048 || /[\s\u0000-\u001f\u007f?#@]/u.test(raw)) throw new RuntimeProxyError("runtime_proxy_invalid");
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password
      || url.search || url.hash || url.pathname !== "/") throw new Error();
    return url.origin;
  } catch { throw new RuntimeProxyError("runtime_proxy_invalid"); }
}
const LOOPBACK = ["localhost", "127.0.0.1", "::1", "[::1]"];
/** Only loopback bypasses survive an explicit proxy; wildcard/provider bypasses could silently go direct. */
export function runtimeProxyEnv(env: NodeJS.ProcessEnv, proxyUrl: string | null): NodeJS.ProcessEnv {
  if (proxyUrl === null) {
    // Inherited AI routing stays untouched. Local Host MCP traffic must always stay local.
    const bypass = new Set<string>();
    for (const [key, value] of Object.entries(env)) if (key.toUpperCase() === "NO_PROXY")
      for (const token of (value ?? "").split(",").map(value => value.trim()).filter(Boolean)) bypass.add(token);
    for (const token of LOOPBACK) bypass.add(token);
    const next = { ...env };
    for (const key of Object.keys(next)) if (key.toUpperCase() === "NO_PROXY") delete next[key];
    next.NO_PROXY = next.no_proxy = [...bypass].join(",");
    return next;
  }
  const endpoint = normalizeRuntimeProxyUrl(proxyUrl)!;
  const bypass = new Set(LOOPBACK);
  for (const [key, value] of Object.entries(env)) if (key.toUpperCase() === "NO_PROXY") {
    for (const token of (value ?? "").split(",").map(value => value.trim().toLowerCase())) {
      if (/^(?:localhost|127(?:\.(?:0|[1-9]\d{0,2})){3}|\[::1\])(?::\d{1,5})?$/u.test(token) || token === "::1") bypass.add(token);
    }
  }
  const next = { ...env };
  for (const name of Object.keys(next)) if (["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"].includes(name.toUpperCase())) delete next[name];
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]) { next[name] = endpoint; next[name.toLowerCase()] = endpoint; }
  next.NO_PROXY = next.no_proxy = [...bypass].join(",");
  return next;
}
/** Bounded endpoint check, not a claim that a remote provider request will succeed. No model request or retry. */
export async function assertRuntimeProxyReachable(proxyUrl: string | null, signal?: AbortSignal, timeoutMs = 1500): Promise<void> {
  if (proxyUrl === null) return;
  const endpoint = new URL(normalizeRuntimeProxyUrl(proxyUrl)!);
  if (signal?.aborted) throw new Error("interrupted");
  await new Promise<void>((resolve, reject) => {
    let socket: Socket | undefined, settled = false;
    const finish = (error?: Error) => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort);
      socket?.destroy(); error ? reject(error) : resolve();
    };
    const abort = () => finish(new Error("interrupted"));
    const timer = setTimeout(() => finish(new RuntimeProxyError("runtime_proxy_unreachable")), Math.max(1, Math.min(timeoutMs, 5000)));
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const host = endpoint.hostname.replace(/^\[|\]$/gu, ""), port = Number(endpoint.port || (endpoint.protocol === "https:" ? 443 : 80));
      socket = endpoint.protocol === "https:" ? connectTls({ host, port, servername: host.includes(":") ? undefined : host, rejectUnauthorized: true }, () => finish())
        : connectTcp({ host, port }, () => finish());
      socket.once("error", () => finish(new RuntimeProxyError("runtime_proxy_unreachable")));
      if (signal?.aborted) abort();
    } catch { finish(new RuntimeProxyError("runtime_proxy_unreachable")); }
  });
}
/** Opt-in evidence from native stderr/events only; never return its content or guess from any network error. */
export function runtimeProxyFailureFromText(text: string, explicitProxy: boolean): RuntimeProxyFailure | undefined {
  if (!explicitProxy) return undefined;
  if (/\b407\b|proxy authentication|required proxy authentication|proxyconnect|proxy error|proxy.*(?:refused|unreachable|timed? ?out|failed|failure)|(?:failed|unable|cannot|could not) to (?:connect|resolve).*proxy|tunnel.*(?:failed|failure)/iu.test(text.slice(0, 65536))) return "runtime_proxy_failed";
  return undefined;
}
