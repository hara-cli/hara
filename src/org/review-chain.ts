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

End your review with EXACTLY ONE verdict line, on its own line, as the LAST line:
VERDICT: APPROVED            — the changes correctly and safely accomplish the task
VERDICT: CHANGES_REQUESTED   — something must be fixed first

If CHANGES_REQUESTED, list the required fixes as a short numbered list ABOVE the verdict line — each one
naming the file and exactly what to change.`;

/** Parse a reviewer's reply into a verdict. Takes the LAST verdict line (the reviewer's final call);
 *  defaults to NOT approved when no verdict line is present (never claim approval we can't see). */
export function parseVerdict(text: string): { approved: boolean; issues: string } {
  const matches = [...text.matchAll(/^[ \t>*-]*VERDICT:\s*(APPROVED|CHANGES_REQUESTED)/gim)];
  const m = matches[matches.length - 1];
  if (!m) return { approved: false, issues: text.trim() };
  const approved = m[1].toUpperCase() === "APPROVED";
  return { approved, issues: text.slice(0, m.index).trim() }; // body before the verdict = the requested changes
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
