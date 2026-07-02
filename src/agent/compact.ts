// Auto-compaction trigger — the small, testable decision behind "compact the conversation before it overflows"
// (à la Claude Code's auto-compact). The actual summarize-and-replace I/O lives in index.ts (compactConversation),
// which reuses the manual /compact path; this just decides *when* to fire.

/** Auto-compact once the last turn used ≥ this % of the model's context window. */
export const AUTO_COMPACT_PCT = 85;

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

/** Whether to auto-compact now: enabled, the history is substantial enough to be worth summarizing, and the
 *  last turn filled the context past the threshold (so the NEXT turn would risk overflow). */
export function shouldAutoCompact(ctxPct: number, historyLen: number, autoCompact: boolean, threshold = AUTO_COMPACT_PCT): boolean {
  return autoCompact && historyLen >= 4 && ctxPct >= threshold;
}
