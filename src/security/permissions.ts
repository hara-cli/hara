// Fine-grained, command-level permission policy for the `bash` tool — the layer that turns "confirm every
// command" / "full-auto, unguarded" into a personal allow/ask/deny policy. Pure-Node, zero-dep. This is
// governance-as-config (hara's moat): it composes with approval modes rather than replacing them.
//
// Rules live in ~/.hara/permissions.json (+ a project .hara/permissions.json, deny-wins on merge):
//   { "allow": ["npm test", "git commit", "npm run *"], "deny": ["git push", "rm -rf", "sudo"],
//     "readonlyAutorun": true }
// A pattern matches a command if the canonical command equals it, starts with "<pattern> ", or glob-matches
// (with `*`). The decision for a compound command (&&, ||, ;, |) is the STRICTEST of its parts
// (deny > ask > allow); anything we can't safely parse fails CLOSED to "ask".
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

export type Decision = "allow" | "ask" | "deny";
export interface PermissionRules {
  allow: string[];
  deny: string[];
  readonlyAutorun: boolean; // auto-run read-only commands (ls/grep/git status…) without a prompt
}
const PROJECT_ROOT_MARKERS = [".git", "package.json", "Cargo.toml", "go.mod", "pyproject.toml", ".hg"];

// Programs that are read-only when run as a plain command (no dangerous flags / redirection — see below).
const READONLY_PROGRAMS = new Set([
  "ls", "pwd", "cat", "head", "tail", "wc", "echo", "printf", "grep", "rg", "fd", "stat", "file", "which",
  "type", "whoami", "id", "date", "tree", "du", "df", "ps", "uname", "hostname", "dirname", "basename",
  "realpath", "sort", "uniq", "cut", "column", "jq", "true", "false", "env",
]);
// `git <sub>` is read-only only for these subcommands.
const GIT_READONLY_SUB = new Set([
  "status", "log", "diff", "show", "branch", "remote", "tag", "describe", "rev-parse", "ls-files",
  "ls-remote", "config", "blame", "shortlog", "cat-file", "whatchanged", "grep", "rev-list", "name-rev",
]);
// Flags that can turn an otherwise-read-only command destructive → disqualify from autorun.
const DANGER_FLAG = /(^|\s)(-i\b|-o\b|--output\b|--exec\b|-delete\b|-fprint\b|--write\b|-w\b|--in-place\b)/;

/** Unwrap shell wrappers and strip leading env/wrappers to get the command's essential form. Lossy on
 *  purpose — used only for matching/classification, never for execution. */
export function canonicalize(command: string): string {
  let cmd = command.trim();
  // Unwrap `bash -lc "…"` / `sh -c '…'` / `zsh -c …` (one level).
  const wrap = /^(?:\/usr\/bin\/|\/bin\/)?(?:ba|z)?sh\s+-[a-z]*c\s+(['"])([\s\S]*)\1\s*$/.exec(cmd);
  if (wrap) cmd = wrap[2].trim();
  // Strip leading `VAR=val` assignments (NODE_ENV=production foo …).
  while (/^[A-Za-z_][A-Za-z0-9_]*=[^\s]*\s+/.test(cmd)) cmd = cmd.replace(/^[A-Za-z_][A-Za-z0-9_]*=[^\s]*\s+/, "");
  // Strip benign leading wrappers that don't change what's actually run.
  for (;;) {
    const m = /^(timeout\s+\d+[a-z]?\s+|time\s+|nice\s+(-n\s+-?\d+\s+)?|command\s+|\\)/.exec(cmd);
    if (!m) break;
    cmd = cmd.slice(m[0].length).trimStart();
  }
  return cmd.replace(/\s+/g, " ").trim();
}

/** True if the (already-canonical, simple) command is read-only and safe to autorun. */
export function isReadOnlyCommand(canonical: string): boolean {
  if (!canonical) return false;
  if (/[>]/.test(canonical)) return false; // any output redirection → not read-only
  if (DANGER_FLAG.test(canonical)) return false;
  const parts = canonical.split(" ");
  const prog = parts[0];
  if (prog === "git") return GIT_READONLY_SUB.has(parts[1] ?? "");
  return READONLY_PROGRAMS.has(prog);
}

/** Split a command on top-level shell operators (&&, ||, ;, |, newline), quote-aware. Returns null if the
 *  command uses constructs we don't safely model (command substitution / backticks / unbalanced quotes) —
 *  the caller then fails closed. */
export function splitCompound(command: string): string[] | null {
  const parts: string[] = [];
  let buf = "";
  let sq = false, dq = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const next = command[i + 1];
    if (sq) { if (ch === "'") sq = false; buf += ch; continue; }
    if (dq) { if (ch === '"') dq = false; buf += ch; continue; }
    if (ch === "'") { sq = true; buf += ch; continue; }
    if (ch === '"') { dq = true; buf += ch; continue; }
    if (ch === "`") return null; // backtick command substitution → can't model, fail closed
    if (ch === "$" && next === "(") return null; // $(…) substitution → fail closed
    if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) { parts.push(buf); buf = ""; i++; continue; }
    if (ch === ";" || ch === "|" || ch === "\n" || ch === "&") { parts.push(buf); buf = ""; continue; }
    buf += ch;
  }
  if (sq || dq) return null; // unbalanced quotes → fail closed
  parts.push(buf);
  return parts.map((p) => canonicalize(p)).filter(Boolean);
}

