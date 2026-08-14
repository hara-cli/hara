import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HARA_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/u;

export function isValidHaraVersion(value: unknown): value is string {
  return typeof value === "string" && HARA_VERSION.test(value);
}

/** One runtime provenance value shared by CLI, Serve, cron pre-registration, and compiled binaries. */
export function resolveHaraRuntimeVersion(): string {
  const built = process.env.HARA_BUILD_VERSION;
  if (isValidHaraVersion(built)) return built;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const parsed = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version?: unknown };
    return isValidHaraVersion(parsed.version) ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const HARA_RUNTIME_VERSION = resolveHaraRuntimeVersion();
