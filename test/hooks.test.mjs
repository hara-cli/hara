import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Codex/CI may itself run inside macOS Seatbelt, where launching a nested sandbox-exec is rejected before
// the hook command starts. Most tests exercise hook semantics rather than the read mask, so disable only the
// nested mask in this test process; the dedicated protected-file test below removes the waiver explicitly.
const originalSensitiveFilesAllow = process.env.HARA_ALLOW_SENSITIVE_FILES;
const originalTrustProjectConfig = process.env.HARA_TRUST_PROJECT_CONFIG;
process.env.HARA_ALLOW_SENSITIVE_FILES = "1";
process.env.HARA_TRUST_PROJECT_CONFIG = "1"; // these tests deliberately execute their fixture repo hooks
const { runHooks, resetHooksCache } = await import("../dist/hooks.js");
const { runAgent } = await import("../dist/agent/loop.js");
await import("../dist/tools/builtin.js");
after(() => {
  if (originalSensitiveFilesAllow === undefined) delete process.env.HARA_ALLOW_SENSITIVE_FILES;
  else process.env.HARA_ALLOW_SENSITIVE_FILES = originalSensitiveFilesAllow;
  if (originalTrustProjectConfig === undefined) delete process.env.HARA_TRUST_PROJECT_CONFIG;
  else process.env.HARA_TRUST_PROJECT_CONFIG = originalTrustProjectConfig;
});

