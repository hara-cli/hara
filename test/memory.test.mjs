import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, linkSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { appendMemory, replaceMemory, forgetMemory, memoryDigest, memoryRoots, scaffoldMemory, readRecentLogs } from "../dist/memory/store.js";
import { searchAssets } from "../dist/recall.js";
import { saveSession, loadSession, newSessionId } from "../dist/session/store.js";

test("memory: write → search → digest → forget round-trip", async () => {
  const d = mkdtempSync(join(tmpdir(), "hara-mem-"));
  process.env.HARA_MEMORY = d;
  const cwd = mkdtempSync(join(tmpdir(), "hara-proj-")); // no markers → project root falls back to cwd
  try {
    await appendMemory("global", "memory", "The user runs glm-5 via the coding endpoint", cwd);
    await appendMemory("global", "user", "Prefers concise, lexical-first answers", cwd);
    const hits = searchAssets("glm coding endpoint", 5, memoryRoots(cwd));
    assert.ok(hits.length >= 1 && hits[0].path.includes("MEMORY.md"), "search finds the fact in MEMORY.md (absolute path)");
    const dig = memoryDigest(cwd);
    assert.ok(dig.includes("glm-5") && dig.includes("concise"), "digest carries MEMORY + USER");
    assert.equal(await forgetMemory("global", "memory", "glm-5", cwd), 1, "forget removes one line");
    assert.ok(!memoryDigest(cwd).includes("glm-5"), "fact gone after forget");
  } finally {
    delete process.env.HARA_MEMORY;
    rmSync(d, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("memory: a huge global MEMORY can't starve USER prefs out of the digest (per-source budgets)", async () => {
  const d = mkdtempSync(join(tmpdir(), "hara-mem3-"));
  process.env.HARA_MEMORY = d;
  const cwd = mkdtempSync(join(tmpdir(), "hara-proj3-"));
  try {
    // 5000 chars of memory entries (each its own line) — far over the per-source cap
    const big = Array.from({ length: 200 }, (_, i) => `- fact line number ${i} about the codebase`).join("\n");
    await appendMemory("global", "memory", big, cwd);
    await appendMemory("global", "user", "ALWAYS answer in terse bullet points", cwd);
    const dig = memoryDigest(cwd);
    assert.ok(dig.includes("ALWAYS answer in terse bullet points"), "USER prefs survive even behind a huge MEMORY");
    assert.ok(/…\[truncated/.test(dig), "the oversized MEMORY is truncated, not dropped");
    assert.ok(!/fact line number 199 /.test(dig.split("USER preferences")[0]), "MEMORY is actually cut (last lines absent)");
    // truncation lands on a line boundary — no half-line fragments before the marker
    const beforeMarker = dig.slice(0, dig.indexOf("…[truncated"));
    assert.ok(beforeMarker.endsWith("\n") || beforeMarker.endsWith("codebase"), "cut at a line boundary, not mid-entry");
  } finally {
    delete process.env.HARA_MEMORY;
    rmSync(d, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("memory: readRecentLogs includes recent daily logs, excludes ones outside the window", async () => {
  const d = mkdtempSync(join(tmpdir(), "hara-mem-logs-"));
  process.env.HARA_MEMORY = d;
  const cwd = mkdtempSync(join(tmpdir(), "hara-proj-logs-"));
  try {
    await appendMemory("global", "log", "today: shipped the cron hardening", cwd); // → log/<today>.md
    mkdirSync(join(d, "log"), { recursive: true });
    writeFileSync(join(d, "log", "2020-01-01.md"), "ancient note\n"); // far outside any window
    const recent = readRecentLogs("global", cwd, 14);
    assert.ok(recent.includes("shipped the cron hardening"), "today's log is in the 14-day window");
    assert.ok(!recent.includes("ancient note"), "a 2020 log is excluded");
    assert.equal(readRecentLogs("global", cwd, 14).includes("ancient note"), false);
  } finally {
    delete process.env.HARA_MEMORY;
    rmSync(d, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("memory: MEMORY/USER/log symlinks cannot inject .env contents", () => {
  const d = mkdtempSync(join(tmpdir(), "hara-mem-protected-"));
  process.env.HARA_MEMORY = d;
  const cwd = mkdtempSync(join(tmpdir(), "hara-proj-protected-"));
  try {
    const secret = join(d, ".env");
    writeFileSync(secret, "MEMORY_SECRET=must-not-leak\n");
    symlinkSync(secret, join(d, "MEMORY.md"));
    symlinkSync(secret, join(d, "USER.md"));
    mkdirSync(join(d, "log"));
    symlinkSync(secret, join(d, "log", "2099-01-01.md"));
    assert.doesNotMatch(memoryDigest(cwd), /must-not-leak/);
    assert.doesNotMatch(readRecentLogs("global", cwd, 100_000), /must-not-leak/);
  } finally {
    delete process.env.HARA_MEMORY;
    rmSync(d, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("memory: mutations and scaffold refuse a symlink to .env and preserve the target", async () => {
  const root = mkdtempSync(join(tmpdir(), "hara-mem-write-link-"));
  const store = join(root, "store");
  const cwd = join(root, "project");
  mkdirSync(store);
  mkdirSync(cwd);
  process.env.HARA_MEMORY = store;
  try {
    const secret = join(root, ".env");
    const original = "MEMORY_WRITE_SECRET=preserve-me\n";
    writeFileSync(secret, original);
    symlinkSync(secret, join(store, "MEMORY.md"));

    await assert.rejects(appendMemory("global", "memory", "attacker append", cwd), /protected|environment file/i);
    await assert.rejects(replaceMemory("global", "memory", "attacker replace", cwd), /protected|environment file/i);
    await assert.rejects(forgetMemory("global", "memory", "preserve", cwd), /protected|environment file/i);
    await assert.rejects(scaffoldMemory(cwd), /protected|environment file/i);
    assert.equal(readFileSync(secret, "utf8"), original, "the symlink target remains byte-for-byte unchanged");
  } finally {
    delete process.env.HARA_MEMORY;
    rmSync(root, { recursive: true, force: true });
  }
});

test("memory: mutations and scaffold reject hard-linked targets and preserve .env", async () => {
  const root = mkdtempSync(join(tmpdir(), "hara-mem-write-hardlink-"));
  const store = join(root, "store");
  const cwd = join(root, "project");
  mkdirSync(store);
  mkdirSync(cwd);
  process.env.HARA_MEMORY = store;
  try {
    const secret = join(root, ".env");
    const original = "MEMORY_HARDLINK_SECRET=preserve-me\n";
    writeFileSync(secret, original);
    linkSync(secret, join(store, "MEMORY.md"));

    await assert.rejects(appendMemory("global", "memory", "attacker append", cwd), /hard link|protected/i);
    await assert.rejects(replaceMemory("global", "memory", "attacker replace", cwd), /hard link|protected/i);
    await assert.rejects(forgetMemory("global", "memory", "preserve", cwd), /hard link|protected/i);
    await assert.rejects(scaffoldMemory(cwd), /hard link|protected/i);
    assert.equal(readFileSync(secret, "utf8"), original, "the hard-link target remains byte-for-byte unchanged");
  } finally {
    delete process.env.HARA_MEMORY;
    rmSync(root, { recursive: true, force: true });
  }
});

test("memory: parent symlink retarget after preflight stays bound to the original canonical store", async () => {
  const root = mkdtempSync(join(tmpdir(), "hara-mem-parent-retarget-"));
  const first = join(root, "first");
  const second = join(root, "second");
  const alias = join(root, "memory-link");
  const cwd = join(root, "project");
  mkdirSync(first);
  mkdirSync(second);
  mkdirSync(cwd);
  symlinkSync(first, alias);
  process.env.HARA_MEMORY = alias;
  try {
    const pending = appendMemory("global", "memory", "bound to first", cwd);
    unlinkSync(alias);
    symlinkSync(second, alias);
    await pending;

    assert.equal(readFileSync(join(first, "MEMORY.md"), "utf8"), "bound to first\n");
    assert.equal(existsSync(join(second, "MEMORY.md")), false, "retargeted parent receives no write");
  } finally {
    delete process.env.HARA_MEMORY;
    rmSync(root, { recursive: true, force: true });
  }
});

test("memory: cancellation after preflight blocks append, replace, and forget commits", async () => {
  const root = mkdtempSync(join(tmpdir(), "hara-mem-cancel-"));
  const store = join(root, "store");
  const cwd = join(root, "project");
  mkdirSync(store);
  mkdirSync(cwd);
  process.env.HARA_MEMORY = store;
  try {
    const target = join(store, "MEMORY.md");
    await appendMemory("global", "memory", "original fact", cwd);
    const original = readFileSync(target, "utf8");
    for (const mutate of [
      (signal) => appendMemory("global", "memory", "late append", cwd, signal),
      (signal) => replaceMemory("global", "memory", "late replacement", cwd, signal),
      (signal) => forgetMemory("global", "memory", "original", cwd, signal),
    ]) {
      const controller = new AbortController();
      const pending = mutate(controller.signal);
      controller.abort();
      await assert.rejects(pending, /cancelled before commit/i);
      assert.equal(readFileSync(target, "utf8"), original);
    }
  } finally {
    delete process.env.HARA_MEMORY;
    rmSync(root, { recursive: true, force: true });
  }
});

test("memory: replace overwrites; scaffold seeds files", async () => {
  const d = mkdtempSync(join(tmpdir(), "hara-mem2-"));
  process.env.HARA_MEMORY = d;
  const cwd = mkdtempSync(join(tmpdir(), "hara-proj2-"));
  try {
    await appendMemory("global", "memory", "old fact", cwd);
    await replaceMemory("global", "memory", "fresh fact only", cwd);
    const dig = memoryDigest(cwd);
    assert.ok(dig.includes("fresh fact only") && !dig.includes("old fact"), "replace overwrites");
    assert.ok((await scaffoldMemory(cwd)).every((p) => typeof p === "string"), "scaffold returns written paths");
  } finally {
    delete process.env.HARA_MEMORY;
    rmSync(d, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("memory: workingSet (short-term) survives save → load", () => {
  const id = newSessionId();
  const meta = {
    id,
    cwd: "/tmp/x",
    provider: "qwen",
    model: "glm-5",
    title: "t",
    createdAt: new Date().toISOString(),
    updatedAt: "",
    workingSet: ["decided to use lexical search", "changed src/recall.ts"],
  };
  try {
    saveSession(meta, [{ role: "user", content: "hi" }]);
    assert.deepEqual(loadSession(id)?.meta.workingSet, ["decided to use lexical search", "changed src/recall.ts"]);
  } finally {
    rmSync(join(homedir(), ".hara", "sessions", `${id}.json`), { force: true });
  }
});
