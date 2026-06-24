// Conversation rewind — fork the thread back to an earlier user turn and continue from there, instead of
// /clear (lose everything) or living with a poisoned context. Pure history manipulation (in-memory + the
// session store); file edits are NOT reverted here (that's the heavier shadow-git checkpoint follow-up).
import type { NeutralMsg } from "../providers/types.js";

/** Recent user turns, newest first (n=1 = most recent), each with a short preview — for `/rewind` to list. */
export function userTurnPreviews(history: NeutralMsg[], max = 10): { n: number; preview: string }[] {
  const idxs: number[] = [];
  history.forEach((m, i) => m.role === "user" && idxs.push(i));
  const out: { n: number; preview: string }[] = [];
  for (let k = idxs.length - 1, n = 1; k >= 0 && n <= max; k--, n++) {
    const m = history[idxs[k]];
    out.push({ n, preview: (m.role === "user" ? m.content : "").replace(/\s+/g, " ").slice(0, 70) });
  }
  return out;
}

/** Truncate history to just BEFORE the n-th-most-recent user turn (n=1 drops the last exchange), forking the
 *  conversation from that point. Returns the new history array, or null if n is out of range. */
export function rewindTo(history: NeutralMsg[], n: number): NeutralMsg[] | null {
  const idxs: number[] = [];
  history.forEach((m, i) => m.role === "user" && idxs.push(i));
  if (!Number.isInteger(n) || n < 1 || n > idxs.length) return null;
  return history.slice(0, idxs[idxs.length - n]); // cut at the n-th-from-last user message
}
