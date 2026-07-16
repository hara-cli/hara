// Multi-role review chain — hara's "runs like an engineering org" move. After an implementer makes
// changes, a reviewer role inspects the diff and either APPROVES or requests changes; requested changes
// feed back to the implementer, looping until approved or a round cap. The orchestration lives in runOrg
// (it needs runAgent + providers); these are the pure, testable pieces: verdict parsing, change capture,
// and the prompts. Used by `hara org --review`.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { verifyOpenedRegularFileSync } from "../fs-read.js";
import { optionalPosixOpenFlag } from "../fs-open-flags.js";
import { sensitiveFileReason } from "../security/sensitive-files.js";
import { redactToolSubprocessOutput, toolSubprocessEnv } from "../security/subprocess-env.js";

export interface CapturedChanges {
  diff: string;
  newFiles: string[];
  /** Protected paths deliberately omitted from model context. Their contents are never returned. */
  skippedFiles: string[];
  /** Safe display labels for tracked deletions. Historical blob contents are deliberately never returned. */
  omittedDeletions: string[];
  error?: string;
}

export interface CaptureChangesOptions {
  staged?: boolean;
  base?: string;
  includeUntracked?: boolean;
}

const MAX_CHANGED_PATHS = 4096;
const GIT_CAPTURE_TIMEOUT_MS = 10_000;
const MAX_STAGED_VERIFY_BYTES = 64 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;

function gitBytes(cwd: string, args: string[]): Buffer {
  return execFileSync("git", args, {
    cwd,
    env: toolSubprocessEnv(),
    encoding: "buffer",
    maxBuffer: 50_000_000,
    timeout: GIT_CAPTURE_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "ignore"],
  }) as Buffer;
}

function nulPaths(bytes: Buffer): string[] {
  const text = bytes.toString("utf8");
  // A replacement character means a POSIX byte filename could not be represented safely as a JS path.
  // Fail closed instead of accidentally diffing a path other than the one Git named.
  if (text.includes("\uFFFD")) throw new Error("git returned a filename that is not valid UTF-8");
  return text.split("\0").filter(Boolean);
}

