import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentRestorationTool } from "../dist/serve/agent-restorer.js";
import { toolOperationTraits } from "../dist/tools/registry.js";
import { runAgent } from "../dist/agent/loop.js";

const target = { ref: "nanhara:pm", name: "Product colleague", revision: "a".repeat(32), dismissedAt: "2026-10-12T00:00:00.000Z" };
const input = { ref: target.ref, expectedRevision: target.revision, dismissedAt: target.dismissedAt };

async function restoreRun({ decision = true, interactive = true, duringConfirm = () => {} } = {}) {
  let writes = 0, confirms = 0, round = 0, allowed = true, current = { ...target };
  const tool = createAgentRestorationTool({
    assertPersonalRoot() { if (!allowed) throw new Error("authority revoked"); },
    inspect(ref) { return ref === current.ref ? current : undefined; },
    restore(saved) { writes++; assert.deepEqual(saved, target); return { ref: saved.ref, restored: true }; },
  });
  const history = [{ role: "user", content: "Restore the original project colleague" }];
  await runAgent(history, {
    ctx: { cwd: process.cwd(), spaceId: "personal" }, approval: "full-auto", approvalChannel: interactive,
    autoApprove: new Set(["agent_restore"]), quiet: true, hooks: false, extraTools: [tool],
    provider: { id: "fixture", model: "fixture", async turn() { return round++ === 0
      ? { text: "", stop: "tool_use", toolUses: [{ id: "restore", name: tool.name, input }] }
      : { text: "done", stop: "end", toolUses: [] }; } },
    confirm: async (question, _signal, options) => {
      confirms++; assert.equal(writes, 0); assert.equal(options.allowAlways, false);
      assert.match(question, /nanhara:pm/);
      duringConfirm({ revoke() { allowed = false; }, change() { current = { ...current, revision: "b".repeat(32) }; } });
      return decision;
    },
  });
  return { writes, confirms, history };
}

test("restoration requires one live exact-target decision even with full-auto and remembered tool permission", async () => {
  assert.equal((await restoreRun()).writes, 1);
  assert.deepEqual(await restoreRun({ decision: false }).then(({ writes, confirms }) => ({ writes, confirms })), { writes: 0, confirms: 1 });
  assert.deepEqual(await restoreRun({ interactive: false }).then(({ writes, confirms }) => ({ writes, confirms })), { writes: 0, confirms: 0 });
});

test("revocation and a changed archived source during confirmation cannot restore the colleague", async () => {
  for (const duringConfirm of [({ revoke }) => revoke(), ({ change }) => change()]) {
    const result = await restoreRun({ duringConfirm });
    assert.equal(result.confirms, 1); assert.equal(result.writes, 0);
    assert.match(JSON.stringify(result.history), /Error:.*(?:revoked|changed)/);
  }
});

test("restoration refuses bare names, stale identity, replacement instructions and authority fields", async () => {
  let writes = 0;
  const tool = createAgentRestorationTool({ assertPersonalRoot() {}, inspect() { return target; }, restore() { writes++; return {}; } });
  for (const invalid of [
    { ...input, ref: "main" }, { ...input, ref: "pm" }, { ...input, expectedRevision: "b".repeat(32) },
    { ...input, dismissedAt: "2026-10-11T00:00:00.000Z" }, { ...input, instructions: "overwrite" },
    { ...input, permissions: ["computer"] }, { ...input, ref: "other:pm" },
  ]) {
    assert.equal(toolOperationTraits(tool, invalid, { cwd: process.cwd() }).requiresExplicitApproval, undefined);
    assert.match(await tool.run(invalid, { cwd: process.cwd() }), /^Error:/);
  }
  assert.equal(writes, 0);
});

test("a read-only refusal cannot acquire restoration authority when an archive appears before execution", async () => {
  let current, writes = 0;
  const tool = createAgentRestorationTool({ assertPersonalRoot() {}, inspect() { return current; }, restore() { writes++; return {}; } });
  const request = { ...input };
  assert.equal(toolOperationTraits(tool, request, { cwd: process.cwd() }).effect, "state");
  current = { ...target };
  assert.match(await tool.run(request, { cwd: process.cwd() }), /Error: No classified restoration proposal/);
  assert.equal(writes, 0);
});
