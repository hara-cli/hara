// OS sandboxing for the bash tool. macOS Seatbelt provides write confinement plus a narrow protected-file
// read mask. Other reads, network, and process exec are not generally confined; non-macOS shells have only
// Hara's command preflight and must not be described as a kernel-enforced read sandbox.
// (sandbox-exec) restricting `file-write*` to the workspace (workspace-write) or to nothing outside
// temp (read-only). Reads, network, and process exec are NOT restricted, and /private/tmp +
// /private/var/folders stay writable in every mode — so this stops a stray `rm`/overwrite escaping the
// project, NOT a determined exfiltration. Other platforms run UNSANDBOXED (a one-time warning is
// emitted from runShell so every entry point — REPL, -p, org, cron — surfaces it). Only the `bash`
// shell is sandboxed; hara's own file tools are in-process, explicit, and gated by the approval flow.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { platform } from "node:os";
import { win32 as winPath } from "node:path";
import {
  existingSensitiveSeatbeltMasks,
  sensitiveFilesAllowed,
  sensitiveShellCommandReason,
} from "./security/sensitive-files.js";
import {
  terminateSubprocessTree,
  toolSubprocessEnv,
  windowsCommandProcessor,
  windowsSystemExecutable,
} from "./security/subprocess-env.js";
import { homeWorkspaceActionError, isUnsafeProjectWorkspace } from "./context/workspace-scope.js";

export type SandboxMode = "off" | "workspace-write" | "read-only";

// Windows shell resolution. hara (and the model) speak POSIX shell — the agent writes `ls`, `grep`,
// `cat`, pipes, `&&`. So on Windows we PREFER a real bash (Git Bash or WSL, which most Windows devs
// have) and only fall back to cmd.exe when none is found. Discovery is memoized only after a candidate has
// proved it can execute a minimal POSIX command; a broken WSL app alias must not become a process-lifetime
// single point of failure.
let _winBash: string | null | undefined;
/** Conventional Git-for-Windows installations are not always added to PATH (the installer makes that
 *  an explicit choice). Keep candidate construction pure so non-Windows CI can cover it. */
export function windowsBashCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const roots = [
    env.ProgramFiles,
    env["ProgramFiles(x86)"],
    env.LocalAppData ? winPath.join(env.LocalAppData, "Programs") : undefined,
    "C:\\Program Files",
    "C:\\Program Files (x86)",
  ].filter((value): value is string => !!value?.trim());
  return [...new Set(roots.map((root) => winPath.join(root, "Git", "bin", "bash.exe")))];
}

export function firstInstalledWindowsBash(
  candidates: readonly string[],
  isFile: (path: string) => boolean,
): string | null {
  return candidates.find((path) => {
    try { return isFile(path); } catch { return false; }
  }) ?? null;
}

export function firstHealthyWindowsBash(
  candidates: readonly string[],
  probe: (path: string) => boolean,
): string | null {
  for (const path of candidates) {
    try {
      if (probe(path)) return path;
    } catch {
      /* a failed candidate must not prevent checking Git Bash or another healthy entry */
    }
  }
  return null;
}

function windowsBashWorks(path: string): boolean {
  const check = spawnSync(path, ["-c", "exit 0"], {
    encoding: "utf8",
    timeout: 3000,
    windowsHide: true,
    env: toolSubprocessEnv(),
  });
  return check.status === 0 && !check.error;
}

function findWindowsBash(refresh = false): string | null {
  if (refresh) _winBash = undefined;
  if (_winBash !== undefined) return _winBash;
  // Prefer a conventional Git Bash before PATH aliases. A healthy WSL bash is still a fallback, but Git
  // Bash shares Windows path semantics with the cwd and avoids needless D:\\... ↔ /mnt/d/... crossings.
  // `timeout` is CRITICAL: this is a SYNCHRONOUS probe on the main thread — without it a slow `where`
  // (a huge PATH, a dead network drive on PATH) hangs hara at startup with nothing able to interrupt it.
  const onPath = spawnSync(windowsSystemExecutable("where.exe"), ["bash"], {
    encoding: "utf8",
    timeout: 3000,
    windowsHide: true,
    env: toolSubprocessEnv(),
  });
  const onPathCandidates = onPath.status === 0
    ? String(onPath.stdout).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    : [];
  const conventional = windowsBashCandidates().filter((path) => {
    try { return existsSync(path) && statSync(path).isFile(); } catch { return false; }
  });
  const candidates = [...new Set([...conventional, ...onPathCandidates])];
  _winBash = firstHealthyWindowsBash(candidates, windowsBashWorks);
  return _winBash;
}

