import { isAbsolute, resolve } from "node:path";
import { registerTool } from "./registry.js";
import { nearestPathsAsync } from "../fs-walk.js";
import { emitDiff } from "../diff.js";
import { applyEdits, type OneEdit } from "./apply-core.js";
import { recordEdit } from "../undo.js";
import { atomicWriteText, bindAtomicWritePath } from "../fs-write.js";
import { invalidateFileCandidates } from "../context/mentions.js";
import { readVerifiedRegularFileSnapshot } from "../fs-read.js";
import { sensitiveFileError } from "../security/sensitive-files.js";

registerTool({
  name: "edit_file",
  description:
    "Edit an existing file by replacing exact strings. Provide a single `old_string`/`new_string`, " +
    "or `edits` (an array of {old_string,new_string,replace_all?}) applied in order. Each `old_string` " +
    "must match exactly and appear once (include surrounding context) unless `replace_all` is true. " +
    "`old_string` is matched against the RAW file text — strip read_file's line-number prefix " +
    "(the leading `   123\\t`) before matching. Quote variants (straight/curly) are matched leniently. " +
    "Use write_file to create a new file, or apply_patch to change several files at once.",
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
    const denied = sensitiveFileError(p, "edit");
    if (denied) return denied;
    const edits: OneEdit[] =
      Array.isArray(input.edits) && input.edits.length
        ? input.edits
        : [{ old_string: input.old_string, new_string: input.new_string, replace_all: input.replace_all }];

    let snapshot: Awaited<ReturnType<typeof readVerifiedRegularFileSnapshot>>;
    let boundary;
    try {
      boundary = bindAtomicWritePath(p, "edit");
      snapshot = await readVerifiedRegularFileSnapshot(boundary.target, undefined, "edit");
    } catch (error: any) {
      const near = await nearestPathsAsync(ctx.cwd, input.path, 3, { timeoutMs: 1_000, signal: ctx.signal });
      return `Error: cannot read ${input.path}: ${error?.message ?? "unknown error"} (use write_file to create a new file).` + (near.length ? ` Did you mean: ${near.join(", ")}?` : "");
    }
    const text = snapshot.text;

    const res = applyEdits(text, edits);
    if ("error" in res) return `Error: ${res.error} in ${input.path}. No changes written.`;
    let committed;
    try {
      committed = await atomicWriteText(boundary.target, res.text, {
        expected: text,
        expectedIdentity: snapshot,
        boundary,
        signal: ctx.signal,
      });
    } catch (error: any) {
      return `Error: cannot edit ${input.path}: ${error?.message ?? String(error)} No changes written.`;
    }
    emitDiff(input.path, text, res.text, ctx.ui);
    recordEdit([{ path: input.path, absPath: boundary.target, before: text, beforeMode: snapshot.mode, committed, after: res.text }]);
    invalidateFileCandidates(ctx.cwd);
    const note = res.fuzzy ? " (quote-normalized)" : "";
    const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : "s"}`;
    return `Edited ${input.path}: ${plural(edits.length, "edit")}, ${plural(res.total, "replacement")}${note}.` +
      (committed.warnings?.length ? ` Warning: ${committed.warnings.join("; ")}` : "");
  },
});
