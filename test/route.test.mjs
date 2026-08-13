import { test } from "node:test";
import assert from "node:assert/strict";
import { isTrivialTurn, lastUserText, routingProvider } from "../dist/agent/route.js";

test("isTrivialTurn: trivial Q&A → true; coding/action/code/long → false (conservative)", () => {
  assert.equal(isTrivialTurn("what is a closure?"), true);
  assert.equal(isTrivialTurn("thanks!"), true);
  assert.equal(isTrivialTurn("which is faster, map or a plain loop"), true);
  assert.equal(isTrivialTurn("explain this error message"), false); // "error" is an action/coding signal
  assert.equal(isTrivialTurn("fix the bug in app.js"), false);
  assert.equal(isTrivialTurn("refactor this function"), false);
  assert.equal(isTrivialTurn("add a test for the parser"), false);
  assert.equal(isTrivialTurn("修复这个问题"), false);
  assert.equal(isTrivialTurn("继续优化并发布"), false);
  assert.equal(isTrivialTurn("开始"), false, "a continuation command must retain the context-capable primary model");
  assert.equal(isTrivialTurn("谢谢"), true);
  assert.equal(isTrivialTurn("什么是闭包？"), true);
  assert.equal(isTrivialTurn("这是一段较长的中文说明，用于确认没有空格的实质内容不会仅仅因为它没有英文动作词就被当作普通闲聊并路由到较弱的备用模型，从而降低理解和执行质量。"), false);
  assert.equal(isTrivialTurn("`npm test`"), false); // backtick / code
  assert.equal(isTrivialTurn("see https://example.com"), false); // URL
  assert.equal(isTrivialTurn("x".repeat(200)), false); // too long
  assert.equal(isTrivialTurn("line one\nline two"), false); // multi-line
  assert.equal(isTrivialTurn(""), false);
});

test("lastUserText: last role:user content; ignores assistant + tool messages", () => {
  const h = [
    { role: "user", content: "first" },
    { role: "assistant", text: "ok", toolUses: [] },
    { role: "tool", results: [{ id: "1", name: "ls", content: "files" }] },
  ];
  assert.equal(lastUserText(h), "first"); // stable across a turn's tool rounds
  h.push({ role: "user", content: "second question" });
  assert.equal(lastUserText(h), "second question");
  assert.equal(lastUserText([]), "");
});

test("routingProvider: trivial→alt, real work→primary; reports the primary model", async () => {
  const mk = (id) => ({
    id,
    model: id + "-model",
    calls: 0,
    async turn() {
      this.calls++;
      return { text: id, toolUses: [], stop: "end" };
    },
  });
  const primary = mk("primary");
  const alt = mk("alt");
  const rp = routingProvider(primary, alt);
  assert.equal(rp.model, "primary-model"); // transparent: reports primary

  const a = await rp.turn({ system: "", history: [{ role: "user", content: "what is a monad?" }], tools: [], onText() {} });
  assert.equal(a.text, "alt"); // trivial → alt
  const b = await rp.turn({ system: "", history: [{ role: "user", content: "refactor the auth module and fix the bug" }], tools: [], onText() {} });
  assert.equal(b.text, "primary"); // coding → primary
  assert.equal(alt.calls, 1);
  assert.equal(primary.calls, 1);
});
