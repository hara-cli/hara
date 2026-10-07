import { createHash } from "node:crypto";

/** Opaque fingerprints allow late diagnostics to be scrubbed after the image bytes are disposed. */
export interface ToolMediaRedaction {
  paths: readonly string[];
  base64Length: number;
  base64Digest: string;
  prefixLength: number;
  prefixDigest: string;
}

const digest = (text: string): string => createHash("sha256").update(text).digest("hex");
const IMAGE_DATA_OMITTED = "[tool image data omitted]";
const IMAGE_PATH_OMITTED = "[tool image path omitted]";
// This lower-level registry must stay independent of tools/providers/vision to avoid initialization
// cycles. Owners register only opaque fingerprints and paths; no image bytes live here.
const liveMedia = new Map<string, ToolMediaRedaction>();

export function registerToolMediaRedaction(owner: string, redaction: ToolMediaRedaction): void {
  liveMedia.set(owner, redaction);
}

export function removeToolMediaRedaction(owner: string): void {
  liveMedia.delete(owner);
}

export function redactOwnedToolImageText(text: string): string {
  return redactToolMediaText(text, [...liveMedia.values()]);
}

/** Inspect JSON-shaped model output while its media owner is still alive. Unchanged opaque provider
 * state keeps its original identity; changed values are display/history projections, never execution
 * arguments or valid replacement provider continuations. */
export function redactOwnedToolImageValue<T>(value: T): { value: T; redacted: boolean } {
  const known = [...liveMedia.values()];
  if (!known.length) return { value, redacted: false };
  let redacted = false;
  const serialized = JSON.stringify(value, (_key, current) => {
    if (typeof current !== "string") return current;
    const clean = redactToolMediaText(current, known);
    if (clean !== current) redacted = true;
    return clean;
  });
  if (serialized === undefined) return { value, redacted: false };
  // The second pass also covers object keys and escaped path representations inside JSON strings.
  const clean = redactToolMediaText(serialized, known);
  if (clean !== serialized) redacted = true;
  return { value: redacted ? JSON.parse(clean) as T : value, redacted };
}

export function toolMediaRedaction(base64: string, path: string): ToolMediaRedaction {
  const prefixLength = Math.min(64, base64.length);
  const paths = [`file://${path}`, encodeURI(`file://${path}`), path, encodeURI(path)];
  return {
    paths: [...new Set(paths.flatMap((value) => [value, value.replaceAll("/", "\\/"), JSON.stringify(value).slice(1, -1)]))]
      .sort((left, right) => right.length - left.length),
    base64Length: base64.length,
    base64Digest: digest(base64),
    prefixLength,
    prefixDigest: digest(base64.slice(0, prefixLength)),
  };
}

/** Scrub inline media in both successful text and diagnostics before text is truncated or retained.
 * Never preserve raw pixels as redaction metadata; the fingerprints are process-local and opaque. */
export function redactToolMediaText(text: string, known: readonly ToolMediaRedaction[] = []): string {
  let clean = text.replace(/data:(?:image|audio|video)\/(?:[^,\s"'<>]{1,256}),[^\s"'<>]+/gi, IMAGE_DATA_OMITTED);
  for (const media of known) {
    for (const path of media.paths) clean = clean.replaceAll(path, IMAGE_PATH_OMITTED);
  }
  if (!known.length) return clean;
  return clean.replace(/[A-Za-z0-9+/]{16,}={0,2}/g, (candidate) => {
    const possible = known.filter((media) => candidate.length <= media.base64Length && candidate.length >= media.prefixLength);
    if (!possible.length) return candidate;
    for (const media of possible) {
      if ((candidate.length === media.base64Length && digest(candidate) === media.base64Digest)
        || digest(candidate.slice(0, media.prefixLength)) === media.prefixDigest) return IMAGE_DATA_OMITTED;
    }
    return candidate;
  });
}
