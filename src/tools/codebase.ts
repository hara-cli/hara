// codebase_search — treat the current project as a knowledge base. Lexical relevance search over the
// repo's code/text (respects .gitignore via listProjectFiles), ranked by how many distinct query words a
// file contains, returning the densest snippet. Distinct from grep (exact pattern): this finds *related*
// code from a natural-language query. The interface a semantic (zvec) index slots into later.
import { statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { registerTool } from "./registry.js";
import { listProjectFilesAsync } from "../fs-walk.js";
import { findProjectRoot } from "../context/agents-md.js";
import { loadConfig } from "../config.js";
import { getEmbedder } from "../search/embed.js";
import { queryIndex, indexExists } from "../search/semindex.js";
import {
  homeWorkspaceDirectoryScanError,
  isHomeWorkspace,
  recursiveRootContainsHome,
  recursiveHomeSearchError,
} from "../context/workspace-scope.js";
import { readVerifiedRegularFileSnapshotSync } from "../fs-read.js";

const MAX_FILE = 200_000; // skip very large files
const INVENTORY_TIMEOUT_MS = 2_000;
const LEXICAL_TIMEOUT_MS = 5_000;
const CODE_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|c|h|cc|cpp|hpp|cs|swift|scala|sh|bash|sql|md|mdx|json|ya?ml|toml|html|css|scss|less|vue|svelte|astro|tf|proto|graphql|gql|gradle|txt)$/i;

registerTool({
  name: "codebase_search",
  description:
    "Find code in THIS project relevant to a natural-language query — ranked by relevance (not exact match). " +
    "Use it to locate similar/related code while working ('where is auth handled?', 'retry logic'); use grep " +
    "for exact strings/regex. Returns the top files with their most relevant snippet (file:line). When Hara " +
    "was started in the home directory, cd to a specific project before searching.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string" },
      limit: { type: "number", description: "default 6 (max 20)" },
      path: { type: "string", description: "project directory (default: cwd)" },
    },
    required: ["query"],
  },
  kind: "read",
  async run(input, ctx) {
    if (ctx.signal?.aborted) throw new Error("codebase_search interrupted by agent run deadline or cancellation");
    const words = [...new Set(String(input.query ?? "").toLowerCase().split(/\s+/).filter((w) => w.length > 1))];
    if (!words.length) return "(empty query)";
    const need = Math.min(2, words.length); // require most of the query to actually appear (conceptual overlap)
    const limit = Math.min(Number(input.limit) || 6, 20);
    const requestedRoot = typeof input.path === "string" && input.path.trim()
      ? (isAbsolute(input.path) ? input.path : resolve(ctx.cwd, input.path))
      : ctx.cwd;
    if (isHomeWorkspace(ctx.cwd)) return homeWorkspaceDirectoryScanError("codebase_search");
    try {
      if (!statSync(requestedRoot).isDirectory()) return `Error: codebase_search path is not a directory: ${input.path ?? "."}`;
    } catch {
      return `Error: no such codebase_search path: ${input.path ?? "."}`;
    }
    if (recursiveRootContainsHome(requestedRoot)) return recursiveHomeSearchError("codebase_search");
    const root = findProjectRoot(requestedRoot);
    if (recursiveRootContainsHome(root)) return recursiveHomeSearchError("codebase_search");
    const hits: { file: string; score: number; line: number; snippet: string }[] = [];
    const inventory = await listProjectFilesAsync(root, {
      maxFiles: 8_000,
      maxDirectories: 20_000,
      maxEntries: 100_000,
      timeoutMs: INVENTORY_TIMEOUT_MS,
      signal: ctx.signal,
      yieldEvery: 64,
    });
    const lexicalStartedAt = Date.now();
    let lexicalTimedOut = false;
    let fileIndex = 0;
    for (const rel of inventory.files) {
      if (ctx.signal?.aborted) throw new Error("codebase_search interrupted by agent run deadline or cancellation");
      if (fileIndex++ > 0 && fileIndex % 32 === 0) {
        await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
        if (ctx.signal?.aborted) throw new Error("codebase_search interrupted by agent run deadline or cancellation");
        if (Date.now() - lexicalStartedAt >= LEXICAL_TIMEOUT_MS) {
          lexicalTimedOut = true;
          break;
        }
      }
      if (!CODE_RE.test(rel)) continue;
      const abs = join(root, rel);
      let text: string;
      try {
        text = readVerifiedRegularFileSnapshotSync(abs, MAX_FILE, { action: "search" }).text;
      } catch {
        continue;
      }
      if (text.includes("\0")) continue;
      const lower = text.toLowerCase();
      const present = words.filter((w) => lower.includes(w));
      if (present.length < need) continue;
      // densest line = the one matching the most distinct query words; show it with a little context
      const lines = text.split("\n");
      let bestLine = 0;
      let bestHits = 0;
      for (let i = 0; i < lines.length; i++) {
        const ll = lines[i].toLowerCase();
        const h = present.reduce((n, w) => (ll.includes(w) ? n + 1 : n), 0);
        if (h > bestHits) {
          bestHits = h;
          bestLine = i;
        }
      }
      const snippet = lines.slice(Math.max(0, bestLine - 2), bestLine + 4).join("\n");
      hits.push({ file: rel, score: present.length * 100 + bestHits, line: bestLine + 1, snippet });
    }
    hits.sort((a, b) => b.score - a.score || a.file.length - b.file.length);

    // Semantic layer (opt-in): if a repo index + embedder are configured, prepend the most relevant
    // chunks (more precise than word overlap), then fill remaining slots with lexical hits. Falls back
    // to pure lexical when no index/embedder — zero behaviour change for the default install.
    const out: string[] = [];
    const seen = new Set<string>();
    // Tool execution can be dispatched to a registered agent home without changing process.cwd(). Its
    // semantic-search provider/index settings belong to the tool context, not to the launcher directory.
    const cfg = loadConfig({ cwd: root });
    const embed = getEmbedder(cfg);
    if (embed && indexExists("repo", root)) {
      try {
        for (const s of await queryIndex("repo", String(input.query), embed, root, limit, ctx.signal)) {
          if (s.score < 0.2 || seen.has(s.file)) continue;
          seen.add(s.file);
          out.push(`${s.file} (semantic ${s.score.toFixed(2)})\n${s.text.split("\n").slice(0, 6).join("\n")}`);
        }
      } catch {
        if (ctx.signal?.aborted) throw new Error("codebase_search interrupted by agent run deadline or cancellation");
        /* embedding endpoint down → degrade to lexical */
      }
    }
    for (const h of hits) {
      if (out.length >= limit) break;
      if (seen.has(h.file)) continue;
      seen.add(h.file);
      out.push(`${h.file}:${h.line}\n${h.snippet}`);
    }
    const boundedNote = inventory.truncated
      ? `(project inventory stopped at its ${inventory.reason?.replace("_", " ") ?? "safety limit"})`
      : lexicalTimedOut ? `(lexical scan stopped at its ${LEXICAL_TIMEOUT_MS}ms safety budget)` : "";
    if (!out.length) return boundedNote ? `(no relevant code found)\n${boundedNote}` : "(no relevant code found)";
    return (boundedNote ? `${boundedNote}\n\n` : "") + out.join("\n\n---\n\n");
  },
});
