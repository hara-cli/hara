import { test } from "node:test";
import assert from "node:assert/strict";
import { userTurnPreviews, rewindTo } from "../dist/agent/rewind.js";

const hist = () => [
  { role: "user", content: "first task please" },
  { role: "assistant", text: "ok", toolUses: [] },
  { role: "tool", results: [{ id: "1", name: "bash", content: "x" }] },
  { role: "user", content: "second task now" },
  { role: "assistant", text: "done", toolUses: [] },
];

test("userTurnPreviews: newest-first, numbered, previewed", () => {
  const t = userTurnPreviews(hist());
  assert.equal(t.length, 2);
  assert.equal(t[0].n, 1);
  assert.match(t[0].preview, /second task/);
  assert.equal(t[1].n, 2);
  assert.match(t[1].preview, /first task/);
});

test("rewindTo: truncates before the n-th-from-last user turn; out-of-range → null", () => {
  assert.deepEqual(rewindTo(hist(), 1).map((m) => m.role), ["user", "assistant", "tool"]); // drop the last exchange
  assert.equal(rewindTo(hist(), 2).length, 0); // before the first user turn → empty
  assert.equal(rewindTo(hist(), 3), null); // only 2 user turns exist
  assert.equal(rewindTo(hist(), 0), null);
  assert.equal(rewindTo(hist(), 1.5), null); // non-integer
});
