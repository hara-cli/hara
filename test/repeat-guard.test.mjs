// Repeat guard (anti-spinning): identical (tool,args) call failing >=2x in a row gets a "stop repeating
// this" note appended to its result; successes never warn and reset the streak.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { recordCall, looksFailed, keyOf, resetRepeatGuard } from "../dist/agent/repeat-guard.js";

beforeEach(() => resetRepeatGuard());

test("looksFailed: hara's failure-string shapes; success output is not a failure", () => {
  assert.equal(looksFailed("Command failed: exit code 128\nfatal: ..."), true);
  assert.equal(looksFailed("Error: cannot read x.txt"), true);
  assert.equal(looksFailed('Skipped without running: host "github.com" already failed'), true);
  assert.equal(looksFailed("     1\thello"), false);
  assert.equal(looksFailed("Edited src/a.ts: 1 edit, 1 replacement."), false);
});

test("2nd identical failure warns; 1st doesn't; different args are a different call", () => {
  const args = { command: "git pull origin main" };
  assert.equal(recordCall("bash", args, "Command failed: exit code 128"), "", "first failure: no warning yet");
  const warn = recordCall("bash", args, "Command failed: exit code 128");
  assert.match(warn, /FAILED 2×/, "second identical failure warns");
  assert.equal(recordCall("bash", { command: "git pull origin dev" }, "Command failed: x"), "", "different args -> separate streak");
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
  const cyc = {};
  cyc.self = cyc;
  assert.equal(keyOf("bash", cyc), "bash <unserializable>");
});
