import { createHash } from "node:crypto";
import { constants, closeSync, existsSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, writeFileSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export interface LegacyBackupFile { path: string; bytes: number; sha256: string; sourceMode: number }
export interface LegacyBackupManifest {
  schemaVersion: 1; state: "complete"; createdAt: string; sourceHome: string; launchAgentsRoot: string;
  sourceFingerprint: string; files: LegacyBackupFile[]; skipped: { path: string; reason: "excluded" | "symlink" | "special" }[];
}
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const inside = (path: string, root: string) => path === root || path.startsWith(root + "/");
/** The company namespace `nanhara` alone is NOT evidence that a service belongs to Hara. */
export function isLegacyHaraLaunchAgent(name: string): boolean {
  return /^[a-zA-Z0-9._-]+\.plist$/.test(name) && (/(?:^|[.-])hara(?:[.-]|$)/.test(name)
    || /^com\.nanhara\.(?:pi-talk-meeting|ceo-console-bridge)\.plist$/.test(name));
}
function canonicalDirectory(path: string) {
  const full = resolve(path), info = lstatSync(full);
  if (!isAbsolute(path) || !info.isDirectory() || info.isSymbolicLink() || realpathSync.native(full) !== full || process.platform !== "win32" && info.uid !== process.getuid?.()) throw new Error("Legacy backup directory is not an owned canonical directory");
  return full;
}
function privateDirectory(path: string) { mkdirSync(path, { recursive: true, mode: 0o700 }); const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync.native(path) !== path || process.platform !== "win32" && (info.uid !== process.getuid?.() || (info.mode & 0o077))) throw new Error("Legacy backup destination is not private");
}
/** Explicit owner-only snapshot; never constructor IO, automatic discovery or a model tool. Source
 * descriptors are read-only/no-follow. Symlinks are inventoried, never materialized into runnable links. */
