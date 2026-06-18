import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { registerTool } from "./registry.js";

registerTool({
  name: "edit_file",
  description:
    "Edit an existing file by replacing an exact string. `old_string` must match exactly and appear " +
    "exactly once (include surrounding context to disambiguate) unless `replace_all` is true. " +
    "For creating a new file, use write_file instead.",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string" },
      old_string: { type: "string", description: "exact text to replace (verbatim, incl. whitespace)" },
      new_string: { type: "string", description: "replacement text" },
      replace_all: { type: "boolean", description: "replace every occurrence (default false)" },
    },
    required: ["path", "old_string", "new_string"],
  },
  dangerous: true,
  async run(input, ctx) {
    const p = isAbsolute(input.path) ? input.path : resolve(ctx.cwd, input.path);
    const { old_string, new_string, replace_all } = input;
    if (old_string === new_string) return "Error: old_string and new_string are identical.";

    let orig: string;
    try {
      orig = await readFile(p, "utf8");
    } catch {
      return `Error: cannot read ${input.path} (use write_file to create a new file).`;
    }

    const count = orig.split(old_string).length - 1;
    if (count === 0) return `Error: old_string not found in ${input.path}.`;
    if (count > 1 && !replace_all) {
      return `Error: old_string appears ${count}× in ${input.path}; add surrounding context to make it unique, or set replace_all.`;
    }

    // split/join + function-replacement avoid $-pattern interpretation in new_string
    const updated = replace_all
      ? orig.split(old_string).join(new_string)
      : orig.replace(old_string, () => new_string);
    await writeFile(p, updated, "utf8");
    return `Edited ${input.path} (${replace_all ? `${count} replacements` : "1 replacement"}).`;
  },
});
