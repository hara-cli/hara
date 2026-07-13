// Crash-safe UTF-8 writes for coding tools. Content is staged beside the destination, fsynced, then
// renamed into place so a killed process never leaves a half-written source file.
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { constants, linkSync, lstatSync, readlinkSync, renameSync, symlinkSync, unlinkSync } from "node:fs";
import { link, lstat, mkdir, open, realpath, rename, rmdir, stat, unlink } from "node:fs/promises";
import { NonRegularFileError, readRegularFileSnapshotNoFollow, type RegularFileSnapshot } from "./fs-read.js";

export class FileChangedError extends Error {
  readonly code = "HARA_FILE_CHANGED";

  constructor(path: string) {
    super(`File changed while the edit was being prepared: ${path}. Re-read it and retry the edit.`);
    this.name = "FileChangedError";
  }
}

export interface AtomicWriteOptions {
  /** undefined = unconditional; string = current content must match; null = path must not exist. */
  expected?: string | null;
  /** Exact file identity captured with expected. Coding tools provide this to reject same-content replacements. */
  expectedIdentity?: Pick<RegularFileSnapshot, "dev" | "ino" | "mode" | "nlink">;
  /** Explicit permission bits for the staged inode (used by transactional rollback). */
  mode?: number;
}

export interface CreatedDirectory extends Pick<RegularFileSnapshot, "dev" | "ino" | "mode"> {
  path: string;
}

export interface AtomicWriteResult extends Pick<RegularFileSnapshot, "dev" | "ino" | "mode" | "nlink"> {
  /** Actual path replaced. Symlink destinations resolve to their target so rollback touches the same inode. */
  target: string;
  /** Parent directories this call itself created, top-down. Transaction rollback may remove them if unchanged/empty. */
  createdDirs: CreatedDirectory[];
  /** Non-fatal cleanup refusals after the new inode was committed. */
  warnings?: string[];
}

export interface ClaimedPathIdentity extends Pick<RegularFileSnapshot, "dev" | "ino" | "mode" | "nlink"> {
  /** Set only when the claimed entry itself is a symlink. */
  linkTarget?: string;
}

let tempSequence = 0;

