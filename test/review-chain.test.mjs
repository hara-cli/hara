import { test } from "node:test";
import assert from "node:assert/strict";
import { linkSync, mkdtempSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  parseVerdict,
  captureChanges,
  reviewPrompt,
  fixPrompt,
  REVIEWER_SYSTEM,
  isTreeClean,
  stripCommitFence,
  commitMessageInput,
  protectedStagedPaths,
  protectedTrackedWorkingTreePaths,
  protectedWorkingTreePaths,
} from "../dist/org/review-chain.js";

test("parseVerdict: APPROVED", () => {
  assert.equal(parseVerdict("Looks correct and safe.\nVERDICT: APPROVED").approved, true);
});

test("parseVerdict: CHANGES_REQUESTED keeps the issue body, strips the verdict line", () => {
  const v = parseVerdict("1. foo.ts: null check missing\n2. bar.ts: leak\nVERDICT: CHANGES_REQUESTED");
  assert.equal(v.approved, false);
  assert.match(v.issues, /null check missing/);
  assert.ok(!/VERDICT/.test(v.issues), "verdict line not in the issues fed back to the implementer");
});

test("parseVerdict: takes the LAST verdict (a reviewer may quote the protocol earlier)", () => {
  assert.equal(parseVerdict("VERDICT: CHANGES_REQUESTED would mean...\n\nActually fixed.\nVERDICT: APPROVED").approved, true);
});

test("parseVerdict: no verdict line → NOT approved (never assume approval we can't see)", () => {
  assert.equal(parseVerdict("seems fine to me?").approved, false);
});

test("parseVerdict: tolerates markdown around the marker AND the token (real model drift)", () => {
  assert.equal(parseVerdict("> **VERDICT: APPROVED**").approved, true);
  assert.equal(parseVerdict("- VERDICT: CHANGES_REQUESTED").approved, false);
  assert.equal(parseVerdict("**VERDICT**: APPROVED").approved, true);
  assert.equal(parseVerdict("**VERDICT**: CHANGES_REQUESTED").approved, false);
  assert.equal(parseVerdict("VERDICT** : CHANGES REQUESTED").approved, false);
});

test("parseVerdict: recognizes natural-language verdicts (the exact shapes glm-5 emitted in live smokes)", () => {
  assert.equal(parseVerdict("**VERDICT**: PASS").approved, true);
  assert.equal(parseVerdict("**VERDICT**: No issues found. Looks great!").approved, true);
  assert.equal(parseVerdict("VERDICT: LGTM").approved, true);
  assert.equal(parseVerdict("VERDICT: FAIL — see notes above").approved, false);
  assert.equal(parseVerdict("VERDICT: Rejected, needs rework").approved, false);
  assert.equal(parseVerdict("VERDICT: not approved — fix the leak").approved, false, "'not approved' must veto despite containing 'approv'");
});

test("parseVerdict: a VERDICT with an ambiguous phrase stays NOT approved (never a blind auto-approve)", () => {
  assert.equal(parseVerdict("VERDICT: done").approved, false);
});

