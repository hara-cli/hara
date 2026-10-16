// Session persistence's synchronous filesystem lane. Legacy calls keep their existing behavior;
// scoped calls fence every operation to the original registered directory identities. In particular,
// a staging open that raced a parent replacement is closed BEFORE any descriptor content is written.
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { opendir as nativeOpenDir } from "node:fs/promises";
import { bindWorkspaceResourceFile, workspaceResourceCommitGuard } from "./resource-context.js";

function fenced<F extends (...args: any[]) => any>(operation: () => F): F {
  return ((...args: Parameters<F>): ReturnType<F> => {
    const assertCurrent = workspaceResourceCommitGuard();
    assertCurrent?.();
    const result = operation()(...args);
    assertCurrent?.();
    return result;
  }) as F;
}

export const chmodSync = fenced(() => fs.chmodSync);
export const existsSync = fenced(() => fs.existsSync);
export const lstatSync = fenced(() => fs.lstatSync);
export const mkdirSync = fenced(() => fs.mkdirSync);
export const readFileSync = fenced(() => fs.readFileSync);
export const readdirSync = fenced(() => fs.readdirSync);
export const renameSync = fenced(() => fs.renameSync);
export const writeFileSync = fenced(() => fs.writeFileSync);

function sameEntry(a: fs.Stats, b: fs.Stats): boolean {
  return a.isFile() && b.isFile() && !a.isSymbolicLink() && !b.isSymbolicLink()
    && a.dev === b.dev && a.ino === b.ino && a.nlink === b.nlink
    && a.size === b.size && a.mtimeMs === b.mtimeMs && a.mode === b.mode;
}

/** Scoped removals claim the entry under an unpredictable name and verify its original inode before
 * unlinking. A late parent replacement may move a foreign entry, but it cannot silently delete it:
 * mismatch recovery restores the exact observed claim with no-clobber link, even after scope denial.
 * No recursive directory deletion is supported in this private session lane. */
export const rmSync: typeof fs.rmSync = (path, options) => {
  const assertCurrent = workspaceResourceCommitGuard();
  if (!assertCurrent) return fs.rmSync(path, options);
  if (typeof path !== "string" || options?.recursive) throw new Error("scoped session removal requires one explicit regular file");
  const binding = bindWorkspaceResourceFile(path);
  let expected: fs.Stats;
  try { expected = fs.lstatSync(binding.path); } catch (error: any) {
    if (error?.code === "ENOENT" && options?.force) return;
    throw error;
  }
  if (!expected.isFile() || expected.isSymbolicLink() || expected.nlink !== 1) throw new Error("unsafe scoped session removal entry");
  binding.assertCurrent();
  const claim = join(dirname(binding.path), `.hara-remove-${randomUUID()}.tmp`);
  fs.renameSync(binding.path, claim);
  let observed: fs.Stats | undefined;
  let removed = false;
  try {
    observed = fs.lstatSync(claim);
    if (!sameEntry(expected, observed)) throw new Error("scoped session removal claim changed identity");
    binding.assertCurrent();
    if (!sameEntry(observed, fs.lstatSync(claim))) throw new Error("scoped session removal claim changed before unlink");
    binding.assertCurrent();
    fs.unlinkSync(claim);
    removed = true;
    assertCurrent();
  } catch (error) {
    if (!removed) {
      try {
        // Resolve only OUR newly claimed entry. Cleanup never guesses a different source file and never
        // overwrites a successor that appeared at the original name.
        const actualClaim = fs.realpathSync.native(claim);
        const actual = fs.lstatSync(actualClaim);
        if (!observed) observed = actual;
        if (!sameEntry(observed, actual) || actual.nlink !== 1) throw new Error("scoped removal recovery claim changed");
        const restore = join(dirname(actualClaim), basename(binding.path));
        fs.linkSync(actualClaim, restore);
        const linked = fs.lstatSync(actualClaim), restored = fs.lstatSync(restore);
        if (linked.dev !== actual.dev || linked.ino !== actual.ino || linked.nlink !== 2
          || restored.dev !== actual.dev || restored.ino !== actual.ino || restored.nlink !== 2) throw new Error("scoped removal recovery identity changed");
        fs.unlinkSync(actualClaim);
      } catch (recoveryError) {
        throw new Error("scoped session removal refused; recovery claim retained for explicit inspection", { cause: recoveryError });
      }
    }
    throw error;
  }
};
export const openSync: typeof fs.openSync = (...args: Parameters<typeof fs.openSync>) => {
  const assertCurrent = workspaceResourceCommitGuard();
  assertCurrent?.();
  const descriptor = fs.openSync(...args);
  try { assertCurrent?.(); return descriptor; } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
};

export const openDirAsync: typeof nativeOpenDir = (async (...args: Parameters<typeof nativeOpenDir>) => {
  const assertCurrent = workspaceResourceCommitGuard();
  assertCurrent?.();
  const directory = await nativeOpenDir(...args);
  try { assertCurrent?.(); return directory; } catch (error) {
    await directory.close();
    throw error;
  }
}) as typeof nativeOpenDir;
