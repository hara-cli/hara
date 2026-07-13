import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHooks, resetHooksCache } from "../dist/hooks.js";
import { runAgent } from "../dist/agent/loop.js";
import "../dist/tools/builtin.js";

// Each case runs in a throwaway project dir whose .hara/config.json carries the hooks under test.
function withProject(hooks, fn) {
  const dir = mkdtempSync(join(tmpdir(), "hara-hooks-"));
  mkdirSync(join(dir, ".hara"), { recursive: true });
  writeFileSync(join(dir, ".hara", "config.json"), JSON.stringify({ hooks }), "utf8");
  const prev = process.cwd();
  process.chdir(dir);
  resetHooksCache();
  try {
    return fn(dir);
  } finally {
    process.chdir(prev);
    resetHooksCache();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("PreToolUse: a non-zero exit blocks the call + surfaces the hook's output", () => {
  withProject({ PreToolUse: [{ matcher: "bash", command: "echo 'no bash here' >&2; exit 1" }] }, () => {
    const r = runHooks("PreToolUse", "bash", { command: "ls" }, process.cwd());
    assert.equal(r.block, true);
    assert.match(r.message, /no bash here/);
  });
});

test("PreToolUse: exit 0 does not block", () => {
  withProject({ PreToolUse: [{ matcher: "*", command: "exit 0" }] }, () => {
    // A payload larger than the pipe buffer makes Linux reliably surface the benign status=0 + EPIPE
    // combination when the hook exits without reading stdin.
    const payload = { ignored: "x".repeat(1024 * 1024) };
    assert.equal(runHooks("PreToolUse", "bash", payload, process.cwd()).block, false);
  });
});

test("PreToolUse fails closed when its policy hook is killed or times out", { skip: process.platform === "win32" }, () => {
  withProject({ PreToolUse: [{ matcher: "bash", command: "kill -TERM $$" }] }, () => {
    const killed = runHooks("PreToolUse", "bash", {}, process.cwd());
    assert.equal(killed.block, true);
    assert.match(killed.message, /SIGTERM|could not start|PreToolUse/i);
  });
  const child = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setTimeout(() => {}, 1000)")}`;
  withProject({ PreToolUse: [{ matcher: "bash", command: child }] }, () => {
    const timedOut = runHooks("PreToolUse", "bash", {}, process.cwd(), 25);
    assert.equal(timedOut.block, true);
    assert.match(timedOut.message, /timed out|SIGTERM|PreToolUse/i);
  });
});

test("matcher: a non-matching tool name is skipped; a matching one fires", () => {
  withProject({ PreToolUse: [{ matcher: "^edit_file$", command: "exit 1" }] }, () => {
    assert.equal(runHooks("PreToolUse", "read_file", {}, process.cwd()).block, false, "read_file ≠ ^edit_file$");
    assert.equal(runHooks("PreToolUse", "edit_file", {}, process.cwd()).block, true, "edit_file matches");
  });
});

test("PostToolUse: runs the command (observe) and never blocks", () => {
  withProject({ PostToolUse: [{ matcher: "*", command: "echo done > post-marker.txt" }] }, (dir) => {
    const r = runHooks("PostToolUse", "write_file", { input: {}, result: "ok" }, process.cwd());
    assert.equal(r.block, false);
    assert.ok(existsSync(join(dir, "post-marker.txt")), "PostToolUse side effect happened");
  });
});

test("no hooks configured → fast no-op, never blocks", () => {
  withProject({}, () => {
    assert.equal(runHooks("PreToolUse", "bash", {}, process.cwd()).block, false);
  });
});

test("the hook receives {tool, payload} as JSON on stdin", () => {
  withProject({ PreToolUse: [{ matcher: "bash", command: "cat > stdin.json" }] }, (dir) => {
    runHooks("PreToolUse", "bash", { command: "ls -la" }, process.cwd());
    const seen = JSON.parse(readFileSync(join(dir, "stdin.json"), "utf8"));
    assert.equal(seen.tool, "bash");
    assert.equal(seen.payload.command, "ls -la");
  });
});

test("hook config is selected by the tool cwd instead of process.cwd or the first cached project", () => {
  const root = mkdtempSync(join(tmpdir(), "hara-hooks-cwd-"));
  const blocked = join(root, "blocked");
  const allowed = join(root, "allowed");
  try {
    for (const dir of [blocked, allowed]) mkdirSync(join(dir, ".hara"), { recursive: true });
    writeFileSync(join(blocked, ".hara", "config.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "read_file", command: "echo target-home >&2; exit 1" }] } }));
    writeFileSync(join(allowed, ".hara", "config.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "read_file", command: "exit 0" }] } }));
    resetHooksCache();
    assert.match(runHooks("PreToolUse", "read_file", {}, blocked).message, /target-home/);
    assert.equal(runHooks("PreToolUse", "read_file", {}, allowed).block, false, "a second home does not reuse the first home's cached hooks");
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
