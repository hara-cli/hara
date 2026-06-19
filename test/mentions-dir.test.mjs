import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandMentions, fileCandidates } from "../dist/context/mentions.js";

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
