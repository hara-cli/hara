import { test } from "node:test";
import assert from "node:assert/strict";
import { noToolReasoningAdvisory, noToolReasoningEffort } from "../dist/gateway/flows-pending.js";

test("schema-forced no-tool judgments default to off for every provider", () => {
  // The default belongs to the call SHAPE: no tools + a forced schema is fill-in-the-blank.
  assert.equal(noToolReasoningEffort(undefined, "high", true), "off");
  assert.equal(noToolReasoningEffort(undefined, undefined, true), "off");
});

test("free-form no-tool prompts keep the profile's normal setting", () => {
  assert.equal(noToolReasoningEffort(undefined, "high", false), "high");
  assert.equal(noToolReasoningEffort(undefined, undefined, false), undefined);
});

test("a caller can force a level or explicitly inherit", () => {
  assert.equal(noToolReasoningEffort("medium", "high", true), "medium");
  assert.equal(noToolReasoningEffort("off", "high", false), "off");
  // "inherit" is how a rule that genuinely wants the chain back opts out of the default.
  assert.equal(noToolReasoningEffort("inherit", "high", true), "high");
  assert.equal(noToolReasoningEffort("inherit", undefined, true), undefined);
});

test("only an engine-chosen level is advisory enough to drop on rejection", () => {
  // Nobody asked for the schema-forced default, so a strict endpoint may be retried without it.
  assert.equal(noToolReasoningAdvisory(undefined, undefined, true), true);
  // A free-form call inherits the profile setting — that is a user choice, not ours.
  assert.equal(noToolReasoningAdvisory(undefined, undefined, false), false);
  // An explicit level, and "inherit" (which names the profile's own setting), are contracts.
  assert.equal(noToolReasoningAdvisory("high", true, true), true);
  assert.equal(noToolReasoningAdvisory("high", undefined, true), false);
  assert.equal(noToolReasoningAdvisory("inherit", true, true), false);
});
