import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function writeSse(res, chunks) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.end("data: [DONE]\n\n");
}

function finishChunk(reason) {
  return {
    id: "chatcmpl-outcome",
    object: "chat.completion.chunk",
    created: 1,
    model: "mock-model",
    choices: [{ index: 0, delta: {}, finish_reason: reason }],
    usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
  };
}

function respond(res, reply) {
  if (reply.type === "error") {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: reply.message ?? "forced provider failure", type: "invalid_request_error" } }));
    return;
  }
  if (reply.type === "empty") {
    writeSse(res, [finishChunk("stop")]);
    return;
  }
  if (reply.type === "tool") {
    writeSse(res, [
      {
        id: "chatcmpl-outcome",
        object: "chat.completion.chunk",
        created: 1,
        model: "mock-model",
        choices: [{
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [{
              index: 0,
              id: reply.id ?? "call_outcome",
              type: "function",
              function: { name: reply.name, arguments: JSON.stringify(reply.arguments) },
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
      id: "chatcmpl-outcome",
      object: "chat.completion.chunk",
      created: 1,
      model: "mock-model",
      choices: [{ index: 0, delta: { role: "assistant", content: reply.text }, finish_reason: null }],
    },
    finishChunk("stop"),
  ]);
}

function listenModel(replies) {
  const requests = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      requests.push(raw ? JSON.parse(raw) : null);
      const reply = replies[Math.min(requests.length - 1, replies.length - 1)];
      respond(res, reply);
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

function fixture(baseURL, { git = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "hara-headless-outcomes-"));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(join(home, ".hara"), { recursive: true });
  mkdirSync(join(project, ".hara", "roles"), { recursive: true });
  writeFileSync(
    join(home, ".hara", "config.json"),
    JSON.stringify({ provider: "openai", apiKey: "test-key", model: "mock-model", baseURL, guardian: "off", updateCheck: false }),
  );
  writeFileSync(join(project, "package.json"), "{}\n");
  writeFileSync(
    join(project, ".hara", "roles", "implementer.md"),
    "---\nname: implementer\ndescription: test implementer\n---\nComplete the task.\n",
  );
  if (git) {
    const runGit = (...args) => execFileSync("git", args, { cwd: project, stdio: "ignore" });
    runGit("init", "-q");
    runGit("config", "user.email", "test@example.com");
    runGit("config", "user.name", "Test");
    runGit("add", "-A");
    runGit("commit", "-qm", "fixture");
  }
  return { root, home, project };
}

test("plain headless -p maps provider errors and empty outcomes to explicit stderr + exit 2", async () => {
  const errorApi = await listenModel([{ type: "error", message: "forced provider failure" }]);
  const emptyApi = await listenModel([{ type: "empty" }]);
  const errorFx = fixture(errorApi.baseURL);
  const emptyFx = fixture(emptyApi.baseURL);
  try {
    const errored = await runCli(["-p", "fail now"], errorFx.project, errorFx.home);
    assert.equal(errored.code, 2);
    assert.match(errored.stderr, /headless run failed \(error\).*forced provider failure/i);

    const empty = await runCli(["-p", "return nothing"], emptyFx.project, emptyFx.home);
    assert.equal(empty.code, 2);
    assert.match(empty.stderr, /headless run failed \(empty\).*empty response/i);
    assert.equal(emptyApi.requests.length, 2, "the agent's one bounded empty retry still occurs before failure is reported");
  } finally {
    await Promise.all([
      new Promise((resolve) => errorApi.server.close(resolve)),
      new Promise((resolve) => emptyApi.server.close(resolve)),
    ]);
    rmSync(errorFx.root, { recursive: true, force: true });
    rmSync(emptyFx.root, { recursive: true, force: true });
  }
});

test("structured_output is not printed when a later provider turn fails", async () => {
  const api = await listenModel([
    { type: "tool", name: "structured_output", arguments: { ok: true } },
    { type: "error", message: "failed after structured tool" },
  ]);
  const fx = fixture(api.baseURL);
  try {
    const schema = JSON.stringify({ type: "object", required: ["ok"], properties: { ok: { type: "boolean" } }, additionalProperties: false });
    const result = await runCli(["-p", "produce a result", "--schema", schema], fx.project, fx.home);
    assert.equal(result.code, 2, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.stdout.trim(), "", "provisional structured data never masquerades as final success JSON");
    assert.match(result.stderr, /structured run failed \(error\).*failed after structured tool/i);
    assert.equal(api.requests.length, 2);
  } finally {
    await new Promise((resolve) => api.server.close(resolve));
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("hara org propagates implementer failure, skips --commit, and exits 2", async () => {
  const api = await listenModel([{ type: "empty" }]);
  const fx = fixture(api.baseURL, { git: true });
  try {
    const result = await runCli(["org", "--role", "implementer", "--commit", "do the task"], fx.project, fx.home);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /org run failed \(empty\).*empty response/i);
    assert.doesNotMatch(result.stdout, /nothing to commit|not auto-committing/i, "commit handling is never entered after a failed implementer run");
    assert.equal(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: fx.project, encoding: "utf8" }).trim(), "1");
  } finally {
    await new Promise((resolve) => api.server.close(resolve));
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("hara plan does not verify or mark an atom done after its agent run failed", async () => {
  const api = await listenModel([{ type: "empty" }]);
  const fx = fixture(api.baseURL);
  try {
    const planDir = join(fx.project, ".hara", "org");
    mkdirSync(planDir, { recursive: true });
    writeFileSync(
      join(planDir, "plan.json"),
      JSON.stringify({
        task: "do one step",
        createdAt: new Date().toISOString(),
        atoms: [{ id: "a1", title: "complete the step", deps: [], check: "true", status: "pending" }],
      }),
    );

    const result = await runCli(["plan", "resume"], fx.project, fx.home);
    assert.equal(result.code, 2, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /plan run failed \(error\).*atom a1 failed.*empty response/i);
    const saved = JSON.parse(readFileSync(join(planDir, "plan.json"), "utf8"));
    assert.equal(saved.atoms[0].status, "failed", "a successful check cannot mask a failed agent turn");
    assert.match(saved.atoms[0].note, /empty response/i);
    assert.equal(api.requests.length, 2, "only the bounded empty-turn retry ran; the verify provider was never called");
  } finally {
    await new Promise((resolve) => api.server.close(resolve));
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("hara org reports a capped review rejection as a halted logical failure", async () => {
  const api = await listenModel([
    { type: "tool", name: "write_file", arguments: { path: "made.txt", content: "created by implementer\n" } },
    { type: "text", text: "Implementation complete." },
    { type: "text", text: "1. made.txt: needs a correction\nVERDICT: CHANGES_REQUESTED" },
  ]);
  const fx = fixture(api.baseURL, { git: true });
  try {
    const result = await runCli(["org", "--role", "implementer", "--review", "--rounds", "1", "do the task"], fx.project, fx.home);
    assert.equal(result.code, 2, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /org run failed \(halted\).*reviewer did not approve after 1 round/i);
    assert.equal(readFileSync(join(fx.project, "made.txt"), "utf8"), "created by implementer\n");
    assert.equal(api.requests.length, 3);
    assert.doesNotMatch(JSON.stringify(api.requests[0]?.messages), /dispatcher in an engineering org/i, "--role is honored without an extra dispatcher turn");
  } finally {
    await new Promise((resolve) => api.server.close(resolve));
    rmSync(fx.root, { recursive: true, force: true });
  }
});
