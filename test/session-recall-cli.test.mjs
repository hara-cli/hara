import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function runCli(args, cwd, home) {
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
      },
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

test("real headless CLI injects an older session when the user explicitly asks to continue it", async () => {
  const root = mkdtempSync(join(tmpdir(), "hara-session-recall-cli-"));
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
        id: "chatcmpl-session-recall",
        object: "chat.completion.chunk",
        created: 1,
        model: "test-model",
        choices: [{ index: 0, delta: { role: "assistant", content: "已继续。" }, finish_reason: null }],
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        id: "chatcmpl-session-recall",
        object: "chat.completion.chunk",
        created: 1,
        model: "test-model",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
      })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    mkdirSync(sessions, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "package.json"), "{}\n");
    writeFileSync(join(home, ".hara", "config.json"), JSON.stringify({
      provider: "openai",
      apiKey: "fixture-key",
      model: "test-model",
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      guardian: "off",
      updateCheck: false,
    }));
    const meta = (id, title, updatedAt) => ({
      id,
      cwd: project,
      provider: "openai",
      model: "test-model",
      title,
      createdAt: "2026-07-20T00:00:00.000Z",
      updatedAt,
      source: "interactive",
    });
    writeFileSync(join(sessions, "prior-copper.json"), JSON.stringify({
      meta: meta("prior-copper", "铜色发布流程", "2026-07-21T09:00:00.000Z"),
      history: [
        { role: "user", content: "铜色发布流程必须先验证签名和摘要。" },
        { role: "assistant", text: "验收完成后才能发布。", toolUses: [] },
      ],
    }));
    writeFileSync(join(sessions, "current-recall.json"), JSON.stringify({
      meta: meta("current-recall", "继续发布", "2026-07-22T09:00:00.000Z"),
      history: [],
    }));

    const run = await runCli(["-p", "继续上次讨论的铜色发布流程", "--resume", "current-recall"], project, home);
    assert.equal(run.code, 0, run.stderr || run.stdout);
    assert.equal(requests.length, 1);
    const sent = JSON.stringify(requests[0].messages);
    assert.match(sent, /Automatic prior-session recall/);
    assert.match(sent, /UNTRUSTED reference text/);
    assert.match(sent, /铜色发布流程必须先验证签名和摘要/);

    const persisted = JSON.parse(readFileSync(join(sessions, "current-recall.json"), "utf8"));
    assert.match(persisted.history.at(-2).content, /Automatic prior-session recall/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
