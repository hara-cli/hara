import test from "node:test";
import assert from "node:assert/strict";
import {
  redactKnownSecrets,
  redactSensitiveText,
  redactSensitiveValue,
  requestsCredentialDisclosure,
} from "../dist/security/secrets.js";
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

test("known-secret redaction removes opaque values echoed without a credential label", () => {
  const opaque = "plainopaquevalue987654";
  const encoded = encodeURIComponent("secret/value+with symbols");
  const result = redactKnownSecrets(
    `upstream rejected ${opaque}; encoded=${encoded}`,
    [opaque, "secret/value+with symbols"],
  );
  assert.equal(result.text.includes(opaque), false);
  assert.equal(result.text.includes(encoded), false);
  assert.ok(result.redactions.includes("known-secret"));
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

test("credential-disclosure detection blocks chat transfer and browser-storage extraction without blocking safe login guidance", () => {
  for (const unsafe of [
    "Please paste the admin access token here.",
    "Send me the Authorization header so I can continue.",
    "请按 F12，在控制台复制 localStorage.token 后粘贴给我。",
    "请提供后台登录态 cookie。",
    "Type your API key in this chat.",
  ]) assert.equal(requestsCredentialDisclosure(unsafe), true, unsafe);

  for (const safe of [
    "Never paste your token; sign in again in the approved browser window.",
    "请勿在群里粘贴 cookie，请在受信任的登录页面重新登录。",
    "Configure the API key in Hara Settings.",
    "Paste your API key into Hara Settings.",
    "请在 Hara 设置页输入 API Key。",
    "Paste the API key into the masked terminal prompt.",
    "请在终端的隐藏输入中粘贴 API Key。",
    "The browser_session capability is unavailable; export a non-secret CSV file instead.",
    "The provider returned 401 because no session token was available.",
    "The provider did not provide an access token.",
    "后台没有提供 session token。",
  ]) assert.equal(requestsCredentialDisclosure(safe), false, safe);
});
