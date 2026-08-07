import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { isAbsolute, resolve, win32 } from "node:path";
import { toolSubprocessEnv } from "../security/subprocess-env.js";
import { registerTool, type Tool } from "./registry.js";

const MAX_DIRECTORY_PATH_BYTES = 32 * 1024;
const LAUNCH_TIMEOUT_MS = 5_000;

export interface DirectoryOpenInvocation {
  command: string;
  args: string[];
  fileManager: string;
}

export interface DirectoryLaunchOptions {
  platform?: NodeJS.Platform;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  spawnProcess?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
}

export type DirectoryLauncher = (
  directory: string,
  options?: DirectoryLaunchOptions,
) => Promise<void>;

function cancellationError(): Error {
  const error = new Error("directory opening was cancelled before the system file manager accepted it");
  error.name = "AbortError";
  return error;
}

/** Resolve only an existing directory. Files, URLs, applications, and model-authored shell text never
 * reach the platform launcher, so this narrow user-visible action cannot become a generic exec escape. */
export function resolveDirectoryToOpen(
  value: unknown,
  cwd: string,
  userHome = homedir(),
): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("`path` must be a non-empty directory path");
  }
  const raw = value.trim();
  if (raw.includes("\0")) throw new Error("`path` contains a null byte");
  if (Buffer.byteLength(raw, "utf8") > MAX_DIRECTORY_PATH_BYTES) {
    throw new Error(`\`path\` exceeds ${MAX_DIRECTORY_PATH_BYTES} bytes`);
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(raw)) {
    throw new Error("URLs are not supported; give an existing local directory path");
  }

  const expanded = raw === "~"
    ? userHome
    : /^~[\\/]/u.test(raw)
      ? resolve(userHome, raw.slice(2))
      : raw;
  const candidate = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);

  let canonical: string;
  try {
    canonical = realpathSync.native(candidate);
  } catch {
    throw new Error(`directory does not exist or cannot be accessed: ${candidate}`);
  }
  try {
    if (!statSync(canonical).isDirectory()) {
      throw new Error(`path is not a directory: ${canonical}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("path is not a directory:")) throw error;
    throw new Error(`directory does not exist or cannot be accessed: ${canonical}`);
  }
  return canonical;
}

/** Fixed executable + argv selection. The directory is never interpolated into a shell command. */
export function directoryOpenInvocation(
  directory: string,
  hostPlatform: NodeJS.Platform = platform(),
  env: NodeJS.ProcessEnv = process.env,
): DirectoryOpenInvocation {
  if (hostPlatform === "darwin") {
    return { command: "/usr/bin/open", args: [directory], fileManager: "Finder" };
  }
  if (hostPlatform === "linux") {
    return { command: "/usr/bin/xdg-open", args: [directory], fileManager: "the system file manager" };
  }
  if (hostPlatform === "win32") {
    const configuredRoot = String(env.SystemRoot ?? env.WINDIR ?? "").trim();
    const systemRoot = configuredRoot && win32.isAbsolute(configuredRoot) && !configuredRoot.includes("\0")
      ? configuredRoot
      : "C:\\Windows";
    return {
      command: win32.join(systemRoot, "explorer.exe"),
      args: [directory],
      fileManager: "File Explorer",
    };
  }
  throw new Error(`opening directories is not supported on platform ${hostPlatform}`);
}

/** Dispatch a bounded, secret-scrubbed, shell-free request to the host file manager. Resolving on the
 * child's spawn event means Hara does not wait on a GUI process, while missing launchers still fail clearly. */
export async function launchDirectory(
  directory: string,
  options: DirectoryLaunchOptions = {},
): Promise<void> {
  const hostPlatform = options.platform ?? platform();
  const invocation = directoryOpenInvocation(directory, hostPlatform, options.env ?? process.env);
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
      settle(new Error(`system file manager did not accept the request within ${LAUNCH_TIMEOUT_MS}ms`));
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
      settle(error instanceof Error ? error : new Error("failed to start the system file manager"));
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

export function createOpenDirectoryTool(launcher: DirectoryLauncher = launchDirectory): Tool {
  return {
    name: "open_directory",
    description:
      "Show an existing local folder in the user's system file manager (Finder, File Explorer, or the Linux file manager). " +
      "Use this directly when the user asks to open/show/reveal a directory; never run bash `open`, `explorer`, or `xdg-open`. " +
      "This accepts directories only (not files, URLs, or applications), does not read their contents, and uses no shell.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Existing absolute directory path, or a path relative to the working directory; ~/ is supported",
        },
      },
      required: ["path"],
    },
    kind: "read",
    classify: () => ({ effect: "interactive", concurrencySafe: false }),
    async run(input, ctx) {
      let directory: string;
      try {
        directory = resolveDirectoryToOpen(input?.path, ctx.cwd);
      } catch (error) {
        return `Error: cannot open directory: ${error instanceof Error ? error.message : String(error)}.`;
      }

      const hostPlatform = platform();
      try {
        await launcher(directory, { platform: hostPlatform, signal: ctx.signal });
      } catch (error) {
        if (ctx.signal?.aborted) throw error;
        return `Error: could not ask the system file manager to open ${directory}: ${error instanceof Error ? error.message : String(error)}.`;
      }
      const { fileManager } = directoryOpenInvocation(directory, hostPlatform);
      return `Sent the directory to ${fileManager}: ${directory}`;
    },
  };
}

registerTool(createOpenDirectoryTool());
