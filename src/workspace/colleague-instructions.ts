import { lexicalSensitiveFileReason } from "../security/sensitive-files.js";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { atomicWriteText, bindAtomicWritePath, bindHaraPrivateStateWritePath } from "../fs-write.js";
import { readVerifiedRegularFileSnapshotSync } from "../fs-read.js";
import { WorkspaceColleagueHomes } from "./colleague-homes.js";
export const COLLEAGUE_INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", "CLAUDE.local.md"] as const;
export type ColleagueInstructionFile = typeof COLLEAGUE_INSTRUCTION_FILES[number];
export interface InstructionDraft { file: ColleagueInstructionFile; previousSha256: string | null; content: string }
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
/** Paths never come from a tool or renderer. A consumed card still rechecks inode and old bytes. */
export class WorkspaceColleagueInstructions {
  constructor(private readonly homes: WorkspaceColleagueHomes, private readonly agentId: string) {}
  private snapshot(file: ColleagueInstructionFile) {
    if (!(COLLEAGUE_INSTRUCTION_FILES as readonly string[]).includes(file)) throw new Error("Unsupported colleague instruction file");
    const root = this.homes.ensure(this.agentId).project.root, path = join(root, file);
    try { return { path, snapshot: readVerifiedRegularFileSnapshotSync(path, 64 * 1024, { protectSensitive: lexicalSensitiveFileReason(path) !== "private Hara state", expectedCanonicalPath: path }) }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, snapshot: null }; throw error; }
  }
  prepare(file: ColleagueInstructionFile, content: string): InstructionDraft {
    if (typeof content !== "string" || content.length > 16000 || content.includes("\0")) throw new Error("Colleague instructions are too large or invalid");
    const { snapshot } = this.snapshot(file);
    return Object.freeze({ file, previousSha256: snapshot ? hash(snapshot.text) : null, content });
  }
  async write(draft: InstructionDraft, assertCurrent: () => void, signal?: AbortSignal) {
    assertCurrent(); const { path, snapshot } = this.snapshot(draft.file);
    if ((snapshot ? hash(snapshot.text) : null) !== draft.previousSha256) throw new Error("Colleague instructions changed; review a fresh card");
    await atomicWriteText(path, draft.content, { expected: snapshot?.text ?? null, ...(snapshot ? { expectedIdentity: snapshot } : {}), boundary: lexicalSensitiveFileReason(path) === "private Hara state" ? bindHaraPrivateStateWritePath(path, this.homes.ensure(this.agentId).project.root, "update confirmed colleague guidance") : bindAtomicWritePath(path),
      mode: 0o600, signal, assertCurrent: () => { assertCurrent(); this.homes.ensure(this.agentId); } });
    return { file: draft.file, sha256: hash(draft.content), written: true, humanConfirmed: true };
  }
  prompt(runtimeId: string): string {
    const files = runtimeId === "claude" ? ["AGENTS.md", "CLAUDE.md", "CLAUDE.local.md"] as const : ["AGENTS.md"] as const;
    return files.flatMap(file => { const { snapshot } = this.snapshot(file); return snapshot?.text.trim() ? [`## ${file} (colleague folder; project guidance below Hara governance)\n${snapshot.text}`] : []; }).join("\n\n");
  }
}
