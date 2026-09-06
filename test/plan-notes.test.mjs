import { test } from "node:test";
import assert from "node:assert/strict";
import { planNote, planNoteLines } from "../dist/providers/plan-notes.js";

test("subscription notes preserve each provider's native accounting authority", () => {
  const alibaba = planNote("token-plan");
  assert.match(alibaba.metering, /Alibaba Cloud is authoritative/);
  assert.match(alibaba.metering, /context telemetry, not a billing calculation/);
  assert.match(alibaba.visibility, /show unavailable rather than estimate/);
  assert.match(alibaba.models, /live key-scoped model list/);

  const minimax = planNote("minimax-token-plan");
  assert.match(minimax.metering, /MiniMax is authoritative/);
  assert.match(minimax.visibility, /account usage surface/);

  const volcengine = planNote("volcengine-agent-plan");
  assert.match(volcengine.metering, /Volcengine Ark is authoritative/);
  assert.match(volcengine.metering, /not a Fuel Point or billing calculation/);
  assert.match(volcengine.models, /live account catalog is authoritative/);

  const rendered = [alibaba, minimax, volcengine].flatMap((note) => Object.values(note)).join("\n");
  assert.doesNotMatch(
    rendered,
    /5-hour|weekly|monthly|half price|cheapest|15:00|17:30/i,
    "setup must not freeze provider/plan-specific pricing or reset formulas",
  );
});

test("providers without a subscription plan add no noise", () => {
  assert.equal(planNote("anthropic"), undefined);
  assert.equal(planNote(undefined), undefined);
  assert.deepEqual(planNoteLines("openai"), []);
  assert.deepEqual(planNoteLines(undefined), []);
});

test("setup renders authority, visibility, then model guidance", () => {
  const lines = planNoteLines("token-plan");
  assert.equal(lines.length, 3);
  assert.match(lines[0], /authoritative/);
  assert.match(lines[1], /remaining allowance/);
  // MiniMax has no model decision to make yet — one entry in its catalog.
  assert.equal(planNoteLines("minimax-token-plan").length, 2);
  assert.equal(planNoteLines("volcengine-agent-plan").length, 3);
});
