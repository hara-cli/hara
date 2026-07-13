// Bounded streaming line reader for files too large to load as one string. It stores only the requested
// window and a capped prefix of each line, so huge logs/JSONL and minified one-line files stay safe.
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { open } from "node:fs/promises";

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
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  let stream: ReturnType<typeof handle.createReadStream> | undefined;
  try {
    const info = await handle.stat();
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
