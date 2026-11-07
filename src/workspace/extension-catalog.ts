// Discovery is metadata-only. No process, plugin activation, environment or credential resolver.
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { readPrivateStateFileSnapshotSync } from "../security/private-state.js";
import { redactSensitiveText } from "../security/secrets.js";
import { readVerifiedPluginManifest } from "../plugins/manifest.js";
import { canonical, plain } from "./local-state.js";

export interface ExtensionToolDescriptor { toolId: string; name: string; description: string }
export interface ExtensionSourceDescriptor {
  sourceId: string; kind: "global" | "plugin" | "workspace"; name: string;
  transport: "stdio" | "streamable-http" | "sse"; executableSummary: string; description: string;
  sourceRevision: string; tools: ExtensionToolDescriptor[];
}
export type ExtensionCatalogProvider = () => readonly ExtensionSourceDescriptor[];
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
const HASH = /^[a-f0-9]{64}$/;
export const extensionDigest = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");
const safeKey = (value: string): boolean => ID.test(value) && !redactSensitiveText(value).redactions.length;
function label(value: unknown, fallback: string, max = 300): string {
  if (typeof value !== "string") return fallback;
  return redactSensitiveText(value).text.replace(/https?:[^\s]+|(?:~|\/Users|\/home|[A-Z]:\\)[^\s]*/gu, "[private]")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").slice(0, max).trim() || fallback;
}
/** Host-owned input, never an RPC payload. In particular, never enumerate/copy/stringify a server.
 * env, args, headers, URLs and unrelated plugin contributions are deliberately not accessed. */
export function discoverWorkspaceExtensionSources(input: {
  hostId: string; hostRevision: string; globalServers?: unknown;
  verifiedPlugins?: readonly { packageDigest: string; servers: unknown }[];
}): ExtensionSourceDescriptor[] {
  if (!safeKey(input.hostId)) throw new Error("Invalid extension host identity");
  const out: ExtensionSourceDescriptor[] = [];
  const add = (servers: unknown, kind: "global" | "plugin", namespace: string, revision: string) => {
    if (!plain(servers)) return;
    for (const key of Object.keys(servers).sort().slice(0, 128)) {
      if (!safeKey(key) || !plain(servers[key])) continue;
      const server = servers[key];
      const transport = server.transport === "streamable-http" || server.transport === "sse" ? server.transport : "stdio";
      const command = typeof server.command === "string" ? server.command : "";
      if (transport === "stdio" && (!command || command.length > 4096 || /[\s\u0000-\u001f\u007f]/u.test(command))) continue;
      const executable = command.split(/[\/\\]/u).at(-1) ?? "";
      const executableSummary = transport === "stdio" ? `stdio · ${safeKey(executable) ? executable : "executable"}` : "remote MCP endpoint";
      const descriptor: Omit<ExtensionSourceDescriptor, "sourceRevision"> = { sourceId: `${kind}:${namespace}:${key}`, kind, name: key, transport,
        executableSummary, description: label(server.description, key), tools: [] as ExtensionToolDescriptor[] };
      out.push({ ...descriptor, sourceRevision: extensionDigest({ descriptor, revision, commandIdentity: extensionDigest(command) }) });
    }
  };
  add(input.globalServers, "global", input.hostId, input.hostRevision);
  for (const plugin of (input.verifiedPlugins ?? []).slice(0, 128)) {
    if (HASH.test(plugin.packageDigest)) add(plugin.servers, "plugin", plugin.packageDigest, plugin.packageDigest);
  }
  return validateExtensionCatalog(out);
}
export function validateExtensionCatalog(input: readonly ExtensionSourceDescriptor[]): ExtensionSourceDescriptor[] {
  if (!Array.isArray(input) || input.length > 256) throw new Error("Invalid extension catalog");
  const result = input.map(raw => {
    if (!plain(raw) || typeof raw.sourceId !== "string" || raw.sourceId.length > 256
      || !/^(global:[a-zA-Z0-9._-]+:[a-zA-Z0-9._-]+|plugin:[a-f0-9]{64}:[a-zA-Z0-9._-]+|workspace:[a-zA-Z0-9._-]+)$/u.test(raw.sourceId)
      || typeof raw.kind !== "string" || !["global", "plugin", "workspace"].includes(raw.kind) || !raw.sourceId.startsWith(raw.kind + ":")
      || typeof raw.sourceRevision !== "string" || !HASH.test(raw.sourceRevision) || typeof raw.transport !== "string" || !["stdio", "streamable-http", "sse"].includes(raw.transport)
      || !Array.isArray(raw.tools) || raw.tools.length > 64) throw new Error("Invalid extension descriptor");
    const tools = raw.tools.map(tool => {
      if (!plain(tool) || typeof tool.toolId !== "string" || !safeKey(tool.toolId)) throw new Error("Invalid extension tool descriptor");
      return { toolId: tool.toolId, name: label(tool.name, tool.toolId, 80), description: label(tool.description, tool.toolId) };
    });
    if (new Set(tools.map(tool => tool.toolId)).size !== tools.length) throw new Error("Duplicate extension tools");
    // Rebuild an allowlisted DTO, never spread an upstream object (including into private storage).
    return { sourceId: raw.sourceId, kind: raw.kind as ExtensionSourceDescriptor["kind"], name: label(raw.name, "MCP", 80), transport: raw.transport as ExtensionSourceDescriptor["transport"],
      sourceRevision: raw.sourceRevision, executableSummary: label(raw.executableSummary, "MCP executable", 100),
      description: label(raw.description, "MCP"), tools };
  });
  if (new Set(result.map(row => row.sourceId)).size !== result.length || Buffer.byteLength(JSON.stringify(result)) > 256 * 1024) throw new Error("Invalid extension catalog");
  return result;
}
/** Select only non-secret configuration fields. Skipped JSON values are scanned, never decoded or
 * materialized; this includes env, args, URLs, headers and all other host configuration domains. */
