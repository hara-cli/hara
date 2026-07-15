// apply_patch — change MULTIPLE files atomically (all-or-nothing). Everything is validated and
// computed in memory first; nothing is written unless every change applies cleanly.
import { linkSync, lstatSync, readlinkSync, renameSync, symlinkSync } from "node:fs";
import { lstat, readlink, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { registerTool } from "./registry.js";
import { applyEdits, type OneEdit } from "./apply-core.js";
import { emitDiff } from "../diff.js";
import { recordEdit } from "../undo.js";
import {
  atomicWriteText,
  bindAtomicParentEntryPath,
  bindAtomicWritePath,
  discardClaimedPath,
  FileChangedError,
  removeCreatedDirectories,
  verifyAtomicWriteBoundary,
  type AtomicWriteBoundary,
  type AtomicWriteResult,
} from "../fs-write.js";
import { invalidateFileCandidates } from "../context/mentions.js";
import {
  readRegularFileSnapshot,
  readRegularFileSnapshotNoFollow,
  readVerifiedRegularFileSnapshot,
  resolveVerifiedModelPath,
  type RegularFileSnapshot,
} from "../fs-read.js";
import { sensitiveFileError } from "../security/sensitive-files.js";

interface Change {
  path: string;
  type?: "update" | "create" | "delete";
  edits?: OneEdit[];
  content?: string;
}

interface Plan {
  path: string;
  abs: string;
  type: "update" | "create" | "delete";
  before: string;
  after: string | null; // null = delete
  existed: boolean; // did the file exist before (for undo: false → undo deletes)
  beforeMode?: number;
  beforeIdentity?: Pick<RegularFileSnapshot, "dev" | "ino" | "mode" | "nlink">;
  beforePathIdentity?: Pick<RegularFileSnapshot, "dev" | "ino" | "mode" | "nlink">;
  beforeLinkTarget?: string;
  writeBoundary?: AtomicWriteBoundary;
  committed?: AtomicWriteResult;
  quarantine?: string;
}

async function restoreMovedFile(quarantine: string, target: string): Promise<void> {
  let identity;
  try {
    // Keep source inspection + create-if-absent in one JS turn. The subsequent discard performs another
    // synchronous identity claim, so a watcher cannot turn cleanup into an unlink of an unrelated entry.
    const info = lstatSync(quarantine);
    const linkTarget = info.isSymbolicLink() ? readlinkSync(quarantine) : undefined;
    if (linkTarget !== undefined) symlinkSync(linkTarget, target);
    else linkSync(quarantine, target);
    identity = {
      dev: info.dev,
      ino: info.ino,
      mode: info.mode & 0o777,
      nlink: info.nlink + (linkTarget === undefined ? 1 : 0),
      linkTarget,
    };
  } catch (error: any) {
    if (error?.code === "EEXIST") {
      throw new Error(`another file appeared at ${target}; the concurrently moved file is preserved at ${quarantine}`);
    }
    throw error;
  }
  discardClaimedPath(quarantine, identity);
}

/** Roll back a file we wrote without read→unlink/rename TOCTOU. First atomically move whichever inode is
 * currently at the path aside, then inspect that moved inode. A concurrent replacement is restored with
 * create-if-absent and never deleted/overwritten. */
async function rollbackWrittenPlan(plan: Plan): Promise<void> {
  if (!plan.committed || plan.after === null) throw new Error(`missing commit identity for ${plan.path}`);
  const target = plan.committed.target;
  const quarantine = join(dirname(target), `.hara-rollback-${process.pid}-${randomUUID()}.tmp`);
  // atomicWriteText follows a destination symlink and replaces its real target. Roll back that exact returned
  // target path; moving plan.abs would destroy the symlink while leaving the changed target untouched.
  await rename(target, quarantine);

  let current: RegularFileSnapshot;
  try {
    current = await readRegularFileSnapshotNoFollow(quarantine);
  } catch (error) {
    await restoreMovedFile(quarantine, target);
    throw error;
  }
  const owned = current.dev === plan.committed.dev && current.ino === plan.committed.ino && current.mode === plan.committed.mode && current.nlink === plan.committed.nlink && current.text === plan.after;
  if (!owned) {
    await restoreMovedFile(quarantine, target);
    throw new FileChangedError(plan.path);
  }

  if (plan.type === "create") {
    discardClaimedPath(quarantine, plan.committed);
    await removeCreatedDirectories(plan.committed.createdDirs);
    return;
  }
  if (plan.beforeMode === undefined) {
    await restoreMovedFile(quarantine, target);
    throw new Error(`missing preflight mode for ${plan.path}`);
  }
  try {
    await atomicWriteText(target, plan.before, { expected: null, mode: plan.beforeMode });
  } catch (error) {
    try {
      await restoreMovedFile(quarantine, target);
    } catch (restoreError: any) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}; could not restore quarantine: ${restoreError?.message ?? String(restoreError)}`);
    }
    throw error;
  }
  discardClaimedPath(quarantine, plan.committed);
}

async function quarantineExpectedDelete(plan: Plan, signal?: AbortSignal): Promise<void> {
  if (!plan.beforeIdentity || !plan.beforePathIdentity || plan.beforeMode === undefined) throw new Error(`missing preflight identity for ${plan.path}`);
  if (!plan.writeBoundary) throw new Error(`missing parent boundary for ${plan.path}`);
  // Keep the initially moved path private until it has been verified. A directory watcher must not be able
  // to mistake an unverified staging entry for the durable delete quarantine used by the commit/cleanup
  // phases. Recording it immediately also lets the outer rollback recover (or accurately report) a failure
  // that happens after rename but before verification completes.
  const staging = join(dirname(plan.abs), `.hara-stage-delete-${process.pid}-${randomUUID()}.tmp`);
  if (signal?.aborted) throw new Error("apply_patch delete cancelled before commit");
  verifyAtomicWriteBoundary(plan.writeBoundary);
  renameSync(plan.abs, staging);
  plan.quarantine = staging;
  const movedPath = await lstat(staging);
  const samePath = movedPath.dev === plan.beforePathIdentity.dev && movedPath.ino === plan.beforePathIdentity.ino && (movedPath.mode & 0o777) === plan.beforePathIdentity.mode && movedPath.nlink === plan.beforePathIdentity.nlink;
  const isExpectedLink = plan.beforeLinkTarget !== undefined;
  const sameLink = movedPath.isSymbolicLink() === isExpectedLink && (!isExpectedLink || await readlink(staging) === plan.beforeLinkTarget);
  if (!samePath || !sameLink) throw new FileChangedError(plan.path);
  const moved = isExpectedLink
    ? await readRegularFileSnapshot(staging)
    : await readRegularFileSnapshotNoFollow(staging);
  if (moved.dev !== plan.beforeIdentity.dev || moved.ino !== plan.beforeIdentity.ino || moved.mode !== plan.beforeMode || moved.nlink !== plan.beforeIdentity.nlink || moved.text !== plan.before) {
    throw new FileChangedError(plan.path);
  }
  const quarantine = join(dirname(plan.abs), `.hara-delete-${process.pid}-${randomUUID()}.tmp`);
  if (signal?.aborted) throw new Error("apply_patch delete cancelled during verification");
  verifyAtomicWriteBoundary(plan.writeBoundary);
  renameSync(staging, quarantine);
  plan.quarantine = quarantine;
}

/** Move a delete quarantine to a fresh name and verify that exact moved path before restore/cleanup. If a
 * concurrent process replaced the known quarantine name, preserve the unexpected inode and fail closed. */
async function claimDeleteQuarantine(plan: Plan, purpose: "restore" | "cleanup"): Promise<string> {
  if (!plan.quarantine || !plan.beforePathIdentity || !plan.beforeIdentity || plan.beforeMode === undefined || !plan.writeBoundary) {
    throw new Error(`missing delete quarantine identity for ${plan.path}`);
  }
  const claimed = join(dirname(plan.quarantine), `.hara-${purpose}-${process.pid}-${randomUUID()}.tmp`);
  verifyAtomicWriteBoundary(plan.writeBoundary);
  renameSync(plan.quarantine, claimed);
  try {
    const pathInfo = await lstat(claimed);
    const expectedPath = plan.beforePathIdentity;
    const expectedLink = plan.beforeLinkTarget !== undefined;
    if (
      pathInfo.dev !== expectedPath.dev ||
      pathInfo.ino !== expectedPath.ino ||
      (pathInfo.mode & 0o777) !== expectedPath.mode ||
      pathInfo.nlink !== expectedPath.nlink ||
      pathInfo.isSymbolicLink() !== expectedLink ||
      (expectedLink && await readlink(claimed) !== plan.beforeLinkTarget)
    ) {
      throw new FileChangedError(plan.path);
    }
    if (!expectedLink) {
      const file = await readRegularFileSnapshotNoFollow(claimed);
      if (
        file.dev !== plan.beforeIdentity.dev ||
        file.ino !== plan.beforeIdentity.ino ||
        file.mode !== plan.beforeMode ||
        file.nlink !== plan.beforeIdentity.nlink ||
        file.text !== plan.before
      ) {
        throw new FileChangedError(plan.path);
      }
    }
    return claimed;
  } catch (error) {
    try {
      await restoreMovedFile(claimed, plan.quarantine);
    } catch (restoreError: any) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}; unexpected quarantine is preserved at ${claimed}: ${restoreError?.message ?? String(restoreError)}`);
    }
    throw error;
  }
}

