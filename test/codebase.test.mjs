import { test } from "node:test";
import assert from "node:assert/strict";
import { linkSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTool } from "../dist/tools/registry.js";
import "../dist/tools/codebase.js";

function tmpProject() {
  const dir = join(tmpdir(), "hara-cb-" + Math.random().toString(36).slice(2));
  mkdirSync(join(dir, ".git"), { recursive: true }); // anchors findProjectRoot; git ls-files fails → walkFiles
  return dir;
}

test("codebase_search: ranks repo files by relevance, returns file:line + snippet", async () => {
  const proj = tmpProject();
  mkdirSync(join(proj, "src"), { recursive: true });
  writeFileSync(join(proj, "src", "auth.ts"), "export function loginUser(token) {\n  // verify the auth token and refresh the session\n  return validateToken(token);\n}\n");
  writeFileSync(join(proj, "src", "math.ts"), "export const add = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\n");
  try {
    const r = await getTool("codebase_search").run({ query: "verify auth token refresh" }, { cwd: proj });
    assert.match(r, /src\/auth\.ts:\d+/, "finds the relevant file with a line number");
    assert.match(r, /verify the auth token/, "returns the relevant snippet");
    assert.doesNotMatch(r, /math\.ts/, "irrelevant file excluded (too few query words)");
  } finally {
    rmSync(proj, { recursive: true, force: true });
  }
});

test("codebase_search: empty query + no-match give friendly messages", async () => {
  const proj = tmpProject();
  writeFileSync(join(proj, "a.ts"), "const x = 1;\n");
  try {
    assert.match(await getTool("codebase_search").run({ query: "" }, { cwd: proj }), /empty query/);
    assert.match(await getTool("codebase_search").run({ query: "nonexistent zzzzz qqqqq" }, { cwd: proj }), /no relevant code/);
  } finally {
    rmSync(proj, { recursive: true, force: true });
  }
});

test("codebase_search refuses an implicit home corpus but accepts an explicit project child", async () => {
  const home = join(tmpdir(), "hara-cb-home-" + Math.random().toString(36).slice(2));
  const project = join(home, "project");
  mkdirSync(join(project, ".git"), { recursive: true });
  writeFileSync(join(project, "auth.ts"), "export const homeBoundaryProjectNeedle = true;\n");
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const tool = getTool("codebase_search");
    assert.match(
      await tool.run({ query: "home boundary project needle" }, { cwd: home }),
      /will not recursively scan the home directory/i,
    );
    assert.match(
      await tool.run({ query: "home boundary project needle", path: "project" }, { cwd: home }),
      /auth\.ts:\d+/,
      "an explicitly selected child project remains searchable",
    );
    assert.match(
      await tool.run({ query: "home boundary project needle", path: ".." }, { cwd: home }),
      /will not recursively scan the home directory/i,
      "an ancestor root must not recurse back through Home",
    );
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("codebase_search reads candidates through a verified no-follow descriptor", { skip: process.platform === "win32" }, async () => {
  const root = join(tmpdir(), "hara-cb-identity-" + Math.random().toString(36).slice(2));
  const home = join(root, "home");
  const project = join(home, "project");
  mkdirSync(project, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: project });
  const tracked = join(project, "tracked.ts");
  writeFileSync(tracked, "export const harmless = true;\n");
  execFileSync("git", ["add", "tracked.ts"], { cwd: project });
  const secret = join(home, ".env");
  writeFileSync(secret, "CODEBASE_PRIVATE_NEEDLE=must_not_escape\n");
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    rmSync(tracked);
    symlinkSync(secret, tracked);
    let result = await getTool("codebase_search").run({ query: "codebase private needle", path: project }, { cwd: project });
    assert.doesNotMatch(result, /must_not_escape|CODEBASE_PRIVATE_NEEDLE/);

    rmSync(tracked);
    linkSync(secret, tracked);
    result = await getTool("codebase_search").run({ query: "codebase private needle", path: project }, { cwd: project });
    assert.doesNotMatch(result, /must_not_escape|CODEBASE_PRIVATE_NEEDLE/);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(root, { recursive: true, force: true });
  }
});
