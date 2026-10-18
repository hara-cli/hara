#!/usr/bin/env node
// Keep the runtime gate dependency-free and ahead of the main CLI import. Older Node releases must see an
// actionable upgrade message even if a future dependency starts using syntax or APIs they cannot load.
import { applyPortableHomeEnv, unsupportedNodeMessage } from "./runtime.js";

const runtimeError = unsupportedNodeMessage();
if (runtimeError) {
  process.stderr.write(`${runtimeError}\n`);
  process.exitCode = 1;
} else if (process.argv[2] === "--runtime-manifest") {
  void import("./runtime-distribution.js").then(({ runtimeDistribution }) => process.stdout.write(JSON.stringify(runtimeDistribution) + "\n"));
} else if (process.argv[2] === "workspace-dev" || process.argv[2] === "workspace") {
  // Route before portable/legacy profile startup. The explicit fixture root is the sole state owner.
  void import("./workspace/local-cli.js").then(module => module.mainLocalWorkspaceCli(process.argv.slice(3), process.argv[2] === "workspace" ? "workspace" : undefined)).catch(() => {
    process.stderr.write(`hara ${process.argv[2]}: startup/request failed; verify the explicit private Workspace root and options. No legacy fallback was started.\n`);
    process.exitCode = 1;
  });
} else {
  applyPortableHomeEnv();
  void import("./index.js").catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`hara: failed to start: ${message}\n`);
    process.exitCode = 1;
  });
}
