import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import type { NeutralMsg } from "../providers/types.js";
import type { WorkspaceRunBinding } from "../workspace/run-binding.js";
import type { WorkspaceResourceStorage } from "../workspace/resource-context.js";
import { WorkspaceJsonState, UUID, canonical, exact, plain } from "../workspace/local-state.js";

interface SessionReceipt {
  schemaVersion: 2; bindingDigest: string; root: string; dev: string; ino: string;
  state: "prepared" | "accepted" | "idle"; sessionFile: string | null; fileDigest: string | null;
  historyCount: number; historyDigest: string;
  contextGeneration: string | null; standingPromptHash: string | null;
}
interface SessionState { revision: number; receipt: SessionReceipt | null }
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const below = (root: string, path: string) => { const tail = relative(root, path); return tail !== ".." && !tail.startsWith("../") && !isAbsolute(tail); };
function invalid(): never { throw new Error("Pi native session recovery requires explicit review; no prompt was replayed"); }
function parse(value: unknown): SessionState {
  if (!plain(value) || !exact(value, ["revision", "receipt"]) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0) return invalid();
  const row = value.receipt;
  if (row !== null && (!plain(row) || ![1, 2].includes(Number(row.schemaVersion)) || !exact(row, ["schemaVersion", "bindingDigest", "root", "dev", "ino", "state", "sessionFile", "fileDigest", "historyCount", "historyDigest",
    ...(row.schemaVersion === 2 ? ["contextGeneration", "standingPromptHash"] : [])])
    || typeof row.bindingDigest !== "string" || !/^[a-f0-9]{64}$/.test(row.bindingDigest)
    || typeof row.root !== "string" || !isAbsolute(row.root) || typeof row.dev !== "string" || !/^\d+$/.test(row.dev)
    || typeof row.ino !== "string" || !/^\d+$/.test(row.ino) || !["prepared", "accepted", "idle"].includes(String(row.state))
    || !(row.sessionFile === null || typeof row.sessionFile === "string" && isAbsolute(row.sessionFile))
    || !(row.fileDigest === null || typeof row.fileDigest === "string" && /^[a-f0-9]{64}$/.test(row.fileDigest))
    || !Number.isSafeInteger(row.historyCount) || Number(row.historyCount) < 0 || typeof row.historyDigest !== "string" || !/^[a-f0-9]{64}$/.test(row.historyDigest)
    || row.schemaVersion === 2 && (!(row.contextGeneration === null || typeof row.contextGeneration === "string" && UUID.test(row.contextGeneration))
      || !(row.standingPromptHash === null || typeof row.standingPromptHash === "string" && /^[a-f0-9]{64}$/.test(row.standingPromptHash))))) return invalid();
  return { revision: Number(value.revision), receipt: row === null ? null : row.schemaVersion === 1
    ? { ...row, schemaVersion: 2, contextGeneration: null, standingPromptHash: null } as SessionReceipt : structuredClone(row) as unknown as SessionReceipt };
}
/** The path/identity/accepted state are Host-private. A Pi JSON event can never create this authority. */
export class PiNativeSessionStore {
  private readonly store: WorkspaceJsonState<SessionState>;
  private current: SessionState;
  readonly root: string;
  readonly resumed: boolean;
  readonly promptHistoryStart: number;
  readonly needsPromptRefresh: boolean;
  private readonly bindingDigest: string;
  constructor(storage: WorkspaceResourceStorage, binding: WorkspaceRunBinding, history: readonly NeutralMsg[], private readonly currentPromptHash: string | null = null) {
    if (currentPromptHash !== null && !/^[a-f0-9]{64}$/.test(currentPromptHash)) invalid();
    this.bindingDigest = hash(canonical(binding));
    this.store = new WorkspaceJsonState(storage, "pi-native-session-" + hash(binding.runId).slice(0, 32) + ".json", parse, () => ({ revision: 0, receipt: null }));
    this.current = this.store.read();
    const previous = this.current.receipt, temporary = realpathSync.native(tmpdir());
    if (previous) {
      if (previous.bindingDigest !== this.bindingDigest || previous.state === "accepted" || !below(temporary, previous.root)
        || realpathSync.native(previous.root) !== previous.root || previous.historyCount > history.length
        || previous.historyDigest !== hash(canonical(history.slice(0, previous.historyCount)))) invalid();
      const stat = lstatSync(previous.root, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink() || String(stat.dev) !== previous.dev || String(stat.ino) !== previous.ino || (stat.mode & 0o077n)) invalid();
      if (previous.sessionFile && (!below(join(previous.root, "agent/sessions"), previous.sessionFile)
        || realpathSync.native(previous.sessionFile) !== previous.sessionFile || !lstatSync(previous.sessionFile).isFile()
        || lstatSync(previous.sessionFile).nlink !== 1 || hash(readFileSync(previous.sessionFile)) !== previous.fileDigest)) invalid();
      if (!previous.sessionFile && previous.state === "idle") invalid();
      this.root = previous.root; this.resumed = previous.sessionFile !== null; this.promptHistoryStart = this.resumed ? previous.historyCount : 0;
      this.needsPromptRefresh = this.resumed && (previous.standingPromptHash === null || previous.standingPromptHash !== currentPromptHash || previous.contextGeneration === null);
    } else {
      this.root = realpathSync.native(mkdtempSync(join(temporary, "hara-pi-native-")));
      for (const dir of ["home", "agent", "agent/sessions", "agent/logs", "agent/tmp"]) mkdirSync(join(this.root, dir), { recursive: true, mode: 0o700 });
      this.resumed = false; this.promptHistoryStart = 0;
      this.needsPromptRefresh = false;
    }
    const stat = lstatSync(this.root, { bigint: true });
    this.save({ schemaVersion: 2, bindingDigest: this.bindingDigest, root: this.root, dev: String(stat.dev), ino: String(stat.ino),
      state: "prepared", sessionFile: previous?.sessionFile ?? null, fileDigest: previous?.fileDigest ?? null,
      historyCount: history.length, historyDigest: hash(canonical(history)),
      contextGeneration: previous?.contextGeneration ?? null, standingPromptHash: previous?.standingPromptHash ?? null });
  }
  get sessionFile(): string | null { return this.current.receipt!.sessionFile; }
  get contextGeneration(): string | null { return this.current.receipt!.contextGeneration; }
  private save(receipt: SessionReceipt): void { this.current = this.store.update(this.current.revision, () => ({ revision: this.current.revision, receipt })); }
  accepted(): void {
    if (this.current.receipt!.state !== "accepted") this.save({ ...this.current.receipt!, state: "accepted",
      contextGeneration: this.current.receipt!.contextGeneration ?? randomUUID() });
  }
  /** A confirmed native compaction changes model memory, never history/budget or an accepted-write receipt. */
  compacted(): void {
    if (this.current.receipt!.state !== "accepted") invalid();
    this.save({ ...this.current.receipt!, contextGeneration: randomUUID(), standingPromptHash: null });
  }
  /** Only call after the shared policy has drained all descendants and the turn was settled. */
  finished(sessionFile: string, history: readonly NeutralMsg[]): void {
    const root = join(this.root, "agent/sessions");
    if (!isAbsolute(sessionFile) || !below(root, sessionFile) || realpathSync.native(sessionFile) !== sessionFile) invalid();
    const info = lstatSync(sessionFile);
    if (!info.isFile() || info.nlink !== 1 || info.size > 16 * 1024 * 1024) invalid();
    this.save({ ...this.current.receipt!, state: "idle", sessionFile, fileDigest: hash(readFileSync(sessionFile)),
      historyCount: history.length, historyDigest: hash(canonical(history)), standingPromptHash: this.currentPromptHash });
  }
}
