// `hara feedback` — the hara-hub verdict made flesh: feedback is a COMMAND, not a server.
// Collects environment facts, redacts secrets, and builds a structured GitHub issue body that
// humans and agents file through the same door (gh CLI when present, copy-paste text otherwise).
// The session tail is OFF by default and explicitly opt-in (--session) because issues are public.
import { platform, release, arch } from "node:os";

export interface FeedbackEnv {
  version: string;
  os: string;
  node: string;
  /** "<provider>:<model>" — never keys/URLs with credentials */
  model?: string;
}

export function collectEnv(version: string, model?: string): FeedbackEnv {
  return {
    version,
    os: `${platform()} ${release()} ${arch()}`,
    node: process.version,
    model,
  };
}

/** Strip credential-looking material from text that is about to become a PUBLIC issue.
 *  Deliberately aggressive: false positives cost a little readability, false negatives leak keys. */
export function redact(text: string): string {
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "sk-***")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "gh*_***")
    .replace(/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, "AWS-KEY-***")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, "Bearer ***")
    .replace(/\b(api[_-]?key|apikey|token|secret|password|passwd|authorization)(["']?\s*[:=]\s*["']?)[^\s"',;]{6,}/gi, "$1$2***")
    .replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "JWT-***");
}

/** The structured issue body — same shape as .github/ISSUE_TEMPLATE/bug_report.yml so hand-filed
 *  and command-filed issues read identically to the triage side. */
export function buildIssueBody(description: string, env: FeedbackEnv, sessionTail?: string): string {
  const parts = [
    "## What happened",
    "",
    redact(description.trim() || "(no description provided)"),
    "",
    "## Environment",
    "",
    "| | |",
    "|---|---|",
    `| hara | ${env.version} |`,
    `| os | ${env.os} |`,
    `| node | ${env.node} |`,
    ...(env.model ? [`| model | ${redact(env.model)} |`] : []),
    "",
  ];
  if (sessionTail && sessionTail.trim()) {
    parts.push(
      "## Session tail (redacted, shared with --session)",
      "",
      "```",
      redact(sessionTail).slice(0, 4000),
      "```",
      "",
    );
  }
  parts.push("---", "_filed via `hara feedback`_");
  return parts.join("\n");
}

/** Issue title from the description: first line, trimmed, capped. */
export function issueTitle(description: string): string {
  const first = (description.trim().split("\n")[0] || "feedback").trim();
  return first.length > 70 ? first.slice(0, 67) + "…" : first;
}

export const FEEDBACK_REPO = "hara-cli/hara";
export const NEW_ISSUE_URL = `https://github.com/${FEEDBACK_REPO}/issues/new`;
