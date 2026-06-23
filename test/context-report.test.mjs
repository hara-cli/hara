import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeContext, formatContextReport } from "../dist/agent/context-report.js";

test("analyzeContext: groups token spend by category, biggest first", () => {
  const history = [
    { role: "user", content: "x".repeat(40) }, // ~10 tok
    { role: "assistant", text: "y".repeat(20), toolUses: [] }, // ~5
    { role: "tool", results: [{ id: "1", name: "bash", content: "z".repeat(400) }] }, // ~100
    { role: "tool", results: [{ id: "2", name: "read_file", content: "w".repeat(80) }] }, // ~20
  ];
  const r = analyzeContext(history);
  assert.equal(r.total, 10 + 5 + 100 + 20);
  assert.equal(r.rows[0].label, "tool: bash"); // biggest first
  assert.ok(r.rows[0].pct > 50);
  assert.equal(analyzeContext([]).total, 0);
});

test("formatContextReport: shows total, the biggest categories, and a window %", () => {
  const history = [{ role: "tool", results: [{ id: "1", name: "bash", content: "z".repeat(4000) }] }];
  const fmt = formatContextReport(history, "glm-5");
  assert.match(fmt, /Context ~/);
  assert.match(fmt, /tool: bash/);
  assert.match(fmt, /% of glm-5/);
  assert.equal(formatContextReport([], "glm-5"), "Context is empty.");
});
