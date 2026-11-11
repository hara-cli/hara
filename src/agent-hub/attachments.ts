import { createHash } from "node:crypto";
import { extname } from "node:path";
import { AgentHubError, exact, hubAssert, plain } from "./errors.js";

export const HUB_LIMITS = Object.freeze({ textBytes: 32 * 1024, fileBytes: 8 * 1024 * 1024,
  metadataBytes: 64 * 1024, pageBytes: 256 * 1024, chunkBytes: 64 * 1024,
  files: 4, attachmentBytes: 16 * 1024 * 1024, pixels: 20_000_000, dimension: 8192,
  quotaBytes: 128 * 1024 * 1024, connections: 256, messages: 4096, catalogBytes: 4 * 1024 * 1024 });
export const HUB_BODY_BYTES = Math.ceil(HUB_LIMITS.attachmentBytes / 3) * 4 + HUB_LIMITS.textBytes * 6 + 64 * 1024;
export interface HubAttachment {
  name: string; mime: string; bytes: number; sha256: string; base64: string;
  /** Container/dimension checks are not a full image decoder. No inline preview before bounded decode. */
  preview: "quarantined" | "none";
  width?: number; height?: number;
}
const TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".md": "text/markdown", ".txt": "text/plain", ".pdf": "application/pdf" };
export const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function dimensions(width: number, height: number) {
  hubAssert(width > 0 && height > 0 && width <= HUB_LIMITS.dimension && height <= HUB_LIMITS.dimension
    && width * height <= HUB_LIMITS.pixels, "unsupported_attachment");
  return { width, height };
}
function imageDimensions(bytes: Buffer, mime: string): { width: number; height: number } {
  if (mime === "image/png") {
    hubAssert(bytes.length >= 45 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      && bytes.readUInt32BE(8) === 13 && bytes.toString("ascii", 12, 16) === "IHDR", "unsupported_attachment");
    const size = dimensions(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
    let offset = 8, data = false, ended = false;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset), kind = bytes.toString("ascii", offset + 4, offset + 8);
      hubAssert(length <= bytes.length - offset - 12 && /^[A-Za-z]{4}$/.test(kind)
        && !["acTL", "fcTL", "fdAT"].includes(kind), "unsupported_attachment");
      if (kind === "IDAT") data = true;
      offset += length + 12;
      if (kind === "IEND") { hubAssert(length === 0 && offset === bytes.length, "unsupported_attachment"); ended = true; break; }
    }
    hubAssert(data && ended, "unsupported_attachment");
    return size;
  }
  if (mime === "image/jpeg") {
    hubAssert(bytes.length >= 12 && bytes[0] === 255 && bytes[1] === 216
      && bytes[bytes.length - 2] === 255 && bytes[bytes.length - 1] === 217, "unsupported_attachment");
    let offset = 2; let size: { width: number; height: number } | undefined;
    while (offset < bytes.length - 2) {
      hubAssert(bytes[offset++] === 255, "unsupported_attachment");
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      hubAssert(marker !== undefined && ![0, 216, 217].includes(marker), "unsupported_attachment");
      if (marker === 1 || marker >= 208 && marker <= 215) continue;
      hubAssert(offset + 2 <= bytes.length, "unsupported_attachment");
      const length = bytes.readUInt16BE(offset);
      hubAssert(length >= 2 && length <= bytes.length - offset, "unsupported_attachment");
      if ([192, 193, 194].includes(marker)) {
        hubAssert(!size && length >= 8 && bytes[offset + 2] === 8, "unsupported_attachment");
        size = dimensions(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3));
      }
      if (marker === 218) { hubAssert(size, "unsupported_attachment"); return size; }
      offset += length;
    }
    throw new AgentHubError("unsupported_attachment");
  }
  hubAssert(bytes.length >= 20 && bytes.toString("ascii", 0, 4) === "RIFF"
    && bytes.toString("ascii", 8, 12) === "WEBP" && bytes.readUInt32LE(4) + 8 === bytes.length, "unsupported_attachment");
  let offset = 12, frames = 0; let size: { width: number; height: number } | undefined;
  while (offset + 8 <= bytes.length) {
    const kind = bytes.toString("ascii", offset, offset + 4), length = bytes.readUInt32LE(offset + 4), start = offset + 8;
    hubAssert(length <= bytes.length - start && !["ANIM", "ANMF"].includes(kind), "unsupported_attachment");
    if (kind === "VP8X") {
      hubAssert(length === 10 && !(bytes[start] & 2), "unsupported_attachment");
      size = dimensions(1 + bytes.readUIntLE(start + 4, 3), 1 + bytes.readUIntLE(start + 7, 3));
    }
    if (kind === "VP8 ") {
      hubAssert(++frames === 1 && length >= 10 && bytes.subarray(start + 3, start + 6).equals(Buffer.from([157, 1, 42])), "unsupported_attachment");
      const frame = dimensions(bytes.readUInt16LE(start + 6) & 16383, bytes.readUInt16LE(start + 8) & 16383);
      hubAssert(!size || size.width === frame.width && size.height === frame.height, "unsupported_attachment"); size = frame;
    }
    if (kind === "VP8L") {
      hubAssert(++frames === 1 && length >= 5 && bytes[start] === 47, "unsupported_attachment");
      const bits = bytes.readUInt32LE(start + 1);
      const frame = dimensions((bits & 16383) + 1, ((bits >>> 14) & 16383) + 1);
      hubAssert(!size || size.width === frame.width && size.height === frame.height, "unsupported_attachment"); size = frame;
    }
    offset = start + length + (length & 1);
  }
  hubAssert(size && frames === 1 && offset === bytes.length, "unsupported_attachment"); return size;
}
export function parseHubAttachments(input: unknown): HubAttachment[] {
  hubAssert(Array.isArray(input) && input.length <= HUB_LIMITS.files);
  let total = 0;
  return input.map(raw => {
    hubAssert(plain(raw) && exact(raw, ["name", "mime", "base64"]));
    hubAssert(typeof raw.name === "string" && raw.name.length > 0 && raw.name.length <= 160
      && !raw.name.startsWith(".") && !/[\\/:\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(raw.name));
    hubAssert(typeof raw.mime === "string" && TYPES[extname(raw.name).toLowerCase()] === raw.mime, "unsupported_attachment");
    hubAssert(typeof raw.base64 === "string" && raw.base64.length > 0
      && raw.base64.length <= Math.ceil(HUB_LIMITS.fileBytes / 3) * 4 && /^[A-Za-z0-9+/]*={0,2}$/.test(raw.base64));
    const bytes = Buffer.from(raw.base64, "base64");
    hubAssert(bytes.length > 0 && bytes.length <= HUB_LIMITS.fileBytes && bytes.toString("base64") === raw.base64);
    total += bytes.length; hubAssert(total <= HUB_LIMITS.attachmentBytes);
    const size = raw.mime.startsWith("image/") ? imageDimensions(bytes, raw.mime) : undefined;
    if (raw.mime.startsWith("text/")) {
      const text = bytes.toString("utf8");
      hubAssert(Buffer.from(text).equals(bytes) && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(text), "unsupported_attachment");
    }
    if (raw.mime === "application/pdf") hubAssert(bytes.subarray(0, 5).toString() === "%PDF-"
      && /%%EOF\s*$/.test(bytes.subarray(-1024).toString("latin1")), "unsupported_attachment");
    return { name: raw.name, mime: raw.mime, bytes: bytes.length, sha256: sha256(bytes), base64: raw.base64,
      preview: size ? "quarantined" : "none", ...size };
  });
}
