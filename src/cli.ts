#!/usr/bin/env node
// Keep the runtime gate dependency-free and ahead of the main CLI import. Older Node releases must see an
// actionable upgrade message even if a future dependency starts using syntax or APIs they cannot load.
import { applyPortableHomeEnv, unsupportedNodeMessage } from "./runtime.js";

const runtimeError = unsupportedNodeMessage();
if (runtimeError) {
  process.stderr.write(`${runtimeError}\n`);
  process.exitCode = 1;
} else {
  applyPortableHomeEnv();
  void import("./index.js").catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`hara: failed to start: ${message}\n`);
    process.exitCode = 1;
  });
}
