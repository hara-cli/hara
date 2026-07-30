import { execFileSync } from "node:child_process";
import { isIP } from "node:net";
import { fetch as undiciFetch, ProxyAgent } from "undici";
import { readRawConfig } from "../config.js";

export type ModelProxySource = "hara-env" | "environment" | "config" | "windows-system";

export interface ModelProxySelection {
  /** Internal only. May contain credentials and must never be logged or serialized. */
  uri: string;
  source: ModelProxySource;
}

export interface WindowsProxySettings {
  enabled: boolean;
  server?: string;
  override?: string;
  autoConfigUrl?: string;
}

interface ModelProxyResolutionOptions {
  configuredProxy?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  windowsProxy?: WindowsProxySettings;
}

const WINDOWS_INTERNET_SETTINGS =
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
const proxyAgents = new Map<string, ProxyAgent>();
let cachedWindowsProxy: { at: number; value?: WindowsProxySettings } | undefined;

function nonBlank(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

function defaultPort(url: URL): string {
  return url.port || (url.protocol === "https:" ? "443" : "80");
}

function loopbackHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/gu, "").replace(/\.$/u, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const ip = isIP(host);
  if (ip === 4) return host.startsWith("127.");
  if (ip === 6) return host === "::1";
  return false;
}

/** Match conventional NO_PROXY syntax plus WinINET's semicolon-separated wildcard form. */
export function bypassesModelProxy(
  url: URL,
  value: string | undefined,
  windowsLocalToken = false,
): boolean {
  const hostname = url.hostname.replace(/^\[|\]$/gu, "").replace(/\.$/u, "").toLowerCase();
  if (loopbackHostname(hostname)) return true;
  const port = defaultPort(url);
  for (const raw of value?.split(/[\s,;]+/u) ?? []) {
    let rule = raw.trim().toLowerCase();
    if (!rule) continue;
    if (rule === "*") return true;
    if (rule === "<local>") {
      if (windowsLocalToken && !hostname.includes(".")) return true;
      continue;
    }
    try {
      if (/^https?:\/\//u.test(rule)) {
        const parsed = new URL(rule);
        if (parsed.port && parsed.port !== port) continue;
        rule = parsed.hostname.toLowerCase();
      }
    } catch {
      continue;
    }
    let rulePort: string | undefined;
    if (rule.startsWith("[")) {
      const match = /^\[([^\]]+)\](?::(\d+))?$/u.exec(rule);
      if (!match) continue;
      rule = match[1];
      rulePort = match[2];
    } else {
      const match = /^([^:]+):(\d+)$/u.exec(rule);
      if (match) {
        rule = match[1];
        rulePort = match[2];
      }
    }
    if (rulePort && rulePort !== port) continue;
    rule = rule.replace(/\.$/u, "");
    const suffix = rule.startsWith("*.") ? rule.slice(2) : rule.startsWith(".") ? rule.slice(1) : "";
    if (suffix ? hostname === suffix || hostname.endsWith(`.${suffix}`) : hostname === rule) return true;
  }
  return false;
}

export function normalizeModelProxyUri(value: string): string {
  const candidate = /^[a-z][a-z\d+.-]*:\/\//iu.test(value.trim())
    ? value.trim()
    : `http://${value.trim()}`;
  try {
    const parsed = new URL(candidate);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      || !parsed.hostname
      || parsed.pathname !== "/"
      || parsed.search
      || parsed.hash
    ) {
      throw new Error("unsupported proxy URL");
    }
    return parsed.href;
  } catch {
    throw new Error(
      "model proxy configuration is invalid; use an HTTP(S) proxy URL without a path, query, or fragment",
    );
  }
}

