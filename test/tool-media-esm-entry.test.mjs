// Import the provider diagnostic entry before the tool/vision entry. A source loader can conceal ESM
// initialization cycles; npm test executes these static imports from the compiled Node distribution.
import test from "node:test";
import assert from "node:assert/strict";
import { safeProviderErrorMessage } from "../dist/providers/errors.js";
import { createToolImageStore } from "../dist/tools/tool-images.js";
import { runAgent } from "../dist/agent/loop.js";

test("compiled provider errors, tool media and agent entries initialize without an ESM dependency cycle", () => {
  assert.equal(typeof runAgent, "function");
  const store = createToolImageStore();
  store.dispose();
  assert.equal(safeProviderErrorMessage(new Error("ordinary diagnostic")), "ordinary diagnostic");
});