/** A cached Windows bash can disappear or become unhealthy after startup (for example WSL is shut down).
 * Re-probe once for a different healthy candidate; callers decide whether replaying their command is safe. */
function refreshWindowsBashAfterFailure(failed: string): string | null {
  if (_winBash !== failed) return _winBash ?? null;
  return findWindowsBash(true);
}

/** Pure shell-argv resolution — split out so the platform branching is unit-testable without spawning.
 *  `plat` and `bash` are injected; production passes the real platform() + findWindowsBash(). */
export function resolveShellArgv(
  command: string,
  plat: string,
  bash: string | null,
  env: NodeJS.ProcessEnv = process.env,
): { cmd: string; args: string[] } {
  if (plat === "win32") {
    // A real bash keeps POSIX commands working; cmd.exe is the last resort (most `ls/grep` will fail
    // there — the model should be told, see maybeWarnWindowsShell).
    return bash
      ? { cmd: bash, args: ["-c", command] }
      : { cmd: windowsCommandProcessor(env), args: ["/d", "/s", "/c", command] };
  }
  return { cmd: "/bin/sh", args: ["-c", command] };
}

function isGitForWindowsBash(bash: string): boolean {
  return /(?:^|[\\/])Git[\\/](?:bin|usr[\\/]bin)[\\/]bash\.exe$/iu.test(bash);
}

/** Reject a Windows path before WSL interprets it as a relative POSIX path such as
 * `/mnt/d/project/D:/Work/project`. Rewriting arbitrary shell text would be unsafe, so the diagnostic
 * tells the model to choose one dialect explicitly instead. Exported as a pure helper for Windows CI. */
