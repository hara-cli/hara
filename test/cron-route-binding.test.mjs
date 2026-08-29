import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HARA_RUNTIME_VERSION } from "../dist/version.js";

function runCli(args, cwd, home, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(process.cwd(), "dist", "index.js"), ...args], {
      cwd,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        HARA_QUIET: "1",
        HARA_UPDATE_CHECK: "0",
        HARA_GUARDIAN: "0",
        NO_COLOR: "1",
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function pendingOccurrence(id, cwd, jobId) {
  const now = new Date().toISOString();
  return {
    meta: {
      id,
      cwd,
      haraVersion: HARA_RUNTIME_VERSION,
      provider: "",
      model: "",
      title: "cron fixture",
      createdAt: now,
      updatedAt: now,
      source: "cron",
      sourceName: "route fixture",
      jobId,
      pendingRouteBinding: "cron",
    },
    history: [],
  };
}

test("a fresh cron occurrence binds the active profile, Space, provider, and model before its first turn", { timeout: 20_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "hara-cron-route-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const sessions = join(home, ".hara", "sessions");
  const requests = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      requests.push(JSON.parse(raw));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({
        id: "chatcmpl-cron-route",
        object: "chat.completion.chunk",
        created: 1,
        model: "cron-route-model",
        choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }],
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        id: "chatcmpl-cron-route",
        object: "chat.completion.chunk",
        created: 1,
        model: "cron-route-model",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const jobId = "cron-route-job";
  const sessionId = randomUUID();
  const refusedId = randomUUID();
  try {
    mkdirSync(sessions, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "package.json"), "{}\n");
    writeFileSync(join(home, ".hara", "config.json"), JSON.stringify({
      provider: "openai",
      apiKey: "fixture-key",
      model: "cron-route-model",
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      guardian: "off",
      updateCheck: false,
    }), { mode: 0o600 });
    writeFileSync(join(sessions, `${sessionId}.json`), JSON.stringify(pendingOccurrence(sessionId, project, jobId)));

    const run = await runCli(
      ["-p", "run the route fixture", "--approval", "full-auto", "--resume", sessionId],
      project,
      home,
      { HARA_CRON: "1", HARA_CRON_ID: jobId, HARA_CRON_NAME: "route fixture" },
    );
    assert.equal(run.code, 0, run.stderr || run.stdout);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].model, "cron-route-model");
    const saved = JSON.parse(readFileSync(join(sessions, `${sessionId}.json`), "utf8"));
    assert.equal(saved.meta.profileId, "personal");
    assert.equal(saved.meta.spaceId, "personal");
    assert.equal(saved.meta.provider, "openai");
    assert.equal(saved.meta.model, "cron-route-model");
    assert.equal(saved.meta.pendingRouteBinding, undefined);

    writeFileSync(join(sessions, `${refusedId}.json`), JSON.stringify(pendingOccurrence(refusedId, project, jobId)));
    const refused = await runCli(
      ["-p", "must not run", "--approval", "full-auto", "--resume", refusedId],
      project,
      home,
      { HARA_CRON: "1", HARA_CRON_ID: "different-job", HARA_CRON_NAME: "route fixture" },
    );
    assert.equal(refused.code, 2, refused.stderr || refused.stdout);
    assert.match(refused.stderr + refused.stdout, /legacy organization session|no verifiable Space binding/i);
    assert.equal(requests.length, 1, "a mismatched cron identity cannot send a model request");
    const stillPending = JSON.parse(readFileSync(join(sessions, `${refusedId}.json`), "utf8"));
    assert.equal(stillPending.meta.pendingRouteBinding, "cron");
    assert.equal(stillPending.meta.profileId, undefined);
    assert.equal(stillPending.meta.spaceId, undefined);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
