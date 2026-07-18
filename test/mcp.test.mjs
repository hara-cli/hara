import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { connectMcpServers, closeMcp, registerLazyMcpServers } from "../dist/mcp/client.js";
import { getTool } from "../dist/tools/registry.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "mcp-echo-server.mjs");

test("mcp: configured servers stay stopped until the selected server is requested", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-mcp-lazy-"));
  const browserPid = join(dir, "browser.pid");
  const wechatPid = join(dir, "wechat.pid");
  const previousAllow = process.env.HARA_ALLOW_TRUSTED_EXTENSIONS;
  delete process.env.HARA_ALLOW_TRUSTED_EXTENSIONS;
  const logs = [];
  try {
    registerLazyMcpServers(
      {
        browser: {
          command: process.execPath,
          args: [fixture],
          env: { MCP_PID_FILE: browserPid, MCP_EMIT_NPM_CONFIG_WARNINGS: "1" },
        },
        wechat: { command: process.execPath, args: [fixture], env: { MCP_PID_FILE: wechatPid } },
      },
      (message) => logs.push(message),
    );

    assert.equal(existsSync(browserPid), false, "registration itself must not execute the browser server");
    assert.equal(existsSync(wechatPid), false, "registration itself must not execute the wechat server");
    const connect = getTool("mcp_connect");
    assert.ok(connect, "the bounded lazy launcher is visible to the model");
    assert.equal(connect.trustBoundary, "external");

    const denied = await connect.run({ server: "browser" }, { cwd: process.cwd() });
    assert.match(denied, /Blocked: MCP is a trusted extension/i);
    assert.equal(existsSync(browserPid), false, "a direct non-interactive call stays fail-closed");

    const started = await connect.run(
      { server: "browser" },
      { cwd: process.cwd(), ask: async () => "yes" },
    );
    assert.match(started, /Connected MCP server 'browser'; 1 tool\(s\)/);
    assert.equal(existsSync(browserPid), true, "only the requested server starts");
    assert.equal(existsSync(wechatPid), false, "unrelated configured servers remain stopped");
    assert.ok(getTool("mcp__browser__echo"), "discovered tools are registered for the next model round");

    await new Promise((resolve) => setTimeout(resolve, 20));
    const diagnostics = logs.join("\n");
    assert.doesNotMatch(diagnostics, /Unknown user config "(?:always-auth|home)"/i);
    assert.match(diagnostics, /Unknown user config "custom-setting"/i, "unrelated npm warnings stay visible");
    assert.match(diagnostics, /real MCP startup warning/i, "real server diagnostics stay visible");
  } finally {
    if (previousAllow === undefined) delete process.env.HARA_ALLOW_TRUSTED_EXTENSIONS;
    else process.env.HARA_ALLOW_TRUSTED_EXTENSIONS = previousAllow;
    await closeMcp();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mcp: startup and calls default closed; reviewed/opted-in calls work and stderr is redacted", async () => {
  const previousAllow = process.env.HARA_ALLOW_TRUSTED_EXTENSIONS;
  delete process.env.HARA_ALLOW_TRUSTED_EXTENSIONS;
  const logs = [];
  try {
    const denied = await connectMcpServers(
      { mustNotStart: { command: process.execPath, args: [fixture] } },
      (message) => logs.push(message),
    );
    assert.equal(denied, 0, "no configured process starts without a startup grant");
    assert.match(logs.join("\n"), /skipped.*trusted extensions/i);

    const diagnosticToken = "mcp-sensitive-test-value";
    const n = await connectMcpServers(
      {
        echo: {
          command: process.execPath,
          args: [fixture],
          env: { MCP_EMIT_STDERR: "1", MCP_DIAGNOSTIC_TOKEN: diagnosticToken },
        },
      },
      (message) => logs.push(message),
      { approved: true },
    );
    assert.ok(n >= 1, "registered ≥1 tool");
    const tool = getTool("mcp__echo__echo");
    assert.ok(tool, "mcp__echo__echo present");
    assert.equal(tool.trustBoundary, "external");

    const nonInteractive = await tool.run({ text: "must-not-run" }, { cwd: process.cwd() });
    assert.match(nonInteractive, /Blocked: MCP is a trusted extension.*disabled in non-interactive/i);
    assert.ok(!nonInteractive.includes("must-not-run"));

    const protectedPath = await tool.run(
      { text: "must-not-run", path: ".env" },
      { cwd: process.cwd(), ask: async () => "yes" },
    );
    assert.match(protectedPath, /Blocked: MCP input names protected environment file/i);
    assert.ok(!protectedPath.includes("must-not-run"));

    const reviewed = await tool.run({ text: "hi-mcp" }, { cwd: process.cwd(), ask: async () => "yes" });
    assert.match(reviewed, /hi-mcp/);

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(!logs.join("\n").includes(diagnosticToken), "stdio stderr never logs the configured secret value");
    assert.match(logs.join("\n"), /diagnostic=\*\*\*/, "redacted diagnostics remain useful");

    process.env.HARA_ALLOW_TRUSTED_EXTENSIONS = "1";
    const headlessCount = await connectMcpServers(
      { headless: { command: process.execPath, args: [fixture] } },
      (message) => logs.push(message),
    );
    assert.ok(headlessCount >= 1, "launch-time opt-in authorizes non-interactive server startup");
    const headlessTool = getTool("mcp__headless__echo");
    assert.ok(headlessTool);
    const optedIn = await headlessTool.run({ text: "headless-opt-in" }, { cwd: process.cwd() });
    assert.match(optedIn, /headless-opt-in/);
  } finally {
    if (previousAllow === undefined) delete process.env.HARA_ALLOW_TRUSTED_EXTENSIONS;
    else process.env.HARA_ALLOW_TRUSTED_EXTENSIONS = previousAllow;
    await closeMcp();
  }
});

