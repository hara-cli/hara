import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { parseVerdict, captureChanges, reviewPrompt, fixPrompt, REVIEWER_SYSTEM, isTreeClean, stripCommitFence } from "../dist/org/review-chain.js";

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

test("reviewPrompt: task + diff fence + new files + asks for a verdict", () => {
  const p = reviewPrompt("add retries", { diff: "@@ -1 +1 @@\n-old\n+new", newFiles: ["x.ts"] });
  assert.match(p, /add retries/);
  assert.match(p, /```diff/);
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
});

test("captureChanges: non-git dir → empty, never throws", () => {
  const ch = captureChanges("/");
  assert.equal(ch.diff, "");
  assert.deepEqual(ch.newFiles, []);
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
