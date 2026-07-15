// Owner-only migration for Hara's local control plane. New writers should still create private files
// directly, but this repairs installations created by older releases and makes ~/.hara non-traversable by
// other local users before credentials/session state are read.
import {
  closeSync,
  chmodSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import {
  FileReadLimitError,
  MAX_EDIT_READ_BYTES,
  openVerifiedRegularFileNoFollow,
  verifyOpenedRegularFileSync,
  type RegularFileSnapshot,
} from "../fs-read.js";

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
  if (!component || component === "." || component === ".." || basename(component) !== component || component.includes(sep) || component.includes("\0")) {
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
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    const directoryOnly = typeof constants.O_DIRECTORY === "number" ? constants.O_DIRECTORY : 0;
    const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | noFollow | directoryOnly);
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
      text: Buffer.concat(chunks, total).toString("utf8"),
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
