import { test } from "node:test";
import assert from "node:assert/strict";
import { linkSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walkFiles, walkFilesAsync, dirPrefixes, listProjectFiles, listProjectFilesAsync } from "../dist/fs-walk.js";
import { fileCandidates } from "../dist/context/mentions.js";
import { activity } from "../dist/activity.js";
import { borderTop, borderBottom, ctxPctFor, nextMode } from "../dist/statusbar.js";
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

test("fs-walk async: directory and Dirent limits bound empty forests and wide directories", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-walk-limits-"));
  try {
    for (let i = 0; i < 24; i++) mkdirSync(join(dir, `empty-${i}`));
    const directories = await walkFilesAsync(dir, {
      maxDirectories: 4,
      maxEntries: 1_000,
      timeoutMs: 5_000,
      yieldEvery: 1,
    });
    assert.equal(directories.reason, "directory_limit");
    assert.equal(directories.directoriesVisited, 4);

    for (let i = 0; i < 24; i++) writeFileSync(join(dir, `wide-${i}.txt`), "x\n");
    const entries = await walkFilesAsync(dir, {
      maxDirectories: 1_000,
      maxEntries: 5,
      timeoutMs: 5_000,
      yieldEvery: 1,
    });
    assert.equal(entries.reason, "entry_limit");
    assert.equal(entries.entriesVisited, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fs-walk async: timer-driven cancellation interrupts a cached empty-directory forest", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-walk-abort-"));
  try {
    // This is the shape that previously took seconds at 80k directories while starving the agent timer.
    // A small fixture is deterministic because yieldEvery:1 gives the abort timer a turn immediately.
    for (let i = 0; i < 512; i++) mkdirSync(join(dir, `empty-${String(i).padStart(4, "0")}`));
    const controller = new AbortController();
    const deadline = new Error("test agent deadline");
    const timer = setTimeout(() => controller.abort(deadline), 0);
    const startedAt = Date.now();
    await assert.rejects(
      walkFilesAsync(dir, { signal: controller.signal, timeoutMs: 10_000, yieldEvery: 1 }),
      (error) => error === deadline,
    );
    clearTimeout(timer);
    assert.ok(Date.now() - startedAt < 1_000, "cancellation is observed without finishing the forest");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fs-walk async: total wall budget starts at API entry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-walk-time-"));
  try {
    for (let i = 0; i < 512; i++) mkdirSync(join(dir, `empty-${String(i).padStart(4, "0")}`));
    let timerRan = false;
    const timer = setTimeout(() => { timerRan = true; }, 0);
    const walked = await walkFilesAsync(dir, { timeoutMs: 5, yieldEvery: 1 });
    clearTimeout(timer);
    assert.equal(walked.reason, "time_limit");
    assert.equal(timerRan, true, "the wall-budget scan yields to deadline timers");
    assert.ok(walked.directoriesVisited < 513, "the scan stopped before consuming the forest");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listProjectFilesAsync: an authoritative empty git inventory does not leak ignored files via fallback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-walk-empty-git-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, ".git", "info", "exclude"), "ignored.txt\n");
    writeFileSync(join(dir, "ignored.txt"), "must stay ignored\n");
    const inventory = await listProjectFilesAsync(dir, { timeoutMs: 5_000 });
    assert.deepEqual(inventory.files, []);
    assert.equal(inventory.truncated, false);
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
    // Rust regex intentionally rejects lookbehind; grep must retain the old JavaScript-regex capability
    // by moving this pattern into the same bounded worker used when rg is absent.
    const lookbehind = await getTool("grep").run({ pattern: "(?<=NEEDLE) here" }, { cwd: dir });
    assert.match(lookbehind, /README\.md:2:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("grep tool: preserves regex support without rg via a bounded Node worker", async () => {
  const dir = fixture();
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = ""; // Force the dependency-free worker path; process.execPath remains absolute.
    const out = await getTool("grep").run({ pattern: "NEEDLE\\s+here", glob: "**/*.md" }, { cwd: dir });
    assert.match(out, /README\.md:2:/);
    assert.ok(!out.includes("src/app.ts"), "glob is enforced by the fallback worker");
    const invalid = await getTool("grep").run({ pattern: "[" }, { cwd: dir });
    assert.match(invalid, /invalid regex/i);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("grep Node fallback reuses the protected-file boundary and rejects hard-link aliases", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-grep-hardlink-"));
  const previousPath = process.env.PATH;
  const marker = "MUST_NOT_CROSS_FALLBACK_BOUNDARY";
  try {
    const protectedFile = join(dir, ".env");
    writeFileSync(protectedFile, `${marker}=secret\n`);
    linkSync(protectedFile, join(dir, "apparently-safe.txt"));
    writeFileSync(join(dir, "ordinary.txt"), `${marker}_SAFE=visible\n`);
    process.env.PATH = "";

    const out = await getTool("grep").run({ pattern: marker }, { cwd: dir });
    assert.match(out, /ordinary\.txt:1:/);
    assert.ok(!out.includes("apparently-safe.txt"), "a hard-link alias never enters fallback output");
    assert.ok(!out.includes("=secret"), "protected content never enters fallback output");
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("grep omits safe .env templates from broad searches but permits an explicit file path in rg and fallback", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hara-grep-env-template-"));
  const previousPath = process.env.PATH;
  const previousAllow = process.env.HARA_ALLOW_SENSITIVE_FILES;
  const pattern = "SAFE_TEMPLATE_SEARCH_NEEDLE";
  writeFileSync(join(dir, ".env.example"), `${pattern}=replace-me\n`);
  delete process.env.HARA_ALLOW_SENSITIVE_FILES;

  const assertPolicy = async (label) => {
    const broad = await getTool("grep").run({ pattern, glob: "**/.env.example" }, { cwd: dir });
    assert.match(broad, /No matches/, `${label}: broad search excludes templates even with a positive glob`);
    assert.ok(!broad.includes(".env.example:"), `${label}: no template match line is returned`);

    const explicit = await getTool("grep").run({ pattern, path: ".env.example" }, { cwd: dir });
    assert.match(explicit, /\.env\.example:1:/, `${label}: an explicit safe template remains searchable`);
    assert.match(explicit, new RegExp(pattern));
  };

  try {
    let ripgrepAvailable = true;
    try {
      execFileSync("rg", ["--version"], { stdio: "ignore" });
    } catch (error) {
      ripgrepAvailable = false;
      t.diagnostic(`ripgrep unavailable; native branch skipped (${error?.message ?? error})`);
    }
    if (ripgrepAvailable) await assertPolicy("ripgrep");

    process.env.PATH = "";
    await assertPolicy("Node fallback");
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousAllow === undefined) delete process.env.HARA_ALLOW_SENSITIVE_FILES;
    else process.env.HARA_ALLOW_SENSITIVE_FILES = previousAllow;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("grep tool: catastrophic JavaScript regex is isolated and hard-stopped", { timeout: 8000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-grep-redos-"));
  const previousPath = process.env.PATH;
  try {
    writeFileSync(join(dir, "redos.txt"), `${"a".repeat(100_000)}!\n`);
    process.env.PATH = ""; // Exercise the JavaScript-regex fallback, not rg's linear-time engine.
    let eventLoopResponsive = false;
    const tick = setTimeout(() => { eventLoopResponsive = true; }, 50);
    const started = Date.now();
    const out = await getTool("grep").run({ pattern: "^(a+)+$" }, { cwd: dir });
    clearTimeout(tick);
    assert.match(out, /safety timeout.*stopped/i);
    assert.equal(eventLoopResponsive, true, "regex work never blocks the CLI event loop");
    assert.ok(Date.now() - started < 7500, "worker obeys the five-second hard deadline");
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
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
    const repeatedGlobstar = `${"**/".repeat(80)}*.ts`;
    const started = Date.now();
    const repeated = await getTool("glob").run({ pattern: repeatedGlobstar }, { cwd: dir });
    assert.match(repeated, /src\/app\.ts/);
    assert.ok(Date.now() - started < 500, "repeated globstars are handled without regex backtracking");
    const oversized = await getTool("glob").run({ pattern: "*".repeat(257) }, { cwd: dir });
    assert.match(oversized, /pattern exceeds 256/i);
    const l = await getTool("ls").run({ path: "src" }, { cwd: dir });
    assert.match(l, /deep\//, "ls shows subdir with trailing slash");
    assert.match(l, /app\.ts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("glob tool: agent cancellation interrupts discovery before matching", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-glob-abort-"));
  try {
    for (let i = 0; i < 1_024; i++) mkdirSync(join(dir, `empty-${String(i).padStart(4, "0")}`));
    const controller = new AbortController();
    const deadline = new Error("glob agent deadline");
    const timer = setTimeout(() => controller.abort(deadline), 0);
    await assert.rejects(
      getTool("glob").run({ pattern: "**/*.ts" }, { cwd: dir, signal: controller.signal }),
      (error) => error === deadline,
    );
    clearTimeout(timer);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("home scope blocks recursive grep/glob aliases but keeps ls, explicit files, and child directories usable", async () => {
  const root = mkdtempSync(join(tmpdir(), "hara-search-home-"));
  const home = join(root, "home");
  const alias = join(root, "home-alias");
  const project = join(home, "project");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(home, "root-note.txt"), "HOME_SCOPE_NEEDLE\n");
  writeFileSync(join(project, "project-note.txt"), "HOME_SCOPE_NEEDLE\n");
  symlinkSync(home, alias, process.platform === "win32" ? "junction" : "dir");
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const grep = getTool("grep");
    const glob = getTool("glob");
    const ls = getTool("ls");
    assert.match(await grep.run({ pattern: "HOME_SCOPE_NEEDLE" }, { cwd: home }), /will not recursively scan the home directory/i);
    assert.match(await grep.run({ pattern: "HOME_SCOPE_NEEDLE" }, { cwd: alias }), /will not recursively scan the home directory/i);
    assert.match(await glob.run({ pattern: "**\/*.txt" }, { cwd: alias }), /will not recursively scan the home directory/i);
    assert.match(await grep.run({ pattern: "HOME_SCOPE_NEEDLE", path: ".." }, { cwd: home }), /will not recursively scan the home directory/i);
    assert.match(await glob.run({ pattern: "**\/*.txt", path: ".." }, { cwd: home }), /will not recursively scan the home directory/i);

    assert.match(await grep.run({ pattern: "HOME_SCOPE_NEEDLE", path: "root-note.txt" }, { cwd: home }), /root-note\.txt:1:/);
    assert.match(await grep.run({ pattern: "HOME_SCOPE_NEEDLE", path: "project" }, { cwd: home }), /project-note\.txt:1:/);
    assert.match(await glob.run({ pattern: "**\/*.txt", path: "project" }, { cwd: home }), /project-note\.txt/);
    assert.match(await ls.run({}, { cwd: home }), /project\//, "non-recursive home listing remains available");
    assert.deepEqual(walkFiles(home), [], "the shared inventory helper also fails closed at the home root");
    assert.deepEqual(walkFiles(root), [], "an ancestor inventory cannot descend back into Home");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(root, { recursive: true, force: true });
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

test("edit_file rejects a FIFO without blocking", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-edit-fifo-"));
  try {
    const fifo = join(dir, "source.pipe");
    execFileSync("mkfifo", [fifo]);
    const out = await getTool("edit_file").run(
      { path: fifo, old_string: "before", new_string: "after" },
      { cwd: dir },
    );
    assert.match(out, /not a regular file/i);
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

test("statusbar: borderTop/borderBottom frame name/mode/tokens/agents", () => {
  const s = { sessionName: "refactor auth", model: "claude-opus-4-8", approval: "suggest", input: 12400, output: 3100, ctxPct: 8 };
  const top = borderTop(s, 80);
  const bottom = borderBottom(s, 80, 3);
  assert.match(top, /⏺/);
  assert.match(top, /refactor auth/);
  assert.match(bottom, /suggest/);
  assert.match(bottom, /12\.4k/);
  assert.match(bottom, /ctx 8%/);
  assert.match(bottom, /⛁3/);
});

test("statusbar: ctxPctFor + nextMode cycle", () => {
  assert.equal(nextMode("suggest"), "auto-edit");
  assert.equal(nextMode("auto-edit"), "full-auto");
  assert.equal(nextMode("full-auto"), "suggest");
  assert.ok(ctxPctFor("claude-haiku-4-5", 20000) > 0); // 200k window → ~10%
  assert.equal(ctxPctFor("any", 0), 0);
});
