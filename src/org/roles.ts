// Org roles — markdown agent definitions in <project>/.hara/roles/*.md.
// Frontmatter: name, description, owns[], rejects[], model?, allowTools[], denyTools[], readOnly?. Body = persona/system.
import { writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { findProjectRoot } from "../context/agents-md.js";
import { pluginRoleDirs } from "../plugins/plugins.js";
import { readModelContextFileSync } from "../fs-read.js";

const MAX_ROLE_BYTES = 512 * 1024;

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
  system: string;
}

export function rolesDir(cwd: string): string {
  return join(findProjectRoot(cwd), ".hara", "roles");
}
/** Global roles — reusable personas across all projects. */
export function globalRolesDir(): string {
  return join(homedir(), ".hara", "roles");
}
/** Org-pushed roles (B-end): the digital-employee bundle synced from hara-control's `/v1/roles` into
 *  `~/.hara/org-roles/*.md` (see org-fleet/enroll.ts syncOrgRoles). A managed baseline — above
 *  third-party plugins, but a dev's own global/project roles still win. */
export function orgRolesDir(): string {
  return join(homedir(), ".hara", "org-roles");
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
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m) return { fm: {}, body: text.trim() };
  const fm: Record<string, any> = {};
  for (const raw of m[1].split("\n")) {
    const line = raw.trim();
    const kv = /^([A-Za-z0-9_]+)\s*:\s*(.*)$/.exec(line);
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

export function loadRoles(cwd: string): Role[] {
  // lowest→highest precedence: plugins < org(B-end push) < global < .claude/agents < .hara/roles (project wins)
  return [...rolesFromDirs([...pluginRoleDirs(), orgRolesDir(), globalRolesDir(), claudeAgentsDir(cwd), rolesDir(cwd)]).values()];
}

/** The project-independent layers only (plugins + org-pushed + ~/.hara/roles) — what the global agent
 *  index lists as "runs anywhere". Excludes cwd-derived layers by construction. */
export function loadGlobalRoles(): Role[] {
  return [...rolesFromDirs([...pluginRoleDirs(), orgRolesDir(), globalRolesDir()]).values()];
}

function rolesFromDirs(dirs: string[]): Map<string, Role> {
  const byId = new Map<string, Role>();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md") || f === "README.md") continue;
      try {
        const { fm, body } = parseFrontmatter(readModelContextFileSync(join(dir, f), MAX_ROLE_BYTES));
        const id = (fm.name as string) || f.replace(/\.md$/, "");
        const explicitReadOnly = /^(true|false)$/i.test(String(fm.readOnly ?? ""))
          ? String(fm.readOnly).toLowerCase() === "true"
          : undefined;
        byId.set(id, {
          id,
          description: (fm.description as string) || "",
          owns: Array.isArray(fm.owns) ? fm.owns : [],
          rejects: Array.isArray(fm.rejects) ? fm.rejects : [],
          // Claude-Code model ALIASES (sonnet/opus/haiku/inherit) aren't hara model ids — treat as
          // "inherit the session model" rather than passing a string no provider resolves.
          model: fm.model && !/^(sonnet|opus|haiku|inherit)$/i.test(String(fm.model)) ? fm.model : undefined,
          allowTools: Array.isArray(fm.allowTools) ? fm.allowTools : claudeTools(fm.tools),
          denyTools: Array.isArray(fm.denyTools) ? fm.denyTools : undefined,
          readOnly: explicitReadOnly ?? (id.toLowerCase() === "reviewer" ? true : undefined),
          system: body,
        });
      } catch {
        /* skip bad role file */
      }
    }
  }
  return byId;
}

export function hasRoles(cwd: string): boolean {
  return loadRoles(cwd).length > 0;
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
  return written;
}
