// Repeat guard — the anti-spinning tripwire. The classic way an agent wastes a session is repeating the
// EXACT same failing tool call, unchanged, expecting a different result (observed: 4x `git pull` into the
// same wall; Nx the same failing build command). The guardian breaker only covers DENIED actions; this
// covers FAILED ones. Deterministic and session-scoped (module state, same pattern as net-reachability):
// when an identical (tool, args) call fails twice without any successful action between the failures, the
// tool result gets an explicit "stop repeating this" note the model can't miss. A model cannot evade the
// guard by alternating several failing tools. Successful repeats are NOT flagged — a re-read after an edit
// or a re-run after a fix is legitimate, and any success resets the bounded no-progress ledger. Serve can run several
// sessions in one process, so streaks are keyed by the same run scope as todo/reminder state.
const DEFAULT_SCOPE = "default";
const MAX_FAILURE_IDENTITIES_PER_SCOPE = 64;
const seenByScope = new Map<string, Map<string, { fails: number }>>();
const HOME_WORKSPACE_BOUNDARY_KEY = "root-cause:home-workspace-boundary";
const EMPTY_RECALL_KEY = "root-cause:empty-memory-or-session-recall";

function stableFailureSignal(content: string): string | undefined {
  const pythonSyntax = pythonSyntaxDiagnostic(content);
  if (pythonSyntax) return `Python ${pythonSyntax.kind}`;
  if (/web_fetch (?:received only a JavaScript SPA shell|could not verify the rendered page)/iu.test(content)) {
    return "browser rendering unavailable";
  }
  const apiCode = /(?:"?(?:error[_-]?code|err[_-]?code|code)"?\s*[:=]\s*"?)(-?\d{4,})/iu.exec(content)?.[1];
  if (apiCode) return `API error ${apiCode}`;
  const httpCode = /\bHTTP(?:\/\d(?:\.\d)?)?\s+([45]\d{2})\b/iu.exec(content)?.[1];
  if (httpCode) return `HTTP ${httpCode}`;
  if (/\b(?:params?|parameters?) error\b|\binvalid (?:request )?(?:params?|parameters?)\b/iu.test(content)) {
    return "parameter validation error";
  }
  return undefined;
}

export interface PythonSyntaxDiagnostic {
  kind: "SyntaxError" | "IndentationError" | "TabError";
  /** Omitted for stdin/string compilation diagnostics such as File "<stdin>". */
  file?: string;
  /** One-based source line reported by Python, when present. */
  line?: number;
  /** Basename-only label safe to repeat in a recovery instruction. */
  label?: string;
}

/** Extract Python's parse-time diagnostic without executing or interpreting any source text. */
export function pythonSyntaxDiagnostic(content: string): PythonSyntaxDiagnostic | undefined {
  const kindMatch = /(?:^|\r?\n)\s*(SyntaxError|IndentationError|TabError)(?=:|\s*$)/u.exec(content);
  if (!kindMatch) return undefined;
  const kind = kindMatch[1] as PythonSyntaxDiagnostic["kind"];
  const fileMatches = [...content.matchAll(/\bFile\s+["']([^"'\r\n]+)["']\s*,\s*line\s+(\d+)/gu)];
  const fileMatch = fileMatches.at(-1);
  const rawFile = fileMatch?.[1]?.trim();
  const file = rawFile && !/^<[^>]+>$/u.test(rawFile) ? rawFile : undefined;
  const lineValue = fileMatch ? Number(fileMatch[2]) : undefined;
  const line = Number.isSafeInteger(lineValue) && (lineValue ?? 0) > 0 ? lineValue : undefined;
  const rawLabel = file
    ? file.replace(/\\/gu, "/").split("/").filter(Boolean).at(-1)
    : undefined;
  const label = rawLabel?.replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, 160) || undefined;
  return {
    kind,
    ...(file ? { file } : {}),
    ...(line ? { line } : {}),
    ...(label ? { label } : {}),
  };
}

/** Deterministic recovery instruction appended to a failed execution result. It deliberately names only
 * the basename: full local paths and source lines already remain in the private tool transcript. */
export function pythonSyntaxRecoveryNote(content: string): string {
  const diagnostic = pythonSyntaxDiagnostic(content);
  if (!diagnostic) return "";
  const location = diagnostic.label
    ? `${diagnostic.label}${diagnostic.line ? `:${diagnostic.line}` : ""}`
    : "the submitted Python source";
  const inspect = diagnostic.file
    ? "Before another edit, call read_file for that exact file and the reported line region; repair from the current bytes, not from an earlier draft or a guessed old_string. "
    : "Revise the submitted source materially instead of resending the same code. ";
  return (
    `\n\n↺ hara syntax recovery: Python reported ${diagnostic.kind} at ${location}. ${inspect}` +
    "Use straight ASCII quotes as Python delimiters (typographic quotes may appear only inside an already quoted string/comment), " +
    "then run syntax validation again. For one-shot library work, prefer the python tool's stdin source instead of a durable helper .py file."
  );
}

