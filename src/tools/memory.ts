// Memory tools — the agent's interface to durable memory. memory_search/get are read-only
// (parallel-safe, never prompt); memory_write/forget are edits (gated by the approval mode).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { isAbsolute, resolve, join } from "node:path";
import { registerTool } from "./registry.js";
import { searchAssets, assetSearchRoots } from "../recall.js";
import { searchHybrid } from "../search/hybrid.js";
import { memoryRoots, appendMemory, replaceMemory, forgetMemory, type Scope, type Target } from "../memory/store.js";
import { scanMemory, redactSecrets, scrubLocal } from "../memory/guard.js";
import { globalSkillsDir, skillsDir, invalidateSkillsCache } from "../skills/skills.js";

const asTarget = (v: unknown): Target => (["memory", "user", "log"].includes(v as string) ? (v as Target) : "memory");
const asScope = (v: unknown): Scope => (v === "global" ? "global" : "project");

registerTool({
  name: "memory_search",
  description:
    "Search your durable memory (facts, decisions, user preferences, daily notes) by keywords. " +
    "Use BEFORE answering about prior work, project conventions, or the user's preferences.",
  input_schema: {
    type: "object",
    properties: { query: { type: "string" }, limit: { type: "number", description: "default 5" } },
    required: ["query"],
  },
  kind: "read",
  async run(input, ctx) {
    const hits = await searchHybrid(String(input.query ?? ""), ctx.cwd, { indexName: "memory", roots: memoryRoots(ctx.cwd), limit: Math.min(Number(input.limit) || 5, 10) });
    if (!hits.length) return "(no memory matches)";
    return hits.map((h) => `${h.path} — ${h.title}\n${h.snippet}`).join("\n\n");
  },
});

registerTool({
  name: "memory_get",
  description: "Read a memory file in full (use after memory_search to pull the exact entry).",
  input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  kind: "read",
  async run(input, ctx) {
    const p = isAbsolute(String(input.path)) ? String(input.path) : resolve(ctx.cwd, String(input.path));
    if (!memoryRoots(ctx.cwd).some((r) => p.startsWith(r))) return `Error: ${input.path} is outside the memory store.`;
    if (!existsSync(p)) return `Error: no memory file at ${p}.`;
    try {
      return readFileSync(p, "utf8").slice(0, 50_000);
    } catch (e: any) {
      return `Error: ${e.message}`;
    }
  },
});

registerTool({
  name: "memory_write",
  description:
    "Persist a durable fact/decision/preference to memory so future sessions recall it. Save proactively " +
    "when you learn something worth keeping: project conventions, the user's preferences, a tricky solution.",
  input_schema: {
    type: "object",
    properties: {
      content: { type: "string" },
      target: { type: "string", enum: ["memory", "user", "log"], description: "memory=durable facts, user=user prefs (global), log=today's note. default memory" },
      scope: { type: "string", enum: ["project", "global"], description: "default project" },
      mode: { type: "string", enum: ["append", "replace"], description: "default append" },
    },
    required: ["content"],
  },
  kind: "edit",
  async run(input, ctx) {
    const content = String(input.content ?? "").trim();
    if (!content) return "Error: empty content.";
    const scan = scanMemory(content);
    if (!scan.ok) return `Blocked: this looks unsafe to store (${scan.hits.join(", ")}). Rephrase without secrets/injection text.`;
    const scope = asScope(input.scope);
    const target = asTarget(input.target);
    const f = input.mode === "replace" ? replaceMemory(scope, target, content, ctx.cwd) : appendMemory(scope, target, content, ctx.cwd);
    return `Saved to ${f}`;
  },
});

registerTool({
  name: "skill_create",
  description:
    "Save a reusable skill (a how-to / capability) as a SKILL.md so you and future sessions can load it " +
    "later via the `skill` tool. Use after solving something worth reusing. The `description` is how you'll " +
    "recognize when to load it, so make it specific (what it does + when to use it).",
  input_schema: {
    type: "object",
    properties: {
      name: { type: "string", description: "short kebab-case skill id" },
      description: { type: "string", description: "one line: what it does + when to use it" },
      body: { type: "string", description: "the instructions in Markdown (steps, code, gotchas)" },
      scope: { type: "string", enum: ["project", "personal"], description: "project = this repo's .hara/skills; personal = ~/.hara/skills (default). Sharing to company/public is a separate, human-confirmed step." },
    },
    required: ["name", "description", "body"],
  },
  kind: "edit",
  async run(input, ctx) {
    const slug = String(input.name ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48);
    if (!slug) return "Error: invalid name.";
    let description = String(input.description ?? "").replace(/\s+/g, " ").trim();
    if (!description) return "Error: a description is required (it's how the skill gets surfaced).";
    // sanitize on capture: generalize local paths/emails, then redact secrets; block only on residue.
    description = scrubLocal(description, ctx.cwd);
    let body = scrubLocal(String(input.body ?? ""), ctx.cwd);
    const rd = redactSecrets(description);
    const rb = redactSecrets(body);
    description = rd.text;
    body = rb.text;
    const redactions = [...rd.redactions, ...rb.redactions];
    const scan = scanMemory(`${description}\n${body}`);
    if (!scan.ok) return `Blocked: content still looks unsafe (${scan.hits.join(", ")}). Remove injection/exfil text.`;
    const scope = input.scope === "project" ? "project" : "personal";
    const dir = join(scope === "project" ? skillsDir(ctx.cwd) : globalSkillsDir(), slug);
    const f = join(dir, "SKILL.md");
    // dedup: surface a near-duplicate so the agent updates instead of piling up (lexical signal, not a block)
    const dups = searchAssets(`${slug} ${description}`, 3, assetSearchRoots(ctx.cwd)).filter((h) => h.path !== f && h.score >= 2);
    mkdirSync(dir, { recursive: true });
    writeFileSync(f, `---\nname: ${slug}\ndescription: ${description}\n---\n\n${body.trim()}\n`, "utf8");
    invalidateSkillsCache();
    const notes = [
      redactions.length ? `redacted ${redactions.length} secret(s)` : "",
      dups.length ? `⚠ similar already exists: ${dups.map((d) => d.path).join(", ")} — consider updating instead` : "",
    ].filter(Boolean);
    return `Saved ${scope} skill to ${f}${notes.length ? ` (${notes.join("; ")})` : ""}`;
  },
});

registerTool({
  name: "memory_forget",
  description: "Remove memory lines matching a substring (prune stale or wrong facts).",
  input_schema: {
    type: "object",
    properties: {
      match: { type: "string" },
      target: { type: "string", enum: ["memory", "user", "log"] },
      scope: { type: "string", enum: ["project", "global"] },
    },
    required: ["match"],
  },
  kind: "edit",
  async run(input, ctx) {
    const n = forgetMemory(asScope(input.scope), asTarget(input.target), String(input.match ?? ""), ctx.cwd);
    return n ? `Removed ${n} line(s).` : "(no matching lines)";
  },
});
