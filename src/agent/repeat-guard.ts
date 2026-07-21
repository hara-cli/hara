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
const HOME_WORKSPACE_BOUNDARY_KEY = "root-cause:home-workspace-boundary";
const EMPTY_RECALL_KEY = "root-cause:empty-memory-or-session-recall";

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

  if (name === "memory_search" || name === "session_search") {
    return /^\(no (?:memory|session) matches\)\s*$/.test(text);
  }
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

/** Several different filesystem tools can hit the same protected Home-workspace boundary. Treating each
 * tool name/argument tuple as a fresh idea lets a model spin through grep → glob → ls even though the
 * root cause cannot change inside that run. Only Hara's own stable boundary diagnostics are coalesced. */
function isHomeWorkspaceBoundaryFailure(content: string): boolean {
  return (
    /will not recursively scan the home directory\b/i.test(content)
    || /will not enumerate or recursively scan directories while Hara is rooted at the home directory\b/i.test(content)
    || /workspace that is the home directory or contains it\b/i.test(content)
  );
}

export interface FailureIdentity {
  key: string;
  label: string;
  semantic: boolean;
  /** Consecutive calls allowed before the run-level breaker stops another model round. */
  hardStopAfter: number;
  kind: "exact" | "home_boundary" | "empty_recall";
}

/** Stable identity used by both the warning note and the run-level hard breaker. */
export function failureIdentity(
  name: string,
  input: unknown,
  content: string,
  isError = false,
): FailureIdentity {
  const failed = isError || looksFailed(content, name);
  if (failed && isHomeWorkspaceBoundaryFailure(content)) {
    return {
      key: HOME_WORKSPACE_BOUNDARY_KEY,
      label: "Home workspace boundary",
      semantic: true,
      hardStopAfter: 1,
      kind: "home_boundary",
    };
  }
  if (
    failed &&
    (name === "memory_search" || name === "session_search") &&
    /^\(no (?:memory|session) matches\)\s*$/.test(content.trimStart())
  ) {
    return {
      // Different queries and both recall tools share one no-progress cause. Otherwise a model can evade
      // the breaker by paraphrasing the same empty lookup dozens of times or alternating tools.
      key: EMPTY_RECALL_KEY,
      label: "memory/session search with no matches",
      semantic: true,
      hardStopAfter: 3,
      kind: "empty_recall",
    };
  }
  return {
    key: keyOf(name, input),
    label: `${name} call`,
    semantic: false,
    hardStopAfter: 3,
    kind: "exact",
  };
}

/** Record a completed call; returns a warning to APPEND to the tool result when the same call has now
 *  failed >=2x in a row (empty string otherwise). Pure aside from the session-scoped map. */
export function recordCall(name: string, input: unknown, content: string, isError = false, scope?: string): string {
  const failed = isError || looksFailed(content, name);
  const identity = failureIdentity(name, input, content, isError);
  const seen = scopedSeen(scope);
  if (!failed) {
    seen.clear(); // any success is progress; a later failure starts a fresh no-progress streak
    return "";
  }
  const s = seen.get(identity.key) ?? { fails: 0 };
  s.fails++;
  // "In a row" is literal: a different failed call is a changed attempt and breaks the old streak.
  seen.clear();
  seen.set(identity.key, s);
  if (identity.kind === "home_boundary") {
    if (s.fails === 1) {
      return (
        "\n\n⟳ hara: the first project tool was blocked by the Home workspace boundary — " +
        "stop this run now and ask the user to switch with `/cd <project>` (the current conversation will continue); do not try another " +
        "filesystem/search tool from Home."
      );
    }
    return (
      `\n\n⟳ hara: the same ${identity.label} has now blocked ${s.fails} consecutive tool calls — ` +
      "another filesystem/search tool cannot bypass it. Ask the user to switch with `/cd <project>` and keep the current conversation " +
      "or stop this run; do not probe another directory tool from Home."
    );
  }
  if (identity.kind === "empty_recall") {
    if (s.fails < identity.hardStopAfter) {
      return (
        `\n\n⟳ hara: ${s.fails} consecutive memory/session search${s.fails === 1 ? " has" : "es have"} returned no matches. ` +
        `Try at most ${identity.hardStopAfter - s.fails} more materially different recall ${identity.hardStopAfter - s.fails === 1 ? "query" : "queries"}; ` +
        "then stop searching and answer from current evidence or tell the user the history was not found."
      );
    }
    return (
      `\n\n⟳ hara: ${s.fails} consecutive memory/session searches returned no matches — stop recall calls now. ` +
      "Recall tools are disabled for the rest of this turn. Tell the user the prior history was not found, " +
      "then ask for the missing detail or whether to recreate it."
    );
  }
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
