import test from "node:test";
import assert from "node:assert/strict";
import { redactSensitiveText, redactSensitiveValue } from "../dist/security/secrets.js";

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
