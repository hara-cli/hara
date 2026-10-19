import { createHash } from "node:crypto";
import { join } from "node:path";
import { scanMemory } from "../memory/guard.js";
import { redactSensitiveText } from "../security/secrets.js";
import { writePrivateStateFileSync } from "../security/private-state.js";
import { canonical, plain, WorkspaceJsonState } from "./local-state.js";
import { sameWorkspaceResourceBinding, inspectWorkspaceResourceFile, workspaceResourceCommitGuard, workspaceStateHome,
  type WorkspaceResourceBinding, type WorkspaceResourceStorage } from "./resource-context.js";
import { LegacyOwnerFileDomain } from "./legacy-file-domain.js";

export interface LegacyMemorySource { sourceRef: string; sourceHash: string; content: string }
interface Row { sourceRef: string; sourceHash: string; bytes: number; status: "imported" | "quarantined"; reason: "safe_text" | "source_guard" }
interface State { revision: number; resourceBinding: WorkspaceResourceBinding; sourceFingerprint: string; rows: Row[] }
const digest = (value: string) => createHash("sha256").update(value).digest("hex"), HASH = /^[a-f0-9]{64}$/;
function checkedSources(sources: readonly LegacyMemorySource[], knownCredentials: readonly string[]) {
  if (sources.length > 256 || new Set(sources.map(row => row.sourceRef)).size !== sources.length) throw new Error("Invalid legacy memory source set");
  return sources.map(row => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(row.sourceRef) || !HASH.test(row.sourceHash) || typeof row.content !== "string"
      || Buffer.byteLength(row.content) > 256 * 1024 || digest(row.content) !== row.sourceHash) throw new Error("Legacy memory source changed or exceeds bounds");
    const safe = scanMemory(row.content).ok && !redactSensitiveText(row.content).redactions.length
      && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(row.content)
      && !row.content.includes("<!-- hara-legacy-memory-v1") && !knownCredentials.some(value => value.length >= 4 && row.content.includes(value));
    return { ...row, safe };
  });
}
/** Imports only scanned text into the EXISTING scoped memory bucket used by memoryDigest/search.
 * Provenance lives separately from prompts. Unsafe sources stay only in the immutable owner backup;
 * the index records hashes/reasons, never unsafe bodies or keys. No historical role authority inferred. */
export class WorkspaceLegacyMemoryImport extends LegacyOwnerFileDomain {
  constructor(storage: WorkspaceResourceStorage, sourceFingerprint: string, sources: readonly LegacyMemorySource[], knownCredentials: readonly string[] = []) {
    if (!HASH.test(sourceFingerprint)) throw new Error("Invalid legacy memory fingerprint");
    const inputs = checkedSources(sources, knownCredentials);
    const index: WorkspaceJsonState<State> = new WorkspaceJsonState<State>(storage, "workspace-legacy-memory-v1.json", raw => {
      if (!plain(raw) || raw.sourceFingerprint !== sourceFingerprint || !sameWorkspaceResourceBinding(raw.resourceBinding as WorkspaceResourceBinding, index.binding())
        || !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 1 || !Array.isArray(raw.rows) || raw.rows.length > 256
        || raw.rows.some(row => !plain(row) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(String(row.sourceRef)) || !HASH.test(String(row.sourceHash))
          || !Number.isSafeInteger(row.bytes) || Number(row.bytes) < 0 || !["imported", "quarantined"].includes(String(row.status)) || !["safe_text", "source_guard"].includes(String(row.reason)))) throw new Error("Invalid inherited memory index");
      return structuredClone(raw) as unknown as State;
    }, () => ({ revision: 0, sourceFingerprint, resourceBinding: index.binding(), rows: [] }));
    super(storage, "memory", sourceFingerprint, [".hara/memory/global/MEMORY.md", ".hara/workspace-legacy-memory-v1.json"], inputs.length, () => storage.run(() => {
      const rows: Row[] = inputs.map(row => ({ sourceRef: row.sourceRef, sourceHash: row.sourceHash, bytes: Buffer.byteLength(row.content), status: row.safe ? "imported" : "quarantined", reason: row.safe ? "safe_text" : "source_guard" }));
      const before = index.read(); if (before.revision && canonical(before.rows) !== canonical(rows)) throw new Error("Legacy memory source/index changed; no duplicate append");
      const file = inspectWorkspaceResourceFile(join(workspaceStateHome(), ".hara/memory/global/MEMORY.md"), 256 * 1024);
      let content = file.snapshot?.text ?? "";
      for (const row of inputs.filter(row => row.safe)) {
        const block = `<!-- hara-legacy-memory-v1 ${row.sourceRef} ${row.sourceHash} -->\n${row.content.trim()}\n<!-- /hara-legacy-memory-v1 -->`;
        const marker = `<!-- hara-legacy-memory-v1 ${row.sourceRef} `;
        if (content.includes(marker)) { if (!content.includes(block)) throw new Error("Inherited memory block changed; existing edits preserved"); }
        else content += `${content ? "\n" : ""}${block}\n`;
      }
      if (Buffer.byteLength(content) > 256 * 1024) throw new Error("Inherited memory exceeds the scoped memory budget");
      if (content !== (file.snapshot?.text ?? "")) writePrivateStateFileSync(file, content, { ...(file.snapshot ? { expectedText: file.snapshot.text } : { expectedMissing: true }), assertCurrent: workspaceResourceCommitGuard() });
      if (!before.revision) index.update(0, old => ({ ...old, rows }));
    }));
  }
}