function webFetchStrategyAnchor(name: string, input: unknown): string | undefined {
  if (name !== "web_fetch" || !input || typeof input !== "object") return undefined;
  const raw = (input as Record<string, unknown>).url;
  if (typeof raw !== "string") return undefined;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    return `web_fetch+${parsed.hostname.toLowerCase()}`;
  } catch {
    return undefined;
  }
}

function commandStrategyAnchor(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const command = (input as Record<string, unknown>).command;
  if (typeof command !== "string" || !command.trim()) return undefined;
  const lower = command.toLowerCase();
  const executable = /\b(curl|wget|powershell(?:\.exe)?|pwsh(?:\.exe)?|python\d*(?:\.exe)?|node(?:\.exe)?|bash|sh)\b/iu.exec(lower)?.[1];
  const script = /(?:^|[\s"'=])([^\s"'=]+\.(?:ps1|py|m?js|cjs|ts|sh))(?=$|[\s"'])/iu.exec(command)?.[1]
    ?.replace(/\\/gu, "/")
    .toLowerCase();
  const rawUrl = /https?:\/\/[^\s"'<>]+/iu.exec(command)?.[0];
  let endpoint: string | undefined;
  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      parsed.username = "";
      parsed.password = "";
      endpoint = `${parsed.hostname.toLowerCase()}${parsed.pathname
        .replace(/\b\d+\b/gu, ":id")
        .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/giu, ":id")}`;
    } catch {
      // A malformed URL is already part of the exact-call breaker, not a semantic strategy family.
    }
  }
  // An interpreter/executable alone is far too broad: unrelated Python or PowerShell commands can return
  // the same API status. Only form a semantic strategy family around a concrete script or endpoint.
  if (!script && !endpoint) return undefined;
  const parts = [executable, script, endpoint].filter((value): value is string => Boolean(value));
  return parts.length ? [...new Set(parts)].join("+") : undefined;
}

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

  if (name === "python") return /^Python failed:/u.test(text);
  if (name === "memory_search" || name === "session_search") {
    return /^\(no (?:memory|session) matches\)\s*$/.test(text);
  }
  if (name === "web_search") return /^Search failed across available providers\b/.test(text);
  if (name === "external_agent") {
    return /^(?:external_agent is disabled\b|Unknown backend\b|'[^'\r\n]+' CLI not found\b|\[[^\]\r\n]+\]\s+failed\b|\[[^\]\r\n]+\s+exit\s+(?!0\b)[^\]\r\n]+\])/.test(text);
  }
  if (name === "cronjob" || name === "cron") return /^✗\s+\S+\s+failed\s*:/.test(text);
  if (name === "computer") {
    return /^(?:Refused:|Screen control is off\.|No apps allowlisted\b|Grounding needs (?:native image input|a vision model that can see images)\b|'[^'\r\n]+' needs a higher tier\b|(?:activate|find|click\/move) needs\b|⛔ Stopping screen control\b)/.test(text)
      || /^Screenshot saved\b[\s\S]*\b(?:switch to a model with native image input|configure a vision model so I can read it)\b/i.test(text);
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
  /** No-progress failures allowed before the run-level breaker stops another model round. */
  hardStopAfter: number;
  kind: "exact" | "home_boundary" | "empty_recall" | "strategy";
}

/** All no-progress failure identities. Exact calls stop on the second attempt; materially different
 * command variants sharing one stable endpoint/script + high-signal error stop on the third. */
export function failureIdentities(
  name: string,
  input: unknown,
  content: string,
  isError = false,
): FailureIdentity[] {
  const failed = isError || looksFailed(content, name);
  if (failed && isHomeWorkspaceBoundaryFailure(content)) {
    return [{
      key: HOME_WORKSPACE_BOUNDARY_KEY,
      label: "Home workspace boundary",
      semantic: true,
      // One rejected read is recoverable: the model can switch to an explicit project workspace or
      // ask the user for it. Stop only when it ignores that feedback and hits the same boundary again.
      hardStopAfter: 2,
      kind: "home_boundary",
    }];
  }
  if (
    failed &&
    (name === "memory_search" || name === "session_search") &&
    /^\(no (?:memory|session) matches\)\s*$/.test(content.trimStart())
  ) {
    return [{
      // Different queries and both recall tools share one no-progress cause. Otherwise a model can evade
      // the breaker by paraphrasing the same empty lookup dozens of times or alternating tools.
      key: EMPTY_RECALL_KEY,
      label: "memory/session search with no matches",
      semantic: true,
      hardStopAfter: 3,
      kind: "empty_recall",
    }];
  }
  const identities: FailureIdentity[] = [{
    key: keyOf(name, input),
    label: `${name} call`,
    semantic: false,
    hardStopAfter: 2,
    kind: "exact",
  }];
  if (failed) {
    const signal = stableFailureSignal(content);
    const anchor = commandStrategyAnchor(input) ?? webFetchStrategyAnchor(name, input);
    if (signal && anchor) {
      identities.push({
        key: `root-cause:command-strategy:${anchor}:${signal}`,
        label: `${anchor} approach (${signal})`,
        semantic: true,
        hardStopAfter: name === "web_fetch" ? 2 : 3,
        kind: "strategy",
      });
    }
  }
  return identities;
}

