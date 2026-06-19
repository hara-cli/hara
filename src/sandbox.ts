// OS sandboxing for the bash tool. macOS = Seatbelt (sandbox-exec); other platforms run unsandboxed
// (the approval gate + cwd-scoped file tools still apply). Only the `bash` shell is sandboxed —
// hara's own file tools (write_file/edit_file) are in-process, explicit, and gated.
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";

export type SandboxMode = "off" | "workspace-write" | "read-only";

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
export function runShell(command: string, cwd: string, mode: SandboxMode, opts: ShellOpts): Promise<{ stdout: string; stderr: string }> {
  let cmd: string;
  let args: string[];
  if (mode !== "off" && platform() === "darwin") {
    const dir = mkdtempSync(join(tmpdir(), "hara-sb-"));
    const profileFile = join(dir, "policy.sb");
    writeFileSync(profileFile, seatbeltProfile(cwd, mode));
    cmd = "sandbox-exec";
    args = ["-f", profileFile, "/bin/bash", "-lc", command];
  } else {
    cmd = "/bin/sh";
    args = ["-c", command];
  }

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const grow = (cur: string, add: string) => (cur.length < opts.maxBuffer ? cur + add : cur);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeout);

    child.stdout.on("data", (d: Buffer) => {
      const s = d.toString();
      stdout = grow(stdout, s);
      opts.onData?.(s);
    });
    child.stderr.on("data", (d: Buffer) => {
      const s = d.toString();
      stderr = grow(stderr, s);
      opts.onData?.(s);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(Object.assign(e, { stdout, stderr }));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(Object.assign(new Error(`timed out after ${opts.timeout}ms`), { stdout, stderr }));
      if (code !== 0) return reject(Object.assign(new Error(`exit code ${code}`), { stdout, stderr, code }));
      resolve({ stdout, stderr });
    });
  });
}
