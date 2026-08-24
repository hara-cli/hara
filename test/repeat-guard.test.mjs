// Repeat guard (anti-spinning): identical (tool,args) call failing >=2x in a row gets a "stop repeating
// this" note appended to its result; successes never warn and reset the streak.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  failureIdentities,
  failureIdentity,
  keyOf,
  looksFailed,
  pythonSyntaxDiagnostic,
  pythonSyntaxRecoveryNote,
  recordCall,
  resetRepeatGuard,
} from "../dist/agent/repeat-guard.js";

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
  assert.equal(looksFailed('Python failed: exit code 1.\n  File "<stdin>", line 1\nSyntaxError: invalid syntax', "python"), true);
  assert.equal(looksFailed("Search failed across available providers (Google: timeout). Check connectivity.", "web_search"), true);
  assert.equal(looksFailed("[codex exit 1]\nbackend failed", "external_agent"), true);
  assert.equal(looksFailed("[claude] failed to start: spawn ENOENT", "external_agent"), true);
  assert.equal(looksFailed("external_agent is disabled (set externalAgentTrust to gated|full).", "external_agent"), true);
  assert.equal(looksFailed("✗ a1b2c3 failed: exit code 7", "cronjob"), true);
  assert.equal(looksFailed("Refused: frontmost app is not allowlisted.", "computer"), true);
  assert.equal(looksFailed("Screen control is off. Enable it with hara config.", "computer"), true);
  assert.equal(looksFailed("Grounding needs a vision model that can see images — set one.", "computer"), true);
  assert.equal(looksFailed("Screenshot saved to /tmp/x.png. Configure a vision model so I can read it.", "computer"), true);
  assert.equal(looksFailed("(no memory matches)", "memory_search"), true);
  assert.equal(looksFailed("(no session matches)", "session_search"), true);

  assert.equal(looksFailed("Search failed is the title of this document.", "read_file"), false);
  assert.equal(looksFailed("The cron output was: ✗ a1 failed: exit 7", "read_file"), false);
  assert.equal(looksFailed("A user may write Refused: in ordinary prose.", "web_fetch"), false);
  assert.equal(looksFailed("Search failed across available providers (quoted example)."), false, "tool identity is required for ambiguous prose-like shapes");
  assert.equal(looksFailed("Python failed is an article title.", "read_file"), false, "Python diagnostics require the python tool identity");
});

