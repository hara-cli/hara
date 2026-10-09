import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { thirdPartyNotices } from "../dist/third-party-notices.js";

test("offline license text includes both integrated runtimes and Pi MCP attribution", () => {
  const text = thirdPartyNotices();
  assert.equal(text, readFileSync(new URL("../THIRD_PARTY_NOTICES.md", import.meta.url), "utf8"));
  for (const attribution of ["Mario Zechner", "2024 Anthropic, PBC", "2025 opencode"]) assert.ok(text.includes(attribution));
});

test("standalone embeds notices and exposes a credential-free offline command", () => {
  const build = readFileSync(new URL("../scripts/build-binary.ts", import.meta.url), "utf8");
  const entry = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(build, /__HARA_BUNDLED_THIRD_PARTY_NOTICES__.*JSON.stringify\(thirdPartyNotices\)/);
  assert.match(entry, /program.command\("licenses"\)/);
  assert.match(entry, /stdout.write\(thirdPartyNotices\(\)\)/);
  assert.match(readFileSync(new URL("../Dockerfile", import.meta.url), "utf8"), /COPY package.json README.md THIRD_PARTY_NOTICES.md/);
});
