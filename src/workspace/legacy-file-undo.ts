import { createHash } from "node:crypto";
import { join } from "node:path";
import { removePrivateStateFile, writePrivateStateFileSync } from "../security/private-state.js";
import { redactSensitiveText } from "../security/secrets.js";
import { WorkspaceJsonState, plain } from "./local-state.js";
import { inspectWorkspaceResourceFile, sameWorkspaceResourceBinding, workspaceResourceCommitGuard, workspaceStateHome,
  type WorkspaceResourceBinding, type WorkspaceResourceStorage } from "./resource-context.js";
import { LEGACY_DOMAINS, type LegacyDomainId } from "./legacy-coordinator.js";
import { observePrivateStateWrites } from "../security/private-write-observer.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const validHash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const validPath = (value: unknown): value is string => typeof value === "string" && value.length <= 512 && value.startsWith(".hara/")
  && value.split("/").slice(1).every(part => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(part)) && !value.includes("workspace-legacy-undo-");
interface Image { path: string; before: string | null; beforeHash: string | null; afterHash: string | null; restored: boolean; written?: boolean; pendingAfterHash?: string | null; retainedAudit?: boolean }
interface State { revision: number; resourceBinding: WorkspaceResourceBinding; sourceFingerprint: string; round: number;
  status: "open" | "applied" | "rolling_back" | "rolled_back"; files: Image[] }
/** Owner-supplied explicit output set. No arbitrary RPC paths; no raw credentials in undo files.
 * Captures BEFORE any domain mutation, compares postimages before rollback, and journals each restore. */
