// Auto-compaction trigger — the small, testable decision behind "compact the conversation before it overflows"
// (à la Claude Code's auto-compact). The actual summarize-and-replace I/O lives in index.ts (compactConversation),
// which reuses the manual /compact path; this just decides *when* to fire.

/** Auto-compact once the last turn used ≥ this % of the model's context window. */
export const AUTO_COMPACT_PCT = 85;

/** Dynamic absolute ceiling. On a 1M-window model, 85% == 850k tokens — a size a session drags for a
 *  long, sluggish while before ever reaching, so the %-trigger effectively never fires and every turn
 *  re-sends a bloated prompt. This cap makes auto-compaction actually engage at a snappy working size
 *  regardless of how large the window is. Overridable via `HARA_AUTO_COMPACT_TOKENS`. */
export const AUTO_COMPACT_TOKEN_CAP = 200_000;

/** The compaction brief (shared by /compact and auto-compaction). Eight sections, mirroring Claude
 *  Code's AU2 template — the two that matter most beyond the obvious: **All user messages** (the
 *  user's own words survive verbatim, so however hard the history is squeezed, intent never drifts)
 *  and **Key technical concepts** (the frameworks/APIs in play, so the next turn doesn't re-derive
 *  the stack). Lives here (not index.ts) so tests can pin the structure. */
export const COMPACT_SYSTEM =
  "Summarize the conversation so far into a structured, complete brief so the assistant can continue with NO " +
  "loss of context. First think privately in a brief <analysis> scratchpad (what matters, what's in flight), " +
  "then output ONLY the summary under these exact headings:\n" +
  "1. Goal — the user's overall intent, in their own framing.\n" +
  "2. Key technical concepts — the frameworks, tools, APIs, and domain ideas central to the work.\n" +
  "3. Key decisions — choices made and why (so they aren't relitigated).\n" +
  "4. Files & code — files created/changed and the important snippets, with why each matters.\n" +
  "5. Errors & fixes — failures hit, how they were resolved, and any correction the user gave (quote pointed feedback verbatim).\n" +
  "6. Current state — what works now / what is verified.\n" +
  "7. All user messages — EVERY user message so far (excluding tool results), verbatim and in order; abbreviate only huge pasted blobs with […]. These are the ground truth of intent.\n" +
  "8. Next step — the immediate next action, INCLUDING a direct verbatim quote of the user's most recent request so there is no drift.\n" +
  "Be specific and concrete. Drop the <analysis>; output only the headed summary.";

/** Working-memory notes distilled from a compaction summary — short lines that survive the history wipe
 *  (stored on SessionMeta.workingSet, injected into subsequent turns). Shared by the CLI /compact path
 *  and serve's session.compact. */
export function workingSetFromSummary(s: string): string[] {
  return s
    .split("\n")
    .map((l) => l.replace(/^[-*\d.\s]+/, "").trim())
    .filter((l) => l.length > 3)
    .slice(0, 12)
    .map((l) => l.slice(0, 140));
}

/** Post-compaction file restore (Claude Code's TW5): re-attach the CURRENT content of the files the
 *  conversation was just working with, so the summary isn't the model's only anchor — it doesn't have
 *  to re-read its own working set next turn (and can't act on a stale memory of an edited file).
 *  `readFn` is injected (returns null for unreadable/gone files); byte caps bound the token cost. */
export function buildFileRestore(
  paths: string[],
  readFn: (p: string) => string | null,
  opts?: { perFileBytes?: number; totalBytes?: number },
): string | null {
  const per = opts?.perFileBytes ?? 8_192;
  let budget = opts?.totalBytes ?? 24_576;
  const parts: string[] = [];
  for (const p of paths) {
    if (budget <= 0) break;
    const raw = readFn(p);
    if (raw == null) continue;
    const clipped = raw.slice(0, Math.min(per, budget));
    budget -= clipped.length;
    parts.push(`--- ${p}${clipped.length < raw.length ? " (truncated)" : ""} ---\n${clipped}`);
  }
  if (!parts.length) return null;
  return `Files you were recently working with (CURRENT on-disk content, restored after compaction):\n\n${parts.join("\n\n")}`;
}

/** Whether to auto-compact now: enabled, the history is substantial enough to be worth summarizing, and the
 *  last turn filled the context past the threshold (so the NEXT turn would risk overflow). */
export function shouldAutoCompact(ctxPct: number, historyLen: number, autoCompact: boolean, threshold = AUTO_COMPACT_PCT): boolean {
  return autoCompact && historyLen >= 4 && ctxPct >= threshold;
}

/** Absolute-size companion to shouldAutoCompact: fire once the last turn's real token count crosses the
 *  cap. This is what makes auto-compaction engage on huge-window models, where the %-trigger sits at an
 *  unreachable 850k. Either trigger (this OR the %-of-window one) compacts. */
export function shouldAutoCompactTokens(lastInputTokens: number, historyLen: number, autoCompact: boolean, cap = AUTO_COMPACT_TOKEN_CAP): boolean {
  return autoCompact && historyLen >= 4 && lastInputTokens >= cap;
}
