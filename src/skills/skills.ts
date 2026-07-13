// Skills — agentskills.io-standard capabilities at <project>/.hara/skills/<name>/SKILL.md (+ global
// ~/.hara/skills). Frontmatter: name, description (required) + when_to_use / allowed-tools /
// context inline|fork / model / paths / user-invocable / disable-model-invocation. The body is the
// instructions, loaded ON DEMAND (progressive disclosure) — only the frontmatter index sits in context.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { findProjectRoot } from "../context/agents-md.js";
import { scanMemory } from "../memory/guard.js";
import { pluginSkillDirs } from "../plugins/plugins.js";
import { readModelContextFileSync, readVerifiedRegularFileSnapshot } from "../fs-read.js";
import { atomicWriteText, bindAtomicWritePath } from "../fs-write.js";

const MAX_SKILL_BYTES = 512 * 1024;

export interface Skill {
  id: string;
  description: string;
  whenToUse?: string;
  allowedTools?: string[];
  context: "inline" | "fork";
  model?: string;
  paths?: string[];
  userInvocable: boolean;
  modelInvocable: boolean;
  file: string; // path to SKILL.md (body read on demand)
  source: "project" | "global" | "plugin";
}

export function skillsDir(cwd: string): string {
  return join(findProjectRoot(cwd), ".hara", "skills");
}
export function globalSkillsDir(): string {
  return join(homedir(), ".hara", "skills");
}
/** Search roots, lowest→highest precedence (later wins on id clash): plugins < global < project. */
export function skillsDirs(cwd: string): string[] {
  return [...pluginSkillDirs(), globalSkillsDir(), skillsDir(cwd)];
}

function listVal(v: unknown): string[] | undefined {
  if (Array.isArray(v)) return v as string[];
  if (typeof v === "string" && v.trim()) return v.split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  return undefined;
}
const isFalse = (v: unknown): boolean => v === "false" || v === false;
const isTrue = (v: unknown): boolean => v === "true" || v === true;

/** Parse YAML-ish frontmatter (keys may contain hyphens, unlike roles.ts). Only the head is needed for the index. */
function parseFrontmatter(text: string): { fm: Record<string, any>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m) return { fm: {}, body: text.trim() };
  const fm: Record<string, any> = {};
  for (const raw of m[1].split("\n")) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(raw.trim());
    if (!kv) continue;
    const val = kv[2].trim();
    if (val.startsWith("[") && val.endsWith("]")) {
      fm[kv[1]] = val.slice(1, -1).split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    } else {
      fm[kv[1]] = val.replace(/^["']|["']$/g, "");
    }
  }
  return { fm, body: m[2].trim() };
}

/** All skills' frontmatter (the index) — cheap; the body is loaded separately by loadSkillBody. */
export function loadSkillIndex(cwd: string): Skill[] {
  const byId = new Map<string, Skill>();
  const gdir = globalSkillsDir();
  const pdir = skillsDir(cwd);
  for (const dir of skillsDirs(cwd)) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      const file = join(dir, entry, "SKILL.md"); // agentskills layout: <name>/SKILL.md
      if (!existsSync(file)) continue;
      try {
        const { fm } = parseFrontmatter(readModelContextFileSync(file, MAX_SKILL_BYTES));
        const id = (fm.name as string) || entry;
        byId.set(id, {
          id,
          description: (fm.description as string) || "",
          whenToUse: (fm.when_to_use as string) || undefined,
          allowedTools: listVal(fm["allowed-tools"]),
          context: fm.context === "fork" ? "fork" : "inline",
          model: fm.model || undefined,
          paths: listVal(fm.paths),
          userInvocable: !isFalse(fm["user-invocable"]),
          modelInvocable: !isTrue(fm["disable-model-invocation"]),
          file,
          source: dir === gdir ? "global" : dir === pdir ? "project" : "plugin",
        });
      } catch {
        /* skip bad skill */
      }
    }
  }
  return [...byId.values()];
}

/** Read a skill's instruction body (progressive disclosure — only when the model/user opens it). */
export function loadSkillBody(skill: Skill): string {
  try {
    return parseFrontmatter(readModelContextFileSync(skill.file, MAX_SKILL_BYTES)).body;
  } catch {
    return "";
  }
}

const DIGEST_CAP = 4000;
let _digestCache = new Map<string, string>();
/** Compact, frozen-per-session index injected into the system prompt (name + description, one line each).
 *  Drops model-hidden skills and any whose description fails the guard (plugin skills may be untrusted). */
export function skillsDigest(cwd: string): string {
  if (_digestCache.has(cwd)) return _digestCache.get(cwd)!;
  const lines: string[] = [];
  for (const s of loadSkillIndex(cwd)) {
    if (!s.modelInvocable || !s.description || !scanMemory(s.description).ok) continue;
    lines.push(`- ${s.id}: ${s.description}${s.whenToUse ? ` — ${s.whenToUse}` : ""}`);
  }
  let digest = lines.join("\n");
  if (digest.length > DIGEST_CAP) digest = digest.slice(0, DIGEST_CAP) + "\n…";
  _digestCache.set(cwd, digest);
  return digest;
}
/** Drop the cached digest (call after skill_create so a new skill surfaces next turn). */
export function invalidateSkillsCache(): void {
  _digestCache.clear();
}

const SCAFFOLD = `---
name: verify-change
description: Verify a code change does what it should by building and running the tests.
when_to_use: after editing code, before declaring a task done
---

# Verify a change

1. Identify how this project builds and tests (check AGENTS.md / package.json scripts).
2. Run the build (e.g. \`tsc\` / \`npm run build\`) and report any errors.
3. Run the relevant tests; if none exist for the change, note that.
4. Summarize: what you ran, pass/fail, and anything still unverified.
`;

/** Create ~/.hara/skills/verify-change/SKILL.md as a starter example. Returns the paths written. */
export async function scaffoldSkills(cwd: string): Promise<string[]> {
  const dir = join(skillsDir(cwd), "verify-change");
  const p = join(dir, "SKILL.md");
  const boundary = bindAtomicWritePath(p, "scaffold skill");
  try {
    await readVerifiedRegularFileSnapshot(boundary.target, undefined, "scaffold skill");
    return [];
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  await atomicWriteText(boundary.target, SCAFFOLD, { expected: null, boundary });
  invalidateSkillsCache();
  return [p];
}