/** Match a canonical command against a single rule pattern: exact, prefix (pattern + space), or glob (*). */
export function matchesPattern(canonical: string, pattern: string): boolean {
  const pat = canonicalize(pattern);
  if (!pat) return false;
  if (pat.includes("*")) {
    const re = new RegExp("^" + pat.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
    return re.test(canonical);
  }
  return canonical === pat || canonical.startsWith(pat + " ");
}

const STRICTNESS: Record<Decision, number> = { allow: 0, ask: 1, deny: 2 };
const strictest = (ds: Decision[]): Decision => ds.reduce<Decision>((a, b) => (STRICTNESS[b] > STRICTNESS[a] ? b : a), "allow");

/** Decide a single simple (canonical) command against the rules. deny > allow-rule > read-only > ask. */
function decideSimple(canonical: string, rules: PermissionRules): Decision {
  if (rules.deny.some((p) => matchesPattern(canonical, p))) return "deny";
  if (rules.allow.some((p) => matchesPattern(canonical, p))) return "allow";
  if (rules.readonlyAutorun && isReadOnlyCommand(canonical)) return "allow";
  return "ask";
}

/** Decide a (possibly compound) shell command. Strictest part wins; unparseable → deny if any deny pattern
 *  hits the whole string, else "ask" (fail closed). */
export function decideCommand(command: string, rules: PermissionRules): Decision {
  const canonical = canonicalize(command);
  const parts = splitCompound(command);
  if (!parts) {
    return rules.deny.some((p) => matchesPattern(canonical, p)) ? "deny" : "ask";
  }
  if (!parts.length) return "ask";
  return strictest(parts.map((p) => decideSimple(p, rules)));
}

const DEFAULTS: PermissionRules = { allow: [], deny: [], readonlyAutorun: true };

function readRules(p: string): Partial<PermissionRules> {
  if (!existsSync(p)) return {};
  try {
    const j = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    return {
      allow: Array.isArray(j.allow) ? (j.allow as string[]).filter((x) => typeof x === "string") : undefined,
      deny: Array.isArray(j.deny) ? (j.deny as string[]).filter((x) => typeof x === "string") : undefined,
      readonlyAutorun: typeof j.readonlyAutorun === "boolean" ? j.readonlyAutorun : undefined,
    };
  } catch {
    return {};
  }
}

export function globalPermissionsPath(): string {
  return join(homedir(), ".hara", "permissions.json");
}
/** Nearest project `.hara/permissions.json`, cwd → repo root. */
export function projectPermissionsPath(cwd: string): string | null {
  let dir = resolve(cwd);
  for (;;) {
    const p = join(dir, ".hara", "permissions.json");
    if (existsSync(p)) return p;
    if (PROJECT_ROOT_MARKERS.some((m) => existsSync(join(dir, m)))) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Effective rules: project ∪ global, deny-wins (union of denies); project's readonlyAutorun overrides
 *  global's. Missing/invalid files → safe defaults (read-only autorun on, no allow/deny rules). */
export function loadPermissionRules(cwd: string): PermissionRules {
  const g = readRules(globalPermissionsPath());
  const projPath = projectPermissionsPath(cwd);
  const p = projPath ? readRules(projPath) : {};
  return {
    allow: [...(g.allow ?? []), ...(p.allow ?? [])],
    deny: [...(g.deny ?? []), ...(p.deny ?? [])],
    readonlyAutorun: p.readonlyAutorun ?? g.readonlyAutorun ?? DEFAULTS.readonlyAutorun,
  };
}

const SCAFFOLD = {
  allow: ["npm test", "npm run lint", "npm run build", "git commit"],
  deny: ["git push", "rm -rf", "sudo", "git reset --hard"],
  readonlyAutorun: true,
};

/** Write a starter permissions.json (global by default). Returns the path, or null if one already exists. */
export function scaffoldPermissions(cwd: string, scope: "global" | "project" = "global"): string | null {
  const p = scope === "project" ? join(resolve(cwd), ".hara", "permissions.json") : globalPermissionsPath();
  if (existsSync(p)) return null;
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(SCAFFOLD, null, 2) + "\n", "utf8");
  return p;
}
