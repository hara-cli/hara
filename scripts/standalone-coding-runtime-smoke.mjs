#!/usr/bin/env node
// Native distribution gate. Pi executes in standalone-pi-runtime-smoke; optional CLIs must be absent.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const [binaryArg, expectedVersion] = process.argv.slice(2);
if (!binaryArg || !expectedVersion) throw new Error("usage: standalone-coding-runtime-smoke <binary> <version>");
const binary = resolve(binaryArg), root = realpathSync.native(mkdtempSync(join(tmpdir(), "hara-standalone-distribution-"))), home = join(root, "home"), workspace = join(root, "workspace");
mkdirSync(home, { mode: 0o700 }); mkdirSync(workspace, { mode: 0o700 });
const env = { HOME: home, USERPROFILE: home, PATH: process.env.PATH ?? "", NO_COLOR: "1", HARA_UPDATE_CHECK: "0",
  ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot ?? "C:\\Windows" } : {}) };
const run = args => { const result = spawnSync(binary, args, { cwd: root, env, encoding: "utf8", timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error("native distribution probe failed"); return result.stdout.trim(); };
try {
  assert.equal(run(["--version"]), expectedVersion);
  const manifest = JSON.parse(run(["--runtime-manifest"])); assert.deepEqual(manifest.preinstalled, ["pi"]); assert.equal(manifest.piSdkVersion, "1.1.0"); assert.deepEqual(manifest.optional, ["opencode", "codex", "claude", "agy"]);
  const state = JSON.parse(run(["workspace", "init", "--root", workspace])); assert.equal(state.executionMode, "workspace"); assert.equal(state.workspaces.length, 0);
  const queue = [workspace]; while (queue.length) for (const entry of readdirSync(queue.pop(), { withFileTypes: true })) {
    assert.equal(entry.isSymbolicLink(), false); assert.doesNotMatch(entry.name, /^(?:opencode|codex|claude|agy|hara-code-runtime)(?:\.exe)?$/i, "no optional runtime may be materialized on startup");
    if (entry.isDirectory()) queue.push(join(entry.parentPath, entry.name));
  }
  console.log("✓ Pi-only standalone: native version, distribution manifest, formal Workspace boot; no optional runtime materialized");
} finally { rmSync(root, { recursive: true, force: true }); }
