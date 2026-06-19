import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walkFiles, dirPrefixes, listProjectFiles } from "../dist/fs-walk.js";
import { fileCandidates } from "../dist/context/mentions.js";
import { activity } from "../dist/activity.js";
import { footerLines, ctxPctFor, nextMode } from "../dist/statusbar.js";
import { getTool } from "../dist/tools/registry.js";
import "../dist/tools/search.js";
import "../dist/tools/edit.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "hara-search-"));
  mkdirSync(join(dir, "src", "deep"), { recursive: true });
  mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(dir, "README.md"), "top level\nNEEDLE here\n");
  writeFileSync(join(dir, "src", "app.ts"), "export const x = 1;\n// NEEDLE in subdir\n");
  writeFileSync(join(dir, "src", "deep", "util.ts"), "export const y = 2;\n");
  writeFileSync(join(dir, "node_modules", "pkg", "index.js"), "NEEDLE should be ignored\n");
  return dir;
}

test("fs-walk: recurses subdirs, skips node_modules", () => {
  const dir = fixture();
  try {
    const files = walkFiles(dir);
    assert.ok(files.includes("src/app.ts"), "finds subdir file");
    assert.ok(files.includes("src/deep/util.ts"), "finds nested file");
    assert.ok(!files.some((f) => f.includes("node_modules")), "skips node_modules");
    const dirs = dirPrefixes(files);
    assert.ok(dirs.includes("src/"), "derives dir prefix");
    assert.ok(dirs.includes("src/deep/"), "derives nested dir prefix");
    assert.ok(listProjectFiles(dir).includes("src/app.ts"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("@ completion: finds subdir files + drills via dir prefix + bare @ lists top level", () => {
  const dir = fixture();
  try {
    assert.ok(fileCandidates(dir, "util").includes("src/deep/util.ts"), "fuzzy finds nested file");
    assert.ok(fileCandidates(dir, "app").includes("src/app.ts"));
    const drill = fileCandidates(dir, "src/");
    assert.ok(drill.some((c) => c.startsWith("src/")), "drills into subdir");
    const bare = fileCandidates(dir, "");
    assert.ok(bare.includes("README.md"), "bare @ shows top-level file");
    assert.ok(bare.includes("src/"), "bare @ shows top-level dir");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("grep tool: matches across subdirs with path:line, skips node_modules", async () => {
  const dir = fixture();
  try {
    const out = await getTool("grep").run({ pattern: "NEEDLE" }, { cwd: dir });
    assert.match(out, /README\.md:2:/, "match in top file with line number");
    assert.match(out, /src\/app\.ts:2:/, "match in subdir file");
    assert.ok(!out.includes("node_modules"), "ignores node_modules");
    const none = await getTool("grep").run({ pattern: "ZZZ_NOPE" }, { cwd: dir });
    assert.match(none, /No matches/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("glob tool: ** matches nested, ls lists a dir", async () => {
  const dir = fixture();
  try {
    const g = await getTool("glob").run({ pattern: "**/*.ts" }, { cwd: dir });
    assert.match(g, /src\/app\.ts/);
    assert.match(g, /src\/deep\/util\.ts/);
    assert.ok(!/README\.md/.test(g), "glob *.ts excludes README");
    const l = await getTool("ls").run({ path: "src" }, { cwd: dir });
    assert.match(l, /deep\//, "ls shows subdir with trailing slash");
    assert.match(l, /app\.ts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edit_file: multi-edit applies in order", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-edit-"));
  try {
    const f = join(dir, "x.txt");
    writeFileSync(f, "alpha\nbeta\ngamma\n");
    const out = await getTool("edit_file").run(
      { path: f, edits: [{ old_string: "alpha", new_string: "ONE" }, { old_string: "gamma", new_string: "THREE" }] },
      { cwd: dir },
    );
    assert.match(out, /2 edits/);
    const txt = readFileSync(f, "utf8");
    assert.equal(txt, "ONE\nbeta\nTHREE\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edit_file: quote-normalized fallback matches curly quotes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-edit2-"));
  try {
    const f = join(dir, "q.ts");
    writeFileSync(f, "const s = “hello”;\n"); // curly double quotes
    const out = await getTool("edit_file").run(
      { path: f, old_string: '"hello"', new_string: '"world"' }, // straight quotes
      { cwd: dir },
    );
    assert.match(out, /quote-normalized/);
    const txt = readFileSync(f, "utf8");
    assert.match(txt, /world/);
    assert.ok(!txt.includes("hello"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("activity: inc/dec tracks running + peak", () => {
  activity.resetPeak();
  const base = activity.running;
  activity.inc();
  activity.inc();
  assert.equal(activity.running, base + 2);
  assert.ok(activity.peak >= 2);
  activity.dec();
  activity.dec();
  assert.equal(activity.running, base);
});

test("statusbar: footerLines composes 2 lines with name/mode/tokens/agents", () => {
  const lines = footerLines(
    { sessionName: "refactor auth", model: "claude-opus-4-8", approval: "suggest", input: 12400, output: 3100, ctxPct: 8 },
    80,
    3,
  );
  assert.equal(lines.length, 2);
  assert.match(lines[0], /refactor auth/);
  assert.match(lines[0], /suggest/);
  assert.match(lines[1], /12\.4k/);
  assert.match(lines[1], /ctx 8%/);
  assert.match(lines[1], /3 agents/);
});

test("statusbar: ctxPctFor + nextMode cycle", () => {
  assert.equal(nextMode("suggest"), "auto-edit");
  assert.equal(nextMode("auto-edit"), "full-auto");
  assert.equal(nextMode("full-auto"), "suggest");
  assert.ok(ctxPctFor("claude-haiku-4-5", 20000) > 0); // 200k window → ~10%
  assert.equal(ctxPctFor("any", 0), 0);
});
