import crossSpawn from "cross-spawn";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runExternalCommandCapture, type ExternalCommandCaptureResult } from "../external-sessions/process.js";
import { createRuntimeExecutionPolicy, type RuntimeExecutionPolicy } from "./execution-policy.js";
import { assertExpandedRuntimeIsolation } from "./expanded-isolation.js";

export type ExpandedMetadataCapture = (input: { runtimeId: "copilot" | "cursor"; command: string;
  env: NodeJS.ProcessEnv; proxyUrl?: string | null; protectedStateRoots: readonly string[] }) => Promise<ExternalCommandCaptureResult>;
/** Metadata queries are also native subprocesses. They do not get an unprotected back door around
 * the production extension gate. The optional Host constructor seam is for synthetic CLI tests. */
export const captureExpandedMetadata: ExpandedMetadataCapture = async input => {
  assertExpandedRuntimeIsolation(input.runtimeId);
  if (!input.env.HOME || !input.protectedStateRoots?.length) throw new Error("runtime_permission_denied");
  const cwd = mkdtempSync(join(realpathSync.native(tmpdir()), "hara-runtime-metadata-"));
  let child: ChildProcess | undefined, stopped = true;
  let policy: RuntimeExecutionPolicy | undefined;
  try {
    policy = createRuntimeExecutionPolicy({ runtimeId: input.runtimeId, tier: "controlled", accountHome: input.env.HOME,
      workRoot: cwd, protectedStateRoots: input.protectedStateRoots, loginSource: "host", lifetime: "attempt" });
    const launch = policy.wrap({ command: input.command, args: input.runtimeId === "cursor" ? ["models"] : ["--help"], env: input.env });
    stopped = false;
    try { return await runExternalCommandCapture({ command: launch.command, env: launch.env,
      spawnProcess(command, argv, options) { child = crossSpawn(command, [...argv], options); return child; } }, launch.args,
      { cwd, proxyUrl: input.proxyUrl, timeoutMs: 15000, maxOutputBytes: 1024 * 1024 });
    } finally {
      if (child?.pid && child.exitCode === null && child.signalCode === null) await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { child?.removeListener("close", ended); reject(new Error("runtime_failed")); }, 4000);
        const ended = () => { clearTimeout(timer); resolve(); }; child!.once("close", ended);
      });
      stopped = true;
    }
  } finally { if (stopped) { await policy?.close(); rmSync(cwd, { recursive: true, force: true }); } }
};
