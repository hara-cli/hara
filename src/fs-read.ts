// Bounded streaming line reader for files too large to load as one string. It stores only the requested
// window and a capped prefix of each line, so huge logs/JSONL and minified one-line files stay safe.
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
  type Stats,
} from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { sensitiveFileError } from "./security/sensitive-files.js";

export class BinaryFileError extends Error {
  constructor(path: string) {
    super(`${path} appears to be binary (NUL byte detected)`);
    this.name = "BinaryFileError";
  }
}

export class NonRegularFileError extends Error {
  readonly code = "HARA_NOT_REGULAR_FILE";

  constructor(path: string) {
    super(`${path} is not a regular file`);
    this.name = "NonRegularFileError";
  }
}

export class FileReadLimitError extends Error {
  readonly code = "HARA_FILE_TOO_LARGE";

  constructor(path: string, readonly limit: number) {
    super(`${path} exceeds the ${limit}-byte safe edit/read limit`);
    this.name = "FileReadLimitError";
  }
}

export interface StreamSliceOptions {
  lineCap?: number;
  maxScanChars?: number;
  /** Apply the protected-file policy, O_NOFOLLOW validation, and hard-link rejection to the opened fd. */
  protectSensitive?: boolean;
}

const DEFAULT_LINE_CAP = 2000;
const DEFAULT_MAX_SCAN = 64 * 1024 * 1024;
const MAX_SLICE_LINES = 2_000;
/** Editing tools materialize the old text for diff/CAS. Keep that allocation explicitly bounded. */
export const MAX_EDIT_READ_BYTES = 64 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const MAX_PREFIX_CHARS = 1_000_000;

export interface RegularFileSnapshot {
  text: string;
  dev: number;
  ino: number;
  mode: number;
  nlink: number;
}

/** A context-loader rejected a protected path before any bytes could enter a model prompt. */
export class ProtectedContextFileError extends Error {
  readonly code = "HARA_PROTECTED_CONTEXT_FILE";

  constructor(message: string) {
    super(message);
    this.name = "ProtectedContextFileError";
  }
}

export class HardLinkedFileError extends Error {
  readonly code = "HARA_HARD_LINKED_FILE";

  constructor(path: string) {
    super(`${path} is hard-linked (has multiple hard links); its protected identity cannot be established safely`);
    this.name = "HardLinkedFileError";
  }
}

export interface VerifiedRegularFile {
  handle: FileHandle;
  info: Stats;
  canonicalPath: string;
}

export interface VerifiedRegularFileReadOptions {
  action?: string;
  rejectHardLinks?: boolean;
  protectSensitive?: boolean;
}

/** Resolve a user-facing path once, checking both its lexical name and canonical target. Direct tools then
 * open this canonical path with O_NOFOLLOW, so a safe symlink remains usable without a retarget race. */
export function resolveVerifiedModelPath(path: string, action = "read"): string {
  const denied = sensitiveFileError(path, action);
  if (denied) throw new ProtectedContextFileError(denied);
  const canonical = realpathSync.native(path);
  const targetDenied = sensitiveFileError(canonical, action);
  if (targetDenied) throw new ProtectedContextFileError(targetDenied);
  return canonical;
}

/**
 * Common post-open identity check for security-sensitive readers. `opened` MUST be the fstat result for an
 * O_NOFOLLOW descriptor. It verifies that the current lexical/canonical name still identifies that inode,
 * rejects hard-link aliases by default, and applies the central protected-file policy to the actual target.
 */
export function verifyOpenedRegularFileSync(
  path: string,
  opened: Stats,
  options: { action?: string; rejectHardLinks?: boolean; protectSensitive?: boolean } = {},
): string {
  if (!opened.isFile()) throw new NonRegularFileError(path);
  if (options.rejectHardLinks !== false && opened.nlink > 1) throw new HardLinkedFileError(path);
  const canonical = realpathSync.native(path);
  if (options.protectSensitive !== false) {
    const targetDenied = sensitiveFileError(canonical, options.action ?? "read");
    if (targetDenied) throw new ProtectedContextFileError(targetDenied);
  }
  const currentLink = lstatSync(path);
  const currentTarget = statSync(canonical);
  if (
    currentLink.isSymbolicLink()
    || currentLink.dev !== opened.dev
    || currentLink.ino !== opened.ino
    || currentTarget.dev !== opened.dev
    || currentTarget.ino !== opened.ino
  ) {
    throw new Error(`refusing to access ${path}: path changed while opening it`);
  }
  return canonical;
}

