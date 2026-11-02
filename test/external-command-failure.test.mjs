import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { registeredCliFailureCode, runExternalCommandCapture } from "../dist/external-sessions/process.js";

for (const [stderr, expected] of [
  ["Not inside a trusted directory and --skip-git-repo-check was not specified.", "project_not_trusted"],
  ["fatal: not a git repository", "project_not_trusted"],
  ["websocket error: 401 Unauthorized private-body", "runtime_auth_required"],
  ["Not logged in", "runtime_auth_required"],
  ["authentication failed", "runtime_auth_required"],
  ["unexpected nonzero exit", undefined],
]) test(`registered CLI stderr becomes only ${expected ?? "a generic failure"}`, async () => {
  assert.equal(registeredCliFailureCode(stderr), expected);
  const spawnProcess = () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    setImmediate(() => { child.stdout.write("PRIVATE_STDOUT"); child.stderr.write(stderr + " PRIVATE_SECRET"); child.emit("close", 1); });
    return child;
  };
  for (const failureKind of [undefined, "registered-cli"]) {
    const result = await runExternalCommandCapture({ command: process.execPath, spawnProcess }, [], { failureKind });
    assert.equal(result.errorCode, failureKind ? expected ?? "command_failed" : "command_failed");
    assert.equal(result.stdout, ""); assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
  }
});

test("spawn and missing-command failures remain distinct", async () => {
  const result = await runExternalCommandCapture({ command: process.execPath, spawnProcess() { throw new Error("PRIVATE"); } }, [], { failureKind: "registered-cli" });
  assert.equal(result.errorCode, "spawn_failed"); assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
  const missing = await runExternalCommandCapture({ command: "/missing/hara-fixture-executable" }, []);
  assert.equal(missing.errorCode, "command_not_found");
});


test("structured codes survive opt-in classification and timeouts remain bounded", async () => {
  const spawnProcess = () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    setImmediate(() => { child.stderr.write(JSON.stringify({ error: { code: "fixture_failure", message: "PRIVATE" } })); child.emit("close", 1); });
    return child;
  };
  const structured = await runExternalCommandCapture({ command: process.execPath, spawnProcess }, [], { failureKind: "registered-cli" });
  assert.equal(structured.errorCode, "fixture_failure"); assert.equal(JSON.stringify(structured).includes("PRIVATE"), false);
  const timeout = await runExternalCommandCapture({ command: process.execPath }, ["-e", "setTimeout(() => {}, 5000)"], { failureKind: "registered-cli", timeoutMs: 250 });
  assert.equal(timeout.errorCode, "timeout"); assert.equal(timeout.timedOut, true);
});

for (const [stderr, kind] of [
  ["401 Unauthorized PRIVATE_SECRET", "runtime_auth_rejected"],
  ["Not logged in PRIVATE_SECRET", "runtime_auth_required"],
  ["403 Forbidden PRIVATE_SECRET", "runtime_permission_denied"],
  ["402 insufficient balance PRIVATE_SECRET", "runtime_quota"],
  ["429 too many requests PRIVATE_SECRET", "runtime_rate_limit"],
  ["unknown model PRIVATE_SECRET", "invalid_model"],
  ["ECONNREFUSED PRIVATE_SECRET", "runtime_network"],
  ["proxy connect failed PRIVATE_SECRET", "runtime_proxy"],
  ["unrecognized option --fixture PRIVATE_SECRET", "version_incompatible"],
  ["thread main panicked PRIVATE_SECRET", "runtime_crashed"],
]) test(`native process failure exposes only ${kind}`, async () => {
  const spawnProcess = () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    setImmediate(() => { child.stdout.write("PRIVATE_PROMPT"); child.stderr.write(stderr); child.emit("close", 1, null); });
    return child;
  };
  const result = await runExternalCommandCapture({ command: process.execPath, spawnProcess }, [], { failureKind: "runtime" });
  assert.equal(result.errorCode, kind);
  assert.equal(result.stdout, "");
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
});

test("stable spawn errno and crash signals survive native classification", async () => {
  for (const [code, kind] of [["ENOENT", "not_installed"], ["EACCES", "runtime_permission_denied"], ["EPERM", "runtime_permission_denied"]]) {
    const result = await runExternalCommandCapture({ command: process.execPath,
      spawnProcess() { throw Object.assign(new Error("PRIVATE_SECRET"), { code }); } }, [], { failureKind: "runtime" });
    assert.equal(result.errorCode, kind); assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  }
  const spawnProcess = () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    setImmediate(() => child.emit("close", null, "SIGSEGV")); return child;
  };
  assert.equal((await runExternalCommandCapture({ command: process.execPath, spawnProcess }, [], { failureKind: "runtime" })).errorCode, "runtime_crashed");
});
