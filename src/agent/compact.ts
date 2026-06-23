// Auto-compaction trigger — the small, testable decision behind "compact the conversation before it overflows"
// (à la Claude Code's auto-compact). The actual summarize-and-replace I/O lives in index.ts (compactConversation),
// which reuses the manual /compact path; this just decides *when* to fire.

/** Auto-compact once the last turn used ≥ this % of the model's context window. */
export const AUTO_COMPACT_PCT = 85;

/** Whether to auto-compact now: enabled, the history is substantial enough to be worth summarizing, and the
 *  last turn filled the context past the threshold (so the NEXT turn would risk overflow). */
export function shouldAutoCompact(ctxPct: number, historyLen: number, autoCompact: boolean, threshold = AUTO_COMPACT_PCT): boolean {
  return autoCompact && historyLen >= 4 && ctxPct >= threshold;
}
