import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { verifyOpenedRegularFileSync } from "../fs-read.js";
import { optionalPosixOpenFlag } from "../fs-open-flags.js";
import { HaraStorageQuota, StorageQuotaError } from "../storage/quota.js";
import { assertPrivateStateDirectory, bindPrivateHaraStateFile, readPrivateStateFileSnapshotSync,
  withPrivateStateLockSync, writePrivateStateFileSync, writePrivateStateBytesOnceSync, removePrivateStateFile,
  type PrivateStateFileSnapshot } from "../security/private-state.js";
import { AgentHubError } from "./errors.js";
import { HUB_LIMITS } from "./attachments.js";

const META = /^message-[a-f0-9]{64}\.json$/;
const BLOB = /^(?:body-[a-f0-9]{64}|attachment-[a-f0-9]{64}-[0-3])\.bin$/;
const CONTROL = /^(?:cleanup|reader)-[a-f0-9-]{36}\.json$/;
export interface HubFileSnapshot { dev: number; ino: number; mode: number; nlink: number; size: number; mtimeMs: number; ctimeMs: number }
/** All mutations share the home-wide quota lock before the per-scope state lock. */
export class AgentHubPrivateStore {
  private readonly namespace: readonly string[];
  constructor(private readonly home: string, scopeKey: string, readonly globalQuota: HaraStorageQuota) {
    if (!/^[a-f0-9]{64}$/.test(scopeKey)) throw new AgentHubError("invalid_request");
    globalQuota.assertHome(home); this.namespace = ["agent-hub", scopeKey];
  }
  private binding(filename: string) {
    if (filename !== "catalog.json" && !META.test(filename) && !BLOB.test(filename) && !CONTROL.test(filename)) throw new AgentHubError("store_unavailable");
    return bindPrivateHaraStateFile(this.home, this.namespace, filename);
  }
  transaction<T>(fn: () => T): T {
    try { return this.globalQuota.run(() => withPrivateStateLockSync(this.home, this.namespace, "hub", fn, { attempts: 10, waitMs: 5 })); }
    catch (error) {
      if (error instanceof AgentHubError) throw error;
      throw new AgentHubError(error instanceof StorageQuotaError && error.code === "quota_exceeded" ? "quota_exceeded" : "store_unavailable");
    }
  }
  names(): string[] {
    const bound = this.binding("catalog.json"); assertPrivateStateDirectory(bound.directory);
    const names = readdirSync(bound.directory.path);
    if (names.length > HUB_LIMITS.messages * 7 + 512) throw new AgentHubError("quota_exceeded");
    assertPrivateStateDirectory(bound.directory); return names;
  }
  read(filename: string): string | null {
    if (BLOB.test(filename)) throw new AgentHubError("store_unavailable");
    const bound = this.binding(filename); assertPrivateStateDirectory(bound.directory);
    return readPrivateStateFileSnapshotSync(bound.path, filename === "catalog.json" ? HUB_LIMITS.catalogBytes : HUB_LIMITS.metadataBytes)?.text ?? null;
  }
  write(filename: string, text: string, expectedText: string | null, assertCurrent?: () => void, control = false): void {
    if (BLOB.test(filename) || Buffer.byteLength(text) > (filename === "catalog.json" ? HUB_LIMITS.catalogBytes : HUB_LIMITS.metadataBytes)) throw new AgentHubError("quota_exceeded");
    const bound = this.binding(filename);
    if (control && filename === "catalog.json") {
      if (expectedText === null) throw new AgentHubError("store_unavailable");
      this.globalQuota.admitControlReplacement(Buffer.byteLength(text), Buffer.byteLength(expectedText));
    } else this.globalQuota.admitGrowth(Buffer.byteLength(text), control);
    writePrivateStateFileSync(bound, text, { ...(expectedText === null ? { expectedMissing: true } : { expectedText }), assertCurrent: () => {
      assertCurrent?.(); this.globalQuota.admitGrowth(0, control);
    } });
  }
  private opened<T>(filename: string, action: (fd: number, info: HubFileSnapshot) => T): T {
    const bound = this.binding(filename); assertPrivateStateDirectory(bound.directory);
    const fd = openSync(bound.path, constants.O_RDONLY | optionalPosixOpenFlag("O_NOFOLLOW") | optionalPosixOpenFlag("O_NONBLOCK"));
    try {
      const before = fstatSync(fd);
      verifyOpenedRegularFileSync(bound.path, before, { protectSensitive: false, rejectHardLinks: true, expectedCanonicalPath: bound.path });
      if (process.platform !== "win32" && (before.uid !== process.getuid?.() || (before.mode & 0o777) !== 0o600)) throw new AgentHubError("store_unavailable");
      const info = { dev: before.dev, ino: before.ino, mode: before.mode & 0o777, nlink: before.nlink, size: before.size, mtimeMs: before.mtimeMs, ctimeMs: before.ctimeMs };
      const result = action(fd, info), after = fstatSync(fd);
      verifyOpenedRegularFileSync(bound.path, after, { protectSensitive: false, rejectHardLinks: true, expectedCanonicalPath: bound.path });
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new AgentHubError("store_unavailable");
      assertPrivateStateDirectory(bound.directory); return result;
    } finally { closeSync(fd); }
  }
  inspect(filename: string): HubFileSnapshot | null {
    try { return this.opened(filename, (_fd, info) => info); }
    catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null; throw error; }
  }
  readChunk(filename: string, offset: number, length: number, expectedSize: number): Buffer {
    if (!BLOB.test(filename) || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > HUB_LIMITS.chunkBytes) throw new AgentHubError("invalid_request");
    return this.opened(filename, (fd, info) => {
      if (info.size !== expectedSize || offset > info.size) throw new AgentHubError("store_unavailable");
      const bytes = Buffer.alloc(Math.min(length, info.size - offset));
      for (let at = 0; at < bytes.length;) { const read = readSync(fd, bytes, at, bytes.length - at, offset + at); if (!read) throw new AgentHubError("store_unavailable"); at += read; }
      return bytes;
    });
  }
  writeBlob(filename: string, bytes: Buffer, digest: string, assertCurrent: () => void): void {
    if (!BLOB.test(filename) || bytes.length > HUB_LIMITS.fileBytes) throw new AgentHubError("quota_exceeded");
    const existing = this.inspect(filename);
    if (existing) {
      if (existing.size !== bytes.length) throw new AgentHubError("conflict");
      const hash = createHash("sha256");
      for (let at = 0; at < existing.size; at += HUB_LIMITS.chunkBytes) hash.update(this.readChunk(filename, at, HUB_LIMITS.chunkBytes, existing.size));
      if (hash.digest("hex") !== digest) throw new AgentHubError("conflict");
      return;
    }
    this.globalQuota.admitGrowth(bytes.length); const bound = this.binding(filename);
    writePrivateStateBytesOnceSync(bound, bytes, { assertCurrent: () => { assertCurrent(); this.globalQuota.admitGrowth(0); } });
  }
  remove(filename: string, expected: HubFileSnapshot): void {
    const bound = this.binding(filename); assertPrivateStateDirectory(bound.directory);
    removePrivateStateFile(bound.path, { ...expected, text: "" } satisfies PrivateStateFileSnapshot, bound.directory);
  }
  usage(): { bytes: number; messages: number } {
    const bound = this.binding("catalog.json"), lock = lstatSync(join(bound.directory.path, "hub.lock"));
    let bytes = 0, messages = 0;
    for (const name of this.names()) {
      const info = lstatSync(join(bound.directory.path, name));
      const ownedLockAlias = info.nlink === 2 && info.dev === lock.dev && info.ino === lock.ino
        && (name === "hub.lock" || /^\.hara-lock-[A-Za-z0-9-]+\.tmp$/.test(name));
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 && !ownedLockAlias
        || process.platform !== "win32" && (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)) throw new AgentHubError("store_unavailable");
      bytes += info.size;
      if (META.test(name)) messages++;
      else if (name !== "catalog.json" && !BLOB.test(name) && !CONTROL.test(name) && !/^hub\.lock(?:\.|$)/.test(name)
        && !/^\.hara-(?:private|lock|claim)-/.test(name)) throw new AgentHubError("store_unavailable");
    }
    assertPrivateStateDirectory(bound.directory); return { bytes, messages };
  }
}
