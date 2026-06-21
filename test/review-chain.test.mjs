import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVerdict, captureChanges, reviewPrompt, fixPrompt, REVIEWER_SYSTEM } from "../dist/org/review-chain.js";

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

test("parseVerdict: tolerates markdown / quote prefixes on the verdict line", () => {
  assert.equal(parseVerdict("> **VERDICT: APPROVED**").approved, true);
  assert.equal(parseVerdict("- VERDICT: CHANGES_REQUESTED").approved, false);
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
