import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import type { WorkspaceMcpEndpoint } from "./registered-cli-mcp.js";
import { WORKSPACE_MCP_TOKEN_ENV } from "./registered-cli-mcp.js";

const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function snapshot(file: string): { bytes: Buffer; mode: number; ino: number; hash: string } | null {
  let before;
  try { before = lstatSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 256 * 1024
    || process.getuid && before.uid !== process.getuid()) throw new Error("runtime_permission_denied");
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd), bytes = readFileSync(fd), after = lstatSync(file);
    if (opened.ino !== before.ino || after.ino !== before.ino || opened.dev !== before.dev || bytes.length !== before.size
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error("runtime_permission_denied");
    return { bytes, mode: before.mode & 0o777, ino: before.ino, hash: digest(bytes) };
  } finally { closeSync(fd); }
}
function atomic(file: string, bytes: Buffer, mode: number): void {
  const temp = file + ".hara-" + randomUUID();
  const fd = openSync(temp, "wx", 0o600);
  try { writeFileSync(fd, bytes); fchmodSync(fd, mode); } finally { closeSync(fd); }
  try { renameSync(temp, file); } finally { try { unlinkSync(temp); } catch { /* renamed or already absent */ } }
}
function server(endpoint: WorkspaceMcpEndpoint) {
  const token = endpoint.env[WORKSPACE_MCP_TOKEN_ENV];
  if (!token || !/^[a-f0-9]{64}$/.test(token)) throw new Error("runtime_permission_denied");
  return { type: "http", url: endpoint.url, headers: { Authorization: "Bearer " + token } };
}
export function writeCopilotMcpConfig(temporaryDirectory: string, endpoint: WorkspaceMcpEndpoint): { path: string; close(): void } {
  const root = realpathSync(temporaryDirectory), path = join(root, "hara-copilot-mcp-" + randomUUID() + ".json");
  writeFileSync(path, JSON.stringify({ mcpServers: { hara: { ...server(endpoint), tools: ["*"] } } }), { mode: 0o600, flag: "wx" });
  const original = snapshot(path)!;
  return { path, close() { const current = snapshot(path); if (!current) return;
    if (current.ino !== original.ino || current.hash !== original.hash) throw new Error("runtime_permission_denied");
    unlinkSync(path); } };
}
/** Temporary additive project MCP overlay; no home config. Refuse links, concurrent Hara overlays and changed
 * files. Restore original bytes/mode, and never discard an observed change made by another writer. */
export function overlayCursorMcpConfig(cwd: string, endpoint: WorkspaceMcpEndpoint): { path: string; close(): void } {
  const directory = join(realpathSync(cwd), ".cursor");
  let createdDirectory = false;
  try { mkdirSync(directory, { mode: 0o700 }); createdDirectory = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o022) !== 0 || process.getuid && info.uid !== process.getuid())
    throw new Error("runtime_permission_denied");
  const lock = join(directory, ".hara-mcp.lock"), lockFd = openSync(lock, "wx", 0o600), lockIdentity = fstatSync(lockFd);
  closeSync(lockFd);
  const path = join(directory, "mcp.json");
  let before: ReturnType<typeof snapshot>, installed: ReturnType<typeof snapshot>, closed = false;
  const release = () => { if (lstatSync(lock).ino !== lockIdentity.ino) throw new Error("runtime_permission_denied"); unlinkSync(lock); };
  try {
    before = snapshot(path);
    const value: unknown = before ? JSON.parse(before.bytes.toString("utf8")) : {};
    if (!object(value) || value.mcpServers !== undefined && !object(value.mcpServers)) throw new Error("runtime_permission_denied");
    const current = snapshot(path);
    if ((current?.ino ?? null) !== (before?.ino ?? null) || (current?.hash ?? null) !== (before?.hash ?? null)) throw new Error("runtime_permission_denied");
    atomic(path, Buffer.from(JSON.stringify({ ...value, mcpServers: { ...(value.mcpServers as object ?? {}), hara: (({ type: _type, ...remote }) => remote)(server(endpoint)) } }) + "\n"), 0o600);
    installed = snapshot(path);
  } catch (error) { release(); if (createdDirectory) try { rmdirSync(directory); } catch { /* retain existing files */ } throw error; }
  return { path, close() {
    if (closed) return;
    closed = true;
    try {
      const current = snapshot(path);
      if (!current || current.ino !== installed?.ino || current.hash !== installed?.hash) throw new Error("runtime_permission_denied");
      if (before) atomic(path, before.bytes, before.mode); else unlinkSync(path);
    } finally { release(); if (createdDirectory) try { rmdirSync(directory); } catch { /* runtime-created project state stays */ } }
  } };
}
