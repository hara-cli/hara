// `hara feedback` core: env collection, secret redaction (public issues must never leak keys),
// structured body assembly, title derivation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { collectEnv, redact, buildIssueBody, issueTitle } from "../dist/feedback.js";

test("redact: strips the credential families that show up in real pastes", () => {
  assert.equal(redact("key sk-abc123def456ghi"), "key sk-***");
  assert.equal(redact("ghp_" + "a1B2".repeat(6)), "gh*_***");
  assert.ok(!redact("Authorization: Bearer abcdefghijklmnop1234").includes("abcdefghijklmnop"));
  assert.equal(redact('apiKey: "supersecret123"'), 'apiKey: "***"');
  assert.ok(redact("eyJhbGciOiJIUzI1NiJ9xxxxxxxxxx.eyJzdWIiOiIxIn0xxxxxxxx.sflKxwRJSMeKKF2QT4xxxx").includes("JWT-***"));
  assert.equal(redact("plain text stays"), "plain text stays");
});

test("buildIssueBody: structured sections, env table, optional redacted session tail", () => {
  const env = collectEnv("0.120.0", "deepseek:deepseek-v4-pro");
  const body = buildIssueBody("write_file loses params", env);
  assert.ok(body.includes("## What happened"));
  assert.ok(body.includes("| hara | 0.120.0 |"));
  assert.ok(body.includes("deepseek:deepseek-v4-pro"));
  assert.ok(!body.includes("## Session tail"), "no session section unless provided");

  const withTail = buildIssueBody("x", env, "user: my key is sk-verysecret1234\nassistant: ok");
  assert.ok(withTail.includes("## Session tail"));
  assert.ok(withTail.includes("sk-***"), "tail is redacted");
  assert.ok(!withTail.includes("sk-verysecret1234"));
});

test("issueTitle: first line capped at 70", () => {
  assert.equal(issueTitle("short bug\ndetails"), "short bug");
  assert.equal(issueTitle("x".repeat(100)).length, 68, "67 chars + ellipsis");
  assert.equal(issueTitle("  "), "feedback");
});
