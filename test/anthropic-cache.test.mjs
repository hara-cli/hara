// Prompt-cache breakpoints — the latency/cost win as history grows. Pins: system becomes a cached
// text block, the message tail carries rolling breakpoints, string content is lifted to a block so the
// mark can attach, and an empty system stays a bare string (no empty-block 400).
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyCacheControl } from "../dist/providers/anthropic.js";

const CC = { type: "ephemeral" };
const lastBlock = (m) => (typeof m.content === "string" ? null : m.content[m.content.length - 1]);

test("system string → single cached text block (tools+system prefix in Anthropic cache order)", () => {
  const { system } = applyCacheControl("You are hara.", []);
  assert.deepEqual(system, [{ type: "text", text: "You are hara.", cache_control: CC }]);
});

test("empty system stays a bare string (an empty cached block would 400)", () => {
  const { system } = applyCacheControl("", []);
  assert.equal(system, "");
});

test("last message gets a rolling breakpoint; string content is lifted to a block to carry it", () => {
  const msgs = [{ role: "user", content: "hi" }];
  const { messages } = applyCacheControl("sys", msgs);
  assert.equal(Array.isArray(messages[0].content), true, "string content lifted to block array");
  assert.deepEqual(lastBlock(messages[0]).cache_control, CC);
});

test("two rolling breakpoints on a long history: last message AND one ~2 back (next turn stays a hit)", () => {
  const msgs = [
    { role: "user", content: [{ type: "text", text: "a" }] },
    { role: "assistant", content: [{ type: "text", text: "b" }] },
    { role: "user", content: [{ type: "text", text: "c" }] },
    { role: "assistant", content: [{ type: "text", text: "d" }] },
  ];
  const { messages } = applyCacheControl("sys", msgs);
  assert.deepEqual(lastBlock(messages[3]).cache_control, CC, "last message marked");
  assert.deepEqual(lastBlock(messages[1]).cache_control, CC, "message 2 back marked");
  assert.equal(lastBlock(messages[0]).cache_control, undefined, "earlier messages left uncached");
  assert.equal(lastBlock(messages[2]).cache_control, undefined);
});

test("mark lands on the LAST content block (e.g. a tool_result), not the first", () => {
  const msgs = [{ role: "user", content: [{ type: "text", text: "x" }, { type: "tool_result", tool_use_id: "t1", content: "ok" }] }];
  const { messages } = applyCacheControl("sys", msgs);
  assert.equal(messages[0].content[0].cache_control, undefined);
  assert.deepEqual(messages[0].content[1].cache_control, CC);
});

test("no more than 4 breakpoints total (Anthropic's cap): system + ≤2 message marks", () => {
  const msgs = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: [{ type: "text", text: String(i) }] }));
  const { system, messages } = applyCacheControl("sys", msgs);
  const marks = (Array.isArray(system) ? system.filter((b) => b.cache_control).length : 0) + messages.reduce((n, m) => n + (Array.isArray(m.content) ? m.content.filter((b) => b.cache_control).length : 0), 0);
  assert.ok(marks <= 4, `expected ≤4 breakpoints, got ${marks}`);
});
