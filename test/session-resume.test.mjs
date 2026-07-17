import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, parse, resolve } from "node:path";
import { saveSession } from "../dist/session/store.js";
import { displaySessionCwd, resolveSessionResumeTarget } from "../dist/session/resume.js";

function withIsolatedSessions(run) {
  const home = mkdtempSync(join(tmpdir(), "hara-resume-home-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    return run(home);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
}

function seedSession(id, cwd, updatedAt = "2026-07-17T12:00:00.000Z") {
  saveSession({
    id,
    cwd,
    provider: "qwen",
    model: "glm-5",
    title: `session ${id}`,
    createdAt: updatedAt,
    updatedAt: "",
  }, [{ role: "user", content: `task ${id}` }]);
}

test("explicit session resume re-roots to the persisted project instead of the launcher cwd", () => {
  withIsolatedSessions((home) => {
    const project = join(home, "Projects", "video");
    const launcher = join(home, "Downloads");
    mkdirSync(project, { recursive: true });
    mkdirSync(launcher, { recursive: true });
    seedSession("resume-project", project);

    const target = resolveSessionResumeTarget("resume-pro", launcher);
    assert.equal(target.ok, true);
    assert.equal(target.id, "resume-project");
    assert.equal(target.cwd, realpathSync.native(resolve(project)));
    assert.equal(target.meta.cwd, project);
  });
});

test("bare resume remains scoped to the current project", () => {
  withIsolatedSessions((home) => {
    const projectA = join(home, "Projects", "a");
    const projectB = join(home, "Projects", "b");
    mkdirSync(projectA, { recursive: true });
    mkdirSync(projectB, { recursive: true });
    seedSession("project-a", projectA, "2026-07-17T12:00:00.000Z");
    seedSession("project-b", projectB, "2026-07-17T13:00:00.000Z");

    const target = resolveSessionResumeTarget(undefined, projectA);
    assert.equal(target.ok, true);
    assert.equal(target.id, "project-a");
    assert.equal(resolveSessionResumeTarget(undefined, home).reason, "no-current");
  });
});

test("resume fails closed when the saved project disappeared or the session is unreadable", () => {
  withIsolatedSessions((home) => {
    const missing = join(home, "Projects", "deleted");
    seedSession("missing-project", missing);
    assert.deepEqual(
      resolveSessionResumeTarget("missing-project", home),
      { ok: false, reason: "cwd-unavailable", id: "missing-project", cwd: missing },
    );

    const sessions = join(home, ".hara", "sessions");
    writeFileSync(join(sessions, "corrupt.json"), "{not-json");
    assert.deepEqual(
      resolveSessionResumeTarget("corrupt", home),
      { ok: false, reason: "unreadable", id: "corrupt" },
    );
  });
});

test("session cwd display keeps project identity while shortening the home prefix", () => {
  const home = homedir();
  const separator = process.platform === "win32" ? "\\" : "/";
  const outside = join(parse(home).root, "hara-outside");
  assert.equal(displaySessionCwd(join(home, "work", "demo"), home), `~${separator}work${separator}demo`);
  assert.equal(displaySessionCwd(outside, home), outside);
});
