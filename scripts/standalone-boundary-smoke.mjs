#!/usr/bin/env node
// Execute a native Hara standalone from a deliberately hostile working directory. Bun standalone binaries
// historically loaded cwd/.env and cwd/bunfig.toml by default; both happen before Hara can apply its own
// file, command, or approval boundaries. This smoke is intentionally runtime-based rather than a source grep.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const [binaryArg, expectedVersion] = process.argv.slice(2);
if (!binaryArg || !expectedVersion) {
  console.error("usage: node scripts/standalone-boundary-smoke.mjs <native-binary> <expected-version>");
  process.exit(2);
}

const binary = isAbsolute(binaryArg) ? binaryArg : resolve(binaryArg);
if (!existsSync(binary)) {
  console.error(`standalone boundary smoke: binary not found: ${binary}`);
  process.exit(2);
}
chmodSync(binary, 0o755);

const root = mkdtempSync(join(tmpdir(), "hara-standalone-boundary-"));
const home = join(root, "home");
const marker = join(root, "PRELOAD_EXECUTED");
const dotenvMarker = "HARA_DOTENV_MUST_NOT_LOAD";
mkdirSync(home, { recursive: true });

try {
  writeFileSync(join(root, ".env"), `HARA_MODEL=${dotenvMarker}\n`, { mode: 0o600 });
  writeFileSync(join(root, "bunfig.toml"), 'preload = ["./preload.ts"]\n', { mode: 0o600 });
  writeFileSync(
    join(root, "preload.ts"),
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "ran\\n");\nconsole.error("HARA_BUNFIG_PRELOAD_EXECUTED");\n`,
    { mode: 0o600 },
  );

  const env = { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: "1", HARA_UPDATE_CHECK: "0" };
  delete env.HARA_MODEL;
  delete env.BUN_CONFIG;

  const run = (args) => spawnSync(binary, args, {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
  });

  const version = run(["--version"]);
  if (version.error || version.status !== 0 || version.stdout.trim() !== expectedVersion) {
    throw new Error(`version probe failed (status ${version.status}): ${version.error?.message ?? version.stderr.trim()}`);
  }
  if (existsSync(marker) || version.stderr.includes("HARA_BUNFIG_PRELOAD_EXECUTED")) {
    throw new Error("cwd bunfig.toml preload executed before Hara startup");
  }

  const doctor = run(["doctor"]);
  if (doctor.error || doctor.status !== 0) {
    throw new Error(`doctor probe failed (status ${doctor.status}): ${doctor.error?.message ?? doctor.stderr.trim()}`);
  }
  if (doctor.stdout.includes(dotenvMarker) || doctor.stderr.includes(dotenvMarker)) {
    throw new Error("cwd .env was loaded into the standalone process");
  }
  if (existsSync(marker) || doctor.stderr.includes("HARA_BUNFIG_PRELOAD_EXECUTED")) {
    throw new Error("cwd bunfig.toml preload executed during Hara startup");
  }

  console.log("✓ standalone ignores cwd .env and bunfig.toml preload");
} catch (error) {
  console.error(`standalone boundary smoke: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
