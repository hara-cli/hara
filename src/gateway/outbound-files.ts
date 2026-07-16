// Immutable, owner-only snapshots for files leaving the machine through a gateway adapter. `send_file`
// runs in a child process and the adapter sends later in the daemon; queueing an original pathname would
// leave a TOCTOU window where that pathname could be exchanged for a symlink or a different file.
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  constants,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { openVerifiedRegularFileNoFollow, verifyOpenedRegularFileSync } from "../fs-read.js";
import { optionalPosixOpenFlag } from "../fs-open-flags.js";

export const OUTBOUND_FILE_MAX_BYTES = 20 * 1024 * 1024;
export const OUTBOUND_BATCH_MAX_BYTES = 20 * 1024 * 1024;
export const OUTBOUND_BATCH_MAX_FILES = 4;
const OUTBOX_MAX_BYTES = 256 * 1024;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const OWNED_SNAPSHOT = new RegExp(`^(?:\\.${UUID}\\.part|[a-z0-9][a-z0-9_-]{0,48}-${UUID}(?:\\.[a-z0-9]{1,12})?)$`, "i");
const SNAPSHOT_SUFFIX = new RegExp(`-${UUID}(?=\\.|$)`, "i");

/** Verified bytes handed to adapters. `snapshotPath` is cleanup-only; adapters must never reopen it. */
export interface OutboundFilePayload {
  readonly snapshotPath: string;
  readonly safeName: string;
  readonly bytes: Buffer;
}

interface SnapshotIdentity {
  dev: number;
  ino: number;
}

// Cleanup receives only the cleanup-only path from serve.ts. Remember the identity that produced its payload so
// a later path replacement is never mistaken for the consumed snapshot.
const consumedSnapshotIdentities = new Map<string, SnapshotIdentity>();
const outboundQueueLocks = new Map<string, Promise<void>>();

function throwIfOutboundCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("gateway file queue cancelled before commit");
}

export function outboundSnapshotDir(outbox: string): string {
  return `${resolve(outbox)}.files`;
}

function ownedByProcess(path: string): boolean {
  if (typeof process.getuid !== "function") return true;
  return lstatSync(path).uid === process.getuid();
}

function ensureSnapshotDir(outbox: string): string {
  const dir = outboundSnapshotDir(outbox);
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (error: any) {
    if (error?.code !== "EEXIST") throw error;
  }
  const info = lstatSync(dir);
  if (!info.isDirectory() || info.isSymbolicLink() || !ownedByProcess(dir)) {
    throw new Error(`unsafe gateway snapshot directory: ${dir}`);
  }
  chmodSync(dir, 0o700);
  return dir;
}

function safeExtension(source: string): string {
  const extension = extname(basename(source)).toLowerCase();
  return /^\.[a-z0-9]{1,12}$/.test(extension) ? extension : "";
}

function safeStem(source: string): string {
  const extension = extname(basename(source));
  const raw = basename(source, extension)
    .normalize("NFKD")
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return raw || "attachment";
}

function existingBatchUsage(dir: string): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  for (const name of readdirSync(dir)) {
    if (!OWNED_SNAPSHOT.test(name)) continue;
    const path = join(dir, name);
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1 || !ownedByProcess(path)) {
      throw new Error(`unsafe gateway snapshot entry: ${path}`);
    }
    files++;
    bytes += info.size;
    if (!Number.isSafeInteger(bytes)) throw new Error("gateway send batch size is invalid");
  }
  return { bytes, files };
}

async function appendOutbox(outbox: string, snapshot: string, signal?: AbortSignal): Promise<void> {
  throwIfOutboundCancelled(signal);
  const path = resolve(outbox);
  let before: ReturnType<typeof lstatSync> | undefined;
  try {
    before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink > 1 || !ownedByProcess(path)) {
      throw new Error(`unsafe gateway outbox: ${outbox}`);
    }
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | optionalPosixOpenFlag("O_NOFOLLOW"),
    0o600,
  );
  try {
    const info = await handle.stat();
    const current = lstatSync(path);
    if (
      !info.isFile()
      || info.nlink > 1
      || current.isSymbolicLink()
      || current.dev !== info.dev
      || current.ino !== info.ino
      || (before && (before.dev !== info.dev || before.ino !== info.ino))
      || !ownedByProcess(path)
    ) throw new Error(`unsafe gateway outbox: ${outbox}`);
    await handle.chmod(0o600);
    // This append makes the snapshot visible to the adapter. Re-check after all descriptor validation and
    // immediately before that irreversible queue mutation.
    throwIfOutboundCancelled(signal);
    await handle.writeFile(snapshot + "\n", "utf8");
    await handle.sync();
  } finally {
    await handle.close().catch(() => {});
  }
}

