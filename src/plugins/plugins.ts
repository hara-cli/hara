// Plugins — a distribution unit that drops skills / roles / MCP servers onto disk; it owns nothing at
// runtime. The existing loaders pick the contents up (skillsDirs/loadRoles append the resolvers below;
// index.ts merges pluginMcpServers into the MCP set). Manifest is Claude-Code-compatible: we read
// .claude-plugin/plugin.json, .hara-plugin/plugin.json, or a bare plugin.json at the plugin root.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync, cpSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { readRawConfig } from "../config.js";
import type { McpServerConfig } from "../config.js";

export interface PluginManifest {
  name: string;
  version?: string;
  description?: string;
  skills?: string[]; // dirs (each holds <name>/SKILL.md), relative to the plugin root
  agents?: string[]; // dirs of role/subagent *.md, relative to the plugin root
  mcpServers?: Record<string, McpServerConfig>;
  hooks?: unknown; // S4
}
export interface Plugin {
  name: string;
  version: string;
  root: string;
  manifest: PluginManifest;
}

export function pluginsDir(): string {
  return join(homedir(), ".hara", "plugins");
}

const MANIFEST_PATHS = [".claude-plugin/plugin.json", ".hara-plugin/plugin.json", "plugin.json"];
function readManifest(root: string): PluginManifest | null {
  for (const rel of MANIFEST_PATHS) {
    const p = join(root, rel);
    if (!existsSync(p)) continue;
    try {
      return JSON.parse(readFileSync(p, "utf8")) as PluginManifest;
    } catch {
      return null;
    }
  }
  return null;
}

/** Every installed plugin under ~/.hara/plugins (regardless of enabled state). */
export function listInstalled(): Plugin[] {
  const dir = pluginsDir();
  if (!existsSync(dir)) return [];
  const out: Plugin[] = [];
  for (const entry of readdirSync(dir)) {
    const root = join(dir, entry);
    const manifest = readManifest(root);
    if (!manifest) continue;
    out.push({ name: manifest.name || entry, version: manifest.version || "0.0.0", root, manifest });
  }
  return out;
}

/** A plugin is active unless explicitly disabled in config (`plugins.enabled[name] === false`). */
export function enabledPlugins(): Plugin[] {
  const enabled = (readRawConfig().plugins?.enabled ?? {}) as Record<string, boolean>;
  return listInstalled().filter((p) => enabled[p.name] !== false);
}

function resolveDirs(p: Plugin, entries: string[] | undefined): string[] {
  return (entries ?? [])
    .map((e) => (isAbsolute(e) ? e : resolve(p.root, e)))
    .filter((d) => existsSync(d));
}

// --- Contribution resolvers (consumed by the existing loaders; lowest precedence) ---
/** Skill search dirs from enabled plugins (each holds <name>/SKILL.md subdirs). */
export function pluginSkillDirs(): string[] {
  return enabledPlugins().flatMap((p) => resolveDirs(p, p.manifest.skills));
}
/** Role/subagent dirs from enabled plugins. */
export function pluginRoleDirs(): string[] {
  return enabledPlugins().flatMap((p) => resolveDirs(p, p.manifest.agents));
}
/** MCP servers contributed by enabled plugins (merged under user config, which wins). */
export function pluginMcpServers(): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const p of enabledPlugins()) Object.assign(out, p.manifest.mcpServers ?? {});
  return out;
}

/** Install a plugin from `file:<path>`, `github:<owner/repo>`, or `git:<url>` into ~/.hara/plugins/<name>. */
export function installPlugin(source: string): Plugin {
  mkdirSync(pluginsDir(), { recursive: true });
  const tmpName = `_install-${process.pid}-${Date.now()}`;
  const tmp = join(pluginsDir(), tmpName);
  rmSync(tmp, { recursive: true, force: true });
  try {
    if (source.startsWith("file:")) {
      const src = resolve(source.slice("file:".length));
      if (!existsSync(src)) throw new Error(`no such path: ${src}`);
      cpSync(src, tmp, { recursive: true });
    } else if (source.startsWith("github:")) {
      execFileSync("git", ["clone", "--depth", "1", `https://github.com/${source.slice("github:".length)}.git`, tmp], { stdio: "ignore" });
    } else if (source.startsWith("git:")) {
      execFileSync("git", ["clone", "--depth", "1", source.slice("git:".length), tmp], { stdio: "ignore" });
    } else {
      throw new Error("source must be file:<path>, github:<owner/repo>, or git:<url>");
    }
    const manifest = readManifest(tmp);
    if (!manifest || !manifest.name) {
      rmSync(tmp, { recursive: true, force: true });
      throw new Error("no valid plugin.json (need at least a name) at the source root");
    }
    const dest = join(pluginsDir(), manifest.name);
    rmSync(dest, { recursive: true, force: true });
    // move tmp → dest (rename within the same dir)
    cpSync(tmp, dest, { recursive: true });
    rmSync(tmp, { recursive: true, force: true });
    return { name: manifest.name, version: manifest.version || "0.0.0", root: dest, manifest };
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}

export function uninstallPlugin(name: string): boolean {
  const dest = join(pluginsDir(), name);
  if (!existsSync(dest)) return false;
  rmSync(dest, { recursive: true, force: true });
  return true;
}

/** Persist a plugin's enabled flag in ~/.hara/config.json (`plugins.enabled[name]`). */
export function setPluginEnabled(name: string, on: boolean): void {
  const p = join(homedir(), ".hara", "config.json");
  const cfg = readRawConfig();
  const plugins = (cfg.plugins && typeof cfg.plugins === "object" ? cfg.plugins : {}) as Record<string, any>;
  plugins.enabled = { ...(plugins.enabled ?? {}), [name]: on };
  cfg.plugins = plugins;
  mkdirSync(join(homedir(), ".hara"), { recursive: true });
  writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n", "utf8");
}
