// Lexical guard for agent-written content (memory + skills). No embeddings — small pattern lists.
// Two policies by direction (the asset pipeline's "redact on the way in, block on the way out"):
//   • scanMemory()  — BLOCK: used at LOAD/inject time (skill bodies, memory) — poisoned content must not
//                     come back into the prompt. Checks secrets AND injection phrases.
//   • redactSecrets()/scrubLocal() — REDACT: used at CAPTURE time (skill_create) — strip secrets +
//                     local identifiers so a reusable snippet is safe to persist (and later share).
import { homedir } from "node:os";

// Secret-shaped tokens — redactable to a typed placeholder on capture; still blocked on load.
const SECRETS: [RegExp, string][] = [
  [/\bsk-[a-zA-Z0-9_-]{16,}\b/, "sk-key"],
  [/\bAKIA[0-9A-Z]{16}\b/, "aws-key"],
  [/\bghp_[A-Za-z0-9]{20,}\b/, "github-token"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/, "private-key"],
];
// Prompt-injection phrases + exfil URLs — block-only (can't meaningfully "redact" an instruction).
const INJECTION: [RegExp, string][] = [
  [/ignore (all |your )?(previous|prior|above) (instructions|prompts?)/i, "prompt-injection phrase"],
  [/disregard (your |the )?(system prompt|instructions|rules|guidelines)/i, "prompt-injection phrase"],
  [/\bfile:\/\/\/?\S+/i, "file:// URL"],
];
const ALL = [...SECRETS, ...INJECTION];

/** Scan agent-written text; ok=false (with labels) when something looks unsafe to persist/inject. */
export function scanMemory(text: string): { ok: boolean; hits: string[] } {
  const hits = [...new Set(ALL.filter(([re]) => re.test(text)).map(([, label]) => label))];
  return { ok: hits.length === 0, hits };
}

/** Replace secret-shaped tokens with typed placeholders (capture path). Injection phrases are left for
 *  scanMemory to block — they aren't redactable. */
export function redactSecrets(text: string): { text: string; redactions: string[] } {
  const redactions: string[] = [];
  let out = text;
  for (const [re, label] of SECRETS) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    out = out.replace(g, () => {
      redactions.push(label);
      return `<REDACTED:${label}>`;
    });
  }
  return { text: out, redactions };
}

/** Safe load boundary for editable/synced legacy memory. Agent writes are checked on capture, but a user,
 * older Hara version, or sync process can still change Markdown later. Redact secret-shaped values, remove
 * injection/exfil lines, and fail closed if a cross-line pattern remains after filtering. */
export function sanitizeMemoryForPrompt(text: string): {
  text: string;
  redactions: string[];
  blockedLines: number;
  blocked: boolean;
} {
  const redacted = redactSecrets(text);
  if (scanMemory(redacted.text).ok) {
    return { text: redacted.text, redactions: redacted.redactions, blockedLines: 0, blocked: false };
  }
  let blockedLines = 0;
  const safeLines = redacted.text.split("\n").filter((line) => {
    if (scanMemory(line).ok) return true;
    blockedLines += 1;
    return false;
  });
  const safe = safeLines.join("\n");
  if (!scanMemory(safe).ok) {
    return { text: "", redactions: redacted.redactions, blockedLines, blocked: true };
  }
  return { text: safe, redactions: redacted.redactions, blockedLines, blocked: blockedLines > 0 };
}

/** Deterministically generalize local identifiers so a captured snippet isn't tied to this machine:
 *  the project path → <project>, the home dir → ~, and email addresses → <email>. Light + reversible. */
export function scrubLocal(text: string, cwd: string): string {
  let out = text;
  if (cwd) out = out.split(cwd).join("<project>");
  const home = homedir();
  if (home) out = out.split(home).join("~");
  return out.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "<email>");
}
