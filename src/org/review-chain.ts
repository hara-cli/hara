// Multi-role review chain — hara's "runs like an engineering org" move. After an implementer makes
// changes, a reviewer role inspects the diff and either APPROVES or requests changes; requested changes
// feed back to the implementer, looping until approved or a round cap. The orchestration lives in runOrg
// (it needs runAgent + providers); these are the pure, testable pieces: verdict parsing, change capture,
// and the prompts. Used by `hara org --review`.
import { execFileSync } from "node:child_process";

/** Fallback reviewer persona when the project has no `reviewer` role. Read-only by intent. */
export const REVIEWER_SYSTEM = `You are a senior code reviewer reviewing changes made to accomplish a task.
Inspect them for: correctness and bugs, security, missing edge cases, and whether they actually accomplish
the task. Use read_file / grep / glob / ls to inspect context and any new files. Be concrete and specific —
cite files. Block only on real problems (bugs, breakage, security), not style preferences.

A script parses your final line, so it MUST be EXACTLY one of these two, verbatim, as the LAST line —
the literal word APPROVED or CHANGES_REQUESTED. Do NOT paraphrase it (not "No issues found", not "LGTM"),
do NOT bold it, do NOT add words after the token:
VERDICT: APPROVED
VERDICT: CHANGES_REQUESTED

Use APPROVED only if the changes correctly and safely accomplish the task. If anything must be fixed, use
CHANGES_REQUESTED and list the required fixes as a short numbered list ABOVE the verdict line — each one
naming the file and exactly what to change.`;

// Real models won't reliably emit the literal token — across live runs glm-5 wrote `VERDICT: APPROVED`,
// `**VERDICT**: No issues found`, and `**VERDICT**: PASS`. So we anchor on the (markdown-tolerant) VERDICT
// marker, then CLASSIFY the phrase after it: a "changes" signal vetoes (safer), an "approve" signal passes,
// and anything ambiguous stays NOT approved — worst case is one extra review round, never a bad auto-commit.
const CHANGES_RE = /\b(changes?[ _-]?request\w*|request\w*[ _-]?changes?|fail(ed|ure)?|reject\w*|block\w*|rework|needs?[ _-]?(work|fix\w*|change\w*)|must[ _-]?(fix|change)|not[ _-]?approv\w*)\b/i;
const APPROVE_RE = /\b(approv\w*|passe?d?|lgtm|accept\w*|ship[ _-]?it|no[ _-]?(issues?|problems?|changes?|concerns?)|looks?[ _-]?good)\b/i;

/** Parse a reviewer's reply into a verdict — see the note above for why it's lenient. Takes the LAST
 *  VERDICT marker (the final call) and classifies the phrase after it; `issues` is the body before it. */
export function parseVerdict(text: string): { approved: boolean; issues: string } {
  const markers = [...text.matchAll(/VERDICT\b[*_:\s]*/gi)];
  const last = markers[markers.length - 1];
  if (!last) return { approved: false, issues: text.trim() };
  const idx = last.index ?? 0;
  const after = text.slice(idx + last[0].length, idx + last[0].length + 80); // the verdict phrase itself
  const approved = !CHANGES_RE.test(after) && APPROVE_RE.test(after); // changes-signal vetoes; ambiguous = not approved
  return { approved, issues: text.slice(0, idx).trim() };
}

/** Capture the working-tree changes vs HEAD (what to review). Non-destructive; empty for a non-git dir
 *  or a repo with no commits. New (untracked) files are listed by name — the reviewer can read_file them. */
export function captureChanges(cwd: string, cap = 100_000): { diff: string; newFiles: string[] } {
  const git = (args: string[]): string => {
    try {
      return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 50_000_000 });
    } catch {
      return "";
    }
  };
  let diff = git(["diff", "HEAD"]).trim();
  if (diff.length > cap) diff = diff.slice(0, cap) + "\n…[diff truncated]";
  const newFiles = git(["ls-files", "--others", "--exclude-standard"])
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 50);
  return { diff, newFiles };
}

/** True only if the working tree is fully clean — no uncommitted changes. The `--commit` capstone uses
 *  this as a guard: `git add -A` + commit is only safe to run when the tree was clean before the org ran,
 *  so it captures THIS run's work and never sweeps up pre-existing WIP. False for a non-git dir. */
export function isTreeClean(cwd: string): boolean {
  try {
    return execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8", maxBuffer: 50_000_000 }).trim() === "";
  } catch {
    return false; // not a git repo / git error → treat as "not clean" so we never auto-commit blindly
  }
}

/** Strip a leading/trailing markdown code fence a model sometimes wraps a commit message in. */
export function stripCommitFence(text: string): string {
  return text.trim().replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "").trim();
}

/** The reviewer's input: the task + the changes to review. */
export function reviewPrompt(task: string, changes: { diff: string; newFiles: string[] }): string {
  const parts = [`Task that was implemented:\n${task}`, ""];
  if (changes.diff) parts.push("Changes (working tree vs HEAD):\n```diff\n" + changes.diff + "\n```");
  if (changes.newFiles.length) parts.push(`New files (use read_file to inspect): ${changes.newFiles.join(", ")}`);
  if (!changes.diff && !changes.newFiles.length) parts.push("(no diff captured — inspect the working tree with git / read_file)");
  parts.push("\nReview these changes against the task. Finish with your VERDICT line.");
  return parts.join("\n");
}

/** Feed the reviewer's requested changes back to the implementer. */
export function fixPrompt(issues: string): string {
  return `A code reviewer reviewed your changes and requires these fixes before this can ship:\n\n${issues}\n\nMake these fixes now — edit the files directly; don't just explain.`;
}
