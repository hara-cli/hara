import { randomUUID } from "node:crypto";
import { AgentHubError, exact, hubAssert, plain } from "./errors.js";
import type { AgentHubPrivateStore, HubFileSnapshot } from "./private-store.js";

export const HUB_READER_LEASE_MS = 30_000;
interface ReaderLease {
  schemaVersion: 2; fileId: string; readerId: string; createdAt: string; renewedAt: string; expiresAt: string;
}
export interface HubReaderHandle { name: string; value: ReaderLease; snapshot: HubFileSnapshot }
const names = (disk: AgentHubPrivateStore) => {
  const result = disk.names().filter(name => /^reader-[a-f0-9-]{36}\.json$/.test(name));
  hubAssert(result.length <= 64, "store_unavailable"); return result;
};
const same = (left: HubFileSnapshot, right: HubFileSnapshot) => JSON.stringify(left) === JSON.stringify(right);
function read(disk: AgentHubPrivateStore, name: string) {
  const snapshot = disk.inspect(name), text = disk.read(name); hubAssert(snapshot && text !== null, "store_unavailable");
  let value: unknown; try { value = JSON.parse(text); } catch { throw new AgentHubError("store_unavailable"); }
  hubAssert(plain(value) && typeof value.fileId === "string" && /^attachment-[a-f0-9]{64}-[0-3]\.bin$/.test(value.fileId)
    && value.readerId === name, "store_unavailable");
  if (value.schemaVersion === 1) {
    // Pre-enable schema-1 records get a finite upgrade grace from their verified inode mtime.
    // The Host drains the old Core before admitting the new protocol; new readers always use v2.
    hubAssert(exact(value, ["schemaVersion", "fileId", "readerId"]), "store_unavailable");
    return { snapshot, text, fileId: value.fileId, expires: snapshot.mtimeMs + HUB_READER_LEASE_MS, value: null };
  }
  hubAssert(value.schemaVersion === 2 && exact(value, ["schemaVersion", "fileId", "readerId", "createdAt", "renewedAt", "expiresAt"])
    && [value.createdAt, value.renewedAt, value.expiresAt].every(part => typeof part === "string"
      && Number.isFinite(Date.parse(part)) && new Date(part).toISOString() === part), "store_unavailable");
  const lease = value as unknown as ReaderLease;
  hubAssert(Date.parse(lease.createdAt) <= Date.parse(lease.renewedAt)
    && Date.parse(lease.expiresAt) - Date.parse(lease.renewedAt) === HUB_READER_LEASE_MS, "store_unavailable");
  return { snapshot, text, fileId: lease.fileId, expires: Date.parse(lease.expiresAt), value: lease };
}
/** Retire only exact, valid expired control records. Malformed/unknown references remain protected.
 * No payload is removed here. Cleanup still requires its own native confirmation and reference check. */
export function activeHubReadFiles(disk: AgentHubPrivateStore, now: Date): Set<string> {
  const files = new Set<string>(); hubAssert(Number.isFinite(now.getTime()), "store_unavailable");
  for (const name of names(disk)) {
    const lease = read(disk, name);
    if (lease.expires <= now.getTime()) disk.remove(name, lease.snapshot);
    else files.add(lease.fileId);
  }
  return files;
}
export function startHubRead(disk: AgentHubPrivateStore, fileId: string, now: Date, assertCurrent: () => void): HubReaderHandle {
  activeHubReadFiles(disk, now); hubAssert(names(disk).length < 8, "quota_exceeded");
  const name = `reader-${randomUUID()}.json`, at = now.toISOString();
  const value: ReaderLease = { schemaVersion: 2, fileId, readerId: name, createdAt: at, renewedAt: at,
    expiresAt: new Date(now.getTime() + HUB_READER_LEASE_MS).toISOString() };
  disk.write(name, JSON.stringify(value), null, assertCurrent, true);
  const snapshot = disk.inspect(name); hubAssert(snapshot, "store_unavailable"); return { name, value, snapshot };
}
/** Pull-based heartbeat: no timer keeps a dead reader alive. A paused/expired reader must reopen;
 * it never reads another chunk after its protection has expired or has been retired/replaced. */
export function renewHubRead(disk: AgentHubPrivateStore, handle: HubReaderHandle, now: Date, assertCurrent: () => void): void {
  hubAssert(disk.inspect(handle.name), "conflict"); const lease = read(disk, handle.name);
  hubAssert(lease.value && same(lease.snapshot, handle.snapshot) && lease.value.fileId === handle.value.fileId
    && lease.value.createdAt === handle.value.createdAt, "conflict");
  if (lease.expires <= now.getTime()) { disk.remove(handle.name, lease.snapshot); throw new AgentHubError("conflict"); }
  if (lease.expires - now.getTime() > HUB_READER_LEASE_MS / 2) return;
  const next: ReaderLease = { ...lease.value, renewedAt: now.toISOString(), expiresAt: new Date(now.getTime() + HUB_READER_LEASE_MS).toISOString() };
  disk.write(handle.name, JSON.stringify(next), lease.text, () => {
    assertCurrent(); hubAssert(Date.parse(handle.value.expiresAt) > now.getTime(), "conflict");
  }, true);
  const snapshot = disk.inspect(handle.name); hubAssert(snapshot, "store_unavailable"); handle.value = next; handle.snapshot = snapshot;
}
export function releaseHubRead(disk: AgentHubPrivateStore, handle: HubReaderHandle): void {
  const snapshot = disk.inspect(handle.name); if (!snapshot || !same(snapshot, handle.snapshot)) return;
  disk.remove(handle.name, snapshot);
}
