// Host-owned review library. Code approval is separate from Workspace/agent grants.
import { join } from "node:path";
import { bindPrivateHaraStateFile, readPrivateStateFileSnapshotSync, withPrivateStateLockSync, writePrivateStateFileSync } from "../security/private-state.js";
import { extensionDigest, type ExtensionSourceDescriptor } from "./extension-catalog.js";
import { assertWorkspaceMcpReviewCurrent, parseWorkspaceMcpReviewLibrary, restoreWorkspaceMcpReview, type McpReviewRecord, type ReviewedMcpSource, type WorkspaceMcpReviewLibraryState } from "./extension-review.js";

export class McpOwnerReviewError extends Error {
  constructor(readonly code: "owner_required" | "view_changed" | "review_changed" | "library_read_only" | "unsupported_platform" | "unsupported_transport" | "credentials_unsupported" | "unsupported_command" | "package_unavailable" | "proxy_unavailable" | "inspection_failed" | "schema_unsupported" | "drain_unknown") { super(code); this.name = "McpOwnerReviewError"; }
}
const empty = (): WorkspaceMcpReviewLibraryState => ({ schemaVersion: 1, revision: 0, records: [], invalidated: {} });
export class WorkspaceMcpReviewLibrary {
  private readonly cache = new Map<string, ReviewedMcpSource>();
  private readonly stale = new Map<string, string>();
  constructor(readonly home: string, private readonly changed: () => void) {}
  private snapshot(backup = false) {
    return readPrivateStateFileSnapshotSync(join(this.home, ".hara", backup ? "mcp-reviewed-v1-backup.json" : "mcp-reviewed-v1.json"), 1024 * 1024);
  }
  read() {
    try {
      const snapshot = this.snapshot();
      if (!snapshot) return { value: empty(), readOnly: !!this.snapshot(true), snapshot: null };
      return { value: parseWorkspaceMcpReviewLibrary(JSON.parse(snapshot.text)), readOnly: false, snapshot };
    } catch { return { value: empty(), readOnly: true, snapshot: null }; }
  }
  private update(expected: number, change: (state: WorkspaceMcpReviewLibraryState) => void, assertCurrent: () => void) {
    const result = withPrivateStateLockSync(this.home, [], "mcp-reviewed-v1", () => {
      assertCurrent(); const before = this.read();
      if (before.readOnly) throw new McpOwnerReviewError("library_read_only");
      if (before.value.revision !== expected) throw new McpOwnerReviewError("review_changed");
      const value = structuredClone(before.value); change(value); value.revision++;
      const next = parseWorkspaceMcpReviewLibrary(value), text = JSON.stringify(next) + "\n";
      if (Buffer.byteLength(text) > 1024 * 1024) throw new McpOwnerReviewError("library_read_only");
      const file = bindPrivateHaraStateFile(this.home, [], "mcp-reviewed-v1.json"), backup = bindPrivateHaraStateFile(this.home, [], "mcp-reviewed-v1-backup.json");
      const oldBackup = this.snapshot(true);
      writePrivateStateFileSync(backup, before.snapshot?.text ?? JSON.stringify(before.value) + "\n", {
        ...(oldBackup ? { expectedText: oldBackup.text } : { expectedMissing: true }), assertCurrent });
      writePrivateStateFileSync(file, text, { ...(before.snapshot ? { expectedText: before.snapshot.text } : { expectedMissing: true }), assertCurrent });
      const interimBackup = this.snapshot(true)!;
      // Recovery must never resurrect a revoked source.
      writePrivateStateFileSync(backup, text, { expectedText: interimBackup.text, assertCurrent });
      return next;
    });
    this.changed(); return result;
  }
  approve(record: McpReviewRecord, expected: number, assertCurrent: () => void) {
    const reviewed = restoreWorkspaceMcpReview(record);
    const fence = () => { assertCurrent(); assertWorkspaceMcpReviewCurrent(reviewed); };
    const value = this.update(expected, state => {
      state.records = [...state.records.filter(row => row.source.sourceId !== record.source.sourceId), structuredClone(record)];
      delete state.invalidated[record.source.sourceId];
    }, fence);
    this.stale.delete(record.source.sourceId); return value;
  }
  revoke(sourceId: string, expected: number, assertCurrent: () => void) {
    const value = this.update(expected, state => {
      state.records = state.records.filter(row => row.source.sourceId !== sourceId); delete state.invalidated[sourceId];
    }, assertCurrent);
    this.stale.delete(sourceId); return value;
  }
  valid(candidates: readonly ExtensionSourceDescriptor[]): ReviewedMcpSource[] {
    const state = this.read(); if (state.readOnly) return [];
    const originals = new Map(candidates.map(source => [source.sourceId, extensionDigest(source)]));
    const retained = new Set(state.value.records.map(extensionDigest));
    for (const key of this.cache.keys()) if (!retained.has(key)) this.cache.delete(key);
    const result: ReviewedMcpSource[] = [];
    for (const record of state.value.records) {
      const hash = extensionDigest(record), sourceId = record.source.sourceId;
      if (originals.get(sourceId) !== extensionDigest(record.source) || state.value.invalidated[sourceId] === hash || this.stale.get(sourceId) === hash) continue;
      try {
        let source = this.cache.get(hash);
        if (!source) { source = restoreWorkspaceMcpReview(record); this.cache.set(hash, source); }
        assertWorkspaceMcpReviewCurrent(source); result.push(source);
      } catch { /* Changed code is unavailable; only the owner can approve its new digest. */ }
    }
    return result;
  }
  /** Permission removal only. Callers provide a Host-captured revision, never upstream arguments. */
  invalidate(sourceId: string, revision: string) {
    const state = this.read(); if (state.readOnly) return;
    const record = state.value.records.find(row => row.source.sourceId === sourceId); if (!record) return;
    const hash = extensionDigest(record), source = this.cache.get(hash);
    if (!source || source.descriptor.sourceRevision !== revision) return; // late old notification
    this.stale.set(sourceId, hash);
    try {
      this.update(state.value.revision, next => {
        const current = next.records.find(row => row.source.sourceId === sourceId);
        if (!current || extensionDigest(current) !== hash) throw new McpOwnerReviewError("review_changed");
        next.invalidated[sourceId] = hash;
      }, () => {});
    } catch { this.changed(); } // memory remains fail-closed if a concurrent write prevents persistence
  }
}
