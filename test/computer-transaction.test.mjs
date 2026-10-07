import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getTool } from "../dist/tools/registry.js";
import "../dist/tools/computer.js";
import { createComputerRunScope, closeComputerRunScope } from "../dist/tools/computer-run.js";

const macOnly = { skip: process.platform !== "darwin", timeout: 30_000 };
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const OTHER_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");
const TARGET = {
  app: "Fixture App", pid: 1234, windowId: "456",
  frame: { x: 100, y: 100, width: 600, height: 600 },
  screen: { x: 0, y: 0, width: 1000, height: 1000 },
};

function targetOutput(value) {
  return [value.app, value.pid, value.windowId, value.frame.x, value.frame.y, value.frame.width, value.frame.height,
    value.screen.x, value.screen.y, value.screen.width, value.screen.height].join("\n");
}

function fixture() {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), "hara-computer-transaction-")));
  const targetFile = join(directory, "target.txt");
  const pngFile = join(directory, "fixture.png");
  const logFile = join(directory, "commands.jsonl");
  const inputExitFile = join(directory, "cliclick-exit.txt");
  const pasteStartedFile = join(directory, "paste-started.txt");
  const holdPasteFile = join(directory, "hold-paste.txt");
  const leaseFile = join(directory, ".hara", "computer-control", "desktop.json");
  const saved = Object.fromEntries(["PATH", "HARA_COMPUTER_USE", "HARA_COMPUTER_APPS"].map((name) => [name, process.env[name]]));
  const scopes = [];
  writeFileSync(targetFile, targetOutput(TARGET));
  writeFileSync(pngFile, PNG);
  // Every native command is replaced with a Node fixture. None forwards to a system GUI program.
  const executable = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ command, args }) + "\\n");