/** Open + validate a regular file for direct tools that need to keep reading the verified descriptor. */
export async function openVerifiedRegularFileNoFollow(
  path: string,
  options: { action?: string; rejectHardLinks?: boolean; protectSensitive?: boolean } = {},
): Promise<VerifiedRegularFile> {
  if (options.protectSensitive !== false) {
    const denied = sensitiveFileError(path, options.action ?? "read");
    if (denied) throw new ProtectedContextFileError(denied);
  }
  const before = lstatSync(path);
  if (before.isSymbolicLink()) throw new NonRegularFileError(path);
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | noFollow);
  try {
    const info = await handle.stat();
    const canonicalPath = verifyOpenedRegularFileSync(path, info, options);
    return { handle, info, canonicalPath };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

/** Materialize a direct-tool pre-read from a verified descriptor. Safe symlinks should be canonicalized by
 * `resolveVerifiedModelPath` first; hard-linked aliases are rejected because their protected origin cannot be
 * inferred from the opened pathname alone. */
export async function readVerifiedRegularFileSnapshot(
  path: string,
  maxBytes = MAX_EDIT_READ_BYTES,
  action = "read",
): Promise<RegularFileSnapshot> {
  const limit = checkedContextLimit(maxBytes);
  const verified = await openVerifiedRegularFileNoFollow(path, { action, rejectHardLinks: true, protectSensitive: true });
  try {
    const { handle, info } = verified;
    if (info.size > limit) throw new FileReadLimitError(path, limit);
    const chunks: Buffer[] = [];
    let total = 0;
    let position = 0;
    while (total <= limit) {
      const want = Math.min(READ_CHUNK_BYTES, limit + 1 - total);
      const buffer = Buffer.allocUnsafe(want);
      const { bytesRead } = await handle.read(buffer, 0, want, position);
      if (!bytesRead) break;
      chunks.push(buffer.subarray(0, bytesRead));
      total += bytesRead;
      position += bytesRead;
    }
    if (total > limit) throw new FileReadLimitError(path, limit);
    const latest = await handle.stat();
    verifyOpenedRegularFileSync(path, latest, { action, rejectHardLinks: true, protectSensitive: true });
    if (
      latest.dev !== info.dev
      || latest.ino !== info.ino
      || latest.size !== info.size
      || latest.mtimeMs !== info.mtimeMs
      || latest.ctimeMs !== info.ctimeMs
    ) throw new Error(`refusing to read ${path}: file changed while reading it`);
    return {
      text: Buffer.concat(chunks, total).toString("utf8"),
      dev: info.dev,
      ino: info.ino,
      mode: info.mode & 0o777,
      nlink: info.nlink,
    };
  } finally {
    await verified.handle.close().catch(() => {});
  }
}

/** Synchronous counterpart for startup/configuration paths that cannot make their public API async. It
 * validates and reads the same O_NOFOLLOW descriptor, rejects aliases with multiple hard links, bounds the
 * allocation, and verifies identity/metadata again after the read. Internal state readers may explicitly
 * disable the model-facing protected-file policy while retaining every filesystem identity check. */
export function readVerifiedRegularFileSnapshotSync(
  path: string,
  maxBytes = MAX_EDIT_READ_BYTES,
  options: VerifiedRegularFileReadOptions = {},
): RegularFileSnapshot {
  const action = options.action ?? "read";
  if (options.protectSensitive !== false) {
    const denied = sensitiveFileError(path, action);
    if (denied) throw new ProtectedContextFileError(denied);
  }
  const before = lstatSync(path);
  if (before.isSymbolicLink()) throw new NonRegularFileError(path);
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | noFollow);
  try {
    const info = fstatSync(fd);
    verifyOpenedRegularFileSync(path, info, {
      action,
      rejectHardLinks: options.rejectHardLinks !== false,
      protectSensitive: options.protectSensitive !== false,
    });
    const limit = checkedContextLimit(maxBytes);
    if (info.size > limit) throw new FileReadLimitError(path, limit);
    const bytes = readFdBytesSync(fd, Math.min(limit + 1, info.size + 1));
    if (bytes.length > limit) throw new FileReadLimitError(path, limit);
    const latest = fstatSync(fd);
    verifyOpenedRegularFileSync(path, latest, {
      action,
      rejectHardLinks: options.rejectHardLinks !== false,
      protectSensitive: options.protectSensitive !== false,
    });
    if (
      latest.dev !== info.dev
      || latest.ino !== info.ino
      || latest.size !== info.size
      || latest.mtimeMs !== info.mtimeMs
      || latest.ctimeMs !== info.ctimeMs
    ) throw new Error(`refusing to read ${path}: file changed while reading it`);
    return {
      text: bytes.toString("utf8"),
      dev: info.dev,
      ino: info.ino,
      mode: info.mode & 0o777,
      nlink: info.nlink,
    };
  } finally {
    closeSync(fd);
  }
}

