import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { cliMcpFixture, until } from "./helpers/workspace-cli-mcp.mjs";
import { HARA_RUNTIME_VERSION, resolveHaraRuntimeVersion } from "../dist/version.js";

const done = view => ["completed", "blocked", "paused", "cancelled"].includes(view.conversation.state);

test("Codex app-server initialize advertises HARA_RUNTIME_VERSION from package.json", async t => {
  const f = await cliMcpFixture(t, "reply");
  await f.send("hello");
  await until(f.read, done);

  const initialize = f.native().filter(row => row.method === "initialize");
  assert.ok(initialize.length >= 1, "initialize request must be sent to the Codex app-server");
  for (const row of initialize) {
    assert.equal(row.params.clientInfo.name, "hara");
    assert.equal(row.params.clientInfo.version, HARA_RUNTIME_VERSION);
  }

  const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(HARA_RUNTIME_VERSION, resolveHaraRuntimeVersion());
  assert.equal(HARA_RUNTIME_VERSION, packageJson.version);

  const source = fs.readFileSync(new URL("../src/agent-runtime/codex-session.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /clientInfo:\s*\{\s*name:\s*"hara",\s*version:\s*"/);
  assert.match(source, /clientInfo:\s*\{\s*name:\s*"hara",\s*version:\s*HARA_RUNTIME_VERSION\s*\}/);
});
