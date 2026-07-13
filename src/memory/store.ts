// Agent-curated memory — durable facts/decisions/prefs hara records and recalls across sessions.
// File-backed Markdown (git-versionable, human-readable), two scopes: global ~/.hara/memory and
// project <root>/.hara/memory. Lexical search reuses recall.ts; no embeddings (local-first).
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { findProjectRoot } from "../context/agents-md.js";
import { readModelContextFileSync, readVerifiedRegularFileSnapshot, type RegularFileSnapshot } from "../fs-read.js";
import { atomicWriteText, bindAtomicWritePath, type AtomicWriteBoundary } from "../fs-write.js";

export type Scope = "global" | "project";
export type Target = "memory" | "user" | "log";

// Per-source budgets for the frozen-snapshot digest (chars). Each source gets its own cap so a large
// project MEMORY can't crowd out the (smaller but high-value) USER prefs — and each is cut at a line
// boundary, never mid-entry. Anything beyond these is still reachable via memory_search. (hermes-style
// per-file budgets; both PAI and hermes confirm lexical injection + capped snapshot beats a vector store.)
const SOURCE_CAP: Record<Target, number> = { memory: 2000, user: 1200, log: 0 };
const MAX_MEMORY_SOURCE_BYTES = 256 * 1024;

/** Truncate at a line boundary at/under `cap` (never mid-entry), with a pointer to search for the rest. */
function capAtLine(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const cut = text.slice(0, cap);
  const nl = cut.lastIndexOf("\n");
  return (nl > cap * 0.5 ? cut.slice(0, nl) : cut).trimEnd() + "\n…[truncated — memory_search for the rest]";
}

export function memoryDir(scope: Scope, cwd: string): string {
  if (scope === "global") return process.env.HARA_MEMORY || join(homedir(), ".hara", "memory");
  return join(findProjectRoot(cwd), ".hara", "memory");
}
/** Dirs to search for memory (project first, then global). */
export function memoryRoots(cwd: string): string[] {
  return [memoryDir("project", cwd), memoryDir("global", cwd)];
}

function today(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function targetFile(scope: Scope, target: Target, cwd: string): string {
  const dir = memoryDir(scope, cwd);
  if (target === "user") return join(dir, "USER.md");
  if (target === "log") return join(dir, "log", `${today()}.md`);
  return join(dir, "MEMORY.md");
}

async function inspectMemoryWrite(
  path: string,
  action: string,
): Promise<{ boundary: AtomicWriteBoundary; snapshot: RegularFileSnapshot | null }> {
  const boundary = bindAtomicWritePath(path, action);
  try {
    return {
      boundary,
      snapshot: await readVerifiedRegularFileSnapshot(boundary.target, MAX_MEMORY_SOURCE_BYTES, action),
    };
  } catch (error: any) {
    if (error?.code === "ENOENT") return { boundary, snapshot: null };
    throw error;
  }
}

async function commitMemoryText(path: string, text: string, action: string): Promise<void> {
  const { boundary, snapshot } = await inspectMemoryWrite(path, action);
  await atomicWriteText(boundary.target, text, {
    expected: snapshot?.text ?? null,
    expectedIdentity: snapshot ?? undefined,
    boundary,
  });
}

export async function appendMemory(scope: Scope, target: Target, content: string, cwd: string): Promise<string> {
  const f = targetFile(scope, target, cwd);
  const { boundary, snapshot } = await inspectMemoryWrite(f, "append memory");
  const text = (snapshot ? `${snapshot.text}\n` : "") + content.trim() + "\n";
  await atomicWriteText(boundary.target, text, {
    expected: snapshot?.text ?? null,
    expectedIdentity: snapshot ?? undefined,
    boundary,
  });
  return f;
}
export async function replaceMemory(scope: Scope, target: Target, content: string, cwd: string): Promise<string> {
  const f = targetFile(scope, target, cwd);
  await commitMemoryText(f, content.trim() + "\n", "replace memory");
  return f;
}
export async function forgetMemory(scope: Scope, target: Target, match: string, cwd: string): Promise<number> {
  const f = targetFile(scope, target, cwd);
  if (!match) return 0;
  const { boundary, snapshot } = await inspectMemoryWrite(f, "forget memory");
  if (!snapshot) return 0;
  const lines = snapshot.text.split("\n");
  const kept = lines.filter((l) => !l.includes(match));
  const removed = lines.length - kept.length;
  if (!removed) return 0;
  await atomicWriteText(boundary.target, kept.join("\n"), {
    expected: snapshot.text,
    expectedIdentity: snapshot,
    boundary,
  });
  return removed;
}

/** MEMORY + USER digest (project + global) for frozen-snapshot injection at session start. Each source is
 *  capped independently (SOURCE_CAP) at a line boundary, so every source is represented (project memory
 *  never starves USER prefs) and no entry is cut mid-line. Daily logs are reached via memory_search. */
export function memoryDigest(cwd: string): string {
  const sources: [Scope, Target, string][] = [
    ["project", "memory", "project MEMORY"],
    ["global", "memory", "global MEMORY"],
    ["global", "user", "USER preferences"],
  ];
  const parts: string[] = [];
  for (const [scope, target, label] of sources) {
    const f = targetFile(scope, target, cwd);
    if (!existsSync(f)) continue;
    try {
      const t = readModelContextFileSync(f, MAX_MEMORY_SOURCE_BYTES).trim();
      if (t) parts.push(`## ${label}\n${capAtLine(t, SOURCE_CAP[target])}`);
    } catch {
      /* skip unreadable */
    }
  }
  return parts.join("\n\n");
}

/** Concatenate the daily logs (`log/YYYY-MM-DD.md`) from the last `days` for one scope — the short-term
 *  tier `hara memory distill` consolidates into evergreen MEMORY. Empty if there's no log dir. */
export function readRecentLogs(scope: Scope, cwd: string, days: number): string {
  const dir = join(memoryDir(scope, cwd), "log");
  if (!existsSync(dir)) return "";
  const cutoff = Date.now() - days * 86_400_000;
  const out: string[] = [];
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith(".md")) continue;
    const m = /^(\d{4})-(\d{2})-(\d{2})\.md$/.exec(f);
    if (m && new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() < cutoff) continue;
    try {
      const t = readModelContextFileSync(join(dir, f), MAX_MEMORY_SOURCE_BYTES).trim();
      if (t) out.push(`### ${f}\n${t}`);
    } catch {
      /* skip unreadable */
    }
  }
  return out.join("\n\n");
}

/** Seed the memory files (their parents are created by the atomic writer; log is created on first append). */
export async function scaffoldMemory(cwd: string): Promise<string[]> {
  const written: string[] = [];
  for (const scope of ["global", "project"] as Scope[]) {
    const mem = join(memoryDir(scope, cwd), "MEMORY.md");
    const { boundary, snapshot } = await inspectMemoryWrite(mem, "scaffold memory");
    if (!snapshot) {
      await atomicWriteText(boundary.target, `# hara ${scope} memory\n\nDurable facts & decisions hara records and recalls across sessions. Git-versionable — edit freely.\n`, {
        expected: null,
        boundary,
      });
      written.push(mem);
    }
  }
  const user = join(memoryDir("global", cwd), "USER.md");
  const { boundary, snapshot } = await inspectMemoryWrite(user, "scaffold memory");
  if (!snapshot) {
    await atomicWriteText(boundary.target, "# User preferences\n\nHow you like hara to work — voice, conventions, do/don't.\n", {
      expected: null,
      boundary,
    });
    written.push(user);
  }
  return written;
}