/** Copy a verified source fd to a private immutable snapshot, then append only that snapshot to the queue. */
async function queueOutboundSnapshotLocked(sourcePath: string, outbox: string, signal?: AbortSignal): Promise<string> {
  throwIfOutboundCancelled(signal);
  const source = resolve(sourcePath);
  const verified = await openVerifiedRegularFileNoFollow(source, {
    action: "send",
    rejectHardLinks: true,
    protectSensitive: true,
  });
  let destination: Awaited<ReturnType<typeof open>> | undefined;
  let temporary: string | undefined;
  let snapshot: string | undefined;
  let published = false;
  try {
    if (verified.info.size > OUTBOUND_FILE_MAX_BYTES) {
      throw new Error(`file exceeds the ${OUTBOUND_FILE_MAX_BYTES}-byte gateway send limit`);
    }
    const dir = ensureSnapshotDir(outbox);
    const usage = existingBatchUsage(dir);
    if (usage.files >= OUTBOUND_BATCH_MAX_FILES) {
      throw new Error(`gateway send batch exceeds the ${OUTBOUND_BATCH_MAX_FILES}-file limit`);
    }
    if (verified.info.size > OUTBOUND_BATCH_MAX_BYTES - usage.bytes) {
      throw new Error(`gateway send batch exceeds the ${OUTBOUND_BATCH_MAX_BYTES}-byte limit`);
    }
    const id = randomUUID();
    temporary = join(dir, `.${id}.part`);
    // Keep a recognizable, sanitized stem for a friendlier attachment name while the UUID preserves uniqueness.
    snapshot = join(dir, `${safeStem(source)}-${id}${safeExtension(source)}`);
    destination = await open(temporary, "wx", 0o600);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < verified.info.size) {
      throwIfOutboundCancelled(signal);
      const want = Math.min(buffer.length, verified.info.size - position);
      const { bytesRead } = await verified.handle.read(buffer, 0, want, position);
      if (bytesRead <= 0) throw new Error(`source changed while snapshotting ${source}`);
      let written = 0;
      while (written < bytesRead) {
        const result = await destination.write(buffer, written, bytesRead - written, position + written);
        if (result.bytesWritten <= 0) throw new Error("failed to write gateway snapshot");
        written += result.bytesWritten;
      }
      position += bytesRead;
    }

    const latest = await verified.handle.stat();
    verifyOpenedRegularFileSync(source, latest, {
      action: "send",
      rejectHardLinks: true,
      protectSensitive: true,
    });
    if (
      latest.dev !== verified.info.dev
      || latest.ino !== verified.info.ino
      || latest.size !== verified.info.size
      || latest.mtimeMs !== verified.info.mtimeMs
      || latest.ctimeMs !== verified.info.ctimeMs
    ) throw new Error(`source changed while snapshotting ${source}`);

    await destination.sync();
    await destination.chmod(0o600);
    await destination.close();
    destination = undefined;
    // Publishing the private snapshot is reversible until appendOutbox succeeds; cancellation after this
    // check is caught below and removes the published inode before returning.
    throwIfOutboundCancelled(signal);
    renameSync(temporary, snapshot);
    published = true;
    await appendOutbox(outbox, snapshot, signal);
    return snapshot;
  } catch (error) {
    if (published && snapshot) {
      try { unlinkSync(snapshot); } catch { /* best-effort cleanup */ }
    }
    if (temporary) {
      try { unlinkSync(temporary); } catch { /* best-effort cleanup */ }
    }
    throw error;
  } finally {
    await destination?.close().catch(() => {});
    await verified.handle.close().catch(() => {});
  }
}

/** Serialize admissions for one outbox so parallel send_file calls cannot race past the aggregate budget. */
export async function queueOutboundSnapshot(sourcePath: string, outbox: string, signal?: AbortSignal): Promise<string> {
  const key = resolve(outbox);
  const previous = outboundQueueLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  const current = previous.then(() => gate, () => gate);
  outboundQueueLocks.set(key, current);
  try {
    await previous.catch(() => {});
    throwIfOutboundCancelled(signal);
    return await queueOutboundSnapshotLocked(sourcePath, outbox, signal);
  } finally {
    release();
    if (outboundQueueLocks.get(key) === current) outboundQueueLocks.delete(key);
  }
}