if (command === "osascript") process.stdout.write(fs.readFileSync(${JSON.stringify(targetFile)}));
else if (command === "screencapture") fs.copyFileSync(${JSON.stringify(pngFile)}, args.at(-1));
else if (command === "which") {
  const candidate = path.join(${JSON.stringify(directory)}, args[0]);
  if (!fs.existsSync(candidate)) process.exitCode = 1;
  else process.stdout.write(candidate + "\\n");
} else if (command === "pbcopy") {
  fs.writeFileSync(${JSON.stringify(join(directory, "clipboard.txt"))}, fs.readFileSync(0));
} else if (command === "cliclick" && args[0] === "kd:cmd" && fs.existsSync(${JSON.stringify(holdPasteFile)})) {
  fs.writeFileSync(${JSON.stringify(pasteStartedFile)}, String(process.pid));
  setInterval(() => {}, 1000);
} else if (command === "cliclick" && fs.existsSync(${JSON.stringify(inputExitFile)})) {
  process.exitCode = Number(fs.readFileSync(${JSON.stringify(inputExitFile)}, "utf8"));
} else if (command !== "open" && command !== "cliclick") process.exitCode = 1;
`;
  for (const name of ["open", "osascript", "screencapture", "cliclick", "pbcopy", "which"]) {
    const file = join(directory, name);
    writeFileSync(file, executable);
    chmodSync(file, 0o755);
  }
  process.env.PATH = `${directory}:${saved.PATH ?? ""}`;
  process.env.HARA_COMPUTER_USE = "full";
  process.env.HARA_COMPUTER_APPS = TARGET.app;
  const commands = () => existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  const assertClean = () => {
    for (const command of commands().filter((item) => item.command === "screencapture")) {
      const path = command.args.at(-1);
      assert.equal(existsSync(path), false, "private screenshot file is removed after the call");
      assert.equal(existsSync(dirname(path)), false, "private screenshot directory is removed after the call");
    }
    assert.equal(existsSync(leaseFile), false, "finished calls release their isolated desktop lease");
  };
  return {
    directory,
    commands,
    assertClean,
    inputCommands: () => commands().filter((item) => item.command === "cliclick" || item.command === "pbcopy"),
    setTarget(value) { writeFileSync(targetFile, targetOutput(value)); },
    setPng(bytes) { writeFileSync(pngFile, bytes); },
    setInputExit(code) { writeFileSync(inputExitFile, String(code)); },
    holdPaste() { writeFileSync(holdPasteFile, "hold"); },
    pasteStarted: () => existsSync(pasteStartedFile),
    context(overrides = {}) {
      const computerScope = createComputerRunScope();
      scopes.push(computerScope);
      const images = [];
      return { cwd: directory, stateHome: directory, sessionId: `fixture-${computerScope.runId}`, computerScope,
        images, attachToolImage: (image) => images.push(image), ...overrides };
    },
    dispose() {
      for (const scope of scopes) closeComputerRunScope(scope);
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function observationId(text) {
  const match = text.match(/observationId=([a-f0-9-]+)/i);
  assert.ok(match, `expected an input-authorizing observation: ${text}`);
  return match[1];
}

async function activateAndObserve(ctx) {
  const tool = getTool("computer");
  assert.ok(tool);
  assert.match(await tool.run({ action: "activate", app: TARGET.app }, ctx), /Observed:.*native window.*foreground/);
  return observationId(await tool.run({ action: "screenshot" }, ctx));
}

test("native computer transaction dispatches one raw click, returns immutable screenshot bytes, and cleans snapshots", macOnly, async () => {
  const fake = fixture();
  try {
    const ctx = fake.context();
    const id = await activateAndObserve(ctx);
    assert.equal(ctx.images.length, 1);
    assert.deepEqual(ctx.images[0].data, PNG);
    assert.equal(Object.hasOwn(ctx.images[0], "path"), false, "model image input contains bytes, not a disposable path");
    fake.assertClean();
    const result = await getTool("computer").run({ action: "click", x: 200, y: 200, observationId: id }, ctx);
    assert.match(result, /^Dispatched: click at 200,200/);
    assert.match(result, /Business outcome is NOT verified/);
    assert.match(result, /fresh post-action screenshot/);
    assert.equal(ctx.images.length, 2);
    const afterId = observationId(result);
    assert.notEqual(afterId, id);
    assert.equal(ctx.computerScope.observation.id, afterId);
    assert.deepEqual(fake.inputCommands().map((command) => command.args), [["c:200,200"]]);
    assert.ok(fake.commands().filter((command) => command.command === "screencapture").every((command) => command.args.slice(0, 2).join(" ") === "-x -m"));
    fake.setPng(OTHER_PNG);
    assert.deepEqual(ctx.images[0].data, PNG, "later capture changes do not mutate an already attached snapshot");
    assert.deepEqual(ctx.images[1].data, PNG);
    const replay = await getTool("computer").run({ action: "click", x: 200, y: 200, observationId: id }, ctx);
    assert.match(replay, /observationId.*required/);
    assert.equal(fake.inputCommands().length, 1, "a consumed observation must never replay the click");
    fake.assertClean();
  } finally { fake.dispose(); }
});

test("native computer transaction revalidates app, native window ID, and frame after grounding before input", macOnly, async () => {
  const fake = fixture();
  try {
    for (const changed of [
      { ...TARGET, app: "Another App" },
      { ...TARGET, windowId: "457" },
      { ...TARGET, frame: { ...TARGET.frame, x: 101 } },
    ]) {
      fake.setTarget(TARGET);
      const ctx = fake.context({ locate: async () => { fake.setTarget(changed); return { x: 0.2, y: 0.2 }; } });
      await activateAndObserve(ctx);
      const result = await getTool("computer").run({ action: "click", target: "Fixture button" }, ctx);
      assert.match(result, /changed.*no input was sent/i, changed.app);
      assert.equal(fake.inputCommands().length, 0);
      fake.assertClean();
    }
  } finally { fake.dispose(); }
});

test("native computer transaction refuses changed screenshot bytes after grounding", macOnly, async () => {
  const fake = fixture();
  try {
    const ctx = fake.context({ locate: async () => { fake.setPng(OTHER_PNG); return { x: 0.2, y: 0.2 }; } });
    await activateAndObserve(ctx);
    const result = await getTool("computer").run({ action: "click", target: "Fixture button" }, ctx);
    assert.match(result, /visible screen changed.*no input was sent/i);
    assert.equal(fake.inputCommands().length, 0);
    fake.assertClean();
  } finally { fake.dispose(); }
});

test("grounding diagnostics cannot expose temporary screenshot paths or pixels before attachment", macOnly, async () => {
  const fake = fixture();
  try {
    let privatePath;
    const ctx = fake.context({ locate: async (path) => {
      privatePath = path;
      throw new Error(`Fixture error file://${path} raw ${PNG.toString("base64")} data:image/png;base64,${PNG.toString("base64")}`);
    } });
    await activateAndObserve(ctx);
    const result = await getTool("computer").run({ action: "find", target: "Fixture button" }, ctx);
    assert.ok(privatePath);
    assert.equal(result.includes(privatePath), false);
    assert.equal(result.includes(PNG.toString("base64")), false);
    assert.equal(result.includes("data:image"), false);
    assert.match(result, /Fixture error/);
    assert.equal(fake.inputCommands().length, 0);
    fake.assertClean();
  } finally { fake.dispose(); }
});

test("native computer transaction rechecks live permission and app allowlist after grounding", macOnly, async () => {
  const fake = fixture();
  try {
    for (const [name, value, expected] of [
      ["HARA_COMPUTER_USE", "off", /permission was lowered or disabled.*no input was sent/i],
      ["HARA_COMPUTER_APPS", "", /removed from the allowlist.*no input was sent/i],
    ]) {
      process.env.HARA_COMPUTER_USE = "full";
      process.env.HARA_COMPUTER_APPS = TARGET.app;
      const ctx = fake.context({ locate: async () => { process.env[name] = value; return { x: 0.2, y: 0.2 }; } });
      await activateAndObserve(ctx);
      assert.match(await getTool("computer").run({ action: "click", target: "Fixture button" }, ctx), expected);
      assert.equal(fake.inputCommands().length, 0);
      fake.assertClean();
    }
  } finally { fake.dispose(); }
});

