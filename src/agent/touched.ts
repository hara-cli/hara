// Recently-touched file tracker — feeds post-compaction FILE RESTORE (Claude Code's TW5 pattern).
// The loop records every file the MAIN conversation reads/edits; when the history is compacted to a
// summary, the top-N most-recent files get their CURRENT on-disk content re-attached — so the model
// doesn't lose the very files it was working on and re-read them all next turn.
const DEFAULT_SCOPE = "default";
const touchedByScope = new Map<string, Map<string, number>>(); // scope → absolute path → last-touch timestamp

function scopedTouched(scope?: string): Map<string, number> {
  const key = scope?.trim() || DEFAULT_SCOPE;
  const touched = touchedByScope.get(key) ?? new Map<string, number>();
  touchedByScope.set(key, touched);
  return touched;
}

export function recordTouch(path: string, scope?: string): void {
  const touched = scopedTouched(scope);
  touched.delete(path);
  touched.set(path, Date.now());
  if (touched.size > 200) touched.delete(touched.keys().next().value!);
}

/** Most-recently-touched first. */
export function recentTouched(n = 5, scope?: string): string[] {
  return [...scopedTouched(scope).entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([p]) => p);
}

export function clearTouched(scope?: string): void {
  if (scope) touchedByScope.delete(scope.trim() || DEFAULT_SCOPE);
  else touchedByScope.clear();
}
