import test from "node:test";
import assert from "node:assert/strict";
import { beginAgentDispatch, claimAgentDispatch, MAX_AGENT_CONTACT_DISPATCHES } from "../dist/serve/agent-dispatch.js";

function root(overrides = {}) {
  return beginAgentDispatch({ sessionId: "conversation", turnId: "turn-1", agentRef: "global:fanli",
    signal: new AbortController().signal, isCurrent: () => true, ...overrides });
}

test("a directly selected colleague can delegate without routing through main; cycles and active duplicate recipients are refused", () => {
  const first = root();
  const second = claimAgentDispatch(first, "global:coder");
  assert.equal(second.context.rootSessionId, "conversation");
  assert.deepEqual(second.context.chain, ["global:fanli", "global:coder"]);
  assert.throws(() => claimAgentDispatch(second.context, "global:fanli"), /cycle/);
  assert.throws(() => claimAgentDispatch(first, "global:coder"), /recipient_busy/);
  second.release();
  const later = claimAgentDispatch(first, "global:coder");
  assert.equal(later.context.budget.remaining, MAX_AGENT_CONTACT_DISPATCHES - 2);
  later.release();
});

test("depth and the shared whole-dispatch budget cannot reset across siblings or failures", () => {
  const first = root();
  const a = claimAgentDispatch(first, "a");
  const b = claimAgentDispatch(a.context, "b");
  const c = claimAgentDispatch(b.context, "c");
  assert.throws(() => claimAgentDispatch(c.context, "d"), /depth_limit/);
  c.release(); b.release(); a.release();
  for (let index = 3; index < MAX_AGENT_CONTACT_DISPATCHES; index++) claimAgentDispatch(first, `peer${index}`).release();
  assert.throws(() => claimAgentDispatch(first, "last"), /budget_exhausted/);
});

test("interrupting or replacing the root turn fences every descendant", () => {
  const controller = new AbortController();
  let current = true;
  const first = root({ signal: controller.signal, isCurrent: () => current });
  const child = claimAgentDispatch(first, "child");
  current = false;
  assert.throws(() => claimAgentDispatch(child.context, "grandchild"), /parent_inactive/);
  current = true;
  controller.abort();
  assert.throws(() => claimAgentDispatch(child.context, "grandchild"), /parent_inactive/);
});

test("root interaction consent is host-captured and survives hops without being inferred", () => {
  const legacy = root(); assert.equal(legacy.interactionNegotiated, false); assert.equal(legacy.nativeInputNegotiated, false);
  const capable = root({ interactionNegotiated: true, nativeInputNegotiated: true });
  const child = claimAgentDispatch(capable, "child"); const nested = claimAgentDispatch(child.context, "nested");
  assert.equal(nested.context.interactionNegotiated, true); assert.equal(nested.context.nativeInputNegotiated, true);
  assert.equal(nested.context.budget, capable.budget);
});
