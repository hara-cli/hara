/** A deliberately small shell grammar for permission hints, never an execution/rewrite parser. */
export function splitLiteralShellCommands(command: string): string[] | null {
  const parts: string[] = [];
  let buf = "";
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const next = command[i + 1];
    if (quote === "'") {
      if (ch === "'") quote = undefined;
      buf += ch;
      continue;
    }
    // Substitution also executes inside double quotes. Escaped shell syntax is not modelled.
    if (ch === "`" || ch === "\\" || (ch === "$" && next === "(")) return null;
    if (quote === '"') {
      if (ch === '"') quote = undefined;
      buf += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; buf += ch; continue; }
    if ((ch === "<" || ch === ">") && next === "(") return null;
    if (ch === "(" || ch === ")") return null;
    // Descriptor duplication is not a background separator. Keep bounded probe redirections intact.
    if (ch === "&" && (((command[i - 1] === ">" || command[i - 1] === "<") && /[0-9-]/u.test(next ?? "")) || next === ">")) {
      buf += ch;
      continue;
    }
    if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
      if (!buf.trim()) return null;
      parts.push(buf.trim()); buf = ""; i++; continue;
    }
    if (ch === "&") return null; // shell-level background execution is not read-only autorun
    if (ch === ";" || ch === "|" || ch === "\n") {
      if (!buf.trim()) return null;
      parts.push(buf.trim()); buf = ""; continue;
    }
    buf += ch;
  }
  if (quote || !buf.trim()) return null;
  parts.push(buf.trim());
  // Assignments can replace executable loaders or redirect cd through CDPATH. Canonicalization strips
  // them for policy matching, so do not let that lossy form acquire read-only execution authority.
  if (parts.some((part) => /^[A-Za-z_][A-Za-z0-9_]*=/u.test(part))) return null;
  if (parts.some((part) => /^(?:(?:\/usr\/bin|\/bin)\/)?(?:ba|z)?sh\s/u.test(part))) return null;
  return parts;
}

/** Decode only literal words. No expansions, globs, substitutions, redirections or escape sequences. */
export function literalShellWords(command: string): string[] | null {
  const words: string[] = [];
  let word = "";
  let started = false;
  let quote: "'" | '"' | undefined;
  for (const ch of command) {
    if (/[\u0000-\u001f\u007f]/u.test(ch) && ch !== "\t") return null;
    if (quote) {
      if (ch === quote) quote = undefined;
      else {
        if (quote === '"' && /[$`\\]/u.test(ch)) return null;
        word += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; started = true; continue; }
    if (/\s/u.test(ch)) {
      if (started) words.push(word);
      word = ""; started = false; continue;
    }
    if (/[$`\\*?\[\]{}()<>;&|!~#]/u.test(ch)) return null;
    word += ch; started = true;
  }
  if (quote) return null;
  if (started) words.push(word);
  return words;
}

export function literalCdTarget(words: readonly string[]): string | null {
  if (words[0] !== "cd") return null;
  const args = words[1] === "--" ? words.slice(2) : words.slice(1);
  return args.length === 1 && !!args[0] && !args[0].startsWith("-") ? args[0] : null;
}
