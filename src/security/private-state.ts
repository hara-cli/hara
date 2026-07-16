// Owner-only migration for Hara's local control plane. New writers should still create private files
// directly, but this repairs installations created by older releases and makes ~/.hara non-traversable by
// other local users before credentials/session state are read.
import {
  closeSync,
  chmodSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  FileReadLimitError,
  MAX_EDIT_READ_BYTES,
  decodeUtf8Strict,
  openVerifiedRegularFileNoFollow,
  verifyOpenedRegularFileSync,
  type RegularFileSnapshot,
} from "../fs-read.js";
import { optionalPosixOpenFlag } from "../fs-open-flags.js";

const PRIVATE_TREES = new Set(["sessions", "checkpoints", "index", "gateway", "cron", "weixin"]);
const tightenedHomes = new Set<string>();
const DEFAULT_MIGRATION_CAP = 50_000;

interface MigrationBudget {
  seen: number;
  readonly cap: number;
}

export interface PrivateStateDirectoryIdentity {
  path: string;
  dev: number;
  ino: number;
}

export interface PrivateStateFileSnapshot extends RegularFileSnapshot {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

export interface PrivateStateFileBinding {
  readonly directory: PrivateStateDirectoryIdentity;
  readonly path: string;
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function chmodPrivate(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch (error) {
    // Windows does not implement POSIX ownership modes. On POSIX, a failed repair is a security failure:
    // propagate it so startup can retry instead of permanently caching an incomplete migration.
    if (process.platform !== "win32") throw error;
  }
}

function checkedPrivateComponent(component: string): string {
  if (
    !component
    || component === "."
    || component === ".."
    || basename(component) !== component
    || /[\\/]/.test(component)
    || component.includes("\0")
  ) {
    throw new Error(`invalid private Hara state path component '${component}'`);
  }
  return component;
}

function verifyPrivateDirectory(identity: PrivateStateDirectoryIdentity): void {
  const info = lstatSync(identity.path);
  if (
    !info.isDirectory()
    || info.isSymbolicLink()
    || info.dev !== identity.dev
    || info.ino !== identity.ino
    || realpathSync.native(identity.path) !== identity.path
  ) throw new Error(`private Hara state directory changed: '${identity.path}'`);
}

/** Tighten one directory through a no-follow descriptor so a pre-existing link is never chmod'd. */
function inspectPrivateDirectory(path: string): PrivateStateDirectoryIdentity {
  const before = lstatSync(path);
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error(`refusing private Hara state directory: '${path}' is not a real directory`);
  }
  if (realpathSync.native(path) !== path) {
    throw new Error(`refusing private Hara state directory: '${path}' contains a symbolic-link component`);
  }
  return { path, dev: before.dev, ino: before.ino };
}

/** Tighten one directory through a no-follow descriptor so a pre-existing link is never chmod'd. */
function verifyAndTightenPrivateDirectory(path: string): PrivateStateDirectoryIdentity {
  const inspected = inspectPrivateDirectory(path);

  // Opening a directory descriptor is not portable to Windows. There, re-checking the link identity around
  // the validation retains the same fail-closed preseed policy and POSIX ownership bits do not apply;
  // POSIX uses O_NOFOLLOW + fchmod.
  if (process.platform === "win32") {
    // no POSIX ownership mode to repair
  } else {
    const fd = openSync(
      path,
      constants.O_RDONLY
        | optionalPosixOpenFlag("O_NONBLOCK")
        | optionalPosixOpenFlag("O_NOFOLLOW")
        | optionalPosixOpenFlag("O_DIRECTORY"),
    );
    try {
      const opened = fstatSync(fd);
      if (!opened.isDirectory() || opened.dev !== inspected.dev || opened.ino !== inspected.ino) {
        throw new Error(`private Hara state directory changed while opening: '${path}'`);
      }
      fchmodSync(fd, 0o700);
    } finally {
      closeSync(fd);
    }
  }
  const after = lstatSync(path);
  if (after.dev !== inspected.dev || after.ino !== inspected.ino) {
    throw new Error(`private Hara state directory changed while tightening: '${path}'`);
  }
  const identity = { path, dev: inspected.dev, ino: inspected.ino } satisfies PrivateStateDirectoryIdentity;
  verifyPrivateDirectory(identity);
  return identity;
}

/**
 * Create a private control-plane subdirectory one component at a time below a canonical trusted base.
 * Existing `.hara`/child components must be real directories; recursive mkdir/chmod is intentionally
 * avoided because either operation would follow a malicious repository-provided link.
 */
export function ensurePrivateStateSubdirectory(
  base: string,
  components: readonly string[],
  tightenExistingFrom = 0,
): PrivateStateDirectoryIdentity {
  if (!Number.isInteger(tightenExistingFrom) || tightenExistingFrom < 0 || tightenExistingFrom > components.length) {
    throw new TypeError("private Hara state tighten boundary is out of range");
  }
  let current = realpathSync.native(resolve(base));
  const baseInfo = lstatSync(current);
  if (!baseInfo.isDirectory() || baseInfo.isSymbolicLink()) {
    throw new Error(`private Hara state base is not a canonical directory: '${current}'`);
  }
  let parent = { path: current, dev: baseInfo.dev, ino: baseInfo.ino } satisfies PrivateStateDirectoryIdentity;
  verifyPrivateDirectory(parent);
  for (let index = 0; index < components.length; index++) {
    const raw = components[index];
    const component = checkedPrivateComponent(raw);
    verifyPrivateDirectory(parent);
    current = join(current, component);
    try {
      const existing = lstatSync(current);
      if (!existing.isDirectory() || existing.isSymbolicLink()) {
        throw new Error(`refusing private Hara state directory: '${current}' is not a real directory`);
      }
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
      // Parent identity is checked immediately before the namespace mutation. mkdir is non-recursive and
      // therefore cannot walk through a newly supplied child link.
      verifyPrivateDirectory(parent);
      try {
        mkdirSync(current, { mode: 0o700 });
      } catch (mkdirError: any) {
        if (mkdirError?.code !== "EEXIST") throw mkdirError;
      }
    }
    parent = index >= tightenExistingFrom
      ? verifyAndTightenPrivateDirectory(current)
      : inspectPrivateDirectory(current);
    verifyPrivateDirectory(parent);
  }
  return parent;
}

/** Bind one immediate file below a symlink-free, owner-only Hara state directory. */
export function bindPrivateHaraStateFile(
  home: string,
  subdirectories: readonly string[],
  filename: string,
): PrivateStateFileBinding {
  const directory = ensurePrivateStateSubdirectory(home, [".hara", ...subdirectories]);
  const name = checkedPrivateComponent(filename);
  const path = join(directory.path, name);
  if (dirname(path) !== directory.path) throw new Error(`private Hara state file is outside '${directory.path}'`);
  verifyPrivateDirectory(directory);
  return { directory, path };
}

function privateReadLimit(maxBytes: number): number {
  const requested = Number.isFinite(maxBytes) ? Math.floor(maxBytes) : MAX_EDIT_READ_BYTES;
  return Math.min(MAX_EDIT_READ_BYTES, Math.max(1, requested));
}

function readFdBytes(fd: number, count: number): Buffer {
  const out = Buffer.allocUnsafe(count);
  let offset = 0;
  while (offset < count) {
    const read = readSync(fd, out, offset, count - offset, offset);
    if (!read) break;
    offset += read;
  }
  return out.subarray(0, offset);
}

/** Synchronous private-state reader for startup/auth APIs that cannot make their public contract async. */
export function readPrivateStateFileSnapshotSync(
  path: string,
  maxBytes = MAX_EDIT_READ_BYTES,
): PrivateStateFileSnapshot | null {
  const limit = privateReadLimit(maxBytes);
  let before;
  try {
    before = lstatSync(path);
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (before.isSymbolicLink()) throw new Error(`refusing private Hara state file: '${path}' is a symbolic link`);
  const fd = openSync(
    path,
    constants.O_RDONLY | optionalPosixOpenFlag("O_NONBLOCK") | optionalPosixOpenFlag("O_NOFOLLOW"),
  );
  try {
    let info = fstatSync(fd);
    verifyOpenedRegularFileSync(path, info, {
      action: "read private Hara state",
      rejectHardLinks: true,
      protectSensitive: false,
    });
    try {
      fchmodSync(fd, 0o600);
    } catch (error) {
      if (process.platform !== "win32") throw error;
    }
    // chmod may update ctime; capture the authoritative baseline afterwards.
    info = fstatSync(fd);
    if (info.size > limit) throw new FileReadLimitError(path, limit);
    const bytes = readFdBytes(fd, Math.min(limit + 1, info.size + 1));
    if (bytes.length > limit) throw new FileReadLimitError(path, limit);
    const latest = fstatSync(fd);
    verifyOpenedRegularFileSync(path, latest, {
      action: "read private Hara state",
      rejectHardLinks: true,
      protectSensitive: false,
    });
    if (
      latest.dev !== info.dev
      || latest.ino !== info.ino
      || latest.size !== info.size
      || latest.mtimeMs !== info.mtimeMs
      || latest.ctimeMs !== info.ctimeMs
    ) throw new Error(`private Hara state file changed while reading: '${path}'`);
    return {
      text: decodeUtf8Strict(bytes, path),
      dev: latest.dev,
      ino: latest.ino,
      mode: latest.mode & 0o777,
      nlink: latest.nlink,
      size: latest.size,
      mtimeMs: latest.mtimeMs,
      ctimeMs: latest.ctimeMs,
    };
  } finally {
    closeSync(fd);
  }
}

function samePrivateFile(path: string, expected: Pick<RegularFileSnapshot, "dev" | "ino" | "mode" | "nlink">): boolean {
  const info = lstatSync(path);
  return (
    info.isFile()
    && !info.isSymbolicLink()
    && privateStateFileIdentityMatches({
      dev: info.dev,
      ino: info.ino,
      mode: info.mode & 0o777,
      nlink: info.nlink,
    }, expected)
  );
}

/**
 * Compare the fields Node can use as a stable file identity on the current platform. Windows only exposes
 * owner read/write permission semantics, so its synthetic POSIX mode can differ between descriptor- and
 * path-based stats without identifying a different file. File type, dev/ino and hard-link count remain
 * mandatory there; POSIX additionally requires the exact owner-only mode.
 */
export function privateStateFileIdentityMatches(
  actual: Pick<RegularFileSnapshot, "dev" | "ino" | "mode" | "nlink">,
  expected: Pick<RegularFileSnapshot, "dev" | "ino" | "mode" | "nlink">,
  platform: string = process.platform,
): boolean {
  return (
    actual.dev === expected.dev
    && actual.ino === expected.ino
    && actual.nlink === expected.nlink
    && (platform === "win32" || actual.mode === expected.mode)
  );
}

function privateFileIdentitySummary(path: string): string {
  try {
    const info = lstatSync(path);
    return JSON.stringify({
      file: info.isFile(),
      symlink: info.isSymbolicLink(),
      dev: info.dev,
      ino: info.ino,
      mode: info.mode & 0o777,
      nlink: info.nlink,
    });
  } catch (error: any) {
    return JSON.stringify({ error: error?.code ?? error?.message ?? String(error) });
  }
}

function restorePrivateClaim(
  claimed: string,
  target: string,
  expected: Pick<RegularFileSnapshot, "dev" | "ino" | "mode" | "nlink">,
): void {
  if (!samePrivateFile(claimed, expected)) {
    throw new Error(`private Hara state claim changed; original entry is preserved at '${claimed}'`);
  }
  try {
    linkSync(claimed, target);
  } catch (error: any) {
    if (error?.code === "EEXIST") {
      throw new Error(`another entry appeared at '${target}'; original entry is preserved at '${claimed}'`);
    }
    throw error;
  }
  const linked = { ...expected, nlink: expected.nlink + 1 };
  if (!samePrivateFile(claimed, linked) || !samePrivateFile(target, linked)) {
    throw new Error(`private Hara state restore changed; original entry is preserved at '${claimed}'`);
  }
  unlinkSync(claimed);
}

function syncPrivateDirectory(path: string): void {
  try {
    const fd = openSync(
      path,
      constants.O_RDONLY
        | optionalPosixOpenFlag("O_NONBLOCK")
        | optionalPosixOpenFlag("O_NOFOLLOW")
        | optionalPosixOpenFlag("O_DIRECTORY"),
    );
    try {
      if (fstatSync(fd).isDirectory()) fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    /* Directory fsync is not portable; the staged file itself is always fsynced. */
  }
}

/**
 * Crash-safe, no-follow, compare-and-swap replacement for one bound private state file. Existing entries
 * are move-claimed before verification so a concurrent alias/replacement is never overwritten silently.
 */
export function writePrivateStateFileSync(binding: PrivateStateFileBinding, text: string): void {
  const { directory, path } = binding;
  verifyPrivateDirectory(directory);
  if (resolve(path) !== join(directory.path, checkedPrivateComponent(basename(path)))) {
    throw new Error(`private Hara state file is outside '${directory.path}'`);
  }
  const existing = readPrivateStateFileSnapshotSync(path);
  verifyPrivateDirectory(directory);

  const temp = join(directory.path, `.hara-private-${process.pid}-${randomUUID()}.tmp`);
  let fd: number | undefined;
  let staged: Pick<RegularFileSnapshot, "dev" | "ino" | "mode" | "nlink"> | undefined;
  try {
    fd = openSync(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | optionalPosixOpenFlag("O_NOFOLLOW"),
      0o600,
    );
    writeFileSync(fd, text, "utf8");
    try {
      fchmodSync(fd, 0o600);
    } catch (error) {
      if (process.platform !== "win32") throw error;
    }
    fsyncSync(fd);
    const stagedInfo = fstatSync(fd);
    if (!stagedInfo.isFile() || stagedInfo.nlink !== 1) throw new Error("unsafe private Hara state staging inode");
    staged = {
      dev: stagedInfo.dev,
      ino: stagedInfo.ino,
      mode: stagedInfo.mode & 0o777,
      nlink: stagedInfo.nlink,
    };
    closeSync(fd);
    fd = undefined;

    if (!existing) {
      try {
        verifyPrivateDirectory(directory);
        linkSync(temp, path);
      } catch (error: any) {
        if (error?.code === "EEXIST") throw new Error(`private Hara state file changed before create: '${path}'`);
        throw error;
      }
    } else {
      const claimed = join(directory.path, `.hara-claim-${process.pid}-${randomUUID()}.tmp`);
      try {
        verifyPrivateDirectory(directory);
        renameSync(path, claimed);
      } catch (error: any) {
        if (error?.code === "ENOENT") throw new Error(`private Hara state file changed before replace: '${path}'`);
        throw error;
      }
      let verifiedClaim = false;
      try {
        const claimedSnapshot = readPrivateStateFileSnapshotSync(claimed);
        verifiedClaim = Boolean(
          claimedSnapshot
          && claimedSnapshot.dev === existing.dev
          && claimedSnapshot.ino === existing.ino
          && claimedSnapshot.mode === existing.mode
          && claimedSnapshot.nlink === existing.nlink
          && claimedSnapshot.text === existing.text
        );
        if (!verifiedClaim) throw new Error(`private Hara state file changed before replace: '${path}'`);
      } catch (error) {
        try {
          restorePrivateClaim(claimed, path, existing);
        } catch (restoreError: any) {
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}; safe restore was incomplete: ${restoreError?.message ?? String(restoreError)}`,
            { cause: error },
          );
        }
        throw error;
      }
      try {
        verifyPrivateDirectory(directory);
        linkSync(temp, path);
      } catch (error: any) {
        let recovery = "";
        try {
          restorePrivateClaim(claimed, path, existing);
        } catch (restoreError: any) {
          recovery = `; original entry is retained: ${restoreError?.message ?? String(restoreError)}`;
        }
        throw new Error(`${error?.message ?? String(error)}${recovery}`, { cause: error });
      }
      if (verifiedClaim) {
        try {
          if (samePrivateFile(claimed, existing)) unlinkSync(claimed);
        } catch {
          // The new entry is already committed. Retain a changed/unremovable unpredictable claim instead of
          // risking deletion of a concurrently supplied path; it contains only the previous private state.
        }
      }
    }

    const linkedStaged = { ...staged, nlink: staged.nlink + 1 };
    if (!samePrivateFile(temp, linkedStaged) || !samePrivateFile(path, linkedStaged)) {
      throw new Error(
        `private Hara state staging identity changed during commit: '${path}'`
        + `; expected=${JSON.stringify(linkedStaged)}`
        + `; staging=${privateFileIdentitySummary(temp)}`
        + `; target=${privateFileIdentitySummary(path)}`,
      );
    }
    unlinkSync(temp);
    const committed = lstatSync(path);
    if (
      !staged
      || !committed.isFile()
      || committed.isSymbolicLink()
      || committed.dev !== staged.dev
      || committed.ino !== staged.ino
      || committed.nlink !== 1
      || (process.platform !== "win32" && (committed.mode & 0o777) !== 0o600)
    ) throw new Error(`private Hara state file changed during commit: '${path}'`);
    verifyPrivateDirectory(directory);
    syncPrivateDirectory(directory.path);
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* preserve original error */ }
    if (staged) {
      try {
        if (samePrivateFile(temp, staged)) unlinkSync(temp);
      } catch {
        /* A changed entry is retained rather than unlinking an attacker-supplied replacement. */
      }
    }
  }
}

/** Open/read one internal state file without following aliases, reject hard links, and repair mode by fd. */
export async function readPrivateStateFileSnapshot(
  path: string,
  maxBytes = MAX_EDIT_READ_BYTES,
): Promise<PrivateStateFileSnapshot | null> {
  const requested = Number.isFinite(maxBytes) ? Math.floor(maxBytes) : MAX_EDIT_READ_BYTES;
  const limit = Math.min(MAX_EDIT_READ_BYTES, Math.max(1, requested));
  let verified;
  try {
    verified = await openVerifiedRegularFileNoFollow(path, {
      action: "read private Hara state",
      rejectHardLinks: true,
      protectSensitive: false,
    });
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  try {
    const { handle } = verified;
    try {
      await handle.chmod(0o600);
    } catch (error) {
      if (process.platform !== "win32") throw error;
    }
    const before = await handle.stat();
    if (before.size > limit) throw new FileReadLimitError(path, limit);
    const chunks: Buffer[] = [];
    let total = 0;
    let position = 0;
    while (total <= limit) {
      const want = Math.min(64 * 1024, limit + 1 - total);
      const buffer = Buffer.allocUnsafe(want);
      const { bytesRead } = await handle.read(buffer, 0, want, position);
      if (!bytesRead) break;
      chunks.push(buffer.subarray(0, bytesRead));
      total += bytesRead;
      position += bytesRead;
    }
    if (total > limit) throw new FileReadLimitError(path, limit);
    const after = await handle.stat();
    verifyOpenedRegularFileSync(path, after, {
      action: "read private Hara state",
      rejectHardLinks: true,
      protectSensitive: false,
    });
    if (
      after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs
    ) throw new Error(`private Hara state file changed while reading: '${path}'`);
    return {
      text: decodeUtf8Strict(Buffer.concat(chunks, total), path),
      dev: after.dev,
      ino: after.ino,
      mode: after.mode & 0o777,
      nlink: after.nlink,
      size: after.size,
      mtimeMs: after.mtimeMs,
      ctimeMs: after.ctimeMs,
    };
  } finally {
    await verified.handle.close().catch(() => {});
  }
}

/** Remove only the exact single-link inode previously read from the same still-bound private directory. */
export function removePrivateStateFile(
  path: string,
  expected: PrivateStateFileSnapshot,
  directory: PrivateStateDirectoryIdentity,
): void {
  verifyPrivateDirectory(directory);
  if (resolve(path) !== join(directory.path, basename(path))) {
    throw new Error(`private Hara state file is outside '${directory.path}'`);
  }
  const current = lstatSync(path);
  if (
    !current.isFile()
    || current.isSymbolicLink()
    || current.nlink !== 1
    || current.dev !== expected.dev
    || current.ino !== expected.ino
    || (current.mode & 0o777) !== expected.mode
    || current.size !== expected.size
    || current.mtimeMs !== expected.mtimeMs
    || current.ctimeMs !== expected.ctimeMs
  ) throw new Error(`private Hara state file changed before removal: '${path}'`);
  verifyPrivateDirectory(directory);
  unlinkSync(path);
}

function consumeBudget(path: string, budget: MigrationBudget): void {
  budget.seen++;
  if (budget.seen > budget.cap) {
    throw new Error(
      `private Hara state migration exceeded ${budget.cap} entries at '${path}'; ` +
        "refusing to cache an incomplete permission repair",
    );
  }
}

function tightenTree(root: string, budget: MigrationBudget): void {
  const stack = [root];
  while (stack.length) {
    const path = stack.pop()!;
    consumeBudget(path, budget);
    let info;
    try {
      info = lstatSync(path);
    } catch (error) {
      if (isMissing(error)) continue; // a concurrently removed derived file needs no repair
      throw error;
    }
    if (info.isSymbolicLink()) continue; // never chmod a target chosen through a replaceable link
    if (info.isDirectory()) {
      chmodPrivate(path, 0o700);
      const entries = readdirSync(path);
      for (const entry of entries) stack.push(join(path, entry));
    } else if (info.isFile() && info.nlink === 1) {
      // chmod follows hard links at the inode level. An attacker-controlled alias must not let startup
      // tighten (and thereby mutate) an unrelated file outside ~/.hara; dedicated readers reject it later.
      chmodPrivate(path, 0o600);
    }
  }
}

/** Repair one Hara home. Exported with an injected path for offline tests. */
export function tightenPrivateHaraState(home = homedir(), cap = DEFAULT_MIGRATION_CAP): void {
  if (!Number.isSafeInteger(cap) || cap < 1) throw new TypeError("private Hara state migration cap must be a positive integer");
  const root = join(home, ".hara");
  let rootInfo;
  try {
    rootInfo = lstatSync(root);
  } catch (error) {
    if (!isMissing(error)) throw error;
    mkdirSync(root, { recursive: true, mode: 0o700 });
    rootInfo = lstatSync(root);
  }
  // `chmod` follows symlinks. Reject the control-plane root before touching it so ~/.hara cannot be
  // redirected to an unrelated user directory by a local link/race left from an older installation.
  if (rootInfo.isSymbolicLink()) throw new Error(`refusing private Hara state migration: '${root}' is a symbolic link`);
  if (!rootInfo.isDirectory()) throw new Error(`refusing private Hara state migration: '${root}' is not a directory`);
  chmodPrivate(root, 0o700);

  const budget: MigrationBudget = { seen: 0, cap };
  const entries = readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    // Re-check with lstat inside tightenTree instead of trusting a possibly stale Dirent. It also skips
    // symlinks, including top-level file links, without following their targets.
    if (entry.isFile() || (entry.isDirectory() && PRIVATE_TREES.has(entry.name))) tightenTree(path, budget);
  }
}

/** Process-once startup migration; repeated loadConfig calls stay cheap. */
export function ensurePrivateHaraState(home = homedir(), cap = DEFAULT_MIGRATION_CAP): void {
  if (tightenedHomes.has(home)) return;
  tightenPrivateHaraState(home, cap);
  // Cache only after the whole migration succeeds. Cap/permission failures are therefore retryable.
  tightenedHomes.add(home);
}

/** @internal test helper. */
export function resetPrivateHaraStateForTests(): void {
  tightenedHomes.clear();
}
