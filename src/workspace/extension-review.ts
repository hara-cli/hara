// Host-only admission. A discovered name or an upstream annotation is never a code/tool grant.
import { createHash } from "node:crypto";
import { constants, openSync, closeSync, readFileSync, fstatSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { homedir } from "node:os";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import { readPrivateStateFileSnapshotSync } from "../security/private-state.js";
import { redactSensitiveText } from "../security/secrets.js";
import { canonical, exact, plain, deepFreeze } from "./local-state.js";
import { extensionDigest, validateExtensionCatalog, type ExtensionSourceDescriptor } from "./extension-catalog.js";
import type { Tool } from "../tools/registry.js";

export class WorkspaceMcpError extends Error {
  constructor(readonly code: "mcp_source_unreviewed" | "mcp_source_stale" | "mcp_schema_stale" | "mcp_input_invalid" | "mcp_proxy_unavailable" | "mcp_call_unavailable" | "mcp_outcome_unknown" | "mcp_approval_required" | "mcp_call_cancelled" | "mcp_result_limit" | "mcp_drain_unknown") { super(code); this.name = "WorkspaceMcpError"; }
}
export interface ReviewedMcpTool {
  toolId: string; remoteName: string; description: string; inputSchema: Tool["input_schema"];
  /** Trusted Host review, never inferred from readOnlyHint. External confirmation still applies. */
  effect: "read" | "exec";
}
export interface McpReviewRecord {
  schemaVersion: 1; source: ExtensionSourceDescriptor; command: string; args: string[]; packageRoot: string;
  binaryDigest: string; packageDigest: string; tools: ReviewedMcpTool[];
}
interface Stamp { path: string; dev: number; ino: number; size: number; mtime: number; ctime: number }
export interface ReviewedMcpSource { readonly descriptor: ExtensionSourceDescriptor }
interface Plan { record: McpReviewRecord; binary: Stamp; files: Stamp[]; schemaDigests: Map<string, string>; validators: Map<string, (input: unknown) => boolean> }
const plans = new WeakMap<object, Plan>();
const HASH = /^[a-f0-9]{64}$/u, ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/u;
const secretPath = /(?:^|\/)(?:\.aws|\.ssh|Keychains|\.env(?:\.[^/]*)?|\.npmrc|auth\.json|credentials?(?:\.[^/]*)?|secrets?(?:\.[^/]*)?|id_rsa|id_ed25519|\.DS_Store)(?:\/|$)/iu;
const contains = (root: string, path: string) => path === root || path.startsWith(root + sep);
function physical(path: string): string {
  if (typeof path !== "string" || !isAbsolute(path) || /[\x00-\x1f\x7f]/u.test(path) || realpathSync.native(path) !== path) throw new WorkspaceMcpError("mcp_source_unreviewed");
  let cursor = path;
  for (;;) { if (lstatSync(cursor).isSymbolicLink()) throw new WorkspaceMcpError("mcp_source_unreviewed"); const parent = dirname(cursor); if (parent === cursor) break; cursor = parent; }
  return path;
}
function hashFile(path: string, max: number): { digest: string; stamp: Stamp } {
  if (typeof path !== "string" || secretPath.test(path)) throw new WorkspaceMcpError("mcp_source_unreviewed");
  physical(path);
  if (!lstatSync(path).isFile()) throw new WorkspaceMcpError("mcp_source_unreviewed");
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > max || before.mode & 0o022) throw new WorkspaceMcpError("mcp_source_unreviewed");
    const bytes = readFileSync(fd), after = fstatSync(fd), named = lstatSync(path);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || after.dev !== named.dev || after.ino !== named.ino || after.nlink !== 1) throw new WorkspaceMcpError("mcp_source_stale");
    return { digest: createHash("sha256").update(bytes).digest("hex"), stamp: { path, dev: after.dev, ino: after.ino, size: after.size, mtime: after.mtimeMs, ctime: after.ctimeMs } };
  } finally { closeSync(fd); }
}
function packageTree(root: string): { digest: string; stamps: Stamp[] } {
  physical(root);
  if (secretPath.test(root) || root === sep || contains(root, homedir()) || !lstatSync(root).isDirectory()) throw new WorkspaceMcpError("mcp_source_unreviewed");
  const hashes: [string, string][] = [], stamps: Stamp[] = []; let total = 0;
  const visit = (directory: string, depth: number) => {
    const info = lstatSync(directory);
    if (depth > 12 || info.isSymbolicLink() || info.mode & 0o022) throw new WorkspaceMcpError("mcp_source_unreviewed");
    for (const row of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, row.name), name = relative(root, path);
      if (row.isSymbolicLink() || secretPath.test(name) || name.split(sep).includes(".git")) throw new WorkspaceMcpError("mcp_source_unreviewed");
      if (row.isDirectory()) { visit(path, depth + 1); continue; }
      if (hashes.length >= 512) throw new WorkspaceMcpError("mcp_source_unreviewed");
      const result = hashFile(path, 8 * 1024 * 1024); total += result.stamp.size;
      if (total > 32 * 1024 * 1024) throw new WorkspaceMcpError("mcp_source_unreviewed");
      hashes.push([name, result.digest]); stamps.push(result.stamp);
    }
  };
  visit(root, 0); if (!hashes.length) throw new WorkspaceMcpError("mcp_source_unreviewed");
  return { digest: extensionDigest(hashes), stamps };
}
function schema(tool: ReviewedMcpTool) {
  if (!plain(tool) || !exact(tool, ["toolId", "remoteName", "description", "inputSchema", "effect"])
    || typeof tool.toolId !== "string" || !ID.test(tool.toolId) || typeof tool.remoteName !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/u.test(tool.remoteName)
    || typeof tool.description !== "string" || tool.description.length > 1000 || redactSensitiveText(tool.description).redactions.length
    || !["read", "exec"].includes(tool.effect) || !plain(tool.inputSchema) || tool.inputSchema.type !== "object" || !plain(tool.inputSchema.properties)) throw new WorkspaceMcpError("mcp_source_unreviewed");
  const raw = canonical(tool.inputSchema);
  if (Buffer.byteLength(raw) > 8 * 1024) throw new WorkspaceMcpError("mcp_source_unreviewed");
  const walk = (value: unknown, depth: number) => {
    if (depth > 16) throw new WorkspaceMcpError("mcp_source_unreviewed");
    if (Array.isArray(value)) { value.forEach(item => walk(item, depth + 1)); return; }
    if (plain(value)) for (const [key, item] of Object.entries(value)) {
      if (["$ref", "$dynamicRef", "$id", "__proto__", "constructor", "prototype"].includes(key)) throw new WorkspaceMcpError("mcp_source_unreviewed"); walk(item, depth + 1);
    }
  };
  walk(tool.inputSchema, 0);
  const validate = new AjvJsonSchemaValidator().getValidator(tool.inputSchema as Parameters<AjvJsonSchemaValidator["getValidator"]>[0]);
  return { digest: extensionDigest({ name: tool.remoteName, description: tool.description, inputSchema: tool.inputSchema }), validate: (input: unknown) => validate(input).valid };
}
/** Produces a review record without starting code. Only trusted owner/Host composition may approve it.
 * No environment or credential field is accepted, persisted or forwarded. */
