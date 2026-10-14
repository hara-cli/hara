#!/usr/bin/env node
// Credential-free acceptance diagnostics. Passing fixture/SDK tests is NOT a main-Agent release gate.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRuntimeRegistry } from "../dist/agent-runtime/registry.js";

const cwd = fileURLToPath(new URL("../", import.meta.url));
const evidence = mkdtempSync(join(tmpdir(), "hara-runtime-acceptance-"));
const groups = [
  { id: "agent-binding", scope: "real Serve and compatibility loop; non-Hara routing fixtures are not production drivers",
    files: ["agent-runtime-binding", "serve-agent-runtime"] },
  { id: "pi-sdk-session", scope: "real pinned Pi SDK with a loopback synthetic model, no Hara planner loop",
    files: ["pi-host-session"] },
  { id: "pi-governed-runtime", scope: "real Pi SDK model-step Runtime, shared Hara governor and actual CLI dispatch; synthetic loopback only",
    files: ["agent-runtime-pi", "agent-runtime-dispatch"] },
  { id: "coding-protocols", scope: "Codex/Claude/OpenCode adapter, ownership, grant and continuation protocol fixtures; not live vendor CLIs",
    files: ["coding-team", "external-coding-sessions", "coding-tools", "coding-continuations"] },
  { id: "pi-worker", scope: "real Pi coding-worker SDK and parent-chat cards; the OpenCode comparison uses a transport fixture",
    files: ["pi-coding", "serve-coding-worker"] },
];
const results = [];
for (const group of groups) {
  const home = join(evidence, group.id); mkdirSync(home, { mode: 0o700 });
  // Do not pass the operator's model, account, proxy, auth or node-preload variables to a test child.
  const env = { HOME: home, USERPROFILE: home, PATH: process.env.PATH ?? "", NO_COLOR: "1", HARA_UPDATE_CHECK: "0",
    ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot ?? "C:\\Windows" } : {}) };
  const result = spawnSync(process.execPath, ["--import", "./test/setup-isolated-home.mjs", "--test", "--test-concurrency=2",
    "--test-timeout=120000", ...group.files.map((file) => `test/${file}.test.mjs`)],
  { cwd, env, encoding: "utf8", timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const log = join(evidence, `${group.id}.log`); writeFileSync(log, output, { mode: 0o600 });
  const count = (name) => { const value = output.match(new RegExp(`^# ${name} (\\d+)$`, "m")); return value ? Number(value[1]) : null; };
  const passed = result.status === 0 && !result.error && count("fail") === 0 && count("cancelled") === 0;
  results.push({ id: group.id, scope: group.scope, status: passed ? "passed" : "failed", tests: count("tests"),
    passed: count("pass"), failed: count("fail"), cancelled: count("cancelled"), skipped: count("skipped"), log });
}
const registered = new AgentRuntimeRegistry().options();
const requested = ["codex", "claude", "opencode", "pi"].map((id) => ({ id,
  generalAgentDriverRegistered: registered.some((option) => option.id === id && option.available),
  nativeLiveSessionTested: false,
}));
const git = (args) => spawnSync("git", args, { cwd, encoding: "utf8", timeout: 5000 });
const commit = git(["rev-parse", "HEAD"]), changed = git(["status", "--porcelain"]);
const report = {
  version: 1, sourceCommit: commit.status === 0 ? commit.stdout.trim() : null,
  sourceDirty: changed.status === 0 ? Boolean(changed.stdout.trim()) : null,
  modelTraffic: "loopback synthetic fixtures only; no real provider credentials or paid calls", suites: results, requested,
  endToEndReady: false,
  remaining: ["external Codex/Claude/OpenCode general-Agent drivers and exact native-session linkage",
    "real-model and packaged Desktop acceptance", "explicit migration of existing main/Agent preferences; never silently rebind old work"],
};
const reportPath = join(evidence, "report.json"); writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify({ ...report, reportPath }, null, 2));
// Explicitly unverified end-to-end gates cannot be greened by fixture coverage or a user flag.
process.exitCode = results.some((group) => group.status !== "passed") ? 1 : 2;