/** Primary identity retained for callers that need the historical one-cause view. */
export function failureIdentity(
  name: string,
  input: unknown,
  content: string,
  isError = false,
): FailureIdentity {
  return failureIdentities(name, input, content, isError)[0];
}

/** Record a completed call; returns a warning to APPEND to the tool result when the same call has now
 * failed >=2x without intervening success (empty string otherwise). Pure aside from the scoped map. */
export function recordCall(name: string, input: unknown, content: string, isError = false, scope?: string): string {
  const failed = isError || looksFailed(content, name);
  const identities = failureIdentities(name, input, content, isError);
  const seen = scopedSeen(scope);
  if (!failed) {
    seen.clear(); // any success is progress; a later failure starts a fresh no-progress streak
    return "";
  }
  const next = identities.map((identity) => {
    const streak = { fails: (seen.get(identity.key)?.fails ?? 0) + 1 };
    // Refresh insertion order so the fixed-size ledger drops the least recently observed identity.
    seen.delete(identity.key);
    seen.set(identity.key, streak);
    return { identity, streak };
  });
  while (seen.size > MAX_FAILURE_IDENTITIES_PER_SCOPE) {
    const oldest = seen.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    seen.delete(oldest);
  }
  const exact = next.find(({ identity }) => identity.kind === "exact");
  const semantic = next.find(({ identity }) => identity.kind !== "exact");
  const selected = semantic?.identity.kind === "home_boundary" || semantic?.identity.kind === "empty_recall"
    ? semantic
    : exact && exact.streak.fails >= exact.identity.hardStopAfter
      ? exact
      : next.find(({ identity, streak }) => identity.kind === "strategy" && streak.fails >= 2)
        ?? exact;
  const identity = selected!.identity;
  const s = selected!.streak;
  if (identity.kind === "home_boundary") {
    if (s.fails === 1) {
      return (
        "\n\n⟳ hara: the first project tool was blocked by the Home workspace boundary — " +
        "this call was rejected, but the run can continue. Switch to an explicit project workspace already supplied by the user, " +
        "or ask them to use `/cd <project>` (the current conversation will continue); do not try another filesystem/search tool from Home."
      );
    }
    return (
      `\n\n⟳ hara: the same ${identity.label} has now blocked ${s.fails} calls without intervening progress — ` +
      "another filesystem/search tool cannot bypass it. Ask the user to switch with `/cd <project>` and keep the current conversation " +
      "or stop this run; do not probe another directory tool from Home."
    );
  }
  if (identity.kind === "empty_recall") {
    if (s.fails < identity.hardStopAfter) {
      return (
        `\n\n⟳ hara: ${s.fails} memory/session search${s.fails === 1 ? " has" : "es have"} returned no matches without intervening progress. ` +
        `Try at most ${identity.hardStopAfter - s.fails} more materially different recall ${identity.hardStopAfter - s.fails === 1 ? "query" : "queries"}; ` +
        "then stop searching and answer from current evidence or tell the user the history was not found."
      );
    }
    return (
      `\n\n⟳ hara: ${s.fails} memory/session searches returned no matches without intervening progress — stop recall calls now. ` +
      "Recall tools are disabled for the rest of this turn. Tell the user the prior history was not found, " +
      "then ask for the missing detail or whether to recreate it."
    );
  }
  if (identity.kind === "strategy") {
    if (s.fails < identity.hardStopAfter) {
      return (
        `\n\n⟳ hara: ${s.fails} variants of the same ${identity.label} have failed without intervening progress. ` +
        "Stop tuning parameters blindly: inspect existing workspace tools/scripts and question the API, library, or shell-boundary assumption. " +
        "Try one materially different strategy; another variant of this approach will stop the run."
      );
    }
    return (
      `\n\n⟳ hara: ${s.fails} variants of the same ${identity.label} have failed without intervening progress — stop this strategy now. ` +
      "Inspect existing workspace tools/scripts, challenge the underlying API/library assumption, and switch language, library, or endpoint before continuing."
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