registerTool({
  name: "apply_patch",
  description:
    "Change SEVERAL files in one atomic step (all-or-nothing). `changes` is an array of " +
    "{path, type:'update'|'create'|'delete', edits?:[{old_string,new_string,replace_all?}], content?}. " +
    "update applies edits (or replaces the whole file with content); create writes a new file; delete removes it. " +
    "If ANY change fails to apply, nothing is written. Prefer this over multiple edit_file calls for multi-file changes.",
  input_schema: {
    type: "object",
    properties: {
      changes: {
        type: "array",
        description: "the file changes to apply together",
        items: {
          type: "object",
          properties: {
            path: { type: "string" },
            type: { type: "string", enum: ["update", "create", "delete"] },
            content: { type: "string", description: "full file content (for create, or whole-file update)" },
            edits: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  old_string: { type: "string" },
                  new_string: { type: "string" },
                  replace_all: { type: "boolean" },
                },
                required: ["old_string", "new_string"],
              },
            },
          },
          required: ["path"],
        },
      },
    },
    required: ["changes"],
  },
  kind: "edit",
  requiresProjectWorkspace: true,
  async run(input, ctx) {
    const changes: Change[] = Array.isArray(input.changes) ? input.changes : [];
    if (!changes.length) return "Error: apply_patch needs a non-empty `changes` array.";
    const abs = (pth: string): string => (isAbsolute(pth) ? pth : resolve(ctx.cwd, pth));

    // PHASE 1 — validate + compute every change in memory; bail before writing anything.
    const plans: Plan[] = [];
    const plannedPaths = new Set<string>();
    for (let i = 0; i < changes.length; i++) {
      const ch = changes[i];
      const tag = `change ${i + 1}/${changes.length}`;
      if (typeof ch.path !== "string" || !ch.path) return `Error: ${tag} is missing a path. Nothing written.`;
      const p = abs(ch.path);
      const denied = sensitiveFileError(p, "patch");
      if (denied) return `Error: ${tag}: ${denied} Nothing written.`;
      if (plannedPaths.has(p)) return `Error: ${tag} repeats path ${ch.path}. Combine edits for one file into a single change. Nothing written.`;
      plannedPaths.add(p);

      let type = ch.type ?? (ch.edits ? "update" : "create");
      // Backward-compatible shorthand: {path, content} updates an existing file and creates a missing
      // one. An EXPLICIT type:create is stricter and never clobbers an existing path.
      if (!ch.type && !ch.edits) {
        try {
          await lstat(p);
          type = "update";
        } catch (error: any) {
          if (error?.code !== "ENOENT") return `Error: ${tag} cannot inspect ${ch.path}: ${error?.message ?? String(error)}. Nothing written.`;
        }
      }

      if (type === "delete") {
        let before: RegularFileSnapshot;
        let pathInfo: Awaited<ReturnType<typeof lstat>>;
        let beforeLinkTarget: string | undefined;
        let writeBoundary: AtomicWriteBoundary;
        try {
          writeBoundary = bindAtomicParentEntryPath(p, "patch");
          pathInfo = await lstat(writeBoundary.target);
          if (pathInfo.isSymbolicLink()) beforeLinkTarget = await readlink(writeBoundary.target);
          const target = resolveVerifiedModelPath(writeBoundary.target, "patch");
          before = await readVerifiedRegularFileSnapshot(target, undefined, "patch");
        } catch (error: any) {
          return `Error: ${tag} delete ${ch.path}: ${error?.message ?? "file not found"}. Nothing written.`;
        }
        plans.push({
          path: ch.path,
          abs: writeBoundary.target,
          type,
          before: before.text,
          beforeMode: before.mode,
          beforeIdentity: { dev: before.dev, ino: before.ino, mode: before.mode, nlink: before.nlink },
          beforePathIdentity: { dev: pathInfo.dev, ino: pathInfo.ino, mode: pathInfo.mode & 0o777, nlink: pathInfo.nlink },
          beforeLinkTarget,
          writeBoundary,
          after: null,
          existed: true,
        });
      } else if (type === "create") {
        if (typeof ch.content !== "string") return `Error: ${tag} create ${ch.path} needs \`content\`. Nothing written.`;
        let writeBoundary: AtomicWriteBoundary | undefined;
        try {
          writeBoundary = bindAtomicWritePath(p, "patch");
          await lstat(writeBoundary.target);
          return `Error: ${tag} create ${ch.path}: path already exists (use type:update to replace it). Nothing written.`;
        } catch (error: any) {
          if (error?.code !== "ENOENT" || !writeBoundary) return `Error: ${tag} create ${ch.path}: ${error?.message ?? String(error)}. Nothing written.`;
        }
        if (!writeBoundary) return `Error: ${tag} create ${ch.path}: cannot bind a stable parent. Nothing written.`;
        plans.push({ path: ch.path, abs: writeBoundary.target, type, before: "", after: ch.content, existed: false, writeBoundary });
      } else {
        // update
        let before: RegularFileSnapshot;
        let writeBoundary: AtomicWriteBoundary;
        try {
          writeBoundary = bindAtomicWritePath(p, "patch");
          before = await readVerifiedRegularFileSnapshot(writeBoundary.target, undefined, "patch");
        } catch (error: any) {
          return `Error: ${tag} update ${ch.path}: cannot read (${error?.message ?? "unknown error"}; use type:create for a new file). Nothing written.`;
        }
        if (typeof ch.content === "string" && !ch.edits) {
          plans.push({ path: ch.path, abs: writeBoundary.target, type, before: before.text, beforeMode: before.mode, beforeIdentity: { dev: before.dev, ino: before.ino, mode: before.mode, nlink: before.nlink }, after: ch.content, existed: true, writeBoundary });
        } else {
          const res = applyEdits(before.text, ch.edits ?? []);
          if ("error" in res) return `Error: ${tag} ${ch.path} — ${res.error}. Nothing written.`;
          plans.push({ path: ch.path, abs: writeBoundary.target, type, before: before.text, beforeMode: before.mode, beforeIdentity: { dev: before.dev, ino: before.ino, mode: before.mode, nlink: before.nlink }, after: res.text, existed: true, writeBoundary });
        }
      }
    }

    // PHASE 2 — commit all changes. Truly all-or-nothing: if any write fails mid-way, roll back the ones
    // already applied (restore updated/deleted files, remove created ones) so the tree is never half-patched.
    const applied: typeof plans = [];
    try {
      for (const pl of plans) {
        if (ctx.signal?.aborted) throw new Error("apply_patch cancelled before commit");
        if (pl.type === "delete") {
          // Atomic move-then-inspect: a replacement inode is moved aside and restored, never unlinked.
          // The expected inode remains quarantined until every other patch step has committed.
          await quarantineExpectedDelete(pl, ctx.signal);
        } else {
          pl.committed = await atomicWriteText(pl.abs, pl.after as string, {
            expected: pl.existed ? pl.before : null,
            expectedIdentity: pl.existed ? pl.beforeIdentity : undefined,
            boundary: pl.writeBoundary,
            signal: ctx.signal,
          });
        }
        applied.push(pl);
        if (ctx.signal?.aborted) throw new Error("apply_patch cancelled during commit; rolling back");
      }
    } catch (e) {
      const rollbackFailures: string[] = [];
      // A delete becomes a visible mutation at its first rename, before its verification can finish. Include
      // that partially staged plan in rollback instead of claiming that an empty `applied` list means the
      // tree was untouched.
      const rollbackPlans = [...applied];
      for (const pl of plans) {
        if (pl.quarantine && !rollbackPlans.includes(pl)) rollbackPlans.push(pl);
      }
      for (const pl of rollbackPlans.reverse()) {
        try {
          if (pl.type === "delete") {
            if (!pl.quarantine) throw new Error(`missing delete quarantine for ${pl.path}`);
            const claimed = await claimDeleteQuarantine(pl, "restore");
            await restoreMovedFile(claimed, pl.abs);
          } else {
            await rollbackWrittenPlan(pl);
          }
        } catch (rollbackError: any) {
          rollbackFailures.push(`${pl.path}: ${rollbackError?.message ?? String(rollbackError)}`);
        }
      }
      if (rollbackFailures.length) {
        return `Error: apply_patch failed (${e instanceof Error ? e.message : String(e)}); rollback was INCOMPLETE: ${rollbackFailures.join("; ")}. Inspect these files before continuing.`;
      }
      return `Error: apply_patch failed writing a file (${e instanceof Error ? e.message : String(e)}) — rolled back, nothing left changed.`;
    }
    // Deletes become final only after every commit step succeeds. Cleanup cannot affect visible paths;
    // report a rare failure rather than rolling back after another quarantine may already be removed.
    const cleanupFailures: string[] = [];
    for (const pl of plans) {
      for (const warning of pl.committed?.warnings ?? []) cleanupFailures.push(`${pl.path}: ${warning}`);
    }
    for (const pl of plans) {
      if (!pl.quarantine) continue;
      try {
        const claimed = await claimDeleteQuarantine(pl, "cleanup");
        if (!pl.beforePathIdentity) throw new Error(`missing delete path identity for ${pl.path}`);
        discardClaimedPath(claimed, { ...pl.beforePathIdentity, linkTarget: pl.beforeLinkTarget });
      } catch (error: any) {
        cleanupFailures.push(`${pl.path}: old entry cleanup was refused (${error?.message ?? String(error)})`);
      }
    }
    // All writes succeeded → now show diffs + record the undo snapshot.
    const summary = plans.map((pl) => {
      emitDiff(pl.path, pl.before, pl.type === "delete" ? "" : (pl.after as string), ctx.ui);
      return pl.type === "delete" ? `deleted ${pl.path}` : `${pl.type === "create" ? "created" : "updated"} ${pl.path}`;
    });
    recordEdit(plans.map((pl) => ({
      path: pl.path,
      absPath: pl.abs,
      before: pl.existed ? pl.before : null,
      beforeMode: pl.beforeMode,
      linkTarget: pl.type === "delete" ? pl.beforeLinkTarget : undefined,
      removed: pl.type === "delete",
      committed: pl.committed,
      after: pl.after ?? undefined,
    })));
    invalidateFileCandidates(ctx.cwd);
    return `apply_patch: ${plans.length} file(s) — ${summary.join("; ")}.` + (cleanupFailures.length ? ` Warning: ${cleanupFailures.join("; ")}` : "");
  },
});
