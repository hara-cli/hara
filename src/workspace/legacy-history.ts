import { createHash } from "node:crypto";
import { join } from "node:path";
import { redactSensitiveText } from "../security/secrets.js";
import { writePrivateStateFileSync } from "../security/private-state.js";
import { canonical, exact, plain, WorkspaceJsonState } from "./local-state.js";
import { inspectWorkspaceResourceFile, sameWorkspaceResourceBinding, workspaceResourceCommitGuard, workspaceStateHome,
  type WorkspaceResourceBinding, type WorkspaceResourceStorage } from "./resource-context.js";
import { LegacyOwnerFileDomain } from "./legacy-file-domain.js";

export interface LegacyHistorySource { sourceRef: string; sourceHash: string; content: string }
interface Message { role: "user" | "assistant" | "tool"; text: string }
interface Entry { id: string; sourceHash: string; contentHash: string; messages: number; updatedAt: number }
interface State { revision: number; resourceBinding: WorkspaceResourceBinding; sourceFingerprint: string; entries: Entry[] }
const hash = (value: string) => createHash("sha256").update(value).digest("hex"), HASH = /^[a-f0-9]{64}$/;
const archivePath = (id: string) => `.hara/legacy-history/v1/${id}.json`;
function project(sources: readonly LegacyHistorySource[], knownCredentials: readonly string[]) {
  if (sources.length > 4096 || new Set(sources.map(row => row.sourceRef)).size !== sources.length) throw new Error("Invalid legacy history source set");
  const clean = (value: string) => { let text = value; for (const key of [...knownCredentials].filter(key => key.length >= 4).sort((a,b) => b.length-a.length)) text = text.split(key).join("[REDACTED]");
    return redactSensitiveText(text).text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ""); };
  return sources.map(row => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(row.sourceRef) || !HASH.test(row.sourceHash) || Buffer.byteLength(row.content) > 4 * 1024 * 1024 || hash(row.content) !== row.sourceHash) throw new Error("Legacy history source changed or exceeds bounds");
    let raw; try { raw = JSON.parse(row.content); } catch { throw new Error("Legacy history JSON requires review; source preserved"); }
    if (!plain(raw) || !Array.isArray(raw.history) || raw.history.length > 40000) throw new Error("Legacy history format requires review");
    const messages: Message[] = [];
    for (const message of raw.history) {
      if (!plain(message)) throw new Error("Invalid legacy history message");
      if (message.role === "user" && typeof message.content === "string") messages.push({ role: "user", text: clean(typeof message.displayContent === "string" ? message.displayContent : message.content) });
      else if (message.role === "assistant" && typeof message.text === "string") messages.push({ role: "assistant", text: clean(message.text) });
      else if (message.role === "tool" && Array.isArray(message.results)) for (const result of message.results) if (plain(result) && typeof result.content === "string") messages.push({ role: "tool", text: clean(result.content) });
      // Tool calls, native continuation/reasoning, attachment paths and run bindings are NEVER copied
      // as execution authority. Tool result text remains searchable display-only history.
    }
    const id = "lh_" + hash(row.sourceRef + "\0" + row.sourceHash), bytes = JSON.stringify({ schemaVersion: 1, id, messages }) + "\n";
    if (Buffer.byteLength(bytes) > 4 * 1024 * 1024) throw new Error("Projected history exceeds archive bounds");
    const updatedAt = plain(raw.meta) && typeof raw.meta.updatedAt === "number" && Number.isFinite(raw.meta.updatedAt) ? raw.meta.updatedAt : 0;
    return { bytes, entry: { id, sourceHash: row.sourceHash, contentHash: hash(bytes), messages: messages.length, updatedAt } };
  });
}
/** Display-only archive IDs are intentionally NOT SessionHub/Workspace session UUIDs. No resume,
 * Provider continuation or model tool exists here. All reads recheck the immutable sanitized hash. */
