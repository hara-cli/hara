import "./setup-isolated-home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { inspectMailRuntime, mailRuntimeStatus } from "../dist/mail-runtime.js";

const fixture = mkdtempSync(join(homedir(), "mail-runtime-"));
const helper = join(fixture, "shared-helper.py");
writeFileSync(helper, "# Synthetic fixture; never executed\n", { mode: 0o600 });

test("missing shared mail capability requires setup without starting any provider", async () => {
  let calls = 0;
  assert.deepEqual(await inspectMailRuntime(join(fixture, "missing.py"), async () => { calls++; return ""; }), { ready: false, reason: "helper-missing" });
  assert.equal(calls, 0);
});

test("mail prerequisites inspect only bounded command help, not identity or mailbox access", async () => {
  const operations = [];
  const result = await inspectMailRuntime(helper, async (file, operation) => {
    assert.equal(file, helper); operations.push(operation);
    return operation === "mail-imap-doctor" ? "--account-file" : "--message-file --confirm-hash";
  });
  assert.deepEqual(result, { ready: true, reason: "ready" });
  assert.deepEqual(operations.sort(), ["mail-imap-doctor", "mail-smtp-send"]);
});

test("an older shared mail capability is not advertised as usable", async () => {
  assert.deepEqual(await inspectMailRuntime(helper, async () => "--mailbox"), { ready: false, reason: "helper-incompatible" });
});

test("Python and execution failures are distinguished without exposing provider error text", async () => {
  assert.deepEqual(await inspectMailRuntime(helper, async () => { throw Object.assign(new Error("private diagnostic"), { code: "ENOENT" }); }), { ready: false, reason: "python-missing" });
  const unavailable = await inspectMailRuntime(helper, async () => { throw new Error("password=private-fixture-value"); });
  assert.deepEqual(unavailable, { ready: false, reason: "unavailable" });
  assert.ok(!JSON.stringify(unavailable).includes("private-fixture-value"));
});

test("concurrent settings prerequisite reads share one cached local probe", async () => {
  const first = mailRuntimeStatus(), second = mailRuntimeStatus();
  assert.equal(first, second);
  const result = await first;
  assert.deepEqual(await mailRuntimeStatus(), result);
});
