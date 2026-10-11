import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HaraRuntimeAdapter } from "../dist/external-sessions/runtime.js";

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "hara-runtime-connected-"));
  const script = join(root, "fixture.mjs"), log = join(root, "calls.jsonl");
  const children = new Set(); let onSpawn = () => {};
  writeFileSync(log, "");
  writeFileSync(script, `
    import { appendFileSync } from "node:fs";
    const args = process.argv.slice(4);
    appendFileSync(${JSON.stringify(log)}, JSON.stringify(args.slice(0, 3)) + "\\n");
    const agent = { agent:"codex", agent_status:"idle", cwd:"/fixture/repo", interactive_ready:true,
      name:"Selected worker", pane_id:"native-pane", terminal_id:"native-terminal", workspace_id:"native-workspace", state_change_seq:1 };
    const reply = result => process.stdout.write(JSON.stringify({ result }) + "\\n");
    if (args[0] === "agent" && args[1] === "list") reply({ type:"agent_list", agents:[agent] });
    else if (args[0] === "agent" && args[1] === "get") reply({ type:"agent_info", agent });
    else if (args[0] === "agent" && args[1] === "read") process.stdout.write("Original terminal output");
    else if (args[0] === "agent" && args[1] === "prompt") setInterval(() => {}, 60000);
    else process.exit(1);
  `);
  const adapter = new HaraRuntimeAdapter({ command: process.execPath, argsPrefix: [script],
    identityHome: root, runtimeRoot: join(root, "runtime"), identityKey: Buffer.alloc(32, 17),
    spawnProcess(command, args, options) {
      const child = spawn(command, [...args], options); children.add(child); onSpawn(args.slice(3)); return child;
    },
  });
  t.after(async () => {
    await adapter.close();
    await Promise.all([...children].map((child) => child.exitCode !== null || child.signalCode !== null ? undefined
      : new Promise((resolve) => { child.once("close", resolve); child.kill("SIGKILL"); })));
    rmSync(root, { recursive: true, force: true });
  });
  const sessionId = (await adapter.list({ limit: 10 })).sessions[0].id;
  return { adapter, sessionId, onSpawn: (fn) => { onSpawn = fn; },
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

test("revocation after runtime prompt closes only the relay wait and never interrupts the original terminal", { timeout: 10000 }, async (t) => {
  const f = await fixture(t); const controller = new AbortController();
  const sending = f.adapter.submit(f.sessionId, "One follow-up", { ...f.sink, signal: controller.signal });
  void sending.catch(() => {});
  const deadline = Date.now() + 3000;
  while (!f.calls().some((args) => args[1] === "prompt")) {
    if (Date.now() >= deadline) throw new Error("fixture did not reach native prompt");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  controller.abort(); await assert.rejects(sending, /coding_link_delivery_unconfirmed/);
  assert.equal(f.calls().filter((args) => args[1] === "prompt").length, 1);
  assert.equal(f.calls().some((args) => ["send-keys", "start", "close"].includes(args[1])), false);
});
