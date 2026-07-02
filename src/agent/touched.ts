// Recently-touched file tracker — feeds post-compaction FILE RESTORE (Claude Code's TW5 pattern).
// The loop records every file the MAIN conversation reads/edits; when the history is compacted to a
// summary, the top-N most-recent files get their CURRENT on-disk content re-attached — so the model
// doesn't lose the very files it was working on and re-read them all next turn.
const touched = new Map<string, number>(); // absolute path → last-touch timestamp

export function recordTouch(path: string): void {
  touched.set(path, Date.now());
}

/** Most-recently-touched first. */
export function recentTouched(n = 5): string[] {
  return [...touched.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([p]) => p);
}

export function clearTouched(): void {
  touched.clear();
}
