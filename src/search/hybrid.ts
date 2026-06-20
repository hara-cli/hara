// Hybrid search — lexical (always) blended with semantic (when an index + embedder are configured).
// One entry point for `recall` and `memory_search`: semantic hits lead (more relevant), lexical fills the
// rest, deduped by path. With no index/embedder it's exactly the lexical result — zero behaviour change.
import { searchAssets, titleOf, type Recalled } from "../recall.js";
import { loadConfig } from "../config.js";
import { getEmbedder } from "./embed.js";
import { queryIndex, indexExists } from "./semindex.js";

export async function searchHybrid(
  query: string,
  cwd: string,
  opts: { indexName: string; roots: string[]; limit?: number },
): Promise<Recalled[]> {
  const limit = opts.limit ?? 5;
  const lex = searchAssets(query, limit, opts.roots);
  const embed = getEmbedder(loadConfig());
  if (!embed || !indexExists(opts.indexName, cwd)) return lex;

  let sem;
  try {
    sem = await queryIndex(opts.indexName, query, embed, cwd, limit);
  } catch {
    return lex; // embedding endpoint down → degrade to lexical
  }

  const out: Recalled[] = [];
  const seen = new Set<string>();
  for (const s of sem) {
    if (s.score < 0.2 || seen.has(s.file)) continue;
    seen.add(s.file);
    out.push({ path: s.file, title: titleOf(s.text, s.file), snippet: s.text.slice(0, 800), score: s.score });
  }
  for (const h of lex) {
    if (out.length >= limit) break;
    if (seen.has(h.path)) continue;
    seen.add(h.path);
    out.push(h);
  }
  return out;
}
