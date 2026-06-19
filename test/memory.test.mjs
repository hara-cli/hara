import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { appendMemory, replaceMemory, forgetMemory, memoryDigest, memoryRoots, scaffoldMemory } from "../dist/memory/store.js";
import { searchAssets } from "../dist/recall.js";
import { saveSession, loadSession, newSessionId } from "../dist/session/store.js";

test("memory: write → search → digest → forget round-trip", () => {
  const d = mkdtempSync(join(tmpdir(), "hara-mem-"));
  process.env.HARA_MEMORY = d;
  const cwd = mkdtempSync(join(tmpdir(), "hara-proj-")); // no markers → project root falls back to cwd
  try {
    appendMemory("global", "memory", "The user runs glm-5 via the coding endpoint", cwd);
    appendMemory("global", "user", "Prefers concise, lexical-first answers", cwd);
    const hits = searchAssets("glm coding endpoint", 5, memoryRoots(cwd));
    assert.ok(hits.length >= 1 && hits[0].path.includes("MEMORY.md"), "search finds the fact in MEMORY.md (absolute path)");
    const dig = memoryDigest(cwd);
    assert.ok(dig.includes("glm-5") && dig.includes("concise"), "digest carries MEMORY + USER");
    assert.equal(forgetMemory("global", "memory", "glm-5", cwd), 1, "forget removes one line");
    assert.ok(!memoryDigest(cwd).includes("glm-5"), "fact gone after forget");
  } finally {
    delete process.env.HARA_MEMORY;
    rmSync(d, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("memory: replace overwrites; scaffold seeds files", () => {
  const d = mkdtempSync(join(tmpdir(), "hara-mem2-"));
  process.env.HARA_MEMORY = d;
  const cwd = mkdtempSync(join(tmpdir(), "hara-proj2-"));
  try {
    appendMemory("global", "memory", "old fact", cwd);
    replaceMemory("global", "memory", "fresh fact only", cwd);
    const dig = memoryDigest(cwd);
    assert.ok(dig.includes("fresh fact only") && !dig.includes("old fact"), "replace overwrites");
    assert.ok(scaffoldMemory(cwd).every((p) => typeof p === "string"), "scaffold returns written paths");
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
