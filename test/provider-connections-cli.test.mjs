import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import WebSocket from "ws";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function reservePort() {
  const server = createNetServer();
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

async function providerFixture() {
  const requests = [];
  const server = createHttpServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        body: raw,
      });
      if (request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ object: "list", data: [{ id: "gpt-a", object: "model" }, { id: "gpt-b", object: "model" }] }));
        return;
      }
      if (request.url === "/v1/chat/completions") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({
          id: "chatcmpl-provider-test",
          object: "chat.completion.chunk",
          created: 1,
          model: "gpt-a",
          choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
        })}\n\n`);
        response.write(`data: ${JSON.stringify({
          id: "chatcmpl-provider-test",
          object: "chat.completion.chunk",
          created: 1,
          model: "gpt-a",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })}\n\n`);
        response.end("data: [DONE]\n\n");
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not found" }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    requests,
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
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

test("real serve keeps multiple accounts from the same provider independent and redacted", { timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "hara-provider-connections-cli-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const haraHome = join(home, ".hara");
  const discoveryPath = join(haraHome, "serve.json");
  const profilesPath = join(haraHome, "profiles.json");
  const token = "provider-connections-test-token";
  const keyA = "sk-named-connection-a-1111";
  const keyB = "sk-named-connection-b-2222";
  const keyC = "sk-named-connection-c-3333";
  const personalVisionKey = "sk-personal-vision-4444";
  const port = await reservePort();
  const provider = await providerFixture();
  mkdirSync(haraHome, { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "package.json"), "{}\n");
  const legacyVisionImage = join(project, "legacy-vision.png");
  writeFileSync(legacyVisionImage, Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ));
  writeFileSync(join(haraHome, "config.json"), JSON.stringify({
    provider: "ollama",
    model: "qwen3",
    visionModel: "gpt-4o-mini",
    visionSource: "custom",
    visionProvider: "openai",
    visionBaseURL: provider.baseURL,
    visionApiKey: personalVisionKey,
    guardian: "off",
    updateCheck: false,
  }), { mode: 0o600 });
  writeFileSync(profilesPath, `${JSON.stringify({
    active: "legacy-openai",
    profiles: [
      { id: "personal", kind: "byok", label: "Personal", provider: "ollama", defaultModel: "qwen3" },
      {
        id: "legacy-openai",
        kind: "byok",
        label: "Legacy OpenAI",
        provider: "openai",
        model: "gpt-a",
        defaultModel: "gpt-a",
        baseURL: provider.baseURL,
        apiKey: keyA,
        // 0.164.2 and earlier could persist an independent OpenAI-compatible vision route without
        // the provider/protocol adapter. It must remain usable after upgrade, not merely editable.
        visionModel: "gpt-4o-mini",
        visionSource: "custom",
        visionBaseURL: provider.baseURL,
        visionApiKey: keyA,
      },
    ],
  }, null, 2)}\n`, { mode: 0o600 });

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
    .replaceAll(keyC, "[REDACTED]")
    .replaceAll(personalVisionKey, "[REDACTED]")
    .trim();

  let client;
  try {
    const discovery = await waitForDiscovery(discoveryPath, child, diagnostics);
    assert.equal(discovery.port, port);
    client = await connect(port);
    const initialized = await client.call("initialize", { token });
    assert.ok(initialized.result.capabilities.methods.includes("settings.providers.connections.create"));

    const initial = await client.call("settings.providers.list", {});
    assert.equal(initial.result.current.profileId, "legacy-openai");
    assert.deepEqual(initial.result.connections.map((connection) => connection.id), ["personal", "legacy-openai"]);
    assert.equal(initial.result.connections.find((connection) => connection.id === "personal").removable, true);
    assert.equal(initial.result.connections.find((connection) => connection.id === "legacy-openai").active, true);
    assert.equal(JSON.stringify(initial).includes(keyA), false, "the legacy current key is never echoed over RPC");
    assert.equal(initial.result.vision.provider, "openai", "a legacy route infers the generic compatible adapter");
    assert.equal(initial.result.vision.model, "gpt-4o-mini");

    provider.requests.length = 0;
    const legacySession = (await client.call("session.create", {})).result.sessionId;
    const legacyVisionTurn = await client.call("session.send", {
      sessionId: legacySession,
      text: "What is in this image?",
      images: [{ path: legacyVisionImage, mediaType: "image/png" }],
    });
    assert.equal(legacyVisionTurn.error, undefined, legacyVisionTurn.error?.message);
    const legacyBodies = provider.requests
      .filter((request) => request.url === "/v1/chat/completions")
      .map((request) => JSON.parse(request.body));
    assert.equal(legacyBodies.length, 2, "the recovered vision adapter runs before the conversation model");
    assert.equal(legacyBodies[0].model, "gpt-4o-mini");
    assert.match(JSON.stringify(legacyBodies[0]), /data:image\/png;base64,/);
    assert.equal(legacyBodies[1].model, "gpt-a");
    assert.doesNotMatch(JSON.stringify(legacyBodies[1]), /data:image\/png;base64,/,
      "the conversation model receives the vision model's text instead of the image bytes");

    const savedLegacyVision = await client.call("settings.vision.save", {
      enabled: true,
      source: "custom",
      provider: "openai",
      model: "gpt-4o-mini",
      baseURL: provider.baseURL,
    });
    assert.equal(savedLegacyVision.error, undefined, savedLegacyVision.error?.message);
    const legacyAfterSave = JSON.parse(readFileSync(profilesPath, "utf8"))
      .profiles.find((profile) => profile.id === "legacy-openai");
    assert.equal(legacyAfterSave.visionProvider, "openai");
    assert.equal(legacyAfterSave.visionApiKey, keyA,
      "saving an inferred legacy route keeps its credential without asking the user to re-enter it");

    const usedPersonal = await client.call("settings.providers.connections.use", { id: "personal" });
    assert.equal(usedPersonal.error, undefined, usedPersonal.error?.message);
    assert.equal(usedPersonal.result.current.profileId, "personal");
    const removedPersonal = await client.call("settings.providers.connections.remove", { id: "personal" });
    assert.equal(removedPersonal.error, undefined, removedPersonal.error?.message);
    assert.equal(removedPersonal.result.current.profileId, "personal",
      "deleting the active connection keeps the empty Personal identity boundary selected");
    assert.deepEqual(removedPersonal.result.connections.map((connection) => connection.id), ["legacy-openai"],
      "the reserved Personal identity is not advertised as a saved connection after its route is deleted");
    const clearedPersonal = JSON.parse(readFileSync(join(haraHome, "config.json"), "utf8"));
    for (const key of [
      "provider", "model", "baseURL", "apiKey", "reasoningEffort",
      "visionModel", "visionSource", "visionProvider", "visionBaseURL", "visionApiKey",
    ]) {
      assert.equal(Object.hasOwn(clearedPersonal, key), false, `${key} is removed with the Personal connection`);
    }
    const storedAfterPersonalRemoval = readFileSync(profilesPath, "utf8");
    assert.equal(storedAfterPersonalRemoval.includes(personalVisionKey), false,
      "the deleted Personal vision credential is not retained in compatibility storage");
    const restoredLegacy = await client.call("settings.providers.connections.use", { id: "legacy-openai" });
    assert.equal(restoredLegacy.error, undefined, restoredLegacy.error?.message);
    assert.equal(restoredLegacy.result.current.profileId, "legacy-openai");

    const createdA = await client.call("settings.providers.connections.create", {
      id: "team-openai-a",
      label: "Team OpenAI A",
      provider: "openai",
      model: "gpt-5.1",
      baseURL: provider.baseURL,
      apiKey: keyB,
      reasoningEffort: "high",
      activate: false,
    });
    assert.equal(createdA.result.current.profileId, "legacy-openai", "saving without switching preserves the active account");
    assert.equal(createdA.result.connections.find((connection) => connection.id === "team-openai-a").active, false);
    assert.equal(createdA.result.connections.find((connection) => connection.id === "team-openai-a").reasoningEffort, "high");
    assert.equal(JSON.stringify(createdA).includes(keyB), false, "the first new key is never echoed over RPC");

    const createdB = await client.call("settings.providers.connections.create", {
      id: "team-openai-b",
      label: "Team OpenAI B",
      provider: "openai",
      model: "gpt-5.1",
      baseURL: provider.baseURL,
      apiKey: keyC,
      reasoningEffort: "low",
      activate: true,
    });
    assert.equal(createdB.result.current.profileId, "team-openai-b");
    assert.equal(createdB.result.connections.filter((connection) => connection.provider === "openai").length, 3);
    assert.equal(createdB.result.connections.find((connection) => connection.id === "team-openai-b").reasoningEffort, "low");
    assert.equal(JSON.stringify(createdB).includes(keyC), false, "the second new key is never echoed over RPC");

    const stored = JSON.parse(readFileSync(profilesPath, "utf8"));
    assert.equal(stored.active, "team-openai-b");
    assert.deepEqual(stored.profiles.map((profile) => profile.id), ["personal", "legacy-openai", "team-openai-a", "team-openai-b"]);
    assert.equal(stored.profiles.find((profile) => profile.id === "team-openai-a").apiKey, keyB);
    assert.equal(stored.profiles.find((profile) => profile.id === "team-openai-b").apiKey, keyC);
    assert.equal(stored.profiles.find((profile) => profile.id === "team-openai-a").reasoningEffort, "high");
    assert.equal(stored.profiles.find((profile) => profile.id === "team-openai-b").reasoningEffort, "low");
    if (process.platform !== "win32") {
      assert.equal(statSync(profilesPath).mode & 0o777, 0o600, "named credentials stay in the private profile store");
    }

    provider.requests.length = 0;
    const testedA = await client.call("settings.providers.connections.test", { id: "team-openai-a" });
    assert.equal(testedA.result.ok, true);
    assert.deepEqual(testedA.result.models, ["gpt-a", "gpt-b"]);
    assert.ok(provider.requests.length >= 2, "saved-connection testing probes models and a completion");
    assert.ok(
      provider.requests.every((request) => request.authorization === `Bearer ${keyB}`),
      "testing account A uses only A's credential even while account B is active",
    );
    assert.equal(JSON.stringify(testedA).includes(keyB), false, "saved-connection testing never echoes its key");

    const withoutKey = await client.call("settings.providers.connections.create", {
      id: "team-openai-no-key",
      label: "Must Not Borrow Another Account",
      provider: "openai",
      model: "gpt-a",
      baseURL: provider.baseURL,
      activate: false,
    });
    assert.match(withoutKey.error.message, /new API key is required/);

    const duplicate = await client.call("settings.providers.connections.create", {
      id: "team-openai-a",
      label: "Must Not Overwrite",
      provider: "openai",
      model: "gpt-a",
      baseURL: provider.baseURL,
      apiKey: keyC,
      activate: true,
    });
    assert.match(duplicate.error.message, /already exists/);
    assert.equal(JSON.parse(readFileSync(profilesPath, "utf8")).profiles.find((profile) => profile.id === "team-openai-a").apiKey, keyB);

    const usedA = await client.call("settings.providers.connections.use", { id: "team-openai-a" });
    assert.equal(usedA.result.current.profileId, "team-openai-a");
    assert.equal(usedA.result.connections.find((connection) => connection.id === "team-openai-a").active, true);

    const removedB = await client.call("settings.providers.connections.remove", { id: "team-openai-b" });
    assert.equal(removedB.result.connections.some((connection) => connection.id === "team-openai-b"), false);
    assert.equal(removedB.result.current.profileId, "team-openai-a");

    const removedA = await client.call("settings.providers.connections.remove", { id: "team-openai-a" });
    assert.equal(removedA.result.current.profileId, "personal");
    assert.deepEqual(removedA.result.connections.map((connection) => connection.id), ["legacy-openai"]);
    const remainingProfiles = readFileSync(profilesPath, "utf8");
    assert.equal(remainingProfiles.includes(keyB), false);
    assert.equal(remainingProfiles.includes(keyC), false);
    assert.equal(remainingProfiles.includes(keyA), true, "removing new accounts does not delete an older independent account");

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
    await provider.close();
    rmSync(root, { recursive: true, force: true });
  }
});
