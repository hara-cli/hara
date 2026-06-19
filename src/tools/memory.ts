// Memory tools — the agent's interface to durable memory. memory_search/get are read-only
// (parallel-safe, never prompt); memory_write/forget are edits (gated by the approval mode).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { isAbsolute, resolve, join } from "node:path";
import { registerTool } from "./registry.js";
import { searchAssets, assetsDir } from "../recall.js";
import { memoryRoots, appendMemory, replaceMemory, forgetMemory, type Scope, type Target } from "../memory/store.js";
import { scanMemory } from "../memory/guard.js";

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
    const hits = searchAssets(String(input.query ?? ""), Math.min(Number(input.limit) || 5, 10), memoryRoots(ctx.cwd));
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
  name: "playbook_save",
  description:
    "Save a reusable playbook (a how-to / pattern you can recall later) to your code-asset library. " +
    "Use after solving something worth reusing — `hara recall` and memory_search find it later.",
  input_schema: {
    type: "object",
    properties: {
      slug: { type: "string", description: "short kebab-case file name" },
      title: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
      body: { type: "string", description: "the playbook in Markdown (steps, code, gotchas)" },
    },
    required: ["slug", "title", "body"],
  },
  kind: "edit",
  async run(input) {
    const slug = String(input.slug ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48);
    if (!slug) return "Error: invalid slug.";
    const body = String(input.body ?? "");
    const scan = scanMemory(`${input.title}\n${body}`);
    if (!scan.ok) return `Blocked: content looks unsafe (${scan.hits.join(", ")}). Remove secrets/injection text.`;
    const tags = Array.isArray(input.tags) ? input.tags : [];
    const dir = join(assetsDir(), "playbooks");
    mkdirSync(dir, { recursive: true });
    const f = join(dir, `${slug}.md`);
    writeFileSync(f, `---\ntitle: ${input.title}\ntags: [${tags.join(", ")}]\n---\n\n${body.trim()}\n`, "utf8");
    return `Saved playbook to ${f}`;
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
