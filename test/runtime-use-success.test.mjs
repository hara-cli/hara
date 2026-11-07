import test from "node:test";
import assert from "node:assert/strict";
import { runtimeUseProtocolSucceeded } from "../dist/agent-runtime/runtime-use-success.js";
const partial = '{"type":"item.completed","item":{"type":"agent_message","text":"PRIVATE_PARTIAL_OUTPUT"}}';
test("success history requires a real Codex completion, not partial output, a lifecycle event or a zero-exit error", () => {
  assert.equal(runtimeUseProtocolSucceeded("codex", partial), false);
  assert.equal(runtimeUseProtocolSucceeded("codex", '{"type":"thread.started","thread_id":"private"}'), false);
  assert.equal(runtimeUseProtocolSucceeded("codex", partial+'\n{"type":"turn.completed"}'), true);
  for (const failure of ['{"type":"turn.failed","error":{"message":"PRIVATE_ERROR"}}', '{"type":"error","message":"PRIVATE_ERROR"}',
    '{"type":"item.completed","item":{"type":"error","message":"PRIVATE_ERROR"}}']) {
    assert.equal(runtimeUseProtocolSucceeded("codex", partial+'\n'+failure), false);
    assert.equal(runtimeUseProtocolSucceeded("codex", partial+'\n{"type":"turn.completed"}\n'+failure), false);
    assert.equal(runtimeUseProtocolSucceeded("codex", partial+'\n'+failure+'\n{"type":"turn.completed"}'), true,
      "an explicit later successful turn can recover an earlier error, matching failure diagnostics");
  }
  for (const output of ['', 'plain old fixture output', '[]', 'null', '{', '{"type":"turn.completed"}\ntruncated-json', 'x'.repeat(2*1024*1024+1)])
    assert.equal(runtimeUseProtocolSucceeded("codex", output), false);
});
test("Claude success history requires a bounded terminal success frame", () => {
  assert.equal(runtimeUseProtocolSucceeded("claude", "buffered response"), false);
  assert.equal(runtimeUseProtocolSucceeded("claude", JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "final reply" })), true);
  assert.equal(runtimeUseProtocolSucceeded("claude", " \n"), false);
  assert.equal(runtimeUseProtocolSucceeded("claude", "x".repeat(2*1024*1024+1)), false);
});
