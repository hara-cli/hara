import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadRoles } from "../dist/org/roles.js";
import { latestForCwd } from "../dist/session/store.js";

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
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function gatewayFixture(label, roles = []) {
  const requests = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      requests.push({
        method: req.method,
        url: req.url,
        body: raw,
        authorization: req.headers.authorization,
      });
      if (req.url === "/v1/chat/completions") {
        const body = JSON.parse(raw);
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({
          id: `chatcmpl-${label}`,
          object: "chat.completion.chunk",
          created: 1,
          model: body.model,
          choices: [{ index: 0, delta: { role: "assistant", content: `${label}-reply` }, finish_reason: null }],
        })}\n\n`);
        res.write(`data: ${JSON.stringify({
          id: `chatcmpl-${label}`,
          object: "chat.completion.chunk",
          created: 1,
          model: body.model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        })}\n\n`);
        return res.end("data: [DONE]\n\n");
      }
      if (req.url === "/v1/roles") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ version: 1, roles }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    requests,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("real headless resume keeps its saved organization profile after the active profile changes", { timeout: 20_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "hara-session-profile-cli-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const sessions = join(home, ".hara", "sessions");
  const flash = await gatewayFixture("flash");
  const pro = await gatewayFixture("pro");
  const sessionId = "profile-bound-session";
  const profilesPath = join(home, ".hara", "profiles.json");
  try {
    mkdirSync(sessions, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "package.json"), "{}\n");
    writeFileSync(join(home, ".hara", "config.json"), JSON.stringify({
      provider: "openai",
      apiKey: "personal-fixture-key",
      model: "personal-fixture-model",
      guardian: "off",
      updateCheck: false,
    }));
    const profiles = {
      active: "pro-org",
      profiles: [
        { id: "personal", kind: "byok", label: "Personal", provider: "openai" },
        {
          id: "flash-org",
          kind: "gateway",
          label: "Flash Org",
          gatewayUrl: flash.url,
          baseURL: `${flash.url}/v1`,
          deviceId: "flash-device",
          deviceToken: "flash-device-token",
          defaultModel: "deepseek-v4-flash",
          availableModels: ["deepseek-v4-flash"],
          thinkingEfforts: ["off", "high", "max"],
          enrolledAt: "2026-07-23T00:00:00.000Z",
        },
        {
          id: "pro-org",
          kind: "gateway",
          label: "Pro Org",
          gatewayUrl: pro.url,
          baseURL: `${pro.url}/v1`,
          deviceId: "pro-device",
          deviceToken: "pro-device-token",
          defaultModel: "deepseek-v4-pro",
          availableModels: ["deepseek-v4-pro"],
          thinkingEfforts: ["off", "high", "max"],
          enrolledAt: "2026-07-23T00:00:00.000Z",
        },
      ],
    };
    writeFileSync(profilesPath, `${JSON.stringify(profiles, null, 2)}\n`, { mode: 0o600 });
    writeFileSync(join(sessions, `${sessionId}.json`), JSON.stringify({
      meta: {
        id: sessionId,
        cwd: project,
        profileId: "flash-org",
        provider: "hara-gateway",
        model: "deepseek-v4-flash",
        effort: "high",
        title: "Bound Flash session",
        createdAt: "2026-07-23T00:00:00.000Z",
        updatedAt: "2026-07-23T00:00:00.000Z",
        source: "interactive",
      },
      history: [],
    }));

    const fresh = await runCli(["-p", "use the active profile default"], project, home);
    assert.equal(fresh.code, 0, fresh.stderr || fresh.stdout);
    assert.match(fresh.stdout, /pro-reply/);
    const freshRequest = pro.requests.find((request) => request.url === "/v1/chat/completions");
    assert.ok(freshRequest);
    assert.equal(JSON.parse(freshRequest.body).model, "deepseek-v4-pro");
    flash.requests.length = 0;
    pro.requests.length = 0;

    const forbidden = await runCli(
      ["-p", "must stay scoped", "--resume", sessionId, "--model", "deepseek-v4-pro"],
      project,
      home,
    );
    assert.equal(forbidden.code, 2, forbidden.stderr || forbidden.stdout);
    assert.match(forbidden.stderr + forbidden.stdout, /not authorized for organization connection 'flash-org'/);
    assert.equal(pro.requests.filter((request) => request.url === "/v1/chat/completions").length, 0);

    const resumed = await runCli(["-p", "continue safely", "--resume", sessionId], project, home);
    assert.equal(resumed.code, 0, resumed.stderr || resumed.stdout);
    assert.match(resumed.stdout, /flash-reply/);
    assert.equal(flash.requests.filter((request) => request.url === "/v1/chat/completions").length, 1);
    assert.equal(pro.requests.filter((request) => request.url === "/v1/chat/completions").length, 0);
    assert.ok(flash.requests.some((request) => request.url === "/v1/heartbeat"), "heartbeat follows the saved Flash profile");
    assert.ok(flash.requests.some((request) => request.url === "/v1/roles"), "managed roles follow the saved Flash profile");
    assert.equal(pro.requests.some((request) => request.url === "/v1/heartbeat"), false, "the active Pro profile receives no resumed-session heartbeat");
    assert.equal(pro.requests.some((request) => request.url === "/v1/roles"), false, "the active Pro profile cannot supply managed roles");
    const saved = JSON.parse(readFileSync(join(sessions, `${sessionId}.json`), "utf8"));
    assert.equal(saved.meta.profileId, "flash-org");
    assert.equal(saved.meta.model, "deepseek-v4-flash");

    flash.requests.length = 0;
    const envResumed = await runCli(
      ["-p", "use a one-process override without changing my saved pin", "--resume", sessionId],
      project,
      home,
      { HARA_MODEL: "deepseek-v4-flash-override" },
    );
    assert.equal(envResumed.code, 2, envResumed.stderr || envResumed.stdout);
    assert.match(
      envResumed.stderr + envResumed.stdout,
      /model 'deepseek-v4-flash-override' is not authorized/,
      "an unauthorized process-local override fails closed",
    );
    const afterRejectedEnv = JSON.parse(readFileSync(join(sessions, `${sessionId}.json`), "utf8"));
    assert.equal(afterRejectedEnv.meta.model, "deepseek-v4-flash", "a rejected environment override cannot rewrite the durable pin");

    profiles.profiles.find((profile) => profile.id === "flash-org").availableModels.push("deepseek-v4-flash-override");
    writeFileSync(profilesPath, `${JSON.stringify(profiles, null, 2)}\n`, { mode: 0o600 });
    const allowedEnvResume = await runCli(
      ["-p", "temporarily use the allowed process override", "--resume", sessionId],
      project,
      home,
      { HARA_MODEL: "deepseek-v4-flash-override" },
    );
    assert.equal(allowedEnvResume.code, 0, allowedEnvResume.stderr || allowedEnvResume.stdout);
    const overrideRequest = flash.requests.find((request) =>
      request.url === "/v1/chat/completions" && JSON.parse(request.body).model === "deepseek-v4-flash-override");
    assert.ok(overrideRequest, "the allowed environment model is used for this process");
    const afterAllowedEnv = JSON.parse(readFileSync(join(sessions, `${sessionId}.json`), "utf8"));
    assert.equal(afterAllowedEnv.meta.model, "deepseek-v4-flash", "the temporary environment model does not replace the durable pin");

    const roleStorageKey = createHash("sha256")
      .update("hara-org-roles-v1\0")
      .update("flash-org", "utf8")
      .digest("hex");
    const flashRoles = join(home, ".hara", "org-roles", roleStorageKey);
    mkdirSync(flashRoles, { recursive: true });
    writeFileSync(join(flashRoles, "flash-auditor.md"), [
      "---",
      "name: flash-auditor",
      "description: Audits the Flash organization.",
      "---",
      "",
      "Stay within the Flash organization route.",
      "",
    ].join("\n"));
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      assert.equal(latestForCwd(project)?.meta.profileId, "flash-org");
      assert.ok(loadRoles(project, "flash-org").some((role) => role.id === "flash-auditor"));
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
    const continued = await runCli(
      ["-p", "continue through the managed role", "--continue", "--role", "flash-auditor"],
      project,
      home,
    );
    assert.equal(continued.code, 0, continued.stderr || continued.stdout);
    assert.match(continued.stdout, /flash-reply/);
    assert.equal(flash.requests.filter((request) => request.url === "/v1/chat/completions").length, 2);
    assert.equal(pro.requests.filter((request) => request.url === "/v1/chat/completions").length, 0);

    profiles.profiles = profiles.profiles.filter((profile) => profile.id !== "flash-org");
    writeFileSync(profilesPath, `${JSON.stringify(profiles, null, 2)}\n`, { mode: 0o600 });
    const removed = await runCli(["-p", "do not reroute", "--resume", sessionId], project, home);
    assert.equal(removed.code, 2, removed.stderr || removed.stdout);
    assert.match(removed.stderr + removed.stdout, /profile 'flash-org' is no longer available/);
    assert.equal(pro.requests.filter((request) => request.url === "/v1/chat/completions").length, 0);
  } finally {
    await Promise.all([flash.close(), pro.close()]);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a fresh named-BYOK session uses the temporary provider's default model", { timeout: 20_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "hara-fresh-provider-override-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const haraHome = join(home, ".hara");
  const sessions = join(haraHome, "sessions");
  const local = await gatewayFixture("local");
  try {
    mkdirSync(sessions, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "package.json"), "{}\n");
    writeFileSync(join(haraHome, "config.json"), JSON.stringify({
      provider: "openai",
      apiKey: "personal-fixture-key",
      model: "personal-fixture-model",
      guardian: "off",
      updateCheck: false,
    }));
    writeFileSync(join(haraHome, "profiles.json"), JSON.stringify({
      active: "work",
      profiles: [
        { id: "personal", kind: "byok", label: "Personal", provider: "openai" },
        {
          id: "work",
          kind: "byok",
          label: "Work",
          provider: "deepseek",
          apiKey: "work-only-key",
          baseURL: "https://api.deepseek.com",
          defaultModel: "deepseek-chat",
        },
      ],
    }), { mode: 0o600 });

    const result = await runCli(
      ["-p", "use the temporary local provider", "--continue"],
      project,
      home,
      {
        HARA_PROFILE: "",
        HARA_PROVIDER: "ollama",
        HARA_BASE_URL: `${local.url}/v1`,
        HARA_MODEL: "",
        HARA_API_KEY: "",
      },
    );
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const request = local.requests.find((candidate) => candidate.url === "/v1/chat/completions");
    assert.ok(request);
    assert.equal(JSON.parse(request.body).model, "qwen3", "the temporary Ollama route keeps its own default model");

    const savedFiles = readdirSync(sessions).filter((name) => name.endsWith(".json"));
    assert.equal(savedFiles.length, 1);
    const saved = JSON.parse(readFileSync(join(sessions, savedFiles[0]), "utf8"));
    assert.equal(saved.meta.profileId, "work");
    assert.equal(saved.meta.model, "qwen3", "the new session pins the resolved provider target, not DeepSeek's old default");
  } finally {
    await local.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a legacy invalid active profile fails before creating an unreadable session", { timeout: 10_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "hara-invalid-profile-cli-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const haraHome = join(home, ".hara");
  try {
    mkdirSync(haraHome, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "package.json"), "{}\n");
    writeFileSync(join(haraHome, "config.json"), JSON.stringify({
      provider: "openai",
      apiKey: "fixture-only-key",
      model: "fixture-model",
      guardian: "off",
      updateCheck: false,
    }));
    writeFileSync(join(haraHome, "profiles.json"), JSON.stringify({
      active: "legacy\\profile",
      profiles: [
        { id: "personal", kind: "byok", label: "Personal", provider: "openai" },
        {
          id: "legacy\\profile",
          kind: "byok",
          label: "Legacy invalid profile",
          provider: "openai",
          apiKey: "fixture-only-key",
          defaultModel: "fixture-model",
        },
      ],
    }), { mode: 0o600 });

    const result = await runCli(["-p", "must fail before provider traffic"], project, home);
    assert.equal(result.code, 2, result.stderr || result.stdout);
    assert.match(result.stderr + result.stdout, /legacy invalid id/);
    assert.equal(
      readFileSync(join(haraHome, "profiles.json"), "utf8").includes("legacy\\\\profile"),
      true,
      "the CLI reports the migration boundary without silently renaming stored identities",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a legacy interactive resume persists its exact profile binding before the first turn", { timeout: 10_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "hara-legacy-session-profile-cli-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const haraHome = join(home, ".hara");
  const sessions = join(haraHome, "sessions");
  const sessionId = "legacy-unbound-session";
  try {
    mkdirSync(sessions, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "AGENTS.md"), "# Fixture\n");
    writeFileSync(join(haraHome, "config.json"), JSON.stringify({
      provider: "openai",
      apiKey: "fixture-only-key",
      model: "fixture-model",
      guardian: "off",
      updateCheck: false,
    }));
    writeFileSync(join(haraHome, "profiles.json"), JSON.stringify({
      active: "personal",
      profiles: [
        {
          id: "personal",
          kind: "byok",
          label: "Personal",
          provider: "openai",
          apiKey: "fixture-only-key",
          defaultModel: "fixture-model",
        },
      ],
    }), { mode: 0o600 });
    writeFileSync(join(sessions, `${sessionId}.json`), JSON.stringify({
      meta: {
        id: sessionId,
        cwd: project,
        provider: "openai",
        model: "fixture-model",
        title: "Legacy unbound session",
        createdAt: "2026-07-23T00:00:00.000Z",
        updatedAt: "2026-07-23T00:00:00.000Z",
        source: "interactive",
      },
      history: [],
    }));

    const opened = await runCli(["--resume", sessionId], project, home);
    assert.equal(opened.code, 0, opened.stderr || opened.stdout);
    const saved = JSON.parse(readFileSync(join(sessions, `${sessionId}.json`), "utf8"));
    assert.equal(saved.meta.profileId, "personal");
    assert.deepEqual(saved.history, [], "opening and exiting adds no synthetic turn");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the first explicit managed-role run seeds the exact profile-scoped bundle", { timeout: 20_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "hara-first-role-profile-cli-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const haraHome = join(home, ".hara");
  const gateway = await gatewayFixture("role", [{
    name: "release-auditor",
    description: "Checks the release route.",
    system: "You are the exact organization release auditor.",
  }]);
  try {
    mkdirSync(haraHome, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "package.json"), "{}\n");
    writeFileSync(join(haraHome, "config.json"), JSON.stringify({
      provider: "openai",
      apiKey: "personal-fixture-key",
      model: "personal-fixture-model",
      guardian: "off",
      updateCheck: false,
    }));
    writeFileSync(join(haraHome, "profiles.json"), JSON.stringify({
      active: "release-org",
      profiles: [
        { id: "personal", kind: "byok", label: "Personal", provider: "openai" },
        {
          id: "release-org",
          kind: "gateway",
          label: "Release Org",
          gatewayUrl: gateway.url,
          baseURL: `${gateway.url}/v1`,
          deviceId: "release-device",
          deviceToken: "release-device-token",
          defaultModel: "deepseek-v4-pro",
          availableModels: ["deepseek-v4-pro"],
          thinkingEfforts: ["off", "high", "max"],
          enrolledAt: "2026-07-23T00:00:00.000Z",
        },
      ],
    }), { mode: 0o600 });

    const result = await runCli(
      ["-p", "audit this release", "--role", "release-auditor"],
      project,
      home,
    );
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /role-reply/);
    const roleRequest = gateway.requests.find((request) => request.url === "/v1/roles");
    assert.ok(roleRequest, "the missing scoped directory triggers a first-use role sync");
    assert.equal(roleRequest.authorization, "Bearer release-device-token");
    const chatRequest = gateway.requests.find((request) => request.url === "/v1/chat/completions");
    assert.ok(chatRequest);
    assert.match(chatRequest.body, /exact organization release auditor/);
  } finally {
    await gateway.close();
    rmSync(root, { recursive: true, force: true });
  }
});
