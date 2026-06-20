import test from "node:test";
import assert from "node:assert/strict";
import { cleanSessionName, slugify } from "../dist/session/store.js";

test("slugify: model phrase → short English kebab slug (for session names)", () => {
  assert.equal(slugify("Add Semantic Search!"), "add-semantic-search");
  assert.equal(slugify("  Fix: login redirect bug  "), "fix-login-redirect-bug");
  assert.equal(slugify("你好世界"), "", "non-ASCII dropped → caller falls back");
  assert.ok(slugify("word ".repeat(40)).length <= 40, "capped at 40");
  assert.ok(!slugify("-- spaced --").startsWith("-") && !slugify("-- spaced --").endsWith("-"), "no edge hyphens");
});

test("cleanSessionName: short ASCII slug from the message, stopwords dropped", () => {
  assert.equal(cleanSessionName("please fix the null check in login.ts"), "null-check-login");
  assert.equal(cleanSessionName("add a /health endpoint with tests"), "health-endpoint-tests");
  assert.ok(cleanSessionName("x".repeat(80)).length <= 24, "capped length");
});

test("cleanSessionName: no CJK / garbled — stable ASCII word fallback", () => {
  const n = cleanSessionName("帮我重构一下登录模块的认证逻辑");
  assert.match(n, /^[a-z]+$/, "ascii word only, no CJK");
  assert.equal(cleanSessionName("帮我重构一下登录模块的认证逻辑"), n, "stable for the same input");
  assert.match(cleanSessionName(""), /^[a-z]+$/, "empty → a word");
});