test("failed native paste is not replayed through typing fallback and halts the current run", macOnly, async () => {
  const fake = fixture();
  try {
    const ctx = fake.context();
    const id = await activateAndObserve(ctx);
    fake.setInputExit(1);
    const result = await getTool("computer").run({ action: "type", text: "Actual 内容 🦀", observationId: id }, ctx);
    assert.match(result, /paste dispatch failed or is uncertain.*do not retry blindly/);
    assert.equal(ctx.computerScope.halted, true);
    assert.equal(ctx.computerScope.observation, undefined);
    const inputs = fake.inputCommands();
    assert.deepEqual(inputs.map((command) => command.command), ["pbcopy", "cliclick", "cliclick"]);
    assert.deepEqual(inputs[1].args, ["kd:cmd", "t:v", "ku:cmd"]);
    assert.deepEqual(inputs[2].args, ["ku:cmd"], "uncertain paste gets only owned-modifier release, not a retry");
    assert.equal(readFileSync(join(fake.directory, "clipboard.txt"), "utf8"), "Actual 内容 🦀");
    const commandCount = fake.commands().length;
    assert.match(await getTool("computer").run({ action: "click", x: 200, y: 200, observationId: id }, ctx), /screen control stopped/);
    assert.equal(fake.commands().length, commandCount, "halted scope cannot spawn another native probe or input");
    fake.assertClean();
  } finally { fake.dispose(); }
});

test("cancelled native paste releases only its owned modifier before releasing the desktop lease", macOnly, async () => {
  const fake = fixture();
  try {
    const controller = new AbortController();
    const ctx = fake.context({ signal: controller.signal });
    const id = await activateAndObserve(ctx);
    fake.holdPaste();
    const pending = getTool("computer").run({ action: "type", text: "Fixture only", observationId: id }, ctx);
    void pending.catch(() => {}); // Observe rejection only after cancelling; avoid a premature unhandled rejection.
    // Observe the fake input worker's startup before cancelling; never assume a fixed scheduling delay.
    const started = Date.now();
    while (!fake.pasteStarted() && Date.now() - started < 10_000) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(fake.pasteStarted(), "fake paste worker started");
    controller.abort();
    await assert.rejects(pending, /computer action interrupted/);
    assert.equal(ctx.computerScope.halted, true);
    assert.deepEqual(fake.inputCommands().map((command) => command.args), [[], ["kd:cmd", "t:v", "ku:cmd"], ["ku:cmd"]]);
    fake.assertClean();
  } finally { fake.dispose(); }
});

test("native computer transaction refuses missing raw observation IDs and coordinates outside the window", macOnly, async () => {
  const fake = fixture();
  try {
    const ctx = fake.context();
    const id = await activateAndObserve(ctx);
    assert.match(await getTool("computer").run({ action: "click", x: 200, y: 200 }, ctx), /observationId.*required/);
    assert.match(await getTool("computer").run({ action: "click", x: 99, y: 200, observationId: id }, ctx), /outside the bound window/);
    assert.equal(fake.inputCommands().length, 0);
    fake.assertClean();
  } finally { fake.dispose(); }
});

test("native computer contexts cannot share a bound window or borrow another run's observation", macOnly, async () => {
  const fake = fixture();
  try {
    const first = fake.context();
    const firstId = await activateAndObserve(first);
    fake.setTarget({ ...TARGET, windowId: "457" });
    const second = fake.context();
    const secondId = await activateAndObserve(second);
    assert.notEqual(first.computerScope.runId, second.computerScope.runId);
    assert.notEqual(firstId, secondId);
    assert.match(await getTool("computer").run({ action: "click", x: 200, y: 200, observationId: firstId }, first), /bound foreground app\/window.*changed/i);
    assert.match(await getTool("computer").run({ action: "click", x: 200, y: 200, observationId: firstId }, second), /observationId.*required/);
    const unbound = fake.context();
    const screenshot = await getTool("computer").run({ action: "screenshot" }, unbound);
    assert.match(screenshot, /no input-authorizing window binding/);
    assert.equal(unbound.computerScope.observation, undefined);
    assert.match(await getTool("computer").run({ action: "click", x: 200, y: 200, observationId: secondId }, unbound), /bound foreground app\/window.*changed/i);
    assert.equal(fake.inputCommands().length, 0);
    fake.assertClean();
  } finally { fake.dispose(); }
});

test("closed, halted, or cancelled native computer runs never spawn desktop commands", macOnly, async () => {
  const fake = fixture();
  try {
    const closed = fake.context();
    closeComputerRunScope(closed.computerScope);
    const halted = fake.context();
    halted.computerScope.halted = true;
    for (const ctx of [closed, halted]) {
      for (const input of [{ action: "activate", app: TARGET.app }, { action: "screenshot" }, { action: "click", x: 200, y: 200 }]) {
        assert.match(await getTool("computer").run(input, ctx), /screen control stopped/);
      }
    }
    const controller = new AbortController();
    controller.abort();
    assert.match(await getTool("computer").run({ action: "activate", app: TARGET.app }, fake.context({ signal: controller.signal })), /computer cancelled before execution/);
    assert.deepEqual(fake.commands(), []);
    fake.assertClean();
  } finally { fake.dispose(); }
});
