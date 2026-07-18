// Guardian — an internal safety layer that sits ON TOP of the existing stack (permission rules →
// PreToolUse hooks → approval gate → soft stuck-guard). It exists for the one failure mode those don't
// cover: a genuinely dangerous, irreversible action that slips through (no deny rule, auto-approved mode,
// a cron/gateway run with `confirm: () => true`). Two moving parts:
//
//   1. A DETERMINISTIC risk classifier that runs FIRST and is the whole point of "zero latency on normal
//      work": read tools, in-project edits, and ordinary shell commands are classified `low` in pure Node
//      (no LLM, no I/O) and skip the guardian entirely. Only a handful of genuinely destructive shapes
//      (rm -rf, dd, mkfs, curl|sh, sudo, force-push, broad chmod -R, writes outside the project root, …)
//      are classified `high` and escalate.
//   2. A conservative LLM veto that runs ONLY on `high` actions: it asks a cheap model "is this action
//      clearly dangerous or clearly off-task?" and defaults to ALLOW. Any glitch (timeout, error, no model
//      configured) FAILS OPEN — a guardian hiccup must never break legitimate work, because the permission
//      rules + the user's own approval gate still apply independently.
//
// Plus a deterministic circuit-breaker: N guardian BLOCKS in one run (or an escalating-destructive runaway)
// trips a hard stop that requires explicit user confirmation to continue — a harder stop than the soft
// stuck-guard nudge, and one that aborts safely (never hangs) when there's no interactive user.
import { resolve, isAbsolute, relative, sep, win32 } from "node:path";
import type { Provider, NeutralMsg } from "../providers/types.js";
import { boundedProviderTurn } from "../providers/bounded-turn.js";
import { canonicalize, splitCompound } from "./permissions.js";

export type RiskLevel = "low" | "high";
export type GuardianDecision = "allow" | "block";
export interface GuardianVerdict {
  decision: GuardianDecision;
  reason: string;
}

// ── Deterministic risk classifier ────────────────────────────────────────────────────────────────────
// The classifier is intentionally NARROW: false positives here cost latency + an LLM call + potential
// annoyance, so we only flag shapes that are destructive/irreversible in practice. Everything else is `low`.

// A path is "broad" (a whole tree / outside the sandbox) when it's `/`, a top-level system dir, a home dir,
// `.`/`*`/`~`, or absolute-outside-cwd. `chmod -R`/`chown -R`/`rm -rf` on a broad path is the danger, not on
// a project-local subdir.
const SYSTEM_ROOTS = /^(\/|\/(bin|boot|dev|etc|home|lib|opt|proc|root|sbin|srv|sys|usr|var|Users|Applications|System|Library|Volumes)(\/|$)|~|\$HOME)/;

/** Genuinely destructive/irreversible single-command shapes (checked against the canonical form of each
 *  part of a compound command). Kept tight — see the module header. */
function isDestructiveCommand(canonical: string): boolean {
  const c = canonical;
  if (!c) return false;
  // rm -rf / rm -fr / recursive-forced removal (the classic).
  if (/\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|-r\s+-f|-f\s+-r|--recursive\s+--force|--force\s+--recursive)\b/.test(c)) return true;
  // rm -r/-rf targeting a broad/system path (rm -rf / , rm -rf ~ , rm -r /etc …).
  if (/\brm\s+-[a-z]*r/.test(c) && /\brm\s+-[a-z]*r[a-z]*\s+(\/|~|\$HOME|\*|\.\s|\.$)/.test(c)) return true;
  // Raw-disk / filesystem-destroying tools.
  if (/\b(dd)\b/.test(c) && /\bof=\/dev\//.test(c)) return true;
  if (/\b(mkfs(\.\w+)?|mke2fs|fdisk|parted|wipefs|shred)\b/.test(c)) return true;
  if (/\bdiskutil\s+(erase|reformat|partitionDisk)/i.test(c)) return true;
  // Fork bomb.
  if (/:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(c) || /\.\(\)\{\s*\.\|\.&\s*\}/.test(c)) return true;
  // Pipe-to-shell from the network (curl … | sh, wget … | bash) — arbitrary remote code execution.
  if (/\b(curl|wget|fetch)\b[^|]*\|\s*(sudo\s+)?(ba|z)?sh\b/.test(c)) return true;
  // Privilege escalation.
  if (/\bsudo\b/.test(c)) return true;
  if (/\bkillall\b/.test(c)) return true;
  // Force-push (rewrites shared history irreversibly).
  if (/\bgit\s+push\b[^\n]*(--force\b|--force-with-lease\b|(^|\s)-f\b)/.test(c)) return true;
  // Broad recursive permission/ownership change.
  if (/\b(chmod|chown|chgrp)\s+(-[a-z]*R|--recursive)/.test(c)) {
    if (SYSTEM_ROOTS.test(commandTarget(c)) || /\s(\/|~|\$HOME|\*|\.)(\s|$)/.test(c)) return true;
  }
  // Destructive git tree resets / clean.
  if (/\bgit\s+clean\b[^\n]*-[a-z]*f/.test(c) && /-[a-z]*d/.test(c)) return true;
  // History overwrite: `> /path` (truncation) onto a system/absolute-outside path is handled by the
  // out-of-project write check below (redirection carries a path); nothing extra here.
  return false;
}

