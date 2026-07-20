// Repeat guard (anti-spinning): identical (tool,args) call failing >=2x in a row gets a "stop repeating
// this" note appended to its result; successes never warn and reset the streak.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { failureIdentity, recordCall, looksFailed, keyOf, resetRepeatGuard } from "../dist/agent/repeat-guard.js";

beforeEach(() => resetRepeatGuard());

test("looksFailed: hara's failure-string shapes; success output is not a failure", () => {
  assert.equal(looksFailed("Command failed: exit code 128\nfatal: ..."), true);
  assert.equal(looksFailed("Error: cannot read x.txt"), true);
  assert.equal(looksFailed('Skipped without running: host "github.com" already failed'), true);
  assert.equal(looksFailed("Failed: UI action did not complete"), true);
  assert.equal(looksFailed("Blocked: unsafe content"), true);
  assert.equal(looksFailed("Error is a normal concept in this document."), false, "ordinary prose beginning with Error is not a protocol failure");
  assert.equal(looksFailed("     1\thello"), false);
  assert.equal(looksFailed("Edited src/a.ts: 1 edit, 1 replacement."), false);
});

test("looksFailed: recognizes tool-specific built-in diagnostics without classifying ordinary prose", () => {
  assert.equal(looksFailed("Search failed across available providers (Google: timeout). Check connectivity.", "web_search"), true);
  assert.equal(looksFailed("[codex exit 1]\nbackend failed", "external_agent"), true);
  assert.equal(looksFailed("[claude] failed to start: spawn ENOENT", "external_agent"), true);
  assert.equal(looksFailed("external_agent is disabled (set externalAgentTrust to gated|full).", "external_agent"), true);
  assert.equal(looksFailed("✗ a1b2c3 failed: exit code 7", "cronjob"), true);
  assert.equal(looksFailed("Refused: frontmost app is not allowlisted.", "computer"), true);
  assert.equal(looksFailed("Screen control is off. Enable it with hara config.", "computer"), true);
  assert.equal(looksFailed("Grounding needs a vision model that can see images — set one.", "computer"), true);
  assert.equal(looksFailed("Screenshot saved to /tmp/x.png. Configure a vision model so I can read it.", "computer"), true);

  assert.equal(looksFailed("Search failed is the title of this document.", "read_file"), false);
  assert.equal(looksFailed("The cron output was: ✗ a1 failed: exit 7", "read_file"), false);
  assert.equal(looksFailed("A user may write Refused: in ordinary prose.", "web_fetch"), false);
  assert.equal(looksFailed("Search failed across available providers (quoted example)."), false, "tool identity is required for ambiguous prose-like shapes");
});

test("recordCall advances the repeated-failure streak for tool-specific diagnostics", () => {
  for (const [name, content] of [
    ["web_search", "Search failed across available providers (offline)."],
    ["external_agent", "[codex exit 1]\nfailed"],
    ["cronjob", "✗ job1 failed: exit 1"],
    ["computer", "Screen control is off. Enable it first."],
  ]) {
    resetRepeatGuard();
    assert.equal(recordCall(name, { same: true }, content), "");
    assert.match(recordCall(name, { same: true }, content), /FAILED 2×/);
  }
});

test("a different failure or any success breaks the consecutive streak", () => {
  assert.equal(recordCall("bash", { command: "npm test" }, "Command failed: first"), "");
  assert.equal(recordCall("edit_file", { path: "x" }, "updated"), "");
  assert.equal(recordCall("bash", { command: "npm test" }, "Command failed: second"), "", "progress reset the old test failure");
  assert.equal(recordCall("bash", { command: "npm lint" }, "Command failed: lint"), "", "a changed failed attempt resets the prior key");
  assert.equal(recordCall("bash", { command: "npm test" }, "Command failed: third"), "", "the old key did not accumulate across another failure");
});

test("2nd identical failure warns; 1st doesn't; different args are a different call", () => {
  const args = { command: "git pull origin main" };
  assert.equal(recordCall("bash", args, "Command failed: exit code 128"), "", "first failure: no warning yet");
  const warn = recordCall("bash", args, "Command failed: exit code 128");
  assert.match(warn, /FAILED 2×/, "second identical failure warns");
  assert.equal(recordCall("bash", { command: "git pull origin dev" }, "Command failed: x"), "", "different args -> separate streak");
});

test("different directory tools share the same protected-Home root cause", () => {
  const grep = "Error: grep will not recursively scan the home directory. Run Hara from a project.";
  const glob = "Error: glob will not enumerate or recursively scan directories while Hara is rooted at the home directory.";
  assert.equal(failureIdentity("grep", { pattern: "x" }, grep).semantic, true);
  assert.equal(recordCall("grep", { pattern: "x" }, grep), "");
  assert.match(recordCall("glob", { pattern: "**/*" }, glob), /same Home workspace boundary.*2 consecutive/is);
});

test("a success resets the streak; loop-level errors (isError) count as failures", () => {
  const args = { path: "a.txt" };
  recordCall("read_file", args, "Error: cannot read a.txt");
  assert.equal(recordCall("read_file", args, "     1\tok now"), "", "success resets");
  assert.equal(recordCall("read_file", args, "Error: cannot read a.txt"), "", "streak restarted at 1");
  // isError=true marks a thrown-exception result as failed regardless of content shape
  recordCall("computer", { op: "x" }, "boom", true);
  assert.match(recordCall("computer", { op: "x" }, "boom", true), /FAILED 2×/);
});

test("streak keeps counting past 2 and resetRepeatGuard clears it", () => {
  const args = { command: "npm test" };
  recordCall("bash", args, "Command failed: 1");
  recordCall("bash", args, "Command failed: 1");
  assert.match(recordCall("bash", args, "Command failed: 1"), /FAILED 3×/);
  resetRepeatGuard();
  assert.equal(recordCall("bash", args, "Command failed: 1"), "", "cleared");
});

test("failure streaks are isolated between concurrent serve sessions", () => {
  const args = { command: "git pull" };
  assert.equal(recordCall("bash", args, "Command failed: A", false, "serve:a"), "");
  assert.equal(recordCall("bash", args, "Command failed: B", false, "serve:b"), "");
  assert.match(recordCall("bash", args, "Command failed: A", false, "serve:a"), /FAILED 2×/);
  assert.match(recordCall("bash", args, "Command failed: B", false, "serve:b"), /FAILED 2×/);
});

test("keyOf: space-separated identity + survives unserializable args", () => {
  assert.equal(keyOf("bash", { command: "ls" }), 'bash {"command":"ls"}');
  assert.equal(
    keyOf("tool", { z: 1, nested: { b: 2, a: 1 } }),
    keyOf("tool", { nested: { a: 1, b: 2 }, z: 1 }),
    "object insertion order cannot bypass repeat identity",
  );
  const cyc = {};
  cyc.self = cyc;
  assert.equal(keyOf("bash", cyc), "bash <unserializable>");
});
