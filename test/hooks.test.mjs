import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHooks, resetHooksCache } from "../dist/hooks.js";

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
    assert.equal(runHooks("PreToolUse", "bash", {}, process.cwd()).block, false);
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
