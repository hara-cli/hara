import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { jsonCliFixture } from "./helpers/json-cli-fixture.mjs";

const macTest = (name, body) => test(name, { skip: process.platform !== "darwin" }, body);
for (const runtime of ["gemini", "kimi"]) {
  for (const helpFailure of [false, true]) macTest(`${runtime}: ${helpFailure ? "help" : "protected native"} startup exposes only its redacted first line`, async t => {
    const f = await jsonCliFixture(t, runtime, { mode: "startup-stderr", helpFailure });
    const sent = f.send(); await f.host.wait(sent.runId);
    const view = f.read(); assert.equal(view.conversation.state, "blocked");
    const reason = view.conversation.blockReason, prefix = "hara_runtime_failure_v1=";
    const start = reason.indexOf(prefix); assert.ok(start >= 0, reason); const diagnostic = JSON.parse(reason.slice(start + prefix.length));
    assert.equal(diagnostic.runtime, runtime);
    assert.equal(diagnostic.kind, helpFailure ? "version_incompatible" : "runtime_failed");
    assert.match(diagnostic.errorFirstLine, helpFailure ? /^Error: help startup failed \[path\]$/ : /^Error: native startup failed/);
    assert.ok([...diagnostic.errorFirstLine].length <= 320);
    assert.doesNotMatch(JSON.stringify(view.conversation), /Users\/private|private\.example|private@example|PRIVATE_SECOND_LINE|[a-f0-9]{64}/);
    assert.equal(diagnostic.extensionsIsolation, runtime === "kimi" ? "inherited" : undefined);
    assert.equal(view.runtimes.options.find(row => row.runtimeId === runtime).versionStatus.lastSuccessfulVersion, null);
    if (runtime === "gemini") assert.equal(fs.existsSync(join(f.project, ".gemini/settings.json")), false, "owned project overlay was removed after drain");
    assert.equal(fs.existsSync(f.metaPath), false, "no MCP tool or successful native response was reached");
    assert.equal(f.policyCalls.some(row => row.kind === "on-process"), !helpFailure);
  });
}

macTest("Gemini preserves pre-existing project settings and refuses before any native model process", async t => {
  const f = await jsonCliFixture(t, "gemini"); fs.mkdirSync(join(f.project, ".gemini")); const path = join(f.project, ".gemini/settings.json"); fs.writeFileSync(path, "FAKE_EXISTING_CONFIG");
  const sent = f.send(); await f.host.wait(sent.runId); const view = f.read();
  assert.equal(view.conversation.state, "blocked"); assert.match(view.conversation.blockReason, /runtime_permission_denied/); assert.match(view.conversation.blockReason, /already exist/);
  assert.equal(f.policyCalls.length, 0); assert.equal(fs.readFileSync(path, "utf8"), "FAKE_EXISTING_CONFIG"); assert.equal(fs.existsSync(f.metaPath), false);
});

for (const runtime of ["gemini", "kimi"]) macTest(`${runtime}: structured native errors reach Host through the safe first-line boundary`, async t => {
  const f = await jsonCliFixture(t, runtime, { mode: "error" }); const sent = f.send(); await f.host.wait(sent.runId); const view = f.read();
  assert.equal(view.conversation.state, "blocked"); const marker = "hara_runtime_failure_v1=", reason = view.conversation.blockReason;
  const diagnostic = JSON.parse(reason.slice(reason.indexOf(marker) + marker.length));
  assert.equal(diagnostic.kind, "runtime_auth_rejected"); assert.match(diagnostic.errorFirstLine, /401 authentication failed/); assert.doesNotMatch(JSON.stringify(view.conversation), /fixture-private/);
  assert.equal(view.runtimes.options.find(row => row.runtimeId === runtime).versionStatus.lastSuccessfulVersion, null);
});
