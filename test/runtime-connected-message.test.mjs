import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HaraRuntimeAdapter } from "../dist/external-sessions/runtime.js";

async function fixture(t, { promptDelayMs = 0 } = {}) {
  const root = mkdtempSync(join(tmpdir(), "hara-runtime-connected-"));
  const script = join(root, "fixture.mjs"), log = join(root, "calls.jsonl");
  const children = new Set(); let onSpawn = () => {};
  let promptEntered;
  const promptReady = new Promise(resolve => { promptEntered = resolve; });
  writeFileSync(log, "");
  writeFileSync(script, `
    import { appendFileSync } from "node:fs";
    import { setTimeout as delay } from "node:timers/promises";
    const args = process.argv.slice(4);
    if (args[0] === "agent" && args[1] === "prompt") await delay(${promptDelayMs});
    appendFileSync(${JSON.stringify(log)}, JSON.stringify(args.slice(0, 3)) + "\\n");
    const agent = { agent:"codex", agent_status:"idle", cwd:"/fixture/repo", interactive_ready:true,
      name:"Selected worker", pane_id:"native-pane", terminal_id:"native-terminal", workspace_id:"native-workspace", state_change_seq:1 };
    const reply = result => process.stdout.write(JSON.stringify({ result }) + "\\n");
    if (args[0] === "agent" && args[1] === "list") reply({ type:"agent_list", agents:[agent] });
    else if (args[0] === "agent" && args[1] === "get") reply({ type:"agent_info", agent });
    else if (args[0] === "agent" && args[1] === "read") process.stdout.write("Original terminal output");
    else if (args[0] === "agent" && args[1] === "prompt") {
      process.send("native-prompt-ready");
      setInterval(() => {}, 60000);
    }
    else process.exit(1);
  `);
  const adapter = new HaraRuntimeAdapter({ command: process.execPath, argsPrefix: [script],
    identityHome: root, runtimeRoot: join(root, "runtime"), identityKey: Buffer.alloc(32, 17),
    spawnProcess(command, args, options) {
      assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
      const child = spawn(command, [...args], { ...options, stdio: ["ignore", "pipe", "pipe", "ipc"] });
      child.on("message", message => { if (message === "native-prompt-ready") promptEntered(); });
      children.add(child); onSpawn(args.slice(3)); return child;
    },
  });
  t.after(async () => {
    await adapter.close();
    await Promise.all([...children].map((child) => child.exitCode !== null || child.signalCode !== null ? undefined
      : new Promise((resolve) => { child.once("close", resolve); child.kill("SIGKILL"); })));
    rmSync(root, { recursive: true, force: true });
  });
  const sessionId = (await adapter.list({ limit: 10 })).sessions[0].id;
  return { adapter, sessionId, promptReady, onSpawn: (fn) => { onSpawn = fn; },
    calls: () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)),
    sink: { existingSessionMessage: true, text() { throw new Error("cancelled relay must not project output"); }, notice() {}, tool() {}, confirm: async () => false } };
}

test("revocation during the runtime's async read prevents native prompt delivery", { timeout: 10000 }, async (t) => {
  const f = await fixture(t); const controller = new AbortController();
  f.onSpawn((args) => { if (args[0] === "agent" && args[1] === "read") controller.abort(); });
  await assert.rejects(f.adapter.submit(f.sessionId, "Must not send", { ...f.sink, signal: controller.signal }), /coding_link_cancelled/);
  assert.equal(f.calls().some((args) => args[1] === "prompt"), false);
  assert.equal(f.calls().some((args) => ["send-keys", "start", "close"].includes(args[1])), false);
});

async function assertPromptRevocation(t, promptDelayMs = 0) {
  const f = await fixture(t, { promptDelayMs }); const controller = new AbortController();
  const sending = f.adapter.submit(f.sessionId, "One follow-up", { ...f.sink, signal: controller.signal });
  void sending.catch(() => {});
  // Actual child readiness, not an OS-spawn callback or an arbitrary 3 s filesystem poll.
  // The enclosing test timeout still bounds a missing event, and an early submit failure propagates.
  await Promise.race([f.promptReady, sending.then(() => { throw new Error("fixture ended before native prompt readiness"); })]);
  controller.abort(); await assert.rejects(sending, /coding_link_delivery_unconfirmed/);
  assert.equal(f.calls().filter((args) => args[1] === "prompt").length, 1);
  assert.equal(f.calls().some((args) => ["send-keys", "start", "close"].includes(args[1])), false);
}

test("revocation after runtime prompt closes only the relay wait and never interrupts the original terminal", { timeout: 10000 }, async (t) => {
  await assertPromptRevocation(t);
});

test("slow native fixture readiness still revokes one relay without retrying or interrupting its terminal", { timeout: 20000 }, async (t) => {
  await assertPromptRevocation(t, 3500);
});
