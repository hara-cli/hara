// K1 slice 1: native codec only. Never links or calls Security.framework.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { OP, NO_UI, CODES, encodeRequest, decodeRequest, encodeReply, decodeReply } from "../native/dev-keychain-fixture/protocol.mjs";
import { helperEnvironment } from "../native/dev-keychain-fixture/fake-vault.mjs";
const native = process.platform === "darwin" ? test : test.skip;
let root, probe;
const source = fileURLToPath(new URL("../native/dev-keychain-fixture/", import.meta.url));
const nonce = Buffer.alloc(16, 0x31);
const request = (op = OP.SET_MANY, entries = [{ ref: "scope:c1:g1", key: "synthetic-native-only" }]) => ({ op, flags: NO_UI, nonce, entries });
function tool(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 15000, maxBuffer: 100000, ...options });
  assert.equal(result.error, undefined, "fixture tool could not run");
  assert.equal(result.status, 0, "fixture tool failed: " + (result.stderr || "")); return result.stdout;
}
function run(frame, args = []) {
  return spawnSync(probe, args, { input: frame, env: helperEnvironment(), timeout: 15000, maxBuffer: 8_500_001 });
}
function success(frame) {
  const result = run(frame);
  assert.equal(result.error, undefined); assert.equal(result.status, 0); assert.equal(result.stderr.length, 0);
  assert.ok(result.stdout.equals(frame), "native decoded/re-encoded frame differs"); return result.stdout;
}
function rejected(frame) {
  const result = run(frame); assert.equal(result.error, undefined); assert.equal(result.status, 64);
  assert.equal(result.stdout.length, 0); assert.equal(result.stderr.length, 0);
}
before(() => {
  if (process.platform !== "darwin") return;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hara-k1-codec-")); fs.chmodSync(root, 0o700); probe = path.join(root, "codec-probe");
  tool("/usr/bin/xcrun", ["clang", "-DK1_FAKE_ONLY=1", "-fobjc-arc", "-Wall", "-Wextra", "-Werror", "-g0", "-framework", "Foundation",
    path.join(source, "k1_codec.m"), path.join(source, "codec-probe.m"), "-o", probe]);
});
after(() => { if (root) fs.rmSync(root, { recursive: true }); }); // Only the directory created by this test; no persistent data.
native("native codec has no Security imports or framework dependency", () => {
  assert.doesNotMatch(tool("/usr/bin/nm", ["-u", probe]), /\b_Sec[A-Za-z]/);
  assert.doesNotMatch(tool("/usr/bin/otool", ["-L", probe]), /\/Security\.framework\//);
  const noDefine = spawnSync("/usr/bin/xcrun", ["clang", "-fsyntax-only", "-fobjc-arc", path.join(source, "k1_codec.m")], { encoding: "utf8", timeout: 15000 });
  assert.notEqual(noDefine.status, 0); assert.match(noDefine.stderr, /requires K1_FAKE_ONLY/);
});
for (const key of ["fixture", "漢字", "emoji-😀", "𝄞", "k".repeat(16384)]) {
  native(`native/JS request and reply agree (${key.length} UTF-16 units)`, () => {
    const value = request(OP.SET_MANY, [{ ref: "scope:c1:g1", key }]);
    assert.deepEqual(decodeRequest(success(encodeRequest(value))), value);
    assert.deepEqual(decodeReply(success(encodeReply({ nonce, value: key })), nonce, OP.GET), { code: "ok", value: key });
  });
}
native("native maximum batch, maximum ref and GET/REMOVE round-trip", () => {
  success(encodeRequest(request(OP.SET_MANY, Array.from({ length: 256 }, (_, i) => ({ ref: "scope:" + String(i).padStart(234, "r"), key: "k".repeat(16384) })))));
  for (const op of [OP.GET, OP.REMOVE]) success(encodeRequest(request(op, [{ ref: "scope:c1:g1", key: "" }])));
  for (const code of CODES) success(encodeReply({ nonce, code }));
});
native("native rejects truncated, trailing, non-ASCII magic and invalid headers", () => {
  const good = encodeRequest(request());
  for (let i = 0; i < good.length; i++) rejected(good.subarray(0, i));
  rejected(Buffer.concat([good, good]));
  for (const mutate of [b => b[4] |= 128, b => b[8] = 0, b => b[9] = 2, b => b.writeUInt16LE(257, 26), b => b.writeUInt32LE(0xffffffff)]) {
    const frame = Buffer.from(good); mutate(frame); rejected(frame);
  }
  const args = run(good, ["not-accepted"]); assert.equal(args.status, 64); assert.equal(args.stdout.length, 0);
});
native("native key validation matches JS for malformed UTF-16 and whitespace", () => {
  const good = encodeRequest(request(OP.SET_MANY, [{ ref: "scope:c1:g1", key: "x" }]));
  for (const unit of [0, 9, 10, 32, 0x7f, 0xa0, 0x1680, 0x2000, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff, 0xd800, 0xdc00]) {
    const frame = Buffer.from(good); frame.writeUInt16LE(unit, frame.length - 2); rejected(frame);
    assert.throws(() => decodeRequest(frame));
  }
  const duplicate = encodeRequest(request(OP.SET_MANY, [{ ref: "scope:a:g1", key: "a" }, { ref: "scope:b:g1", key: "b" }]));
  const second = 28 + 2 + "scope:a:g1".length + 4 + 2 + 2;
  duplicate.write("scope:a:g1", second); rejected(duplicate);
  duplicate.write("other:b:g1", second); rejected(duplicate);
});
native("native replies reject unknown states, malformed values and trailing frames", () => {
  const good = encodeReply({ nonce, value: "fixture" });
  for (const mutate of [b => b[4] |= 128, b => b[24] = 7, b => b[24] = 1, b => b[25] = 2, b => b.writeUInt32LE(16385, 26), b => b.writeUInt16LE(0xd800, 30)]) {
    const frame = Buffer.from(good); mutate(frame); rejected(frame);
  }
  rejected(Buffer.concat([good, good]));
  for (let i = 0; i < good.length; i++) rejected(good.subarray(0, i));
});
native("native emits no output before EOF, including for a complete input frame", async () => {
  const child = spawn(probe, [], { env: helperEnvironment(), stdio: ["pipe", "pipe", "pipe"] });
  let size = 0; child.stdout.on("data", chunk => size += chunk.length);
  const done = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", code => resolve(code)); });
  try {
    child.stdin.write(encodeRequest(request())); await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(size, 0);
    child.stdin.end(); assert.equal(await done, 0); assert.ok(size > 0);
  } finally { if (child.exitCode === null) child.kill(); }
});