/** The last whitespace token that looks like a path target of a command (best-effort, for chmod/chown). */
function commandTarget(canonical: string): string {
  const toks = canonical.split(/\s+/).filter((t) => t && !t.startsWith("-"));
  return toks[toks.length - 1] ?? "";
}

/** Extract `> file` / `>> file` redirection targets from a canonical command (quote-naive; classifier only). */
function redirectionTargets(canonical: string): string[] {
  const out: string[] = [];
  const re = />>?\s*("([^"]*)"|'([^']*)'|([^\s;|&]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(canonical))) {
    const p = m[2] ?? m[3] ?? m[4];
    if (p && p !== "/dev/null" && !p.startsWith("&") && !/^\d$/.test(p)) out.push(p);
  }
  return out;
}

/** True if `p` resolves OUTSIDE the project/cwd root (a write/delete escaping the sandbox). Non-file
 *  pseudo-paths (/dev/null) and empties are treated as in-scope. */
export function isOutsideRoot(p: string, cwd: string): boolean {
  if (!p || p === "/dev/null" || p === "-") return false;
  // Windows uses `\\` boundaries, so concatenating `root + "/"` classifies every ordinary child as
  // outside. `relative` expresses containment portably. Detect an explicit Windows root as well so the
  // classifier remains testable and safe when a control-plane caller runs on another host.
  const windowsRoot = win32.isAbsolute(cwd);
  const pathApi = windowsRoot
    ? { resolve: win32.resolve, isAbsolute: win32.isAbsolute, relative: win32.relative, sep: win32.sep }
    : { resolve, isAbsolute, relative, sep };
  const expanded = p.replace(/^~(?=[/\\]|$)/, process.env.HOME ?? process.env.USERPROFILE ?? "~");
  const abs = pathApi.isAbsolute(expanded) ? pathApi.resolve(expanded) : pathApi.resolve(cwd, expanded);
  const root = pathApi.resolve(cwd);
  const rel = pathApi.relative(root, abs);
  return rel !== "" && (rel === ".." || rel.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(rel));
}

/** Collect the file paths an edit-kind tool would write/delete, from its tool input. */
export function editPaths(name: string, input: Record<string, unknown>): string[] {
  const paths: string[] = [];
  if (typeof input.path === "string") paths.push(input.path);
  // apply_patch: { changes: [{ path, ... }] }
  if (Array.isArray(input.changes)) {
    for (const ch of input.changes) if (ch && typeof ch.path === "string") paths.push(ch.path);
  }
  return paths;
}

/** Deterministic risk classifier. Runs FIRST, in pure Node — this is what keeps normal work at zero cost.
 *  Returns `low` for read tools, in-project edits, and ordinary shell commands (→ guardian is skipped
 *  entirely); `high` only for destructive/irreversible bash or writes/deletes outside the project root. */
export function classifyRisk(
  toolName: string,
  toolKind: string | undefined,
  input: Record<string, unknown>,
  cwd: string,
): { level: RiskLevel; reason: string } {
  if (toolKind === "read" || !input) return { level: "low", reason: "" };

  if (toolKind === "edit") {
    for (const p of editPaths(toolName, input)) {
      if (isOutsideRoot(p, cwd)) return { level: "high", reason: `writes/deletes outside the project root: ${p}` };
    }
    return { level: "low", reason: "" };
  }

  if (toolKind === "exec" && typeof input.command === "string") {
    const command = input.command;
    const whole = canonicalize(command);
    // Whole-command check FIRST — catches cross-part shapes a compound split would hide (curl … | sh, where
    // the danger is the pipe connecting two individually-benign parts).
    if (isDestructiveCommand(whole)) return { level: "high", reason: `destructive/irreversible command: ${whole.slice(0, 120)}` };
    // Then per-part: strictest part wins; if we can't safely parse it, fall back to the whole canonical form.
    const parts = splitCompound(command) ?? [whole];
    for (const part of parts) {
      if (isDestructiveCommand(part)) return { level: "high", reason: `destructive/irreversible command: ${part.slice(0, 120)}` };
      for (const t of redirectionTargets(part)) {
        if (isOutsideRoot(t, cwd)) return { level: "high", reason: `writes outside the project root via redirection: ${t}` };
        if (SYSTEM_ROOTS.test(t)) return { level: "high", reason: `writes to a system path: ${t}` };
      }
    }
    return { level: "low", reason: "" };
  }

  // computer / unknown non-read kinds are already gated hard elsewhere (always-confirm); leave them to that.
  return { level: "low", reason: "" };
}

// ── LLM veto (conservative; high-risk only) ──────────────────────────────────────────────────────────

