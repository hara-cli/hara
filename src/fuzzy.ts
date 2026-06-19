// Tiny zero-dependency fuzzy matcher (subsequence scoring, codex/nucleo-flavored).
// Used for @path completion, file-path did-you-mean, and slash-command suggestions.

/**
 * Score how well `query` fuzzy-matches `target` (case-insensitive subsequence).
 * Higher is better; returns null if `query` is not a subsequence of `target`.
 * Bonuses: first char, word boundary (/ _ - . space), camelCase, consecutive runs;
 * gap penalty for spread-out matches; mild shorter-is-better tiebreak.
 */
export function fuzzyScore(query: string, target: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  let qi = 0;
  let score = 0;
  let prev = -2;
  let consec = 0;
  for (let ti = 0; ti < target.length && qi < q.length; ti++) {
    if (target[ti].toLowerCase() === q[qi]) {
      let s = 16;
      if (ti === prev + 1) {
        consec++;
        s += 8 * consec; // reward consecutive runs strongly so clean prefixes win
      } else consec = 0;
      if (ti === 0) s += 10;
      else {
        const p = target[ti - 1];
        if ("/_-. ".includes(p)) s += 8; // boundary
        else if (p === p.toLowerCase() && target[ti] !== target[ti].toLowerCase()) s += 6; // camelCase
      }
      if (prev >= 0) s -= Math.min(ti - prev - 1, 4); // gap penalty
      score += s;
      prev = ti;
      qi++;
    }
  }
  if (qi < q.length) return null; // not all query chars consumed → no match
  return score - target.length * 0.1;
}

export interface Ranked<T> {
  item: T;
  score: number;
}

/** Rank `items` by fuzzy match against `query`; drops non-matches; best first. */
export function fuzzyRank<T>(query: string, items: T[], key: (t: T) => string): Ranked<T>[] {
  const out: Ranked<T>[] = [];
  for (const item of items) {
    const sc = fuzzyScore(query, key(item));
    if (sc !== null) out.push({ item, score: sc });
  }
  out.sort((a, b) => b.score - a.score || key(a.item).length - key(b.item).length || key(a.item).localeCompare(key(b.item)));
  return out;
}

/** Up to `n` nearest strings to `query` (for did-you-mean suggestions). */
export function nearest(query: string, candidates: string[], n = 3): string[] {
  return fuzzyRank(query, candidates, (s) => s)
    .slice(0, n)
    .map((r) => r.item);
}
