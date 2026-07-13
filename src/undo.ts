// In-session undo stack for file changes. Each edit tool records the prior state of the files it
// touched; `/undo` pops the last group and restores it. Process-scoped (one REPL session).
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { linkSync, lstatSync, readlinkSync, symlinkSync } from "node:fs";
import { rename, symlink, unlink } from "node:fs/promises";
import { atomicWriteText, discardClaimedPath, FileChangedError, removeCreatedDirectories, type AtomicWriteResult } from "./fs-write.js";
import { readRegularFileSnapshotNoFollow } from "./fs-read.js";
import { invalidateFileCandidates } from "./context/mentions.js";

export interface FileSnap {
  path: string; // display path (as given by the tool)
  absPath: string; // absolute path on disk
  before: string | null; // content before the change; null = file didn't exist → undo deletes it
  beforeMode?: number;
  /** A removed symlink is recreated as a symlink, rather than as a regular file containing target bytes. */
  linkTarget?: string;
  /** The original path was removed (so restore must be create-if-absent). */
  removed?: boolean;
  /** Exact inode written by the tool; lets undo refuse to clobber a concurrent external replacement. */
  committed?: AtomicWriteResult;
  after?: string;
}

const stack: FileSnap[][] = [];
const MAX = 50;

/** Record a group of file changes (one tool call = one undo step). */
export function recordEdit(group: FileSnap[]): void {
  if (!group.length) return;
  stack.push(group);
  if (stack.length > MAX) stack.shift();
}

export function undoDepth(): number {
  return stack.length;
}

async function restoreMovedFile(quarantine: string, target: string): Promise<void> {
  const info = lstatSync(quarantine);
  // link(2) may follow a symlink source on some platforms. Recreate its topology explicitly while retaining
  // create-if-absent semantics; a regular inode can still use an atomic hard link.
  const linkTarget = info.isSymbolicLink() ? readlinkSync(quarantine) : undefined;
  if (linkTarget !== undefined) symlinkSync(linkTarget, target);
  else linkSync(quarantine, target);
  discardClaimedPath(quarantine, {
    dev: info.dev,
    ino: info.ino,
    mode: info.mode & 0o777,
    nlink: info.nlink + (linkTarget === undefined ? 1 : 0),
    linkTarget,
  });
}

/** Undo an update/create only if the path still names the exact inode and bytes written by that tool. */
async function undoCommitted(s: FileSnap): Promise<void> {
  if (!s.committed || s.after === undefined) throw new Error(`missing committed snapshot for ${s.path}`);
  const target = s.committed.target;
  const quarantine = join(dirname(target), `.hara-undo-${process.pid}-${randomUUID()}.tmp`);
  await rename(target, quarantine);
  try {
    // O_NOFOLLOW + same-fd fstat/read rejects a path replaced with a symlink to the committed inode.
    const current = await readRegularFileSnapshotNoFollow(quarantine);
    if (
      current.dev !== s.committed.dev ||
      current.ino !== s.committed.ino ||
      current.mode !== s.committed.mode ||
      current.nlink !== s.committed.nlink ||
      current.text !== s.after
    ) {
      await restoreMovedFile(quarantine, target);
      throw new FileChangedError(s.path);
    }
    if (s.before === null) {
      discardClaimedPath(quarantine, s.committed);
      await removeCreatedDirectories(s.committed.createdDirs);
      return;
    }
    await atomicWriteText(target, s.before, { expected: null, mode: s.beforeMode });
    discardClaimedPath(quarantine, s.committed);
  } catch (error) {
    // If restoration failed after the owned inode was moved, put it back only when the destination is still
    // absent. link(2) never overwrites a concurrent file; leave quarantine for recovery if another appeared.
    try {
      await restoreMovedFile(quarantine, target);
    } catch {
      /* the original error remains the useful user-facing failure */
    }
    throw error;
  }
}

/** Restore the most recent edit group. Returns the files reverted, or an error. */
export async function undoLast(): Promise<{ files: string[] } | { error: string }> {
  const group = stack.pop();
  if (!group) return { error: "nothing to undo" };
  const files: string[] = [];
  const failures: string[] = [];
  for (const s of group) {
    try {
      if (s.committed && s.after !== undefined) {
        await undoCommitted(s);
      } else if (s.before === null) {
        try {
          await unlink(s.absPath); // legacy snapshot: was newly created → remove
        } catch (error: any) {
          if (error?.code !== "ENOENT") throw error;
        }
      } else if (s.linkTarget !== undefined) {
        await symlink(s.linkTarget, s.absPath); // atomic create-if-absent; never clobbers a newer path
      } else {
        await atomicWriteText(s.absPath, s.before, { expected: s.removed ? null : undefined, mode: s.beforeMode });
      }
      files.push(s.path);
    } catch (error: any) {
      failures.push(`${s.path}: ${error?.message ?? String(error)}`);
    }
  }
  if (files.length) invalidateFileCandidates();
  if (failures.length) {
    const prefix = files.length ? `partially reverted ${files.join(", ")}; ` : "";
    return { error: `${prefix}could not safely undo ${failures.join("; ")}` };
  }
  return { files };
}
