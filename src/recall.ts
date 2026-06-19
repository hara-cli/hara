// Code-asset recall — a personal, git-versionable library of snippets/playbooks the agent can
// reference. Lexical search over `~/.hara/code-assets/**/*.md` (override with HARA_ASSETS).
// Phase-C v0: lexical-first (no embeddings); reuses the shared filesystem walker.
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { walkFiles } from "./fs-walk.js";

export function assetsDir(): string {
  return process.env.HARA_ASSETS || join(homedir(), ".hara", "code-assets");
}

export interface Recalled {
  path: string;
  title: string;
  snippet: string;
  score: number;
}

function titleOf(text: string, path: string): string {
  const fm = /^---\n([\s\S]*?)\n---/.exec(text);
  if (fm) {
    const t = /(?:^|\n)title:\s*(.+)/i.exec(fm[1]);
    if (t) return t[1].trim();
  }
  const h = /^#\s+(.+)$/m.exec(text);
  return h ? h[1].trim() : (path.split("/").pop() ?? path);
}

/**
 * Lexical search: rank .md files by how many query words appear in path+content.
 * Default searches the code-asset library (relative paths). Pass `roots` to search other dirs
 * (e.g. the memory store) — then paths come back absolute so callers can read them directly.
 */
export function searchAssets(query: string, limit = 5, roots?: string[]): Recalled[] {
  const dirs = roots ?? [assetsDir()];
  const abs = roots !== undefined;
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const hits: Recalled[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const rel of walkFiles(dir).filter((f) => f.endsWith(".md"))) {
      let text: string;
      try {
        text = readFileSync(join(dir, rel), "utf8");
      } catch {
        continue;
      }
      const hay = (rel + "\n" + text).toLowerCase();
      const score = words.filter((w) => hay.includes(w)).length;
      if (!score) continue;
      hits.push({ path: abs ? join(dir, rel) : rel, title: titleOf(text, rel), snippet: text.slice(0, 800), score });
    }
  }
  hits.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
  return hits.slice(0, limit);
}

/** Create the assets dir with an example snippet + README. Returns files written. */
export function scaffoldAssets(): string[] {
  const dir = assetsDir();
  mkdirSync(join(dir, "snippets"), { recursive: true });
  const written: string[] = [];
  const ex = join(dir, "snippets", "example.md");
  if (!existsSync(ex)) {
    writeFileSync(
      ex,
      "---\ntitle: Example snippet\ntags: [example]\nlang: ts\n---\n\n# Example snippet\n\nDescribe a reusable pattern, then the code:\n\n```ts\nexport const example = 1;\n```\n",
    );
    written.push("snippets/example.md");
  }
  const rd = join(dir, "README.md");
  if (!existsSync(rd)) {
    writeFileSync(
      rd,
      '# hara code-assets\n\nDrop `*.md` files here (snippets, playbooks). `hara recall "<query>"` searches them;\nin the REPL, `/recall <query>` pulls the best matches into your next message. A personal,\ngit-versionable library of code/patterns you want to reuse.\n',
    );
    written.push("README.md");
  }
  return written;
}
