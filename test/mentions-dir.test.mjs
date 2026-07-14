import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandMentions, expandMentionsAsync, fileCandidates } from "../dist/context/mentions.js";

function fx() {
  const dir = mkdtempSync(join(tmpdir(), "hara-atdir-"));
  mkdirSync(join(dir, "src", "deep"), { recursive: true });
  writeFileSync(join(dir, "src", "app.ts"), "x");
  writeFileSync(join(dir, "src", "deep", "util.ts"), "y");
  writeFileSync(join(dir, "README.md"), "z");
  return dir;
}

test("@dir loads a directory listing", () => {
  const dir = fx();
  try {
    const out = expandMentions("look at @src please", dir);
    assert.match(out, /Referenced directory `src`/);
    assert.match(out, /app\.ts/);
    assert.match(out, /deep\/util\.ts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("async @dir expansion preserves inline order, deduplicates, and reports truncation", async () => {
  const dir = fx();
  try {
    const out = await expandMentionsAsync("before @src between @src after", dir, {
      maxDirectories: 1,
      timeoutMs: 5_000,
      yieldEvery: 1,
    });
    assert.ok(out.startsWith("before "));
    assert.ok(out.indexOf("Referenced directory `src`") < out.indexOf("between"));
    assert.equal((out.match(/Referenced directory `src`/g) ?? []).length, 1, "a repeated ref is inlined once");
    assert.match(out, /between @src after$/, "the repeated token remains unchanged");
    assert.match(out, /directory limit/i, "partial listings explain why they stopped");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("async @dir expansion propagates timer-driven cancellation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-atdir-abort-"));
  try {
    for (let i = 0; i < 512; i++) mkdirSync(join(dir, `empty-${String(i).padStart(4, "0")}`));
    const controller = new AbortController();
    const reason = new Error("mention deadline");
    const timer = setTimeout(() => controller.abort(reason), 0);
    await assert.rejects(
      expandMentionsAsync("inspect @.", dir, { signal: controller.signal, timeoutMs: 10_000, yieldEvery: 1 }),
      (error) => error === reason,
    );
    clearTimeout(timer);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("@src/ drills into immediate children (dirs first); not nested files", () => {
  const dir = fx();
  try {
    const kids = fileCandidates(dir, "src/");
    assert.ok(kids.includes("src/deep/"));
    assert.ok(kids.includes("src/app.ts"));
    assert.ok(!kids.includes("src/deep/util.ts"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