/**
 * Open a model-context source without following its final component, validate the SAME descriptor, and
 * re-check the canonical target against the central protected-file policy. The identity comparison closes
 * the ordinary validate-then-open race: if the pathname is exchanged while it is being inspected, callers
 * get an error rather than bytes from an unverified inode.
 *
 * This is intentionally synchronous because AGENTS/skills/roles/memory are assembled synchronously before
 * a provider turn. Keep the reader callback small and bounded.
 */
function withVerifiedContextFdSync<T>(path: string, read: (fd: number, size: number) => T): T {
  const denied = sensitiveFileError(path, "load into model context");
  if (denied) throw new ProtectedContextFileError(denied);

  // O_NOFOLLOW is not exposed on every platform. The before/after lstat checks retain fail-closed symlink
  // behaviour there; on POSIX O_NOFOLLOW makes the critical open itself atomic.
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const before = lstatSync(path);
  if (before.isSymbolicLink()) throw new NonRegularFileError(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | noFollow);
  try {
    const info = fstatSync(fd);
    verifyOpenedRegularFileSync(path, info, {
      action: "load into model context",
      rejectHardLinks: true,
      protectSensitive: true,
    });
    const result = read(fd, info.size);
    const latest = fstatSync(fd);
    verifyOpenedRegularFileSync(path, latest, {
      action: "load into model context",
      rejectHardLinks: true,
      protectSensitive: true,
    });
    if (
      latest.dev !== info.dev
      || latest.ino !== info.ino
      || latest.size !== info.size
      || latest.mtimeMs !== info.mtimeMs
      || latest.ctimeMs !== info.ctimeMs
    ) throw new Error(`refusing to read ${path}: file changed while reading it`);
    return result;
  } finally {
    closeSync(fd);
  }
}

function checkedContextLimit(maxBytes: number): number {
  const requested = Number.isFinite(maxBytes) ? Math.floor(maxBytes) : MAX_EDIT_READ_BYTES;
  return Math.min(MAX_EDIT_READ_BYTES, Math.max(1, requested));
}

function readFdBytesSync(fd: number, count: number): Buffer {
  const out = Buffer.allocUnsafe(count);
  let offset = 0;
  while (offset < count) {
    const n = readSync(fd, out, offset, count - offset, offset);
    if (n === 0) break;
    offset += n;
  }
  return out.subarray(0, offset);
}

/** Safely materialize a bounded UTF-8 context file. Oversized or binary inputs fail closed. */
export function readModelContextFileSync(path: string, maxBytes: number): string {
  const limit = checkedContextLimit(maxBytes);
  return withVerifiedContextFdSync(path, (fd, size) => {
    if (size > limit) throw new FileReadLimitError(path, limit);
    // Read one byte past the stated size/limit so concurrent growth is never silently included or ignored.
    const bytes = readFdBytesSync(fd, Math.min(limit + 1, size + 1));
    if (bytes.length > limit) throw new FileReadLimitError(path, limit);
    if (bytes.includes(0)) throw new BinaryFileError(path);
    return bytes.toString("utf8");
  });
}

