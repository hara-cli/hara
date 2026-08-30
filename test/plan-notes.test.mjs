import { test } from "node:test";
import assert from "node:assert/strict";
import { planNote, planNoteLines } from "../dist/providers/plan-notes.js";

test("a subscription plan explains the cost shape a model list cannot show", () => {
  const alibaba = planNote("token-plan");
  assert.match(alibaba.billing, /thinking chain/, "thinking is billed, not free");
  assert.match(alibaba.limits, /does not carry over/);
  assert.match(alibaba.models, /qwen3\.8-flash/);

  const minimax = planNote("minimax-token-plan");
  // Throughput is the fact that decides whether a slow turn is the plan or the client.
  assert.match(minimax.limits, /15:00–17:30/);
  assert.match(minimax.limits, /tier rather than the client/);
});

test("providers without a subscription plan add no noise", () => {
  assert.equal(planNote("anthropic"), undefined);
  assert.equal(planNote(undefined), undefined);
  assert.deepEqual(planNoteLines("openai"), []);
  assert.deepEqual(planNoteLines(undefined), []);
});

test("setup renders billing, limits, then models", () => {
  const lines = planNoteLines("token-plan");
  assert.equal(lines.length, 3);
  assert.match(lines[0], /thinking chain/);
  assert.match(lines[1], /carry over/);
  // MiniMax has no model decision to make yet — one entry in its catalog.
  assert.equal(planNoteLines("minimax-token-plan").length, 2);
});
