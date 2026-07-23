// Org roles — markdown agent definitions from Hara and Claude Code.
// Frontmatter: name, description, owns[], rejects[], model?, allowTools[]/tools, denyTools[],
// readOnly?, disable-model-invocation?. Body = persona/system, loaded only for the selected role.
import { writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { findProjectRoot } from "../context/agents-md.js";
import { pluginRoleDirs } from "../plugins/plugins.js";
import { readModelContextFileSync } from "../fs-read.js";
import { scanMemory } from "../memory/guard.js";
import { isValidProfileId, resolveActive } from "../profile/profile.js";

const MAX_ROLE_BYTES = 512 * 1024;
const ROLE_DIGEST_CAP = 16_000;
const ROLE_DESCRIPTION_CAP = 180;

export type RoleSource = "plugin" | "org" | "claude-global" | "global" | "claude-project" | "project";

export interface Role {
  id: string;
  description: string;
  owns: string[];
  rejects: string[];
  model?: string;
  allowTools?: string[];
  denyTools?: string[];
  /** Enforce a genuinely read-only tool surface. Reviewer roles default to true unless explicitly disabled. */
  readOnly?: boolean;
  /** Hidden from automatic routing/catalogs, but still addressable explicitly with --role or agent(role). */
  modelInvocable?: boolean;
  /** Why a foreign role stays explicit-only instead of entering automatic routing. */
  compatibilityWarnings?: string[];
  source?: RoleSource;
  file?: string;
  system: string;
}

export function rolesDir(cwd: string): string {
  return join(findProjectRoot(cwd), ".hara", "roles");
}
/** Global roles — reusable personas across all projects. */
export function globalRolesDir(): string {
  return join(homedir(), ".hara", "roles");
}
/** Claude Code's personal subagents are portable role prompts. Read them in place so users do not need
 *  to copy or fork the prompt collection into Hara. Native ~/.hara/roles overrides an id collision. */
export function globalClaudeAgentsDir(): string {
  return join(homedir(), ".claude", "agents");
}
/** Org-pushed roles are identity-scoped. Two organization connections can advertise the same role id
 * with different policy/persona text, so a global shared directory would let the active connection inject
 * prompts into a resumed session owned by another connection. */
export function orgRolesDir(profileId?: string): string {
  const selected = profileId ?? resolveActive().id;
  if (!isValidProfileId(selected)) throw new Error("invalid profile id for organization role storage");
  // Profile ids are case-sensitive in profiles.json, while common macOS/Windows filesystems are not.
  // A fixed lowercase digest prevents OrgA/orga, trailing-dot, and device-name aliases from sharing a
  // managed prompt directory. Domain separation keeps this namespace independent of other identity hashes.
  const storageKey = createHash("sha256")
    .update("hara-org-roles-v1\0")
    .update(selected, "utf8")
    .digest("hex");
  return join(homedir(), ".hara", "org-roles", storageKey);
}
/** Claude-Code subagents (`.claude/agents/*.md`) — consumed for ecosystem interop (project scope). */
export function claudeAgentsDir(cwd: string): string {
  return join(findProjectRoot(cwd), ".claude", "agents");
}
/** Claude-Code tool names → hara tool names, for `.claude/agents` interop. Without this, a CC agent
 *  with `tools: Read, Edit, Bash` produced allowTools that matched ZERO hara tools — the role spawned
 *  with an empty toolbox. Unknown names pass through verbatim (they may be hara names already). */
const CLAUDE_TOOL_MAP: Record<string, string> = {
  read: "read_file",
  edit: "edit_file",
  write: "write_file",
  bash: "bash",
  grep: "grep",
  glob: "glob",
  ls: "ls",
  webfetch: "web_fetch",
  websearch: "web_search",
  agent: "agent",
  task: "agent",
  todowrite: "todo_write",
  notebookedit: "edit_file",
};
/** Accept Claude-Code `tools:` (comma string or list) as an alias for hara's allowTools —
 *  translating CC tool names to hara's. "All tools" / "*" means unrestricted → undefined. */
export function claudeTools(v: unknown): string[] | undefined {
  const raw = Array.isArray(v)
    ? (v as string[])
    : typeof v === "string" && v.trim()
      ? v.split(",").map((s) => s.trim()).filter(Boolean)
      : null;
  if (!raw || !raw.length) return undefined;
  if (raw.some((t) => /^(\*|all tools?)$/i.test(t))) return undefined; // unrestricted
  return raw.map((t) => CLAUDE_TOOL_MAP[t.toLowerCase().replace(/[^a-z]/g, "")] ?? t);
}

function parseFrontmatter(text: string): { fm: Record<string, any>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { fm: {}, body: text.trim() };
  const fm: Record<string, any> = {};
  for (const raw of m[1].split(/\r?\n/)) {
    // This is intentionally a small top-level parser, not YAML. Do not trim before matching: nested
    // metadata such as `persona:\n  name: Vera` must never overwrite the role's top-level `name`.
    if (/^\s/.test(raw)) continue;
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(raw);
    if (!kv) continue;
    const key = kv[1];
    const val = kv[2].trim();
    if (val.startsWith("[") && val.endsWith("]")) {
      fm[key] = val
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    } else {
      fm[key] = val.replace(/^["']|["']$/g, "");
    }
  }
  return { fm, body: m[2].trim() };
}

/** Tool filter for a fan-out sub-agent: ALWAYS read-only (sub-agents run full-auto + unconfirmed +
 *  parallel), with a role allowed to narrow further but never to grant write/exec. `isReadonly` is the
 *  read-kind predicate. This is the guard that keeps the `agent` tool from bypassing the approval gate. */
export function subagentToolFilter(role: Role | undefined, isReadonly: (n: string) => boolean): (n: string) => boolean {
  // Treat allow + deny as an intersection when both are present. A deny must never disappear merely
  // because an allow-list was also declared (mixed policies are common in generated role bundles).
  const roleFilter = role?.allowTools || role?.denyTools
    ? (n: string) => (!role.allowTools || role.allowTools.includes(n)) && (!role.denyTools || !role.denyTools.includes(n))
    : null;
  return (n) => isReadonly(n) && (roleFilter ? roleFilter(n) : true);
}

/** Apply a role's declared tool policy to a normal (approval-gated) run. Undefined means unrestricted. */
export function roleToolFilter(role: Role | undefined): ((name: string) => boolean) | undefined {
  if (!role) return undefined;
  const declared = (name: string): boolean =>
    (!role.allowTools || role.allowTools.includes(name)) && (!role.denyTools || !role.denyTools.includes(name));
  if (role.readOnly) {
    // Raw bash is intentionally absent: even commands that look read-only can hide redirection, command
    // substitution, hooks, or an executable with side effects. Reviewers get dedicated read/search tools.
    const safe = new Set(["read_file", "grep", "glob", "ls", "web_fetch", "web_search", "codebase_search", "todo_write"]);
    return (name) => safe.has(name) && declared(name);
  }
  return role.allowTools || role.denyTools ? declared : undefined;
}

export function loadRoles(cwd: string, profileId?: string): Role[] {
  const selectedProfileId = profileId ?? resolveActive(cwd).id;
  const managedRoleDirs: RoleDir[] = isValidProfileId(selectedProfileId)
    ? [{ dir: orgRolesDir(selectedProfileId), source: "org" }]
    : [];
  // lowest→highest precedence: plugins < org(B-end push) < personal Claude < personal Hara
  // < project Claude < project Hara. A user's native Hara definition intentionally wins an id collision.
  return [...rolesFromDirs([
    ...pluginRoleDirs().map((dir): RoleDir => ({ dir, source: "plugin" })),
    ...managedRoleDirs,
    { dir: globalClaudeAgentsDir(), source: "claude-global" },
    { dir: globalRolesDir(), source: "global" },
    { dir: claudeAgentsDir(cwd), source: "claude-project" },
    { dir: rolesDir(cwd), source: "project" },
  ]).values()];
}

/** The project-independent layers only — what the global agent index lists as "runs anywhere".
 *  Personal Claude Code agents participate directly; no copy/import step is required. */
export function loadGlobalRoles(profileId?: string): Role[] {
  const selectedProfileId = profileId ?? resolveActive().id;
  const managedRoleDirs: RoleDir[] = isValidProfileId(selectedProfileId)
    ? [{ dir: orgRolesDir(selectedProfileId), source: "org" }]
    : [];
  return [...rolesFromDirs([
    ...pluginRoleDirs().map((dir): RoleDir => ({ dir, source: "plugin" })),
    ...managedRoleDirs,
    { dir: globalClaudeAgentsDir(), source: "claude-global" },
    { dir: globalRolesDir(), source: "global" },
  ]).values()];
}

interface RoleDir {
  dir: string;
  source: RoleSource;
}

const isTrue = (value: unknown): boolean => value === true || String(value).toLowerCase() === "true";

function claudeCompatibilityWarnings(description: string, body: string): string[] {
  const warnings: string[] = [];
  if (/\bcalled by\b.*\b(?:only|workflows? only)\b/i.test(description)) warnings.push("workflow-only");
  if (/\b(?:must be used|mandatory before|always use)\b/i.test(description)) {
    warnings.push("mandatory auto-invocation directive");
  }
  if (/localhost:\d+\/notify|YOUR_VOICE_ID(?:_HERE)?|voice notification/i.test(body)) {
    warnings.push("local notification dependency");
  }
  if (/(?:~|\/Users\/[^/\s]+)\/\.claude\/skills\//i.test(body)) warnings.push("Claude-only skill dependency");
  return [...new Set(warnings)];
}

function rolesFromDirs(dirs: RoleDir[]): Map<string, Role> {
  const byId = new Map<string, Role>();
  for (const { dir, source } of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md") || f === "README.md") continue;
      try {
        const file = join(dir, f);
        const { fm, body } = parseFrontmatter(readModelContextFileSync(file, MAX_ROLE_BYTES));
        const id = (fm.name as string) || f.replace(/\.md$/, "");
        const explicitReadOnly = /^(true|false)$/i.test(String(fm.readOnly ?? ""))
          ? String(fm.readOnly).toLowerCase() === "true"
          : undefined;
        const claudeSource = source === "claude-global" || source === "claude-project";
        const compatibilityWarnings = claudeSource
          ? claudeCompatibilityWarnings(String(fm.description ?? ""), body)
          : [];
        const rawModel = fm.model ? String(fm.model) : "";
        const foreignClaudeModel = claudeSource && /^claude(?:[-_.]|$)/i.test(rawModel);
        byId.set(id, {
          id,
          description: (fm.description as string) || "",
          owns: Array.isArray(fm.owns) ? fm.owns : [],
          rejects: Array.isArray(fm.rejects) ? fm.rejects : [],
          // Claude aliases and Claude-provider ids cannot safely switch Hara's active provider — inherit
          // the session model instead of passing a foreign id to (for example) a Qwen/OpenAI endpoint.
          model: rawModel && !/^(sonnet|opus|haiku|inherit)$/i.test(rawModel) && !foreignClaudeModel
            ? rawModel
            : undefined,
          allowTools: Array.isArray(fm.allowTools) ? fm.allowTools : claudeTools(fm.tools),
          denyTools: Array.isArray(fm.denyTools) ? fm.denyTools : undefined,
          readOnly: explicitReadOnly ?? (id.toLowerCase() === "reviewer" ? true : undefined),
          modelInvocable: !isTrue(fm["disable-model-invocation"]) && compatibilityWarnings.length === 0,
          compatibilityWarnings,
          source,
          file,
          system: body,
        });
      } catch {
        /* skip bad role file */
      }
    }
  }
  return byId;
}

function compactRoleDescription(role: Role): string {
  const description = role.description.replace(/\s+/g, " ").trim();
  if (!description || !scanMemory(description).ok) return "";
  return description.length > ROLE_DESCRIPTION_CAP
    ? description.slice(0, ROLE_DESCRIPTION_CAP - 1).trimEnd() + "…"
    : description;
}

/** Compact metadata catalog for dispatch/planning. Role bodies remain progressive: only the selected role's
 *  persona is injected into its run. Descriptions are bounded and guarded because plugin roles can be
 *  untrusted. */
export function roleCatalog(roles: Role[], cap = ROLE_DIGEST_CAP): string {
  const lines: string[] = [];
  const sourceRank: Record<RoleSource, number> = {
    project: 0,
    "claude-project": 1,
    global: 2,
    "claude-global": 3,
    org: 4,
    plugin: 5,
  };
  const ordered = [...roles].sort((a, b) => {
    const source = (sourceRank[a.source ?? "plugin"] ?? 9) - (sourceRank[b.source ?? "plugin"] ?? 9);
    if (source) return source;
    const ownership = Number(b.owns.length > 0) - Number(a.owns.length > 0);
    if (ownership) return ownership;
    return a.id.localeCompare(b.id);
  });
  for (const role of ordered) {
    if (role.modelInvocable === false) continue;
    const description = compactRoleDescription(role);
    if (!description) continue;
    const flags = [role.readOnly ? "read-only" : "", role.source?.startsWith("claude-") ? "Claude-compatible" : ""]
      .filter(Boolean)
      .join(", ");
    lines.push(`- ${role.id}${flags ? ` [${flags}]` : ""}: ${description}`);
  }
  let digest = lines.join("\n");
  if (digest.length > cap) digest = digest.slice(0, cap) + "\n…";
  return digest;
}

let roleDigestCache = new Map<string, string>();

/** Frozen-per-session specialist index for the ordinary Hara agent. This is the missing Claude-style
 *  discovery layer: the main agent sees role metadata, then loads only the chosen persona through agent/org. */
export function rolesDigest(cwd: string, profileId?: string): string {
  const selectedProfileId = profileId ?? resolveActive(cwd).id;
  const cacheKey = `${cwd}\0${selectedProfileId}`;
  if (roleDigestCache.has(cacheKey)) return roleDigestCache.get(cacheKey)!;
  const digest = roleCatalog(loadRoles(cwd, selectedProfileId));
  roleDigestCache.set(cacheKey, digest);
  return digest;
}

export function invalidateRolesCache(): void {
  roleDigestCache.clear();
}

export function hasRoles(cwd: string, profileId?: string): boolean {
  return loadRoles(cwd, profileId).length > 0;
}

const SCAFFOLD: Record<string, string> = {
  "implementer.md": `---
name: implementer
description: Implements features, fixes bugs, and refactors code.
owns: [implement, add, feature, fix, bug, refactor, build, create, write, change]
model:
---
You are the **implementer** on an engineering team. You write and change code to satisfy the task.
Make small, verifiable edits (prefer edit_file over rewriting). Run tests/build when relevant.
End with a one-line summary of what changed.
`,
  "reviewer.md": `---
name: reviewer
description: Reviews code for bugs, correctness, security, and style. Does not modify code.
owns: [review, audit, check, correctness, security, vulnerability, lint, quality]
allowTools: [read_file, grep, glob, ls, codebase_search]
readOnly: true
---
You are the **reviewer**. Read the relevant code and report concrete issues (bug / correctness /
security / style) with file:line and a suggested fix. Do NOT edit files — your tool surface is enforced read-only.
Be specific; skip nitpicks unless asked.
`,
  "docs.md": `---
name: docs
description: Writes and updates documentation, READMEs, and code comments.
owns: [doc, docs, document, readme, comment, explain, guide, changelog]
---
You are the **docs** writer. Produce clear, concise documentation grounded in the actual code.
Update or create the relevant files with write_file/edit_file. Match the project's existing tone.
`,
  "README.md": `# Org roles

Each \`*.md\` here is a role-agent. Frontmatter:

- \`name\` — role id
- \`description\` — what it owns (used by the dispatcher)
- \`owns\` — keywords that route a task here (OWN)
- \`rejects\` — keywords that exclude this role (REJECT)
- \`model\` — optional model override
- \`allowTools\` / \`denyTools\` — restrict the role's tools
- \`readOnly\` — enforce read/search-only tools (defaults on for a role named \`reviewer\`)
- \`disable-model-invocation\` — hide the role from automatic routing while keeping explicit \`--role\` use

Run \`hara org "<task>"\` to dispatch a task to the owning role, or \`hara org --role <id> "<task>"\`.
`,
};

export function scaffoldRoles(cwd: string): string[] {
  const dir = rolesDir(cwd);
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  for (const [name, content] of Object.entries(SCAFFOLD)) {
    const p = join(dir, name);
    if (!existsSync(p)) {
      writeFileSync(p, content, "utf8");
      written.push(name);
    }
  }
  if (written.length) invalidateRolesCache();
  return written;
}
