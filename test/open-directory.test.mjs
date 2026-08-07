import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../dist/agent/loop.js";
import { createTaskExecution, newTurnInteraction } from "../dist/session/task.js";
import {
  createOpenDirectoryTool,
  directoryOpenInvocation,
  resolveDirectoryToOpen,
} from "../dist/tools/open-directory.js";
import { getTool, toolOperationTraits } from "../dist/tools/registry.js";

const root = mkdtempSync(join(tmpdir(), "hara-open-directory-"));
const folder = join(root, "folder with ; shell text");
const file = join(root, "ordinary.txt");
mkdirSync(folder);
writeFileSync(file, "not a directory");
const canonicalFolder = realpathSync.native(folder);

after(() => rmSync(root, { recursive: true, force: true }));

test("open_directory is a narrow interactive action that does not require an understanding brief", () => {
  const tool = getTool("open_directory");
  assert.ok(tool);
  assert.match(tool.description, /never run bash/);
  assert.deepEqual(toolOperationTraits(tool, { path: folder }, { cwd: root }), {
    effect: "interactive",
    concurrencySafe: false,
  });
  assert.equal(tool.requiresProjectWorkspace, undefined);
});

test("directory paths are canonicalized and files, missing paths, and URLs are rejected", () => {
  assert.equal(resolveDirectoryToOpen("folder with ; shell text", root), canonicalFolder);
  assert.equal(resolveDirectoryToOpen("~/folder with ; shell text", "/ignored", root), canonicalFolder);
  assert.throws(() => resolveDirectoryToOpen(file, root), /not a directory/);
  assert.throws(() => resolveDirectoryToOpen(join(root, "missing"), root), /does not exist/);
  assert.throws(() => resolveDirectoryToOpen("https://example.com", root), /URLs are not supported/);
});

test("platform launchers receive the directory as one argv value without a shell", () => {
  assert.deepEqual(directoryOpenInvocation(folder, "darwin"), {
    command: "/usr/bin/open",
    args: [folder],
    fileManager: "Finder",
  });
  assert.deepEqual(directoryOpenInvocation(folder, "linux"), {
    command: "/usr/bin/xdg-open",
    args: [folder],
    fileManager: "the system file manager",
  });
  assert.deepEqual(directoryOpenInvocation("C:\\Users\\Tester\\folder", "win32", { SystemRoot: "D:\\Windows" }), {
    command: "D:\\Windows\\explorer.exe",
    args: ["C:\\Users\\Tester\\folder"],
    fileManager: "File Explorer",
  });
});

test("tool validates first and dispatches the canonical directory through the injected launcher", async () => {
  const launches = [];
  const tool = createOpenDirectoryTool(async (directory, options) => {
    launches.push({ directory, platform: options?.platform });
  });

  const output = await tool.run({ path: "folder with ; shell text" }, { cwd: root });
  assert.match(output, /Sent the directory/);
  assert.deepEqual(launches, [{ directory: canonicalFolder, platform: process.platform }]);

  const rejected = await tool.run({ path: file }, { cwd: root });
  assert.match(rejected, /^Error: cannot open directory: .*not a directory/);
  assert.equal(launches.length, 1, "invalid input never reaches the launcher");
});

test("a raw open-folder request runs without task_intake, confirmation, or Bash", async () => {
  let launches = 0;
  let confirmations = 0;
  let turnIndex = 0;
  const systems = [];
  const tool = createOpenDirectoryTool(async () => { launches++; });
  const interaction = newTurnInteraction();
  const task = createTaskExecution("把文件目录打开", interaction.turnId);
  const history = [{ role: "user", content: "把文件目录打开" }];

  const outcome = await runAgent(history, {
    provider: {
      id: "open-directory-fixture",
      model: "open-directory-fixture",
      async turn({ system }) {
        systems.push(system);
        return turnIndex++ === 0
          ? { text: "", toolUses: [{ id: "open-1", name: "open_directory", input: { path: folder } }], stop: "tool_use" }
          : { text: "已打开", toolUses: [], stop: "end" };
      },
    },
    ctx: { cwd: root },
    approval: "suggest",
    confirm: async () => { confirmations++; return true; },
    quiet: true,
    extraTools: [tool],
    taskIntake: { task },
  });

  assert.equal(outcome.status, "completed");
  assert.equal(launches, 1);
  assert.equal(confirmations, 0);
  assert.doesNotMatch(JSON.stringify(history), /Understanding gate/);
  assert.match(systems[0], /call\s+open_directory directly/);
});
