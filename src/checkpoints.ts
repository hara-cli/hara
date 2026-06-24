// File-state checkpoints via a SHADOW git repo — durable "undo the agent's file changes" beyond the
// edit-only in-memory undo (which misses bash-made changes). The shadow repo lives OUTSIDE the project
// (~/.hara/checkpoints/<hash>/git) with GIT_DIR there + GIT_WORK_TREE = the project root, so it captures the
// WHOLE tree, NEVER touches the user's real .git/index, and the model never sees it. Restore is
// snapshot-then-checkout: SAFE — it reverts changed/deleted files to the checkpoint and never deletes files
// created since (so a stray restore can't nuke new work; it's also itself undoable via the auto-snapshot).
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { findProjectRoot } from "./context/agents-md.js";

// Heavy/derived dirs the shadow repo must never snapshot (in addition to the project's own .gitignore).
const EXCLUDES = ["node_modules/", ".git/", "dist/", "build/", "out/", ".next/", "target/", ".venv/", "venv/", "__pycache__/", ".hara/", ".cache/", ".turbo/", "coverage/", "*.log", ".DS_Store"];

function shadowGitDir(root: string): string {
  return join(homedir(), ".hara", "checkpoints", createHash("sha256").update(root).digest("hex").slice(0, 16), "git");
}

function git(root: string, gitDir: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    env: { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: root, GIT_AUTHOR_NAME: "hara", GIT_AUTHOR_EMAIL: "hara@local", GIT_COMMITTER_NAME: "hara", GIT_COMMITTER_EMAIL: "hara@local" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 64 * 1024 * 1024,
  }).toString();
}

function ensureRepo(root: string, gitDir: string): boolean {
  try {
    if (!existsSync(join(gitDir, "HEAD"))) {
      mkdirSync(gitDir, { recursive: true });
      git(root, gitDir, ["init", "-q"]);
      mkdirSync(join(gitDir, "info"), { recursive: true });
      writeFileSync(join(gitDir, "info", "exclude"), EXCLUDES.join("\n") + "\n");
    }
    return true;
  } catch {
    return false;
  }
}

/** Snapshot the current working tree into the shadow repo. Returns the short sha, or null on failure. */
export function checkpoint(cwd: string, label: string): string | null {
  const root = findProjectRoot(cwd);
  const gitDir = shadowGitDir(root);
  if (!ensureRepo(root, gitDir)) return null;
  try {
    git(root, gitDir, ["add", "-A"]);
    git(root, gitDir, ["commit", "-q", "--allow-empty", "--no-gpg-sign", "-m", (label || "checkpoint").slice(0, 120)]);
    return git(root, gitDir, ["rev-parse", "--short", "HEAD"]).trim();
  } catch {
    return null;
  }
}

export interface Checkpoint {
  sha: string;
  when: number;
  label: string;
}

/** Recent checkpoints, newest first. */
export function listCheckpoints(cwd: string, n = 15): Checkpoint[] {
  const gitDir = shadowGitDir(findProjectRoot(cwd));
  if (!existsSync(join(gitDir, "HEAD"))) return [];
  try {
    const out = git(findProjectRoot(cwd), gitDir, ["log", `-n${n}`, "--format=%h\x1f%ct\x1f%s"]).trim();
    if (!out) return [];
    return out.split("\n").map((l) => {
      const [sha, ct, ...rest] = l.split("\x1f");
      return { sha, when: Number(ct) * 1000, label: rest.join("\x1f") };
    });
  } catch {
    return [];
  }
}

/** Restore the working tree's changed/deleted files to a checkpoint (snapshots current first, so it's
 *  undoable). Files created AFTER the checkpoint are left in place — nothing is deleted. Returns the count of
 *  files restored, or null on failure. */
export function restoreCheckpoint(cwd: string, ref: string): number | null {
  const root = findProjectRoot(cwd);
  const gitDir = shadowGitDir(root);
  if (!existsSync(join(gitDir, "HEAD"))) return null;
  try {
    checkpoint(cwd, `before restore to ${ref}`); // make the restore itself undoable
    const changed = git(root, gitDir, ["diff", "--name-only", ref, "--"]).trim(); // files differing now vs ref
    git(root, gitDir, ["checkout", ref, "--", "."]);
    return changed ? changed.split("\n").length : 0;
  } catch {
    return null;
  }
}
