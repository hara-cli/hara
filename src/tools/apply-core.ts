// Shared edit-application core — applies old→new string edits to file text with a
// quote-insensitive fallback. Used by edit_file (single file) and apply_patch (multi-file).

// Quote variants — models often emit curly quotes where the file has straight ones (or vice versa).
const SINGLE = "'‘’‚‛";
const DOUBLE = '"“”„‟';
const reEscape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** RegExp source for `s` where any quote char matches any of its typographic variants. */
function quoteFlexSource(s: string): string {
  let out = "";
  for (const ch of s) {
    if (SINGLE.includes(ch)) out += `[${SINGLE}]`;
    else if (DOUBLE.includes(ch)) out += `[${DOUBLE}]`;
    else out += reEscape(ch);
  }
  return out;
}

export interface OneEdit {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

interface OneResult {
  text: string;
  count: number;
  fuzzy: boolean;
}

/** Apply one old→new replacement to `src`. Returns an error reason on not-found/ambiguous. */
function applyOne(src: string, oldStr: string, newStr: string, replaceAll: boolean): OneResult | { error: string } {
  // 1) exact
  let count = src.split(oldStr).length - 1;
  if (count > 0) {
    if (count > 1 && !replaceAll) return { error: `appears ${count}×; add context or set replace_all` };
    const text = replaceAll ? src.split(oldStr).join(newStr) : src.replace(oldStr, () => newStr);
    return { text, count, fuzzy: false };
  }
  // 2) quote-flexible fallback
  const re = new RegExp(quoteFlexSource(oldStr), "g");
  const matches = src.match(re);
  count = matches ? matches.length : 0;
  if (count === 0) return { error: "not found" };
  if (count > 1 && !replaceAll) return { error: `appears ${count}× (quote-insensitive); add context or set replace_all` };
  const text = src.replace(re, () => newStr);
  return { text, count, fuzzy: true };
}

/** Apply a sequence of edits to `text`. All-or-nothing: returns an error (no partial result). */
export function applyEdits(text: string, edits: OneEdit[]): { text: string; total: number; fuzzy: boolean } | { error: string } {
  if (!edits.length) return { error: "no edits provided" };
  for (const e of edits) {
    if (typeof e.old_string !== "string" || typeof e.new_string !== "string")
      return { error: "each edit needs string old_string and new_string" };
    if (e.old_string === e.new_string) return { error: "an edit has identical old_string and new_string" };
  }
  let out = text;
  let total = 0;
  let fuzzy = false;
  for (let i = 0; i < edits.length; i++) {
    const r = applyOne(out, edits[i].old_string, edits[i].new_string, !!edits[i].replace_all);
    if ("error" in r) return { error: `edit ${i + 1}/${edits.length} — old_string ${r.error}` };
    out = r.text;
    total += r.count;
    fuzzy = fuzzy || r.fuzzy;
  }
  return { text: out, total, fuzzy };
}
