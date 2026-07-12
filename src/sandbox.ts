// OS sandboxing for the bash tool — WRITE CONFINEMENT, not a security jail. macOS = Seatbelt
// (sandbox-exec) restricting `file-write*` to the workspace (workspace-write) or to nothing outside
// temp (read-only). Reads, network, and process exec are NOT restricted, and /private/tmp +
// /private/var/folders stay writable in every mode — so this stops a stray `rm`/overwrite escaping the
// project, NOT a determined exfiltration. Other platforms run UNSANDBOXED (a one-time warning is
// emitted from runShell so every entry point — REPL, -p, org, cron — surfaces it). Only the `bash`
// shell is sandboxed; hara's own file tools are in-process, explicit, and gated by the approval flow.
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";

export type SandboxMode = "off" | "workspace-write" | "read-only";

// Windows shell resolution. hara (and the model) speak POSIX shell — the agent writes `ls`, `grep`,
// `cat`, pipes, `&&`. So on Windows we PREFER a real bash (Git Bash or WSL, which most Windows devs
// have) and only fall back to cmd.exe when none is found. Memoized: the PATH probe runs at most once.
let _winBash: string | null | undefined;
function findWindowsBash(): string | null {
  if (_winBash !== undefined) return _winBash;
  // `where bash` finds Git Bash / WSL bash on PATH; also probe the default Git-for-Windows location.
  // `timeout` is CRITICAL: this is a SYNCHRONOUS probe on the main thread — without it a slow `where`
  // (a huge PATH, a dead network drive on PATH) hangs hara at startup with nothing able to interrupt it.
  const onPath = spawnSync("where", ["bash"], { encoding: "utf8", timeout: 3000 });
  const hit = onPath.status === 0 ? String(onPath.stdout).split(/\r?\n/).find((l) => l.trim()) : "";
  _winBash = (hit && hit.trim()) || null;
  return _winBash;
}

/** Pure shell-argv resolution — split out so the platform branching is unit-testable without spawning.
 *  `plat` and `bash` are injected; production passes the real platform() + findWindowsBash(). */
export function resolveShellArgv(command: string, plat: string, bash: string | null): { cmd: string; args: string[] } {
  if (plat === "win32") {
    // A real bash keeps POSIX commands working; cmd.exe is the last resort (most `ls/grep` will fail
    // there — the model should be told, see maybeWarnWindowsShell).
    return bash ? { cmd: bash, args: ["-c", command] } : { cmd: "cmd.exe", args: ["/d", "/s", "/c", command] };
  }
  return { cmd: "/bin/sh", args: ["-c", command] };
}

const sbQuote = (s: string) => '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';

function seatbeltProfile(cwd: string, mode: SandboxMode): string {
  const writable = [
    '(literal "/dev/null")',
    '(literal "/dev/stdout")',
    '(literal "/dev/stderr")',
    '(literal "/dev/dtracehelper")',
    '(literal "/dev/tty")',
    '(subpath "/private/tmp")',
    '(subpath "/private/var/folders")',
  ];
  if (mode === "workspace-write") writable.push(`(subpath ${sbQuote(cwd)})`);
  return `(version 1)\n(allow default)\n(deny file-write*)\n(allow file-write*\n  ${writable.join("\n  ")})\n`;
}

export function sandboxSupported(): boolean {
  return platform() === "darwin";
}

let warnedUnsandboxed = false; // emit the "macOS-only" notice at most once per process

export interface ShellOpts {
  timeout: number;
  maxBuffer: number;
  /** stream stdout/stderr chunks live as they arrive (in addition to the buffered return) */
  onData?: (chunk: string) => void;
}

/**
 * Run a shell command, sandboxed when mode != off and the platform supports it.
 * Streams output via `opts.onData` while capturing it for the resolved value.
 * Resolves on exit 0; rejects (with `.stdout`/`.stderr`/`.code`) on nonzero exit or timeout.
 */
/** Build the (sandboxed, when supported) argv for a shell command — shared by runShell + background jobs
 *  so the seatbelt write-confinement is identical for both. */
export function shellCommand(command: string, cwd: string, mode: SandboxMode): { cmd: string; args: string[] } {
  if (mode !== "off" && platform() === "darwin") {
    const dir = mkdtempSync(join(tmpdir(), "hara-sb-"));
    const profileFile = join(dir, "policy.sb");
    writeFileSync(profileFile, seatbeltProfile(cwd, mode));
    return { cmd: "sandbox-exec", args: ["-f", profileFile, "/bin/bash", "-lc", command] };
  }
  maybeWarnUnsandboxed(mode);
  const plat = platform();
  if (plat === "win32") maybeWarnWindowsShell();
  return resolveShellArgv(command, plat, plat === "win32" ? findWindowsBash() : null);
}

/** One-time notice on Windows when no bash is found — the POSIX commands the model writes won't run
 *  under cmd.exe. Points the user at the fix (install Git for Windows or run under WSL). */
let warnedWinShell = false;
function maybeWarnWindowsShell(): void {
  if (warnedWinShell || findWindowsBash()) return;
  warnedWinShell = true;
  process.stderr.write(
    "hara: no bash found on PATH — shell commands run under cmd.exe, where most Unix commands (ls, grep, cat) fail.\n" +
      "      Install Git for Windows (bundles bash) or run hara inside WSL for full command support.\n",
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
  const { cmd, args } = shellCommand(command, cwd, mode);

  return new Promise((resolve, reject) => {
    // Non-interactive by contract: there is no terminal to answer a credential prompt, so a git
    // https op against a private repo would otherwise sit silently until the timeout (observed as
    // "git hangs 5 minutes"). With prompts disabled it fails in seconds with a real auth error.
    // Users' credential helpers (keychain/GCM store) still work — only interactive PROMPTS are off.
    const env = {
      ...process.env,
      GIT_TERMINAL_PROMPT: process.env.GIT_TERMINAL_PROMPT ?? "0",
      GCM_INTERACTIVE: process.env.GCM_INTERACTIVE ?? "never",
    };
    const child = spawn(cmd, args, { cwd, env });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killedForSize = false;
    const grow = (cur: string, add: string) => (cur.length < opts.maxBuffer ? cur + add : cur);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeout);
    // Kill a runaway command once its total output passes maxBuffer — don't let it stream GBs to the UI
    // until the timeout just because we stopped retaining the bytes.
    const checkOverflow = (): void => {
      if (!killedForSize && stdout.length + stderr.length >= opts.maxBuffer) {
        killedForSize = true;
        child.kill("SIGKILL");
      }
    };

    child.stdout.on("data", (d: Buffer) => {
      const s = d.toString();
      stdout = grow(stdout, s);
      opts.onData?.(s);
      checkOverflow();
    });
    child.stderr.on("data", (d: Buffer) => {
      const s = d.toString();
      stderr = grow(stderr, s);
      opts.onData?.(s);
      checkOverflow();
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(Object.assign(e, { stdout, stderr }));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (killedForSize) return resolve({ stdout, stderr: stderr + `\n[output truncated — exceeded ${opts.maxBuffer} bytes; process killed]` });
      if (timedOut) return reject(Object.assign(new Error(`timed out after ${opts.timeout}ms`), { stdout, stderr }));
      if (code !== 0) return reject(Object.assign(new Error(`exit code ${code}`), { stdout, stderr, code }));
      resolve({ stdout, stderr });
    });
  });
}
