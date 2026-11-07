import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { createCodingHostBridge } from "../dist/coding/host.js";
import { createWorkspaceMcpEndpoint } from "../dist/agent-runtime/registered-cli-mcp.js";
import { PiRpcProcess } from "../dist/agent-runtime/pi-rpc-process.js";
import { piNativeLauncher } from "../dist/agent-runtime/pi-full.js";
import { RuntimeProcessBoundary, RUNTIME_GUARD_SCRIPT } from "../dist/agent-runtime/process-boundary.js";
test("pinned Pi RPC compacts only while idle through the original local model gateway, keeping its native journal append-only", async t => {
  if (process.platform !== "darwin") return t.skip("macOS protected process boundary required");
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "hara-pi-compact-native-"))), work = join(root, "work");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of [work, "home", "agent", "agent/sessions", "agent/tmp"].map(path => path.startsWith(root) ? path : join(root, path))) mkdirSync(path, { recursive: true, mode: 0o700 });
  for (const name of ["auth.json", "models.json", "models-store.json"]) writeFileSync(join(root, "agent", name), "{}\n", { mode: 0o600 });
  let requests = 0, summaryPhase = false;
  const gateway = await createCodingHostBridge({ provider: { id: "frozen-local-fixture", model: "fixed-local-model", async turn(args) {
    requests++; assert.deepEqual(args.tools, []);
    return { text: summaryPhase ? "## Goal\nRetain the synthetic goal and latest confirmation state.\n## Progress\nNo action approved; verify before any mutation."
      : "Synthetic original reply " + requests, toolUses: [], stop: "end", usage: { input: 20000, output: 30 } };
  } }, tools: [], executeTool: async () => { throw new Error("no tool execution in this fixture"); }, assertCurrent() {},
    nativeModel: { audience: "d".repeat(64) }, budget: { maxProviderRounds: 8, maxToolCalls: 1, maxTokens: 200000, timeoutMs: 15000 } });
  t.after(() => gateway.close());
  const endpoint = await createWorkspaceMcpEndpoint({ signal: new AbortController().signal, assertCurrent() {}, tools: () => [], async call() { throw new Error("no tool authority"); } });
  t.after(() => endpoint.close());
  const model = gateway.provider.hara.options, launch = piNativeLauncher();
  const env = { HOME: join(root, "home"), USERPROFILE: join(root, "home"), PI_CODING_AGENT_DIR: join(root, "agent"), PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", NODE_DISABLE_COMPILE_CACHE: "1", PATH: dirname(launch.command) + ":/usr/bin:/bin", TMPDIR: join(root, "agent/tmp") };
  const configuration = { schemaVersion: 1, sdkVersion: "1.5.0", root, cwd: work, system: "Only synthetic reference material. Never execute tools.",
    model: { baseURL: model.baseURL, token: model.apiKey }, mcp: { url: endpoint.url, token: endpoint.env.HARA_WORKSPACE_MCP_TOKEN, tools: [] }, nativeTools: [], sessionFile: null };
  const lifecycle = new RuntimeProcessBoundary(); lifecycle.markWrapped();
  const profile = '(version 1) (allow default) (deny file-write*) (allow file-write* (subpath ' + JSON.stringify(root) + ') (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr")) (deny file-link)';
  const rpc = new PiRpcProcess({ ...launch, env, configuration, cwd: work, timeoutMs: 15000, signal: new AbortController().signal, onFrame() {}, onAccepted() {},
    boundary: { spawn() {
      const child = spawn("/bin/sh", ["-c", RUNTIME_GUARD_SCRIPT, "hara-native-guard", "/usr/bin/sandbox-exec", "-p", profile, launch.command, ...launch.args], { cwd: work, env, detached: true, stdio: ["pipe", "pipe", "pipe", "pipe"] });
      return { child, ready: lifecycle.own(child, true) };
    }, async drain() { await lifecycle.drain(false); } } });
  t.after(async () => { await rpc.close(); await lifecycle.close(); });
  const original = "NATIVE-ORIGINAL-" + randomUUID();
  await rpc.prompt(original + "\n" + "reference fact retained with no authority. ".repeat(600));
  const second = await rpc.prompt("LATEST-REFERENCE\n" + "Open work is verify; no mutation is confirmed. ".repeat(900));
  assert.equal(requests, 2); assert.equal(second.state.isStreaming, false); assert.equal(second.state.autoCompactionEnabled, false);
  const before = readFileSync(second.state.sessionFile, "utf8"); assert.ok(before.includes(original));
  assert.ok(await rpc.contextTokens() >= 16384); summaryPhase = true;
  const compacted = await rpc.compact("Retain goals, decisions, open work, references and card state. No authority or completion evidence.");
  assert.equal(requests, 3, "one native summary call through the same frozen gateway; no retry");
  assert.ok(compacted.tokensBefore > 0); assert.equal("summary" in compacted, false);
  const after = readFileSync(second.state.sessionFile, "utf8"); assert.ok(after.startsWith(before)); assert.match(after, /"type":"compaction"/);
  assert.equal((await rpc.state()).sessionId, second.state.sessionId); assert.equal((await rpc.state()).autoCompactionEnabled, false);
});
