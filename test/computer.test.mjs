import { test } from "node:test";
import assert from "node:assert/strict";
import { getTool } from "../dist/tools/registry.js";
import { actionAllowed, keyIsBlocked } from "../dist/tools/computer.js";

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
