#!/usr/bin/env node
// Verify the actual embedded native executable without credentials, a model request or npm install.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { CODE_RUNTIME_VERSION } from "./bundled-opencode.mjs";

const [binaryArg, expectedVersion] = process.argv.slice(2);
if (!binaryArg || !expectedVersion) {
  console.error("usage: node scripts/standalone-coding-runtime-smoke.mjs <native-binary> <expected-version>");
  process.exit(2);
}
const binary = resolve(binaryArg);
const root = mkdtempSync(join(tmpdir(), "hara-standalone-coding-"));
const home = join(root, "home");
mkdirSync(home);
// Do not inherit real API keys, configuration overrides, Bun preloads or account locations.
const env = {
  HOME: home, USERPROFILE: home, PATH: process.env.PATH ?? "",
  APPDATA: join(home, "appdata"), LOCALAPPDATA: join(home, "localappdata"),
  XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"),
  XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"),
  NO_COLOR: "1", HARA_UPDATE_CHECK: "0", OPENCODE_DISABLE_AUTOUPDATE: "1",
  ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot ?? "C:\\Windows" } : {}),
};
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, env, encoding: "utf8", timeout: 60_000, maxBuffer: 2 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error("native coding runtime probe failed");
  return result.stdout.trim();
};
try {
  if (run(binary, ["--version"]) !== expectedVersion) throw new Error("Hara binary version mismatch");
  run(binary, ["coding", "sessions", "--provider", "opencode"]);
  const executables = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error("coding runtime cache contains a symlink");
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name === (process.platform === "win32" ? "opencode.exe" : "opencode")) executables.push(path);
    }
  };
  walk(join(home, ".hara", "runtime", "coding", CODE_RUNTIME_VERSION));
  if (executables.length !== 1) throw new Error("expected exactly one embedded native coding runtime");
  const command = executables[0], before = lstatSync(command);
  if (!before.isFile() || before.nlink !== 1 ||
    (process.platform !== "win32" && ((before.mode & 0o777) !== 0o500 || before.uid !== process.getuid?.()))) {
    throw new Error("coding runtime cache ownership/mode contract failed");
  }
  const digest = createHash("sha256").update(readFileSync(command)).digest("hex");
  if (digest !== basename(dirname(command))) throw new Error("embedded coding runtime digest mismatch");
  if (run(command, ["--version"]) !== CODE_RUNTIME_VERSION) throw new Error("native coding runtime version mismatch");
  run(binary, ["coding", "sessions", "--provider", "opencode"]);
  const after = lstatSync(command);
  if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error("a verified coding runtime cache was unexpectedly replaced");
  }
  console.log(`✓ embedded OpenCode ${CODE_RUNTIME_VERSION}: native execution, SHA-256, private mode and cache reuse`);
} catch (error) {
  console.error(`standalone coding runtime smoke: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
