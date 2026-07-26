import {
  closeSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import type { ImageAttachment, UserAttachmentView } from "../providers/types.js";
import { sensitiveFileError } from "../security/sensitive-files.js";

export const MAX_TURN_ATTACHMENTS = 16;
export const MAX_TURN_IMAGES = 8;
/** Keeps base64 payloads below the common 5 MB provider limit. */
export const MAX_IMAGE_BYTES = 3_600_000;
const MAX_ATTACHMENT_PATH = 4_096;

export type SessionAttachmentKind = "image" | "file" | "directory";

export interface SessionAttachmentIntent {
  clientId?: string;
  kind: SessionAttachmentKind;
  path: string;
  mediaType?: string;
}

export interface ValidatedSessionAttachments {
  images: ImageAttachment[];
  contexts: { kind: "file" | "directory"; path: string }[];
  views: UserAttachmentView[];
}

function imageMediaType(path: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const head = Buffer.alloc(12);
    const length = readSync(fd, head, 0, head.length, 0);
    if (
      length >= 8
      && head[0] === 0x89
      && head.subarray(1, 4).toString("ascii") === "PNG"
      && head[4] === 0x0d
      && head[5] === 0x0a
      && head[6] === 0x1a
      && head[7] === 0x0a
    ) return "image/png";
    if (length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
      return "image/jpeg";
    }
    const signature = head.subarray(0, 6).toString("ascii");
    if (signature === "GIF87a" || signature === "GIF89a") return "image/gif";
    if (
      length >= 12
      && head.subarray(0, 4).toString("ascii") === "RIFF"
      && head.subarray(8, 12).toString("ascii") === "WEBP"
    ) return "image/webp";
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function normalizedPath(raw: string, cwd: string): string {
  if (!raw || raw.length > MAX_ATTACHMENT_PATH || raw.includes("\0")) {
    throw new Error("attachment path is empty or too long");
  }
  return isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw);
}

/**
 * Security and type boundary for every persistent client, not just Desktop.
 * The renderer may preflight for UX, but `hara serve` remains authoritative.
 */
export function validateSessionAttachments(
  cwd: string,
  input: SessionAttachmentIntent[],
): ValidatedSessionAttachments {
  if (input.length > MAX_TURN_ATTACHMENTS) {
    throw new Error(`a turn can attach at most ${MAX_TURN_ATTACHMENTS} items`);
  }
  const images: ImageAttachment[] = [];
  const contexts: ValidatedSessionAttachments["contexts"] = [];
  const views: UserAttachmentView[] = [];
  const seen = new Set<string>();

  for (const attachment of input) {
    if (
      !attachment
      || !["image", "file", "directory"].includes(attachment.kind)
      || typeof attachment.path !== "string"
    ) {
      throw new Error("each attachment needs kind=image|file|directory and a path");
    }
    const path = normalizedPath(attachment.path, cwd);
    const denied = sensitiveFileError(path, "attach");
    if (denied) throw new Error(denied);
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      throw new Error(`attachment is missing or unreadable: ${basename(path)}`);
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`attachment cannot be a symbolic link: ${basename(path)}`);
    }
    const dedupeKey = `${stat.isDirectory() ? "directory" : "file"}:${path}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    if (attachment.kind === "directory") {
      if (!stat.isDirectory()) throw new Error(`selected directory is not a directory: ${basename(path)}`);
      contexts.push({ kind: "directory", path });
      views.push({
        kind: "directory",
        name: basename(path),
        strategy: "directory-inventory",
      });
      continue;
    }
    if (!stat.isFile()) throw new Error(`attachment is not a regular file: ${basename(path)}`);
    const detectedImage = imageMediaType(path);
    if (attachment.kind === "image" && !detectedImage) {
      throw new Error(`selected image has an unsupported or invalid format: ${basename(path)}`);
    }
    if (detectedImage) {
      if (stat.size === 0 || stat.size > MAX_IMAGE_BYTES) {
        throw new Error(
          `image '${basename(path)}' must be between 1 byte and ${MAX_IMAGE_BYTES} bytes`,
        );
      }
      images.push({ path, mediaType: detectedImage });
      views.push({
        kind: "image",
        name: basename(path),
        mediaType: detectedImage,
        byteSize: stat.size,
        strategy: "native-image",
      });
      continue;
    }
    contexts.push({ kind: "file", path });
    views.push({
      kind: "file",
      name: basename(path),
      byteSize: stat.size,
      strategy: "inline-or-agent-tool",
    });
  }
  if (images.length > MAX_TURN_IMAGES) {
    throw new Error(`a turn can attach at most ${MAX_TURN_IMAGES} images`);
  }
  return { images, contexts, views };
}
