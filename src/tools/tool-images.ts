import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdtempSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readVerifiedRegularFileBytesSync } from "../fs-read.js";
import {
  ensurePrivateStateSubdirectory,
  writePrivateStateBytesOnceSync,
  type PrivateStateDirectoryIdentity,
} from "../security/private-state.js";
import type { ImageAttachment, ToolImageInput } from "../providers/types.js";
import { MAX_NATIVE_IMAGE_BYTES } from "../vision.js";
import {
  redactToolMediaText, registerToolMediaRedaction, removeToolMediaRedaction,
  toolMediaRedaction, type ToolMediaRedaction,
} from "../security/tool-media-redaction.js";
export { redactOwnedToolImageText } from "../security/tool-media-redaction.js";

export const MAX_TOOL_IMAGES = 4;
export const MAX_TOOL_IMAGE_PIXELS = 40_000_000;
const EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp",
};
const MAX_BASE64_CHARS = Math.ceil(MAX_NATIVE_IMAGE_BYTES / 3) * 4;
type Receipt = {
  directory: PrivateStateDirectoryIdentity;
  dev: number;
  ino: number;
  digest: string;
  mediaType: string;
  redaction: ToolMediaRedaction;
};
// Only snapshots created by this process can be provider input. A persisted/forged path is never enough.
const receipts = new Map<string, Receipt>();

function checkedDimensions(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0
    || width > 32_768 || height > 32_768 || width * height > MAX_TOOL_IMAGE_PIXELS) {
    throw new Error("tool image has invalid or excessive dimensions");
  }
}

