// Tool results cross two boundaries: the model needs a bounded preview, while useful command/MCP output
// must remain recoverable. Oversized redacted values are therefore written to Hara's private state and
// represented by an opaque id that the model can page with tool_result_read.
import { randomBytes } from "node:crypto";
import { lstatSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  bindPrivateHaraStateFile,
  readPrivateStateFileSnapshotSync,
  removePrivateStateFile,
  writePrivateStateFileSync,
  type PrivateStateDirectoryIdentity,
} from "../security/private-state.js";
import { redactToolSubprocessOutput } from "../security/subprocess-env.js";

export const MAX_TOOL_RESULT_CHARS = 24_000;
export const MAX_TOOL_RESULT_BATCH_CHARS = 64_000;
export const MAX_TOOL_RESULT_READ_CHARS = 18_000;
export const MAX_STORED_TOOL_RESULT_BYTES = 4 * 1024 * 1024;
const MAX_STORED_TOOL_RESULT_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_STORED_TOOL_RESULT_FILES = 128;
const STORED_TOOL_RESULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RESULT_ID = /^tr_[a-f0-9]{32}$/;
const RESULT_FILE = /^(tr_[a-f0-9]{32})\.txt$/;

interface StoredToolResult {
  id: string;
  chars: number;
}

function safeHead(value: string, end: number): string {
  let at = Math.max(0, Math.min(value.length, end));
  if (at > 0 && /[\uD800-\uDBFF]/.test(value[at - 1] ?? "")) at--;
  return value.slice(0, at);
}

function safeTail(value: string, start: number): string {
  let at = Math.max(0, Math.min(value.length, start));
  if (at < value.length && /[\uDC00-\uDFFF]/.test(value[at] ?? "")) at++;
  return value.slice(at);
}

/** Keep actionable beginnings and endings while bounding the exact string persisted in history. */
export function limitToolResult(value: unknown, max = MAX_TOOL_RESULT_CHARS): string {
  const text = typeof value === "string" ? value : String(value ?? "");
  const cap = Math.max(0, Math.floor(max));
  if (text.length <= cap) return text;
  if (cap === 0) return "";

  let omitted = text.length - cap;
  let fullMarker = "";
  // The marker consumes part of the budget too. Iterate twice so its count reflects the actual payload
  // removed rather than understating it by roughly the marker's own length.
  for (let i = 0; i < 2; i++) {
    fullMarker = `\n…[hara: ${omitted} chars omitted; narrow the query or continue read_file with offset/limit]…\n`;
    omitted = text.length - Math.max(0, cap - fullMarker.length);
  }
  const marker = fullMarker.length < cap ? fullMarker : "…[truncated]…".slice(0, cap);
  const room = cap - marker.length;
  const headChars = Math.floor(room * 0.6);
  const tailChars = room - headChars;
  return safeHead(text, headChars) + marker + safeTail(text, text.length - tailChars);
}

function resultBinding(id: string) {
  if (!RESULT_ID.test(id)) throw new Error("invalid tool result id");
  return bindPrivateHaraStateFile(homedir(), ["tool-results"], `${id}.txt`);
}

interface StoreEntry {
  path: string;
  size: number;
  mtimeMs: number;
}

/** Remove only verified single-link private-state files. Changed, linked, or aliased entries are retained
 * and count against the quota, making a hostile local preseed fail closed. */
function pruneStore(
  directory: PrivateStateDirectoryIdentity,
  incomingBytes: number,
  now = Date.now(),
): boolean {
  const entries: StoreEntry[] = [];
  let totalBytes = 0;
  let totalFiles = 0;
  for (const name of readdirSync(directory.path)) {
    if (!RESULT_FILE.test(name)) continue;
    const path = join(directory.path, name);
    try {
      const info = lstatSync(path);
      totalFiles++;
      totalBytes += info.size;
      if (info.isFile() && !info.isSymbolicLink() && info.nlink === 1) {
        entries.push({ path, size: info.size, mtimeMs: info.mtimeMs });
      }
    } catch {
      // A disappearing or changed entry is not safe to remove.
    }
  }

  entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const entry of entries) {
    const expired = now - entry.mtimeMs > STORED_TOOL_RESULT_TTL_MS;
    const overQuota =
      totalFiles >= MAX_STORED_TOOL_RESULT_FILES
      || totalBytes + incomingBytes > MAX_STORED_TOOL_RESULT_TOTAL_BYTES;
    if (!expired && !overQuota) continue;
    try {
      const snapshot = readPrivateStateFileSnapshotSync(entry.path, MAX_STORED_TOOL_RESULT_BYTES);
      if (!snapshot) continue;
      removePrivateStateFile(entry.path, snapshot, directory);
      totalFiles--;
      totalBytes -= entry.size;
    } catch {
      // Never unlink a path that failed the private-state identity boundary.
    }
  }
  return (
    totalFiles < MAX_STORED_TOOL_RESULT_FILES
    && totalBytes + incomingBytes <= MAX_STORED_TOOL_RESULT_TOTAL_BYTES
  );
}

/** Store only a redacted, bounded UTF-8 value. Failure degrades to an ordinary preview; the original tool
 * action must not fail merely because this optional continuation store is unavailable. */