export function windowsShellPathPreflight(command: string, bash: string | null): string | undefined {
  const mixedToken = /\/mnt\/([a-z])\/[^\s"'|;&]*[a-z]:[\\/]/iu.exec(command);
  if (mixedToken) {
    return (
      "shell command contains one path that mixes WSL (/mnt/<drive>/...) and Windows (<drive>:/...) syntax. " +
      "Use one absolute path dialect; do not append a Windows absolute path to the current WSL directory."
    );
  }
  if (!bash || isGitForWindowsBash(bash)) return undefined;
  if (/\bwslpath\b/iu.test(command)) return undefined;
  if (/^\s*(?:powershell|pwsh|cmd|node|python|py)\.exe\b/iu.test(command)) return undefined;
  const windowsAbsolute = /(?:^|[\s"'=(])([a-z]):[\\/]/iu.exec(command);
  if (!windowsAbsolute) return undefined;
  const drive = windowsAbsolute[1].toLowerCase();
  return (
    `shell command passes a Windows absolute path to WSL Bash. Convert it explicitly to /mnt/${drive}/... ` +
    "with wslpath, use a Windows-native executable, or install/select Git Bash; Hara will not guess by concatenating path dialects."
  );
}

const MAX_INLINE_SEATBELT_PROFILE_BYTES = 96 * 1024;
const sbQuote = (s: string): string => {
  if (/[\u0000-\u001f\u007f]/u.test(s)) {
    throw new Error("cannot safely encode a protected path containing control characters in a Seatbelt profile");
  }
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
};

function seatbeltProfile(cwd: string, mode: SandboxMode): string {
  const rules = ["(version 1)", "(allow default)"];
  const writable = [
    '(literal "/dev/null")',
    '(literal "/dev/stdout")',
    '(literal "/dev/stderr")',
    '(literal "/dev/dtracehelper")',
    '(literal "/dev/tty")',
    '(subpath "/private/tmp")',
    '(subpath "/private/var/folders")',
  ];
  if (mode !== "off") {
    if (mode === "workspace-write") writable.push(`(subpath ${sbQuote(cwd)})`);
    rules.push(`(deny file-write*)\n(allow file-write*\n  ${writable.join("\n  ")})`);
  }
  const masks = existingSensitiveSeatbeltMasks(cwd);
  const unreadable = masks.files;
  if (unreadable.length) {
    const literals = unreadable.map((path) => `(literal ${sbQuote(path)})`).join("\n  ");
    rules.push(`(deny file-read*\n  ${literals})`);
    // Protect metadata mutations too: unlink/rename/link/chmod all sit under file-write* in Seatbelt.
    // This remains active in sandbox=off; the opt-out is the explicit launch-time secret-file waiver.
    rules.push(`(deny file-write*\n  ${literals})`);
  }
  const unreadableDirs = masks.directories;
  if (unreadableDirs.length) {
    // `subpath` masks descendants; the paired `literal` masks rename/unlink of the directory entry itself.
    const subpaths = unreadableDirs
      .flatMap((path) => [`(literal ${sbQuote(path)})`, `(subpath ${sbQuote(path)})`])
      .join("\n  ");
    rules.push(`(deny file-read*\n  ${subpaths})`);
    rules.push(`(deny file-write*\n  ${subpaths})`);
  }
  const writeContainers = masks.writeContainers;
  if (writeContainers.length) {
    rules.push(`(deny file-write*\n  ${writeContainers.map((path) => `(literal ${sbQuote(path)})`).join("\n  ")})`);
  }
  const profile = rules.join("\n") + "\n";
  if (Buffer.byteLength(profile) > MAX_INLINE_SEATBELT_PROFILE_BYTES) {
    throw new Error(
      `protected-file Seatbelt profile exceeds ${MAX_INLINE_SEATBELT_PROFILE_BYTES} bytes; refusing an incomplete or unlaunchable mask`,
    );
  }
  return profile;
}

export function sandboxSupported(): boolean {
  return platform() === "darwin";
}

let warnedUnsandboxed = false; // emit the "macOS-only" notice at most once per process

export interface ShellOpts {
  timeout: number;
  maxBuffer: number;
  /** Parent agent-run cancellation. Aborting kills the owned process tree just like a timeout. */
  signal?: AbortSignal;
  /** stream stdout/stderr chunks live as they arrive (in addition to the buffered return) */
  onData?: (chunk: string, stream: "stdout" | "stderr") => void;
  /** Optional stdin payload for non-interactive helpers such as lifecycle hooks. */
  input?: string | Buffer;
  /** Deliberate, narrowly-scoped environment additions applied after inherited-secret scrubbing. */
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}

interface ShellLaunch {
  cmd: string;
  args: string[];
  windowsBash?: string;
}

function shellLaunch(command: string, cwd: string, mode: SandboxMode): ShellLaunch {
  const argv = shellCommand(command, cwd, mode);
  return {
    ...argv,
    ...(platform() === "win32" && /(?:^|[\\/])bash\.exe$/i.test(argv.cmd)
      ? { windowsBash: argv.cmd }
      : {}),
  };
}

function windowsBashLaunchFailure(error: NodeJS.ErrnoException): boolean {
  return ["ENOENT", "EACCES", "ENOEXEC", "UNKNOWN"].includes(String(error.code ?? ""));
}

/**
 * Run a shell command, sandboxed when mode != off and the platform supports it.
 * Streams output via `opts.onData` while capturing it for the resolved value.
 * Resolves on exit 0; rejects (with `.stdout`/`.stderr`/`.code`) on nonzero exit or timeout.
 */
/** Build the (sandboxed, when supported) argv for a shell command — shared by runShell + background jobs
 *  so the seatbelt write-confinement is identical for both. */
export function shellCommand(command: string, cwd: string, mode: SandboxMode): { cmd: string; args: string[] } {
  // Shell syntax can recursively traverse arbitrary paths, so unlike explicit read/write tools it is not
  // safe at the Home root. Check before protected-file mask discovery, which itself would have to walk ~/.
  if (isUnsafeProjectWorkspace(cwd)) throw new Error(homeWorkspaceActionError("run shell commands"));
  const protectedReason = sensitiveShellCommandReason(command, cwd);
  if (protectedReason) {
    throw new Error(
      `shell command crosses Hara's protected secret boundary (${protectedReason}). ` +
      "Restart hara with HARA_ALLOW_SENSITIVE_FILES=1 only for an intentional, user-approved exposure.",
    );
  }
  // sandbox=off still retains the narrow secret-file read mask on macOS. It places no restriction on
  // ordinary reads/writes/network and is removed only by the explicit launch-time sensitive-file opt-in.
  if ((mode !== "off" || !sensitiveFilesAllowed()) && platform() === "darwin") {
    // Non-login shell: inheriting the already-scrubbed PATH is sufficient, while -l would source the
    // user's profile again and silently re-introduce credentials we deliberately removed from env.
    return { cmd: "sandbox-exec", args: ["-p", seatbeltProfile(cwd, mode), "/bin/bash", "-c", command] };
  }
  maybeWarnUnsandboxed(mode);
  const plat = platform();
  if (plat === "win32") maybeWarnWindowsShell();
  const bash = plat === "win32" ? findWindowsBash() : null;
  if (plat === "win32") {
    const pathReason = windowsShellPathPreflight(command, bash);
    if (pathReason) throw new Error(pathReason);
  }
  return resolveShellArgv(command, plat, bash);
}

/** One-time notice on Windows when no bash is found — the POSIX commands the model writes won't run
 *  under cmd.exe. Points the user at the fix (install Git for Windows or run under WSL). */
let warnedWinShell = false;
function maybeWarnWindowsShell(): void {
  if (warnedWinShell || findWindowsBash()) return;
  warnedWinShell = true;
  process.stderr.write(
    "hara: no healthy bash found — shell commands run under native cmd.exe; Unix commands (ls, grep, cat) may fail.\n" +
      "      Windows-native commands (PowerShell, cmd, py, node) remain available; repair Git Bash/WSL for POSIX commands.\n",
  );
}

/** One-time-per-process notice that --sandbox is a no-op off macOS (covers every entry point). */
export function maybeWarnUnsandboxed(mode: SandboxMode): void {
  if (mode !== "off" && !warnedUnsandboxed) {
    warnedUnsandboxed = true;
    process.stderr.write(`hara: --sandbox ${mode} is macOS-only — the shell runs UNSANDBOXED on ${platform()}.\n`);
  }
}

export function runShell(command: string, cwd: string, mode: SandboxMode, opts: ShellOpts): Promise<{ stdout: string; stderr: string }> {
  if (opts.signal?.aborted) return Promise.reject(new Error("interrupted before command start"));
  const execute = (launch: ShellLaunch, canRetryWindowsBash: boolean): Promise<{ stdout: string; stderr: string }> => new Promise((resolve, reject) => {
    const { cmd, args } = launch;
    // Non-interactive by contract: there is no terminal to answer a credential prompt, so a git
    // https op against a private repo would otherwise sit silently until the timeout (observed as
    // "git hangs 5 minutes"). With prompts disabled it fails in seconds with a real auth error.
    // Users' credential helpers (keychain/GCM store) still work — only interactive PROMPTS are off.
    const env = toolSubprocessEnv(process.env, {
      GIT_TERMINAL_PROMPT: process.env.GIT_TERMINAL_PROMPT ?? "0",
      GCM_INTERACTIVE: process.env.GCM_INTERACTIVE ?? "never",
      ...(opts.env ?? {}),
    });
    // A dedicated POSIX process group lets timeout/output-cap termination reach grandchildren (shell →
    // node/npm → worker). Windows uses taskkill /T in terminateSubprocessTree instead.
    const processGroup = platform() !== "win32";
    const child = spawn(cmd, args, { cwd, env, detached: processGroup });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let killedForSize = false;
    let done = false;
    let receivedBytes = 0;
    let forceIssued = false;
    let closeBeforeForce = false;
    let closeBeforeForceCode: number | null = null;
    let cancelTermination: ((cancelForce?: boolean) => void) | undefined;
    const grow = (cur: string, add: string) => {
      const remaining = opts.maxBuffer - stdout.length - stderr.length;
      if (remaining <= 0) return cur;
      return cur + add.slice(0, remaining);
    };
    const hardSettle = (): void => {
      // A daemon can intentionally create a new process group while retaining our pipes. We cannot signal
      // that unknown group safely, but we can destroy our pipe ends and guarantee the API settles on time.
      child.stdout.destroy();
      child.stderr.destroy();
      settle(null);
    };
    const stopTree = (): void => {
      if (cancelTermination) return;
      cancelTermination = terminateSubprocessTree(child, {
        processGroup,
        graceMs: 250,
        fallbackMs: 1_000,
        onFallback: hardSettle,
        onForce: () => {
          forceIssued = true;
          // A quiet descendant can let the direct shell close after TERM while remaining alive itself.
          // Do not claim the timed-out/capped tree is gone until the forced group kill has been issued.
          if (closeBeforeForce) settle(closeBeforeForceCode);
        },
      });
    };
    const settle = (code: number | null, error?: Error): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", abortRun);
      cancelTermination?.();
      if (error) {
        reject(Object.assign(error, { stdout, stderr }));
        return;
      }
      if (killedForSize) {
        resolve({ stdout, stderr: stderr + `\n[output truncated — exceeded ${opts.maxBuffer} bytes; process tree killed]` });
      } else if (timedOut) {
        reject(Object.assign(new Error(`timed out after ${opts.timeout}ms`), { stdout, stderr }));
      } else if (aborted) {
        reject(Object.assign(new Error("interrupted by agent run deadline or cancellation"), { stdout, stderr }));
      } else if (code !== 0) {
        reject(Object.assign(new Error(`exit code ${code}`), { stdout, stderr, code }));
      } else {
        resolve({ stdout, stderr });
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stopTree();
    }, opts.timeout);
    const abortRun = (): void => {
      if (done || timedOut || killedForSize || aborted) return;
      aborted = true;
      stopTree();
    };
    opts.signal?.addEventListener("abort", abortRun, { once: true });
    if (opts.signal?.aborted) abortRun();
    // A hook may exit successfully without reading stdin. Swallow the resulting benign EPIPE and let the
    // child's authoritative close status settle the operation, matching spawnSync's historical behavior.
    child.stdin.on("error", () => {});
    child.stdin.end(opts.input);
    // Kill a runaway command once its total output passes maxBuffer — don't let it stream GBs to the UI
    // until the timeout just because we stopped retaining the bytes.
    const checkOverflow = (): void => {
      if (!killedForSize && receivedBytes > opts.maxBuffer) {
        killedForSize = true;
        stopTree();
      }
    };

    child.stdout.on("data", (d: Buffer) => {
      if (done || timedOut || killedForSize || aborted) return;
      const s = d.toString();
      receivedBytes += d.length;
      stdout = grow(stdout, s);
      if (receivedBytes <= opts.maxBuffer) opts.onData?.(s, "stdout");
      checkOverflow();
    });
    child.stderr.on("data", (d: Buffer) => {
      if (done || timedOut || killedForSize || aborted) return;
      const s = d.toString();
      receivedBytes += d.length;
      stderr = grow(stderr, s);
      if (receivedBytes <= opts.maxBuffer) opts.onData?.(s, "stderr");
      checkOverflow();
    });
    child.on("error", (e: NodeJS.ErrnoException) => {
      if (canRetryWindowsBash && launch.windowsBash && windowsBashLaunchFailure(e)) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", abortRun);
        cancelTermination?.();
        const replacement = refreshWindowsBashAfterFailure(launch.windowsBash);
        if (replacement && replacement !== launch.windowsBash) {
          execute(
            { cmd: replacement, args: ["-c", command], windowsBash: replacement },
            false,
          ).then(resolve, reject);
          return;
        }
        // `error` means the shell process never started, so the command has not run and a single native
        // retry is safe. Do not do this for a non-zero shell exit: that command may already have effects.
        execute(resolveShellArgv(command, "win32", null), false).then(resolve, reject);
        return;
      }
      settle(null, e);
    });
    child.on("close", (code) => {
      if ((timedOut || killedForSize || aborted) && !forceIssued) {
        closeBeforeForce = true;
        closeBeforeForceCode = code;
        return;
      }
      settle(code);
    });
  });
  return execute(shellLaunch(command, cwd, mode), true);
}
