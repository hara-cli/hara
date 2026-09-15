import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { sensitiveFileError } from "../security/sensitive-files.js";
import type { ToolContext } from "./registry.js";

const MAX_DECLARED_OUTPUTS = 12;
const MAX_VERIFIED_OUTPUT_BYTES = 24 * 1024 * 1024;

export type DeclaredOutputSnapshot = Map<string, string | undefined>;

function insideWorkspace(cwd: string, path: string): boolean {
  const rel = relative(cwd, path);
  return rel !== "" && rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\");
}

function declaredPaths(value: unknown, cwd: string): string[] {
  if (!Array.isArray(value)) return [];
  const paths = new Set<string>();
  for (const item of value.slice(0, MAX_DECLARED_OUTPUTS)) {
    if (typeof item !== "string" || !item.trim() || item.length > 500 || item.includes("\0")) continue;
    const path = resolve(cwd, item);
    if (insideWorkspace(cwd, path) && !sensitiveFileError(path, "read")) paths.add(path);
  }
  return [...paths];
}

async function contentDigest(path: string, cwdReal: string): Promise<string | undefined> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size > MAX_VERIFIED_OUTPUT_BYTES) return undefined;
    const canonical = await realpath(path);
    if (!insideWorkspace(cwdReal, canonical) || sensitiveFileError(canonical, "read")) return undefined;
    const content = await readFile(canonical);
    return createHash("sha256").update(content).digest("hex");
  } catch {
    return undefined;
  }
}

/** Bounded, read-only proof for shell/Python-produced files. No file content or path enters progress state. */
export async function snapshotDeclaredOutputs(value: unknown, ctx: ToolContext): Promise<DeclaredOutputSnapshot> {
  const snapshot: DeclaredOutputSnapshot = new Map();
  const paths = declaredPaths(value, ctx.cwd);
  if (!paths.length) return snapshot;
  const cwdReal = await realpath(ctx.cwd).catch(() => ctx.cwd);
  for (const path of paths) snapshot.set(path, await contentDigest(path, cwdReal));
  return snapshot;
}

export async function reportChangedDeclaredOutputs(snapshot: DeclaredOutputSnapshot, ctx: ToolContext): Promise<void> {
  if (!ctx.verifiedChange || !snapshot.size) return;
  const cwdReal = await realpath(ctx.cwd).catch(() => ctx.cwd);
  for (const [path, before] of snapshot) {
    const after = await contentDigest(path, cwdReal);
    if (!after || before === after) continue;
    ctx.verifiedChange(createHash("sha256").update(path).update("\0").update(after).digest("hex"));
  }
}
