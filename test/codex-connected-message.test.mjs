import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAppServerAdapter } from "../dist/external-sessions/codex.js";

async function fixture(t, { nativeState = "active", wrongTurn = false, holdDelivery = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "hara-codex-connected-")); const log = join(root, "calls.jsonl"), script = join(root, "fixture.mjs");
  writeFileSync(log, "");
  writeFileSync(script, `
    import { createInterface } from "node:readline";
    import { appendFileSync } from "node:fs";
    if (process.argv.includes("--version")) process.stdout.write("codex-cli 9.9.9\\n");
    else if (process.argv.includes("daemon") && process.argv.includes("start")) process.exit(0);
    else {
      const reply = (id, result) => process.stdout.write(JSON.stringify({id,result}) + "\\n");
      createInterface({input:process.stdin}).on("line", line => {
        const req = JSON.parse(line); appendFileSync(${JSON.stringify(log)}, JSON.stringify(req) + "\\n");
        if (req.method === "initialize") reply(req.id, {userAgent:"fixture"});
        if (req.method === "thread/list") reply(req.id, {data:[{id:"private-native-thread",name:"Implementation",cwd:"/workspace/repo",
          createdAt:1780000000,updatedAt:1780000030,status:{type:"active",activeFlags:[]},source:"appServer",ephemeral:false}],nextCursor:null});
        if (req.method === "thread/read") reply(req.id, {thread:{id:req.params.threadId,status:{type:${JSON.stringify(nativeState)},activeFlags:[]}}});
        if (req.method === "thread/turns/list") reply(req.id, {data:[{id:"private-active-turn",status:"inProgress",items:[]}],nextCursor:null});
        if (req.method === "turn/steer" && !${holdDelivery}) reply(req.id, {turnId:${JSON.stringify(wrongTurn ? "wrong-turn" : "private-active-turn")}});
      });
    }
  `);
  const adapter = new CodexAppServerAdapter({ command: process.execPath, argsPrefix: [script], managedDaemon: true,
    timeoutMs: 1500, haraVersion: "fixture", identityKey: Buffer.alloc(32, 19) });
  t.after(async () => { await adapter.close(); rmSync(root, { recursive: true, force: true }); });
  const list = await adapter.list({ limit: 10 }); const sessionId = list.sessions[0].id;
  const calls = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const sink = { existingSessionMessage: true, text() { throw new Error("non-owning send must not subscribe to native output"); },
    tool() {}, notice() {}, confirm() { throw new Error("native permissions remain with original controller"); } };
  return { adapter, calls, sink, sessionId };
}
test("connected chat sends a non-owning Codex follow-up and returns accepted, never task-completed", { timeout: 10000 }, async (t) => {
  const f = await fixture(t); const result = await f.adapter.submit(f.sessionId, "Please also check UI tests.", f.sink);
  assert.equal(result.delivery, "accepted"); assert.match(result.reply, /completion has not been verified/);
  const calls = f.calls(); const steer = calls.find((call) => call.method === "turn/steer");
  assert.equal(steer.params.threadId, "private-native-thread"); assert.equal(steer.params.expectedTurnId, "private-active-turn");
  assert.equal(steer.params.input[0].text, "Please also check UI tests.");
  assert.equal(calls.some((call) => ["thread/resume", "thread/fork", "turn/start", "turn/interrupt"].includes(call.method)), false);
  assert.doesNotMatch(JSON.stringify(result), /private-native-thread|private-active-turn|\/workspace\/repo/);
});
test("idle or changed active turns are not automatically resumed, retried or replaced", { timeout: 10000 }, async (t) => {
  const idle = await fixture(t, { nativeState: "idle" });
  await assert.rejects(idle.adapter.submit(idle.sessionId, "Do work", idle.sink), /coding_link_native_turn_not_active/);
  assert.equal(idle.calls().some((call) => ["turn/steer", "turn/start", "thread/resume", "thread/fork"].includes(call.method)), false);
  const changed = await fixture(t, { wrongTurn: true });
  await assert.rejects(changed.adapter.submit(changed.sessionId, "Do work", changed.sink), /coding_link_delivery_unconfirmed/);
  assert.equal(changed.calls().filter((call) => call.method === "turn/steer").length, 1);
});
test("cancelling delivery only closes its proxy; the original Codex turn is never interrupted", { timeout: 10000 }, async (t) => {
  const f = await fixture(t, { holdDelivery: true }); const controller = new AbortController();
  const sending = f.adapter.submit(f.sessionId, "Bounded follow-up", { ...f.sink, signal: controller.signal });
  void sending.catch(() => {});
  const deadline = Date.now() + 3000;
  while (!f.calls().some((call) => call.method === "turn/steer")) {
    if (Date.now() >= deadline) throw new Error("fixture did not reach delivery");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  controller.abort(); await assert.rejects(sending);
  assert.equal(f.calls().some((call) => ["turn/interrupt", "thread/resume", "thread/fork", "turn/start"].includes(call.method)), false);
});
