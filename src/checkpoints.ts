// File-state checkpoints via a SHADOW git repo — durable "undo the agent's file changes" beyond the
// edit-only in-memory undo (which misses bash-made changes). The shadow repo lives OUTSIDE the project
// (~/.hara/checkpoints/<hash>/git) with GIT_DIR there + GIT_WORK_TREE = the project root, so it captures the
// WHOLE tree, NEVER touches the user's real .git/index, and the model never sees it. Restore is
// snapshot-then-checkout: SAFE — it reverts changed/deleted files to the checkpoint and never deletes files
// created since (so a stray restore can't nuke new work; it's also itself undoable via the auto-snapshot).
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { findProjectRoot } from "./context/agents-md.js";
import { toolSubprocessEnv } from "./security/subprocess-env.js";
import { sensitiveFileReason } from "./security/sensitive-files.js";
import { redactSensitiveText } from "./security/secrets.js";

// Heavy/derived dirs the shadow repo must never snapshot (in addition to the project's own .gitignore).
const PRIVATE_DATA_EXCLUDES = ["credentials", "credential", "secrets", "secret", "service-account", "service_account"]
  .flatMap((stem) => ["json", "yaml", "yml", "toml", "ini", "cfg", "conf"].map((ext) => `**/${stem}.${ext}`));
const EXCLUDES = [
  "node_modules/", ".git/", "dist/", "build/", "out/", ".next/", "target/", ".venv/", "venv/",
  "__pycache__/", ".hara/", ".cache/", ".turbo/", "coverage/", "*.log", ".DS_Store",
  "**/.env", "**/.env.*", "!**/.env.example", "!**/.env.*.example", "!**/.env.sample", "!**/.env.*.sample",
  "!**/.env.template", "!**/.env.*.template", "!**/.env.dist", "!**/.env.*.dist", "!**/.env.defaults", "!**/.env.*.defaults",
  "**/.envrc", "**/.direnv/", "**/.netrc", "**/.npmrc", "**/.pypirc", "**/.git-credentials",
  "**/credentials", "**/credential", "**/secrets", "**/secret", "**/service-account", "**/service_account",
  ...PRIVATE_DATA_EXCLUDES,
  "**/application_default_credentials.json", "**/.aws/credentials", "**/.docker/config.json", "**/.kube/config",
  "**/id_rsa", "**/id_ed25519", "**/id_ecdsa", "**/*.pem", "**/*.key", "**/*.p12", "**/*.pfx", "**/*.keystore",
];
const CHECKPOINT_FORMAT = "protected-files-v2";

function shadowGitDir(root: string): string {
  return join(homedir(), ".hara", "checkpoints", createHash("sha256").update(root).digest("hex").slice(0, 16), "git");
}

function git(root: string, gitDir: string, args: string[], input?: string): string {
  return execFileSync("git", args, {
    cwd: root,
    env: toolSubprocessEnv(process.env, { GIT_DIR: gitDir, GIT_WORK_TREE: root, GIT_AUTHOR_NAME: "hara", GIT_AUTHOR_EMAIL: "hara@local", GIT_COMMITTER_NAME: "hara", GIT_COMMITTER_EMAIL: "hara@local" }),
    encoding: "utf8",
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"],
    ...(input === undefined ? {} : { input }),
    maxBuffer: 64 * 1024 * 1024,
    // Bound it: the per-turn shadow `git add -A` over a large tree (or a hung git) must never freeze a
    // turn. On timeout execFileSync throws → checkpoint()/ensureRepo() catch it → the snapshot is just
    // skipped (best-effort), the turn proceeds.
    timeout: 10000,
  }).toString();
}

