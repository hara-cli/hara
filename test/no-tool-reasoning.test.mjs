import { test } from "node:test";
import assert from "node:assert/strict";
import { noToolReasoningEffort } from "../dist/gateway/flows-pending.js";

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
