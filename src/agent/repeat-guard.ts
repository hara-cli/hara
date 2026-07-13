// Repeat guard — the anti-spinning tripwire. The classic way an agent wastes a session is repeating the
// EXACT same failing tool call, unchanged, expecting a different result (observed: 4x `git pull` into the
// same wall; Nx the same failing build command). The guardian breaker only covers DENIED actions; this
// covers FAILED ones. Deterministic and session-scoped (module state, same pattern as net-reachability):
// when an identical (tool, args) call fails twice in a row, the tool result gets an explicit "stop
// repeating this" note the model can't miss. Successful repeats are NOT flagged — a re-read after an edit
// or a re-run after a fix is legitimate, and a success resets the failure streak. Serve can run several
// sessions in one process, so streaks are keyed by the same run scope as todo/reminder state.
const DEFAULT_SCOPE = "default";
const seenByScope = new Map<string, Map<string, { fails: number }>>();

function scopedSeen(scope?: string): Map<string, { fails: number }> {
  const key = scope?.trim() || DEFAULT_SCOPE;
  const seen = seenByScope.get(key) ?? new Map<string, { fails: number }>();
  seenByScope.set(key, seen);
  return seen;
}

/** Identity of a call = tool name + exact JSON of its arguments (tool names contain no spaces,
 *  so a space separator is unambiguous). */
export function keyOf(name: string, input: unknown): string {
  try {
    return name + " " + JSON.stringify(input ?? {});
  } catch {
    return name + " <unserializable>";
  }
}

/** Does a tool RESULT string look like a failure? hara tools report failures as ordinary strings
 *  (bash -> "Command failed: ...", file tools -> "Error: ...", net guard -> "Skipped without running: ..."),
 *  so the loop's isError flag alone misses them. Pure — exported for tests. */
export function looksFailed(content: string): boolean {
  return /^\s*(Command failed|Error\b|Skipped without running)/.test(content);
}

/** Record a completed call; returns a warning to APPEND to the tool result when the same call has now
 *  failed >=2x in a row (empty string otherwise). Pure aside from the session-scoped map. */
export function recordCall(name: string, input: unknown, content: string, isError = false, scope?: string): string {
  const k = keyOf(name, input);
  const failed = isError || looksFailed(content);
  const seen = scopedSeen(scope);
  const s = seen.get(k) ?? { fails: 0 };
  if (!failed) {
    seen.delete(k); // successes have no useful state; don't leak every unique tool call in a long-lived server
    return "";
  }
  s.fails++;
  seen.delete(k);
  seen.set(k, s); // refresh insertion order for the bounded per-scope LRU
  if (seen.size > 500) seen.delete(seen.keys().next().value!);
  if (s.fails < 2) return "";
  return (
    `\n\n⟳ hara: this exact ${name} call has now FAILED ${s.fails}× with identical arguments — ` +
    `repeating it unchanged will fail again. Read the error above, change something (arguments / approach / tool), ` +
    `or step back and re-plan; if you're out of ideas, ask the user and say what you tried.`
  );
}

/** Clear the streaks — /reset (fresh start) and tests. */
export function resetRepeatGuard(scope?: string): void {
  if (scope) seenByScope.delete(scope.trim() || DEFAULT_SCOPE);
  else seenByScope.clear();
}