function regValue(output: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^\\s*${escaped}\\s+REG_[A-Z0-9_]+\\s+(.+?)\\s*$`, "imu")
    .exec(output)?.[1]
    ?.trim();
}

/** Parse one `reg.exe query ... Internet Settings` result without relying on localized headings. */
export function parseWindowsProxyRegistry(output: string): WindowsProxySettings {
  const enabledRaw = regValue(output, "ProxyEnable");
  const enabled = enabledRaw === "1" || /^0x0*1$/iu.test(enabledRaw ?? "");
  return {
    enabled,
    server: regValue(output, "ProxyServer"),
    override: regValue(output, "ProxyOverride"),
    autoConfigUrl: regValue(output, "AutoConfigURL"),
  };
}

export function readWindowsProxySettings(now = Date.now()): WindowsProxySettings | undefined {
  if (process.platform !== "win32") return undefined;
  if (cachedWindowsProxy && now - cachedWindowsProxy.at < 5_000) return cachedWindowsProxy.value;
  let value: WindowsProxySettings | undefined;
  try {
    const output = execFileSync("reg.exe", ["query", WINDOWS_INTERNET_SETTINGS], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 1_000,
      maxBuffer: 256 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    value = parseWindowsProxyRegistry(output);
  } catch {
    value = undefined;
  }
  cachedWindowsProxy = { at: now, value };
  return value;
}

/** WinINET uses `http=...;https=...` keys for destination protocols; both commonly point to an HTTP
 * CONNECT proxy. SOCKS-only settings are deliberately not reinterpreted as HTTP. */
export function windowsProxyUri(server: string | undefined, url: URL): string | undefined {
  const raw = nonBlank(server);
  if (!raw) return undefined;
  const entries = raw.split(";").map((entry) => entry.trim()).filter(Boolean);
  const mapped = new Map<string, string>();
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;
    mapped.set(entry.slice(0, separator).trim().toLowerCase(), entry.slice(separator + 1).trim());
  }
  const protocol = url.protocol === "https:" ? "https" : "http";
  const candidate = mapped.size
    ? nonBlank(mapped.get(protocol)) ?? nonBlank(mapped.get("http"))
    : raw;
  return candidate ? normalizeModelProxyUri(candidate) : undefined;
}

/** Select a provider/model proxy without changing Undici's global dispatcher. Explicit Hara settings win,
 * then standard proxy environment variables, then user config, then a static Windows system proxy. */
export function selectModelProxy(
  url: URL,
  options: ModelProxyResolutionOptions = {},
): ModelProxySelection | undefined {
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  const env = options.env ?? process.env;
  const noProxy = nonBlank(env.no_proxy) ?? nonBlank(env.NO_PROXY);
  if (bypassesModelProxy(url, noProxy)) return undefined;

  const haraProxy = nonBlank(env.HARA_MODEL_PROXY);
  if (haraProxy) return { uri: normalizeModelProxyUri(haraProxy), source: "hara-env" };
  const protocolProxy = url.protocol === "https:"
    ? nonBlank(env.https_proxy) ?? nonBlank(env.HTTPS_PROXY)
      ?? nonBlank(env.http_proxy) ?? nonBlank(env.HTTP_PROXY)
    : nonBlank(env.http_proxy) ?? nonBlank(env.HTTP_PROXY);
  if (protocolProxy) return { uri: normalizeModelProxyUri(protocolProxy), source: "environment" };
  if (options.configuredProxy) {
    return { uri: normalizeModelProxyUri(options.configuredProxy), source: "config" };
  }

  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return undefined;
  const windows = options.windowsProxy ?? readWindowsProxySettings();
  if (!windows?.enabled) return undefined;
  if (bypassesModelProxy(url, windows.override, true)) return undefined;
  const uri = windowsProxyUri(windows.server, url);
  return uri ? { uri, source: "windows-system" } : undefined;
}

function proxyAgent(uri: string): ProxyAgent {
  let agent = proxyAgents.get(uri);
  if (!agent) {
    agent = new ProxyAgent({ uri, proxyTunnel: true });
    proxyAgents.set(uri, agent);
  }
  return agent;
}

function networkErrorCode(error: unknown): string | undefined {
  const candidate = error as {
    code?: unknown;
    cause?: { code?: unknown; cause?: { code?: unknown } };
  };
  const values = [candidate?.code, candidate?.cause?.code, candidate?.cause?.cause?.code];
  return values.find((value): value is string =>
    typeof value === "string" && /^[A-Z][A-Z0-9_]{1,39}$/u.test(value)
  );
}

function safeModelNetworkError(error: unknown, proxy?: ModelProxySelection): Error {
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) return error;
  const code = networkErrorCode(error);
  const networkPath = proxy
    ? proxy.source === "windows-system"
      ? " through the Windows system proxy"
      : " through the configured proxy"
    : "";
  return new Error(
    `model network request failed${networkPath}${code ? ` (${code})` : ""}; check the endpoint, VPN, and proxy settings`,
  );
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Custom SDK fetch that applies a request-scoped dispatcher and returns only redacted transport errors. */
export function createModelFetch(
  configuredProxy?: string,
  resolutionDefaults: Omit<ModelProxyResolutionOptions, "configuredProxy"> = {},
): FetchLike {
  return async (input, init) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    const url = new URL(rawUrl);
    const proxy = selectModelProxy(url, { ...resolutionDefaults, configuredProxy });
    try {
      const response = proxy
        ? await undiciFetch(input as Parameters<typeof undiciFetch>[0], {
            ...(init as Parameters<typeof undiciFetch>[1]),
            dispatcher: proxyAgent(proxy.uri),
          })
        : await globalThis.fetch(input, init);
      return response as unknown as Response;
    } catch (error) {
      throw safeModelNetworkError(error, proxy);
    }
  };
}

/** Provider-side traffic outside a loaded run (OAuth, enrollment and model discovery) may use only the
 * user-owned global proxy setting. A project `.hara/config.json` must never choose the route carrying a
 * provider or device credential. */
export const userModelFetch: FetchLike = (input, init) => {
  const raw = readRawConfig();
  const configuredProxy =
    typeof raw.proxy === "string" && raw.proxy.trim() ? raw.proxy.trim() : undefined;
  return createModelFetch(configuredProxy)(input, init);
};
