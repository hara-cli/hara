import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

function listenModel(reply) {
  const requests = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      requests.push({ url: req.url, authorization: req.headers.authorization, body: JSON.parse(raw) });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-role-home",
          object: "chat.completion.chunk",
          created: 1,
          model: "role-model",
          choices: [{ index: 0, delta: { role: "assistant", content: reply }, finish_reason: null }],
        })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-role-home",
          object: "chat.completion.chunk",
          created: 1,
          model: "role-model",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
        })}\n\n`,
      );
      res.end("data: [DONE]\n\n");
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

function runCli(args, cwd, home, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      HOME: home,
      HARA_QUIET: "1",
      HARA_UPDATE_CHECK: "0",
      HARA_GUARDIAN: "0",
      HARA_TRUST_PROJECT_CONFIG: "1", // fixture project routing/MCP is intentionally trusted in this test
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
      "HARA_ALLOW_TRUSTED_EXTENSIONS",
    ]) delete env[key];
    Object.assign(env, extraEnv);
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

test("headless project:name builds provider/persona at the registered home and rejects a foreign resume", async () => {
  const root = mkdtempSync(join(tmpdir(), "hara-headless-role-home-"));
  const home = join(root, "home");
  const launcher = join(root, "launcher");
  const project = join(root, "target");
  const foreign = join(root, "foreign");
  const userMcpMarker = join(root, "user-mcp-started");
  const pluginMcpMarker = join(root, "plugin-mcp-started");
  const mcpFixture = pathToFileURL(join(process.cwd(), "test", "fixtures", "mcp-echo-server.mjs")).href;
  const markedMcp = (marker) => ({
    command: process.execPath,
    args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "started"); import(${JSON.stringify(mcpFixture)})`],
  });
  const targetApi = await listenModel("TARGET_HOME_OK");
  const globalApi = await listenModel("GLOBAL_ROLE_OK");
  try {
    mkdirSync(join(home, ".hara", "sessions"), { recursive: true });
    mkdirSync(join(home, ".hara", "roles"), { recursive: true });
    mkdirSync(join(home, ".hara", "plugins", "side-effect", ".hara-plugin"), { recursive: true });
    mkdirSync(join(project, ".hara", "roles"), { recursive: true });
    mkdirSync(launcher, { recursive: true });
    mkdirSync(foreign, { recursive: true });
    writeFileSync(join(launcher, "package.json"), "{}\n");
    writeFileSync(join(project, "package.json"), "{}\n");
    writeFileSync(join(foreign, "package.json"), "{}\n");
    writeFileSync(
      join(home, ".hara", "config.json"),
      JSON.stringify({ provider: "openai", apiKey: "global-key", model: "global-model", baseURL: globalApi.baseURL, guardian: "off", updateCheck: false }),
    );
    writeFileSync(
      join(project, ".hara", "config.json"),
      JSON.stringify({
        provider: "openai",
        apiKey: "project-key",
        model: "project-model",
        baseURL: targetApi.baseURL,
        guardian: "off",
        updateCheck: false,
        mcpServers: { userSideEffect: markedMcp(userMcpMarker) },
      }),
    );
    writeFileSync(
      join(home, ".hara", "plugins", "side-effect", ".hara-plugin", "plugin.json"),
      JSON.stringify({ name: "side-effect", version: "1.0.0", mcpServers: { pluginSideEffect: markedMcp(pluginMcpMarker) } }),
    );
    writeFileSync(
      join(project, ".hara", "roles", "auditor.md"),
      "---\nname: auditor\ndescription: target auditor\nmodel: role-model\nallowTools: [read_file, grep]\nreadOnly: true\n---\nTARGET ROLE PERSONA\n",
    );
    writeFileSync(
      join(project, ".hara", "roles", "writer.md"),
      "---\nname: writer\ndescription: target writer\nmodel: role-model\n---\nTARGET WRITER PERSONA\n",
    );
    writeFileSync(
      join(home, ".hara", "roles", "portable.md"),
      "---\nname: portable\ndescription: portable global reviewer\nmodel: global-role-model\nreadOnly: true\n---\nGLOBAL ROLE PERSONA\n",
    );
    writeFileSync(join(home, ".hara", "projects.json"), JSON.stringify({ projects: [{ name: "target", path: project }] }));

    const ok = await runCli(["-p", "identify your execution home", "--role", "target:auditor"], launcher, home);
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.stdout, /TARGET_HOME_OK/);
    assert.equal(globalApi.requests.length, 0, "the launcher/global route is never contacted");
    assert.equal(targetApi.requests.length, 1);
    assert.equal(targetApi.requests[0].url, "/v1/chat/completions");
    assert.equal(targetApi.requests[0].authorization, "Bearer project-key");
    assert.equal(targetApi.requests[0].body.model, "role-model", "the role model overlays the target home's live provider config");
    assert.match(JSON.stringify(targetApi.requests[0].body.messages), /TARGET ROLE PERSONA/);
    assert.equal(existsSync(userMcpMarker), false, "a read-only role never starts a user-configured MCP subprocess");
    assert.equal(existsSync(pluginMcpMarker), false, "a read-only role never starts a plugin-contributed MCP subprocess");

    const global = await runCli(["-p", "identify the global persona", "--role", "global:portable"], launcher, home);
    assert.equal(global.code, 0, global.stderr);
    assert.match(global.stdout, /GLOBAL_ROLE_OK/);
    assert.equal(targetApi.requests.length, 1, "an explicit global role stays in the caller's current project");
    assert.equal(globalApi.requests.length, 1);
    assert.equal(globalApi.requests[0].authorization, "Bearer global-key");
    assert.equal(globalApi.requests[0].body.model, "global-role-model");
    assert.match(JSON.stringify(globalApi.requests[0].body.messages), /GLOBAL ROLE PERSONA/);
    assert.equal(existsSync(pluginMcpMarker), false, "a global read-only role also skips plugin MCP subprocesses");

    const missing = await runCli(["-p", "do not run", "--role", "missing-role"], launcher, home);
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /no agent 'missing-role'/i);
    assert.equal(existsSync(pluginMcpMarker), false, "an unknown role fails before plugin MCP startup");
    assert.equal(globalApi.requests.length, 1, "an unknown role fails before any model request");

    const writable = await runCli(["-p", "use the writable persona", "--role", "target:writer"], launcher, home);
    assert.equal(writable.code, 0, writable.stderr);
    assert.match(writable.stdout, /TARGET_HOME_OK/);
    assert.equal(existsSync(userMcpMarker), false, "headless roles skip user MCP subprocesses by default");
    assert.equal(existsSync(pluginMcpMarker), false, "headless roles skip plugin MCP subprocesses by default");

    const trusted = await runCli(
      ["-p", "use trusted extensions", "--role", "target:writer"],
      launcher,
      home,
      { HARA_ALLOW_TRUSTED_EXTENSIONS: "1" },
    );
    assert.equal(trusted.code, 0, trusted.stderr);
    assert.match(trusted.stdout, /TARGET_HOME_OK/);
    assert.equal(existsSync(userMcpMarker), true, "launch-time trusted-extension opt-in enables user MCP subprocesses");
    assert.equal(existsSync(pluginMcpMarker), true, "launch-time trusted-extension opt-in enables plugin MCP subprocesses");

    const foreignId = "foreign-session";
    writeFileSync(
      join(home, ".hara", "sessions", `${foreignId}.json`),
      JSON.stringify({
        meta: {
          id: foreignId,
          cwd: foreign,
          provider: "openai",
          model: "foreign-model",
          title: "foreign",
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        },
        history: [],
      }),
    );
    const rejected = await runCli(["-p", "do not run", "--role", "target:auditor", "--resume", foreignId], launcher, home);
    assert.equal(rejected.code, 2);
    assert.match(rejected.stderr, /belongs to .*foreign.*refusing to resume/i);
    assert.equal(targetApi.requests.length, 3, "foreign history is rejected before any model request");

    const crossHome = await runCli(["-p", "do not run", "--resume", foreignId], launcher, home);
    assert.equal(crossHome.code, 2);
    assert.match(crossHome.stderr, /belongs to .*foreign.*refusing to resume across project homes/i);
    assert.equal(globalApi.requests.length, 1, "ordinary resumes also reject a foreign execution home before any model request");

    const corruptId = "corrupt-session";
    const corruptPath = join(home, ".hara", "sessions", `${corruptId}.json`);
    writeFileSync(corruptPath, "{ preserve this broken transcript");
    const corrupt = await runCli(["-p", "do not overwrite", "--resume", corruptId], launcher, home);
    assert.equal(corrupt.code, 2);
    assert.match(corrupt.stderr, /unreadable or corrupt; refusing to overwrite/i);
    assert.equal(globalApi.requests.length, 1, "corrupt history is rejected before any model request");
    assert.equal(readFileSync(corruptPath, "utf8"), "{ preserve this broken transcript");
  } finally {
    await Promise.all([
      new Promise((resolve) => targetApi.server.close(resolve)),
      new Promise((resolve) => globalApi.server.close(resolve)),
    ]);
    rmSync(root, { recursive: true, force: true });
  }
});
