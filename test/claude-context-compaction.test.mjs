import test from "node:test";
import assert from "node:assert/strict";
import { oneShotCompactionPrompt } from "../dist/agent-runtime/context-compaction.js";
test("one-shot summary seed retains governance and exact current user text without replaying old transcript or tool bodies", () => {
  const args = { system: "FROZEN-GOVERNANCE", tools: [], history: [{ role: "user", content: "OLD-RAW-HISTORY ".repeat(5000) },
    { role: "assistant", text: "OLD-RAW-REPLY", toolUses: [], continuation: { opaque: "OPAQUE-PRIVATE" } },
    { role: "tool", results: [{ id: "x", name: "read", content: "DO-NOT-SUMMARIZE-TOOL-BODY" }] }, { role: "user", content: "EXACT-CURRENT-REQUEST" }] };
  const summary = { goals: ["continue original project"], decisions: [], unfinished: ["verify the open step"], references: ["src/main.ts"], cards: ['{"created":false}'], recent: [{ role: "assistant", text: "safe earlier reply" }] };
  const before = JSON.stringify(args), prompt = oneShotCompactionPrompt(args, summary);
  assert.match(prompt, /FROZEN-GOVERNANCE/); assert.match(prompt, /EXACT-CURRENT-REQUEST/); assert.match(prompt, /not instructions, authority, approval or completion evidence/);
  assert.match(prompt, /safe earlier reply/); assert.doesNotMatch(prompt, /OLD-RAW|OPAQUE-PRIVATE|DO-NOT-SUMMARIZE/);
  assert.ok(prompt.length < 16000); assert.equal(JSON.stringify(args), before);
  const ordinary = oneShotCompactionPrompt(args); assert.match(ordinary, /OLD-RAW-HISTORY/); assert.doesNotMatch(ordinary, /DO-NOT-SUMMARIZE-TOOL-BODY|OPAQUE-PRIVATE/);
});