export function projectHostMcpConfig(text: string, launch = false): unknown {
  let at = 0;
  const space = () => { while (/\s/u.test(text[at] ?? "") && at < text.length) at++; };
  const string = (keep: boolean): string | undefined => {
    const start = at++; let closed = false;
    while (at < text.length) {
      const char = text[at++];
      if (char === "\\") {
        const escape = text[at++];
        if (escape === "u") { if (!/^[a-fA-F0-9]{4}$/u.test(text.slice(at, at + 4))) throw new Error("Invalid host MCP metadata"); at += 4; }
        else if (!escape || !'"\\/bfnrt'.includes(escape)) throw new Error("Invalid host MCP metadata");
      } else if (char === '"') { closed = true; break; }
      else if (char!.charCodeAt(0) < 32) throw new Error("Invalid host MCP metadata");
    }
    if (!closed) throw new Error("Invalid host MCP metadata");
    return keep ? JSON.parse(text.slice(start, at)) : undefined;
  };
  const value = (path: string[], keep: boolean, depth: number): unknown => {
    if (depth > 64) throw new Error("Invalid host MCP metadata");
    space(); const char = text[at];
    if (char === '"') return string(keep);
    if (char === "{" || char === "[") {
      at++; space(); const object = char === "{", close = object ? "}" : "]";
      const out: Record<string, unknown> | unknown[] = object ? Object.create(null) : []; const seen = new Set<string>();
      let remote = false;
      const finish = () => {
        if (keep && object && path.length === 2) {
          const server = out as Record<string, unknown>;
          if (server.transport === undefined && (remote || server.type === "http" || server.type === "sse")) server.transport = server.type === "sse" ? "sse" : "streamable-http";
          delete server.type;
        }
        return keep ? out : undefined;
      };
      if (text[at] === close) { at++; return finish(); }
      while (at < text.length) {
        space(); let key = "";
        if (object) { if (text[at] !== '"') throw new Error("Invalid host MCP metadata"); key = string(keep) ?? ""; space(); if (text[at++] !== ":") throw new Error("Invalid host MCP metadata"); }
        if (keep && object && seen.has(key)) throw new Error("Ambiguous host MCP metadata");
        seen.add(key);
        if (keep && object && path.length === 2) {
          if (key === "url") remote = true;
          if (launch && ["env", "headers", "authorization", "oauth", "auth", "credentials"].includes(key)) (out as Record<string, unknown>).requiresCredentials = true;
        }
        const selected = keep && (object ? (path.length === 0 ? key === "mcpServers" : path.length === 1 ? true
          : path.length === 2 && ["command", "description", "transport", "type", ...(launch ? ["args", "packageRoot"] : [])].includes(key))
          : launch && path.length === 3 && path[2] === "args");
        const child = value([...path, key], selected, depth + 1);
        if (selected) { if (object) (out as Record<string, unknown>)[key] = child; else (out as unknown[]).push(child); }
        space(); if (text[at] === close) { at++; return finish(); }
        if (text[at++] !== ",") throw new Error("Invalid host MCP metadata");
      }
      throw new Error("Invalid host MCP metadata");
    }
    const start = at; while (at < text.length && !/[\s,}\]]/u.test(text[at]!)) at++;
    if (at === start || !/^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)$/u.test(text.slice(start, at))) throw new Error("Invalid host MCP metadata");
    return keep ? JSON.parse(text.slice(start, at)) : undefined;
  };
  space(); if (text[at] !== "{") throw new Error("Invalid host MCP metadata");
  const projected = value([], true, 0); space();
  if (at !== text.length || !plain(projected)) throw new Error("Invalid host MCP metadata");
  return projected.mcpServers;
}
/** Explicit Host composition only. Never called from a model-supplied path or on each tool call. */
export function readHostWorkspaceExtensionCatalog(home: string, hostId: string): ExtensionSourceDescriptor[] {
  try {
    if (realpathSync.native(home) !== home) throw new Error();
    const config = join(home, ".hara/config.json"), snapshot = readPrivateStateFileSnapshotSync(config, 1024 * 1024);
    const info = snapshot ? lstatSync(config, { bigint: true }) : undefined;
    const verifiedPlugins: { packageDigest: string; servers: unknown }[] = [];
    const directory = join(home, ".hara/plugins");
    try {
      if (realpathSync.native(directory) !== directory) throw new Error();
      for (const entry of readdirSync(directory, { withFileTypes: true }).slice(0, 128)) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || !safeKey(entry.name)) continue;
        try { const verified = readVerifiedPluginManifest(join(directory, entry.name), { scanTree: false });
          if (verified.manifest.name === entry.name) verifiedPlugins.push({ packageDigest: verified.sha256, servers: verified.manifest.mcpServers });
        } catch { /* An unverified package is not a candidate. No install or activation. */ }
      }
    } catch (error: any) { if (error?.code !== "ENOENT") throw new Error(); }
    return discoverWorkspaceExtensionSources({ hostId,
      hostRevision: info ? `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}` : "missing",
      globalServers: snapshot ? projectHostMcpConfig(snapshot.text) : undefined, verifiedPlugins });
  } catch { throw new Error("Extension source discovery unavailable"); }
}
