import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { taskSlug } from "../dist/tools/task.js";

const DEAD_PID = 2_000_000_000;

function fixture(label) {
  const root = mkdtempSync(join(tmpdir(), `hara-${label}-`));
  const home = join(root, "home");
  return { root, home };
}

function runProbe(home, script) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(
    result.status,
    0,
    `probe failed (status=${result.status}, signal=${result.signal ?? "none"})\n${result.stderr || result.stdout}`,
  );
}

function seedGuard(path, session = false) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({
    pid: DEAD_PID,
    token: "dead-reclaimer-token",
    ...(session ? { startedAt: 1 } : {}),
  }), { mode: 0o600 });
}

test("session lock reclaims a complete guard whose PID is dead", () => {
  const { root, home } = fixture("session-reclaim");
  const id = "stale-reclaim";
  const lock = join(home, ".hara", "sessions", `${id}.lock`);
  const reclaim = `${lock}.reclaim`;
  try {
    seedGuard(reclaim, true);
    runProbe(home, `
      import { acquireSessionLock, releaseSessionLock } from "./dist/session/store.js";
      const result = acquireSessionLock(${JSON.stringify(id)});
      if (!result.ok) throw new Error("stale reclaim guard blocked the session lock");
      releaseSessionLock(${JSON.stringify(id)});
    `);
    assert.equal(existsSync(reclaim), false);
    assert.equal(existsSync(lock), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("gateway chat store reclaims a complete guard whose PID is dead", () => {
  const { root, home } = fixture("gateway-reclaim");
  const lock = join(home, ".hara", "gateway", "chats.json.lock");
  const reclaim = `${lock}.reclaim`;
  try {
    seedGuard(reclaim);
    runProbe(home, `
      import { chatContext } from "./dist/gateway/sessions.js";
      chatContext("telegram", "stale-reclaim", "/tmp");
    `);
    assert.equal(existsSync(reclaim), false);
    assert.equal(existsSync(lock), false);
    assert.equal(existsSync(join(home, ".hara", "gateway", "chats.json")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("flow pending store reclaims a complete guard whose PID is dead", () => {
  const { root, home } = fixture("flow-reclaim");
  const lock = join(home, ".hara", "flows-pending.json.lock");
  const reclaim = `${lock}.reclaim`;
  try {
    seedGuard(reclaim);
    runProbe(home, `
      import { addPending } from "./dist/gateway/flows-pending.js";
      addPending({ owner: "telegram:owner", target: "telegram:target", draft: "ok", context: "test" });
    `);
    assert.equal(existsSync(reclaim), false);
    assert.equal(existsSync(lock), false);
    assert.equal(existsSync(join(home, ".hara", "flows-pending.json")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("projects registry reclaims a complete guard whose PID is dead", () => {
  const { root, home } = fixture("projects-reclaim");
  const project = join(root, "project");
  const lock = join(home, ".hara", "projects.json.lock");
  const reclaim = `${lock}.reclaim`;
  try {
    mkdirSync(project, { recursive: true });
    seedGuard(reclaim);
    runProbe(home, `
      import { addProject } from "./dist/org/projects.js";
      const error = addProject("stale-reclaim", ${JSON.stringify(project)});
      if (error) throw new Error(error);
    `);
    assert.equal(existsSync(reclaim), false);
    assert.equal(existsSync(lock), false);
    assert.equal(existsSync(join(home, ".hara", "projects.json")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("project task store reclaims a complete guard whose PID is dead", () => {
  const { root, home } = fixture("task-reclaim");
  const project = join(root, "project");
  try {
    mkdirSync(project, { recursive: true });
    const lock = join(home, ".hara", "tasks", `${taskSlug(project)}.json.lock`);
    const reclaim = `${lock}.reclaim`;
    seedGuard(reclaim);
    runProbe(home, `
      import { saveTasks } from "./dist/tools/task.js";
      saveTasks(${JSON.stringify(project)}, []);
    `);
    assert.equal(existsSync(reclaim), false);
    assert.equal(existsSync(lock), false);
    assert.equal(existsSync(lock.slice(0, -".lock".length)), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
