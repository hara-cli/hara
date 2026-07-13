import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyTaskAction,
  isBlocked,
  loadTasks,
  renderTasks,
  saveTasks,
  taskSlug,
} from "../dist/tools/task.js";
import { getTool } from "../dist/tools/registry.js";

function child(script, home) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ["--input-type=module", "-e", script], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: home },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    proc.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => code === 0 ? resolve() : reject(new Error(`task child exited ${code}: ${stderr}`)));
  });
}

test("task state transitions validate dependencies, updates, rendering, and removal", () => {
  const firstAt = "2026-07-13T08:00:00.000Z";
  const secondAt = "2026-07-13T08:01:00.000Z";
  const updatedAt = "2026-07-13T08:02:00.000Z";

  const empty = applyTaskAction([], { action: "add", subject: "   " }, firstAt);
  assert.deepEqual(empty.list, []);
  assert.match(empty.reply, /subject.*1-500/);
  assert.match(applyTaskAction([], { action: "launch" }, firstAt).reply, /action must be/);
  assert.match(applyTaskAction([], { action: "list", owner: "unexpected" }, firstAt).reply, /list accepts no other fields/);

  const first = applyTaskAction([], { action: "add", subject: "Design API", owner: "architect" }, firstAt);
  const firstId = first.list[0].id;
  assert.match(firstId, /^t[0-9a-z]+$/);
  assert.deepEqual(first.list[0], {
    id: firstId,
    subject: "Design API",
    status: "pending",
    owner: "architect",
    createdAt: firstAt,
    updatedAt: firstAt,
  });

  assert.match(
    applyTaskAction(first.list, { action: "add", subject: "Bad dependency", blockedBy: ["missing"] }, secondAt).reply,
    /unknown task 'missing'/,
  );
  const second = applyTaskAction(first.list, { action: "add", subject: "Implement API", blockedBy: [firstId] }, secondAt);
  const secondId = second.list[1].id;
  assert.equal(isBlocked(second.list[1], second.list), true);
  assert.equal(isBlocked({ ...second.list[1], blockedBy: ["missing"] }, second.list), true, "missing dependencies fail closed");
  assert.match(renderTasks(second.list), /Project tasks \(2 open \/ 2 total\)/);
  assert.match(renderTasks(second.list), /@architect/);
  assert.match(renderTasks(second.list), new RegExp(`blocked by ${firstId}`));
  for (const status of ["in_progress", "done"]) {
    const blockedTransition = applyTaskAction(second.list, { action: "update", id: secondId, status }, updatedAt);
    assert.equal(blockedTransition.list, second.list, `${status} must not commit a blocked transition`);
    assert.match(blockedTransition.reply, /until every blockedBy task is done/);
  }
  const unblockedInSameUpdate = applyTaskAction(
    second.list,
    { action: "update", id: secondId, status: "in_progress", blockedBy: [] },
    updatedAt,
  );
  assert.equal(unblockedInSameUpdate.list[1].status, "in_progress", "validation uses the merged state");
  assert.equal(unblockedInSameUpdate.list[1].blockedBy, undefined);
  const reblockedWhileRunning = applyTaskAction(
    unblockedInSameUpdate.list,
    { action: "update", id: secondId, blockedBy: [firstId] },
    updatedAt,
  );
  assert.equal(reblockedWhileRunning.list, unblockedInSameUpdate.list);
  assert.match(reblockedWhileRunning.reply, /until every blockedBy task is done/);
  assert.match(applyTaskAction(second.list, { action: "remove", id: firstId }, updatedAt).reply, /still blocks/);

  const completed = applyTaskAction(second.list, { action: "update", id: firstId, status: "done", owner: "" }, updatedAt);
  assert.equal(completed.list[0].status, "done");
  assert.equal(completed.list[0].owner, undefined);
  assert.equal(completed.list[0].updatedAt, updatedAt);
  assert.equal(isBlocked(completed.list[1], completed.list), false);
  const allDone = applyTaskAction(completed.list, { action: "update", id: secondId, status: "done" }, updatedAt);
  assert.equal(allDone.list[1].status, "done");
  const reopenDependency = applyTaskAction(allDone.list, { action: "update", id: firstId, status: "pending" }, updatedAt);
  assert.equal(reopenDependency.list, allDone.list, "reopening a prerequisite cannot strand a completed dependent");
  assert.match(reopenDependency.reply, new RegExp(`task '${secondId}'.*until every blockedBy task is done`));
  assert.match(applyTaskAction(completed.list, { action: "update", id: secondId, blockedBy: [secondId] }, updatedAt).reply, /cannot block itself/);
  assert.match(
    applyTaskAction(completed.list, { action: "update", id: firstId, blockedBy: [secondId] }, updatedAt).reply,
    /dependency cycle/,
    "indirect dependency cycles are rejected",
  );
  assert.match(applyTaskAction(completed.list, { action: "update", id: secondId, status: "bogus" }, updatedAt).reply, /status is invalid/);

  const inProgress = applyTaskAction(
    completed.list,
    { action: "update", id: secondId, status: "in_progress", subject: "Implement public API", blockedBy: [] },
    updatedAt,
  );
  assert.equal(inProgress.list[1].subject, "Implement public API");
  assert.equal(inProgress.list[1].status, "in_progress");
  assert.equal(inProgress.list[1].blockedBy, undefined);
  assert.match(applyTaskAction(inProgress.list, { action: "list" }, updatedAt).reply, /1 open \/ 2 total/);

  const missing = applyTaskAction(inProgress.list, { action: "update", id: "missing", status: "done" }, updatedAt);
  assert.equal(missing.list, inProgress.list);
  assert.match(missing.reply, /no task with id 'missing'/);

  const removed = applyTaskAction(inProgress.list, { action: "remove", id: firstId }, updatedAt);
  assert.deepEqual(removed.list.map((item) => item.id), [secondId]);
  assert.match(removed.reply, /removed/);
});

