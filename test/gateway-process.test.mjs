import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatewayRunTimeoutMs, runHara } from "../dist/gateway/serve.js";
import { approvedOrgTimeoutMs, runApprovedOrgProcess } from "../dist/gateway/flows-pending.js";

async function waitForPath(path, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for child readiness: ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function withChild(mode, options = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "hara-gateway-child-"));
  const helper = join(cwd, "child.mjs");
  writeFileSync(helper, `
const mode = process.env.HARA_TEST_GATEWAY_CHILD;
if (mode === "ok") console.log("mcp: hidden status\\nhello from child\\n  model · ↑1 ↓2 tok");
else if (mode === "empty") process.exit(0);
else if (mode === "failure") { console.error("provider unavailable"); process.exit(7); }
else if (mode === "sigkill") process.kill(process.pid, "SIGKILL");
else if (mode === "hang-ignore-term") { process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); }
else if (mode === "hang") setInterval(() => {}, 1000);
else if (mode === "inherited-pipe") {
  const { spawn } = await import("node:child_process");
  const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: ["ignore", process.stdout, process.stderr],
  });
  grandchild.unref();
  console.log("grandchild:" + grandchild.pid);
}
`);
  const previousArgv1 = process.argv[1];
  const previousMode = process.env.HARA_TEST_GATEWAY_CHILD;
  process.argv[1] = helper;
  process.env.HARA_TEST_GATEWAY_CHILD = mode;
  const promise = runHara("test", `test-${mode}`, cwd, "test", undefined, undefined, options);
  return promise.finally(() => {
    process.argv[1] = previousArgv1;
    if (previousMode === undefined) delete process.env.HARA_TEST_GATEWAY_CHILD;
    else process.env.HARA_TEST_GATEWAY_CHILD = previousMode;
    rmSync(cwd, { recursive: true, force: true });
  });
}

test("gateway run timeout is configurable but clamped to a hard ceiling", () => {
  assert.equal(gatewayRunTimeoutMs("not-a-number"), 15 * 60_000);
  assert.equal(gatewayRunTimeoutMs(1), 50);
  assert.equal(gatewayRunTimeoutMs(60_000), 60_000);
  assert.equal(gatewayRunTimeoutMs(Number.MAX_SAFE_INTEGER), 30 * 60_000);
});

test("approved org subprocesses have a hard ceiling and die with gateway shutdown", async () => {
  assert.equal(approvedOrgTimeoutMs("bad"), 15 * 60_000);
  assert.equal(approvedOrgTimeoutMs(1), 50);
  assert.equal(approvedOrgTimeoutMs(Number.MAX_SAFE_INTEGER), 30 * 60_000);

  const cwd = mkdtempSync(join(tmpdir(), "hara-approved-org-child-"));
  const helper = join(cwd, "org-child.mjs");
  const ready = join(cwd, "ready");
  writeFileSync(helper, `
import { writeFileSync } from "node:fs";
process.stdout.write("pid:" + process.pid + "\\n", () => writeFileSync(${JSON.stringify(ready)}, ""));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`);
  const controller = new AbortController();
  let running;
  try {
    running = runApprovedOrgProcess(process.execPath, [helper], {
      cwd,
      signal: controller.signal,
      timeoutMs: 5_000,
      killGraceMs: 50,
    });
    await waitForPath(ready);
    const started = Date.now();
    controller.abort();
    const result = await running;
    assert.equal(result.stopReason, "shutdown");
    assert.match(result.output, /pid:\d+/);
    assert.ok(Date.now() - started < 1_500, "a TERM-ignoring approved delegation cannot pin daemon shutdown");
  } finally {
    controller.abort();
    await running;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runHara cleans successful output and reports empty/non-zero/signal exits explicitly", async () => {
  assert.deepEqual(await withChild("ok"), { reply: "hello from child", files: [] });

  const empty = await withChild("empty");
  assert.match(empty.reply, /^✗ hara completed but produced no reply\.$/);

  const failed = await withChild("failure");
  assert.match(failed.reply, /^✗ hara failed with exit code 7\./);
  assert.match(failed.reply, /provider unavailable/);

  const killed = await withChild("sigkill");
  assert.match(killed.reply, /^✗ hara was terminated by SIGKILL\.$/);
});

test("runHara times out, escalates TERM to KILL, and settles promptly", async () => {
  const started = Date.now();
  const result = await withChild("hang-ignore-term", { timeoutMs: 80, killGraceMs: 50 });
  assert.match(result.reply, /^✗ hara timed out after 80ms; the run was stopped\.$/);
  assert.ok(Date.now() - started < 1_500, "a TERM-ignoring child must not pin the gateway");
});

test("runHara does not wait forever when a grandchild inherits its output pipes", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX pid cleanup assertion");
  const started = Date.now();
  const result = await withChild("inherited-pipe", { timeoutMs: 2_000 });
  const pid = Number(/grandchild:(\d+)/.exec(result.reply)?.[1]);
  try {
    assert.ok(Number.isSafeInteger(pid) && pid > 0, result.reply);
    assert.ok(Date.now() - started < 1_000, "an inherited pipe must have a bounded drain window");
  } finally {
    if (Number.isSafeInteger(pid) && pid > 0) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already exited */ }
    }
  }
});

test("runHara aborts an in-flight child during daemon shutdown", async () => {
  const controller = new AbortController();
  const running = withChild("hang", { signal: controller.signal, timeoutMs: 5_000, killGraceMs: 50 });
  setTimeout(() => controller.abort(), 80);
  const result = await running;
  assert.match(result.reply, /^✗ hara run cancelled because the gateway is shutting down\.$/);

  const alreadyStopped = new AbortController();
  alreadyStopped.abort();
  assert.deepEqual(await withChild("ok", { signal: alreadyStopped.signal }), {
    reply: "✗ hara run cancelled because the gateway is shutting down.",
    files: [],
  });
});
