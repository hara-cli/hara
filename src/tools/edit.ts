import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { registerTool } from "./registry.js";
import { nearestPaths } from "../fs-walk.js";
import { showDiff } from "../diff.js";
import { applyEdits, type OneEdit } from "./apply-core.js";
import { recordEdit } from "../undo.js";

registerTool({
  name: "edit_file",
  description:
    "Edit an existing file by replacing exact strings. Provide a single `old_string`/`new_string`, " +
    "or `edits` (an array of {old_string,new_string,replace_all?}) applied in order. Each `old_string` " +
    "must match exactly and appear once (include surrounding context) unless `replace_all` is true. " +
    "Quote variants (straight/curly) are matched leniently. Use write_file to create a new file, or " +
    "apply_patch to change several files at once.",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string" },
      old_string: { type: "string", description: "exact text to replace (verbatim, incl. whitespace)" },
      new_string: { type: "string", description: "replacement text" },
      replace_all: { type: "boolean", description: "replace every occurrence (default false)" },
      edits: {
        type: "array",
        description: "multiple edits applied in sequence (alternative to a single old/new)",
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
  kind: "edit",
  async run(input, ctx) {
    const p = isAbsolute(input.path) ? input.path : resolve(ctx.cwd, input.path);
    const edits: OneEdit[] =
      Array.isArray(input.edits) && input.edits.length
        ? input.edits
        : [{ old_string: input.old_string, new_string: input.new_string, replace_all: input.replace_all }];

    let text: string;
    try {
      text = await readFile(p, "utf8");
    } catch {
      const near = nearestPaths(ctx.cwd, input.path);
      return `Error: cannot read ${input.path} (use write_file to create a new file).` + (near.length ? ` Did you mean: ${near.join(", ")}?` : "");
    }

    const res = applyEdits(text, edits);
    if ("error" in res) return `Error: ${res.error} in ${input.path}. No changes written.`;
    await writeFile(p, res.text, "utf8");
    showDiff(input.path, text, res.text);
    recordEdit([{ path: input.path, absPath: p, before: text }]);
    const note = res.fuzzy ? " (quote-normalized)" : "";
    const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : "s"}`;
    return `Edited ${input.path}: ${plural(edits.length, "edit")}, ${plural(res.total, "replacement")}${note}.`;
  },
});