test("task storage uses canonical collision-resistant keys and private atomic files", async () => {
  const root = mkdtempSync(join(tmpdir(), "hara-task-store-"));
  const previousHome = process.env.HOME;
  const cwdA = join(root, "projects", "a-b");
  const cwdB = join(root, "projects", "a", "b");
  const aliasA = join(root, "alias-a");

  try {
    process.env.HOME = join(root, "home");
    mkdirSync(cwdA, { recursive: true });
    mkdirSync(cwdB, { recursive: true });
    symlinkSync(cwdA, aliasA);
    assert.notEqual(taskSlug(cwdA), taskSlug(cwdB), "paths that collided under dash replacement now hash independently");
    assert.equal(taskSlug(cwdA), taskSlug(aliasA), "symlink aliases resolve to one canonical project store");
    assert.match(taskSlug("///"), /^root-[0-9a-f]{24}$/);
    assert.ok(taskSlug(`/prefix/${"very-long-segment-".repeat(10)}`).length <= 80);

    const seed = [{
      id: "seed",
      subject: "Seed alpha",
      status: "pending",
      createdAt: "2026-07-13T00:00:00.000Z",
      updatedAt: "2026-07-13T00:00:00.000Z",
    }];
    saveTasks(cwdA, seed);
    assert.deepEqual(loadTasks(cwdA), seed);
    assert.deepEqual(loadTasks(aliasA), seed);
    assert.deepEqual(loadTasks(cwdB), [], "a formerly colliding path has an independent task file");

    const tool = getTool("task");
    assert.ok(tool);
    assert.equal(tool.kind, "edit", "persistent mutations must pass the edit approval gate");
    assert.match(await tool.run({ action: "add", subject: "Beta task", owner: "implementer" }, { cwd: cwdB }), /added/);
    const beta = loadTasks(cwdB);
    assert.equal(beta.length, 1);
    assert.equal(beta[0].subject, "Beta task");
    assert.equal(beta[0].owner, "implementer");
    assert.deepEqual(loadTasks(cwdA), seed, "writing beta does not alter alpha");

    assert.match(await tool.run({ action: "update", id: beta[0].id, status: "done" }, { cwd: cwdB }), /updated/);
    assert.equal(loadTasks(cwdB)[0].status, "done");
    assert.match(await tool.run({ action: "remove", id: beta[0].id }, { cwd: cwdB }), /removed/);
    assert.deepEqual(loadTasks(cwdB), []);

    const tasksDir = join(process.env.HOME, ".hara", "tasks");
    const alphaFile = join(tasksDir, `${taskSlug(cwdA)}.json`);
    assert.equal(statSync(join(process.env.HOME, ".hara")).mode & 0o777, 0o700);
    assert.equal(statSync(tasksDir).mode & 0o777, 0o700);
    assert.equal(statSync(alphaFile).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(alphaFile, "utf8")).project, realpathSync(cwdA));
    assert.deepEqual(readdirSync(tasksDir).filter((name) => name.includes(".tmp") || name.endsWith(".lock") || name.endsWith(".reclaim")), []);
    assert.throws(() => saveTasks(cwdA, [{ ...seed[0], blockedBy: ["missing"] }]), /invalid task data/);

    const corruptCwd = join(root, "corrupt");
    mkdirSync(corruptCwd);
    saveTasks(corruptCwd, seed);
    const corruptFile = join(tasksDir, `${taskSlug(corruptCwd)}.json`);
    writeFileSync(corruptFile, "{broken", "utf8");
    assert.match(await tool.run({ action: "add", subject: "must not overwrite" }, { cwd: corruptCwd }), /Unexpected token|JSON/);
    assert.equal(readFileSync(corruptFile, "utf8"), "{broken", "a corrupt registry fails closed instead of being replaced");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test("task read-modify-write preserves every concurrent process update", async () => {
  const root = mkdtempSync(join(tmpdir(), "hara-task-concurrent-"));
  const home = join(root, "home");
  const cwd = join(root, "project");
  const previousHome = process.env.HOME;
  mkdirSync(cwd, { recursive: true });
  try {
    process.env.HOME = home;
    await Promise.all(Array.from({ length: 16 }, (_, i) => {
      const script = `import "./dist/tools/task.js"; import { getTool } from "./dist/tools/registry.js"; const out = await getTool("task").run({ action: "add", subject: "child-${i}" }, { cwd: ${JSON.stringify(cwd)} }); if (!out.startsWith("added")) throw new Error(out);`;
      return child(script, home);
    }));
    const list = loadTasks(cwd);
    assert.equal(list.length, 16);
    assert.equal(new Set(list.map((task) => task.id)).size, 16, "same-time cross-process ids remain unique");
    assert.deepEqual(list.map((task) => task.subject).sort(), Array.from({ length: 16 }, (_, i) => `child-${i}`).sort());
    const dir = join(home, ".hara", "tasks");
    assert.equal(statSync(join(dir, `${taskSlug(cwd)}.json`)).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(dir).filter((name) => name.includes(".tmp") || name.endsWith(".lock") || name.endsWith(".reclaim")), []);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});
