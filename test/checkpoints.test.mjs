import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkpoint, listCheckpoints, restoreCheckpoint } from "../dist/checkpoints.js";

const SECRET = "checkpoint-secret-value-864209";

function shadowPaths(home, root) {
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 16);
  const stateDir = join(home, ".hara", "checkpoints", hash);
  return { stateDir, gitDir: join(stateDir, "git"), marker: join(stateDir, "format") };
}

function shadowGit(root, gitDir, args) {
  return execFileSync("git", args, {
    cwd: root,
    env: {
      ...process.env,
      GIT_DIR: gitDir,
      GIT_WORK_TREE: root,
      GIT_AUTHOR_NAME: "hara-test",
      GIT_AUTHOR_EMAIL: "hara-test@local",
      GIT_COMMITTER_NAME: "hara-test",
      GIT_COMMITTER_EMAIL: "hara-test@local",
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

test("shadow-git: checkpoint → edit → restore reverts the file, undoably (isolated HOME)", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-ckpt-home-"));
  const proj = mkdtempSync(join(tmpdir(), "hara-ckpt-proj-"));
  const prev = process.env.HOME;
  process.env.HOME = home; // shadow repo lives under ~/.hara → keep it off the real home
  try {
    writeFileSync(join(proj, "package.json"), "{}"); // project-root marker
    writeFileSync(join(proj, "app.js"), "v1");
    const sha = checkpoint(proj, "first");
    assert.match(sha ?? "", /^[0-9a-f]{7,}$/, "checkpoint returns a short sha");

    writeFileSync(join(proj, "app.js"), "v2-BROKEN"); // the agent "breaks" the file
    checkpoint(proj, "second");
    assert.equal(readFileSync(join(proj, "app.js"), "utf8"), "v2-BROKEN");

    const n = restoreCheckpoint(proj, sha); // roll back to the first checkpoint
    assert.ok(n >= 1, "reports ≥1 file restored");
    assert.equal(readFileSync(join(proj, "app.js"), "utf8"), "v1", "file reverted to the checkpoint");

    const cps = listCheckpoints(proj);
    assert.ok(cps.length >= 3, "first + second + the pre-restore snapshot");
    assert.ok(cps[0].label.startsWith("before restore"), "restore made an undo checkpoint (newest)");

    // a file created AFTER the checkpoint is NOT deleted by restore (safe)
    writeFileSync(join(proj, "new.txt"), "added later");
    writeFileSync(join(proj, "app.js"), "v3-BROKEN");
    assert.ok(restoreCheckpoint(proj, sha) >= 1, "existing files still restore when a newer file is present");
    assert.ok(existsSync(join(proj, "new.txt")), "files created since the checkpoint are left in place");
    assert.equal(readFileSync(join(proj, "app.js"), "utf8"), "v1");
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    rmSync(home, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
});

test("listCheckpoints: empty for a project with no checkpoints yet", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-ckpt-home2-"));
  const proj = mkdtempSync(join(tmpdir(), "hara-ckpt-proj2-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    writeFileSync(join(proj, "package.json"), "{}");
    assert.deepEqual(listCheckpoints(proj), []);
    assert.equal(restoreCheckpoint(proj, "deadbeef"), null); // nothing to restore from
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    rmSync(home, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
});

test("checkpoints refuse canonical Home aliases without creating shadow state, while a child project works", () => {
  const root = mkdtempSync(join(tmpdir(), "hara-ckpt-home-boundary-"));
  const home = join(root, "home");
  const alias = join(root, "home-alias");
  const project = join(home, "project");
  mkdirSync(project, { recursive: true });
  symlinkSync(home, alias, process.platform === "win32" ? "junction" : "dir");
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    writeFileSync(join(home, "personal.txt"), "must not be snapshotted\n");
    assert.equal(checkpoint(home, "home snapshot"), null);
    assert.equal(checkpoint(alias, "alias snapshot"), null);
    assert.deepEqual(listCheckpoints(alias), []);
    assert.equal(restoreCheckpoint(home, "deadbeef"), null);
    assert.equal(existsSync(join(home, ".hara", "checkpoints")), false, "rejection happens before state creation");

    writeFileSync(join(project, "package.json"), "{}");
    writeFileSync(join(project, "app.js"), "project scoped\n");
    assert.match(checkpoint(project, "child project snapshot") ?? "", /^[0-9a-f]{7,}$/);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(root, { recursive: true, force: true });
  }
});

test("restoreCheckpoint aborts without changing files when the pre-restore snapshot fails", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-ckpt-fail-home-"));
  const proj = mkdtempSync(join(tmpdir(), "hara-ckpt-fail-proj-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    writeFileSync(join(proj, "package.json"), "{}");
    writeFileSync(join(proj, "app.js"), "checkpointed\n");
    const sha = checkpoint(proj, "good checkpoint");
    assert.match(sha ?? "", /^[0-9a-f]{7,}$/);

    const { gitDir } = shadowPaths(home, proj);
    const hook = join(gitDir, "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    chmodSync(hook, 0o755);
    writeFileSync(join(proj, "app.js"), "unsaved user work\n");

    assert.equal(restoreCheckpoint(proj, sha), null, "restore fails closed when its safety snapshot fails");
    assert.equal(readFileSync(join(proj, "app.js"), "utf8"), "unsaved user work\n");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
});

test("protected checkpoint format rotates legacy history and never stores sensitive blobs", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-ckpt-rotate-home-"));
  const proj = mkdtempSync(join(tmpdir(), "hara-ckpt-rotate-proj-"));
  const previousHome = process.env.HOME;
  const previousAllow = process.env.HARA_ALLOW_SENSITIVE_FILES;
  process.env.HOME = home;
  delete process.env.HARA_ALLOW_SENSITIVE_FILES;
  const { stateDir, gitDir, marker } = shadowPaths(home, proj);
  let excludeMode;
  try {
    writeFileSync(join(proj, "package.json"), "{}");
    writeFileSync(join(proj, "app.js"), "safe-v1\n");
    writeFileSync(join(proj, ".env"), `API_KEY=${SECRET}\n`);
    writeFileSync(join(proj, "credentials.json"), JSON.stringify({ token: SECRET }));
    writeFileSync(join(proj, ".env.local.example"), "API_KEY=replace-me\n");
    mkdirSync(join(proj, "src", "security"), { recursive: true });
    writeFileSync(join(proj, "src", "security", "secrets.ts"), "export const label = 'not credential data';\n");

    // Simulate a pre-boundary shadow repository that already retained a real secret in history.
    mkdirSync(gitDir, { recursive: true });
    shadowGit(proj, gitDir, ["init", "-q"]);
    shadowGit(proj, gitDir, ["add", "--", ".env", "credentials.json"]);
    shadowGit(proj, gitDir, ["commit", "-q", "--no-gpg-sign", "-m", "legacy secret snapshot"]);
    const legacySha = shadowGit(proj, gitDir, ["rev-parse", "HEAD"]).trim();
    chmodSync(stateDir, 0o755);
    chmodSync(gitDir, 0o755);
    assert.equal(existsSync(marker), false, "legacy repository intentionally has no protected format marker");

    const first = checkpoint(proj, "protected snapshot");
    assert.match(first ?? "", /^[0-9a-f]{7,}$/);
    assert.equal(readFileSync(marker, "utf8"), "protected-files-v2\n");
    assert.throws(
      () => shadowGit(proj, gitDir, ["cat-file", "-e", legacySha]),
      (error) => typeof error?.status === "number" && error.status !== 0,
      "opening the new format must delete the old object database, not merely unstage the path",
    );

    if (process.platform !== "win32") {
      assert.equal(statSync(join(home, ".hara", "checkpoints")).mode & 0o777, 0o700);
      assert.equal(statSync(stateDir).mode & 0o777, 0o700);
      assert.equal(statSync(gitDir).mode & 0o777, 0o700);
      assert.equal(statSync(marker).mode & 0o777, 0o600);
      excludeMode = statSync(join(gitDir, "info", "exclude")).mode & 0o777;
    }

    let names = shadowGit(proj, gitDir, ["ls-tree", "-r", "--name-only", "HEAD"]);
    assert.match(names, /app\.js/);
    assert.match(names, /\.env\.local\.example/, "nested-suffix safe templates remain checkpointable");
    assert.match(names, /src\/security\/secrets\.ts/, "ordinary source files named secrets.ts remain checkpointable");
    assert.ok(!names.includes(".env\n"));
    assert.ok(!names.includes("credentials.json"));
    let objects = shadowGit(proj, gitDir, ["rev-list", "--objects", "--all"]);
    assert.ok(!objects.includes(".env\n"));
    assert.ok(!objects.includes("credentials.json"));

    // Simulate a protected-v2 repository whose index was polluted before a later policy expansion. A
    // pre-add filter must rotate its object database; unstaging alone would leave the old blob reachable.
    shadowGit(proj, gitDir, ["add", "-f", "--", ".env"]);
    shadowGit(proj, gitDir, ["commit", "-q", "--no-gpg-sign", "-m", "forced protected path"]);
    const pollutedSha = shadowGit(proj, gitDir, ["rev-parse", "HEAD"]).trim();
    assert.match(checkpoint(proj, "rotate polluted protected-v2 history") ?? "", /^[0-9a-f]{7,}$/);
    assert.throws(
      () => shadowGit(proj, gitDir, ["cat-file", "-e", pollutedSha]),
      (error) => typeof error?.status === "number" && error.status !== 0,
      "a newly protected tracked path must rotate existing object history",
    );

    // The direct-read escape hatch must not weaken durable-history hygiene.
    process.env.HARA_ALLOW_SENSITIVE_FILES = "1";
    writeFileSync(join(proj, ".env"), `API_KEY=${SECRET}-changed\n`);
    writeFileSync(join(proj, "app.js"), "safe-v2\n");
    assert.match(checkpoint(proj, `API_KEY=${SECRET}`) ?? "", /^[0-9a-f]{7,}$/);
    names = shadowGit(proj, gitDir, ["ls-tree", "-r", "--name-only", "HEAD"]);
    objects = shadowGit(proj, gitDir, ["rev-list", "--objects", "--all"]);
    assert.ok(!names.includes(".env\n"));
    assert.ok(!objects.includes(".env\n"));
    assert.ok(!objects.includes("credentials.json"));
    assert.ok(!shadowGit(proj, gitDir, ["log", "--format=%s"]).includes(SECRET), "checkpoint labels are redacted");
    if (process.platform !== "win32") assert.equal(excludeMode, 0o600, "git/info/exclude must be owner-only");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousAllow === undefined) delete process.env.HARA_ALLOW_SENSITIVE_FILES;
    else process.env.HARA_ALLOW_SENSITIVE_FILES = previousAllow;
    rmSync(home, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
});
