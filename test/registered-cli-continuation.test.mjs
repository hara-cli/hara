import test from "node:test";
import assert from "node:assert/strict";
import { createRegisteredCliMcpTurn } from "../dist/agent-runtime/registered-cli-mcp.js";
const args = signal => ({ system: "fixed", history: [{ role: "user", content: "current request" }], tools: [], signal });
function fixture({ canContinue = true, failed = false } = {}) {
  const controller = new AbortController(), launches = [], closes = [], follows = [];
  const turn = createRegisteredCliMcpTurn({ signal: controller.signal, assertCurrent() {},
    createEndpoint: async () => { const index = closes.length; closes.push(false); return { url: "http://127.0.0.1:1", env: {}, async close() { closes[index] = true; } }; },
    ...(canContinue ? { async prepareContinuation() { assert.equal(closes.at(-1), true); follows.push(1); } } : {}),
    async launch(_endpoint, prompt) { launches.push(prompt); return { ok: !failed, code: failed ? 1 : 0, timedOut: false, ...(failed ? { errorCode: "unknown" } : {}), stdout: JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "A visible reply" } }) }; },
  });
  return { turn, controller, launches, closes, follows };
}
test("only successful native completion permits one fresh explicit Host continuation", async () => {
 const f=fixture();try {
  assert.equal((await f.turn.turn(args(f.controller.signal))).nativeContinuation,"available");
  const next={...args(f.controller.signal),history:[{role:"user",content:"current request"},{role:"user",content:"private Host feedback"}]};
  assert.equal((await f.turn.turn(next)).nativeContinuation,"unavailable");
  assert.equal(f.launches.length,2);assert.equal(f.follows.length,1);assert.match(f.launches[1],/private Host feedback/);
  const third=await f.turn.turn(next);assert.equal(third.errorMetadata.code,"native_continuation_unavailable");assert.equal(f.launches.length,2);
 }finally{await f.turn.close();}assert(f.closes.every(Boolean));
});
test("one-shot runtimes advertise a dedicated end instead of permitting reuse",async()=>{
 const f=fixture({canContinue:false});try{assert.equal((await f.turn.turn(args(f.controller.signal))).nativeContinuation,"unavailable");const next=await f.turn.turn(args(f.controller.signal));assert.equal(next.errorMetadata.code,"native_continuation_unavailable");assert.equal(f.launches.length,1);}finally{await f.turn.close();}
});
test("failed or cancelled native runs never automatically restart",async()=>{
 const f=fixture({failed:true});try{assert.equal((await f.turn.turn(args(f.controller.signal))).stop,"error");assert.equal((await f.turn.turn(args(f.controller.signal))).stop,"error");assert.equal(f.launches.length,1);assert.equal(f.follows.length,0);}finally{await f.turn.close();}
 const cancelled=fixture();await cancelled.turn.turn(args(cancelled.controller.signal));cancelled.controller.abort();assert.equal((await cancelled.turn.turn(args(cancelled.controller.signal))).errorMsg,"interrupted");assert.equal(cancelled.launches.length,1);await cancelled.turn.close();
});
