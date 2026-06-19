// Agent-curated memory — durable facts/decisions/prefs hara records and recalls across sessions.
// File-backed Markdown (git-versionable, human-readable), two scopes: global ~/.hara/memory and
// project <root>/.hara/memory. Lexical search reuses recall.ts; no embeddings (local-first).
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { findProjectRoot } from "../context/agents-md.js";

export type Scope = "global" | "project";
export type Target = "memory" | "user" | "log";

const DIGEST_CAP = 4000; // chars of MEMORY/USER injected at session start (logs reached via search)

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

export function appendMemory(scope: Scope, target: Target, content: string, cwd: string): string {
  const f = targetFile(scope, target, cwd);
  mkdirSync(dirname(f), { recursive: true });
  appendFileSync(f, (existsSync(f) ? "\n" : "") + content.trim() + "\n", "utf8");
  return f;
}
export function replaceMemory(scope: Scope, target: Target, content: string, cwd: string): string {
  const f = targetFile(scope, target, cwd);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, content.trim() + "\n", "utf8");
  return f;
}
export function forgetMemory(scope: Scope, target: Target, match: string, cwd: string): number {
  const f = targetFile(scope, target, cwd);
  if (!existsSync(f) || !match) return 0;
  const lines = readFileSync(f, "utf8").split("\n");
  const kept = lines.filter((l) => !l.includes(match));
  writeFileSync(f, kept.join("\n"), "utf8");
  return lines.length - kept.length;
}

/** Capped MEMORY + USER digest (project + global) for frozen-snapshot injection at session start. */
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
      const t = readFileSync(f, "utf8").trim();
      if (t) parts.push(`## ${label}\n${t}`);
    } catch {
      /* skip unreadable */
    }
  }
  const out = parts.join("\n\n");
  return out.length > DIGEST_CAP ? out.slice(0, DIGEST_CAP) + "\n…[memory truncated — use memory_search]" : out;
}

/** Create memory dirs + seed files (global + project). Returns files written. */
export function scaffoldMemory(cwd: string): string[] {
  const written: string[] = [];
  for (const scope of ["global", "project"] as Scope[]) {
    mkdirSync(join(memoryDir(scope, cwd), "log"), { recursive: true });
    const mem = join(memoryDir(scope, cwd), "MEMORY.md");
    if (!existsSync(mem)) {
      writeFileSync(mem, `# hara ${scope} memory\n\nDurable facts & decisions hara records and recalls across sessions. Git-versionable — edit freely.\n`, "utf8");
      written.push(mem);
    }
  }
  const user = join(memoryDir("global", cwd), "USER.md");
  if (!existsSync(user)) {
    writeFileSync(user, "# User preferences\n\nHow you like hara to work — voice, conventions, do/don't.\n", "utf8");
    written.push(user);
  }
  return written;
}