/** Safe bounded-prefix counterpart for @file expansion; it never materializes the remainder of a huge file. */
export function readModelContextPrefixSync(path: string, maxChars: number): { text: string; truncated: boolean; binary: boolean } {
  const requested = Number.isFinite(maxChars) ? Math.floor(maxChars) : MAX_PREFIX_CHARS;
  const chars = Math.min(MAX_PREFIX_CHARS, Math.max(0, requested));
  return withVerifiedContextFdSync(path, (fd, size) => {
    const byteLimit = Math.min(size, chars * 4 + 4);
    const bytes = readFdBytesSync(fd, byteLimit);
    const binary = bytes.subarray(0, Math.min(bytes.length, 4096)).includes(0);
    const decoded = binary ? "" : bytes.toString("utf8");
    return {
      text: decoded.slice(0, chars),
      truncated: size > bytes.length || decoded.length > chars,
      binary,
    };
  });
}

function utf8BytePrefix(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let used = 0;
  let end = 0;
  for (const char of value) {
    const bytes = Buffer.byteLength(char, "utf8");
    if (used + bytes > maxBytes) break;
    used += bytes;
    end += char.length;
  }
  return value.slice(0, end);
}

/**
 * Verified byte-budgeted prefix reader for project instructions. Unlike `readModelContextFileSync`, an
 * oversized text file keeps its useful beginning instead of disappearing from model context. The returned
 * text is always at most `maxBytes` UTF-8 bytes and never ends with half of a multibyte code point.
 */
export function readModelContextBytePrefixSync(path: string, maxBytes: number): { text: string; truncated: boolean; binary: boolean } {
  const limit = checkedContextLimit(maxBytes);
  return withVerifiedContextFdSync(path, (fd, size) => {
    const bytes = readFdBytesSync(fd, Math.min(size, limit));
    const binary = bytes.subarray(0, Math.min(bytes.length, 4096)).includes(0);
    if (binary) return { text: "", truncated: size > bytes.length, binary: true };

    // StringDecoder buffers an incomplete UTF-8 suffix when the file continues past this prefix. This
    // avoids injecting U+FFFD merely because the byte budget happened to split a multibyte character.
    const decoder = new StringDecoder("utf8");
    const decoded = size > bytes.length ? decoder.write(bytes) : decoder.end(bytes);
    const text = utf8BytePrefix(decoded, limit);
    return { text, truncated: size > bytes.length || text.length < decoded.length, binary: false };
  });
}

/** Open without blocking on a FIFO, validate the SAME descriptor, then read at most maxBytes from it.
 * Path-level stat→readFile is unsafe because the path can be exchanged for a pipe/device between calls. */
async function readRegularFileSnapshotWithFlags(path: string, maxBytes: number, flags: number): Promise<RegularFileSnapshot> {
  const requested = Number.isFinite(maxBytes) ? Math.floor(maxBytes) : MAX_EDIT_READ_BYTES;
  const limit = Math.min(MAX_EDIT_READ_BYTES, Math.max(1, requested));
  const handle = await open(path, flags);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new NonRegularFileError(path);
    if (info.size > limit) throw new FileReadLimitError(path, limit);
    const chunks: Buffer[] = [];
    let total = 0;
    let position = 0;
    // Read one byte past the limit so concurrent growth cannot bypass the pre-read size check.
    while (total <= limit) {
      const want = Math.min(READ_CHUNK_BYTES, limit + 1 - total);
      const buffer = Buffer.allocUnsafe(want);
      const { bytesRead } = await handle.read(buffer, 0, want, position);
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
      total += bytesRead;
      position += bytesRead;
    }
    if (total > limit) throw new FileReadLimitError(path, limit);
    return { text: Buffer.concat(chunks, total).toString("utf8"), dev: info.dev, ino: info.ino, mode: info.mode & 0o777, nlink: info.nlink };
  } finally {
    await handle.close().catch(() => {});
  }
}

export async function readRegularFileSnapshot(path: string, maxBytes = MAX_EDIT_READ_BYTES): Promise<RegularFileSnapshot> {
  return readRegularFileSnapshotWithFlags(path, maxBytes, constants.O_RDONLY | constants.O_NONBLOCK);
}

