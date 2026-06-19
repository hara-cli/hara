// Org roles — markdown agent definitions in <project>/.hara/roles/*.md.
// Frontmatter: name, description, owns[], rejects[], model?, allowTools[], denyTools[]. Body = persona/system.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { findProjectRoot } from "../context/agents-md.js";

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

export function loadRoles(cwd: string): Role[] {
  const dir = rolesDir(cwd);
  if (!existsSync(dir)) return [];
  const roles: Role[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md") || f === "README.md") continue;
    try {
      const { fm, body } = parseFrontmatter(readFileSync(join(dir, f), "utf8"));
      roles.push({
        id: (fm.name as string) || f.replace(/\.md$/, ""),
        description: (fm.description as string) || "",
        owns: Array.isArray(fm.owns) ? fm.owns : [],
        rejects: Array.isArray(fm.rejects) ? fm.rejects : [],
        model: fm.model || undefined,
        allowTools: Array.isArray(fm.allowTools) ? fm.allowTools : undefined,
        denyTools: Array.isArray(fm.denyTools) ? fm.denyTools : undefined,
        system: body,
      });
    } catch {
      /* skip bad role file */
    }
  }
  return roles;
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
