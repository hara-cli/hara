// apply_patch — change MULTIPLE files atomically (all-or-nothing). Everything is validated and
// computed in memory first; nothing is written unless every change applies cleanly.
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { isAbsolute, resolve, dirname } from "node:path";
import { registerTool } from "./registry.js";
import { applyEdits, type OneEdit } from "./apply-core.js";
import { showDiff } from "../diff.js";
import { recordEdit } from "../undo.js";

interface Change {
  path: string;
  type?: "update" | "create" | "delete";
  edits?: OneEdit[];
  content?: string;
}

interface Plan {
  path: string;
  abs: string;
  type: "update" | "create" | "delete";
  before: string;
  after: string | null; // null = delete
  existed: boolean; // did the file exist before (for undo: false → undo deletes)
}

registerTool({
  name: "apply_patch",
  description:
    "Change SEVERAL files in one atomic step (all-or-nothing). `changes` is an array of " +
    "{path, type:'update'|'create'|'delete', edits?:[{old_string,new_string,replace_all?}], content?}. " +
    "update applies edits (or replaces the whole file with content); create writes a new file; delete removes it. " +
    "If ANY change fails to apply, nothing is written. Prefer this over multiple edit_file calls for multi-file changes.",
  input_schema: {
    type: "object",
    properties: {
      changes: {
        type: "array",
        description: "the file changes to apply together",
        items: {
          type: "object",
          properties: {
            path: { type: "string" },
            type: { type: "string", enum: ["update", "create", "delete"] },
            content: { type: "string", description: "full file content (for create, or whole-file update)" },
            edits: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  old_string: { type: "string" },
                  new_string: { type: "string" },
                  replace_all: { type: "boolean" },
                },
                required: ["old_string", "new_string"],
              },
            },
          },
          required: ["path"],
        },
      },
    },
    required: ["changes"],
  },
  kind: "edit",
  async run(input, ctx) {
    const changes: Change[] = Array.isArray(input.changes) ? input.changes : [];
    if (!changes.length) return "Error: apply_patch needs a non-empty `changes` array.";
    const abs = (pth: string): string => (isAbsolute(pth) ? pth : resolve(ctx.cwd, pth));

    // PHASE 1 — validate + compute every change in memory; bail before writing anything.
    const plans: Plan[] = [];
    for (let i = 0; i < changes.length; i++) {
      const ch = changes[i];
      const tag = `change ${i + 1}/${changes.length}`;
      if (typeof ch.path !== "string" || !ch.path) return `Error: ${tag} is missing a path. Nothing written.`;
      const p = abs(ch.path);
      const type = ch.type ?? (ch.edits ? "update" : "create");

      if (type === "delete") {
        let before: string;
        try {
          before = await readFile(p, "utf8");
        } catch {
          return `Error: ${tag} delete ${ch.path}: file not found. Nothing written.`;
        }
        plans.push({ path: ch.path, abs: p, type, before, after: null, existed: true });
      } else if (type === "create") {
        if (typeof ch.content !== "string") return `Error: ${tag} create ${ch.path} needs \`content\`. Nothing written.`;
        let before = "";
        let existed = false;
        try {
          before = await readFile(p, "utf8");
          existed = true;
        } catch {
          /* new file */
        }
        plans.push({ path: ch.path, abs: p, type, before, after: ch.content, existed });
      } else {
        // update
        let before: string;
        try {
          before = await readFile(p, "utf8");
        } catch {
          return `Error: ${tag} update ${ch.path}: cannot read (use type:create for a new file). Nothing written.`;
        }
        if (typeof ch.content === "string" && !ch.edits) {
          plans.push({ path: ch.path, abs: p, type, before, after: ch.content, existed: true });
        } else {
          const res = applyEdits(before, ch.edits ?? []);
          if ("error" in res) return `Error: ${tag} ${ch.path} — ${res.error}. Nothing written.`;
          plans.push({ path: ch.path, abs: p, type, before, after: res.text, existed: true });
        }
      }
    }

    // PHASE 2 — commit all changes + show each diff.
    const summary: string[] = [];
    for (const pl of plans) {
      if (pl.type === "delete") {
        await unlink(pl.abs);
        showDiff(pl.path, pl.before, "");
        summary.push(`deleted ${pl.path}`);
      } else {
        await mkdir(dirname(pl.abs), { recursive: true });
        await writeFile(pl.abs, pl.after as string, "utf8");
        showDiff(pl.path, pl.before, pl.after as string);
        summary.push(`${pl.type === "create" ? "created" : "updated"} ${pl.path}`);
      }
    }
    recordEdit(plans.map((pl) => ({ path: pl.path, absPath: pl.abs, before: pl.existed ? pl.before : null })));
    return `apply_patch: ${plans.length} file(s) — ${summary.join("; ")}.`;
  },
});
