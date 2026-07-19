import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { McpServerConfig } from "../config.js";
import type { HookEntry, HooksConfig } from "../hooks.js";
import { sensitiveFileReason } from "../security/sensitive-files.js";

export interface PanelSpec {
  id: string;
  title: string;
  command: string;
  args?: string[];
  port?: number;
  detect?: string[];
}

export interface PluginManifest {
  name: string;
  version?: string;
  description?: string;
  skills?: string[];
  agents?: string[];
  mcpServers?: Record<string, McpServerConfig>;
  hooks?: HooksConfig;
  bin?: Record<string, string>;
  panels?: PanelSpec[];
}

export interface VerifiedPluginManifest {
  manifest: PluginManifest;
  path: string;
  sha256: string;
}

const MANIFEST_PATHS = [".claude-plugin/plugin.json", ".hara-plugin/plugin.json", "plugin.json"];
const TOP_LEVEL_KEYS = new Set(["name", "version", "description", "skills", "agents", "mcpServers", "hooks", "bin", "panels"]);
const MCP_KEYS = new Set(["command", "args", "env"]);
const PANEL_KEYS = new Set(["id", "title", "command", "args", "port", "detect"]);
const HOOK_KEYS = new Set(["matcher", "command"]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_PLUGIN_FILES = 20_000;
const MAX_PLUGIN_BYTES = 512 * 1024 * 1024;
const MAX_ARRAY_ENTRIES = 256;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new Error(`${label} must be a plain object`);
  return value as Record<string, unknown>;
}

function knownKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`${label} contains unsupported field '${unknown[0]}'`);
}

function text(value: unknown, label: string, max = 4096): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  if (!value || value.length > max || /[\0-\x1f\x7f]/u.test(value)) {
    throw new Error(`${label} is empty, too long, or contains control characters`);
  }
  return value;
}

export function safePluginId(value: unknown, label = "plugin name"): string {
  const id = text(value, label, 64);
  if (!ID.test(id)) throw new Error(`${label} must match ${ID.source}`);
  return id;
}

export function safePluginRelativePath(value: unknown, label: string): string {
  const input = text(value, label, 512);
  const path = input.startsWith("./") ? input.slice(2) : input;
  if (
    isAbsolute(path)
    || path.includes("\\")
    || path.startsWith("~")
    || /^[A-Za-z]:/u.test(path)
    || path.startsWith("//")
  ) throw new Error(`${label} must be a portable relative path`);
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || /[\0-\x1f\x7f]/u.test(part))) {
    throw new Error(`${label} must not contain empty, current, parent, or control-character components`);
  }
  return parts.join("/");
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function verifiedPluginPath(root: string, rel: string, kind: "file" | "directory", label: string): string {
  const safe = safePluginRelativePath(rel, label);
  const canonicalRoot = realpathSync.native(resolve(root));
  let current = canonicalRoot;
  const parts = safe.split("/");
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]);
    const info = lstatSync(current);
    if (info.isSymbolicLink()) throw new Error(`${label} contains a symbolic-link component`);
    if (index < parts.length - 1 && !info.isDirectory()) throw new Error(`${label} crosses a non-directory component`);
  }
  const info = lstatSync(current);
  if (kind === "file" && (!info.isFile() || info.nlink !== 1)) throw new Error(`${label} must be a single-link regular file`);
  if (kind === "directory" && !info.isDirectory()) throw new Error(`${label} must be a directory`);
  const canonical = realpathSync.native(current);
  if (!inside(canonicalRoot, canonical)) throw new Error(`${label} escapes the immutable plugin root`);
  return canonical;
}

function stringArray(value: unknown, label: string, pathValues = false): string[] {
  if (!Array.isArray(value) || value.length > MAX_ARRAY_ENTRIES) throw new Error(`${label} must be a bounded array`);
  return value.map((entry, index) => pathValues
    ? safePluginRelativePath(entry, `${label}[${index}]`)
    : text(entry, `${label}[${index}]`));
}

function validateHooks(value: unknown): HooksConfig {
  const raw = record(value, "plugin hooks");
  knownKeys(raw, new Set(["PreToolUse", "PostToolUse"]), "plugin hooks");
  const out: HooksConfig = {};
  for (const event of ["PreToolUse", "PostToolUse"] as const) {
    if (raw[event] === undefined) continue;
    if (!Array.isArray(raw[event]) || raw[event]!.length > 64) throw new Error(`plugin hooks.${event} must be a bounded array`);
    out[event] = raw[event]!.map((entry, index) => {
      const item = record(entry, `plugin hooks.${event}[${index}]`);
      knownKeys(item, HOOK_KEYS, `plugin hooks.${event}[${index}]`);
      const hook: HookEntry = { command: text(item.command, `plugin hooks.${event}[${index}].command`, 16_384) };
      if (item.matcher !== undefined) hook.matcher = text(item.matcher, `plugin hooks.${event}[${index}].matcher`, 1024);
      return hook;
    });
  }
  return out;
}