test("mcp: cancelling the owning turn aborts lazy startup and closes its child", { timeout: 4000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-mcp-abort-"));
  const pidFile = join(dir, "list.pid");
  const listRequestFile = join(dir, "list-requested");
  const controller = new AbortController();
  const logs = [];
  try {
    const started = Date.now();
    const connecting = connectMcpServers(
      {
        "cancelled-list": {
          command: process.execPath,
          args: [fixture],
          env: {
            MCP_PID_FILE: pidFile,
            MCP_HANG_LIST: "1",
            MCP_LIST_REQUEST_FILE: listRequestFile,
          },
        },
      },
      (message) => logs.push(message),
      { approved: true, timeoutMs: 10_000, signal: controller.signal },
    );
    // Wait for the fixture to confirm that initialization completed and listTools reached the server.
    // A fixed abort delay raced slower Node/Windows CI and sometimes cancelled connect instead, leaving
    // this test to assert an implementation-detail timing accident rather than the intended ownership rule.
    for (let attempt = 0; attempt < 200 && !existsSync(listRequestFile); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const reachedListTools = existsSync(listRequestFile);
    controller.abort();
    const count = await connecting;
    const elapsed = Date.now() - started;

    assert.equal(reachedListTools, true, "fixture received the listTools request before cancellation");
    assert.equal(count, 0);
    assert.ok(elapsed < 2_000, `turn cancellation should return promptly (actual ${elapsed}ms)`);
    assert.match(logs.join("\n"), /failed during list tools.*abort/i);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    assert.ok(Number.isSafeInteger(pid) && pid > 0, "fixture recorded a child pid");
    let alive = true;
    for (let attempt = 0; attempt < 20 && alive; attempt++) {
      try {
        process.kill(pid, 0);
        await new Promise((resolve) => setTimeout(resolve, 10));
      } catch {
        alive = false;
      }
    }
    assert.equal(alive, false, "cancelled startup must not outlive the owning agent turn");
  } finally {
    controller.abort();
    await closeMcp();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mcp: connect and listTools time out boundedly, close the child, and bound stderr", { timeout: 4000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-mcp-timeout-"));
  const previousAllow = process.env.HARA_ALLOW_TRUSTED_EXTENSIONS;
  delete process.env.HARA_ALLOW_TRUSTED_EXTENSIONS;
  try {
    for (const stage of ["connect", "list"]) {
      const pidFile = join(dir, `${stage}.pid`);
      const logs = [];
      const env = {
        MCP_PID_FILE: pidFile,
        ...(stage === "connect" ? { MCP_HANG_CONNECT: "1" } : {
          MCP_HANG_LIST: "1",
          MCP_EMIT_OVERSIZED_STDERR: "1",
        }),
      };
      const started = Date.now();
      const count = await connectMcpServers(
        { [`hang-${stage}`]: { command: process.execPath, args: [fixture], env } },
        (message) => logs.push(message),
        { approved: true, timeoutMs: 500 },
      );
      const elapsed = Date.now() - started;

      assert.equal(count, 0);
      assert.ok(elapsed < 2000, `${stage} timeout should return promptly (actual ${elapsed}ms)`);
      assert.match(logs.join("\n"), new RegExp(`failed during ${stage === "connect" ? "connect" : "list tools"}.*timed out`, "i"));
      assert.ok(logs.join("\n").length < 2_000, "stderr diagnostics remain strictly bounded");
      if (stage === "list") assert.match(logs.join("\n"), /oversized diagnostic line omitted/i);

      const pid = Number(readFileSync(pidFile, "utf8").trim());
      assert.ok(Number.isSafeInteger(pid) && pid > 0, `${stage} fixture recorded a child pid`);
      let alive = true;
      for (let attempt = 0; attempt < 20 && alive; attempt++) {
        try {
          process.kill(pid, 0);
          await new Promise((resolve) => setTimeout(resolve, 10));
        } catch {
          alive = false;
        }
      }
      assert.equal(alive, false, `${stage} failure must not leave the MCP child running`);
    }
  } finally {
    if (previousAllow === undefined) delete process.env.HARA_ALLOW_TRUSTED_EXTENSIONS;
    else process.env.HARA_ALLOW_TRUSTED_EXTENSIONS = previousAllow;
    await closeMcp();
    rmSync(dir, { recursive: true, force: true });
  }
});
