// CC-learning items ② + ④: post-compaction file restore (TW5) and the context threshold ladder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFileRestore } from "../dist/agent/compact.js";
import { recordTouch, recentTouched, clearTouched } from "../dist/agent/touched.js";
import { runAgent } from "../dist/agent/loop.js";
import { footerParts } from "../dist/tui/InputBox.js";
import { resolve } from "node:path";

test("touched: most-recent-first, capped, clearable", async () => {
  clearTouched();
  recordTouch("/a");
  await new Promise((r) => setTimeout(r, 2));
  recordTouch("/b");
  await new Promise((r) => setTimeout(r, 2));
  recordTouch("/a"); // re-touch bumps recency
  assert.deepEqual(recentTouched(2), ["/a", "/b"], "recency order, re-touch bumps");
  clearTouched();
  assert.deepEqual(recentTouched(), [], "clearable");
});

test("loop records MAIN-loop file-tool touches (quiet fan-outs don't pollute the working set)", async () => {
  clearTouched();
  const fileTool = {
    name: "read_file",
    description: "read",
    input_schema: { type: "object", properties: { path: { type: "string" } } },
    kind: "read",
    run: async () => "content",
  };
  const provider = (path) => {
    let done = false;
    return {
      id: "f",
      model: "f",
      async turn() {
        if (done) return { text: "ok", toolUses: [], stop: "end" };
        done = true;
        return { text: "", toolUses: [{ id: "t1", name: "read_file", input: { path } }], stop: "tool_use" };
      },
    };
  };
  const base = (p, quiet) => ({ provider: provider(p), ctx: { cwd: process.cwd(), ui: { text() {}, reasoning() {}, tool() {}, diff() {}, notice() {} } }, approval: "full-auto", confirm: async () => true, extraTools: [fileTool], quiet });
  await runAgent([{ role: "user", content: "go" }], base("src/thing.ts", false));
  assert.deepEqual(recentTouched(1), [resolve(process.cwd(), "src/thing.ts")], "main-loop read recorded (resolved absolute)");
  clearTouched();
  await runAgent([{ role: "user", content: "go" }], base("src/other.ts", true));
  assert.deepEqual(recentTouched(), [], "quiet run recorded nothing");
});

test("buildFileRestore: caps per-file + total, marks truncation, skips unreadable, null when empty", () => {
  const files = { "/big": "x".repeat(10_000), "/small": "hello", "/gone": null };
  const readFn = (p) => files[p] ?? null;
  const out = buildFileRestore(["/big", "/gone", "/small"], readFn, { perFileBytes: 100, totalBytes: 120 });
  assert.ok(out.includes("--- /big (truncated) ---"), "over-cap file marked truncated");
  assert.ok(out.includes("restored after compaction"), "framing present");
  // total budget: /big ate 100, /small gets the remaining 20 → 'hello' fits whole
  assert.ok(out.includes("--- /small ---") && out.includes("hello"), "later file fits in remaining budget");
  assert.ok(!out.includes("/gone"), "unreadable file skipped silently");
  assert.equal(buildFileRestore(["/gone"], readFn), null, "nothing readable → null (no empty message)");
});

test("footer ctx ladder: ok < 60 ≤ warn < 80 ≤ high (and footerLine keeps the full string)", () => {
  const S = (pct) => ({ sessionName: "s", approval: "suggest", input: 0, output: 0, ctxPct: pct, agents: 0 });
  assert.equal(footerParts("m", S(59), "~").ctxLevel, "ok");
  assert.equal(footerParts("m", S(60), "~").ctxLevel, "warn");
  assert.equal(footerParts("m", S(79), "~").ctxLevel, "warn");
  assert.equal(footerParts("m", S(80), "~").ctxLevel, "high");
  const p = footerParts("m", S(42), "~");
  assert.ok((p.prefix + p.mode + p.suffix + p.ctx).includes("ctx 42%"), "ctx field intact in the recomposed line");
});