export class WorkspaceLegacyHistory {
  private readonly state: WorkspaceJsonState<State>;
  constructor(private readonly storage: WorkspaceResourceStorage, private readonly sourceFingerprint: string) {
    if (!HASH.test(sourceFingerprint)) throw new Error("Invalid legacy history fingerprint");
    this.state = new WorkspaceJsonState<State>(storage, "workspace-legacy-history-v1.json", raw => {
      if (!plain(raw) || raw.sourceFingerprint !== sourceFingerprint || !sameWorkspaceResourceBinding(raw.resourceBinding as WorkspaceResourceBinding, this.state.binding())
        || !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 1 || !Array.isArray(raw.entries) || raw.entries.length > 4096
        || new Set(raw.entries.map(row => plain(row) ? row.id : null)).size !== raw.entries.length) throw new Error("Invalid legacy history index");
      for (const row of raw.entries) if (!plain(row) || !exact(row, ["id", "sourceHash", "contentHash", "messages", "updatedAt"]) || !/^lh_[a-f0-9]{64}$/.test(String(row.id))
        || !HASH.test(String(row.sourceHash)) || !HASH.test(String(row.contentHash)) || !Number.isSafeInteger(row.messages) || Number(row.messages) < 0 || !Number.isFinite(row.updatedAt)) throw new Error("Invalid legacy history entry");
      return structuredClone(raw) as unknown as State;
    }, () => ({ revision: 0, resourceBinding: this.state.binding(), sourceFingerprint, entries: [] }));
  }
  domain(sources: readonly LegacyHistorySource[], knownCredentials: readonly string[] = []) {
    const rows = project(sources, knownCredentials);
    return new LegacyOwnerFileDomain(this.storage, "history", this.sourceFingerprint, [".hara/workspace-legacy-history-v1.json", ...rows.map(row => archivePath(row.entry.id))], rows.length, () => this.storage.run(() => {
      const before = this.state.read(), entries = rows.map(row => row.entry);
      if (before.revision && canonical(before.entries) !== canonical(entries)) throw new Error("Legacy history source changed; existing archive preserved");
      for (const row of rows) {
        const file = inspectWorkspaceResourceFile(join(workspaceStateHome(), archivePath(row.entry.id)), 4 * 1024 * 1024);
        if (file.snapshot) { if (file.snapshot.text !== row.bytes) throw new Error("Legacy history collision; no overwrite"); }
        else writePrivateStateFileSync(file, row.bytes, { expectedMissing: true, assertCurrent: workspaceResourceCommitGuard() });
      }
      if (!before.revision) this.state.update(0, old => ({ ...old, entries }));
    }));
  }
  list() { return { readOnly: true as const, entries: this.state.read().entries.map(({ contentHash: _content, ...row }) => row) }; }
  private messages(id: string): Message[] {
    const entry = this.state.read().entries.find(row => row.id === id); if (!entry) throw new Error("Archive does not belong to this Workspace");
    return this.storage.run(() => {
      const text = inspectWorkspaceResourceFile(join(workspaceStateHome(), archivePath(id)), 4 * 1024 * 1024).snapshot?.text;
      if (!text || hash(text) !== entry.contentHash) throw new Error("Legacy archive changed; no unverified content displayed");
      const raw = JSON.parse(text); if (!plain(raw) || !exact(raw, ["schemaVersion", "id", "messages"]) || raw.schemaVersion !== 1 || raw.id !== id || !Array.isArray(raw.messages)) throw new Error("Invalid legacy archive");
      return raw.messages as Message[];
    });
  }
  page(id: string, message = 0, offset = 0) {
    if (!Number.isSafeInteger(message) || message < 0 || !Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid archive cursor");
    const rows = this.messages(id), row = rows[message]; if (!row) return { readOnly: true as const, id, messages: [], next: null };
    let text = row.text.slice(offset, offset + 6000); if (offset > row.text.length) throw new Error("Archive cursor out of range");
    while (JSON.stringify({ role: row.role, text }).length > 7400 && text.length) text = text.slice(0, Math.floor(text.length * .75));
    const next = offset + text.length < row.text.length ? { message, offset: offset + text.length } : message + 1 < rows.length ? { message: message + 1, offset: 0 } : null;
    return { readOnly: true as const, id, messages: [{ role: row.role, text }], next };
  }
  search(query: string, limit = 20) {
    if (typeof query !== "string" || !query.trim() || query.length > 200 || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error("Invalid legacy archive search");
    const hits: { id: string; message: number; role: Message["role"]; excerpt: string }[] = [], needle = query.toLocaleLowerCase();
    for (const entry of this.state.read().entries) { const rows = this.messages(entry.id); for (let i = 0; i < rows.length; i++) {
      const at = rows[i]!.text.toLocaleLowerCase().indexOf(needle); if (at < 0) continue;
      hits.push({ id: entry.id, message: i, role: rows[i]!.role, excerpt: rows[i]!.text.slice(Math.max(0, at - 60), at + 180) }); if (hits.length >= limit) return { readOnly: true as const, hits };
    } }
    return { readOnly: true as const, hits };
  }
}
