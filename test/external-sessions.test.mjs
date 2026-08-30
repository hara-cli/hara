import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ClaudeAgentSdkAdapter } from "../dist/external-sessions/claude.js";
import { CodexAppServerAdapter } from "../dist/external-sessions/codex.js";
import { ExternalSessionRegistry } from "../dist/external-sessions/registry.js";
import {
  JsonlRpcClient,
  probeExternalCommand,
  resolveExternalCommand,
} from "../dist/external-sessions/process.js";

test("external command discovery rejects relative PATH roots and finds a versioned NVM install", () => {
  const root = mkdtempSync(join(tmpdir(), "hara-external-command-"));
  try {
    const home = join(root, "home");
    const executable = join(home, ".nvm", "versions", "node", "v22.23.1", "bin", "codex");
    mkdirSync(join(executable, ".."), { recursive: true });
    writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    chmodSync(executable, 0o755);
    const projectLookalike = join(root, "project", "node_modules", ".bin", "codex");
    mkdirSync(join(projectLookalike, ".."), { recursive: true });
    writeFileSync(projectLookalike, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    chmodSync(projectLookalike, 0o755);

    assert.equal(
      resolveExternalCommand("codex", { PATH: `${join(projectLookalike, "..")}:/absolute/untrusted` }, home),
      realpathSync(executable),
      "an absolute project PATH entry cannot shadow a bounded user runtime install",
    );
    assert.equal(resolveExternalCommand("./codex", { PATH: root }, home), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex discovery accepts only the explicit macOS app-bundle locations", {
  skip: process.platform !== "darwin" ? "macOS bundle discovery" : false,
}, () => {
  const installed = [
    "/Applications/Codex.app/Contents/Resources/codex",
    "/Applications/ChatGPT.app/Contents/Resources/codex",
  ].find((candidate) => existsSync(candidate));
  if (installed) {
    assert.equal(
      resolveExternalCommand("codex", { PATH: "" }, join(tmpdir(), "hara-no-user-runtime")),
      realpathSync(installed),
      "the fixture ignores real user runtimes and resolves only an allowlisted application bundle",
    );
  }
});

test("an explicit CLI prepends its verified sibling runtime directory", {
  skip: process.platform === "win32" ? "POSIX executable fixture" : false,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "hara-external-runtime-"));
  try {
    const runtimeBin = join(root, "bin");
    const executable = join(runtimeBin, "fixture-cli");
    mkdirSync(runtimeBin, { recursive: true });
    writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    chmodSync(executable, 0o755);

    let childPath = "";
    const result = await probeExternalCommand({
      command: executable,
      env: { PATH: "/bin:/usr/bin" },
      // The full release suite starts many real child-process fixtures in parallel. Keep this
      // PATH-order assertion bounded without turning transient process-launch pressure into a flake.
      timeoutMs: 10_000,
      spawnProcess(command, args, options) {
        childPath = String(options.env?.PATH ?? "");
        return spawn(command, [...args], options);
      },
    });
    assert.deepEqual(result, { installed: true });
    assert.equal(childPath.split(":")[0], runtimeBin);
    assert.equal(childPath.split(":").filter((entry) => entry === runtimeBin).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a timed-out App Server request closes the uncertain provider process", {
  skip: process.platform === "win32" ? "POSIX process liveness probe" : false,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "hara-external-timeout-"));
  let client;
  try {
    const fixture = join(root, "silent-app-server.mjs");
    const pidFile = join(root, "pid");
    writeFileSync(fixture, `
      import { writeFileSync } from "node:fs";
      import { createInterface } from "node:readline";
      writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      createInterface({ input: process.stdin }).on("line", () => {});
    `);
    client = JsonlRpcClient.start({
      command: process.execPath,
      argsPrefix: [fixture],
      timeoutMs: 500,
    });
    await assert.rejects(client.call("thread/list"), /request timed out/);
    const pid = Number(readFileSync(pidFile, "utf8"));
    assert.ok(Number.isSafeInteger(pid) && pid > 1);
    let alive = true;
    for (let attempt = 0; attempt < 40 && alive; attempt += 1) {
      try {
        process.kill(pid, 0);
        await new Promise((resolve) => setTimeout(resolve, 25));
      } catch (error) {
        alive = error?.code === "EPERM";
      }
    }
    assert.equal(alive, false, "the timed-out provider process must not remain alive");
  } finally {
    client?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex App Server metadata is normalized and provider cursors remain server-owned", async () => {
  const root = mkdtempSync(join(tmpdir(), "hara-external-codex-"));
  try {
    const fixture = join(root, "fake-codex.mjs");
    writeFileSync(fixture, `
      import { createInterface } from "node:readline";
      if (process.argv.includes("--version")) {
        process.stdout.write("codex-cli 9.9.9\\n");
      } else {
        const lines = createInterface({ input: process.stdin });
        lines.on("line", (line) => {
          const request = JSON.parse(line);
          if (request.method === "initialize") {
            process.stdout.write(JSON.stringify({ id: request.id, result: { userAgent: "fixture" } }) + "\\n");
          }
          if (request.method === "thread/list") {
            const second = request.params?.cursor === "provider-secret-cursor";
            const data = second ? [{
              id: "019-provider-native-second",
              name: null,
              preview: "second confidential prompt",
              path: "/Users/example/.codex/sessions/private.jsonl",
              cwd: "/Users/example/work/second-project",
              createdAt: 1_780_000_000,
              updatedAt: 1_780_000_020,
              status: { type: "idle" },
              source: "vscode",
              ephemeral: false
            }] : [{
              id: "019-provider-native-first",
              name: "Release audit",
              preview: "first confidential prompt",
              path: "/Users/example/.codex/sessions/private.jsonl",
              cwd: "/Users/example/work/secret-project",
              createdAt: 1_780_000_000,
              updatedAt: 1_780_000_010,
              status: { type: "active", activeFlags: ["waitingOnApproval"] },
              source: "cli",
              ephemeral: false
            }];
            process.stdout.write(JSON.stringify({
              id: request.id,
              result: { data, nextCursor: second ? null : "provider-secret-cursor" }
            }) + "\\n");
          }
        });
      }
    `);

    const registry = new ExternalSessionRegistry({
      haraVersion: "0.0.0-test",
      identityHome: root,
      codex: { command: process.execPath, argsPrefix: [fixture], timeoutMs: 3_000 },
      claude: { command: "definitely-missing-claude-test-command", timeoutMs: 500 },
    });
    const first = await registry.listSessions({ sourceId: "codex", limit: 1 });
    assert.deepEqual(first.sources.map((source) => source.id), ["codex", "claude"]);
    assert.equal(first.sessions.length, 1);
    assert.equal(first.sessions[0].title, "Release audit");
    assert.equal(first.sessions[0].workspaceName, "secret-project");
    assert.equal(first.sessions[0].state, "waiting");
    assert.match(first.sessions[0].id, /^ext_codex_[a-f0-9]{24}$/);
    assert.match(first.sessions[0].workspaceId, /^ws_[a-f0-9]{24}$/);
    assert.match(first.page.nextCursor, /^extcur_/);
    assert.notEqual(first.page.nextCursor, "provider-secret-cursor");

    const serialized = JSON.stringify(first);
    assert.doesNotMatch(serialized, /019-provider-native|\/Users\/example\/work|confidential prompt|private\.jsonl|provider-secret-cursor/);

    const second = await registry.listSessions({
      sourceId: "codex",
      limit: 1,
      cursor: first.page.nextCursor,
    });
    assert.equal(second.sessions.length, 1);
    assert.equal(second.sessions[0].workspaceName, "second-project");
    assert.equal(second.page.hasMore, false);
    await assert.rejects(
      registry.listSessions({ sourceId: "codex", limit: 1, cursor: first.page.nextCursor }),
      /invalid or expired/,
      "opaque cursors are one-use leases, not reusable provider handles",
    );

    const restartedRegistry = new ExternalSessionRegistry({
      haraVersion: "0.0.0-test",
      identityHome: root,
      codex: { command: process.execPath, argsPrefix: [fixture], timeoutMs: 3_000 },
      claude: { command: "definitely-missing-claude-test-command", timeoutMs: 500 },
    });
    const afterRestart = await restartedRegistry.listSessions({ sourceId: "codex", limit: 1 });
    assert.equal(
      afterRestart.sessions[0].workspaceId,
      first.sessions[0].workspaceId,
      "workspace digests remain stable on one device without exposing local paths",
    );
    assert.equal(afterRestart.sessions[0].id, first.sessions[0].id);

    const identityPath = join(root, ".hara", "external-sessions", "identity.json");
    assert.equal(statSync(identityPath).mode & 0o777, 0o600);
    const identityFile = readFileSync(identityPath, "utf8");
    assert.doesNotMatch(identityFile, /019-provider-native|\/Users\/example\/work|secret-project/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex official runtime supports bounded read, safety fork, approval, streaming, and interrupt-safe completion", async () => {
  const root = mkdtempSync(join(tmpdir(), "hara-external-codex-turn-"));
  try {
    const fixture = join(root, "fake-codex-turn.mjs");
    writeFileSync(fixture, `
      import { createInterface } from "node:readline";
      if (process.argv.includes("--version")) {
        process.stdout.write("codex-cli 9.9.9\\n");
      } else {
        const lines = createInterface({ input: process.stdin });
        const reply = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + "\\n");
        lines.on("line", (line) => {
          const request = JSON.parse(line);
          if (request.method === "initialize") reply(request.id, { userAgent: "fixture" });
          if (request.method === "thread/list") reply(request.id, { data: [{
            id: "native-source", name: "Source", cwd: "/workspace/private-project",
            createdAt: 1780000000, updatedAt: 1780000010, status: { type: "idle" },
            source: "cli", ephemeral: false
          }], nextCursor: null });
          if (request.method === "thread/read") {
            process.stdout.write(JSON.stringify({ id: request.id, result: { thread: {
              id: request.params.threadId,
              turns: [{ items: [{ id: "unbounded-tool-output", type: "commandExecution", aggregatedOutput: "x".repeat(17 * 1024 * 1024) }] }]
            } } }) + "\\n");
          }
          if (request.method === "thread/turns/list") reply(request.id, {
            data: [{ items: [
              { id: "native-user-item", type: "userMessage", content: [{ type: "text", text: "hello" }] },
              { id: "native-agent-item", type: "agentMessage", text: "prior answer" }
            ] }],
            nextCursor: "provider-private-turn-cursor",
            backwardsCursor: "provider-private-backwards-cursor"
          });
          if (request.method === "thread/fork") reply(request.id, { thread: {
            id: "native-fork", cwd: "/workspace/private-project", name: "Source fork",
            createdAt: 1780000000, updatedAt: 1780000020, status: { type: "idle" }, source: "appServer",
            turns: []
          } });
          if (request.method === "thread/resume") reply(request.id, { thread: { id: request.params.threadId } });
          if (request.method === "turn/start") {
            reply(request.id, { turn: { id: "native-turn" } });
            process.stdout.write(JSON.stringify({
              id: "approval-native", method: "item/commandExecution/requestApproval",
              params: { command: "npm test" }
            }) + "\\n");
          }
          if (request.id === "approval-native" && request.result?.decision === "accept") {
            process.stdout.write(JSON.stringify({ method: "item/agentMessage/delta", params: { delta: "hello " } }) + "\\n");
            process.stdout.write(JSON.stringify({ method: "item/agentMessage/delta", params: { delta: "world" } }) + "\\n");
            process.stdout.write(JSON.stringify({ method: "turn/completed", params: { turn: { status: "completed" } } }) + "\\n");
          }
        });
      }
    `);
    const added = [];
    const adapter = new CodexAppServerAdapter({
      command: process.execPath,
      argsPrefix: [fixture],
      timeoutMs: 3_000,
      haraVersion: "0.0.0-test",
      identityKey: Buffer.alloc(32, 7),
      ownership: { has: () => false, add: (sourceId, sessionId) => added.push([sourceId, sessionId]) },
    });
    const listed = await adapter.list({ limit: 10 });
    const sourceId = listed.sessions[0].id;
    const read = await adapter.read(sourceId);
    assert.equal(read.readOnly, true);
    assert.deepEqual(read.messages.map((message) => [message.role, message.text]), [
      ["notice", "Showing the latest 50 Codex turns. Earlier history remains in Codex."],
      ["user", "hello"],
      ["assistant", "prior answer"],
    ]);
    const forked = await adapter.fork(sourceId);
    assert.equal(forked.readOnly, false);
    assert.match(forked.session.id, /^ext_codex_[a-f0-9]{24}$/);
    assert.deepEqual(added, [["codex", forked.session.id]]);

    const deltas = [];
    const approvals = [];
    const turn = await adapter.submit(forked.session.id, "continue", {
      text: (delta) => deltas.push(delta),
      tool: () => {},
      notice: () => {},
      confirm: async (request) => { approvals.push(request); return true; },
    });
    assert.equal(turn.status, "completed");
    assert.equal(turn.reply, "hello world", "stream whitespace is preserved across provider deltas");
    assert.deepEqual(deltas, ["hello ", "world"]);
    assert.match(approvals[0].question, /npm test/);
    assert.doesNotMatch(JSON.stringify({ listed, read, forked, turn }), /native-(?:source|fork|turn|user-item|agent-item)|\/workspace\/private-project|provider-private-(?:turn|backwards)-cursor/);
    await adapter.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex read degrades safely when an older App Server lacks bounded turn pagination", async () => {
  const root = mkdtempSync(join(tmpdir(), "hara-external-codex-legacy-"));
  try {
    const fixture = join(root, "fake-codex-legacy.mjs");
    writeFileSync(fixture, `
      import { createInterface } from "node:readline";
      if (process.argv.includes("--version")) {
        process.stdout.write("codex-cli 0.0.1\\n");
      } else {
        const lines = createInterface({ input: process.stdin });
        lines.on("line", (line) => {
          const request = JSON.parse(line);
          if (request.method === "initialize") {
            process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + "\\n");
          }
          if (request.method === "thread/list") {
            process.stdout.write(JSON.stringify({ id: request.id, result: { data: [{
              id: "legacy-native", name: "Legacy", cwd: "/workspace/legacy-private",
              createdAt: 1780000000, updatedAt: 1780000010, status: { type: "idle" },
              source: "cli", ephemeral: false
            }], nextCursor: null } }) + "\\n");
          }
          if (request.method === "thread/turns/list") {
            process.stdout.write(JSON.stringify({ id: request.id, error: {
              code: -32601,
              message: "method unavailable at /workspace/provider-secret"
            } }) + "\\n");
          }
        });
      }
    `);
    const adapter = new CodexAppServerAdapter({
      command: process.execPath,
      argsPrefix: [fixture],
      timeoutMs: 3_000,
      haraVersion: "0.0.0-test",
      identityKey: Buffer.alloc(32, 11),
    });
    const listed = await adapter.list({ limit: 1 });
    const read = await adapter.read(listed.sessions[0].id);
    assert.equal(read.readOnly, true);
    assert.deepEqual(read.messages.map(({ role, text }) => [role, text]), [[
      "notice",
      "Update Codex to read this transcript safely in Hara. The original session remains unchanged.",
    ]]);
    assert.doesNotMatch(JSON.stringify(read), /legacy-native|\/workspace\/legacy-private|provider-secret/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Claude official Agent SDK mapping keeps native state in Core and makes only a Hara fork writable", async () => {
  const sdkCalls = [];
  let queryOptions;
  let closed = false;
  const source = {
    sessionId: "claude-native-source",
    cwd: "/workspace/confidential-claude-project",
    customTitle: "Claude audit",
    summary: "private summary",
    firstPrompt: "private prompt",
    createdAt: 1_780_000_000_000,
    lastModified: 1_780_000_010_000,
  };
  const fork = { ...source, sessionId: "claude-native-fork", customTitle: "Claude audit · Hara fork" };
  const sdk = {
    async listSessions(options) {
      sdkCalls.push(["list", options]);
      return [source, {
        ...source,
        sessionId: "claude-native-untitled",
        customTitle: undefined,
        firstPrompt: "do not expose this prompt in metadata",
        summary: "do not expose this summary in metadata",
      }];
    },
    async getSessionMessages(sessionId, options) {
      sdkCalls.push(["messages", sessionId, options]);
      return [
        { type: "user", uuid: "native-user", message: { content: "question" } },
        { type: "assistant", uuid: "native-agent", message: { content: [{ type: "text", text: "answer" }] } },
      ];
    },
    async forkSession(sessionId, options) { sdkCalls.push(["fork", sessionId, options]); return { sessionId: fork.sessionId }; },
    async getSessionInfo(sessionId) { sdkCalls.push(["info", sessionId]); return fork; },
    query(input) {
      queryOptions = input.options;
      return {
        async *[Symbol.asyncIterator]() {
          const permission = await input.options.canUseTool(
            "Bash",
            { command: "npm test" },
            {
              title: "Run verification",
              description: "Run verification",
              displayName: "Bash",
              suggestions: [],
              signal: new AbortController().signal,
            },
          );
          assert.equal(permission.behavior, "allow");
          yield { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "completed" }] } };
          yield { type: "result", subtype: "success", result: "completed", errors: [] };
        },
        close() { closed = true; },
      };
    },
  };
  const owned = new Set();
  const adapter = new ClaudeAgentSdkAdapter({
    command: "/usr/bin/true",
    env: { ...process.env, OPENAI_API_KEY: "must-not-cross" },
    identityKey: Buffer.alloc(32, 9),
    ownership: { has: (sessionId) => owned.has(sessionId), add: (_sourceId, sessionId) => owned.add(sessionId) },
    sdk,
  });
  const listed = await adapter.list({ limit: 10 });
  const sourceId = listed.sessions[0].id;
  assert.match(listed.sessions[1].title, /^Claude session · [A-F0-9]{6}$/);
  const read = await adapter.read(sourceId);
  assert.equal(read.readOnly, true);
  assert.deepEqual(read.messages.map((message) => message.text), ["question", "answer"]);
  const forked = await adapter.fork(sourceId);
  assert.equal(forked.readOnly, false);
  assert.ok(owned.has(forked.session.id));
  const text = [];
  const approvals = [];
  const turn = await adapter.submit(forked.session.id, "continue", {
    text: (delta) => text.push(delta),
    tool: () => {},
    notice: () => {},
    confirm: async (request) => { approvals.push(request); return true; },
  });
  assert.equal(turn.status, "completed");
  assert.deepEqual(text, ["completed"]);
  assert.equal(closed, true);
  assert.equal(queryOptions.resume, fork.sessionId);
  assert.equal(queryOptions.pathToClaudeCodeExecutable, realpathSync("/usr/bin/true"));
  assert.equal(queryOptions.env.OPENAI_API_KEY, undefined);
  assert.match(approvals[0].question, /npm test/);
  assert.doesNotMatch(JSON.stringify({ listed, read, forked, turn }), /claude-native|\/workspace\/confidential-claude-project|private prompt|private summary/);
  assert.ok(sdkCalls.some(([kind]) => kind === "fork"));
});
