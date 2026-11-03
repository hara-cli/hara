import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { runExternalCommandCapture } from "../dist/external-sessions/process.js";
test("protected cancellation waits for physical close before policy cleanup", async () => {
  const controller = new AbortController(), child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
  let resolved = false;
  const pending = runExternalCommandCapture({ command: process.execPath, spawnProcess: () => child }, [], {
    signal: controller.signal, waitForClose: true, timeoutMs: 1000
  }).then(value => { resolved = true; return value; });
  controller.abort(); await new Promise(resolve => setImmediate(resolve)); assert.equal(resolved, false);
  child.emit("close", null, "SIGKILL");
  const result = await pending; assert.equal(result.ok, false); assert.equal(result.errorCode, "interrupted");
});
test("protected spawn errors retain the boundary until close", async () => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  let resolved = false;
  const pending = runExternalCommandCapture({ command: process.execPath, spawnProcess: () => child }, [], {
    waitForClose: true, timeoutMs: 1000
  }).then(value => { resolved = true; return value; });
  child.emit("error", Object.assign(new Error("fixture spawn failed"), { code: "ENOENT" }));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(resolved, false);
  child.emit("close", -2); assert.equal((await pending).errorCode, "command_not_found");
});

test("late abort inside spawn cannot release protection before close listeners exist", async () => {
  const controller = new AbortController(), child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
  let finished = false;
  const pending = runExternalCommandCapture({ command: process.execPath, spawnProcess() { controller.abort(); return child; } }, [], {
    signal: controller.signal, waitForClose: true
  }).then(result => { finished = true; return result; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(finished, false);
  child.emit("close", null, "SIGKILL"); assert.equal((await pending).errorCode, "interrupted");
});
