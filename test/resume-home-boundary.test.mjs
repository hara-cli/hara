import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function finishChunk(reason) {
  return {
    id: "chatcmpl-resume-home",
    object: "chat.completion.chunk",
    created: 1,
    model: "mock-model",
    choices: [{ index: 0, delta: {}, finish_reason: reason }],
    usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
  };
}

function writeSse(res, chunks) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.end("data: [DONE]\n\n");
}

function listenModel() {
  const requests = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      requests.push(JSON.parse(raw));
      if (requests.length === 1) {
        writeSse(res, [
          {
            id: "chatcmpl-resume-home",
            object: "chat.completion.chunk",
            created: 1,
            model: "mock-model",
            choices: [{
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [{
                  index: 0,
                  id: "call_home_ls",
                  type: "function",
                  function: { name: "ls", arguments: "{}" },
                }],
              },
              finish_reason: null,
            }],
          },
          finishChunk("tool_calls"),
        ]);
        return;
      }
      writeSse(res, [
        {
          id: "chatcmpl-resume-home",
          object: "chat.completion.chunk",
          created: 1,
          model: "mock-model",
          choices: [{ index: 0, delta: { role: "assistant", content: "RESUME_BOUNDARY_OK" }, finish_reason: null }],
        },
        finishChunk("stop"),
      ]);
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, requests, baseURL: `http://127.0.0.1:${address.port}/v1` });
    });
  });
}

function runCli(args, cwd, home) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      HARA_QUIET: "1",
      HARA_UPDATE_CHECK: "0",
      HARA_GUARDIAN: "0",
      NO_COLOR: "1",
    };
    for (const key of [
      "HARA_PROVIDER",
      "HARA_MODEL",
      "HARA_BASE_URL",
      "HARA_API_KEY",
      "OPENAI_API_KEY",
      "HARA_PROFILE",
      "HARA_OVERLAY",
      "HARA_ROUTE_MODEL",
      "HARA_ROUTE_BASE_URL",
      "HARA_ROUTE_API_KEY",
    ]) delete env[key];
    const child = spawn(process.execPath, [join(process.cwd(), "dist", "index.js"), ...args], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("Home-root resume reuses history and rejects a model-initiated workspace inventory", async () => {
  const root = mkdtempSync(join(tmpdir(), "hara-resume-home-"));
  const home = join(root, "home");
  const hiddenProjectName = "HOME_PROJECT_NAME_MUST_NOT_REACH_MODEL";
  const sessionId = "resume-home-boundary";
  const api = await listenModel();
  try {
    mkdirSync(join(home, ".hara", "sessions"), { recursive: true });
    mkdirSync(join(home, hiddenProjectName), { recursive: true });
    writeFileSync(join(home, hiddenProjectName, "thousands-of-files-sentinel.txt"), "must-not-be-read\n");
    writeFileSync(
      join(home, ".hara", "config.json"),
      JSON.stringify({ provider: "openai", apiKey: "test-key", model: "mock-model", baseURL: api.baseURL, guardian: "off", updateCheck: false }),
    );
    writeFileSync(
      join(home, ".hara", "sessions", `${sessionId}.json`),
      JSON.stringify({
        meta: {
          id: sessionId,
          cwd: home,
          provider: "openai",
          model: "mock-model",
          title: "continue prior task",
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
          source: "interactive",
        },
        history: [
          { role: "user", content: "implement the agreed change" },
          { role: "assistant", text: "first step is complete", toolUses: [] },
        ],
      }),
    );

    const result = await runCli(["-p", "continue the existing task", "--resume", sessionId], home, home);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /RESUME_BOUNDARY_OK/);
    assert.equal(api.requests.length, 2, "one refused tool round followed by the final answer");

    const firstRequest = JSON.stringify(api.requests[0]);
    assert.match(firstRequest, /Existing-session continuity/);
    assert.match(firstRequest, /first step is complete/);
    assert.match(firstRequest, /continue the existing task/);
    assert.doesNotMatch(firstRequest, new RegExp(hiddenProjectName));

    const secondRequest = JSON.stringify(api.requests[1]);
    assert.match(secondRequest, /will not enumerate or recursively scan directories/i);
    assert.doesNotMatch(secondRequest, new RegExp(hiddenProjectName));
    assert.doesNotMatch(secondRequest, /thousands-of-files-sentinel/);
  } finally {
    await new Promise((resolve) => api.server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