function pathInside(cwd: string, path: string): boolean {
  const rel = relative(resolve(cwd), resolve(cwd, path));
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

interface ClassifiedPaths {
  protected: string[];
  missing: string[];
}

function safePathLabel(path: string): string {
  return redactToolSubprocessOutput(path);
}

function safePathLabels(paths: readonly string[]): string[] {
  return [...new Set(paths.map(safePathLabel))];
}

function classifyPaths(cwd: string, paths: readonly string[]): ClassifiedPaths {
  const classified: ClassifiedPaths = { protected: [], missing: [] };
  for (const path of paths) {
    if (!pathInside(cwd, path)) {
      classified.protected.push(path);
      continue;
    }
    const absolute = join(cwd, path);
    if (sensitiveFileReason(absolute) !== null) {
      classified.protected.push(path);
      continue;
    }
    try {
      const info = lstatSync(absolute);
      // A tracked directory is a submodule gitlink (Git emits only its object id). Every other non-regular
      // inode is excluded so FIFOs/devices/symlinks and hard-link aliases cannot enter model context.
      if (!info.isDirectory() && (!info.isFile() || info.nlink > 1)) classified.protected.push(path);
    } catch (error: any) {
      if (error?.code === "ENOENT") classified.missing.push(path);
      else classified.protected.push(path);
    }
  }
  return classified;
}

type DiffPathFormat = "name-status";

function diffArgs(options: CaptureChangesOptions, format: DiffPathFormat): string[] {
  const args = ["diff", "--no-ext-diff", "--no-textconv", "--no-renames"];
  if (format === "name-status") args.push("--name-status", "-z");
  if (options.staged) args.push("--staged");
  else if (options.base) {
    if (options.base.startsWith("-") || options.base.includes("\0")) throw new Error("invalid base ref");
    args.push(options.base);
  } else args.push("HEAD");
  return args;
}

function changedPathStatuses(cwd: string, options: CaptureChangesOptions): Map<string, string> {
  const fields = nulPaths(gitBytes(cwd, [...diffArgs(options, "name-status"), "--"]));
  const statuses = new Map<string, string>();
  for (let i = 0; i < fields.length;) {
    const rawStatus = fields[i++];
    if (!/^[ACDMRTUXB][0-9]*$/u.test(rawStatus)) throw new Error("git returned an invalid name-status record");
    const status = rawStatus[0];
    // --no-renames keeps C/R out of ordinary output, but consume both paths defensively if a Git variant
    // still reports one so a source name can never be mistaken for a status token.
    if (status === "C" || status === "R") {
      const source = fields[i++];
      const destination = fields[i++];
      if (source === undefined || destination === undefined) throw new Error("git returned a truncated name-status record");
      statuses.set(destination, status);
      continue;
    }
    const path = fields[i++];
    if (path === undefined) throw new Error("git returned a truncated name-status record");
    statuses.set(path, status);
  }
  return statuses;
}

interface StagedIndexEntry {
  mode: string;
  oid: string;
}

function stagedIndexEntry(cwd: string, path: string): StagedIndexEntry | null {
  const records = nulPaths(gitBytes(cwd, ["ls-files", "--stage", "-z", "--", path]));
  if (records.length !== 1) return null;
  const record = records[0];
  const tab = record.indexOf("\t");
  if (tab < 0 || record.slice(tab + 1) !== path) return null;
  const fields = record.slice(0, tab).split(" ");
  if (fields.length !== 3 || fields[2] !== "0" || !/^[0-9a-f]+$/u.test(fields[1])) return null;
  return { mode: fields[0], oid: fields[1] };
}

function verifiedWorktreeBlobOid(
  cwd: string,
  path: string,
  algorithm: "sha1" | "sha256",
  maxBytes: number,
): string {
  const absolute = join(cwd, path);
  const fd = openSync(
    absolute,
    constants.O_RDONLY | optionalPosixOpenFlag("O_NONBLOCK") | optionalPosixOpenFlag("O_NOFOLLOW"),
  );
  try {
    const before = fstatSync(fd);
    verifyOpenedRegularFileSync(absolute, before, {
      action: "verify staged commit content",
      rejectHardLinks: true,
      protectSensitive: true,
    });
    if (before.size > maxBytes) throw new Error("staged file exceeds verification limit");
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maxBytes) {
      const want = Math.min(READ_CHUNK_BYTES, maxBytes + 1 - total);
      const buffer = Buffer.allocUnsafe(want);
      const bytesRead = readSync(fd, buffer, 0, want, total);
      if (!bytesRead) break;
      chunks.push(buffer.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > maxBytes) throw new Error("staged file exceeds verification limit");
    const after = fstatSync(fd);
    verifyOpenedRegularFileSync(absolute, after, {
      action: "verify staged commit content",
      rejectHardLinks: true,
      protectSensitive: true,
    });
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
      || total !== before.size
    ) throw new Error("staged worktree file changed during verification");
    const hash = createHash(algorithm);
    hash.update(`blob ${total}\0`);
    for (const chunk of chunks) hash.update(chunk);
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}

function stagedBlobMatchesWorktree(cwd: string, path: string, maxBytes: number): boolean {
  try {
    const entry = stagedIndexEntry(cwd, path);
    if (!entry || (entry.mode !== "100644" && entry.mode !== "100755")) return false;
    const algorithm = entry.oid.length === 40 ? "sha1" : entry.oid.length === 64 ? "sha256" : null;
    if (!algorithm) return false;
    return verifiedWorktreeBlobOid(cwd, path, algorithm, maxBytes) === entry.oid;
  } catch {
    return false;
  }
}

function untrackedPaths(cwd: string): string[] {
  return nulPaths(gitBytes(cwd, ["ls-files", "--others", "--exclude-standard", "-z", "--"]));
}

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

/** Capture model-safe change metadata. Git patches are deliberately excluded because their old side is
 * historical content with no trustworthy current filesystem identity. Reviewers can read current files. */
export function captureChanges(cwd: string, cap = 100_000, options: CaptureChangesOptions = {}): CapturedChanges {
  try {
    const statuses = changedPathStatuses(cwd, options);
    const paths = [...statuses.keys()];
    const deleted = new Set(paths.filter((path) => statuses.get(path) === "D"));
    const includeUntracked = options.includeUntracked ?? (!options.staged && !options.base);
    const untracked = includeUntracked ? untrackedPaths(cwd) : [];
    if (paths.length + untracked.length > MAX_CHANGED_PATHS) {
      return { diff: "", newFiles: [], skippedFiles: [], omittedDeletions: [], error: `too many changed paths (>${MAX_CHANGED_PATHS})` };
    }
    const tracked = classifyPaths(cwd, paths);
    const untrackedClass = classifyPaths(cwd, untracked);
    const skippedRaw = new Set([...tracked.protected, ...untrackedClass.protected]);
    // A token-shaped untracked pathname is itself unsafe model input. Once staged, its diff header is
    // redacted like every other subprocess output; before then, omit it rather than advertise a false path.
    for (const path of untracked) if (safePathLabel(path) !== path) skippedRaw.add(path);
    // Missing is not synonymous with deleted: a staged AD entry has an added blob in the index while the
    // worktree path is absent. Only Git's exact D status is an omitted deletion; every other missing tracked
    // entry is unverifiable and remains protected.
    for (const path of tracked.missing) if (!deleted.has(path)) skippedRaw.add(path);
    const omittedRaw = paths.filter((path) => !skippedRaw.has(path) && deleted.has(path));
    const safePaths = paths.filter((path) => !skippedRaw.has(path) && !deleted.has(path));
    const missingUntracked = new Set(untrackedClass.missing);
    const newFiles = untracked
      .filter((path) => !skippedRaw.has(path) && !missingUntracked.has(path))
      .slice(0, 50);
    // Never provide a Git patch to a model: even an ordinary modification's old side can be a historical
    // hard-link alias of a credential, and a staged index blob can diverge from today's verified worktree.
    // Status + redacted path metadata is sufficient for reviewers to inspect the current file via read_file.
    let diff = safePaths.map((path) => `${statuses.get(path)}\t${safePathLabel(path)}`).join("\n");
    if (diff.length > cap) diff = diff.slice(0, cap) + "\n…[diff truncated]";
    return {
      diff,
      newFiles,
      skippedFiles: safePathLabels([...skippedRaw]),
      omittedDeletions: safePathLabels(omittedRaw),
    };
  } catch (error) {
    return {
      diff: "",
      newFiles: [],
      skippedFiles: [],
      omittedDeletions: [],
      error: redactToolSubprocessOutput(error instanceof Error ? error.message : String(error)),
    };
  }
}

/** Protected files currently staged for commit. Commit-message generation and commit both fail closed. */
export function protectedStagedPaths(cwd: string): string[] {
  try {
    const statuses = changedPathStatuses(cwd, { staged: true });
    if (statuses.size > MAX_CHANGED_PATHS) return ["(too many staged paths to verify)"];
    const classified = classifyPaths(cwd, [...statuses.keys()]);
    const unverifiable = new Set(classified.missing.filter((path) => statuses.get(path) !== "D"));
    const protectedSet = new Set(classified.protected);
    let remainingBytes = MAX_STAGED_VERIFY_BYTES;
    for (const [path, status] of statuses) {
      if (status === "D" || protectedSet.has(path) || unverifiable.has(path)) continue;
      let size = remainingBytes + 1;
      try { size = lstatSync(join(cwd, path)).size; } catch { /* verification below fails closed */ }
      if (
        !(["A", "M", "T"] as string[]).includes(status)
        || size > remainingBytes
        || !stagedBlobMatchesWorktree(cwd, path, remainingBytes)
      ) {
        unverifiable.add(path);
      } else {
        remainingBytes -= size;
      }
    }
    return safePathLabels([...classified.protected, ...unverifiable]);
  } catch {
    // An unreadable/ambiguous Git index cannot be declared safe to send to a model or commit automatically.
    return ["(unable to verify staged paths)"];
  }
}

/** Protected tracked/untracked changes that `git add -A` would stage. */
export function protectedWorkingTreePaths(cwd: string): string[] {
  try {
    // Compare HEAD directly with the final worktree. Combining cached + unstaged lists misclassifies an AD
    // entry that `git add -A` will collapse to no net change.
    const statuses = changedPathStatuses(cwd, {});
    const tracked = [...statuses.keys()];
    const untracked = untrackedPaths(cwd);
    if (tracked.length + untracked.length > MAX_CHANGED_PATHS) return ["(too many changed paths to verify)"];
    const trackedClass = classifyPaths(cwd, tracked);
    const untrackedClass = classifyPaths(cwd, untracked);
    const unverifiable = trackedClass.missing.filter((path) => statuses.get(path) !== "D");
    return safePathLabels([...trackedClass.protected, ...unverifiable, ...untrackedClass.protected]);
  } catch {
    return ["(unable to verify working-tree paths)"];
  }
}

/** Protected tracked changes that `git add -u` would stage (untracked files are intentionally excluded). */
export function protectedTrackedWorkingTreePaths(cwd: string): string[] {
  try {
    const statuses = changedPathStatuses(cwd, {});
    const tracked = [...statuses.keys()];
    if (tracked.length > MAX_CHANGED_PATHS) return ["(too many changed paths to verify)"];
    const classified = classifyPaths(cwd, tracked);
    const unverifiable = classified.missing.filter((path) => statuses.get(path) !== "D");
    return safePathLabels([...classified.protected, ...unverifiable]);
  } catch {
    return ["(unable to verify tracked working-tree paths)"];
  }
}

/** True only if the working tree is fully clean — no uncommitted changes. The `--commit` capstone uses
 *  this as a guard: `git add -A` + commit is only safe to run when the tree was clean before the org ran,
 *  so it captures THIS run's work and never sweeps up pre-existing WIP. False for a non-git dir. */
export function isTreeClean(cwd: string): boolean {
  try {
    return execFileSync("git", ["status", "--porcelain"], {
      cwd,
      env: toolSubprocessEnv(),
      encoding: "utf8",
      maxBuffer: 50_000_000,
      timeout: GIT_CAPTURE_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() === "";
  } catch {
    return false; // not a git repo / git error → treat as "not clean" so we never auto-commit blindly
  }
}

/** Strip a leading/trailing markdown code fence a model sometimes wraps a commit message in. */
export function stripCommitFence(text: string): string {
  return text.trim().replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "").trim();
}

function displayPathList(paths: readonly string[], cap = 12_000): string {
  const shown: string[] = [];
  let length = 0;
  for (const path of paths) {
    const label = JSON.stringify(safePathLabel(path));
    if (length + label.length + (shown.length ? 2 : 0) > cap) break;
    shown.push(label);
    length += label.length + (shown.length > 1 ? 2 : 0);
  }
  const remaining = paths.length - shown.length;
  if (!shown.length) return `${paths.length} path(s) (names omitted for length)`;
  return shown.join(", ") + (remaining ? `, … and ${remaining} more` : "");
}

/** Model-safe input for commit-message generation. A deletion-only commit still has useful metadata, but
 * never receives the unverifiable historical blob that Git's ordinary deletion diff would expose. */
export function commitMessageInput(changes: CapturedChanges): string {
  const omittedDeletions = changes.omittedDeletions ?? [];
  const parts: string[] = [];
  if (changes.diff.trim()) parts.push(changes.diff);
  if (omittedDeletions.length) {
    parts.push(
      "Tracked deletions (historical file contents intentionally omitted for safety): " +
      displayPathList(omittedDeletions),
    );
  }
  return parts.join("\n\n");
}

/** The reviewer's input: the task + the changes to review. */
export function reviewPrompt(task: string, changes: CapturedChanges): string {
  const skippedFiles = changes.skippedFiles ?? [];
  const omittedDeletions = changes.omittedDeletions ?? [];
  const parts = [`Task that was implemented:\n${task}`, ""];
  if (changes.diff) {
    parts.push(
      "Change metadata only (status + path; historical patch contents are intentionally omitted):\n```text\n" +
      changes.diff + "\n```",
    );
  }
  if (changes.newFiles.length) parts.push(`New files (use read_file to inspect): ${displayPathList(changes.newFiles)}`);
  if (skippedFiles.length) {
    parts.push(
      "Protected paths were omitted from review context and MUST NOT be opened by the reviewer: " +
      displayPathList(skippedFiles),
    );
  }
  if (omittedDeletions.length) {
    parts.push(
      "Tracked deletions were detected, but their historical contents were omitted because old filesystem " +
      "identity cannot be verified safely: " + displayPathList(omittedDeletions),
    );
  }
  if (changes.error) parts.push(`(change capture failed closed: ${changes.error})`);
  if (!changes.diff && !changes.newFiles.length && !omittedDeletions.length) parts.push("(no reviewable diff was captured)");
  parts.push("\nReview these changes against the task. Finish with your VERDICT line.");
  return parts.join("\n");
}

/** Feed the reviewer's requested changes back to the implementer. */
export function fixPrompt(issues: string): string {
  return `A code reviewer reviewed your changes and requires these fixes before this can ship:\n\n${issues}\n\nMake these fixes now — edit the files directly; don't just explain.`;
}
