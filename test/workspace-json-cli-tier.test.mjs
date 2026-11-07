import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { jsonCliFixture } from "./helpers/json-cli-fixture.mjs";
import { FULL_TIER_SKIP, GEMINI_SKIP, SEATBELT } from "./helpers/platform-tier.mjs";
const live = pid => { try { return !execFileSync("/bin/ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" }).trim().startsWith("Z"); } catch { return false; } };
for (const runtime of ["gemini", "kimi"]) {
  test(`${runtime}: full tier publishes actual native file evidence through Host and C-lite`, { skip: FULL_TIER_SKIP }, async t => {
    const f = await jsonCliFixture(t, runtime, { mode: "native-write", productionPolicy: true }), sent = f.send("Write native-result.txt"); await f.host.wait(sent.runId); const view = f.read();
    assert.equal(view.conversation.permissionTier, "full-protected");
    assert.equal(view.conversation.state, "completed", view.conversation.blockReason); assert.equal(view.conversation.completion.state, "verified");
    assert.match(view.conversation.completion.evidence.join(" "), /native-workspace-diff/); assert.equal(fs.readFileSync(join(f.project, "native-result.txt"), "utf8"), "native fixture result");
  });
  test(`${runtime}: controlled rejects native writes and a reported write without a diff cannot complete`, { skip: runtime === "gemini" ? GEMINI_SKIP : false }, async t => {
    const controlled = await jsonCliFixture(t, runtime, { mode: "native-write", tier: "controlled", productionPolicy: true });
    let sent = controlled.send("Write native-result.txt"); await controlled.host.wait(sent.runId); let view = controlled.read();
    assert.equal(view.conversation.permissionTier, "controlled"); assert.notEqual(view.conversation.state, "completed");
    if (SEATBELT) { // Inside Seatbelt the OS denies the write outright.
      assert.equal(controlled.meta().writeDenied, true); assert.equal(fs.existsSync(join(controlled.project, "native-result.txt")), false);
    } else { // Decision B: no system-level write protection; a write that bypasses the native mode is never credited.
      assert.notEqual(view.conversation.completion?.state, "verified"); assert.doesNotMatch(JSON.stringify(view.conversation.completion ?? {}), /native-workspace-diff/);
    }
    const claimed = await jsonCliFixture(t, runtime, { mode: "native-claim", productionPolicy: true });
    sent = claimed.send("Write native-result.txt"); await claimed.host.wait(sent.runId); view = claimed.read();
    assert.notEqual(view.conversation.state, "completed"); assert.notEqual(view.conversation.completion?.state, "verified");
  });
  test(`${runtime}: complete wrap hooks drain an observed detached shell and background child before completion`, { skip: process.platform !== "darwin" }, async t => {
    const f = await jsonCliFixture(t, runtime, { mode: "background" }), sent = f.send(); await f.host.wait(sent.runId); const view = f.read(), meta = f.meta();
    assert.equal(view.conversation.state, "completed", view.conversation.blockReason);
    assert.equal(live(meta.pid), false, "owned root survived"); assert.equal(live(meta.toolPid), false, "observed fixture shell survived"); assert.equal(live(meta.backgroundPid), false, "observed fixture child survived");
    assert.ok(f.policyCalls.some(row => row.kind === "on-process")); assert.ok(f.policyCalls.some(row => row.kind === "drain-process")); assert.ok(f.policyCalls.some(row => row.kind === "drain"));
  });
  test(`${runtime}: recognized native risk reaches the conversation as a redacted observed summary`, { skip: runtime === "gemini" ? GEMINI_SKIP : false }, async t => {
    const f = await jsonCliFixture(t, runtime, { mode: "risk", productionPolicy: true }), sent = f.send(); await f.host.wait(sent.runId); const view = f.read();
    assert.equal(view.conversation.state, "completed", view.conversation.blockReason);
    assert.equal(view.conversation.nativeRisks.length, 1); assert.equal(view.conversation.nativeRisks[0].kind, "external-publish"); assert.equal(view.conversation.nativeRisks[0].state, "observed");
    assert.ok(!JSON.stringify(view).includes("PRIVATE_ARGUMENT"));
  });
}

test("Gemini default managed App layout keeps the project override outside native evidence and passes N1", { skip: process.platform !== "darwin" }, async t => {
  const f = await jsonCliFixture(t, "gemini", { mode: "native-write", productionPolicy: true, defaultLayout: true });
  const sent = f.send("Write native-result.txt"); await f.host.wait(sent.runId); const view = f.read();
  assert.equal(view.conversation.state, "completed"); assert.equal(view.conversation.completion.state, "verified");
  assert.equal(fs.readFileSync(join(f.project, "native-result.txt"), "utf8"), "native fixture result");
  assert.equal(fs.existsSync(join(f.project, ".gemini/settings.json")), false);
  assert.match(view.conversation.completion.evidence.join(" "), /native-workspace-diff/);
});