/** Quarantine/transaction reader: reject a symlink at open(2), then validate/read that same fd. */
export async function readRegularFileSnapshotNoFollow(path: string, maxBytes = MAX_EDIT_READ_BYTES): Promise<RegularFileSnapshot> {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  return readRegularFileSnapshotWithFlags(path, maxBytes, constants.O_RDONLY | constants.O_NONBLOCK | noFollow);
}

export async function readRegularFileText(path: string, maxBytes = MAX_EDIT_READ_BYTES): Promise<string> {
  return (await readRegularFileSnapshot(path, maxBytes)).text;
}

/** Read only enough bytes to produce a bounded UTF-8 prefix (used by synchronous @file expansion). */
export function readTextPrefixSync(path: string, maxChars: number): { text: string; truncated: boolean; binary: boolean } {
  const requested = Number.isFinite(maxChars) ? Math.floor(maxChars) : MAX_PREFIX_CHARS;
  const chars = Math.min(MAX_PREFIX_CHARS, Math.max(0, requested));
  // O_NONBLOCK makes opening a FIFO return immediately; fstat on this exact fd then rejects it before read.
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw new NonRegularFileError(path);
    const size = info.size;
    // Four bytes per Unicode scalar plus a small boundary cushion guarantees enough decoded input for
    // `chars` without allocating the entire file. readSync can short-read, so fill in a loop.
    const byteLimit = Math.min(size, chars * 4 + 4);
    const buffer = Buffer.allocUnsafe(byteLimit);
    let read = 0;
    while (read < byteLimit) {
      const n = readSync(fd, buffer, read, byteLimit - read, read);
      if (n === 0) break;
      read += n;
    }
    const bytes = buffer.subarray(0, read);
    const binary = bytes.subarray(0, Math.min(bytes.length, 4096)).includes(0);
    const decoded = binary ? "" : bytes.toString("utf8");
    return {
      text: decoded.slice(0, chars),
      truncated: size > read || decoded.length > chars,
      binary,
    };
  } finally {
    closeSync(fd);
  }
}

