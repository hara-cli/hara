import { test } from "node:test";
import assert from "node:assert/strict";
import { vimNormal } from "../dist/tui/vim.js";

const S = (value, cursor, over = {}) => ({ value, cursor, mode: "normal", pending: "", register: "", ...over });

test("motions: h l 0 $ w b e", () => {
  assert.equal(vimNormal(S("hello world", 0), "l").cursor, 1);
  assert.equal(vimNormal(S("hello world", 5), "h").cursor, 4);
  assert.equal(vimNormal(S("hello world", 5), "0").cursor, 0);
  assert.equal(vimNormal(S("hello world", 0), "$").cursor, 11);
  assert.equal(vimNormal(S("hello world", 0), "w").cursor, 6, "start of 'world'");
  assert.equal(vimNormal(S("hello world", 6), "b").cursor, 0, "back to 'hello'");
  assert.equal(vimNormal(S("hello world", 0), "e").cursor, 4, "end of 'hello'");
});

test("enter insert mode: i a A I", () => {
  assert.deepEqual([vimNormal(S("abc", 1), "i")].map((s) => [s.mode, s.cursor])[0], ["insert", 1]);
  assert.deepEqual([vimNormal(S("abc", 1), "a")].map((s) => [s.mode, s.cursor])[0], ["insert", 2]);
  assert.deepEqual([vimNormal(S("abc", 0), "A")].map((s) => [s.mode, s.cursor])[0], ["insert", 3]);
  assert.deepEqual([vimNormal(S("  abc", 4), "I")].map((s) => [s.mode, s.cursor])[0], ["insert", 2], "first non-space");
});

test("x deletes the char under the cursor (into the register)", () => {
  const s = vimNormal(S("abc", 1), "x");
  assert.equal(s.value, "ac");
  assert.equal(s.register, "b");
  assert.equal(s.mode, "normal");
});

test("D deletes to end; C does too but enters insert", () => {
  const d = vimNormal(S("hello world", 5), "D");
  assert.equal(d.value, "hello");
  assert.equal(d.register, " world");
  assert.equal(d.mode, "normal");
  const ch = vimNormal(S("hello world", 5), "C");
  assert.equal(ch.value, "hello");
  assert.equal(ch.mode, "insert");
});

test("dd / cc clear the whole line", () => {
  const dd = vimNormal(vimNormal(S("hello", 2), "d"), "d");
  assert.equal(dd.value, "");
  assert.equal(dd.register, "hello");
  assert.equal(dd.mode, "normal");
  const cc = vimNormal(vimNormal(S("hello", 2), "c"), "c");
  assert.equal(cc.value, "");
  assert.equal(cc.mode, "insert");
});

test("dw deletes a word; cw changes to word-end (ce), entering insert", () => {
  const dw = vimNormal(vimNormal(S("hello world", 0), "d"), "w");
  assert.equal(dw.value, "world");
  assert.equal(dw.register, "hello ");
  const cw = vimNormal(vimNormal(S("hello world", 0), "c"), "w");
  assert.equal(cw.value, " world", "cw leaves the trailing space (ce semantics)");
  assert.equal(cw.mode, "insert");
});

test("p pastes the register after the cursor; P before it", () => {
  assert.equal(vimNormal(S("ac", 0, { register: "b" }), "p").value, "abc");
  assert.equal(vimNormal(S("ac", 1, { register: "X" }), "P").value, "aXc");
});

test("gg → start; unknown keys are inert (no insert)", () => {
  assert.equal(vimNormal(vimNormal(S("hello", 3), "g"), "g").cursor, 0);
  assert.deepEqual(vimNormal(S("hello", 2), "z"), { value: "hello", cursor: 2, mode: "normal", pending: "", register: "" });
});

test("an operator followed by an unknown motion cancels (no destruction)", () => {
  const s = vimNormal(vimNormal(S("hello", 2), "d"), "z");
  assert.equal(s.value, "hello");
  assert.equal(s.pending, "");
});
