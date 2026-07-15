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

import type { NeutralMsg } from "../providers/types.js";
import { historyChars, prepareHistoryForModel } from "./context-budget.js";

export const COMPACTION_SOURCE_CHARS = 220_000;
export const COMPACTION_RECENT_CHARS = 72_000;
export const COMPACTION_SUMMARY_CHARS = 40_000;
export const COMPACTION_RECENT_USER_TURNS = 3;

export const COMPACTION_HEADINGS = [
  "Goal and latest request",
  "Constraints and preferences",
  "Decisions and exact identifiers",
  "Completed and verified",
  "Files and artifacts",
  "Failures and corrections",
  "Current execution checkpoint",
  "Pending work and blockers",
  "Next concrete action",
] as const;

/** The compaction brief is bounded and checkpoint-oriented. Recent turns are preserved separately, so asking
 *  the model to repeat every user message would waste the very context compaction is meant to recover. */
export const COMPACT_SYSTEM =
  "Create a bounded execution checkpoint for another coding agent. Recent turns will be retained separately, so DO NOT copy the full transcript or list every user message. " +
  "Preserve exact file paths, commands, versions, task/turn IDs, error strings, API names, and numeric values when they matter. Distinguish verified facts from assumptions. " +
  "Quote only short, pointed user corrections or the latest ask when necessary. Output ONLY these exact Markdown headings, each concise and concrete:\n" +
  COMPACTION_HEADINGS.map((heading) => `## ${heading}`).join("\n") + "\n" +
  "Under Current execution checkpoint include the active plan/status and the last safely completed action. Under Pending work and blockers include accepted steering or unanswered questions. " +
  "Under Next concrete action give exactly one immediate action. Never include secrets or credentials.";

function clipSummary(value: string): string {
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if (normalized.length <= COMPACTION_SUMMARY_CHARS) return normalized;
  const marker = "\n…[hara: compaction summary truncated at its hard boundary]";
  return normalized.slice(0, COMPACTION_SUMMARY_CHARS - marker.length) + marker;
}

function clipSection(value: string, max = 3_800): string {
  const normalized = value.trim();
  if (normalized.length <= max) return normalized;
  const marker = "\n…[section truncated]";
  return normalized.slice(0, max - marker.length) + marker;
}

/** Ensure even a weak/non-compliant summarizer leaves a predictable checkpoint shape. */
export function normalizeCompactionSummary(raw: string): string {
  const normalized = raw.replace(/\r\n?/g, "\n").trim();
  const complete = COMPACTION_HEADINGS.every((heading) => normalized.includes(`## ${heading}`));
  if (complete) {
    const sections = COMPACTION_HEADINGS.map((heading, index) => {
      const start = normalized.indexOf(`## ${heading}`) + `## ${heading}`.length;
      const nextHeading = COMPACTION_HEADINGS.slice(index + 1)
        .map((candidate) => normalized.indexOf(`## ${candidate}`, start))
        .find((position) => position >= 0) ?? normalized.length;
      return `## ${heading}\n${clipSection(normalized.slice(start, nextHeading))}`;
    });
    return clipSummary(sections.join("\n\n"));
  }
  const summary = clipSection(normalized, 8_000);
  const sections = COMPACTION_HEADINGS.map((heading, index) => {
    if (index === 0) return `## ${heading}\n${summary || "No usable model summary was returned."}`;
    if (heading === "Current execution checkpoint") return `## ${heading}\nConsult the durable task state and recent preserved turns.`;
    if (heading === "Next concrete action") return `## ${heading}\nRe-read the latest preserved user request and take its next verifiable step.`;
    return `## ${heading}\nNot captured by the summarizer; verify from recent preserved turns or the workspace.`;
  });
  return clipSummary(sections.join("\n\n"));
}

/** Bounded source snapshot for the summarizer itself; direct compaction calls bypass runAgent's guard. */
export function compactionSourceHistory(history: NeutralMsg[]): NeutralMsg[] {
  return prepareHistoryForModel(history, { model: "compaction", maxChars: COMPACTION_SOURCE_CHARS }).history;
}

/** Preserve the last few user-turn groups after the summary, with the same hard payload/image boundaries as
 *  ordinary model requests. This is the anti-drift anchor used by Codex/OpenClaw-style compaction. */
export function recentHistoryForCompaction(
  history: NeutralMsg[],
  userTurns = COMPACTION_RECENT_USER_TURNS,
): NeutralMsg[] {
  const users = history.flatMap((message, index) => message.role === "user" ? [index] : []);
  if (!users.length) return [];
  const start = users[Math.max(0, users.length - Math.max(1, userTurns))]!;
  return prepareHistoryForModel(history.slice(start), { model: "compaction", maxChars: COMPACTION_RECENT_CHARS }).history;
}

export function compactedConversationHistory(summary: string, recent: NeutralMsg[], restore?: string | null): NeutralMsg[] {
  const out: NeutralMsg[] = [
    { role: "user", content: `Execution checkpoint from older conversation (continue from current task and recent turns):\n\n${normalizeCompactionSummary(summary)}` },
    ...recent,
  ];
  if (restore) out.push({ role: "user", content: restore });
  return out;
}

export function compactedHistoryTokenEstimate(history: NeutralMsg[]): number {
  return Math.ceil(historyChars(history) / 4);
}

/** Working-memory notes distilled from a compaction summary — short lines that survive the history wipe
 *  (stored on SessionMeta.workingSet, injected into subsequent turns). Shared by the CLI /compact path
 *  and serve's session.compact. */
export function workingSetFromSummary(s: string): string[] {
  const seen = new Set<string>();
  return s
    .split("\n")
    .map((l) => l.replace(/^[-*\d.\s]+/, "").trim())
    .filter((l) => l.length > 3 && !/^#{1,6}\s/.test(l) && !/^not captured/i.test(l) && !/^consult the durable/i.test(l))
    .filter((l) => {
      const key = l.toLocaleLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
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