function ensureRepo(root: string, gitDir: string): boolean {
  try {
    const stateDir = dirname(gitDir);
    const checkpointRoot = dirname(stateDir);
    const marker = join(stateDir, "format");
    mkdirSync(checkpointRoot, { recursive: true, mode: 0o700 });
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    try { chmodSync(checkpointRoot, 0o700); chmodSync(stateDir, 0o700); } catch { /* best effort */ }

    // Older shadow repositories may contain secret blobs even after the path leaves the index. Checkpoints
    // are a derived undo cache, so rotate the repository instead of pretending git-rm purged its history.
    let format = "";
    try { format = readFileSync(marker, "utf8").trim(); } catch { /* first protected open */ }
    if (existsSync(gitDir) && format !== CHECKPOINT_FORMAT) rmSync(gitDir, { recursive: true, force: true });
    if (!existsSync(join(gitDir, "HEAD"))) {
      mkdirSync(gitDir, { recursive: true, mode: 0o700 });
      git(root, gitDir, ["init", "-q"]);
      mkdirSync(join(gitDir, "info"), { recursive: true });
    }
    try { chmodSync(gitDir, 0o700); } catch { /* best effort */ }
    writeFileSync(marker, CHECKPOINT_FORMAT + "\n", { mode: 0o600 });
    try { chmodSync(marker, 0o600); } catch { /* best effort on non-POSIX filesystems */ }
    mkdirSync(join(gitDir, "info"), { recursive: true });
    const excludeFile = join(gitDir, "info", "exclude");
    writeFileSync(excludeFile, EXCLUDES.join("\n") + "\n", { mode: 0o600 });
    try { chmodSync(excludeFile, 0o600); } catch { /* best effort on non-POSIX filesystems */ }
    return true;
  } catch {
    return false;
  }
}

function dropSensitiveIndexEntries(root: string, gitDir: string): number {
  const indexed = git(root, gitDir, ["ls-files", "-z"]).split("\0").filter(Boolean);
  const protectedPaths = indexed.filter((path) => sensitiveFileReason(join(root, path)) !== null);
  if (protectedPaths.length) {
    // stdin pathspecs avoid ARG_MAX and preserve arbitrary filenames (including whitespace/newlines).
    git(root, gitDir, ["update-index", "--force-remove", "-z", "--stdin"], protectedPaths.join("\0") + "\0");
  }
  return protectedPaths.length;
}

/** Snapshot the current working tree into the shadow repo. Returns the short sha, or null on failure. */
export function checkpoint(cwd: string, label: string): string | null {
  const root = findProjectRoot(cwd);
  const gitDir = shadowGitDir(root);
  if (!ensureRepo(root, gitDir)) return null;
  try {
    // If a path became protected after this format was introduced, merely unstaging it would leave its
    // historical blobs reachable. Rotate the derived repository before taking another snapshot.
    if (dropSensitiveIndexEntries(root, gitDir) > 0) {
      rmSync(gitDir, { recursive: true, force: true });
      if (!ensureRepo(root, gitDir)) return null;
    }
    git(root, gitDir, ["add", "-A"]);
    // Defense against a future exclude-list regression. Once git-add saw a protected path its blob may exist
    // even if we unstage it, so fail closed and purge the derived repository instead of retaining that object.
    if (dropSensitiveIndexEntries(root, gitDir) > 0) {
      rmSync(gitDir, { recursive: true, force: true });
      return null;
    }
    const safeLabel = redactSensitiveText(label || "checkpoint").text.slice(0, 120);
    git(root, gitDir, ["commit", "-q", "--allow-empty", "--no-gpg-sign", "-m", safeLabel]);
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
  const root = findProjectRoot(cwd);
  const gitDir = shadowGitDir(root);
  if (!ensureRepo(root, gitDir) || !existsSync(join(gitDir, "HEAD"))) return [];
  try {
    const out = git(root, gitDir, ["log", `-n${n}`, "--format=%h\x1f%ct\x1f%s"]).trim();
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
  if (!/^[0-9a-f]{4,64}$/i.test(ref)) return null; // checkpoint refs are hashes; reject option/ref injection
  const root = findProjectRoot(cwd);
  const gitDir = shadowGitDir(root);
  if (!ensureRepo(root, gitDir) || !existsSync(join(gitDir, "HEAD"))) return null;
  try {
    // Restoring without a durable pre-restore snapshot can destroy the user's newest work. Checkpointing is
    // best-effort during ordinary turns, but it is a hard prerequisite for this destructive operation.
    if (!checkpoint(cwd, `before restore to ${ref}`)) return null;
    const changed = new Set(git(root, gitDir, ["diff", "--name-only", "-z", ref, "--"]).split("\0").filter(Boolean));
    // A pre-restore snapshot tracks files created after `ref`; `git checkout ref -- new-file` would make
    // the whole checkout fail. Restore only paths that actually existed at the requested checkpoint.
    const atRef = git(root, gitDir, ["ls-tree", "-r", "-z", "--name-only", ref]).split("\0").filter(Boolean);
    const safe = atRef.filter((path) => changed.has(path) && sensitiveFileReason(join(root, path)) === null);
    if (safe.length) {
      git(root, gitDir, ["checkout", ref, "--pathspec-from-file=-", "--pathspec-file-nul"], safe.join("\0") + "\0");
    }
    return safe.length;
  } catch {
    return null;
  }
}
