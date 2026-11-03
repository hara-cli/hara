import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runExternalCommandCapture, type ExternalCommandCaptureResult } from "../external-sessions/process.js";
import { createRuntimeExecutionPolicy, type RuntimeExecutionPolicy } from "./execution-policy.js";
import { assertExpandedRuntimeIsolation } from "./expanded-isolation.js";

export type ExpandedMetadataCapture = (input: { runtimeId: "copilot" | "cursor"; command: string;
  env: NodeJS.ProcessEnv; proxyUrl?: string | null; accountHome: string; runtimeHome: string; protectedStateRoots: readonly string[] }) => Promise<ExternalCommandCaptureResult>;
/** Metadata retains host login and inherited extensions. It uses the same v4 process ownership
 * barrier and drain as model execution, with an empty controlled cwd and Host-proved state roots. */
export const captureExpandedMetadata: ExpandedMetadataCapture = async input => {
  assertExpandedRuntimeIsolation(input.runtimeId);
  if (!input.env.HOME || input.env.HOME !== input.accountHome || !input.runtimeHome || !input.protectedStateRoots?.length) throw new Error("runtime_permission_denied");
  const cwd = mkdtempSync(join(realpathSync.native(tmpdir()), "hara-runtime-metadata-"));
  let policy: RuntimeExecutionPolicy | undefined;
  try {
    policy = createRuntimeExecutionPolicy({ runtimeId: input.runtimeId, tier: "controlled", accountHome: input.accountHome, runtimeHome: input.runtimeHome,
      workRoot: cwd, protectedStateRoots: input.protectedStateRoots, loginSource: "host", lifetime: "attempt" });
    const launch = policy.wrap({ command: input.command, args: input.runtimeId === "cursor" ? ["models"] : ["--help"], env: input.env });
    return await runExternalCommandCapture(launch, launch.args,
      { cwd, proxyUrl: input.proxyUrl, timeoutMs: 15000, maxOutputBytes: 1024 * 1024, waitForClose: true });
  } finally { await policy?.close(); rmSync(cwd, { recursive: true, force: true }); }
};