const GUARDIAN_SYSTEM =
  `You are a safety guardian for a coding agent. You are shown a SINGLE high-risk action the agent is about ` +
  `to take, plus a short summary of the user's task. Decide whether to ALLOW or BLOCK it. Default to ALLOW. ` +
  `Only BLOCK when the action is CLEARLY dangerous/irreversible AND not plausibly part of the stated task ` +
  `(e.g. deleting unrelated files, wiping a disk, exfiltrating data, force-pushing over shared history when ` +
  `the task never asked for it), or when it is CLEARLY misaligned with the task. If the action is a ` +
  `reasonable step toward the task — even a destructive one the user likely wants — ALLOW it. When unsure, ` +
  `ALLOW. Reply with ONLY compact JSON: {"decision":"allow"|"block","reason":"<one short sentence>"}.`;

/** Parse the model's reply into a verdict. Anything we can't confidently read as a BLOCK is treated as
 *  ALLOW (fail-open on ambiguity). */
export function parseVerdict(text: string): GuardianVerdict {
  const raw = (text ?? "").trim();
  // Try strict JSON first, then the first {...} blob.
  const tryParse = (s: string): GuardianVerdict | null => {
    try {
      const j = JSON.parse(s) as { decision?: unknown; reason?: unknown };
      if (j && (j.decision === "block" || j.decision === "allow")) {
        return { decision: j.decision, reason: typeof j.reason === "string" ? j.reason : "" };
      }
    } catch {
      /* fall through */
    }
    return null;
  };
  const direct = tryParse(raw);
  if (direct) return direct;
  const m = /\{[\s\S]*\}/.exec(raw);
  if (m) {
    const blob = tryParse(m[0]);
    if (blob) return blob;
  }
  // No parseable verdict → fail open.
  return { decision: "allow", reason: "" };
}

/** A brief, safe task-context summary for the guardian prompt: the most recent genuine user message,
 *  truncated. Kept short (cheap call, and we don't want to leak the whole transcript). */
export function taskSummary(history: NeutralMsg[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === "user" && typeof m.content === "string" && m.content.trim()) {
      return m.content.trim().replace(/\s+/g, " ").slice(0, 500);
    }
  }
  return "(no task context available)";
}

const DEFAULT_TIMEOUT_MS = 6000;

/** Ask the cheap model to veto a single high-risk action. Conservative + fail-open:
 *   - no provider            → allow (guardian effectively off; deterministic layers still apply)
 *   - timeout / error        → allow (a guardian glitch must never break legit work)
 *   - unparseable reply      → allow
 *  Only a clean, parsed `block` blocks. */
export async function guardianVeto(
  provider: Provider | null | undefined,
  action: { tool: string; detail: string; classifierReason: string },
  history: NeutralMsg[],
  opts: {
    timeoutMs?: number;
    signal?: AbortSignal;
    onProviderTurn?: (turn: Promise<unknown>) => void;
  } = {},
): Promise<GuardianVerdict> {
  if (!provider) return { decision: "allow", reason: "" }; // fail-open: no model → deterministic layers still guard

  const prompt =
    `TASK CONTEXT:\n${taskSummary(history)}\n\n` +
    `HIGH-RISK ACTION (flagged: ${action.classifierReason}):\n` +
    `tool: ${action.tool}\n${action.detail}\n\n` +
    `Allow or block this action? Reply with only the JSON verdict.`;

  try {
    const r = await boundedProviderTurn(provider, {
      system: GUARDIAN_SYSTEM,
      history: [{ role: "user", content: prompt }],
      tools: [],
      onText: () => {},
    }, {
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      signal: opts.signal,
      label: "security guardian",
      onProviderTurn: opts.onProviderTurn,
    });
    if (r.stop === "error") return { decision: "allow", reason: "" }; // fail-open on model error
    return parseVerdict(r.text);
  } catch {
    return { decision: "allow", reason: "" }; // fail-open on timeout/abort/throw
  }
}

// ── Circuit-breaker (deterministic, hard stop) ─────────────────────────────────────────────────────────

export interface BreakerState {
  blocks: number; // guardian BLOCKs so far this run
  tripped: boolean; // once true, stays true until the user explicitly clears it
}

export function newBreaker(): BreakerState {
  return { blocks: 0, tripped: false };
}

/** Record a guardian BLOCK; trip the breaker at the threshold. Returns the (possibly updated) state's
 *  tripped flag. Deterministic — a harder stop than the soft stuck-guard nudge. */
export function recordBlock(state: BreakerState, threshold = GUARDIAN_BLOCK_THRESHOLD): boolean {
  state.blocks += 1;
  if (state.blocks >= threshold) state.tripped = true;
  return state.tripped;
}

export const GUARDIAN_BLOCK_THRESHOLD = 3;

// ── Config ─────────────────────────────────────────────────────────────────────────────────────────────

/** Guardian is ON by default and only engages on high-risk actions (so normal turns are untouched).
 *  Off via `HARA_GUARDIAN=0` (or config key `guardian: "off"`). Any other value / unset → on. */
export function guardianEnabled(config?: { guardian?: string }): boolean {
  const env = process.env.HARA_GUARDIAN;
  if (env !== undefined) return !(env === "0" || env.toLowerCase() === "off" || env.toLowerCase() === "false");
  if (config?.guardian !== undefined) return !(config.guardian === "off" || config.guardian === "false");
  return true; // default on
}