test("reviewPrompt: task + status metadata + new files + asks for a verdict", () => {
  const p = reviewPrompt("add retries", { diff: "M\tx.ts", newFiles: ["x.ts"] });
  assert.match(p, /add retries/);
  assert.match(p, /```text/);
  assert.match(p, /historical patch contents are intentionally omitted/i);
  assert.match(p, /x\.ts/);
  assert.match(p, /VERDICT/);
});

test("fixPrompt restates the reviewer's issues as an instruction to edit", () => {
  assert.match(fixPrompt("1. fix the leak in foo.ts"), /fix the leak in foo\.ts/);
});

test("captureChanges: {diff, newFiles} shape, no throw (this git repo)", () => {
  const ch = captureChanges(process.cwd());
  assert.equal(typeof ch.diff, "string");
  assert.ok(Array.isArray(ch.newFiles));
  assert.ok(Array.isArray(ch.omittedDeletions));
});

test("captureChanges: non-git dir → empty, never throws", () => {
  const ch = captureChanges("/");
  assert.equal(ch.diff, "");
  assert.deepEqual(ch.newFiles, []);
});

test("captureChanges: NUL-safe path filtering omits protected diffs/untracked files without leaking contents", () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-review-protected-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.co");
    git("config", "user.name", "t");
    writeFileSync(join(dir, "safe.txt"), "safe before\n");
    writeFileSync(join(dir, ".env"), "TOKEN=old-value\n");
    git("add", "-A");
    git("commit", "-qm", "init");

    writeFileSync(join(dir, "safe.txt"), "safe after\n");
    writeFileSync(join(dir, ".env"), "TOKEN=DIFF_SECRET_MUST_NOT_LEAK\n");
    linkSync(join(dir, ".env"), join(dir, "innocent-name.txt"));
    writeFileSync(join(dir, "credentials.json"), "UNTRACKED_SECRET_MUST_NOT_LEAK\n");
    writeFileSync(join(dir, "new\nline.txt"), "newline-safe\n");

    const changes = captureChanges(dir);
    assert.equal(changes.error, undefined);
    assert.match(changes.diff, /^M\tsafe\.txt$/m);
    assert.doesNotMatch(changes.diff, /safe before|safe after/);
    assert.doesNotMatch(changes.diff, /DIFF_SECRET_MUST_NOT_LEAK|UNTRACKED_SECRET_MUST_NOT_LEAK/);
    assert.ok(changes.skippedFiles.includes(".env"));
    assert.ok(changes.skippedFiles.includes("credentials.json"));
    assert.ok(changes.skippedFiles.includes("innocent-name.txt"), "hard-link aliases fail closed even with a safe basename");
    assert.ok(changes.newFiles.includes("new\nline.txt"), "newline filename survives NUL parsing as one path");
    const prompt = reviewPrompt("review", changes);
    assert.doesNotMatch(prompt, /DIFF_SECRET_MUST_NOT_LEAK|UNTRACKED_SECRET_MUST_NOT_LEAK/);
    assert.match(prompt, /new\\nline\.txt/, "control characters in path labels are escaped in the prompt");

    assert.ok(protectedWorkingTreePaths(dir).includes(".env"));
    git("add", ".env");
    assert.ok(protectedStagedPaths(dir).includes(".env"));
    const staged = captureChanges(dir, 100_000, { staged: true });
    assert.equal(staged.diff, "");
    assert.ok(staged.skippedFiles.includes(".env"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("captureChanges skips unverifiable deleted blobs from historical hard-link aliases", () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-review-deleted-hardlink-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  const marker = "HISTORICAL_DELETED_SECRET_MUST_NOT_LEAK";
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.co");
    git("config", "user.name", "t");
    writeFileSync(join(dir, ".env"), `${marker}=value\n`);
    linkSync(join(dir, ".env"), join(dir, "innocent.txt"));
    git("add", "-A");
    git("commit", "-qm", "historical alias");

    unlinkSync(join(dir, "innocent.txt"));
    const changes = captureChanges(dir);
    assert.ok(changes.omittedDeletions.includes("innocent.txt"));
    assert.ok(!changes.skippedFiles.includes("innocent.txt"));
    assert.ok(!protectedWorkingTreePaths(dir).includes("innocent.txt"));
    assert.doesNotMatch(changes.diff, new RegExp(marker));
    assert.doesNotMatch(reviewPrompt("review deletion", changes), new RegExp(marker));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ordinary tracked deletions omit historical blobs but remain stageable and commit-message visible", () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-review-safe-deletion-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  const marker = "ORDINARY_DELETED_HISTORY_MUST_NOT_REACH_MODEL";
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.co");
    git("config", "user.name", "t");
    writeFileSync(join(dir, "ordinary.txt"), `${marker}\n`);
    git("add", "-A");
    git("commit", "-qm", "initial file");

    unlinkSync(join(dir, "ordinary.txt"));
    const working = captureChanges(dir);
    assert.deepEqual(working.omittedDeletions, ["ordinary.txt"]);
    assert.deepEqual(working.skippedFiles, []);
    assert.equal(protectedWorkingTreePaths(dir).includes("ordinary.txt"), false);
    assert.equal(protectedTrackedWorkingTreePaths(dir).includes("ordinary.txt"), false);
    assert.doesNotMatch(working.diff, new RegExp(marker));
    assert.doesNotMatch(reviewPrompt("delete obsolete file", working), new RegExp(marker));

    git("add", "-A");
    assert.equal(protectedStagedPaths(dir).includes("ordinary.txt"), false);
    const staged = captureChanges(dir, 100_000, { staged: true, includeUntracked: false });
    assert.deepEqual(staged.omittedDeletions, ["ordinary.txt"]);
    assert.deepEqual(staged.skippedFiles, []);
    const commitInput = commitMessageInput(staged);
    assert.match(commitInput, /ordinary\.txt/);
    assert.match(commitInput, /historical file contents intentionally omitted/i);
    assert.doesNotMatch(commitInput, new RegExp(marker));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lexically sensitive deletions stay protected and never become ordinary omitted deletions", () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-review-sensitive-deletion-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  const marker = "SENSITIVE_DELETED_HISTORY_MUST_NOT_REACH_MODEL";
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.co");
    git("config", "user.name", "t");
    writeFileSync(join(dir, ".env"), `${marker}=value\n`);
    git("add", "-A");
    git("commit", "-qm", "historical sensitive file");

    unlinkSync(join(dir, ".env"));
    const working = captureChanges(dir);
    assert.ok(working.skippedFiles.includes(".env"));
    assert.deepEqual(working.omittedDeletions, []);
    assert.ok(protectedWorkingTreePaths(dir).includes(".env"));
    assert.ok(protectedTrackedWorkingTreePaths(dir).includes(".env"));
    assert.doesNotMatch(working.diff, new RegExp(marker));

    git("add", "-A");
    assert.ok(protectedStagedPaths(dir).includes(".env"));
    const staged = captureChanges(dir, 100_000, { staged: true, includeUntracked: false });
    assert.ok(staged.skippedFiles.includes(".env"));
    assert.deepEqual(staged.omittedDeletions, []);
    assert.doesNotMatch(reviewPrompt("remove sensitive state", staged), new RegExp(marker));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("token-shaped deleted path labels are redacted everywhere model-facing", () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-review-token-path-deletion-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  const tokenPath = "sk-reviewfilename123456789.txt";
  const marker = "TOKEN_PATH_DELETED_HISTORY_MUST_NOT_REACH_MODEL";
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.co");
    git("config", "user.name", "t");
    writeFileSync(join(dir, tokenPath), `${marker}\n`);
    git("add", "-A");
    git("commit", "-qm", "token-shaped path fixture");
    unlinkSync(join(dir, tokenPath));

    const changes = captureChanges(dir);
    const serialized = JSON.stringify(changes);
    const prompt = reviewPrompt("remove fixture", changes);
    const commitInput = commitMessageInput(changes);
    for (const output of [serialized, prompt, commitInput]) {
      assert.doesNotMatch(output, new RegExp(tokenPath));
      assert.doesNotMatch(output, new RegExp(marker));
    }
    assert.deepEqual(changes.omittedDeletions, ["sk-***.txt"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("staged AD is not a deletion: direct staged inspection fails closed, add -A collapses to no net change", () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-review-staged-ad-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.co");
    git("config", "user.name", "t");
    writeFileSync(join(dir, "README.md"), "fixture\n");
    git("add", "-A");
    git("commit", "-qm", "initial fixture");

    writeFileSync(join(dir, "added.txt"), "staged addition\n");
    git("add", "added.txt");
    unlinkSync(join(dir, "added.txt"));

    const finalWorktree = captureChanges(dir);
    assert.deepEqual(finalWorktree.omittedDeletions, [], "HEAD to final worktree has no deletion");
    assert.equal(protectedWorkingTreePaths(dir).includes("added.txt"), false, "git add -A will collapse AD to clean");

    const cached = captureChanges(dir, 100_000, { staged: true, includeUntracked: false });
    assert.deepEqual(cached.omittedDeletions, [], "cached A must never be mislabeled D from worktree ENOENT");
    assert.ok(cached.skippedFiles.includes("added.txt"));
    assert.ok(protectedStagedPaths(dir).includes("added.txt"), "direct commit cannot verify the missing staged A blob");

    git("add", "-A");
    const afterAddAll = captureChanges(dir, 100_000, { staged: true, includeUntracked: false });
    assert.deepEqual(afterAddAll.omittedDeletions, []);
    assert.equal(commitMessageInput(afterAddAll), "", "net-clean AD is correctly reported as nothing to commit");
    assert.deepEqual(protectedStagedPaths(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ordinary modification metadata never includes a historical hard-link secret old side", () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-review-historical-modification-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  const marker = "HISTORICAL_MODIFICATION_HARDLINK_SECRET_MUST_NOT_LEAK";
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.co");
    git("config", "user.name", "t");
    writeFileSync(join(dir, ".env"), `${marker}=value\n`);
    linkSync(join(dir, ".env"), join(dir, "innocent.txt"));
    git("add", "-A");
    git("commit", "-qm", "historical alias");

    unlinkSync(join(dir, "innocent.txt"));
    writeFileSync(join(dir, "innocent.txt"), "current verified safe content\n");
    const working = captureChanges(dir);
    assert.equal(working.diff, "M\tinnocent.txt");
    assert.equal(protectedWorkingTreePaths(dir).includes("innocent.txt"), false);
    for (const output of [working.diff, reviewPrompt("replace historical alias", working), commitMessageInput(working)]) {
      assert.doesNotMatch(output, new RegExp(marker));
      assert.doesNotMatch(output, /current verified safe content/, "capture is metadata-only; reviewer reads current files separately");
    }

    git("add", "-A");
    assert.equal(protectedStagedPaths(dir).includes("innocent.txt"), false, "fresh index blob equals verified worktree");
    const staged = captureChanges(dir, 100_000, { staged: true, includeUntracked: false });
    assert.equal(staged.diff, "M\tinnocent.txt");
    assert.doesNotMatch(commitMessageInput(staged), new RegExp(marker));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a dangerous staged blob diverging from a safe worktree is metadata-only and blocked from commit", () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-review-staged-divergence-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  const marker = "STAGED_DANGEROUS_BLOB_MUST_NOT_LEAK";
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.co");
    git("config", "user.name", "t");
    writeFileSync(join(dir, "README.md"), "fixture\n");
    git("add", "-A");
    git("commit", "-qm", "initial fixture");

    writeFileSync(join(dir, ".env"), `${marker}=value\n`);
    linkSync(join(dir, ".env"), join(dir, "innocent.txt"));
    git("add", "innocent.txt");
    unlinkSync(join(dir, "innocent.txt"));
    writeFileSync(join(dir, "innocent.txt"), "safe replacement\n");
    unlinkSync(join(dir, ".env"));

    const staged = captureChanges(dir, 100_000, { staged: true, includeUntracked: false });
    assert.equal(staged.diff, "A\tinnocent.txt");
    assert.doesNotMatch(JSON.stringify(staged), new RegExp(marker));
    assert.doesNotMatch(commitMessageInput(staged), new RegExp(marker));
    assert.ok(protectedStagedPaths(dir).includes("innocent.txt"), "index blob does not equal verified current bytes");

    git("add", "-A");
    assert.equal(protectedStagedPaths(dir).includes("innocent.txt"), false, "restaging the safe replacement repairs parity");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("REVIEWER_SYSTEM demands both verdict forms", () => {
  assert.match(REVIEWER_SYSTEM, /VERDICT: APPROVED/);
  assert.match(REVIEWER_SYSTEM, /VERDICT: CHANGES_REQUESTED/);
});

test("stripCommitFence removes a wrapping markdown fence (any/no language)", () => {
  assert.equal(stripCommitFence("```\nfix: thing\n```"), "fix: thing");
  assert.equal(stripCommitFence("```text\nfeat: x\n```"), "feat: x");
  assert.equal(stripCommitFence("plain subject\n\nbody"), "plain subject\n\nbody");
});

test("isTreeClean: false for a non-git dir; tracks clean→dirty in a real repo", () => {
  assert.equal(isTreeClean("/"), false, "non-git → never 'clean' (so we never auto-commit blindly)");
  const dir = mkdtempSync(join(tmpdir(), "hara-clean-"));
  const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.co");
    git("config", "user.name", "t");
    writeFileSync(join(dir, "a.txt"), "1");
    git("add", "-A");
    git("commit", "-qm", "init");
    assert.equal(isTreeClean(dir), true, "clean right after a commit");
    writeFileSync(join(dir, "a.txt"), "2");
    assert.equal(isTreeClean(dir), false, "dirty after an edit");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