function validateMcpServers(value: unknown): Record<string, McpServerConfig> {
  const raw = record(value, "plugin mcpServers");
  if (Object.keys(raw).length > 64) throw new Error("plugin mcpServers has too many entries");
  const out: Record<string, McpServerConfig> = {};
  for (const [rawName, rawConfig] of Object.entries(raw)) {
    const name = safePluginId(rawName, "MCP server id");
    const item = record(rawConfig, `MCP server '${name}'`);
    knownKeys(item, MCP_KEYS, `MCP server '${name}'`);
    const command = text(item.command, `MCP server '${name}' command`, 512);
    if (/\s/u.test(command)) throw new Error(`MCP server '${name}' command must be one executable, not a shell command`);
    const config: McpServerConfig = { command };
    if (item.args !== undefined) config.args = stringArray(item.args, `MCP server '${name}' args`);
    if (item.env !== undefined) {
      const env = record(item.env, `MCP server '${name}' env`);
      if (Object.keys(env).length > 128) throw new Error(`MCP server '${name}' env has too many entries`);
      config.env = {};
      for (const [key, rawValue] of Object.entries(env)) {
        if (!ENV_KEY.test(key)) throw new Error(`MCP server '${name}' env key '${key}' is invalid`);
        config.env[key] = text(rawValue, `MCP server '${name}' env '${key}'`, 65_536);
      }
    }
    out[name] = config;
  }
  return out;
}

function validateManifest(value: unknown, root: string): PluginManifest {
  const raw = record(value, "plugin manifest");
  knownKeys(raw, TOP_LEVEL_KEYS, "plugin manifest");
  const manifest: PluginManifest = { name: safePluginId(raw.name) };
  if (raw.version !== undefined) manifest.version = text(raw.version, "plugin version", 128);
  if (raw.description !== undefined) manifest.description = text(raw.description, "plugin description", 4096);

  for (const field of ["skills", "agents"] as const) {
    if (raw[field] === undefined) continue;
    const paths = stringArray(raw[field], `plugin ${field}`, true);
    for (let index = 0; index < paths.length; index++) {
      verifiedPluginPath(root, paths[index], "directory", `plugin ${field}[${index}]`);
    }
    manifest[field] = paths;
  }

  if (raw.bin !== undefined) {
    const bins = record(raw.bin, "plugin bin");
    if (Object.keys(bins).length > 128) throw new Error("plugin bin has too many entries");
    manifest.bin = {};
    for (const [rawName, rawPath] of Object.entries(bins)) {
      const name = safePluginId(rawName, "plugin command name");
      const rel = safePluginRelativePath(rawPath, `plugin bin '${name}'`);
      verifiedPluginPath(root, rel, "file", `plugin bin '${name}'`);
      manifest.bin[name] = rel;
    }
  }

  if (raw.mcpServers !== undefined) manifest.mcpServers = validateMcpServers(raw.mcpServers);
  if (raw.hooks !== undefined) manifest.hooks = validateHooks(raw.hooks);

  if (raw.panels !== undefined) {
    if (!Array.isArray(raw.panels) || raw.panels.length > 64) throw new Error("plugin panels must be a bounded array");
    manifest.panels = raw.panels.map((entry, index) => {
      const item = record(entry, `plugin panels[${index}]`);
      knownKeys(item, PANEL_KEYS, `plugin panels[${index}]`);
      const command = safePluginId(item.command, `plugin panels[${index}].command`);
      if (!manifest.bin?.[command]) {
        throw new Error(`plugin panels[${index}].command must reference a declared plugin bin`);
      }
      const panel: PanelSpec = {
        id: safePluginId(item.id, `plugin panels[${index}].id`),
        title: text(item.title, `plugin panels[${index}].title`, 256),
        command,
      };
      if (item.args !== undefined) panel.args = stringArray(item.args, `plugin panels[${index}].args`);
      if (item.detect !== undefined) panel.detect = stringArray(item.detect, `plugin panels[${index}].detect`, true);
      if (item.port !== undefined) {
        if (!Number.isInteger(item.port) || Number(item.port) < 1 || Number(item.port) > 65_535) {
          throw new Error(`plugin panels[${index}].port must be an integer from 1 to 65535`);
        }
        panel.port = Number(item.port);
      }
      return panel;
    });
  }
  // Validation must fail during staging, not only when a later session starts the server. This also catches
  // `node server.mjs`-style relative entry scripts whose process cwd used to be the user's current project.
  if (manifest.mcpServers) bindPluginMcpServers(root, manifest);
  return manifest;
}