export function prepareWorkspaceMcpReview(input: { source: ExtensionSourceDescriptor; command: string; args: string[]; packageRoot: string; tools: ReviewedMcpTool[] }): McpReviewRecord {
  const binary = hashFile(input.command, 256 * 1024 * 1024), pack = packageTree(input.packageRoot);
  const record: McpReviewRecord = { schemaVersion: 1, ...input, binaryDigest: binary.digest, packageDigest: pack.digest };
  restoreWorkspaceMcpReview(record); return structuredClone(record);
}
/** Restore exact previously approved digests; never recompute a changed input into a new approval. */
export function restoreWorkspaceMcpReview(raw: McpReviewRecord): ReviewedMcpSource {
  try {
    if (!plain(raw) || !exact(raw, ["schemaVersion", "source", "command", "args", "packageRoot", "binaryDigest", "packageDigest", "tools"])
      || raw.schemaVersion !== 1 || !HASH.test(raw.binaryDigest) || !HASH.test(raw.packageDigest)
      || !Array.isArray(raw.args) || raw.args.length > 64 || !raw.args.every(arg => typeof arg === "string" && arg.length <= 4096 && !/[\x00-\x1f\x7f]/u.test(arg))
      || Buffer.byteLength(canonical(raw.args)) > 16 * 1024 || redactSensitiveText(canonical(raw.args)).redactions.length
      || raw.args.some(arg => /(?:^|--)(?:token|password|secret|api[-_]?key|authorization|cookie)(?:=|$)/iu.test(arg))
      || !Array.isArray(raw.tools) || raw.tools.length > 64) throw new WorkspaceMcpError("mcp_source_unreviewed");
    const source = validateExtensionCatalog([raw.source])[0]!;
    if (source.transport !== "stdio") throw new WorkspaceMcpError("mcp_source_unreviewed");
    physical(raw.command); physical(raw.packageRoot);
    if (raw.args.some(arg => isAbsolute(arg) && !contains(raw.packageRoot, arg))) throw new WorkspaceMcpError("mcp_source_unreviewed");
    const binary = hashFile(raw.command, 256 * 1024 * 1024), pack = packageTree(raw.packageRoot);
    if (binary.digest !== raw.binaryDigest || pack.digest !== raw.packageDigest) throw new WorkspaceMcpError("mcp_source_stale");
    const schemaDigests = new Map<string, string>(), validators = new Map<string, (value: unknown) => boolean>();
    for (const tool of raw.tools) { const checked = schema(tool); schemaDigests.set(tool.toolId, checked.digest); validators.set(tool.toolId, checked.validate); }
    if (new Set(raw.tools.map(tool => tool.remoteName)).size !== raw.tools.length || schemaDigests.size !== raw.tools.length) throw new WorkspaceMcpError("mcp_source_unreviewed");
    const descriptor = validateExtensionCatalog([{ ...source, sourceRevision: extensionDigest({ sourceRevision: source.sourceRevision, binary: binary.digest, package: pack.digest, schemas: [...schemaDigests] }),
      tools: raw.tools.map(tool => ({ toolId: tool.toolId, name: tool.remoteName, description: tool.description })) }])[0]!;
    const reviewed = Object.freeze({ descriptor: deepFreeze(descriptor) });
    plans.set(reviewed, { record: deepFreeze(structuredClone(raw)), binary: binary.stamp, files: pack.stamps, schemaDigests, validators }); return reviewed;
  } catch (error) { throw error instanceof WorkspaceMcpError ? error : new WorkspaceMcpError("mcp_source_unreviewed"); }
}
export function workspaceMcpReviewPlan(source: ReviewedMcpSource): Readonly<Plan> {
  const plan = plans.get(source); if (!plan) throw new WorkspaceMcpError("mcp_source_unreviewed"); return plan;
}
export function assertWorkspaceMcpReviewCurrent(source: ReviewedMcpSource): void {
  const plan = workspaceMcpReviewPlan(source);
  for (const saved of [plan.binary, ...plan.files]) {
    const info = lstatSync(saved.path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.mode & 0o022 || info.dev !== saved.dev || info.ino !== saved.ino || info.size !== saved.size
      || info.mtimeMs !== saved.mtime || info.ctimeMs !== saved.ctime || realpathSync.native(saved.path) !== saved.path) throw new WorkspaceMcpError("mcp_source_stale");
  }
  // Catch new/deleted package entries as well as changed known files. Bounded tree, no credential paths.
  if (packageTree(plan.record.packageRoot).digest !== plan.record.packageDigest) throw new WorkspaceMcpError("mcp_source_stale");
}
/** Optional Host-maintained, owner-only review library. Missing means no reviewed execution sources.
 * This file contains no credentials; native installer/operator review is separate from Workspace grants. */
export function readWorkspaceMcpReviews(path: string): ReviewedMcpSource[] {
  try {
    const snapshot = readPrivateStateFileSnapshotSync(path, 1024 * 1024); if (!snapshot) return [];
    const raw: unknown = JSON.parse(snapshot.text);
    if (!plain(raw) || !exact(raw, ["schemaVersion", "records"]) || raw.schemaVersion !== 1 || !Array.isArray(raw.records) || raw.records.length > 64) throw new Error();
    return raw.records.map(record => restoreWorkspaceMcpReview(record as McpReviewRecord));
  } catch { throw new WorkspaceMcpError("mcp_source_unreviewed"); }
}