export function storeToolResult(value: unknown): StoredToolResult | null {
  const raw = typeof value === "string" ? value : String(value ?? "");
  const text = redactToolSubprocessOutput(raw);
  const bytes = Buffer.byteLength(text, "utf8");
  if (!bytes || bytes > MAX_STORED_TOOL_RESULT_BYTES) return null;
  try {
    const id = `tr_${randomBytes(16).toString("hex")}`;
    const binding = resultBinding(id);
    if (!pruneStore(binding.directory, bytes)) return null;
    writePrivateStateFileSync(binding, text);
    return { id, chars: text.length };
  } catch {
    return null;
  }
}

function referenceFooter(stored: StoredToolResult, compact = false): string {
  if (compact) return `[tool result ${stored.id}; use tool_result_read]`;
  return (
    `\n…[hara: ${stored.chars} redacted chars stored as ${stored.id}; ` +
    `call tool_result_read with {"id":"${stored.id}","offset":0,"limit":${MAX_TOOL_RESULT_READ_CHARS}} to continue]…`
  );
}

function previewWithReference(text: string, stored: StoredToolResult, max: number): string {
  const cap = Math.max(0, Math.floor(max));
  if (!cap) return "";
  const footer = referenceFooter(stored);
  if (footer.length + 32 < cap) return limitToolResult(text, cap - footer.length) + footer;
  return limitToolResult(referenceFooter(stored, true), cap);
}

/** Registry boundary: redact ordinary results and spool them before trimming so direct callers and the main
 * loop receive the same safe representation. Verified file reads may keep their immediate preview because
 * their protected-file policy has already run; continuation storage remains redacted independently. */
export function prepareToolResult(
  value: unknown,
  max = MAX_TOOL_RESULT_CHARS,
  options: { redactPreview?: boolean } = {},
): string {
  const raw = typeof value === "string" ? value : String(value ?? "");
  const text = options.redactPreview === false ? raw : redactToolSubprocessOutput(raw);
  const cap = Math.max(0, Math.floor(max));
  if (text.length <= cap) return text;
  const stored = storeToolResult(raw);
  return stored ? previewWithReference(text, stored, cap) : limitToolResult(text, cap);
}

function existingResultReference(text: string): StoredToolResult | null {
  const match = text.match(/\[hara:\s+(\d+)\s+redacted chars stored as (tr_[a-f0-9]{32});/);
  if (!match) return null;
  const [, charsText, id] = match;
  try {
    const binding = resultBinding(id);
    const snapshot = readPrivateStateFileSnapshotSync(binding.path, MAX_STORED_TOOL_RESULT_BYTES);
    if (!snapshot) return null;
    const chars = Number(charsText);
    return { id, chars: Number.isFinite(chars) ? chars : snapshot.text.length };
  } catch {
    return null;
  }
}

/** Bound one parallel tool round. Values reduced only because siblings consumed the round budget receive
 * their own continuation id instead of losing content. */
export function limitToolResultBatch(
  values: readonly string[],
  max = MAX_TOOL_RESULT_BATCH_CHARS,
): string[] {
  const cap = Math.max(0, Math.floor(max));
  if (values.reduce((sum, value) => sum + value.length, 0) <= cap) return [...values];
  if (!values.length) return [];
  const allowance = Math.floor(cap / values.length);
  return values.map((value) => {
    if (value.length <= allowance) return value;
    const stored = existingResultReference(value) ?? storeToolResult(value);
    return stored ? previewWithReference(value, stored, allowance) : limitToolResult(value, allowance);
  });
}

/** Page one opaque result id. Paths are never accepted, and the private reader rejects symlinks/hard links. */
export function readStoredToolResult(
  id: string,
  offsetValue: unknown = 0,
  limitValue: unknown = MAX_TOOL_RESULT_READ_CHARS,
): string {
  if (!RESULT_ID.test(id)) return "Error: invalid tool result id.";
  const offset = Math.max(0, Math.floor(Number(offsetValue) || 0));
  const limit = Math.min(
    MAX_TOOL_RESULT_READ_CHARS,
    Math.max(1, Math.floor(Number(limitValue) || MAX_TOOL_RESULT_READ_CHARS)),
  );
  try {
    const binding = resultBinding(id);
    const snapshot = readPrivateStateFileSnapshotSync(binding.path, MAX_STORED_TOOL_RESULT_BYTES);
    if (!snapshot) return `Error: tool result ${id} was not found or has expired. Re-run the narrow source query.`;
    const text = snapshot.text;
    if (offset >= text.length) return `(tool result ${id} has ${text.length} chars; offset ${offset} is past the end)`;
    const end = Math.min(text.length, offset + limit);
    let slice = safeTail(text, offset);
    slice = safeHead(slice, end - offset);
    const actualEnd = offset + slice.length;
    const header =
      `(tool result ${id}: chars ${offset}–${actualEnd} of ${text.length}` +
      `${actualEnd < text.length ? `; continue with offset:${actualEnd}` : ""})\n`;
    return header + slice;
  } catch (error) {
    return `Error: cannot read tool result ${id}: ${error instanceof Error ? error.message : String(error)}`;
  }
}
