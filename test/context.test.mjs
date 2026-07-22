import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, linkSync, mkdtempSync, realpathSync, rmSync, writeFileSync, mkdirSync, readFileSync, symlinkSync, utimesSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadAgentContext, loadAgentsMd, hasAgentsMd, hasProjectContent, findProjectRoot } from "../dist/context/agents-md.js";
import { canonicalWorkspacePath, discoverProjectWorkspaces, isHomeWorkspace, suggestedProjectWorkspace } from "../dist/context/workspace-scope.js";
import { expandMentions, expandMentionsAsync, fileCandidates } from "../dist/context/mentions.js";
import { needsConfirm } from "../dist/agent/loop.js";
import "../dist/tools/edit.js";
import "../dist/tools/builtin.js";
import "../dist/tools/patch.js";
import { getTool } from "../dist/tools/registry.js";

test("approval gate: needsConfirm per mode/kind", () => {
  // read is never gated
  assert.equal(needsConfirm("read", "suggest"), false);
  // suggest: confirm edit + exec
  assert.equal(needsConfirm("edit", "suggest"), true);
  assert.equal(needsConfirm("exec", "suggest"), true);
  // auto-edit: auto file edits, still confirm exec
  assert.equal(needsConfirm("edit", "auto-edit"), false);
  assert.equal(needsConfirm("exec", "auto-edit"), true);
  // full-auto: nothing prompts
  assert.equal(needsConfirm("edit", "full-auto"), false);
  assert.equal(needsConfirm("exec", "full-auto"), false);
});

