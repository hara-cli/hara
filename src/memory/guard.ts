// Lexical guard for agent-written content (memory + playbooks). No embeddings — a small pattern list
// flags prompt-injection phrases, secret-shaped tokens, and credential-exfil URLs, so poisoned content
// can't silently land on disk or be injected back into the prompt. Agent-written = untrusted-by-default.
const PATTERNS: [RegExp, string][] = [
  [/ignore (all |your )?(previous|prior|above) (instructions|prompts?)/i, "prompt-injection phrase"],
  [/disregard (your |the )?(system prompt|instructions|rules|guidelines)/i, "prompt-injection phrase"],
  [/\bsk-[a-zA-Z0-9_-]{16,}\b/, "secret (sk-… key)"],
  [/\bAKIA[0-9A-Z]{16}\b/, "secret (AWS access key)"],
  [/\bghp_[A-Za-z0-9]{20,}\b/, "secret (GitHub token)"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "secret (private key)"],
  [/\bfile:\/\/\/?\S+/i, "file:// URL"],
];

/** Scan agent-written text; ok=false (with labels) when something looks unsafe to persist/inject. */
export function scanMemory(text: string): { ok: boolean; hits: string[] } {
  const hits = [...new Set(PATTERNS.filter(([re]) => re.test(text)).map(([, label]) => label))];
  return { ok: hits.length === 0, hits };
}
