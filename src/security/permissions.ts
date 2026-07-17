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
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { psArgumentsExposeEnvironment } from "./sensitive-files.js";
import { projectRepositoryTrustedAtStartup } from "./project-trust.js";
import { readVerifiedRegularFileSnapshotSync } from "../fs-read.js";
import { homeWorkspaceActionError, isHomeWorkspace, isUnsafeProjectWorkspace } from "../context/workspace-scope.js";
import { sameOpenedFileIdentity } from "../fs-identity.js";

export type Decision = "allow" | "ask" | "deny";
export interface PermissionRules {
  allow: string[];
  deny: string[];
  readonlyAutorun: boolean; // auto-run read-only commands (ls/grep/git status…) without a prompt
}
const PROJECT_ROOT_MARKERS = [".git", "package.json", "Cargo.toml", "go.mod", "pyproject.toml", ".hg"];
const MAX_PROJECT_PERMISSIONS_BYTES = 64 * 1024;
const projectPermissionWarnings = new Set<string>();

// Programs that are read-only when run as a plain command (no dangerous flags / redirection — see below).
const READONLY_PROGRAMS = new Set([
  "ls", "pwd", "cat", "head", "tail", "wc", "grep", "rg", "fd", "stat", "file", "which",
  "type", "whoami", "id", "date", "tree", "du", "df", "ps", "uname", "hostname", "dirname", "basename",
  "realpath", "sort", "uniq", "cut", "column", "jq", "true", "false",
]);
// `git <sub>` is read-only only for these subcommands.
const GIT_READONLY_SUB = new Set([
  "describe", "rev-parse", "ls-files", "shortlog", "rev-list", "name-rev",
]);
// Flags that can turn an otherwise-read-only command destructive → disqualify from autorun.
const DANGER_FLAG = /(^|\s)(-i\b|-o\b|--output\b|--exec\b|-delete\b|-fprint\b|--write\b|-w\b|--in-place\b)/;

function gitPatchOutputRequested(args: readonly string[]): boolean {
  for (const arg of args) {
    if (arg === "--") break;
    if (/^-[^-]*[mpucUW]/u.test(arg)) return true;
    if (
      /^(?:--patch|--patch-with-raw|--patch-with-stat|--unified|--word-diff|--word-diff-regex|--color-words|--cc|--combined-all-paths|--diff-merges|--remerge-diff|--binary|--check|--function-context|--inter-hunk-context)(?:=|$)/u.test(arg)
    ) return true;
  }
  return false;
}

