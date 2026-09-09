import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { AgentWorktreeManager } from "../dist/subagent/worktree.js";
import "../dist/tools/builtin.js";
import "../dist/tools/edit.js";
import "../dist/tools/patch.js";
import { getTool } from "../dist/tools/registry.js";

const AGENT_A = "11111111-1111-4111-8111-111111111111";
const AGENT_B = "22222222-2222-4222-8222-222222222222";

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || `git ${args[0]} failed`);
  return result.stdout.trim();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "hara-agent-worktree-"));
  const home = join(root, "home");
  const repo = join(root, "repo");
  const nested = join(repo, "packages", "app");
  mkdirSync(home);
  mkdirSync(nested, { recursive: true });
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "test@example.test");
  git(repo, "config", "user.name", "Hara Test");
  writeFileSync(join(nested, "feature.txt"), "base\n");
  writeFileSync(join(repo, "other.txt"), "other\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "base");
  return {
    home,
    nested,
    repo,
    root,
    cleanup() { rmSync(root, { force: true, recursive: true }); },
  };
}

test("isolated Agent Worktree owns a reviewable Diff and applies only after explicit acceptance", () => {
  const state = fixture();
  try {
    const manager = new AgentWorktreeManager(state.nested, state.home, "session-a");
    const binding = manager.prepare(AGENT_A);
    assert.equal(readFileSync(join(binding.cwd, "feature.txt"), "utf8"), "base\n");
    writeFileSync(join(binding.cwd, "feature.txt"), "from child\n");
    writeFileSync(join(binding.cwd, "created.txt"), "new file\n");

    const diff = manager.capture(AGENT_A, binding.baseCommit);
    assert.deepEqual(diff.changedPaths, ["packages/app/created.txt", "packages/app/feature.txt"]);
    assert.match(diff.patch, /from child/u);
    assert.equal(readFileSync(join(state.nested, "feature.txt"), "utf8"), "base\n");
    assert.equal(diff.ownerAgentId, AGENT_A);
    manager.assertWorkspaceId(AGENT_A, diff.workspaceId);
    assert.throws(() => manager.assertWorkspaceId(AGENT_B, diff.workspaceId), /another workspace/i);

    const applied = manager.apply(AGENT_A, diff.baseCommit, diff.patchSha256);
    assert.equal(applied.applied, true);
    assert.equal(readFileSync(join(state.nested, "feature.txt"), "utf8"), "from child\n");
    assert.equal(readFileSync(join(state.nested, "created.txt"), "utf8"), "new file\n");
    assert.throws(() => manager.remove(AGENT_A, manager.prepare(AGENT_B).workspaceId), /another workspace/i);
    assert.equal(manager.remove(AGENT_A, diff.workspaceId), true);
    assert.equal(existsSync(binding.path), false);
    assert.equal(manager.remove(AGENT_A, diff.workspaceId), false, "cleanup retry is idempotent");
  } finally {
    state.cleanup();
  }
});

test("Agent Diff refuses an overlapping source edit or a moved source HEAD", () => {
  const overlap = fixture();
  try {
    const manager = new AgentWorktreeManager(overlap.repo, overlap.home, "session-overlap");
    const binding = manager.prepare(AGENT_A);
    writeFileSync(join(binding.path, "other.txt"), "child\n");
    const diff = manager.capture(AGENT_A, binding.baseCommit);
    writeFileSync(join(overlap.repo, "other.txt"), "user\n");
    assert.throws(
      () => manager.apply(AGENT_A, diff.baseCommit, diff.patchSha256),
      /overlapping changes/i,
    );
    assert.equal(readFileSync(join(overlap.repo, "other.txt"), "utf8"), "user\n");
  } finally {
    overlap.cleanup();
  }

  const moved = fixture();
  try {
    const manager = new AgentWorktreeManager(moved.repo, moved.home, "session-moved");
    const binding = manager.prepare(AGENT_A);
    writeFileSync(join(binding.path, "other.txt"), "child\n");
    const diff = manager.capture(AGENT_A, binding.baseCommit);
    writeFileSync(join(moved.repo, "new-head.txt"), "new head\n");
    git(moved.repo, "add", "new-head.txt");
    git(moved.repo, "commit", "-qm", "move head");
    assert.throws(
      () => manager.apply(AGENT_A, diff.baseCommit, diff.patchSha256),
      /source HEAD changed/i,
    );
  } finally {
    moved.cleanup();
  }
});

test("isolated coding tools cannot escape through an absolute path or worktree symlink", async () => {
  const state = fixture();
  try {
    const manager = new AgentWorktreeManager(state.repo, state.home, "session-boundary");
    const binding = manager.prepare(AGENT_A);
    const write = getTool("write_file");
    assert.ok(write);
    const ctx = { cwd: binding.path, writeBoundary: binding.path };
    const absolute = await write.run({ path: join(state.repo, "outside.txt"), content: "blocked\n" }, ctx);
    assert.match(absolute, /escaped its managed workspace/i);

    symlinkSync(state.repo, join(binding.path, "escape"), "dir");
    const linked = await write.run({ path: "escape/outside.txt", content: "blocked\n" }, ctx);
    assert.match(linked, /escaped its managed workspace/i);
  } finally {
    state.cleanup();
  }
});

test("isolated Agent checkout refuses executable Git content filters", () => {
  const state = fixture();
  try {
    git(state.repo, "config", "filter.fixture.smudge", "echo unsafe");
    writeFileSync(join(state.repo, ".gitattributes"), "*.txt filter=fixture\n");
    git(state.repo, "add", ".gitattributes");
    git(state.repo, "commit", "-qm", "activate unsafe filter");
    const manager = new AgentWorktreeManager(state.repo, state.home, "session-filter");
    assert.throws(() => manager.prepare(AGENT_A), /executable Git .* filters/i);
  } finally {
    state.cleanup();
  }
});
