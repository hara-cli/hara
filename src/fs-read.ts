// Bounded streaming line reader for files too large to load as one string. It stores only the requested
// window and a capped prefix of each line, so huge logs/JSONL and minified one-line files stay safe.
import { closeSync, createReadStream, fstatSync, openSync, readSync } from "node:fs";

export class BinaryFileError extends Error {
  constructor(path: string) {
    super(`${path} appears to be binary (NUL byte detected)`);
    this.name = "BinaryFileError";
  }
}

export interface StreamSliceOptions {
  lineCap?: number;
  maxScanChars?: number;
}

const DEFAULT_LINE_CAP = 2000;
const DEFAULT_MAX_SCAN = 64 * 1024 * 1024;

/** Read only enough bytes to produce a bounded UTF-8 prefix (used by synchronous @file expansion). */
export function readTextPrefixSync(path: string, maxChars: number): { text: string; truncated: boolean; binary: boolean } {
  const chars = Math.max(0, Math.floor(maxChars));
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
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
  const start = Math.max(1, Math.floor(offset));
  const want = Math.max(1, Math.floor(limit));
  const requestedEnd = start + want - 1;
  const lineCap = Math.max(1, Math.floor(options.lineCap ?? DEFAULT_LINE_CAP));
  const maxScan = Math.max(lineCap, Math.floor(options.maxScanChars ?? DEFAULT_MAX_SCAN));

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

  const stream = createReadStream(path, { encoding: "utf8", highWaterMark: 64 * 1024 });
  try {
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
      if (scanned >= maxScan) {
        scanLimited = true;
        stoppedEarly = true;
        if (lineNo >= start && lineNo <= requestedEnd) finishLine(true);
        break;
      }
    }
  } finally {
    stream.destroy();
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