function gitDiffIsMetadataOnly(args: readonly string[]): boolean {
  let metadata = false;
  for (const arg of args) {
    if (arg === "--") break;
    if (gitPatchOutputRequested([arg])) return false;
    if (/^--(?:stat(?:=.*)?|name-only|name-status|numstat)$/u.test(arg)) {
      metadata = true;
      continue;
    }
    if (
      /^(?:-z|--cached|--staged|--merge-base|--no-renames|--no-ext-diff|--no-textconv)$/u.test(arg)
      || /^--(?:relative|ignore-submodules|submodule|diff-filter|stat-width|stat-name-width|stat-graph-width|stat-count|abbrev)(?:=|$)/u.test(arg)
    ) continue;
    // Revisions and pathspecs are positional. Unknown options may enable content or external helpers, so
    // a metadata flag does not make them safe automatically.
    if (arg.startsWith("-")) return false;
  }
  return metadata;
}

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
  if (/\$(?:\{)?[A-Za-z_][A-Za-z0-9_]*/.test(canonical)) return false; // variable expansion may print a credential
  if (/^jq\b[\s\S]*(?:\benv\b|\$ENV\b)/.test(canonical)) return false;
  if (DANGER_FLAG.test(canonical)) return false;
  const parts = canonical.split(" ");
  const prog = parts[0];
  // `ps` is normally read-only, but BSD/GNU environment display modifiers turn it into a credential
  // disclosure command. It must never inherit readonly auto-approval (the shell boundary also hard-denies it).
  if (prog === "ps" && psArgumentsExposeEnvironment(parts.slice(1))) return false;
  if (prog === "git") {
    const sub = parts[1] ?? "";
    const args = parts.slice(2);
    // Git can expose deleted credential contents without touching the current filesystem. Autorun only
    // explicit metadata diffs; history commands that inherently print file bodies always require approval.
    if (sub === "diff") return gitDiffIsMetadataOnly(args);
    if (sub === "log" || sub === "whatchanged") return !gitPatchOutputRequested(args);
    if (sub === "status") {
      return !args.some((arg) => arg === "--verbose" || /^-[^-]*v/u.test(arg));
    }
    if (sub === "config") return false; // values may be credentials (http.extraHeader, credential helpers, URLs)
    if (GIT_READONLY_SUB.has(sub)) return true;
    if (sub === "branch") {
      if (!args.length) return true;
      // Bare branch names create/delete/move branches. Autorun only explicit display/query forms.
      return args.some((arg) => ["--list", "-l", "--show-current", "-a", "--all", "-r", "--remotes", "-v", "-vv", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--format", "--sort"].includes(arg))
        && !args.some((arg) => ["-d", "-D", "-m", "-M", "-c", "-C", "--delete", "--move", "--copy", "--edit-description", "--set-upstream-to", "--unset-upstream"].includes(arg));
    }
    if (sub === "tag") {
      if (!args.length) return true;
      return args.some((arg) => ["--list", "-l", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--format", "--sort"].includes(arg))
        && !args.some((arg) => ["-d", "--delete", "-f", "--force", "-a", "--annotate", "-s", "--sign", "-u", "--local-user"].includes(arg));
    }
    if (sub === "remote") {
      // Bare `git remote` lists names only. Verbose/get-url/show variants can print credential-bearing URLs;
      // mutating and networked variants are not readonly-autorun candidates either.
      return args.length === 0;
    }
    return false;
  }
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

function permissionRecord(raw: string): Partial<PermissionRules> {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const j = parsed as Record<string, unknown>;
    return {
      allow: Array.isArray(j.allow) ? (j.allow as string[]).filter((x) => typeof x === "string") : undefined,
      deny: Array.isArray(j.deny) ? (j.deny as string[]).filter((x) => typeof x === "string") : undefined,
      readonlyAutorun: typeof j.readonlyAutorun === "boolean" ? j.readonlyAutorun : undefined,
    };
  } catch {
    return {};
  }
}

function readGlobalRules(p: string): Partial<PermissionRules> {
  if (!existsSync(p)) return {};
  try { return permissionRecord(readFileSync(p, "utf8")); } catch { return {}; }
}

function warnProjectPermissions(kind: string, message: string): void {
  if (projectPermissionWarnings.has(kind)) return;
  projectPermissionWarnings.add(kind);
  try { process.stderr.write(`hara: ${message}\n`); } catch { /* best effort */ }
}

function unsafeProjectPermissions(kind: string): Partial<PermissionRules> {
  warnProjectPermissions(
    `unsafe-file:${kind}`,
    `ignored an unsafe project .hara/permissions.json (${kind}); no project permission values were loaded.`,
  );
  return {};
}

/** Read the nearest repository permission file through a bounded O_NOFOLLOW descriptor. The repository's
 * `.hara` parent is part of the trust boundary too: neither it nor the final file may be an alias, and both
 * identities are rechecked after the read. */
function readProjectRules(cwd: string): Partial<PermissionRules> {
  let dir: string;
  try { dir = realpathSync.native(resolve(cwd)); } catch { dir = resolve(cwd); }
  for (;;) {
    // ~/.hara/permissions.json is global policy, not a project policy file. Stopping before Home also
    // prevents an unmarked child workspace from inheriting a repository marker above the user's home.
    if (isHomeWorkspace(dir)) break;
    const hara = join(dir, ".hara");
    const file = join(hara, "permissions.json");
    let parentInfo;
    try {
      parentInfo = lstatSync(hara);
    } catch (error: any) {
      if (error?.code !== "ENOENT") return unsafeProjectPermissions("unreadable parent");
    }
    if (parentInfo) {
      if (parentInfo.isSymbolicLink()) return unsafeProjectPermissions("symlink parent");
      if (!parentInfo.isDirectory()) return unsafeProjectPermissions("non-directory parent");
      try {
        if (realpathSync.native(hara) !== hara) return unsafeProjectPermissions("non-canonical parent");
        const fileInfo = lstatSync(file);
        if (fileInfo.isSymbolicLink()) return unsafeProjectPermissions("symlink file");
        if (!fileInfo.isFile()) return unsafeProjectPermissions("non-regular file");
        const snapshot = readVerifiedRegularFileSnapshotSync(file, MAX_PROJECT_PERMISSIONS_BYTES, {
          action: "read project permissions",
          protectSensitive: false,
          rejectHardLinks: true,
        });
        const parentAfter = lstatSync(hara);
        if (
          !parentAfter.isDirectory()
          || parentAfter.isSymbolicLink()
          || parentAfter.dev !== parentInfo.dev
          || parentAfter.ino !== parentInfo.ino
          || realpathSync.native(hara) !== hara
        ) return unsafeProjectPermissions("changed parent");
        return permissionRecord(snapshot.text);
      } catch (error: any) {
        if (error?.code === "ENOENT") {
          // No file in this directory; continue toward the repository root.
        } else if (error?.code === "HARA_HARD_LINKED_FILE") {
          return unsafeProjectPermissions("hard-linked file");
        } else if (error?.code === "HARA_FILE_TOO_LARGE") {
          return unsafeProjectPermissions("oversized file");
        } else if (/changed while (?:opening|reading)|File changed|path changed/i.test(error?.message ?? "")) {
          return unsafeProjectPermissions("changed file");
        } else {
          return unsafeProjectPermissions("invalid file");
        }
      }
    }
    if (PROJECT_ROOT_MARKERS.some((marker) => existsSync(join(dir, marker)))) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return {};
}

export function globalPermissionsPath(): string {
  return join(homedir(), ".hara", "permissions.json");
}
/** Nearest project `.hara/permissions.json`, cwd → repo root. */
export function projectPermissionsPath(cwd: string): string | null {
  let dir = resolve(cwd);
  for (;;) {
    if (isHomeWorkspace(dir)) break;
    const p = join(dir, ".hara", "permissions.json");
    if (existsSync(p)) return p;
    if (PROJECT_ROOT_MARKERS.some((m) => existsSync(join(dir, m)))) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Effective rules: an untrusted repository may only tighten policy (add deny rules or turn readonly
 * autorun off). Project allow rules and a readonlyAutorun=true expansion require the launch-time trust flag.
 * Missing/invalid files use safe defaults; every deny remains deny-wins. */
export function loadPermissionRules(cwd: string): PermissionRules {
  const g = readGlobalRules(globalPermissionsPath());
  const p = readProjectRules(cwd);
  const trustedProject = projectRepositoryTrustedAtStartup();
  const globalReadonly = g.readonlyAutorun ?? DEFAULTS.readonlyAutorun;
  const privileged = [
    ...(p.allow?.length ? ["allow"] : []),
    ...(p.readonlyAutorun === true ? ["readonlyAutorun"] : []),
  ];
  if (privileged.length) {
    const names = privileged.join(", ");
    if (trustedProject) {
      warnProjectPermissions(
        `trusted:${names}`,
        `trusted project permissions enabled for privileged key(s): ${names}.`,
      );
    } else {
      warnProjectPermissions(
        `ignored:${names}`,
        `ignored untrusted project permission expansion(s): ${names}. Project deny rules and readonlyAutorun=false still tighten policy. ` +
          "Set HARA_TRUST_PROJECT_CONFIG=1 before starting hara only for a repository you trust.",
      );
    }
  }
  return {
    allow: [...(g.allow ?? []), ...(trustedProject ? (p.allow ?? []) : [])],
    deny: [...(g.deny ?? []), ...(p.deny ?? [])],
    readonlyAutorun: trustedProject
      ? (p.readonlyAutorun ?? globalReadonly)
      : (p.readonlyAutorun === false ? false : globalReadonly),
  };
}

const SCAFFOLD = {
  allow: ["npm test", "npm run lint", "npm run build", "git commit"],
  deny: ["git push", "rm -rf", "sudo", "git reset --hard"],
  readonlyAutorun: true,
};

interface DirectoryIdentity {
  dev: number;
  ino: number;
}

function verifiedDirectory(path: string, expected?: DirectoryIdentity): DirectoryIdentity {
  const info = lstatSync(path);
  if (
    !info.isDirectory()
    || info.isSymbolicLink()
    || realpathSync.native(path) !== path
    || (expected && (info.dev !== expected.dev || info.ino !== expected.ino))
  ) throw new Error(`refusing project permissions write: parent directory identity is unsafe or changed`);
  return { dev: info.dev, ino: info.ino };
}

function existingScaffoldTarget(path: string): boolean {
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) throw new Error("refusing project permissions write: destination is a symlink");
    if (!info.isFile()) throw new Error("refusing project permissions write: destination is not a regular file");
    if (info.nlink > 1) throw new Error("refusing project permissions write: destination is hard-linked");
    return true;
  } catch (error: any) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

/** Create project permissions without following `.hara` or replacing any existing directory entry. */
function scaffoldProjectPermissions(cwd: string): string | null {
  const project = realpathSync.native(resolve(cwd));
  // Project scaffolding at ~/ would target the same ~/.hara/permissions.json used by global policy and
  // silently promote repository starter rules to every Hara session. Reject before creating `.hara`.
  if (isUnsafeProjectWorkspace(project)) throw new Error(homeWorkspaceActionError("create project permissions"));
  const projectIdentity = verifiedDirectory(project);
  const parent = join(project, ".hara");
  try {
    lstatSync(parent);
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
    verifiedDirectory(project, projectIdentity);
    try { mkdirSync(parent, { mode: 0o700 }); } catch (mkdirError: any) {
      if (mkdirError?.code !== "EEXIST") throw mkdirError;
    }
  }
  const parentIdentity = verifiedDirectory(parent);
  const target = join(parent, "permissions.json");
  if (existingScaffoldTarget(target)) return null;

  const temp = join(parent, `.hara-permissions-${process.pid}-${randomUUID()}.tmp`);
  let fd: number | undefined;
  let tempIdentity: { dev: number; ino: number } | undefined;
  let committed = false;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(SCAFFOLD, null, 2) + "\n", "utf8");
    fsyncSync(fd);
    const opened = fstatSync(fd);
    tempIdentity = { dev: opened.dev, ino: opened.ino };
    closeSync(fd);
    fd = undefined;

    verifiedDirectory(parent, parentIdentity);
    const staged = lstatSync(temp);
    if (!staged.isFile() || staged.isSymbolicLink() || !sameOpenedFileIdentity(staged, tempIdentity)) {
      throw new Error("refusing project permissions write: staging file identity changed");
    }
    verifiedDirectory(parent, parentIdentity);
    try {
      // Hard-link commit is create-if-absent on every supported platform; unlike rename it cannot overwrite
      // a symlink/hard-link/ordinary file planted after preflight.
      linkSync(temp, target);
    } catch (error: any) {
      if (error?.code === "EEXIST") {
        if (existingScaffoldTarget(target)) return null;
      }
      throw error;
    }
    verifiedDirectory(parent, parentIdentity);
    const written = lstatSync(target);
    if (!written.isFile() || written.isSymbolicLink() || !sameOpenedFileIdentity(written, tempIdentity)) {
      throw new Error("refusing project permissions write: committed file identity changed");
    }
    unlinkSync(temp);
    committed = true;
    return target;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* best effort */ }
    if (!committed && tempIdentity) {
      try {
        verifiedDirectory(parent, parentIdentity);
        const current = lstatSync(temp);
        if (current.isFile() && sameOpenedFileIdentity(current, tempIdentity)) unlinkSync(temp);
      } catch {
        /* Retain an uncertain private staging file rather than unlinking an attacker-controlled replacement. */
      }
    }
  }
}

/** Write a starter permissions.json (global by default). Returns the path, or null if one already exists. */
export function scaffoldPermissions(cwd: string, scope: "global" | "project" = "global"): string | null {
  if (scope === "project") return scaffoldProjectPermissions(cwd);
  const p = globalPermissionsPath();
  if (existsSync(p)) return null;
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(SCAFFOLD, null, 2) + "\n", "utf8");
  return p;
}
