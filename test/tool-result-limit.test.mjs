import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { limitToolResult, MAX_TOOL_RESULT_CHARS, pruneStoredToolResults } from "../dist/tools/result-limit.js";
import { getTool, registerTool, toolSpecs } from "../dist/tools/registry.js";

test("limitToolResult keeps head and tail within one hard context budget", () => {
  const value = "HEAD" + "中".repeat(MAX_TOOL_RESULT_CHARS * 2) + "TAIL";
  const out = limitToolResult(value);
  assert.ok(out.length <= MAX_TOOL_RESULT_CHARS);
  assert.ok(out.startsWith("HEAD"));
  assert.ok(out.endsWith("TAIL"));
  assert.match(out, /chars omitted/);
});

test("limitToolResult never splits a surrogate pair at either retained boundary", () => {
  const value = "🙂".repeat(100);
  const out = limitToolResult(value, 80);
  assert.ok(out.length <= 80);
  assert.ok(!/[\uD800-\uDBFF]$/.test(out), "does not end on a high surrogate");
  assert.ok(!out.includes("�"), "does not introduce a replacement character");
});

test("startup janitor removes expired owned tool results without waiting for another oversized result", () => {
  const previousHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "hara-result-prune-home-"));
  process.env.HOME = home;
  try {
    const dir = join(home, ".hara", "tool-results");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stale = `tr_${"a".repeat(32)}.txt`;
    const recent = `tr_${"b".repeat(32)}.txt`;
    writeFileSync(join(dir, stale), "stale", { mode: 0o600 });
    writeFileSync(join(dir, recent), "recent", { mode: 0o600 });
    const now = Date.parse("2026-08-28T00:00:00.000Z");
    const old = new Date(now - 8 * 24 * 60 * 60 * 1000);
    utimesSync(join(dir, stale), old, old);
    assert.equal(pruneStoredToolResults(now), true);
    assert.deepEqual(readdirSync(dir), [recent]);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("registry caps every tool and invalidates its cached schema snapshot", async () => {
  const previousHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "hara-result-limit-home-"));
  process.env.HOME = home;
  try {
  const before = toolSpecs();
  registerTool({
    name: "test_huge_result",
    description: "test",
    input_schema: { type: "object", properties: {} },
    async run() {
      return "start" + "x".repeat(MAX_TOOL_RESULT_CHARS * 2) + "finish";
    },
  });
  const after = toolSpecs();
  assert.ok(!before.some((tool) => tool.name === "test_huge_result"));
  assert.ok(after.some((tool) => tool.name === "test_huge_result"), "new registration invalidates the spec cache");

  const out = await getTool("test_huge_result").run({}, { cwd: process.cwd() });
  assert.ok(out.length <= MAX_TOOL_RESULT_CHARS);
  assert.ok(out.startsWith("start"));
  assert.ok(out.includes("finish"));
  assert.match(out, /\btr_[a-f0-9]{32}\b/);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});
