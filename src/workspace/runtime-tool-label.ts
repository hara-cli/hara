import { redactSensitiveText } from "../security/secrets.js";
const PRIVATE = /(?:^|[\\/])(?:\.env(?:\.[^\\/]*)?|\.(?:hara|codex|claude|gemini|kimi|ssh|aws|npmrc)|credentials?|secrets?|auth\.json)(?:$|[\\/])/iu;
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\/\\<>:@?#]|%2f|%5c|(?:sk[-_]|gh[pousr]_|github_pat_|xox[baprs]-)|(?:password|token|secret)\s*[:=]|\.(?:pem|key|p12|pfx)$/iu;
const OPAQUE = /^[a-f0-9]{24,}(?:\.[a-z0-9]+)?$/iu;
/** Only a basename is observable; never inspect the file, environment or tool result. */
export function isSafeRuntimeTargetLabel(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim() && [...value].length <= 40
    && value !== "." && value !== ".." && !PRIVATE.test(value) && !UNSAFE.test(value)
    && !OPAQUE.test(value) && redactSensitiveText(value).redactions.length === 0;
}
export function runtimeToolTargetLabel(name: string, input: unknown): string | undefined {
  if (!["read_file", "write_file", "edit_file", "ls", "workspace_read", "workspace_write", "workspace_verify"].includes(name) || !input || typeof input !== "object" || Array.isArray(input)) return undefined;
  try {
  const descriptor = Object.getOwnPropertyDescriptor(input, "path");
  const path = descriptor && "value" in descriptor ? descriptor.value : undefined;
  if (typeof path !== "string" || path.length > 4096 || PRIVATE.test(path) || redactSensitiveText(path).redactions.length) return undefined;
  const leaf = path.replace(/\\/gu, "/").split("/").filter(Boolean).at(-1);
  if (!leaf || UNSAFE.test(leaf) || OPAQUE.test(leaf)) return undefined;
  const chars = [...leaf], label = chars.length > 40 ? chars.slice(0, 39).join("") + "…" : leaf;
  return isSafeRuntimeTargetLabel(label) ? label : undefined;
  } catch { return undefined; } // Optional observation must never affect tool execution.
}
