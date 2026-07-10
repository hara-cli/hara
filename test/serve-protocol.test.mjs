// hara serve protocol v1 — pure layer: frame parsing + builders + error codes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFrame, rpcResult, rpcError, rpcNotify, ERR, PROTOCOL_VERSION } from "../dist/serve/protocol.js";

test("parseFrame: valid request round-trips; id and params optional", () => {
  const r = parseFrame('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"token":"t"}}');
  assert.ok("req" in r);
  assert.equal(r.req.method, "initialize");
  assert.equal(r.req.id, 1);
  assert.deepEqual(r.req.params, { token: "t" });
  const n = parseFrame('{"jsonrpc":"2.0","method":"event.ping"}');
  assert.ok("req" in n && n.req.id === undefined, "notification (no id) parses");
});

test("parseFrame: garbage / wrong shapes are rejected, never thrown", () => {
  for (const bad of ["not json", "{}", '{"jsonrpc":"1.0","method":"x"}', '{"jsonrpc":"2.0"}', '{"jsonrpc":"2.0","method":""}', '{"jsonrpc":"2.0","method":"x","id":{}}', '{"jsonrpc":"2.0","method":"x","params":[1]}']) {
    const r = parseFrame(bad);
    assert.ok("error" in r, `should reject: ${bad}`);
  }
});

test("builders: result / error / notify frames are valid JSON-RPC", () => {
  assert.deepEqual(JSON.parse(rpcResult(7, { ok: true })), { jsonrpc: "2.0", id: 7, result: { ok: true } });
  assert.deepEqual(JSON.parse(rpcError(null, ERR.PARSE, "bad")), { jsonrpc: "2.0", id: null, error: { code: -32700, message: "bad" } });
  assert.deepEqual(JSON.parse(rpcNotify("event.text", { sessionId: "s", delta: "hi" })), { jsonrpc: "2.0", method: "event.text", params: { sessionId: "s", delta: "hi" } });
});

test("error codes are distinct + protocol version pinned", () => {
  const codes = Object.values(ERR);
  assert.equal(new Set(codes).size, codes.length, "no duplicate codes");
  assert.equal(PROTOCOL_VERSION, 1);
});