async function readOutbox(outbox: string): Promise<string[]> {
  let verified: Awaited<ReturnType<typeof openVerifiedRegularFileNoFollow>> | undefined;
  try {
    verified = await openVerifiedRegularFileNoFollow(resolve(outbox), {
      action: "read gateway outbox",
      rejectHardLinks: true,
      protectSensitive: false,
    });
    if (verified.info.size > OUTBOX_MAX_BYTES) throw new Error("gateway outbox is too large");
    const bytes = Buffer.alloc(verified.info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await verified.handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return bytes.subarray(0, offset).toString("utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  } finally {
    await verified?.handle.close().catch(() => {});
    try {
      const current = lstatSync(resolve(outbox));
      if (verified && !current.isSymbolicLink() && current.dev === verified.info.dev && current.ino === verified.info.ino) {
        unlinkSync(resolve(outbox));
      }
    } catch { /* missing or replaced outbox is left alone */ }
  }
}

function attachmentName(snapshotPath: string): string {
  return basename(snapshotPath).replace(SNAPSHOT_SUFFIX, "") || "attachment";
}

/**
 * Drain an outbox and materialize only verified snapshots owned by this queue. The returned bytes are the
 * security boundary: adapters never reopen `snapshotPath`, so replacing it after this function returns cannot
 * alter or disclose what is uploaded. Per-file, batch-byte, and file-count caps bound the in-memory payload.
 */
export async function consumeOutboundSnapshots(outbox: string): Promise<OutboundFilePayload[]> {
  const dir = outboundSnapshotDir(outbox);
  const queued = await readOutbox(outbox); // always drain/unlink the outbox, even if its snapshot dir is absent
  let dirReal: string;
  try {
    const info = lstatSync(dir);
    if (!info.isDirectory() || info.isSymbolicLink() || !ownedByProcess(dir)) return [];
    dirReal = realpathSync.native(dir);
  } catch {
    return [];
  }
  const accepted: OutboundFilePayload[] = [];
  let acceptedBytes = 0;
  for (const raw of queued) {
    if (accepted.length >= OUTBOUND_BATCH_MAX_FILES || acceptedBytes >= OUTBOUND_BATCH_MAX_BYTES) break;
    const candidate = resolve(raw);
    if (dirname(candidate) !== dir || !OWNED_SNAPSHOT.test(basename(candidate))) continue;
    let verified: Awaited<ReturnType<typeof openVerifiedRegularFileNoFollow>> | undefined;
    try {
      verified = await openVerifiedRegularFileNoFollow(candidate, {
        action: "send gateway snapshot",
        rejectHardLinks: true,
        protectSensitive: false,
      });
      if (
        dirname(verified.canonicalPath) !== dirReal
        || verified.info.size > OUTBOUND_FILE_MAX_BYTES
        || verified.info.size > OUTBOUND_BATCH_MAX_BYTES - acceptedBytes
        || !ownedByProcess(candidate)
      ) continue;
      const bytes = Buffer.allocUnsafe(verified.info.size);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await verified.handle.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (offset !== bytes.length) continue;
      const latest = await verified.handle.stat();
      verifyOpenedRegularFileSync(candidate, latest, {
        action: "send gateway snapshot",
        rejectHardLinks: true,
        protectSensitive: false,
      });
      if (
        latest.dev !== verified.info.dev
        || latest.ino !== verified.info.ino
        || latest.size !== verified.info.size
        || latest.mtimeMs !== verified.info.mtimeMs
        || latest.ctimeMs !== verified.info.ctimeMs
      ) continue;
      consumedSnapshotIdentities.set(candidate, { dev: latest.dev, ino: latest.ino });
      accepted.push({ snapshotPath: candidate, safeName: attachmentName(candidate), bytes });
      acceptedBytes += bytes.length;
    } catch {
      /* malformed/replaced queue entry is never delivered */
    } finally {
      await verified?.handle.close().catch(() => {});
    }
  }
  return accepted;
}

/** Remove only files in this queue's private snapshot directory, never arbitrary outbox entries. */
export function cleanupOutboundSnapshots(outbox: string, preserve: readonly string[] = []): void {
  const dir = outboundSnapshotDir(outbox);
  const keep = new Set(preserve.map((path) => resolve(path)));
  try {
    const info = lstatSync(dir);
    if (!info.isDirectory() || info.isSymbolicLink() || !ownedByProcess(dir)) return;
    for (const name of readdirSync(dir)) {
      if (!OWNED_SNAPSHOT.test(name)) continue;
      const path = join(dir, name);
      if (keep.has(resolve(path))) continue;
      try {
        const entry = lstatSync(path);
        if ((entry.isFile() || entry.isSymbolicLink()) && ownedByProcess(path)) unlinkSync(path);
      } catch {
        /* raced cleanup is harmless */
      }
    }
    rmdirSync(dir);
  } catch {
    /* best-effort cleanup */
  }
}

/** Delete one previously verified delivered snapshot and remove its now-empty queue directory. */
export function cleanupOutboundSnapshot(path: string): void {
  const candidate = resolve(path);
  const expected = consumedSnapshotIdentities.get(candidate);
  consumedSnapshotIdentities.delete(candidate);
  const dir = dirname(candidate);
  if (!dir.endsWith(".files") || !OWNED_SNAPSHOT.test(basename(candidate))) return;
  try {
    const parent = lstatSync(dir);
    if (!parent.isDirectory() || parent.isSymbolicLink() || !ownedByProcess(dir)) return;
    const entry = lstatSync(candidate);
    if (
      expected
      && entry.isFile()
      && !entry.isSymbolicLink()
      && entry.nlink === 1
      && entry.dev === expected.dev
      && entry.ino === expected.ino
      && ownedByProcess(candidate)
    ) unlinkSync(candidate);
    if (readdirSync(dir).length === 0) rmdirSync(dir);
  } catch {
    /* already removed or raced cleanup */
  }
}
