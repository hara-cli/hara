import test from "node:test";
import assert from "node:assert/strict";
import { redactSensitiveText, redactSensitiveValue } from "../dist/security/secrets.js";
import { issueTitle } from "../dist/feedback.js";

test("secret redaction covers chat, env, JSON, headers, flags, and nested tool data", () => {
  const secrets = [
    "sk-abc123def456ghi",
    "feishu-super-secret-123",
    "abcdefghijklmnop1234",
    "json-secret-value-999",
    "cli-secret-value-888",
    "generic-key-value-777",
  ];
  const input = [
    `key ${secrets[0]}`,
    `FEISHU_APP_SECRET=${secrets[1]}`,
    `Authorization: Bearer ${secrets[2]}`,
    `{"apiKey":"${secrets[3]}"}`,
    `tool --token=${secrets[4]}`,
    `OPENAI_KEY=${secrets[5]}`,
    "PLAIN_SETTING=keep-me",
  ].join("\n");
  const r = redactSensitiveText(input);
  for (const secret of secrets) assert.ok(!r.text.includes(secret), `redacted ${secret}`);
  assert.ok(r.text.includes("PLAIN_SETTING=keep-me"), "non-credential assignments stay intact");
  assert.ok(r.redactions.length >= 6);

  const nested = redactSensitiveValue({ history: [{ toolUses: [{ input: { command: `curl -H 'Authorization: Bearer ${secrets[2]}'` } }] }] });
  assert.ok(!JSON.stringify(nested.value).includes(secrets[2]), "nested tool input is redacted");
  assert.ok(nested.redactions.length > 0);
});

test("secret redaction handles quoted whitespace, URL credentials, and common standalone token families", () => {
  const values = [
    "correct horse battery staple",
    "url-password-123456",
    "glpat-abcdefghijklmnopqrstuv",
    ["xoxb", "1234567890", "abcdefghijklmnop"].join("-"),
    "npm_abcdefghijklmnopqrstuvwxyz123456",
    "AIzaabcdefghijklmnopqrstuvwxyz123456",
    "sk_live_abcdefghijklmnop",
  ];
  const input = [
    `PASSWORD="${values[0]}"`,
    `https://robot:${values[1]}@example.test/path`,
    ...values.slice(2),
    `tool --token '${values[0]}'`,
  ].join("\n");
  const redacted = redactSensitiveText(input).text;
  for (const value of values) assert.ok(!redacted.includes(value), `redacted ${value}`);
  assert.match(redacted, /PASSWORD="\*\*\*"/);
  assert.match(redacted, /https:\/\/robot:\*\*\*@example\.test/);
  assert.match(redacted, /--token '\*\*\*'/);
});

test("deep redaction clones without mutating frozen input or treating __proto__ as a setter", () => {
  const source = JSON.parse(`{
    "history":[{"input":{"command":"curl -H 'Authorization: Bearer abcdefghijklmnop1234'"}}],
    "__proto__":{"apiKey":"json-secret-value-123456"}
  }`);
  Object.freeze(source.history[0].input);
  Object.freeze(source.history[0]);
  Object.freeze(source.history);
  Object.freeze(source.__proto__);
  Object.freeze(source);
  const before = JSON.stringify(source);

  const result = redactSensitiveValue(source);
  assert.equal(JSON.stringify(source), before, "live value remains byte-for-byte unchanged");
  assert.notEqual(result.value, source);
  assert.ok(!JSON.stringify(result.value).includes("abcdefghijklmnop1234"));
  assert.ok(!JSON.stringify(result.value).includes("json-secret-value-123456"));
  assert.equal(Object.hasOwn(result.value, "__proto__"), true);
  assert.equal(Object.getPrototypeOf(result.value), Object.prototype, "clone prototype was not polluted");
});

test("public feedback titles are redacted before truncation", () => {
  const secret = "public-title-secret-123456789";
  const title = issueTitle(`startup failed: API_KEY=${secret}\nprivate details`);
  assert.ok(!title.includes(secret));
  assert.match(title, /API_KEY=\*\*\*/);
  assert.ok(title.length <= 70);
});