function validateImageContainer(bytes: Buffer, mediaType: string): void {
  if (mediaType === "image/png") {
    if (bytes.length < 45 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      throw new Error("tool image bytes do not match PNG MIME type");
    }
    let at = 8;
    let sawData = false;
    while (at + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(at);
      const type = bytes.toString("ascii", at + 4, at + 8);
      if (length > bytes.length - at - 12) break;
      if (at === 8) {
        if (type !== "IHDR" || length !== 13) break;
        checkedDimensions(bytes.readUInt32BE(at + 8), bytes.readUInt32BE(at + 12));
      }
      if (type === "IDAT" && length > 0) sawData = true;
      if (type === "IEND") {
        if (length === 0 && sawData && at + 12 === bytes.length) return;
        break;
      }
      at += length + 12;
    }
    throw new Error("tool image PNG container is incomplete");
  }
  if (mediaType === "image/jpeg") {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8
      || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) {
      throw new Error("tool image bytes do not match JPEG MIME type");
    }
    for (let at = 2; at + 4 <= bytes.length;) {
      if (bytes[at++] !== 0xff) break;
      while (at < bytes.length && bytes[at] === 0xff) at++;
      const marker = bytes[at++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (at + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(at);
      if (length < 2 || at + length > bytes.length) break;
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        if (length < 8) break;
        checkedDimensions(bytes.readUInt16BE(at + 5), bytes.readUInt16BE(at + 3));
        return;
      }
      at += length;
    }
    throw new Error("tool image JPEG has no valid frame dimensions");
  }
  if (mediaType === "image/gif") {
    if (bytes.length < 14 || !["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))
      || bytes[bytes.length - 1] !== 0x3b) throw new Error("tool image bytes do not match GIF MIME type");
    checkedDimensions(bytes.readUInt16LE(6), bytes.readUInt16LE(8));
    return;
  }
  if (bytes.length < 25 || bytes.toString("ascii", 0, 4) !== "RIFF"
    || bytes.toString("ascii", 8, 12) !== "WEBP" || bytes.readUInt32LE(4) + 8 !== bytes.length) {
    throw new Error("tool image bytes do not match WebP MIME type");
  }
  const type = bytes.toString("ascii", 12, 16);
  const chunkLength = bytes.readUInt32LE(16);
  if (chunkLength > bytes.length - 20) throw new Error("tool image WebP container is incomplete");
  if (type === "VP8X" && chunkLength >= 10 && bytes.length >= 30) {
    checkedDimensions(bytes.readUIntLE(24, 3) + 1, bytes.readUIntLE(27, 3) + 1);
  } else if (type === "VP8L" && chunkLength >= 5 && bytes[20] === 0x2f) {
    const bits = bytes.readUInt32LE(21);
    checkedDimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  } else if (type === "VP8 " && chunkLength >= 10 && bytes.length >= 30
    && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    checkedDimensions(bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff);
  } else throw new Error("tool image WebP has no valid frame dimensions");
}

/** Validate untrusted inline image content before allocating disk or allowing a provider read. */
export function validateToolImage(image: ToolImageInput): Buffer {
  if (!image || typeof image !== "object" || typeof image.mediaType !== "string"
    || !Object.hasOwn(EXTENSIONS, image.mediaType)) throw new Error("unsupported tool image MIME type");
  let bytes: Buffer;
  if (typeof image.data === "string") {
    if (!image.data.length || image.data.length > MAX_BASE64_CHARS || image.data.length % 4 !== 0
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) {
      throw new Error("tool image must contain bounded canonical base64");
    }
    bytes = Buffer.from(image.data, "base64");
    if (bytes.toString("base64") !== image.data) throw new Error("tool image base64 is not canonical");
  } else if (image.data instanceof Uint8Array) {
    if (!image.data.byteLength || image.data.byteLength > MAX_NATIVE_IMAGE_BYTES) {
      throw new Error("tool image exceeds the native image byte limit");
    }
    bytes = Buffer.from(image.data);
  } else throw new Error("tool image requires inline bytes, not a path or URI");
  if (!bytes.length || bytes.length > MAX_NATIVE_IMAGE_BYTES) throw new Error("tool image exceeds the native image byte limit");
  validateImageContainer(bytes, image.mediaType);
  return bytes;
}

function directoryMatches(directory: PrivateStateDirectoryIdentity): boolean {
  try {
    const info = lstatSync(directory.path);
    return info.isDirectory() && !info.isSymbolicLink() && info.dev === directory.dev && info.ino === directory.ino
      && (process.platform === "win32" || (info.mode & 0o777) === 0o700);
  } catch { return false; }
}

/** Per-tool-call owner. Dispose after the following model request (including cancellation/error). */
export function createToolImageStore(): {
  add(image: ToolImageInput): ImageAttachment;
  /** Safe text after success/error/cleanup; only opaque pixel fingerprints survive disposal. */
  redactText(text: string): string;
  dispose(): void;
} {
  let directory: PrivateStateDirectoryIdentity | undefined;
  const paths: string[] = [];
  const redactions: ToolMediaRedaction[] = [];
  let disposed = false;
  return {
    add(image) {
      if (disposed) throw new Error("tool image store has been disposed");
      if (paths.length >= MAX_TOOL_IMAGES) throw new Error(`tool call exceeds the ${MAX_TOOL_IMAGES}-image limit`);
      const bytes = validateToolImage(image);
      directory ??= ensurePrivateStateSubdirectory(mkdtempSync(join(tmpdir(), "hara-tool-images-")), []);
      const path = join(directory.path, `${randomUUID()}${EXTENSIONS[image.mediaType]}`);
      writePrivateStateBytesOnceSync({ directory, path }, bytes);
      const info = lstatSync(path);
      const redaction = toolMediaRedaction(typeof image.data === "string" ? image.data : bytes.toString("base64"), path);
      redactions.push(redaction);
      receipts.set(path, {
        directory, dev: info.dev, ino: info.ino,
        digest: createHash("sha256").update(bytes).digest("hex"), mediaType: image.mediaType, redaction,
      });
      registerToolMediaRedaction(path, redaction);
      paths.push(path);
      return { path, mediaType: image.mediaType };
    },
    redactText(text) { return redactToolMediaText(text, redactions); },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const path of paths) {
        const receipt = receipts.get(path);
        receipts.delete(path);
        removeToolMediaRedaction(path);
        if (!receipt || !directoryMatches(receipt.directory)) continue;
        try {
          const info = lstatSync(path);
          if (info.isFile() && !info.isSymbolicLink() && info.dev === receipt.dev && info.ino === receipt.ino
            && info.nlink === 1) unlinkSync(path);
        } catch { /* best effort; never remove an exchanged entry */ }
      }
      if (directory && directoryMatches(directory)) {
        try { rmdirSync(directory.path); } catch { /* preserve any unowned entries */ }
      }
    },
  };
}

/** Provider read boundary. Never read an arbitrary attachment path supplied by an MCP server/history. */
export function readToolImageToBase64(image: ImageAttachment): string | null {
  const receipt = image && receipts.get(image.path);
  if (!receipt || image.mediaType !== receipt.mediaType || !directoryMatches(receipt.directory)) return null;
  try {
    const snapshot = readVerifiedRegularFileBytesSync(image.path, MAX_NATIVE_IMAGE_BYTES, {
      action: "read tool image snapshot", rejectHardLinks: true, protectSensitive: false,
    });
    if (snapshot.dev !== receipt.dev || snapshot.ino !== receipt.ino
      || (process.platform !== "win32" && snapshot.mode !== 0o600)
      || createHash("sha256").update(snapshot.bytes).digest("hex") !== receipt.digest) return null;
    return snapshot.bytes.toString("base64");
  } catch { return null; }
}

export const TOOL_IMAGE_UNAVAILABLE_NOTE = "[Tool image unavailable or no longer trusted; its pixels were not inspected. Request a fresh observation.]";
export const TOOL_IMAGE_UNSUPPORTED_NOTE = "[Tool image omitted: this model route does not accept images; its pixels were not inspected. Use the session's authorized image route.]";
