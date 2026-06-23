// Org roles — markdown agent definitions in <project>/.hara/roles/*.md.
// Frontmatter: name, description, owns[], rejects[], model?, allowTools[], denyTools[]. Body = persona/system.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { findProjectRoot } from "../context/agents-md.js";
import { pluginRoleDirs } from "../plugins/plugins.js";

export interface Role {
  id: string;
  description: string;
  owns: string[];
  rejects: string[];
  model?: string;
  allowTools?: string[];
  denyTools?: string[];
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
/** Accept Claude-Code `tools:` (comma string or list) as an alias for hara's allowTools. */
function claudeTools(v: unknown): string[] | undefined {
  if (Array.isArray(v)) return v as string[];
  if (typeof v === "string" && v.trim()) return v.split(",").map((s) => s.trim()).filter(Boolean);
  return undefined;
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
  const roleFilter = role?.allowTools
    ? (n: string) => role.allowTools!.includes(n)
    : role?.denyTools
      ? (n: string) => !role.denyTools!.includes(n)
      : null;
  return (n) => isReadonly(n) && (roleFilter ? roleFilter(n) : true);
}

export function loadRoles(cwd: string): Role[] {
  const byId = new Map<string, Role>();
  // lowest→highest precedence: plugins < org(B-end push) < global < .claude/agents < .hara/roles (project wins)
  for (const dir of [...pluginRoleDirs(), orgRolesDir(), globalRolesDir(), claudeAgentsDir(cwd), rolesDir(cwd)]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md") || f === "README.md") continue;
      try {
        const { fm, body } = parseFrontmatter(readFileSync(join(dir, f), "utf8"));
        const id = (fm.name as string) || f.replace(/\.md$/, "");
        byId.set(id, {
          id,
          description: (fm.description as string) || "",
          owns: Array.isArray(fm.owns) ? fm.owns : [],
          rejects: Array.isArray(fm.rejects) ? fm.rejects : [],
          model: fm.model || undefined,
          allowTools: Array.isArray(fm.allowTools) ? fm.allowTools : claudeTools(fm.tools),
          denyTools: Array.isArray(fm.denyTools) ? fm.denyTools : undefined,
          system: body,
        });
      } catch {
        /* skip bad role file */
      }
    }
  }
  return [...byId.values()];
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
allowTools: [read_file, bash]
---
You are the **reviewer**. Read the relevant code and report concrete issues (bug / correctness /
security / style) with file:line and a suggested fix. Do NOT edit files — you have read-only tools.
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
