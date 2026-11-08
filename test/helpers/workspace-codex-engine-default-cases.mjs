// All workspace-codex-engine-default cases. Thin test files register disjoint partitions so each stays well under the unchanged
// 120s per-file deadline on hosted Intel (target <= 60s per file). A case that is not listed in exactly one
// partition fails registration, so no case can be silently dropped.
import nodeTest from "node:test";
import assert from "node:assert/strict";
import { cliMcpFixture, until } from "./workspace-cli-mcp.mjs";
export const PARTITIONS = Object.freeze({
  "workspace-codex-engine-default.test.mjs": Object.freeze([
    "engine-default stays high on repeated simple turns while auto chooses low, with explicit sticky overrides",
  ]),
  "workspace-codex-engine-default-catalog.test.mjs": Object.freeze([
    "an undeclared catalog default never sends the sentinel or silently inherits sticky high",
    "high to engine-default explicitly replaces sticky high with catalog medium",
  ]),
});
const ASSIGNED = new Map(Object.entries(PARTITIONS).flatMap(([file, cases]) => cases.map(name => [name, file])));
if (ASSIGNED.size !== Object.values(PARTITIONS).flat().length) throw new Error("a case is listed in more than one partition");
export async function registerCases(file) {
  if (!Object.hasOwn(PARTITIONS, file)) throw new Error(`unknown partition ${file}`);
  const test = (name, ...rest) => {
    if (!ASSIGNED.has(name)) throw new Error(`case is not assigned to a partition: ${name}`);
    return ASSIGNED.get(name) === file ? nodeTest(name, ...rest) : undefined;
  };
const done = view => ["completed", "blocked", "paused", "cancelled"].includes(view.conversation.state);
const turns = f => f.native().filter(row => row.method === "turn/start");
const inventory = defaultReasoningEffort => ({ data: [{ id: "fixture-model", displayName: "Fixture", isDefault: true,
  supportedReasoningEfforts: ["low", "medium", "high"].map(reasoningEffort => ({ reasoningEffort })),
  ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}) }] });
async function select(f, effort) {
  const models = await f.request("workspace.runtime.listModels", { ...f.scope, runtimeId: "codex" });
  await f.request("workspace.runtime.selectModel", { ...f.scope, runtimeId: "codex", modelId: "fixture-model", expectedRevision: models.revision, effort });
  assert.equal((await f.request("workspace.runtime.listModels", { ...f.scope, runtimeId: "codex" })).selectedEffort, effort, "selection is not rewritten into an automatic/fixed level");
}
async function hello(f) { await f.send("你好"); return until(f.read, done); }
test("engine-default stays high on repeated simple turns while auto chooses low, with explicit sticky overrides", async t => {
  const f = await cliMcpFixture(t, "reply", { inventory: inventory("high") });
  await select(f, "engine-default"); await hello(f); await hello(f);
  await select(f, "auto"); await hello(f);
  assert.deepEqual(turns(f).map(row => [row.params.model, row.params.effort]), [["fixture-model", "high"], ["fixture-model", "high"], ["fixture-model", "low"]]);
  assert.equal(new Set(turns(f).map(row => row.params.threadId)).size, 1);
  assert.equal(f.native().some(row => row.method === "thread/resume"), false);
});
test("high to engine-default explicitly replaces sticky high with catalog medium", async t => {
  const f = await cliMcpFixture(t, "reply", { inventory: inventory("medium") });
  await select(f, "high"); await hello(f); await select(f, "engine-default"); await hello(f);
  assert.deepEqual(turns(f).map(row => row.params.effort), ["high", "medium"]);
  assert.equal(new Set(turns(f).map(row => row.params.threadId)).size, 1);
});
test("an undeclared catalog default never sends the sentinel or silently inherits sticky high", async t => {
  const f = await cliMcpFixture(t, "reply", { inventory: inventory(null) });
  await select(f, "high"); await hello(f); await select(f, "engine-default"); const view = await hello(f);
  assert.equal(turns(f).length, 1, "no user turn is submitted with unconfirmed defaults");
  assert.equal(view.conversation.taskState, "blocked");
  assert.match(view.conversation.blockReason ?? "", /invalid_model|codex_default_settings_unconfirmed/);
});
}