export function createLegacyBackup(input: { sourceHome: string; destination: string; launchAgentsRoot: string; excluded?: string[]; now?: string }) {
  const sourceHome = canonicalDirectory(input.sourceHome), source = canonicalDirectory(join(sourceHome, ".hara"));
  const launchAgentsRoot = canonicalDirectory(input.launchAgentsRoot), destination = canonicalDirectory(input.destination);
  if (inside(destination, source) || inside(destination, launchAgentsRoot) || inside(source, destination) || inside(launchAgentsRoot, destination)) throw new Error("Legacy backup source and destination must be disjoint");
  const destinationInfo = lstatSync(destination);
  if (process.platform !== "win32" && (destinationInfo.mode & 0o077)) throw new Error("Legacy backup root must be private");
  if (readdirSync(destination).length) throw new Error("Legacy backup destination must be empty; existing evidence was preserved");
  const excluded = new Set(input.excluded ?? ["checkpoints", "wechat-group"]);
  if ([...excluded].some(name => !/^[a-zA-Z0-9._-]+$/.test(name))) throw new Error("Invalid backup exclusion");
  const files: LegacyBackupFile[] = [], skipped: LegacyBackupManifest["skipped"] = [], original: { path: string; record: LegacyBackupFile }[] = [];
  let total = 0;
  const copy = (from: string, to: string, logical: string) => {
    if (files.length + skipped.length >= 100000) throw new Error("Legacy backup file bound exceeded; partial evidence retained");
    const info = lstatSync(from);
    if (info.isSymbolicLink()) { skipped.push({ path: logical, reason: "symlink" }); return; }
    if (realpathSync.native(from) !== from || !inside(from, source) && !inside(from, launchAgentsRoot)) throw new Error("Legacy source path changed; partial evidence retained");
    if (process.platform !== "win32" && info.uid !== process.getuid?.()) throw new Error("Legacy backup found foreign-owned input; partial evidence retained");
    if (info.isDirectory()) { privateDirectory(to); for (const name of readdirSync(from).sort()) copy(join(from, name), join(to, name), logical + "/" + name);
      const after = lstatSync(from); if (after.isSymbolicLink() || after.ino !== info.ino || after.dev !== info.dev || realpathSync.native(from) !== from) throw new Error("Legacy source directory changed; partial evidence retained"); return; }
    if (!info.isFile()) { skipped.push({ path: logical, reason: "special" }); return; }
    if (info.size > 512 * 1024 * 1024 || total + info.size > 4 * 1024 * 1024 * 1024) throw new Error("Legacy backup byte bound exceeded; partial evidence retained");
    privateDirectory(dirname(to));
    const fd = openSync(from, constants.O_RDONLY | constants.O_NOFOLLOW), out = openSync(to, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const digest = createHash("sha256"), buffer = Buffer.allocUnsafe(1024 * 1024);
    try {
      const start = fstatSync(fd);
      if (!start.isFile() || start.ino !== info.ino || start.dev !== info.dev || start.size !== info.size) throw new Error("Legacy source changed while opening; partial evidence retained");
      let bytes = 0, count;
      while ((count = readSync(fd, buffer)) > 0) { digest.update(buffer.subarray(0, count)); let written = 0; while (written < count) written += writeSync(out, buffer, written, count - written); bytes += count; }
      const end = fstatSync(fd), pathEnd = lstatSync(from);
      if (bytes !== start.size || start.size !== end.size || start.mtimeMs !== end.mtimeMs || start.ctimeMs !== end.ctimeMs || pathEnd.isSymbolicLink() || pathEnd.ino !== start.ino || pathEnd.dev !== start.dev) throw new Error("Legacy source changed during copy; partial evidence retained");
      fchmodSync(out, 0o400); const record = { path: logical, bytes, sha256: digest.digest("hex"), sourceMode: info.mode & 0o777 };
      files.push(record); original.push({ path: from, record }); total += bytes;
    } finally { closeSync(fd); closeSync(out); }
  };
  const copiedHome = join(destination, "source-home"), copiedLaunch = join(destination, "launch-agents");
  privateDirectory(join(copiedHome, ".hara")); privateDirectory(copiedLaunch);
  for (const name of readdirSync(source).sort()) {
    if (excluded.has(name)) skipped.push({ path: ".hara/" + name, reason: "excluded" });
    else copy(join(source, name), join(copiedHome, ".hara", name), ".hara/" + name);
  }
  for (const name of readdirSync(launchAgentsRoot).sort().filter(isLegacyHaraLaunchAgent)) copy(join(launchAgentsRoot, name), join(copiedLaunch, name), "LaunchAgents/" + name);
  // Configuration and job definitions must still match after the potentially larger binary copy.
  // Volatile transcripts/logs are individually stable snapshots, not a claim of a global writer freeze.
  for (const row of original.filter(row => /^\.hara\/(?:profiles\.json|config\.json|projects\.json|cron\/jobs\.json|roles\/)/.test(row.record.path))) {
    const bytes = readLegacyBackupBytes(row.path, row.record.bytes + 1); if (sha(bytes) !== row.record.sha256) throw new Error("Legacy configuration changed during snapshot; preserve and retry in a new directory");
  }
  const manifest: LegacyBackupManifest = { schemaVersion: 1, state: "complete", createdAt: input.now ?? new Date().toISOString(), sourceHome, launchAgentsRoot,
    sourceFingerprint: sha(JSON.stringify(files.map(row => [row.path, row.sha256]))), files, skipped };
  writeFileSync(join(destination, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return { manifest, sourceHome: copiedHome, launchAgentsRoot: copiedLaunch, totalBytes: total };
}
/** Used on snapshots and the few rechecked original definitions only. Never serialize file contents. */
export function readLegacyBackupBytes(path: string, maxBytes = 4 * 1024 * 1024): Buffer {
  const info = lstatSync(path); if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) throw new Error("Legacy input is not a bounded regular file");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const before = fstatSync(fd); if (before.ino !== info.ino || before.dev !== info.dev || !before.isFile() || before.size > maxBytes) throw new Error("Legacy input changed");
    const result = Buffer.alloc(before.size); let read = 0; while (read < result.length) { const count = readSync(fd, result, read, result.length - read, null); if (!count) throw new Error("Legacy input truncated"); read += count; }
    const after = fstatSync(fd); if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("Legacy input changed"); return result;
  } finally { closeSync(fd); }
}
export function verifyLegacyBackup(root: string): LegacyBackupManifest {
  root = canonicalDirectory(root); let manifest: LegacyBackupManifest;
  try { manifest = JSON.parse(readLegacyBackupBytes(join(root, "manifest.json"), 32 * 1024 * 1024).toString("utf8")) as LegacyBackupManifest; }
  catch { throw new Error("Invalid legacy backup manifest; contents withheld"); }
  if (manifest.schemaVersion !== 1 || manifest.state !== "complete" || !Array.isArray(manifest.files) || manifest.files.length > 100000) throw new Error("Invalid legacy backup manifest");
  const seen = new Set<string>();
  for (const row of manifest.files) {
    if (!row || typeof row.path !== "string" || seen.has(row.path) || row.path.includes("\\") || row.path.split("/").some(part => !part || part === "." || part === "..") || !/^[a-f0-9]{64}$/.test(row.sha256) || !Number.isSafeInteger(row.bytes) || row.bytes < 0) throw new Error("Invalid legacy backup entry");
    seen.add(row.path);
    const path = row.path.startsWith(".hara/") ? join(root, "source-home", row.path) : row.path.startsWith("LaunchAgents/") ? join(root, "launch-agents", row.path.slice(13)) : "";
    if (!path || relative(root, realpathSync.native(dirname(path))).startsWith("..") || !existsSync(path)) throw new Error("Legacy backup content verification failed");
    const bytes = readLegacyBackupBytes(path, Math.min(row.bytes + 1, 512 * 1024 * 1024));
    if (bytes.length !== row.bytes || sha(bytes) !== row.sha256) throw new Error("Legacy backup content verification failed");
  }
  if (sha(JSON.stringify(manifest.files.map(row => [row.path, row.sha256]))) !== manifest.sourceFingerprint) throw new Error("Legacy backup fingerprint mismatch");
  return manifest;
}
