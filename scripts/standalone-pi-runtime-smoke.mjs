#!/usr/bin/env node
// Exercise the actual compiled CLI's Pi worker using a bounded loopback-only synthetic model.
// No account/configuration/credential is inherited and no paid provider is contacted.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createPortReservation } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readStandalonePiSmokeWorkerFailure, standalonePiSmokeDiagnostic } from "./standalone-pi-runtime-diagnostics.mjs";

const [binaryArg, expectedVersion] = process.argv.slice(2);
if (!binaryArg || !expectedVersion) {
  console.error("usage: node scripts/standalone-pi-runtime-smoke.mjs <native-binary> <expected-version>");
  process.exit(2);
}
const binary = resolve(binaryArg);
const root = realpathSync.native(mkdtempSync(join(tmpdir(), "hara-native-pi-")));
const home = join(root, "home"), cwd = join(root, "repo");
mkdirSync(home, { mode: 0o700 }); mkdirSync(cwd, { mode: 0o700 });
writeFileSync(join(cwd, "source.txt"), "synthetic-pi-memory-314\n", { mode: 0o600 });
const env = {
  HOME: home, USERPROFILE: home, PATH: process.env.PATH ?? "",
  APPDATA: join(home, "appdata"), LOCALAPPDATA: join(home, "localappdata"),
  XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"),
  XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"),
  NO_COLOR: "1", HARA_UPDATE_CHECK: "0", HARA_CODING_EXECUTOR: "pi",
  HARA_PROVIDER: "openai", HARA_MODEL: "synthetic-native-pi",
  HARA_API_KEY: "synthetic-loopback-only-not-a-credential",
  ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot ?? "C:\\Windows" } : {}),
};
let child, ws, failedRequest;
let childOutput = "";
let rootRounds = 0, workerRounds = 0, requests = 0;
let stage = "fixture_git", diagnosticWorker, diagnosticSessionId;
const pending = new Map();
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.method, "POST"); assert.equal(req.url, "/v1/chat/completions");
    assert.ok(++requests <= 16, "synthetic model request ceiling exceeded");
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      assert.ok(Buffer.byteLength(raw) <= 2 * 1024 * 1024, "synthetic request is oversized");
    }
    const body = JSON.parse(raw);
    assert.equal(body.model, env.HARA_MODEL);
    const system = body.messages.filter(item => item.role === "system").map(item => item.content).join("\n");
    const worker = system.includes("Hara-owned coding worker");
    let name, input, text = "Synthetic fixture complete.";
    if (worker) {
      workerRounds += 1;
      assert.deepEqual(body.tools.map(tool => tool.function.name).sort(),
        ["hara_ask_user", "hara_edit_file", "hara_list_files", "hara_read_file", "hara_write_file"]);
      if (workerRounds === 1) { name = "hara_read_file"; input = { path: "source.txt" }; }
      else {
        assert.ok(body.messages.some(item => item.role === "tool" && String(item.content).includes("synthetic-pi-memory-314")),
          "the native SDK must retain the actual read result, including after resume");
        text = "Remembered synthetic-pi-memory-314.";
      }
      assert.ok(workerRounds <= 3, "unexpected repeated worker execution");
    } else if (body.tools?.length) {
      rootRounds += 1;
      if (rootRounds === 1) {
        name = "task_intake"; input = { intent: "change", goal: "Exercise the isolated synthetic Pi worker twice",
          constraints: ["read only source.txt; do not send messages or contact external services"],
          acceptance: ["the worker reads the synthetic marker and recalls it in a second generation"],
          steps: ["start worker", "wait", "resume worker", "wait", "confirm"] };
      } else if (rootRounds === 2) {
        name = "spawn_agent"; input = { task_name: "pi_smoke", runtime: "coding", workspace: "isolated-write",
          message: "Read source.txt once, remember its synthetic marker and report it. Do not write or run commands." };
      } else if (rootRounds === 3 || rootRounds === 5) {
        name = "wait_agent"; input = { target: "/root/pi_smoke", timeout_ms: 10_000 };
      } else if (rootRounds === 4) {
        name = "followup_task"; input = { target: "/root/pi_smoke", message: "Recall the earlier marker from this same session, without rereading files." };
      } else if (rootRounds === 6) {
        name = "task_checkpoint"; input = { completion: { state: "verified",
          evidence: ["the synthetic worker returned its marker after read and same-session resume"],
          final_answer: "Synthetic Pi native smoke complete." } };
      } else throw new Error("unexpected parent round");
    }
    if (name) assert.ok(body.tools.some(tool => tool.function.name === name), "fixture requested an unavailable tool");
    const toolCalls = name ? [{ id: `synthetic_${requests}`, type: "function",
      function: { name, arguments: JSON.stringify(input) } }] : undefined;
    const finish = name ? "tool_calls" : "stop";
    const base = { id: `synthetic_completion_${requests}`, model: body.model, created: 1 };
    if (body.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const frame = (delta, finish_reason = null, usage) => res.write(`data: ${JSON.stringify({ ...base,
        object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\n\n`);
      frame({ role: "assistant", ...(name ? { tool_calls: toolCalls.map((call, index) => ({ index, ...call })) } : { content: text }) });
      frame({}, finish, { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 });
      res.end("data: [DONE]\n\n");
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ...base, object: "chat.completion", choices: [{ index: 0,
        message: { role: "assistant", content: name ? null : text, ...(toolCalls ? { tool_calls: toolCalls } : {}) }, finish_reason: finish }],
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } }));
    }
  } catch (error) {
    failedRequest = error;
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "synthetic fixture rejected the request" } }));
  }
});
const waitFor = async (condition, milliseconds, label) => {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (failedRequest) throw failedRequest;
    const value = condition(); if (value) return value;
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error(`isolated native Serve exited early: ${childOutput.trim()}`);
    await new Promise(done => setTimeout(done, 25));
  }
  throw new Error(`${label} timed out`);
};
let nextId = 0;
const rpc = (method, params = {}) => new Promise((done, reject) => {
  const id = ++nextId;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`synthetic RPC timeout: ${method}`)); }, 45_000);
  pending.set(id, { done, reject, timer });
  ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
});
let notificationFailure;
try {
  for (const args of [["init", "-q"], ["config", "user.name", "Hara Fixture"],
    ["config", "user.email", "fixture@example.test"], ["add", "source.txt"], ["commit", "-qm", "fixture"]]) {
    const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, env, encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 0, "isolated fixture Git setup failed");
  }
  stage = "fixture_provider";
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  env.HARA_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;
  // Serve pins a persisted route per session; ambient model variables alone do not create that route.
  stage = "profile";
  for (const args of [["profile", "add", "native-smoke", "--byok", "--provider", "openai-compatible",
    "--no-key-prompt", "--key", env.HARA_API_KEY, "--base-url", env.HARA_BASE_URL, "--model", env.HARA_MODEL],
    ["profile", "use", "native-smoke"]]) {
    const configured = spawnSync(binary, args, { cwd: root, env, encoding: "utf8", timeout: 15_000, windowsHide: true });
    assert.equal(configured.status, 0, "isolated synthetic provider profile setup failed");
  }
  stage = "serve_start";
  const port = await new Promise((done, reject) => {
    const reservation = createPortReservation(); reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", () => {
      const selected = reservation.address().port;
      reservation.close(error => error ? reject(error) : done(selected));
    });
  });
  child = spawn(binary, ["serve", "--host", "127.0.0.1", "--port", String(port), "--cwd", cwd, "--approval", "full-auto", "--sandbox", "off"],
    { cwd: root, env, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  child.stderr.on("data", chunk => { childOutput = (childOutput + String(chunk)).slice(-4_000); });
  child.on("error", error => { notificationFailure = error; });
  const discovery = join(home, ".hara", "serve.json");
  stage = "discovery";
  const record = await waitFor(() => {
    if (notificationFailure) throw notificationFailure;
    if (!existsSync(discovery)) return null;
    try { return JSON.parse(readFileSync(discovery, "utf8")); } catch { return null; }
  }, 20_000, "native discovery");
  assert.equal(record.version, expectedVersion); assert.equal(record.pid, child.pid); assert.equal(record.port, port);
  assert.ok(Number.isInteger(record.port) && record.port > 0);
  ws = new WebSocket(`ws://127.0.0.1:${record.port}`);
  ws.addEventListener("message", event => {
    const message = JSON.parse(String(event.data));
    const item = pending.get(message.id);
    if (item) { clearTimeout(item.timer); pending.delete(message.id); item.done(message); }
    if (message.method === "approval.request") {
      void rpc("approval.reply", { approvalId: message.params.approvalId, allow: true }).then(result => {
        assert.equal(result.error, undefined);
      }).catch(error => { notificationFailure = error; });
    }
    if (message.method === "external.approval.request" || message.method === "external.question.request") {
      notificationFailure = new Error("read-only synthetic worker requested unexpected authority or input");
    }
  });
  await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error("native WebSocket open timed out")), 10_000);
    ws.addEventListener("open", () => { clearTimeout(timer); done(); }, { once: true });
    ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("native WebSocket failed")); }, { once: true });
  });
  stage = "initialize";
  const initialized = await rpc("initialize", { token: record.token,
    capabilities: { features: ["coding.settings.v1", "external.delegated-interaction.v1", "external.questions.v1"] } });
  assert.equal(initialized.error, undefined); assert.equal(initialized.result.version, expectedVersion);
  stage = "settings";
  const settings = await rpc("settings.coding.get");
  assert.equal(settings.error, undefined); assert.equal(settings.result.effectiveExecutor, "pi");
  stage = "session_create";
  const created = await rpc("session.create"); assert.equal(created.error, undefined);
  const sessionId = created.result.sessionId;
  diagnosticSessionId = sessionId;
  stage = "session_send";
  const sent = await rpc("session.send", { sessionId, text: "Run the synthetic Pi read and same-session recall fixture. No external services, sends, writes or shell commands." });
  if (failedRequest) throw failedRequest;
  if (notificationFailure) throw notificationFailure;
  assert.equal(sent.error, undefined, "native Pi task did not complete");
  stage = "worker_assertions";
  const listed = await rpc("session.agents.list", { sessionId }); assert.equal(listed.error, undefined);
  diagnosticWorker = listed.result?.agents?.[0];
  assert.equal(listed.result.agents.length, 1);
  const worker = listed.result.agents[0];
  assert.equal(worker.runtime, "pi"); assert.equal(worker.status, "completed"); assert.equal(worker.generation, 2);
  assert.match(worker.providerSessionId, /^ext_pi_[a-f0-9]{24}$/);
  assert.equal(workerRounds, 3); assert.equal(rootRounds, 6);
  assert.equal(listed.result.budget.providerRounds, 3); assert.equal(listed.result.budget.toolCalls, 1);
  assert.equal(listed.result.budget.inputTokens, 21); assert.equal(listed.result.budget.outputTokens, 9);
  assert.equal(readFileSync(join(cwd, "source.txt"), "utf8"), "synthetic-pi-memory-314\n");
  stage = "shutdown";
  const shutdown = await rpc("server.shutdown"); assert.equal(shutdown.error, undefined);
  await new Promise((done, reject) => {
    if (child.exitCode !== null) { assert.equal(child.exitCode, 0); done(); return; }
    const timer = setTimeout(() => reject(new Error("native shutdown timed out")), 10_000);
    child.once("exit", code => { clearTimeout(timer); code === 0 ? done() : reject(new Error("native shutdown failed")); });
  });
  assert.equal(existsSync(discovery), false);
  console.log("✓ compiled Pi SDK: authenticated Serve, real read tool, same-session resume and exact usage; loopback synthetic only");
} catch (error) {
  console.error("standalone Pi runtime smoke failed");
  const workerFailure = readStandalonePiSmokeWorkerFailure(home, diagnosticSessionId, diagnosticWorker?.id);
  console.error(`standalone Pi runtime diagnostic: ${JSON.stringify(standalonePiSmokeDiagnostic({
    stage, rootRounds, workerRounds, requests, worker: diagnosticWorker, workerFailure, error,
  }))}`);
  process.exitCode = 1;
} finally {
  for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("fixture stopped")); }
  ws?.close();
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill();
    await Promise.race([new Promise(done => child.once("exit", done)), new Promise(done => setTimeout(done, 3_000))]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  server.closeAllConnections();
  await new Promise(done => server.close(done));
  if (!child || child.exitCode !== null || child.signalCode !== null) rmSync(root, { recursive: true, force: true });
  else { console.error("standalone Pi runtime smoke: preserving private fixture until child exits"); process.exitCode = 1; }
}
