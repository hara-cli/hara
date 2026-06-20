// codebase_search — treat the current project as a knowledge base. Lexical relevance search over the
// repo's code/text (respects .gitignore via listProjectFiles), ranked by how many distinct query words a
// file contains, returning the densest snippet. Distinct from grep (exact pattern): this finds *related*
// code from a natural-language query. The interface a semantic (zvec) index slots into later.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { registerTool } from "./registry.js";
import { listProjectFiles, isProbablyBinary, fileSize } from "../fs-walk.js";
import { findProjectRoot } from "../context/agents-md.js";

const MAX_FILE = 200_000; // skip very large files
const CODE_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|c|h|cc|cpp|hpp|cs|swift|scala|sh|bash|sql|md|mdx|json|ya?ml|toml|html|css|scss|less|vue|svelte|astro|tf|proto|graphql|gql|gradle|txt)$/i;

registerTool({
  name: "codebase_search",
  description:
    "Find code in THIS project relevant to a natural-language query — ranked by relevance (not exact match). " +
    "Use it to locate similar/related code while working ('where is auth handled?', 'retry logic'); use grep " +
    "for exact strings/regex. Returns the top files with their most relevant snippet (file:line).",
  input_schema: {
    type: "object",
    properties: { query: { type: "string" }, limit: { type: "number", description: "default 6 (max 20)" } },
    required: ["query"],
  },
  kind: "read",
  async run(input, ctx) {
    const words = [...new Set(String(input.query ?? "").toLowerCase().split(/\s+/).filter((w) => w.length > 1))];
    if (!words.length) return "(empty query)";
    const need = Math.min(2, words.length); // require most of the query to actually appear (conceptual overlap)
    const limit = Math.min(Number(input.limit) || 6, 20);
    const root = findProjectRoot(ctx.cwd);
    const hits: { file: string; score: number; line: number; snippet: string }[] = [];
    for (const rel of listProjectFiles(root)) {
      if (!CODE_RE.test(rel)) continue;
      const abs = join(root, rel);
      if (fileSize(abs) > MAX_FILE) continue;
      let buf: Buffer;
      try {
        buf = readFileSync(abs);
      } catch {
        continue;
      }
      if (isProbablyBinary(buf)) continue;
      const text = buf.toString("utf8");
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
    if (!hits.length) return "(no relevant code found)";
    return hits.slice(0, limit).map((h) => `${h.file}:${h.line}\n${h.snippet}`).join("\n\n---\n\n");
  },
});
