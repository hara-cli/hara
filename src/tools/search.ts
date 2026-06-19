// Search/listing tools — grep (regex across files), glob (path patterns), ls (one directory).
// All read-only (kind: "read"), so they never hit the approval gate and run in parallel.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, resolve, join, relative, sep } from "node:path";
import { registerTool } from "./registry.js";
import { walkFiles, isProbablyBinary } from "../fs-walk.js";

const MAX_OUT = 60_000;
const MAX_MATCHES = 300;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const toPosix = (p: string): string => (sep === "/" ? p : p.split(sep).join("/"));
const absOf = (p: string | undefined, cwd: string): string => (p ? (isAbsolute(p) ? p : resolve(cwd, p)) : cwd);

/** Convert a glob (supports **, *, ?) to an anchored RegExp over POSIX paths. */
function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        // ** matches across path separators (optionally swallow a trailing slash)
        i++;
        if (glob[i + 1] === "/") i++;
        re += "(?:.*/)?";
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") re += "[^/]";
    else if (".+^${}()|[]\\".includes(ch)) re += "\\" + ch;
    else re += ch;
  }
  return new RegExp("^" + re + "$");
}

registerTool({
  name: "grep",
  description:
    "Search file contents by regular expression. Returns matching `path:line: text`. " +
    "Scopes to `path` (dir or file, default cwd); optional `glob` filters which files; `ignore_case`.",
  input_schema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "JavaScript regular expression" },
      path: { type: "string", description: "directory or file to search (default: cwd)" },
      glob: { type: "string", description: "only search files whose path matches this glob (e.g. **/*.ts)" },
      ignore_case: { type: "boolean" },
    },
    required: ["pattern"],
  },
  kind: "read",
  async run(input, ctx) {
    let re: RegExp;
    try {
      re = new RegExp(input.pattern, input.ignore_case ? "i" : "");
    } catch (e: any) {
      return `Error: invalid regex: ${e.message}`;
    }
    const root = absOf(input.path, ctx.cwd);
    let isFile = false;
    try {
      isFile = statSync(root).isFile();
    } catch {
      return `Error: no such path: ${input.path ?? "."}`;
    }
    const rel = (abs: string) => toPosix(relative(ctx.cwd, abs)) || toPosix(relative(root, abs));
    const files = isFile ? [root] : walkFiles(root).map((f) => join(root, f));
    const globRe = input.glob ? globToRegExp(input.glob) : null;

    const lines: string[] = [];
    let matches = 0;
    let scanned = 0;
    for (const abs of files) {
      if (matches >= MAX_MATCHES) break;
      const r = toPosix(relative(ctx.cwd, abs));
      if (globRe && !globRe.test(toPosix(relative(isFile ? ctx.cwd : root, abs)))) continue;
      let buf: Buffer;
      try {
        if (statSync(abs).size > MAX_FILE_BYTES) continue;
        buf = readFileSync(abs);
      } catch {
        continue;
      }
      if (isProbablyBinary(buf)) continue;
      scanned++;
      const text = buf.toString("utf8");
      const fileLines = text.split("\n");
      for (let i = 0; i < fileLines.length; i++) {
        if (re.test(fileLines[i])) {
          lines.push(`${r}:${i + 1}: ${fileLines[i].trim().slice(0, 300)}`);
          if (++matches >= MAX_MATCHES) break;
        }
      }
    }
    if (!lines.length) return `No matches for /${input.pattern}/ (scanned ${scanned} files).`;
    let body = lines.join("\n");
    if (body.length > MAX_OUT) body = body.slice(0, MAX_OUT) + "\n…[truncated]";
    const head = matches >= MAX_MATCHES ? `(showing first ${MAX_MATCHES} matches)\n` : "";
    return head + body;
  },
});

registerTool({
  name: "glob",
  description: "List files whose path matches a glob pattern (supports **, *, ?). Scopes to `path` (default cwd).",
  input_schema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "e.g. **/*.ts, src/**/index.*" },
      path: { type: "string", description: "base directory (default: cwd)" },
    },
    required: ["pattern"],
  },
  kind: "read",
  async run(input, ctx) {
    const root = absOf(input.path, ctx.cwd);
    const re = globToRegExp(input.pattern);
    const hits = walkFiles(root).filter((f) => re.test(f));
    if (!hits.length) return `No files match ${input.pattern}.`;
    const shown = hits.slice(0, 400);
    const head = hits.length > shown.length ? `(${hits.length} matches, showing 400)\n` : "";
    return head + shown.join("\n");
  },
});

registerTool({
  name: "ls",
  description: "List the entries of one directory (name, type, size). Non-recursive; use glob/grep to search deeper.",
  input_schema: {
    type: "object",
    properties: { path: { type: "string", description: "directory (default: cwd)" } },
  },
  kind: "read",
  async run(input, ctx) {
    const dir = absOf(input.path, ctx.cwd);
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (e: any) {
      return `Error: cannot list ${input.path ?? "."}: ${e.message}`;
    }
    const rows = entries
      .filter((e) => !(e.isDirectory() && e.name === ".git"))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .map((e) => {
        if (e.isDirectory()) return `  ${e.name}/`;
        let size = 0;
        try {
          size = statSync(join(dir, e.name)).size;
        } catch {
          /* ignore */
        }
        return `  ${e.name}  ${c_size(size)}`;
      });
    return rows.length ? rows.join("\n") : "(empty directory)";
  },
});

function c_size(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${(n / 1024 / 1024).toFixed(1)}M`;
}
