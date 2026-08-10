import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgent } from "../dist/agent/loop.js";
import { createTaskExecution, newTurnInteraction } from "../dist/session/task.js";
import {
  browserOpenInvocation,
  createOpenBrowserTool,
  resolveBrowserUrl,
} from "../dist/tools/open-browser.js";
import { getTool, toolOperationTraits } from "../dist/tools/registry.js";

test("open_browser is a narrow real-browser action under the computer approval boundary", () => {
  const tool = getTool("open_browser");
  assert.ok(tool);
  assert.match(tool.description, /real default browser/);
  assert.deepEqual(toolOperationTraits(tool, { url: "https://example.com/app" }, { cwd: process.cwd() }), {
    effect: "interactive",
    concurrencySafe: false,
    approvalKind: "computer",
  });
  assert.equal(tool.requiresProjectWorkspace, undefined);
});

test("browser URLs are normalized while custom protocols and embedded credentials are rejected", () => {
  assert.equal(resolveBrowserUrl(" https://example.com/app?q=1#view ").href, "https://example.com/app?q=1#view");
  assert.equal(resolveBrowserUrl("http://localhost:3000/").href, "http://localhost:3000/");
  assert.throws(() => resolveBrowserUrl("example.com"), /include http:\/\//);
  assert.throws(() => resolveBrowserUrl("file:///tmp/page.html"), /only http:\/\//);
  assert.throws(() => resolveBrowserUrl("https://user:pass@example.com/"), /credentials/);
});

test("platform launchers receive one URL argv without a shell", () => {
  assert.deepEqual(browserOpenInvocation("https://example.com/a?x=1", "darwin"), {
    command: "/usr/bin/open",
    args: ["https://example.com/a?x=1"],
    browser: "the default browser",
  });
  assert.deepEqual(browserOpenInvocation("https://example.com/", "linux"), {
    command: "/usr/bin/xdg-open",
    args: ["https://example.com/"],
    browser: "the default browser",
  });
  assert.deepEqual(browserOpenInvocation("https://example.com/", "win32", { SystemRoot: "D:\\Windows" }), {
    command: "D:\\Windows\\explorer.exe",
    args: ["https://example.com/"],
    browser: "the default browser",
  });
});

test("tool dispatches the full URL but does not persist query or fragment values in its result", async () => {
  const launches = [];
  const tool = createOpenBrowserTool(async (url, options) => {
    launches.push({ url, platform: options?.platform });
  });
  const output = await tool.run({ url: "https://example.com/app?token=secret-value#private-state" }, { cwd: process.cwd() });
  assert.equal(launches.length, 1);
  assert.equal(launches[0].url, "https://example.com/app?token=secret-value#private-state");
  assert.doesNotMatch(output, /secret-value|private-state/);
  assert.match(output, /query omitted/);
});

test("a website UI test can open the real browser without an understanding brief", async () => {
  let launches = 0;
  let confirmations = 0;
  let turnIndex = 0;
  const systems = [];
  const tool = createOpenBrowserTool(async () => { launches++; });
  const interaction = newTurnInteraction();
  const task = createTaskExecution("测试 https://example.com 的网页界面", interaction.turnId);
  const history = [{ role: "user", content: "测试 https://example.com 的网页界面" }];

  const outcome = await runAgent(history, {
    provider: {
      id: "open-browser-fixture",
      model: "open-browser-fixture",
      async turn({ system }) {
        systems.push(system);
        return turnIndex++ === 0
          ? { text: "", toolUses: [{ id: "open-browser-1", name: "open_browser", input: { url: "https://example.com/" } }], stop: "tool_use" }
          : { text: "浏览器导航请求已发出，等待可视化验证。", toolUses: [], stop: "end" };
      },
    },
    ctx: { cwd: process.cwd() },
    approval: "suggest",
    confirm: async () => { confirmations++; return true; },
    quiet: true,
    extraTools: [tool],
    taskIntake: { task },
  });

  assert.equal(outcome.status, "completed");
  assert.equal(launches, 1);
  assert.equal(confirmations, 1, "real browser navigation remains explicitly computer-approved");
  assert.doesNotMatch(JSON.stringify(history), /Understanding gate/);
  assert.match(systems[0], /website UI, SPA, visual, or\s+interaction testing, call open_browser directly/);
});