test("three empty recall queries coalesce across changed arguments and both recall tools", () => {
  const first = recordCall("memory_search", { query: "马斯克" }, "(no memory matches)");
  const second = recordCall("memory_search", { query: "Elon Musk" }, "(no memory matches)");
  const third = recordCall("session_search", { query: "Wikipedia Musk" }, "(no session matches)");
  assert.match(first, /1 memory\/session search.*at most 2 more/is);
  assert.match(second, /2 memory\/session searches.*at most 1 more/is);
  assert.match(third, /3 memory\/session searches.*recall tools are disabled.*tell the user/is);
  const identity = failureIdentity("session_search", { query: "different" }, "(no session matches)");
  assert.equal(identity.semantic, true);
  assert.equal(identity.hardStopAfter, 3);
  assert.equal(identity.kind, "empty_recall");
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

test("interleaved failures accumulate until a successful action resets the no-progress ledger", () => {
  assert.equal(recordCall("bash", { command: "npm test" }, "Command failed: first"), "");
  assert.equal(recordCall("bash", { command: "npm lint" }, "Command failed: lint"), "", "a different failure is not progress");
  assert.match(recordCall("bash", { command: "npm test" }, "Command failed: second"), /FAILED 2×/, "the old key survives an interleaved failure");
  assert.equal(recordCall("edit_file", { path: "x" }, "updated"), "");
  assert.equal(recordCall("bash", { command: "npm test" }, "Command failed: third"), "", "real progress resets the ledger");
});

test("2nd identical failure warns; 1st doesn't; different args are a different call", () => {
  const args = { command: "git pull origin main" };
  assert.equal(recordCall("bash", args, "Command failed: exit code 128"), "", "first failure: no warning yet");
  const warn = recordCall("bash", args, "Command failed: exit code 128");
  assert.match(warn, /FAILED 2×/, "second identical failure warns");
  assert.equal(recordCall("bash", { command: "git pull origin dev" }, "Command failed: x"), "", "different args -> separate streak");
});

test("three parameter variants sharing one command strategy and API error force a re-plan", () => {
  const failure = 'Command failed: request rejected\n{"code":1061002,"msg":"params error"}';
  const commands = [
    'curl -F file=@a.pdf https://open.feishu.cn/open-apis/drive/v1/medias/upload_all',
    'curl -F file_name=a.pdf -F file=@a.pdf https://open.feishu.cn/open-apis/drive/v1/medias/upload_all',
    'curl -H "Content-Type: multipart/form-data" -F file=@a.pdf https://open.feishu.cn/open-apis/drive/v1/medias/upload_all',
  ];
  assert.equal(recordCall("bash", { command: commands[0] }, failure), "");
  assert.match(recordCall("bash", { command: commands[1] }, failure), /2 variants.*without intervening progress.*tools\/scripts.*materially different strategy/is);
  assert.match(recordCall("bash", { command: commands[2] }, failure), /3 variants.*without intervening progress.*stop this strategy now/is);
  const identities = failureIdentities("bash", { command: commands[0] }, failure);
  assert.equal(identities.find((identity) => identity.kind === "strategy")?.hardStopAfter, 3);
});

test("Python syntax failures expose a bounded read-before-repair instruction", () => {
  assert.equal(
    pythonSyntaxDiagnostic("Command failed: assertion expected SyntaxError but received ValueError"),
    undefined,
    "an exception name mentioned in ordinary failure prose is not a parser receipt",
  );
  const failure = [
    "Command failed: exit code 1",
    String.raw`  File "D:\Work\automation\upload_helper.py", line 51`,
    "    target = “broken”",
    "             ^",
    "SyntaxError: invalid character '“' (U+201C)",
  ].join("\n");
  assert.deepEqual(pythonSyntaxDiagnostic(failure), {
    kind: "SyntaxError",
    file: "D:\\Work\\automation\\upload_helper.py",
    line: 51,
    label: "upload_helper.py",
  });
  const note = pythonSyntaxRecoveryNote(failure);
  assert.match(note, /SyntaxError at upload_helper\.py:51/);
  assert.match(note, /call read_file for that exact file and the reported line region/);
  assert.match(note, /straight ASCII quotes/);
  assert.doesNotMatch(note, /D:\\Work/, "the repeated instruction does not expose the full local path");
  const strategy = failureIdentities(
    "bash",
    { command: "python upload_helper.py" },
    failure,
  ).find((identity) => identity.kind === "strategy");
  assert.match(strategy?.key ?? "", /Python SyntaxError/);
});

test("two unusable SPA fetch variants stop the text-fetch strategy and direct the agent to a real browser", () => {
  resetRepeatGuard();
  const failure = "Error: web_fetch received only a JavaScript SPA shell at https://example.com. Use open_browser.";
  assert.equal(recordCall("web_fetch", { url: "https://example.com/app" }, failure), "");
  const warning = recordCall("web_fetch", { url: "https://example.com/app", render: true }, failure);
  assert.match(warning, /2 variants.*web_fetch\+example\.com.*browser rendering unavailable.*stop this strategy now/is);
  const identity = failureIdentities("web_fetch", { url: "https://example.com/app" }, failure)
    .find((entry) => entry.kind === "strategy");
  assert.equal(identity?.hardStopAfter, 2);
});

test("a changed high-signal root cause does not accumulate as one command strategy", () => {
  assert.equal(recordCall("bash", { command: "curl -F attempt=1 https://api.example/upload" }, 'Command failed: {"code":1061002}'), "");
  assert.equal(recordCall("bash", { command: "curl -F attempt=2 https://api.example/upload" }, 'Command failed: {"code":1061003}'), "");
});

test("an interpreter name alone cannot merge unrelated failing scripts", () => {
  const failure = 'Command failed: {"code":1061002,"msg":"params error"}';
  assert.equal(recordCall("bash", { command: "python scripts/upload_a.py --attempt 1" }, failure), "");
  assert.equal(recordCall("bash", { command: "python scripts/upload_b.py --attempt 2" }, failure), "");
  const firstStrategy = failureIdentities("bash", { command: "python scripts/upload_a.py --attempt 3" }, failure)
    .find((identity) => identity.kind === "strategy");
  assert.match(firstStrategy?.key ?? "", /scripts\/upload_a\.py/);
});

test("different directory tools share the same protected-Home root cause", () => {
  const grep = "Error: grep will not recursively scan the home directory. Run Hara from a project.";
  const glob = "Error: glob will not enumerate or recursively scan directories while Hara is rooted at the home directory.";
  assert.equal(failureIdentity("grep", { pattern: "x" }, grep).semantic, true);
  assert.match(recordCall("grep", { pattern: "x" }, grep), /first project tool.*\/cd <project>.*current conversation will continue/is);
  assert.match(recordCall("glob", { pattern: "**/*" }, glob), /same Home workspace boundary.*2 calls without intervening progress/is);
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
