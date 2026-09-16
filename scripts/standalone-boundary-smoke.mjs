#!/usr/bin/env node
// Execute a native Hara standalone from a deliberately hostile working directory. Bun standalone binaries
// historically loaded cwd/.env and cwd/bunfig.toml by default; both happen before Hara can apply its own
// file, command, or approval boundaries. This smoke is intentionally runtime-based rather than a source grep.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  delete env.HARA_PROFILE;
  delete env.HARA_PROVIDER;
  delete env.HARA_API_KEY;
  delete env.ANTHROPIC_API_KEY;

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
    const details = doctor.error?.message
      ?? [doctor.stderr.trim(), doctor.stdout.trim()].filter(Boolean).join("\n");
    throw new Error(`doctor probe failed (status ${doctor.status}): ${details}`);
  }
  if (doctor.stdout.includes(dotenvMarker) || doctor.stderr.includes(dotenvMarker)) {
    throw new Error("cwd .env was loaded into the standalone process");
  }
  if (existsSync(marker) || doctor.stderr.includes("HARA_BUNFIG_PRELOAD_EXECUTED")) {
    throw new Error("cwd bunfig.toml preload executed during Hara startup");
  }

  // Exercise the exact self-reentry used by chat gateways and prompt-mode cron jobs. Bun exposes a synthetic
  // argv[1] for compiled programs (`/$bunfs/...` on POSIX and `B:/~BUN/...` on Windows); forwarding it makes
  // Commander reject the child before it reaches authentication with `too many arguments`.
  const added = run(["cron", "add", "in 1h", "standalone self invocation smoke", "--name", "self-reentry-probe"]);
  const jobId = /scheduled\s+([0-9a-f]{8})\b/iu.exec(added.stdout)?.[1];
  if (added.error || added.status !== 0 || !jobId) {
    const details = added.error?.message
      ?? [added.stderr.trim(), added.stdout.trim()].filter(Boolean).join("\n");
    throw new Error(`self-reentry setup failed (status ${added.status}): ${details}`);
  }
  const reentered = run(["cron", "run", jobId]);
  if (reentered.error || reentered.status !== 0) {
    const details = reentered.error?.message
      ?? [reentered.stderr.trim(), reentered.stdout.trim()].filter(Boolean).join("\n");
    throw new Error(`self-reentry probe failed (status ${reentered.status}): ${details}`);
  }
  const runLog = readFileSync(join(home, ".hara", "cron", "logs", `${jobId}.log`), "utf8");
  if (/too many arguments|(?:\$bunfs|~BUN)[\\/]/iu.test(runLog)) {
    throw new Error(`compiled self-reentry forwarded Bun's virtual entry: ${runLog.trim().slice(-1_000)}`);
  }
  if (!/Not authenticated for profile 'personal'/u.test(runLog)) {
    throw new Error(`compiled self-reentry did not reach the expected auth boundary: ${runLog.trim().slice(-1_000)}`);
  }

  console.log("✓ standalone ignores ambient project loaders and safely re-enters itself");
} catch (error) {
  console.error(`standalone boundary smoke: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
