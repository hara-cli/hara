// Explicit Host process adapter, not an OS security sandbox and never a default launcher.
import { spawn } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { terminateSubprocessTree } from "../security/subprocess-env.js";
import type { LegacyCommandInvocation, LegacyCommandExit } from "./legacy-command.js";

export function legacyProcessLauncher(options: { shell: "/bin/bash"; assertLaunch(invocation: LegacyCommandInvocation): void;
  terminationGraceMs?: number }): (invocation: LegacyCommandInvocation) => Promise<LegacyCommandExit> {
  const grace = options.terminationGraceMs ?? 300;
  if (process.platform === "win32" || options.shell !== "/bin/bash" || typeof options.assertLaunch !== "function"
    || !Number.isSafeInteger(grace) || grace < 10 || grace > 5000) throw new Error("Explicit POSIX process Host required");
  return invocation => new Promise((resolve, reject) => {
    try {
      if (invocation.signal.aborted) { resolve({ code: null, terminated: true }); return; }
      const grant: unknown = options.assertLaunch(invocation);
      if (grant !== undefined) {
        if (grant && typeof (grant as { then?: unknown }).then === "function") void Promise.resolve(grant).catch(() => {});
        throw new Error();
      }
      const directory = lstatSync(invocation.cwd);
      if (!isAbsolute(invocation.cwd) || realpathSync(invocation.cwd) !== invocation.cwd || !directory.isDirectory() || directory.isSymbolicLink()) throw new Error();
    } catch { reject(new Error("Host process grant/cwd unavailable; no process launched")); return; }
    const child = spawn(options.shell, ["--noprofile", "--norc", "-c", invocation.command], {
      cwd: invocation.cwd, env: { ...invocation.env }, detached: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let escalation: NodeJS.Timeout | undefined, settled = false;
    const stop = () => {
      terminateSubprocessTree(child, { processGroup: true });
      escalation ??= setTimeout(() => terminateSubprocessTree(child, { force: true, processGroup: true }), grace);
    };
    const finish = (code: number | null, terminated: boolean) => {
      if (settled) return; settled = true; if (escalation) clearTimeout(escalation);
      invocation.signal.removeEventListener("abort", stop); resolve({ code, terminated });
    };
    invocation.signal.addEventListener("abort", stop, { once: true }); if (invocation.signal.aborted) stop();
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => invocation.onOutput("stdout", chunk)); child.stderr.on("data", chunk => invocation.onOutput("stderr", chunk));
    child.once("error", () => finish(null, false));
    child.once("close", code => {
      // A closed leader is not proof its detached descendants stopped. Terminate only OUR group.
      terminateSubprocessTree(child, { force: true, processGroup: true });
      try { process.kill(-child.pid!, 0); finish(code, false); }
      catch (error: any) { finish(code, error.code === "ESRCH"); }
    });
  });
}