export class LegacyScopedFileUndo {
  private readonly state: WorkspaceJsonState<State>;
  private readonly filename: string;
  constructor(private readonly storage: WorkspaceResourceStorage, domain: LegacyDomainId, private readonly sourceFingerprint: string) {
    if (!LEGACY_DOMAINS.includes(domain) || !validHash(sourceFingerprint)) throw new Error("Invalid legacy file undo scope");
    this.filename = `workspace-legacy-undo-${domain}.json`;
    this.state = new WorkspaceJsonState(storage, this.filename, raw => {
      if (!plain(raw) || !sameWorkspaceResourceBinding(raw.resourceBinding as WorkspaceResourceBinding, this.state.binding()) || raw.sourceFingerprint !== sourceFingerprint
        || !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 1 || !Number.isSafeInteger(raw.round) || Number(raw.round) < 1
        || !["open", "applied", "rolling_back", "rolled_back"].includes(String(raw.status)) || !Array.isArray(raw.files) || raw.files.length > 8192
        || new Set(raw.files.map(row => plain(row) ? row.path : null)).size !== raw.files.length) throw new Error("Invalid inheritance undo journal; nothing restored");
      for (const row of raw.files) if (!plain(row) || !validPath(row.path) || !(row.before === null || typeof row.before === "string" && Buffer.byteLength(row.before) <= 4 * 1024 * 1024)
        || row.beforeHash !== (row.before === null ? null : hash(row.before as string)) || !(row.afterHash === null || validHash(row.afterHash)) || typeof row.restored !== "boolean"
        || row.written !== undefined && typeof row.written !== "boolean" || row.pendingAfterHash !== undefined && row.pendingAfterHash !== null && !validHash(row.pendingAfterHash)
        || row.retainedAudit !== undefined && typeof row.retainedAudit !== "boolean") throw new Error("Invalid inherited file image");
      return structuredClone(raw) as unknown as State;
    }, () => ({ revision: 0, resourceBinding: this.state.binding(), sourceFingerprint, round: 0, status: "rolled_back", files: [] }));
  }
  read() { return this.state.read(); }
  private image(path: string) { return this.storage.run(() => {
    if (!validPath(path)) throw new Error("Invalid owner-supplied inheritance output path");
    const file = inspectWorkspaceResourceFile(join(workspaceStateHome(), path), 4 * 1024 * 1024);
    return { file, text: file.snapshot?.text ?? null, hash: file.snapshot ? hash(file.snapshot.text) : null };
  }); }
  begin(paths: readonly string[], retainedAudits: readonly string[] = []) {
    const before = this.read(), names = [...new Set(paths)].sort();
    if (names.length !== paths.length || names.some(path => !validPath(path)) || names.length > 8192
      || retainedAudits.some(path => !names.includes(path))) throw new Error("Invalid inheritance output set");
    if (before.revision && before.status !== "rolled_back") {
      if (JSON.stringify(before.files.map(row => row.path)) !== JSON.stringify(names)
        || before.files.some(row => Boolean(row.retainedAudit) !== retainedAudits.includes(row.path))) throw new Error("Inheritance output set changed; preserve the old undo journal");
      return before;
    }
    const files = names.map(path => { const image = this.image(path);
      if (image.text && redactSensitiveText(image.text).redactions.length) throw new Error("Existing output requires secure migration before inheritance; no credential undo copy written");
      return { path, before: image.text, beforeHash: image.hash, afterHash: null, restored: false, written: false, pendingAfterHash: null, retainedAudit: retainedAudits.includes(path) };
    });
    return this.state.update(before.revision, old => ({ ...old, files, round: old.round + 1, status: "open" }));
  }
  /** Every domain write must use the CAS private writer. The expected chain is captured from OUR
   * write payloads, not a late filesystem scan that could accidentally adopt a concurrent user edit. */
  async runImport<T>(action: () => T | Promise<T>): Promise<T> {
    let before = this.read(); if (before.status !== "open") throw new Error("An open inheritance intent is required");
    for (const row of before.files) if (row.pendingAfterHash) {
      const actual = this.image(row.path).hash, previous = row.written ? row.afterHash : row.beforeHash;
      if (actual !== previous && actual !== row.pendingAfterHash) throw new Error("Unknown partial import image; preserve it for reconciliation");
      before = this.state.update(before.revision, old => ({ ...old, files: old.files.map(file => file.path === row.path ? {
        ...file, ...(actual === row.pendingAfterHash ? { afterHash: actual, written: true } : {}), pendingAfterHash: null } : file) }));
    }
    const home = this.storage.run(() => workspaceStateHome()), journal = join(home, ".hara", this.filename);
    const paths = new Map(before.files.map(row => [join(home, row.path), row.path]));
    const expected = new Map(before.files.map(row => [join(home, row.path), row.written ? row.afterHash : row.beforeHash]));
    for (const row of before.files) if (this.image(row.path).hash !== expected.get(join(home, row.path))) throw new Error("A newer edit appeared before import; source and user data preserved");
    const update = (path: string, change: (row: Image) => Image) => {
      const current = this.read(); this.state.update(current.revision, old => ({ ...old, files: old.files.map(row => row.path === paths.get(path) ? change(row) : row) }));
    };
    let active = true, result: T;
    try {
      result = await observePrivateStateWrites({
        checkPath(path) { if (!active || path !== journal && !paths.has(path)) throw new Error("Unplanned inheritance write refused before mutation"); },
        before(path, previousHash, nextHash) {
          if (path === journal) return;
          if (previousHash !== expected.get(path)) throw new Error("Concurrent user edit refused before inheritance write");
          update(path, row => ({ ...row, pendingAfterHash: nextHash }));
        },
        committed(path, nextHash) { if (path === journal) return; expected.set(path, nextHash); update(path, row => ({ ...row, afterHash: nextHash, pendingAfterHash: null, written: true })); },
      }, action);
    } finally { active = false; }
    for (const row of before.files) if (this.image(row.path).hash !== expected.get(join(home, row.path))) throw new Error("A concurrent edit was preserved; import cannot claim its postimage");
    const current = this.read(); this.state.update(current.revision, old => ({ ...old, status: "applied",
      files: old.files.map(row => ({ ...row, afterHash: expected.get(join(home, row.path)) ?? null })) }));
    return result;
  }
  preflightRollback() {
    const current = this.read(); if (current.status === "rolled_back") return;
    if (current.status === "open") throw new Error("Incomplete inheritance domain; resume its import before rollback");
    for (const row of current.files) if (!row.restored) {
      const actual = this.image(row.path).hash;
      if (actual !== row.afterHash && !(current.status === "rolling_back" && actual === row.beforeHash)) throw new Error("A newer file edit was preserved; inheritance rollback requires reconciliation");
    }
  }
  /** Retained credential-reference audit is needed to retry cleanup after metadata rollback/crash.
   * It contains no key values and cannot be trusted after even a single unexpected byte changes. */
  retainedAuditText(path: string): string {
    const row = this.read().files.find(row => row.path === path && row.retainedAudit);
    const image = this.image(path); if (!row || !row.afterHash || image.hash !== row.afterHash || image.text === null) throw new Error("Inheritance cleanup audit changed; no credentials removed");
    return image.text;
  }
  rollback() {
    this.preflightRollback(); let current = this.read(); if (current.status === "rolled_back") return current;
    if (current.status !== "rolling_back") current = this.state.update(current.revision, value => ({ ...value, status: "rolling_back" }));
    for (const row of current.files) {
      if (row.restored) continue;
      if (!row.retainedAudit) this.storage.run(() => {
        const image = this.image(row.path);
        // Crash between a restore and its receipt publication: matching the exact preimage is
        // already restored, not permission to overwrite a different/newer edit.
        if (image.hash === row.beforeHash) return;
        if (image.hash !== row.afterHash) throw new Error("Inherited file changed during rollback; partial journal preserved");
        image.file.assertCurrent();
        if (row.before === null) { if (image.file.snapshot) removePrivateStateFile(image.file.path, image.file.snapshot, image.file.directory); }
        else writePrivateStateFileSync(image.file, row.before, { ...(image.file.snapshot ? { expectedText: image.file.snapshot.text } : { expectedMissing: true }), assertCurrent: workspaceResourceCommitGuard() });
      });
      current = this.state.update(current.revision, value => ({ ...value, files: value.files.map(file => file.path === row.path ? { ...file, restored: true } : file) }));
    }
    return this.state.update(current.revision, value => ({ ...value, status: "rolled_back" }));
  }
}
