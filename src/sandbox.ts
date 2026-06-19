// OS sandboxing for the bash tool. macOS = Seatbelt (sandbox-exec); other platforms run unsandboxed
// (the approval gate + cwd-scoped file tools still apply). Only the `bash` shell is sandboxed —
// hara's own file tools (write_file/edit_file) are in-process, explicit, and gated.
import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";

const pexec = promisify(exec);
const pexecFile = promisify(execFile);

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

/** Run a shell command, sandboxed when mode != off and the platform supports it. */
export function runShell(
  command: string,
  cwd: string,
  mode: SandboxMode,
  opts: { timeout: number; maxBuffer: number },
): Promise<{ stdout: string; stderr: string }> {
  if (mode !== "off" && platform() === "darwin") {
    const dir = mkdtempSync(join(tmpdir(), "hara-sb-"));
    const profileFile = join(dir, "policy.sb");
    writeFileSync(profileFile, seatbeltProfile(cwd, mode));
    return pexecFile("sandbox-exec", ["-f", profileFile, "/bin/bash", "-lc", command], {
      cwd,
      timeout: opts.timeout,
      maxBuffer: opts.maxBuffer,
    });
  }
  return pexec(command, { cwd, timeout: opts.timeout, maxBuffer: opts.maxBuffer });
}