async function writeTarget(path: string): Promise<string> {
  try {
    const info = await lstat(path);
    // Replacing a symlink would silently break it. Stage beside the real target instead so edits retain
    // the link (common in dotfile repos and generated workspace layouts).
    if (info.isSymbolicLink()) return await realpath(path);
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  return path;
}

/** mkdir -p with ownership accounting: only a mkdir call that actually succeeded is recorded. */
async function ensureDirectory(path: string, created: CreatedDirectory[]): Promise<void> {
  try {
    const info = await stat(path);
    if (!info.isDirectory()) throw new Error(`${path} is not a directory`);
    return;
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  const parent = dirname(path);
  if (parent === path) throw new Error(`cannot create directory ${path}`);
  await ensureDirectory(parent, created);
  try {
    await mkdir(path);
    const info = await lstat(path);
    if (!info.isDirectory()) throw new Error(`${path} changed while it was being created`);
    // Store the canonical name now. Keeping a lexical path beneath a symlink would make undo look in a
    // different tree after that parent link is retargeted, silently leaving directories we created behind.
    const canonical = await realpath(path);
    const canonicalInfo = await lstat(canonical);
    if (!canonicalInfo.isDirectory() || canonicalInfo.dev !== info.dev || canonicalInfo.ino !== info.ino) {
      throw new FileChangedError(path);
    }
    created.push({ path: canonical, dev: info.dev, ino: info.ino, mode: info.mode & 0o777 });
  } catch (error: any) {
    if (error?.code !== "EEXIST") throw error;
    const info = await stat(path);
    if (!info.isDirectory()) throw new Error(`${path} is not a directory`);
  }
}

/** Remove only directories this process actually created and that still name the same empty inode. */
export async function removeCreatedDirectories(created: CreatedDirectory[]): Promise<void> {
  for (let i = created.length - 1; i >= 0; i--) {
    const expected = created[i];
    let info;
    try {
      info = await lstat(expected.path);
    } catch (error: any) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (!info.isDirectory() || info.dev !== expected.dev || info.ino !== expected.ino || (info.mode & 0o777) !== expected.mode) {
      throw new FileChangedError(expected.path);
    }
    await rmdir(expected.path); // ENOTEMPTY is a safe refusal: concurrent content is never removed.
  }
}

/**
 * Delete a previously verified quarantine entry without reopening the long verify→unlink race.
 *
 * The caller has already verified content through a no-follow descriptor. We atomically claim the current
 * directory entry under one more unpredictable name, then perform the final no-follow identity check and
 * unlink synchronously in the same JS turn. A same-process watcher therefore cannot replace the entry in
 * the long asynchronous content-read window and have an unrelated inode unlinked. On any mismatch/failure,
 * the claimed entry is deliberately retained and its exact recovery path is included in the error.
 */
export function discardClaimedPath(path: string, expected: ClaimedPathIdentity): void {
  const disposal = join(dirname(path), `.hara-discard-${process.pid}-${randomUUID()}.tmp`);
  renameSync(path, disposal);
  try {
    const info = lstatSync(disposal);
    const isLink = expected.linkTarget !== undefined;
    const same =
      info.dev === expected.dev &&
      info.ino === expected.ino &&
      (info.mode & 0o777) === expected.mode &&
      info.nlink === expected.nlink &&
      info.isSymbolicLink() === isLink &&
      (!isLink || readlinkSync(disposal) === expected.linkTarget);
    if (!same) throw new FileChangedError(path);
    unlinkSync(disposal);
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; claimed entry is preserved at ${disposal}`,
      { cause: error },
    );
  }
}

function sameClaimedPath(path: string, expected: ClaimedPathIdentity): boolean {
  const info = lstatSync(path);
  const isLink = expected.linkTarget !== undefined;
  return (
    info.dev === expected.dev &&
    info.ino === expected.ino &&
    (info.mode & 0o777) === expected.mode &&
    info.nlink === expected.nlink &&
    info.isSymbolicLink() === isLink &&
    (!isLink || readlinkSync(path) === expected.linkTarget)
  );
}

/** Restore a move-claimed entry without overwriting a path that appeared concurrently. */
function restoreClaimedPath(claimed: string, target: string, expected: ClaimedPathIdentity): void {
  if (!sameClaimedPath(claimed, expected)) {
    throw new Error(`${new FileChangedError(target).message}; claimed entry is preserved at ${claimed}`);
  }
  const info = lstatSync(claimed);
  if (info.isDirectory()) {
    // POSIX has no portable rename-no-replace for directories. Retaining is safer than overwriting a new target.
    throw new Error(`cannot safely restore a concurrently claimed directory; it is preserved at ${claimed}`);
  }
  try {
    if (expected.linkTarget !== undefined) symlinkSync(expected.linkTarget, target);
    else linkSync(claimed, target);
  } catch (error: any) {
    if (error?.code === "EEXIST") {
      throw new Error(`another entry appeared at ${target}; the claimed entry is preserved at ${claimed}`);
    }
    throw error;
  }
  discardClaimedPath(claimed, {
    ...expected,
    nlink: expected.nlink + (expected.linkTarget === undefined ? 1 : 0),
  });
}

async function syncDirectory(path: string): Promise<void> {
  // Directory fsync makes the rename durable across a power loss on POSIX. Some filesystems/platforms
  // reject opening directories, so durability degrades gracefully after the file itself was synced.
  try {
    // The directory name can be exchanged after rename. O_NONBLOCK plus fstat on this exact descriptor
    // keeps best-effort durability from hanging forever on a replacement FIFO/device.
    const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      if (!(await handle.stat()).isDirectory()) return;
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    /* best effort */
  }
}

/** Atomically replace/create a UTF-8 file, optionally refusing to overwrite a newer disk version. */
export async function atomicWriteText(path: string, content: string, options: AtomicWriteOptions = {}): Promise<AtomicWriteResult> {
  let target = await writeTarget(path);
  let dir = dirname(target);
  const createdDirs: CreatedDirectory[] = [];
  await ensureDirectory(dir, createdDirs);
  // Canonicalize the parent too, not just a final-component symlink. A workspace may sit beneath a linked
  // directory; returning/rolling back the canonical target prevents a concurrent parent retarget from sending
  // later transaction steps to a different tree.
  dir = await realpath(dir);
  target = join(dir, basename(target));

  // A caller-provided preflight identity is authoritative. Reading mode from a path before the move-claim
  // would let a temporary same-path replacement influence the mode even when the expected inode is restored
  // before claim verification.
  let mode = options.mode === undefined ? (options.expectedIdentity?.mode ?? 0o666) : options.mode & 0o777;
  let preserveExactMode = options.mode !== undefined || options.expectedIdentity !== undefined;
  try {
    const info = await stat(target);
    if (!info.isFile()) throw new NonRegularFileError(path);
    if (options.mode === undefined && !options.expectedIdentity) mode = info.mode & 0o777;
    preserveExactMode = true;
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }

  // Keep the staging basename fixed-size: prefixing the destination's full basename would make a
  // perfectly valid near-NAME_MAX file impossible to edit because the temporary name becomes longer.
  const temp = join(dir, `.hara-${process.pid}-${Date.now().toString(36)}-${tempSequence++}.tmp`);
  let staged = false;
  let writtenIdentity: Pick<RegularFileSnapshot, "dev" | "ino" | "mode" | "nlink"> | undefined;
  const warnings: string[] = [];
  let succeeded = false;
  try {
    const handle = await open(temp, "wx", mode);
    staged = true;
    try {
      await handle.writeFile(content, "utf8");
      // open(2) applies the process umask even when replacing an existing file. Restore that existing (or
      // explicit rollback) mode on the staged fd; brand-new ordinary files still honor the user's umask.
      if (preserveExactMode) await handle.chmod(mode);
      await handle.sync();
      const info = await handle.stat();
      writtenIdentity = { dev: info.dev, ino: info.ino, mode: info.mode & 0o777, nlink: info.nlink };
    } finally {
      await handle.close();
    }

    if (options.expected === null) {
      // link(2) is an atomic create-if-absent operation. A plain rename would overwrite a file that
      // appeared after validation, defeating create's no-clobber contract.
      try {
        await link(temp, target);
      } catch (error: any) {
        if (error?.code === "EEXIST") throw new FileChangedError(path);
        throw error;
      }
      await unlink(temp);
      staged = false;
    } else if (typeof options.expected === "string") {
      // Claim the directory entry BEFORE verification. Reading the old fd and then rename-overwriting the
      // path leaves a verify→commit race; a concurrent replacement can otherwise be silently destroyed.
      const claimed = join(dir, `.hara-claim-${process.pid}-${randomUUID()}.tmp`);
      try {
        await rename(target, claimed);
      } catch (error: any) {
        if (error?.code === "ENOENT") throw new FileChangedError(path);
        throw error;
      }
      let claimedIdentity: ClaimedPathIdentity | undefined;
      try {
        const pathInfo = await lstat(claimed);
        claimedIdentity = {
          dev: pathInfo.dev,
          ino: pathInfo.ino,
          mode: pathInfo.mode & 0o777,
          nlink: pathInfo.nlink,
          linkTarget: pathInfo.isSymbolicLink() ? readlinkSync(claimed) : undefined,
        };
        const current = await readRegularFileSnapshotNoFollow(claimed);
        const expectedIdentity = options.expectedIdentity;
        const identityMatches =
          !expectedIdentity ||
          (current.dev === expectedIdentity.dev &&
            current.ino === expectedIdentity.ino &&
            current.mode === expectedIdentity.mode &&
            current.nlink === expectedIdentity.nlink);
        if (!identityMatches || current.text !== options.expected) throw new FileChangedError(path);
      } catch (error) {
        try {
          if (!claimedIdentity) {
            const info = lstatSync(claimed);
            claimedIdentity = {
              dev: info.dev,
              ino: info.ino,
              mode: info.mode & 0o777,
              nlink: info.nlink,
              linkTarget: info.isSymbolicLink() ? readlinkSync(claimed) : undefined,
            };
          }
          restoreClaimedPath(claimed, target, claimedIdentity);
        } catch (restoreError: any) {
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}; safe restore was incomplete: ${restoreError?.message ?? String(restoreError)}`,
            { cause: error },
          );
        }
        throw error;
      }

      if (!claimedIdentity) throw new Error(`Failed to identify claimed file for ${path}`);

      try {
        await link(temp, target); // atomic create-if-absent: never overwrites an entry created after claim.
      } catch (error: any) {
        let recovery = "";
        try {
          restoreClaimedPath(claimed, target, claimedIdentity);
        } catch (restoreError: any) {
          recovery = `; claimed old entry is retained: ${restoreError?.message ?? String(restoreError)}`;
        }
        if (error?.code === "EEXIST") throw new Error(`${new FileChangedError(path).message}${recovery}`);
        throw new Error(`${error?.message ?? String(error)}${recovery}`, { cause: error });
      }
      await unlink(temp);
      staged = false;
      try {
        discardClaimedPath(claimed, claimedIdentity);
      } catch (error: any) {
        warnings.push(`old entry cleanup was refused: ${error?.message ?? String(error)}`);
      }
    } else {
      await rename(temp, target);
      staged = false;
    }
    await syncDirectory(dir);
    succeeded = true;
  } finally {
    if (staged) await unlink(temp).catch(() => {});
    if (!succeeded) await removeCreatedDirectories(createdDirs).catch(() => {});
  }
  if (!writtenIdentity) throw new Error(`Failed to identify staged file for ${path}`);
  return { ...writtenIdentity, target, createdDirs, ...(warnings.length ? { warnings } : {}) };
}
