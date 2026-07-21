import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  latestForCwd,
  loadSession,
  newSessionId,
  saveSession,
} from "../dist/session/store.js";
import { createTaskExecution, recordTaskSteering } from "../dist/session/task.js";
import {
  RECENT_WORKSPACE_TRANSFER_MS,
  persistWorkspaceSessionFork,
  recentWorkspaceTransferCandidate,
  workspaceSessionFork,
} from "../dist/session/transfer.js";

function seedSession(cwd, { history = [{ role: "user", content: "keep this context" }], source = "interactive" } = {}) {
  const id = newSessionId();
  const meta = {
    id,
    cwd,
    provider: "qwen",
    model: "glm-5",
    title: "workspace transfer",
    createdAt: new Date().toISOString(),
    updatedAt: "",
    source,
  };
  saveSession(meta, history);
  return loadSession(id);
}

test("direct --cwd continuity only offers a recent interactive source-directory session", () => {
  const root = mkdtempSync(join(tmpdir(), "hara-transfer-candidate-"));
  const sourceCwd = join(root, "source");
  const targetCwd = join(root, "target");
  mkdirSync(sourceCwd);
  mkdirSync(targetCwd);
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    const source = seedSession(realpathSync.native(sourceCwd));
    assert.ok(source);
    const updated = Date.parse(source.meta.updatedAt);
    assert.equal(
      recentWorkspaceTransferCandidate(sourceCwd, targetCwd, new Date(updated + 1_000))?.meta.id,
      source.meta.id,
    );
    assert.equal(recentWorkspaceTransferCandidate(sourceCwd, sourceCwd, new Date(updated + 1_000)), null);
    assert.equal(
      recentWorkspaceTransferCandidate(sourceCwd, targetCwd, new Date(updated + RECENT_WORKSPACE_TRANSFER_MS + 1)),
      null,
      "an old thread must not nag every future explicit --cwd launch",
    );

    seedSession(realpathSync.native(sourceCwd), { source: "gateway" });
    assert.equal(recentWorkspaceTransferCandidate(sourceCwd, targetCwd), null, "automated threads are never migrated into the interactive CLI");
    seedSession(realpathSync.native(sourceCwd), { history: [] });
    assert.equal(recentWorkspaceTransferCandidate(sourceCwd, targetCwd), null, "an empty latest session has no context to carry");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test("workspace transfer persists a new project-bound fork and leaves the source session intact", () => {
  const root = mkdtempSync(join(tmpdir(), "hara-transfer-fork-"));
  const sourceCwd = join(root, "source");
  const targetCwd = join(root, "target");
  mkdirSync(sourceCwd);
  mkdirSync(targetCwd);
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    const task0 = createTaskExecution("finish the current work", "source-turn", "2026-07-21T08:00:00.000Z");
    const steered = recordTaskSteering(task0, "source-turn", "also preserve this constraint", "2026-07-21T08:01:00.000Z");
    assert.equal(steered.ok, true);
    const source = {
      meta: {
        id: newSessionId(),
        cwd: realpathSync.native(sourceCwd),
        provider: "qwen",
        model: "glm-5",
        title: "keep the title",
        createdAt: "2026-07-21T08:00:00.000Z",
        updatedAt: "2026-07-21T08:01:00.000Z",
        source: "gateway",
        sourceName: "telegram",
        archived: true,
        gatewayOwner: "telegram:42",
        workingSet: ["remember this"],
      },
      history: [
        { role: "user", content: "keep this context" },
        { role: "assistant", text: "working", toolUses: [] },
      ],
      task: steered.task,
    };
    const before = structuredClone(source);
    const fork = workspaceSessionFork(source, targetCwd, "2026-07-21T08:02:00.000Z");

    assert.notEqual(fork.meta.id, source.meta.id);
    assert.equal(fork.meta.cwd, realpathSync.native(targetCwd));
    assert.equal(fork.meta.createdAt, "2026-07-21T08:02:00.000Z");
    assert.equal(fork.meta.source, "interactive");
    assert.equal(fork.meta.sourceName, undefined);
    assert.equal(fork.meta.archived, undefined);
    assert.equal(fork.meta.gatewayOwner, undefined);
    assert.deepEqual(fork.history, source.history);
    assert.notEqual(fork.task.id, source.task.id);
    assert.notEqual(fork.task.turnId, source.task.turnId);
    assert.equal(fork.task.status, "paused");
    assert.equal(fork.task.steering[0].deliveryState, "consumed", "a fork never duplicates pending steering ownership");
    fork.history[0].content = "changed only in fork";
    assert.deepEqual(source, before, "creating or mutating the fork never rewrites the source session");

    const persisted = persistWorkspaceSessionFork(source, targetCwd, "2026-07-21T08:03:00.000Z");
    const loaded = loadSession(persisted.meta.id);
    assert.ok(loaded);
    assert.equal(loaded.meta.cwd, realpathSync.native(targetCwd));
    assert.equal(loaded.history[0].content, "keep this context");
    assert.equal(latestForCwd(realpathSync.native(targetCwd))?.meta.id, persisted.meta.id);
    assert.equal(loadSession(source.meta.id), null, "the helper does not invent or overwrite the caller's source file");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});
