import { test } from "node:test";
import assert from "node:assert/strict";
import { getTool } from "../dist/tools/registry.js";
import { actionAllowed, keyIsBlocked } from "../dist/tools/computer.js";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("actionAllowed: the tier gates each action", () => {
  assert.equal(actionAllowed("off", "screenshot"), false);
  assert.equal(actionAllowed("read", "screenshot"), true);
  assert.equal(actionAllowed("read", "click"), false);
  assert.equal(actionAllowed("click", "click"), true);
  assert.equal(actionAllowed("click", "move"), true);
  assert.equal(actionAllowed("click", "type"), false); // typing needs full
  assert.equal(actionAllowed("full", "type"), true);
  assert.equal(actionAllowed("full", "key"), true);
});

test("keyIsBlocked: dangerous combos refused, safe ones allowed", () => {
  for (const k of ["cmd+q", "ctrl+alt+delete", "alt+f4", "cmd+w", "command+q"]) assert.equal(keyIsBlocked(k), true, k);
  for (const k of ["cmd+c", "return", "ctrl+s", "tab", "cmd+v", "enter"]) assert.equal(keyIsBlocked(k), false, k);
});

test("keyIsBlocked: catches Windows SendKeys + Linux keysym forms the combo regex missed", () => {
  for (const k of ["%{F4}", "^{F4}", "^w", "XF86LogOff", "XF86PowerOff", "xf86reboot"]) assert.equal(keyIsBlocked(k), true, `should block ${k}`);
  // bare editing/navigation keys stay allowed (Delete/Backspace are needed to edit text)
  for (const k of ["Delete", "BackSpace", "{DEL}", "%{TAB}", "Home", "End"]) assert.equal(keyIsBlocked(k), false, `should allow ${k}`);
});

test("computer tool: gates on tier + app allowlist (deterministic refusal paths)", async () => {
  const t = getTool("computer");
  assert.ok(t && t.kind === "computer");
  const save = { u: process.env.HARA_COMPUTER_USE, a: process.env.HARA_COMPUTER_APPS };
  try {
    process.env.HARA_COMPUTER_USE = "off";
    assert.match(await t.run({ action: "screenshot" }, { cwd: process.cwd() }), /off/i);
    process.env.HARA_COMPUTER_USE = "read";
    assert.match(await t.run({ action: "click", x: 1, y: 1 }, { cwd: process.cwd() }), /higher tier/i);
    process.env.HARA_COMPUTER_USE = "click";
    process.env.HARA_COMPUTER_APPS = "";
    assert.match(await t.run({ action: "click", x: 1, y: 1 }, { cwd: process.cwd() }), /allowlist/i);
  } finally {
    if (save.u === undefined) delete process.env.HARA_COMPUTER_USE;
    else process.env.HARA_COMPUTER_USE = save.u;
    if (save.a === undefined) delete process.env.HARA_COMPUTER_APPS;
    else process.env.HARA_COMPUTER_APPS = save.a;
  }
});

test("computer child is cancelled promptly and does not survive the parent deadline", { skip: process.platform !== "darwin", timeout: 20_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-computer-abort-"));
  const pidFile = join(dir, "open.pid");
  const fakeOpen = join(dir, "open");
  const saved = {
    path: process.env.PATH,
    use: process.env.HARA_COMPUTER_USE,
    apps: process.env.HARA_COMPUTER_APPS,
  };
  let pid;
  try {
    writeFileSync(fakeOpen, `#!/bin/sh\necho $$ > ${JSON.stringify(pidFile)}\ntrap '' TERM\nwhile :; do sleep 1; done\n`);
    chmodSync(fakeOpen, 0o755);
    process.env.PATH = `${dir}:${saved.path ?? ""}`;
    process.env.HARA_COMPUTER_USE = "click";
    process.env.HARA_COMPUTER_APPS = "Fixture App";
    const controller = new AbortController();
    let earlySettlement;
    const running = getTool("computer").run({ action: "activate", app: "Fixture App" }, { cwd: dir, signal: controller.signal });
    void running.then(
      (value) => { earlySettlement = `resolved early: ${value}`; },
      (error) => { earlySettlement = `rejected early: ${error instanceof Error ? error.message : String(error)}`; },
    );
    // Full-suite process contention can delay fixture scheduling; cancellation latency starts only after the
    // child has positively started and remains the behavior under test.
    const deadline = Date.now() + 10_000;
    while (!pid && !earlySettlement && Date.now() < deadline) {
      if (existsSync(pidFile)) {
        const candidate = Number(readFileSync(pidFile, "utf8").trim());
        if (Number.isSafeInteger(candidate) && candidate > 0) pid = candidate;
      }
      if (!pid) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(pid, `fake screen-control child published a valid pid${earlySettlement ? ` (${earlySettlement})` : ""}`);
    const abortStarted = Date.now();
    controller.abort();
    await assert.rejects(running, /computer action interrupted/);
    assert.ok(Date.now() - abortStarted < 1_500);
    const goneDeadline = Date.now() + 1_000;
    for (;;) {
      try { process.kill(pid, 0); } catch (error) { if (error?.code === "ESRCH") break; throw error; }
      if (Date.now() >= goneDeadline) assert.fail(`computer child ${pid} survived cancellation`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } finally {
    if (pid) try { process.kill(pid, "SIGKILL"); } catch {}
    if (saved.path === undefined) delete process.env.PATH; else process.env.PATH = saved.path;
    if (saved.use === undefined) delete process.env.HARA_COMPUTER_USE; else process.env.HARA_COMPUTER_USE = saved.use;
    if (saved.apps === undefined) delete process.env.HARA_COMPUTER_APPS; else process.env.HARA_COMPUTER_APPS = saved.apps;
    rmSync(dir, { recursive: true, force: true });
  }
});
