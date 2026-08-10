import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { platform } from "node:os";
import { win32 } from "node:path";
import { toolSubprocessEnv } from "../security/subprocess-env.js";
import { registerTool, type Tool } from "./registry.js";

const MAX_BROWSER_URL_BYTES = 16 * 1024;
const LAUNCH_TIMEOUT_MS = 5_000;

export interface BrowserOpenInvocation {
  command: string;
  args: string[];
  browser: string;
}

export interface BrowserLaunchOptions {
  platform?: NodeJS.Platform;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  spawnProcess?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
}

export type BrowserLauncher = (
  url: string,
  options?: BrowserLaunchOptions,
) => Promise<void>;

function cancellationError(): Error {
  const error = new Error("browser opening was cancelled before the system accepted it");
  error.name = "AbortError";
  return error;
}

/** Accept only explicit HTTP(S) navigation. Keeping files, applications, custom protocols, credentials,
 * and shell text out of this narrow tool prevents it from becoming a generic host-process escape. */
export function resolveBrowserUrl(value: unknown): URL {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("`url` must be a non-empty HTTP(S) URL");
  }
  const raw = value.trim();
  if (/\u0000|[\u0001-\u001f\u007f]/u.test(raw)) throw new Error("`url` contains control characters");
  if (Buffer.byteLength(raw, "utf8") > MAX_BROWSER_URL_BYTES) {
    throw new Error(`\`url\` exceeds ${MAX_BROWSER_URL_BYTES} bytes`);
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("`url` is invalid; include http:// or https://");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("only http:// and https:// URLs are supported");
  }
  if (parsed.username || parsed.password) {
    throw new Error("URL-embedded credentials are not supported");
  }
  return parsed;
}

/** Fixed executable + argv selection. The URL is never interpolated into a shell command. */
export function browserOpenInvocation(
  url: string,
  hostPlatform: NodeJS.Platform = platform(),
  env: NodeJS.ProcessEnv = process.env,
): BrowserOpenInvocation {
  if (hostPlatform === "darwin") {
    return { command: "/usr/bin/open", args: [url], browser: "the default browser" };
  }
  if (hostPlatform === "linux") {
    return { command: "/usr/bin/xdg-open", args: [url], browser: "the default browser" };
  }
  if (hostPlatform === "win32") {
    const configuredRoot = String(env.SystemRoot ?? env.WINDIR ?? "").trim();
    const systemRoot = configuredRoot && win32.isAbsolute(configuredRoot) && !configuredRoot.includes("\0")
      ? configuredRoot
      : "C:\\Windows";
    return {
      command: win32.join(systemRoot, "explorer.exe"),
      args: [url],
      browser: "the default browser",
    };
  }
  throw new Error(`opening a browser is not supported on platform ${hostPlatform}`);
}

/** Dispatch a bounded, secret-scrubbed, shell-free navigation request and return once the OS accepts it. */
export async function launchBrowserUrl(
  url: string,
  options: BrowserLaunchOptions = {},
): Promise<void> {
  const hostPlatform = options.platform ?? platform();
  const invocation = browserOpenInvocation(url, hostPlatform, options.env ?? process.env);
  const spawnProcess = options.spawnProcess ?? spawn;
  const signal = options.signal;
  if (signal?.aborted) throw cancellationError();

  await new Promise<void>((resolveLaunch, rejectLaunch) => {
    let child: ChildProcess;
    let settled = false;
    const settle = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortLaunch);
      if (error) rejectLaunch(error);
      else resolveLaunch();
    };
    const abortLaunch = (): void => {
      try { child?.kill(); } catch { /* best effort before dispatch */ }
      settle(cancellationError());
    };
    const timer = setTimeout(() => {
      try { child?.kill(); } catch { /* best effort */ }
      settle(new Error(`system browser did not accept the request within ${LAUNCH_TIMEOUT_MS}ms`));
    }, LAUNCH_TIMEOUT_MS);

    try {
      child = spawnProcess(invocation.command, invocation.args, {
        detached: true,
        env: toolSubprocessEnv(options.env ?? process.env),
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      });
    } catch (error) {
      settle(error instanceof Error ? error : new Error("failed to start the system browser"));
      return;
    }
    child.once("error", (error) => settle(error));
    child.once("spawn", () => {
      child.unref();
      settle();
    });
    signal?.addEventListener("abort", abortLaunch, { once: true });
    if (signal?.aborted) abortLaunch();
  });
}

function safeDisplayUrl(parsed: URL): string {
  return `${parsed.origin}${parsed.pathname}${parsed.search ? "?[query omitted]" : ""}${parsed.hash ? "#[fragment omitted]" : ""}`;
}

export function createOpenBrowserTool(launcher: BrowserLauncher = launchBrowserUrl): Tool {
  return {
    name: "open_browser",
    description:
      "Open an explicit http(s) URL in the user's real default browser. Use this directly for website UI, SPA, visual, or interaction testing; " +
      "web_fetch is for text/content retrieval and cannot prove what a user sees. After opening, use the computer tool to screenshot/find/click when configured. " +
      "Never shell out to open, explorer, or xdg-open. Dispatch does not prove the page loaded or passed validation.",
    input_schema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Explicit http:// or https:// URL to open in the real default browser",
        },
      },
      required: ["url"],
    },
    kind: "read",
    classify: () => ({ effect: "interactive", concurrencySafe: false, approvalKind: "computer" }),
    async run(input, ctx) {
      let parsed: URL;
      try {
        parsed = resolveBrowserUrl(input?.url);
      } catch (error) {
        return `Error: cannot open browser: ${error instanceof Error ? error.message : String(error)}.`;
      }

      const hostPlatform = platform();
      try {
        await launcher(parsed.href, { platform: hostPlatform, signal: ctx.signal });
      } catch (error) {
        if (ctx.signal?.aborted) throw error;
        return `Error: could not ask the system browser to open ${safeDisplayUrl(parsed)}: ${error instanceof Error ? error.message : String(error)}.`;
      }
      return (
        `Sent ${safeDisplayUrl(parsed)} to ${browserOpenInvocation(parsed.href, hostPlatform).browser}. ` +
        "This proves only that the OS accepted the navigation request; use computer screenshot/find/click to verify the rendered page."
      );
    },
  };
}

registerTool(createOpenBrowserTool());
