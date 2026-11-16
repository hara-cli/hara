import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { OP, NO_UI, MAX_REQUEST, CODES, FixtureError, encodeRequest, decodeRequest, requestAfterEOF, encodeReply, decodeReply } from "../native/dev-keychain-fixture/protocol.mjs";
const nonce = Buffer.alloc(16, 0x3a);
const request = (op = OP.SET_MANY, entries = [{ ref: "scope:connection:g1", key: "synthetic-fixture-only" }]) => ({ op, flags: NO_UI, nonce, entries });
const invalid = fn => assert.throws(fn, error => error instanceof FixtureError && error.code === "invalid_request");
for (const key of ["synthetic-fixture-only", "漢字", "emoji-😀", "𝄞"]) {
  test(`request round-trip preserves UTF-16 units: ${key.length}`, () => {
    const value = request(OP.SET_MANY, [{ ref: "scope:x:1", key }]);
    assert.deepEqual(decodeRequest(encodeRequest(value)), value);
    assert.deepEqual(decodeReply(encodeReply({ nonce, value: key }), nonce, OP.GET), { code: "ok", value: key });
  });
}
test("request/ref and key maximum boundaries round-trip", () => {
  const ref = "r".repeat(240), key = "k".repeat(16384);
  assert.equal(decodeRequest(encodeRequest(request(OP.SET_MANY, [{ ref, key }]))).entries[0].key.length, 16384);
  const entries = Array.from({ length: 256 }, (_, i) => ({ ref: `scope:c${i}:1`, key: "k".repeat(16384) }));
  const frame = encodeRequest(request(OP.SET_MANY, entries)); assert.ok(frame.length < MAX_REQUEST);
  assert.equal(decodeRequest(frame).entries.length, 256);
});
for (const key of ["", "a b", "x\ny", "x\0y", "\u00a0", "\ufeff", "\ud800", "\udc00", "k".repeat(16385)]) {
  test(`bad key is rejected before a frame is emitted (${key.length})`, () => invalid(() => encodeRequest(request(OP.SET_MANY, [{ ref: "scope:x:1", key }]))));
}
for (const entries of [[], [{ ref: "x", key: "x" }, { ref: "x", key: "y" }], [{ ref: "a:x", key: "x" }, { ref: "b:y", key: "y" }], [{ ref: "../escape", key: "x" }], [{ ref: "r".repeat(241), key: "x" }]]) {
  test("invalid count, duplicate, scope or ref is rejected", () => invalid(() => encodeRequest(request(OP.SET_MANY, entries))));
}
test("request objects cannot carry service/account/path fields", () => {
  for (const name of ["service", "account", "keychain", "path"]) invalid(() => encodeRequest({ ...request(), [name]: "not-an-input" }));
  invalid(() => encodeRequest(request(OP.SET_MANY, [{ ref: "x", key: "k", service: "other" }])));
});
for (const mutate of [b => b.writeUInt32LE(0), b => b.write("BAD1", 4), b => { b[4] |= 0x80; }, b => b.writeUInt16LE(257, 26), b => b.writeUInt32LE(0xffffffff, 30 + "scope:connection:g1".length), b => { b[8] = 99; }, b => { b[9] = 0x80; }, b => { b[30] = 0xff; }]) {
  test("malformed request wire data fails closed", () => { const b = encodeRequest(request()); mutate(b); invalid(() => decodeRequest(b)); });
}
test("all truncated prefixes and a second/tail frame are rejected", () => {
  const b = encodeRequest(request());
  for (let i = 0; i < b.length; i++) invalid(() => decodeRequest(b.subarray(0, i)));
  invalid(() => decodeRequest(Buffer.concat([b, b])));
});
test("GET and REMOVE have one reference and no key", () => {
  for (const op of [OP.GET, OP.REMOVE]) {
    assert.equal(decodeRequest(encodeRequest(request(op, [{ ref: "scope:x", key: "" }]))).op, op);
    invalid(() => encodeRequest(request(op)));
  }
});
test("streamed input is not actionable until EOF, and is length bounded", async () => {
  const stream = new PassThrough(), frame = encodeRequest(request()); let complete = false;
  const pending = requestAfterEOF(stream).then(value => { complete = true; return value; });
  stream.write(frame); await new Promise(resolve => setImmediate(resolve)); assert.equal(complete, false);
  stream.end(); assert.deepEqual(await pending, request());
  await assert.rejects(requestAfterEOF((async function* () { const b = Buffer.alloc(4); b.writeUInt32LE(MAX_REQUEST); yield b; })()), FixtureError);
});
test("reply nonce, op, error payload and trailing bytes are checked", () => {
  const found = encodeReply({ nonce, value: "synthetic" });
  invalid(() => decodeReply(found, Buffer.alloc(16), OP.GET));
  invalid(() => decodeReply(found, nonce, OP.SET_MANY));
  invalid(() => decodeReply(Buffer.concat([found, Buffer.alloc(1)]), nonce, OP.GET));
  invalid(() => encodeReply({ nonce, code: "access_denied", value: "must-not-leak" }));
  for (const code of CODES) assert.equal(decodeReply(encodeReply({ nonce, code }), nonce, OP.REMOVE).code, code);
  const changed = Buffer.from(found); changed[24] = 255; invalid(() => decodeReply(changed, nonce, OP.GET));
});
test("diagnostics do not repeat arbitrary error content", () => {
  const error = new FixtureError("synthetic-do-not-log");
  assert.equal(error.code, "unavailable"); assert.equal(error.message.includes("synthetic-do-not-log"), false);
});

test("non-enumerable and symbol selector fields are rejected too", () => {
  invalid(() => encodeRequest(Object.defineProperty(request(), "service", { value: "other" })));
  invalid(() => encodeRequest({ ...request(), [Symbol("path")]: "other" }));
  const reply = encodeReply({ nonce }); reply[4] |= 0x80; invalid(() => decodeReply(reply, nonce, OP.GET));
});