// Each case runs in a throwaway project dir whose .hara/config.json carries the hooks under test.
async function withProject(hooks, fn) {
  const dir = mkdtempSync(join(tmpdir(), "hara-hooks-"));
  mkdirSync(join(dir, ".hara"), { recursive: true });
  writeFileSync(join(dir, ".hara", "config.json"), JSON.stringify({ hooks }), "utf8");
  const prev = process.cwd();
  process.chdir(dir);
  resetHooksCache();
  try {
    return await fn(dir);
  } finally {
    process.chdir(prev);
    resetHooksCache();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("PreToolUse: a non-zero exit blocks the call + surfaces the hook's output", async () => {
  await withProject({ PreToolUse: [{ matcher: "bash", command: "echo 'no bash here' >&2; exit 1" }] }, async () => {
    const r = await runHooks("PreToolUse", "bash", { command: "ls" }, process.cwd());
    assert.equal(r.block, true);
    assert.match(r.message, /no bash here/);
  });
});

test("PreToolUse: exit 0 does not block", async () => {
  await withProject({ PreToolUse: [{ matcher: "*", command: "exit 0" }] }, async () => {
    // A payload larger than the pipe buffer makes Linux reliably surface the benign status=0 + EPIPE
    // combination when the hook exits without reading stdin.
    const payload = { ignored: "x".repeat(1024 * 1024) };
    assert.equal((await runHooks("PreToolUse", "bash", payload, process.cwd())).block, false);
  });
});

test("PreToolUse fails closed when its policy hook is killed or times out", { skip: process.platform === "win32" }, async () => {
  await withProject({ PreToolUse: [{ matcher: "bash", command: "kill -TERM $$" }] }, async () => {
    const killed = await runHooks("PreToolUse", "bash", {}, process.cwd());
    assert.equal(killed.block, true);
    assert.match(killed.message, /SIGTERM|could not start|PreToolUse/i);
  });
  const child = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setTimeout(() => {}, 1000)")}`;
  await withProject({ PreToolUse: [{ matcher: "bash", command: child }] }, async () => {
    const timedOut = await runHooks("PreToolUse", "bash", {}, process.cwd(), 25);
    assert.equal(timedOut.block, true);
    assert.match(timedOut.message, /timed out|SIGTERM|PreToolUse/i);
  });
});

test("matcher: a non-matching tool name is skipped; a matching one fires", async () => {
  await withProject({ PreToolUse: [{ matcher: "^edit_file$", command: "exit 1" }] }, async () => {
    assert.equal((await runHooks("PreToolUse", "read_file", {}, process.cwd())).block, false, "read_file ≠ ^edit_file$");
    assert.equal((await runHooks("PreToolUse", "edit_file", {}, process.cwd())).block, true, "edit_file matches");
  });
});

test("PostToolUse: runs the command (observe) and never blocks", async () => {
  await withProject({ PostToolUse: [{ matcher: "*", command: "echo done > post-marker.txt" }] }, async (dir) => {
    const r = await runHooks("PostToolUse", "write_file", { input: {}, result: "ok" }, process.cwd());
    assert.equal(r.block, false);
    assert.ok(existsSync(join(dir, "post-marker.txt")), "PostToolUse side effect happened");
  });
});

test("no hooks configured → fast no-op, never blocks", async () => {
  await withProject({}, async () => {
    assert.equal((await runHooks("PreToolUse", "bash", {}, process.cwd())).block, false);
  });
});

test("the hook receives {tool, payload} as JSON on stdin", async () => {
  await withProject({ PreToolUse: [{ matcher: "bash", command: "cat > stdin.json" }] }, async (dir) => {
    await runHooks("PreToolUse", "bash", { command: "ls -la" }, process.cwd());
    const seen = JSON.parse(readFileSync(join(dir, "stdin.json"), "utf8"));
    assert.equal(seen.tool, "bash");
    assert.equal(seen.payload.command, "ls -la");
  });
});

test("hooks inherit the subprocess secret scrubber", { skip: process.platform === "win32" }, async () => {
  const name = "HARA_HOOK_TEST_TOKEN";
  const previous = process.env[name];
  process.env[name] = "must-not-reach-hook";
  try {
    await withProject(
      { PreToolUse: [{ matcher: "bash", command: `printf '%s' "\${${name}:-missing}" > hook-env.txt` }] },
      async (dir) => {
        assert.equal((await runHooks("PreToolUse", "bash", {}, dir)).block, false);
        assert.equal(readFileSync(join(dir, "hook-env.txt"), "utf8"), "missing");
      },
    );
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
});

test("PreToolUse fails closed and PostToolUse skips when a hook names a protected file", async () => {
  const previous = process.env.HARA_ALLOW_SENSITIVE_FILES;
  delete process.env.HARA_ALLOW_SENSITIVE_FILES;
  try {
    await withProject(
      {
        PreToolUse: [{ matcher: "read_file", command: "cat .env >/dev/null; echo ran > pre-marker.txt" }],
        PostToolUse: [{ matcher: "read_file", command: "cat .env > post-leak.txt" }],
      },
      async (dir) => {
        writeFileSync(join(dir, ".env"), "API_KEY=must-not-leak\n");

        const pre = await runHooks("PreToolUse", "read_file", {}, dir);
        assert.equal(pre.block, true);
        assert.match(pre.message, /protected secret boundary|environment file/i);
        assert.equal(existsSync(join(dir, "pre-marker.txt")), false, "blocked PreToolUse was never launched");

        const post = await runHooks("PostToolUse", "read_file", {}, dir);
        assert.equal(post.block, false, "PostToolUse remains observe-only");
        assert.equal(existsSync(join(dir, "post-leak.txt")), false, "policy-blocked PostToolUse was not retried unsafely");
      },
    );
  } finally {
    if (previous === undefined) delete process.env.HARA_ALLOW_SENSITIVE_FILES;
    else process.env.HARA_ALLOW_SENSITIVE_FILES = previous;
  }
});

test("hook config is selected by the tool cwd instead of process.cwd or the first cached project", async () => {
  const root = mkdtempSync(join(tmpdir(), "hara-hooks-cwd-"));
  const blocked = join(root, "blocked");
  const allowed = join(root, "allowed");
  try {
    for (const dir of [blocked, allowed]) mkdirSync(join(dir, ".hara"), { recursive: true });
    writeFileSync(join(blocked, ".hara", "config.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "read_file", command: "echo target-home >&2; exit 1" }] } }));
    writeFileSync(join(allowed, ".hara", "config.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "read_file", command: "exit 0" }] } }));
    resetHooksCache();
    assert.match((await runHooks("PreToolUse", "read_file", {}, blocked)).message, /target-home/);
    assert.equal((await runHooks("PreToolUse", "read_file", {}, allowed)).block, false, "a second home does not reuse the first home's cached hooks");
  } finally {
    resetHooksCache();
    rmSync(root, { recursive: true, force: true });
  }
});

test("genuinely read-only runs invoke neither mutating PreToolUse nor PostToolUse shell hooks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-hooks-readonly-"));
  const preMarker = join(dir, "pre-mutated.txt");
  const postMarker = join(dir, "post-mutated.txt");
  try {
    mkdirSync(join(dir, ".hara"), { recursive: true });
    writeFileSync(join(dir, "input.txt"), "safe\n");
    writeFileSync(
      join(dir, ".hara", "config.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: "read_file", command: "echo changed > pre-mutated.txt" }],
          PostToolUse: [{ matcher: "read_file", command: "echo changed > post-mutated.txt" }],
        },
      }),
    );
    resetHooksCache();
    let round = 0;
    const provider = {
      id: "test",
      model: "test",
      async turn() {
        round++;
        return round === 1
          ? { text: "", toolUses: [{ id: "r1", name: "read_file", input: { path: "input.txt" } }], stop: "tool_use" }
          : { text: "done", toolUses: [], stop: "end" };
      },
    };
    const history = [{ role: "user", content: "inspect" }];
    await runAgent(history, {
      provider,
      ctx: { cwd: dir, sandbox: "off", todoScope: "hook-readonly" },
      approval: "full-auto",
      confirm: async () => true,
      toolFilter: (name) => name === "read_file",
      hooks: false,
      quiet: true,
    });
    assert.ok(history.some((message) => message.role === "tool"), "the read tool itself still ran");
    assert.equal(existsSync(preMarker), false, "PreToolUse shell did not run");
    assert.equal(existsSync(postMarker), false, "PostToolUse shell did not run");
  } finally {
    resetHooksCache();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ordinary runs load and execute both hook phases from ctx.cwd", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-hooks-normal-cwd-"));
  try {
    mkdirSync(join(dir, ".hara"), { recursive: true });
    writeFileSync(join(dir, "input.txt"), "normal\n");
    writeFileSync(
      join(dir, ".hara", "config.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: "read_file", command: "echo pre > normal-pre.txt" }],
          PostToolUse: [{ matcher: "read_file", command: "echo post > normal-post.txt" }],
        },
      }),
    );
    resetHooksCache();
    let round = 0;
    const provider = {
      id: "test",
      model: "test",
      async turn() {
        round++;
        return round === 1
          ? { text: "", toolUses: [{ id: "r1", name: "read_file", input: { path: "input.txt" } }], stop: "tool_use" }
          : { text: "done", toolUses: [], stop: "end" };
      },
    };
    const history = [{ role: "user", content: "inspect" }];
    await runAgent(history, {
      provider,
      ctx: { cwd: dir, sandbox: "off", todoScope: "hook-normal" },
      approval: "full-auto",
      confirm: async () => true,
      toolFilter: (name) => name === "read_file",
      quiet: true,
    });
    assert.equal(readFileSync(join(dir, "normal-pre.txt"), "utf8").trim(), "pre");
    assert.equal(readFileSync(join(dir, "normal-post.txt"), "utf8").trim(), "post");
    assert.match(JSON.stringify(history), /normal/, "the ordinary tool run was not blocked");
  } finally {
    resetHooksCache();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("agent deadline cancels a hanging hook promptly and kills the hook process", { skip: process.platform === "win32", timeout: 8_000 }, async () => {
  const previous = process.env.HARA_ALLOW_SENSITIVE_FILES;
  process.env.HARA_ALLOW_SENSITIVE_FILES = "1";
  let pid;
  try {
    await withProject({}, async (dir) => {
      const pidFile = join(dir, "hook.pid");
      const script = `require("node:fs").writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`;
      writeFileSync(
        join(dir, ".hara", "config.json"),
        JSON.stringify({ hooks: { PreToolUse: [{ matcher: "wait_tool", command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}` }] } }),
      );
      resetHooksCache();
      let round = 0;
      const provider = {
        id: "hook-deadline",
        model: "hook-deadline",
        async turn() {
          round += 1;
          return round === 1
            ? { text: "", toolUses: [{ id: "h1", name: "wait_tool", input: {} }], stop: "tool_use" }
            : { text: "wrong", toolUses: [], stop: "end" };
        },
      };
      const started = Date.now();
      const outcome = await runAgent([{ role: "user", content: "wait" }], {
        provider,
        ctx: { cwd: dir },
        approval: "full-auto",
        confirm: async () => true,
        timeoutMs: 1_000,
        quiet: true,
        extraTools: [{
          name: "wait_tool",
          description: "fixture",
          input_schema: { type: "object", properties: {} },
          kind: "read",
          async run() { return "ran"; },
        }],
      });
      assert.equal(outcome.stopReason, "deadline");
      assert.ok(Date.now() - started < 2_000, "hook cannot hold the event loop until its own timeout");
      assert.ok(existsSync(pidFile), "hook child started before the deadline");
      pid = Number(readFileSync(pidFile, "utf8"));
      const deadline = Date.now() + 1_000;
      for (;;) {
        try { process.kill(pid, 0); } catch (error) { if (error?.code === "ESRCH") break; throw error; }
        if (Date.now() >= deadline) assert.fail(`hook process ${pid} survived cancellation`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    });
  } finally {
    if (pid) try { process.kill(pid, "SIGKILL"); } catch {}
    if (previous === undefined) delete process.env.HARA_ALLOW_SENSITIVE_FILES;
    else process.env.HARA_ALLOW_SENSITIVE_FILES = previous;
  }
});
