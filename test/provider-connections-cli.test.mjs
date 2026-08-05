import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import WebSocket from "ws";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function connect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const pending = new Map();
    let nextId = 1;
    ws.once("error", reject);
    ws.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    });
    ws.once("close", () => {
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("serve socket closed before the RPC response"));
      }
      pending.clear();
    });
    ws.once("open", () => resolve({
      ws,
      call(method, params) {
        return new Promise((callResolve, callReject) => {
          const id = nextId++;
          const timer = setTimeout(() => {
            pending.delete(id);
            callReject(new Error(`timed out waiting for ${method}`));
          }, 5_000);
          pending.set(id, { resolve: callResolve, reject: callReject, timer });
          ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
        });
      },
      close() {
        ws.close();
      },
    }));
  });
}

async function waitForDiscovery(discoveryPath, child, diagnostics, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(discoveryPath)) return JSON.parse(readFileSync(discoveryPath, "utf8"));
    if (child.exitCode !== null) {
      throw new Error(`hara serve exited with ${child.exitCode} before discovery: ${diagnostics()}`);
    }
    await delay(25);
  }
  throw new Error(`timed out waiting for hara serve discovery: ${diagnostics()}`);
}

function waitForExit(child, timeoutMs = 5_000) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("hara serve did not exit after shutdown")), timeoutMs);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

test("real serve keeps same-provider named personal connections independent and redacted", { timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "hara-provider-connections-cli-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const haraHome = join(home, ".hara");
  const discoveryPath = join(haraHome, "serve.json");
  const profilesPath = join(haraHome, "profiles.json");
  const token = "provider-connections-test-token";
  const keyA = "sk-named-connection-a-1111";
  const keyB = "sk-named-connection-b-2222";
  const port = await reservePort();
  mkdirSync(haraHome, { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "package.json"), "{}\n");
  writeFileSync(join(haraHome, "config.json"), JSON.stringify({
    provider: "ollama",
    model: "qwen3",
    guardian: "off",
    updateCheck: false,
  }), { mode: 0o600 });

  const childEnv = { ...process.env };
  for (const name of [
    "HARA_PROFILE",
    "HARA_PROVIDER",
    "HARA_MODEL",
    "HARA_BASE_URL",
    "HARA_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "DASHSCOPE_API_KEY",
    "GLM_API_KEY",
    "DEEPSEEK_API_KEY",
    "OPENROUTER_API_KEY",
  ]) delete childEnv[name];
  Object.assign(childEnv, {
    HOME: home,
    USERPROFILE: home,
    HARA_QUIET: "1",
    HARA_UPDATE_CHECK: "0",
    HARA_GUARDIAN: "0",
    NO_COLOR: "1",
  });

  const child = spawn(process.execPath, [
    join(process.cwd(), "dist", "index.js"),
    "serve",
    "--host", "127.0.0.1",
    "--port", String(port),
    "--token", token,
    "--cwd", project,
  ], {
    cwd: project,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const diagnostics = () => `${stdout}\n${stderr}`
    .replaceAll(token, "[REDACTED]")
    .replaceAll(keyA, "[REDACTED]")
    .replaceAll(keyB, "[REDACTED]")
    .trim();

  let client;
  try {
    const discovery = await waitForDiscovery(discoveryPath, child, diagnostics);
    assert.equal(discovery.port, port);
    client = await connect(port);
    const initialized = await client.call("initialize", { token });
    assert.ok(initialized.result.capabilities.methods.includes("settings.providers.connections.create"));

    const initial = await client.call("settings.providers.list", {});
    assert.equal(initial.result.current.profileId, "personal");
    assert.deepEqual(initial.result.connections.map((connection) => connection.id), ["personal"]);

    const createdA = await client.call("settings.providers.connections.create", {
      id: "team-openai-a",
      label: "Team OpenAI A",
      provider: "openai",
      model: "gpt-a",
      apiKey: keyA,
      activate: false,
    });
    assert.equal(createdA.result.connections.find((connection) => connection.id === "team-openai-a").active, false);
    assert.equal(JSON.stringify(createdA).includes(keyA), false, "the first key is never echoed over RPC");

    const createdB = await client.call("settings.providers.connections.create", {
      id: "team-openai-b",
      label: "Team OpenAI B",
      provider: "openai",
      model: "gpt-b",
      apiKey: keyB,
      activate: true,
    });
    assert.equal(createdB.result.current.profileId, "team-openai-b");
    assert.equal(createdB.result.connections.filter((connection) => connection.provider === "openai").length, 2);
    assert.equal(JSON.stringify(createdB).includes(keyB), false, "the second key is never echoed over RPC");

    const stored = JSON.parse(readFileSync(profilesPath, "utf8"));
    assert.equal(stored.active, "team-openai-b");
    assert.equal(stored.profiles.find((profile) => profile.id === "team-openai-a").apiKey, keyA);
    assert.equal(stored.profiles.find((profile) => profile.id === "team-openai-b").apiKey, keyB);
    if (process.platform !== "win32") {
      assert.equal(statSync(profilesPath).mode & 0o777, 0o600, "named credentials stay in the private profile store");
    }

    const duplicate = await client.call("settings.providers.connections.create", {
      id: "team-openai-a",
      label: "Must Not Overwrite",
      provider: "openai",
      model: "gpt-overwrite",
      apiKey: keyB,
      activate: true,
    });
    assert.match(duplicate.error.message, /already exists/);
    assert.equal(JSON.parse(readFileSync(profilesPath, "utf8")).profiles.find((profile) => profile.id === "team-openai-a").apiKey, keyA);

    const usedA = await client.call("settings.providers.connections.use", { id: "team-openai-a" });
    assert.equal(usedA.result.current.profileId, "team-openai-a");
    assert.equal(usedA.result.connections.find((connection) => connection.id === "team-openai-a").active, true);

    const removedB = await client.call("settings.providers.connections.remove", { id: "team-openai-b" });
    assert.equal(removedB.result.connections.some((connection) => connection.id === "team-openai-b"), false);
    assert.equal(removedB.result.current.profileId, "team-openai-a");

    const removedActive = await client.call("settings.providers.connections.remove", { id: "team-openai-a" });
    assert.equal(removedActive.result.current.profileId, "personal");
    assert.deepEqual(removedActive.result.connections.map((connection) => connection.id), ["personal"]);
    assert.equal(readFileSync(profilesPath, "utf8").includes("sk-named-connection"), false);

    const socketClosed = new Promise((resolve) => client.ws.once("close", resolve));
    assert.deepEqual((await client.call("server.shutdown", {})).result, { accepted: true });
    await socketClosed;
    assert.equal(await waitForExit(child), 0, diagnostics());
  } finally {
    client?.close();
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await waitForExit(child).catch(() => child.kill("SIGKILL"));
    }
    rmSync(root, { recursive: true, force: true });
  }
});