/** Render a line slice without retaining the entire file. Total line count is shown only when EOF is reached. */
export async function streamFileSlice(
  path: string,
  offset = 1,
  limit = 300,
  options: StreamSliceOptions = {},
): Promise<string> {
  const requestedStart = Number.isFinite(offset) ? Math.floor(offset) : 1;
  const requestedLines = Number.isFinite(limit) ? Math.floor(limit) : 300;
  const start = Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, requestedStart));
  const want = Math.min(MAX_SLICE_LINES, Math.max(1, requestedLines));
  const requestedEnd = start + want - 1;
  const requestedLineCap = Number.isFinite(options.lineCap)
    ? Math.floor(options.lineCap as number)
    : DEFAULT_LINE_CAP;
  const lineCap = Math.min(DEFAULT_LINE_CAP, Math.max(1, requestedLineCap));
  const requestedScan = Number.isFinite(options.maxScanChars)
    ? Math.floor(options.maxScanChars as number)
    : DEFAULT_MAX_SCAN;
  const maxScan = Math.min(DEFAULT_MAX_SCAN, Math.max(lineCap, requestedScan));

  const rendered: string[] = [];
  let lineNo = 1;
  let linePrefix = "";
  let lineChars = 0;
  let lineEndsWithCr = false;
  let sawData = false;
  let endedWithNewline = false;
  let scanned = 0;
  let hasMore = false;
  let scanLimited = false;
  let stoppedEarly = false;

  const append = (part: string): void => {
    if (!part.length) return;
    sawData = true;
    endedWithNewline = false;
    if (lineNo > requestedEnd) {
      hasMore = true;
      return;
    }
    if (lineNo >= start) {
      lineChars += part.length;
      if (linePrefix.length < lineCap) linePrefix += part.slice(0, lineCap - linePrefix.length);
      lineEndsWithCr = part.endsWith("\r");
    }
  };

  const finishLine = (partial = false): void => {
    const current = lineNo;
    if (current >= start && current <= requestedEnd) {
      let chars = lineChars;
      let prefix = linePrefix;
      if (!partial && lineEndsWithCr) {
        chars = Math.max(0, chars - 1);
        if (prefix.endsWith("\r")) prefix = prefix.slice(0, -1);
      }
      const omitted = Math.max(0, chars - prefix.length);
      const tail = partial
        ? `…[line continues; scan stopped after ${scanned} chars]`
        : omitted
          ? `…[+${omitted} chars]`
          : "";
      rendered.push(`${String(current).padStart(6)}\t${prefix}${tail}`);
    }
    lineNo++;
    linePrefix = "";
    lineChars = 0;
    lineEndsWithCr = false;
    if (current > requestedEnd) hasMore = true;
  };

  // Keep validation and streaming on the same non-blocking descriptor. This closes the stat→open race
  // where an attacker/local generator exchanges a regular path for a FIFO after validation.
  const verified = options.protectSensitive
    ? await openVerifiedRegularFileNoFollow(path, { action: "read", rejectHardLinks: true, protectSensitive: true })
    : null;
  const handle = verified?.handle ?? await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  let stream: ReturnType<typeof handle.createReadStream> | undefined;
  try {
    const info = verified?.info ?? await handle.stat();
    if (!info.isFile()) throw new NonRegularFileError(path);
    // `end` is an inclusive byte offset. It makes the scan ceiling a true fd-level byte bound (not just
    // a post-read character counter, which could overshoot badly on multi-byte text or a giant chunk).
    stream = handle.createReadStream({ encoding: "utf8", highWaterMark: 64 * 1024, autoClose: false, end: maxScan - 1 });
    for await (const raw of stream) {
      const chunk = String(raw);
      if (chunk.length) sawData = true;
      if (scanned < 4096 && chunk.slice(0, 4096 - scanned).includes("\0")) throw new BinaryFileError(path);
      scanned += chunk.length;
      let at = 0;
      while (at < chunk.length) {
        const newline = chunk.indexOf("\n", at);
        if (newline < 0) {
          append(chunk.slice(at));
          break;
        }
        append(chunk.slice(at, newline));
        finishLine();
        endedWithNewline = true;
        at = newline + 1;
        if (hasMore) break;
      }
      if (hasMore) {
        stoppedEarly = true;
        break;
      }
    }
    if (!stoppedEarly && stream.bytesRead >= maxScan) {
      // Re-fstat the same open file description so concurrent growth is also detected. An exact-size file
      // is genuine EOF and should still receive the normal total-line rendering.
      const latest = await handle.stat();
      if (latest.size > stream.bytesRead) {
        scanLimited = true;
        stoppedEarly = true;
        if (lineNo >= start && lineNo <= requestedEnd) finishLine(true);
      }
    }
    if (verified) {
      const latest = await handle.stat();
      verifyOpenedRegularFileSync(path, latest, { action: "read", rejectHardLinks: true, protectSensitive: true });
      if (
        latest.dev !== info.dev
        || latest.ino !== info.ino
        || latest.size !== info.size
        || latest.mtimeMs !== info.mtimeMs
        || latest.ctimeMs !== info.ctimeMs
      ) throw new Error(`refusing to read ${path}: file changed while reading it`);
    }
  } finally {
    stream?.destroy();
    await handle.close().catch(() => {});
  }

  if (!stoppedEarly) {
    // A trailing newline creates no phantom line, matching String#split + trailing-empty removal.
    if (!endedWithNewline || !sawData) finishLine();
    const total = lineNo - 1;
    if (start > total) return `(file has ${total} lines — offset ${start} is past the end)`;
    const end = start + rendered.length - 1;
    const sliced = start > 1 || end < total;
    const head = sliced ? `(lines ${start}–${end} of ${total}${end < total ? ` — continue with offset:${end + 1}` : ""})\n` : "";
    return head + rendered.join("\n");
  }

  const end = start + Math.max(0, rendered.length - 1);
  if (scanLimited) {
    return `(large file scan stopped after ${scanned} chars — use grep or bash byte-range tools for a narrower target)\n${rendered.join("\n")}`;
  }
  return `(lines ${start}–${end}; more lines follow — continue with offset:${end + 1})\n${rendered.join("\n")}`;
}
