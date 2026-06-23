// Context-spend breakdown — what's actually filling the context window, so a long session can see WHY it's
// near the limit (and what to trim) beyond the single ctx% number. Pairs with auto-compaction. Token counts
// are a cheap chars/4 estimate (no tokenizer dependency).
import type { NeutralMsg } from "../providers/types.js";
import { contextWindow } from "../statusbar.js";

const est = (s: string): number => Math.ceil((s?.length ?? 0) / 4);

export interface ContextReport {
  total: number;
  rows: { label: string; tokens: number; pct: number }[];
}

/** Estimate token spend by category (your messages / assistant / each tool's output) across the history. */
export function analyzeContext(history: NeutralMsg[]): ContextReport {
  const by = new Map<string, number>();
  const add = (k: string, n: number): void => {
    by.set(k, (by.get(k) ?? 0) + n);
  };
  for (const m of history) {
    if (m.role === "user") add("your messages", est(m.content));
    else if (m.role === "assistant") add("assistant", est(m.text));
    else if (m.role === "tool") for (const r of m.results) add(`tool: ${r.name}`, est(r.content));
  }
  const total = [...by.values()].reduce((a, b) => a + b, 0);
  const rows = [...by.entries()]
    .map(([label, tokens]) => ({ label, tokens, pct: Math.round((tokens / (total || 1)) * 100) }))
    .sort((a, b) => b.tokens - a.tokens);
  return { total, rows };
}

/** Human-readable breakdown, biggest first, with the share of the model's window used + a trim hint. */
export function formatContextReport(history: NeutralMsg[], model: string): string {
  const { total, rows } = analyzeContext(history);
  if (!rows.length) return "Context is empty.";
  const pctWin = Math.min(99, Math.round((total / contextWindow(model)) * 100));
  const lines = rows.slice(0, 8).map((r) => `  ${String(r.pct).padStart(3)}%  ${r.label} (~${r.tokens.toLocaleString()} tok)`);
  const tip = pctWin >= 80 ? "\n  → near the limit; /compact to summarize or /clear to reset." : "";
  return `Context ~${total.toLocaleString()} tok (~${pctWin}% of ${model}'s window):\n${lines.join("\n")}${tip}`;
}
