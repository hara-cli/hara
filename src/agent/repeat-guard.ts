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
    const seen = new WeakSet<object>();
    const canonical = (value: unknown): unknown => {
      if (!value || typeof value !== "object") return value;
      if (seen.has(value as object)) throw new TypeError("circular tool input");
      seen.add(value as object);
      try {
        if (Array.isArray(value)) return value.map(canonical);
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(value as Record<string, unknown>).sort()) {
          const next = (value as Record<string, unknown>)[key];
          if (next !== undefined && typeof next !== "function" && typeof next !== "symbol") out[key] = canonical(next);
        }
        return out;
      } finally {
        seen.delete(value as object);
      }
    };
    return name + " " + JSON.stringify(canonical(input ?? {}));
  } catch {
    return name + " <unserializable>";
  }
}

/** Does a tool RESULT string look like a failure? hara tools report failures as ordinary strings
 *  (bash -> "Command failed: ...", file tools -> "Error: ...", safety gates -> "Blocked: ..."),
 *  so the loop's isError flag alone misses them. Tool-specific shapes are intentionally keyed by `name`:
 *  a read_file/web_fetch result can legitimately begin with prose such as "Search failed ..." and must not
 *  be mistaken for the web_search tool's own diagnostic. Pure — exported for tests. */
export function looksFailed(content: string, name?: string): boolean {
  const text = content.trimStart();
  if (/^(Command failed|Error:|Failed:|Blocked:|Skipped without running)/.test(text)) return true;

  if (name === "web_search") return /^Search failed across available providers\b/.test(text);
  if (name === "external_agent") {
    return /^(?:external_agent is disabled\b|Unknown backend\b|'[^'\r\n]+' CLI not found\b|\[[^\]\r\n]+\]\s+failed\b|\[[^\]\r\n]+\s+exit\s+(?!0\b)[^\]\r\n]+\])/.test(text);
  }
  if (name === "cronjob" || name === "cron") return /^✗\s+\S+\s+failed\s*:/.test(text);
  if (name === "computer") {
    return /^(?:Refused:|Screen control is off\.|No apps allowlisted\b|Grounding needs a vision model\b|'[^'\r\n]+' needs a higher tier\b|(?:activate|find|click\/move) needs\b|⛔ Stopping screen control\b)/.test(text)
      || /^Screenshot saved\b[\s\S]*\bConfigure a vision model\b/.test(text);
  }
  return false;
}

/** Record a completed call; returns a warning to APPEND to the tool result when the same call has now
 *  failed >=2x in a row (empty string otherwise). Pure aside from the session-scoped map. */
export function recordCall(name: string, input: unknown, content: string, isError = false, scope?: string): string {
  const k = keyOf(name, input);
  const failed = isError || looksFailed(content, name);
  const seen = scopedSeen(scope);
  if (!failed) {
    seen.clear(); // any success is progress; a later failure starts a fresh no-progress streak
    return "";
  }
  const s = seen.get(k) ?? { fails: 0 };
  s.fails++;
  // "In a row" is literal: a different failed call is a changed attempt and breaks the old streak.
  seen.clear();
  seen.set(k, s);
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