test("Home startup suggestion uses only an existing safe candidate and skips stale/Home paths", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-home-suggest-"));
  const project = join(home, "work", "project");
  mkdirSync(project, { recursive: true });
  try {
    assert.equal(
      suggestedProjectWorkspace([home, join(home, "gone"), project], home),
      realpathSync.native(project),
    );
    assert.equal(suggestedProjectWorkspace([home, join(home, "gone")], home), undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Home fallback prefers a recently active real project and ignores legacy AGENTS-only directories", { skip: process.platform === "win32" }, () => {
  const home = mkdtempSync(join(tmpdir(), "hara-home-discovery-"));
  const actual = join(home, "Projects", "南荒程序员", "feishu-bot");
  const older = join(home, "Projects", "older-project");
  const python = join(home, "Projects", "python-project");
  const legacy = join(home, "design");
  const privatePackage = join(home, "Documents", "private-package");
  mkdirSync(join(actual, ".git"), { recursive: true });
  mkdirSync(join(older, ".git"), { recursive: true });
  mkdirSync(python, { recursive: true });
  mkdirSync(legacy, { recursive: true });
  mkdirSync(privatePackage, { recursive: true });
  writeFileSync(join(actual, "package.json"), "{}\n");
  writeFileSync(join(python, "pyproject.toml"), "[project]\nname = 'python-project'\n");
  writeFileSync(join(legacy, "AGENTS.md"), "legacy only\n");
  writeFileSync(join(privatePackage, "package.json"), "{}\n");
  symlinkSync(privatePackage, join(home, "Projects", "private-link"), "dir");
  const old = new Date("2026-06-30T00:00:00Z");
  const recent = new Date("2026-07-21T08:00:00Z");
  utimesSync(older, old, old);
  utimesSync(join(older, ".git"), old, old);
  utimesSync(join(python, "pyproject.toml"), old, old);
  utimesSync(actual, old, old);
  utimesSync(join(actual, ".git"), recent, recent);
  utimesSync(join(actual, "package.json"), recent, recent);
  try {
    const discovered = discoverProjectWorkspaces(home);
    assert.equal(discovered[0], realpathSync.native(actual));
    assert.ok(discovered.includes(realpathSync.native(older)));
    assert.ok(discovered.includes(realpathSync.native(python)), "pyproject.toml discovers non-Node projects");
    assert.ok(!discovered.includes(realpathSync.native(legacy)), "AGENTS.md alone is not project evidence");
    assert.ok(!discovered.includes(realpathSync.native(privatePackage)), "non-project Home roots and symlink escapes are not scanned");
    assert.equal(
      suggestedProjectWorkspace([...discovered, legacy], home),
      realpathSync.native(actual),
      "bounded discovery outranks an old registered AGENTS-only directory",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("agents-md: finds root via .git and loads AGENTS.md from an ancestor", () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-ctx-"));
  try {
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, "AGENTS.md"), "# Test Project\nbuild: npm run build");
    const sub = join(dir, "src");
    mkdirSync(sub);
    assert.equal(findProjectRoot(sub), dir);
    assert.ok(hasAgentsMd(sub));
    const ctx = loadAgentsMd(sub);
    assert.match(ctx, /Test Project/);
    assert.match(ctx, /npm run build/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("agents-md: no file → empty string + hasAgentsMd false", () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-ctx-"));
  try {
    mkdirSync(join(dir, ".git"));
    assert.equal(hasAgentsMd(dir), false);
    assert.equal(loadAgentsMd(dir), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("agents-md: first-run offer distinguishes an empty directory from a real project", () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-empty-project-"));
  try {
    assert.equal(hasProjectContent(dir), false);
    writeFileSync(join(dir, ".DS_Store"), "");
    writeFileSync(join(dir, ".gitkeep"), "");
    assert.equal(hasProjectContent(dir), false, "OS placeholders do not turn an empty folder into a project");

    writeFileSync(join(dir, "README.md"), "# real content\n");
    assert.equal(hasProjectContent(dir), true);
    rmSync(join(dir, "README.md"));
    mkdirSync(join(dir, ".git"));
    assert.equal(hasProjectContent(dir), true, "a project marker is sufficient even before source files exist");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("workspace scope: canonical home and its symlink alias get guidance; a real project does not", () => {
  const root = mkdtempSync(join(tmpdir(), "hara-home-scope-"));
  const home = join(root, "home");
  const alias = join(root, "home-alias");
  const project = join(home, "project");
  mkdirSync(project, { recursive: true });
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, "AGENTS.md"), "PARENT_CONTEXT_MUST_NOT_REACH_HOME\n");
  symlinkSync(home, alias, process.platform === "win32" ? "junction" : "dir");
  try {
    assert.equal(canonicalWorkspacePath(alias), canonicalWorkspacePath(home));
    assert.equal(isHomeWorkspace(home, home), true);
    assert.equal(isHomeWorkspace(alias, home), true, "realpath closes a symlink alias bypass");
    assert.equal(isHomeWorkspace(project, home), false);

    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      assert.match(loadAgentContext(alias), /Home-directory workspace boundary/);
      assert.match(loadAgentContext(alias), /cd \/path\/to\/project/);
      assert.doesNotMatch(loadAgentContext(alias), /PARENT_CONTEXT_MUST_NOT_REACH_HOME/);
      assert.equal(findProjectRoot(home), home, "Home cannot inherit a marker above it");
      assert.equal(findProjectRoot(alias), alias, "a canonical Home alias cannot inherit a parent marker");
      assert.equal(loadAgentContext(project), "", "normal child project context is unchanged without AGENTS.md");
      writeFileSync(join(home, "package.json"), "{}");
      assert.equal(findProjectRoot(project), project, "a marker at Home never widens an explicit child into a Home-sized project");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("agents-md: an oversized instruction file keeps a verified prefix within the 32 KiB total budget", () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-ctx-large-"));
  try {
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, "AGENTS.md"), `# KEEP-THIS-PREFIX\n${"规则🙂".repeat(20_000)}\nDROP-THIS-TAIL`);
    const ctx = loadAgentsMd(dir);
    assert.match(ctx, /KEEP-THIS-PREFIX/);
    assert.match(ctx, /truncated to project-context budget/);
    assert.doesNotMatch(ctx, /DROP-THIS-TAIL/);
    assert.ok(Buffer.byteLength(ctx, "utf8") <= 32 * 1024, "headers, content, and marker share one byte budget");
    assert.doesNotMatch(ctx, /�$/, "the prefix never ends with a split UTF-8 code point");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("agents-md: a symlink or hard-link alias cannot inject .env into project context", () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-ctx-protected-"));
  const previous = process.env.HARA_ALLOW_SENSITIVE_FILES;
  delete process.env.HARA_ALLOW_SENSITIVE_FILES;
  try {
    mkdirSync(join(dir, ".git"));
    const secret = join(dir, ".env");
    writeFileSync(secret, "MODEL_CONTEXT_SECRET=must-not-leak\n");

    symlinkSync(secret, join(dir, "AGENTS.md"));
    assert.doesNotMatch(loadAgentsMd(dir), /must-not-leak/);
    rmSync(join(dir, "AGENTS.md"));

    linkSync(secret, join(dir, "AGENTS.md"));
    assert.doesNotMatch(loadAgentsMd(dir), /must-not-leak/);
  } finally {
    if (previous === undefined) delete process.env.HARA_ALLOW_SENSITIVE_FILES;
    else process.env.HARA_ALLOW_SENSITIVE_FILES = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mentions: @path expands to fenced file contents", () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-ctx-"));
  try {
    writeFileSync(join(dir, "note.txt"), "hello-from-file");
    const o = expandMentions("please read @note.txt now", dir);
    assert.match(o, /Referenced file `note\.txt`/);
    assert.match(o, /hello-from-file/);
    // expanded INLINE at the @ position, not appended at the bottom: content lands before "now"
    assert.ok(o.indexOf("hello-from-file") < o.lastIndexOf("now"), "file content is inline, before the trailing text");
    assert.ok(o.startsWith("please read "), "text before the mention is preserved");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mentions: email-like a@b.com is NOT treated as a file mention", () => {
  const o = expandMentions("mail me at a@b.com please", process.cwd());
  assert.equal(o, "mail me at a@b.com please");
});

test("mentions: binary files are described but never injected as text", () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-ctx-"));
  try {
    writeFileSync(join(dir, "blob.bin"), Buffer.from([1, 2, 0, 3]));
    const out = expandMentions("inspect @blob.bin", dir);
    assert.match(out, /appears to be binary/i);
    assert.ok(!out.includes("\u0000"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mentions: Home ancestors report the recursive workspace boundary instead of pretending to be empty", async () => {
  const ancestor = dirname(homedir());
  const input = `inspect @${ancestor}`;
  assert.match(expandMentions(input, process.cwd()), /will not recursively scan the home directory/i);
  assert.match(await expandMentionsAsync(input, process.cwd()), /will not recursively scan the home directory/i);
});

test("mentions: a Home-root session cannot expand a model-selected child directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "hara-ctx-home-child-"));
  const home = join(root, "home");
  const project = join(home, "projects", "demo");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "private-context.txt"), "must-not-be-inventoried\n");
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const input = "inspect @projects";
    assert.match(expandMentions(input, home), /will not.*directories.*home directory/i);
    assert.match(await expandMentionsAsync(input, home), /will not.*directories.*home directory/i);
    assert.doesNotMatch(expandMentions(input, home), /private-context/);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(root, { recursive: true, force: true });
  }
});

test("Home scope: autocomplete and coding mutations cannot inventory or promote a child project", async () => {
  const root = mkdtempSync(join(tmpdir(), "hara-ctx-home-coding-"));
  const home = join(root, "home");
  const alias = join(root, "home-alias");
  const project = join(home, "projects", "demo");
  const homeFile = join(home, "home-note.txt");
  mkdirSync(project, { recursive: true });
  writeFileSync(homeFile, "original\n");
  writeFileSync(join(project, "project-note.txt"), "project\n");
  symlinkSync(home, alias, process.platform === "win32" ? "junction" : "dir");
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    assert.deepEqual(fileCandidates(home, ""), [], "bare @ cannot enumerate Home");
    assert.deepEqual(fileCandidates(home, "project"), [], "a query cannot discover a named Home child");
    assert.deepEqual(fileCandidates(alias, "note"), [], "a symlink alias cannot bypass the Home boundary");
    assert.ok(fileCandidates(project, "note").includes("project-note.txt"), "an explicitly selected project keeps normal completion");

    for (const name of ["write_file", "edit_file", "apply_patch"]) {
      assert.equal(getTool(name).requiresProjectWorkspace, true, `${name} declares its project boundary`);
    }
    const edit = await getTool("edit_file").run(
      { path: "home-note.txt", old_string: "original", new_string: "changed" },
      { cwd: alias },
    );
    assert.match(edit, /home directory.*cd \/path\/to\/project/i);
    assert.equal(readFileSync(homeFile, "utf8"), "original\n", "Home file stays unchanged");

    const write = await getTool("write_file").run({ path: "new.txt", content: "nope" }, { cwd: home });
    assert.match(write, /home directory.*cd \/path\/to\/project/i);
    assert.equal(existsSync(join(home, "new.txt")), false);

    const ancestorWrite = await getTool("write_file").run({ path: "ancestor-new.txt", content: "nope" }, { cwd: root });
    assert.match(ancestorWrite, /home directory.*cd \/path\/to\/project/i);
    assert.equal(existsSync(join(root, "ancestor-new.txt")), false, "an ancestor scope cannot mutate and descend into Home");

    const patched = await getTool("apply_patch").run(
      { changes: [{ path: "patched.txt", type: "create", content: "nope" }] },
      { cwd: home },
    );
    assert.match(patched, /home directory.*cd \/path\/to\/project/i);
    assert.equal(existsSync(join(home, "patched.txt")), false);

    const projectWrite = await getTool("write_file").run({ path: "created.txt", content: "ok" }, { cwd: project });
    assert.match(projectWrite, /Wrote 2 chars/);
    assert.equal(readFileSync(join(project, "created.txt"), "utf8"), "ok");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(root, { recursive: true, force: true });
  }
});

test("edit_file: single unique replacement", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-ctx-"));
  try {
    const p = join(dir, "f.txt");
    writeFileSync(p, "alpha beta gamma");
    const r = await getTool("edit_file").run({ path: "f.txt", old_string: "beta", new_string: "BETA" }, { cwd: dir });
    assert.match(r, /1 replacement/);
    assert.equal(readFileSync(p, "utf8"), "alpha BETA gamma");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edit_file: ambiguous match errors unless replace_all", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-ctx-"));
  try {
    const p = join(dir, "f.txt");
    writeFileSync(p, "x x x");
    const err = await getTool("edit_file").run({ path: "f.txt", old_string: "x", new_string: "y" }, { cwd: dir });
    assert.match(err, /appears 3/);
    const ok = await getTool("edit_file").run({ path: "f.txt", old_string: "x", new_string: "y", replace_all: true }, { cwd: dir });
    assert.match(ok, /3 replacements/);
    assert.equal(readFileSync(p, "utf8"), "y y y");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