export function verifyPluginTree(root: string): void {
  const canonicalRoot = realpathSync.native(resolve(root));
  const rootInfo = lstatSync(canonicalRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("plugin root must be a real directory");
  const rootDevice = String(rootInfo.dev);
  let files = 0;
  let bytes = 0;
  const stack = [canonicalRoot];
  while (stack.length) {
    const directory = stack.pop()!;
    for (const name of readdirSync(directory)) {
      files++;
      if (files > MAX_PLUGIN_FILES) throw new Error(`plugin contains more than ${MAX_PLUGIN_FILES} filesystem entries`);
      const path = join(directory, name);
      const info = lstatSync(path);
      if (info.isSymbolicLink()) throw new Error(`plugin packages must not contain symbolic links: '${relative(canonicalRoot, path)}'`);
      if (String(info.dev) !== rootDevice) {
        throw new Error(`plugin packages must not cross filesystem boundaries: '${relative(canonicalRoot, path)}'`);
      }
      if (info.isDirectory()) {
        stack.push(path);
        continue;
      }
      if (!info.isFile() || info.nlink !== 1) {
        throw new Error(`plugin packages may contain only directories and single-link regular files: '${relative(canonicalRoot, path)}'`);
      }
      const protectedReason = sensitiveFileReason(path);
      if (protectedReason) throw new Error(`plugin package contains protected ${protectedReason}: '${relative(canonicalRoot, path)}'`);
      bytes += info.size;
      if (bytes > MAX_PLUGIN_BYTES) throw new Error(`plugin exceeds the ${MAX_PLUGIN_BYTES}-byte unpacked limit`);
    }
  }
}

export function readVerifiedPluginManifest(
  root: string,
  options: { scanTree?: boolean } = {},
): VerifiedPluginManifest {
  if (options.scanTree !== false) verifyPluginTree(root);
  else {
    const info = lstatSync(realpathSync.native(resolve(root)));
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("plugin root must be a real directory");
  }
  const present: string[] = [];
  for (const rel of MANIFEST_PATHS) {
    try {
      present.push(verifiedPluginPath(root, rel, "file", "plugin manifest"));
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  if (!present.length) throw new Error("no supported plugin.json at the source root");
  if (present.length > 1) throw new Error("plugin package contains multiple ambiguous manifests");
  const path = present[0];
  const info = lstatSync(path);
  if (info.size > MAX_MANIFEST_BYTES) throw new Error("plugin manifest is too large");
  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("plugin manifest is not valid JSON");
  }
  return {
    manifest: validateManifest(parsed, root),
    path,
    sha256: createHash("sha256").update(raw).digest("hex"),
  };
}

function pathLikeCommand(command: string): boolean {
  return command.startsWith(".") || command.includes("/") || command.includes("\\") || isAbsolute(command) || /^[A-Za-z]:/u.test(command);
}

/** Bind every plugin-owned MCP process to the installed package root. Bare PATH executables remain
 * allowed, but relative executables and conventional runtime entry scripts become verified absolute files. */
export function bindPluginMcpServers(root: string, manifest: PluginManifest): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const [name, input] of Object.entries(manifest.mcpServers ?? {})) {
    let command = input.command;
    const args = [...(input.args ?? [])];
    if (pathLikeCommand(command)) {
      command = verifiedPluginPath(
        root,
        safePluginRelativePath(command, `MCP server '${name}' command`),
        "file",
        `MCP server '${name}' command`,
      );
    } else {
      const runtime = command.toLowerCase().replace(/\.exe$/u, "");
      if (["node", "bun", "deno", "python", "python3", "pythonw"].includes(runtime)) {
        const scriptIndex = args.findIndex((arg) => !arg.startsWith("-") && /\.(?:[cm]?js|ts|py)$/iu.test(arg));
        if (scriptIndex >= 0) {
          args[scriptIndex] = verifiedPluginPath(
            root,
            safePluginRelativePath(args[scriptIndex], `MCP server '${name}' entry script`),
            "file",
            `MCP server '${name}' entry script`,
          );
        }
      }
    }
    out[name] = {
      command,
      ...(args.length ? { args } : {}),
      ...(input.env ? { env: { ...input.env } } : {}),
      cwd: realpathSync.native(resolve(root)),
    };
  }
  return out;
}
