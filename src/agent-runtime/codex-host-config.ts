import { readFileSync, lstatSync } from "node:fs";
import { dirname, join } from "node:path";

/** Read configuration names only. Never copy auth or settings into an isolated login HOME.
 * Unknown MCP table syntax fails closed instead of silently loading a global integration. */
export function codexHostToolOverrides(home: string, runtimeHome = join(home, ".codex"), cwd?: string, reservedName?: string): string[] {
  const files = new Set([join(runtimeHome, "config.toml")]);
  if (cwd) for (let p = cwd;; p = dirname(p)) { files.add(join(p, ".codex", "config.toml")); if (dirname(p) === p) break; }
  const names = new Set<string>();
  for (const config of files) {
    let source: string;
    try {
      const stat = lstatSync(config);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error("Unsupported Codex integration config");
      source = readFileSync(config, "utf8");
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw new Error("Cannot safely isolate Codex integrations"); }
    for (const line of source.split(/\r?\n/u)) {
      const value = line.trim();
      if (!value || value.startsWith("#")) continue;
      if (/^(?:[A-Za-z0-9_-]+\.)?mcp_servers\s*=/u.test(value)) throw new Error("Inline Codex MCP tables require explicit supported isolation");
      if (!value.startsWith("[") || !value.includes("mcp_servers")) continue;
      const section = /^\[(?:profiles\.[A-Za-z0-9_-]+\.)?mcp_servers\.([A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')(?:\.[A-Za-z0-9_-]+)*\]\s*(?:#.*)?$/u.exec(value);
      if (!section) throw new Error("Unsupported Codex MCP table syntax; global integrations were not loaded");
      const key = section[1]!;
      let name: string;
      try { name = key.startsWith('"') ? JSON.parse(key) : key.startsWith("'") ? key.slice(1, -1) : key; } catch { throw new Error("Unsupported Codex MCP name"); }
      if (!name || name.length > 200 || /[\u0000-\u001f\u007f]/u.test(name)) throw new Error("Unsupported Codex MCP name");
      if (name === reservedName) throw new Error("User MCP config conflicts with the private Hara namespace");
      names.add(name);
    }
  }
  // Codex CLI overrides replace each named table rather than merging its transport. An
  // enabled=false-only table fails validation before initialize (0.163.0). Replace the
  // whole entry with a valid, inert disabled transport; never inherit its command/env/URL.
  return [...names].sort().flatMap(name => ["-c", `mcp_servers.${JSON.stringify(name)}={enabled=false,command="hara-disabled-global-mcp"}`]).concat([
    // Disable Codex's embedded-skills installer instead of granting it writes to
    // the user's global skills/.system. CLI overrides leave host files untouched.
    "-c", "skills.bundled.enabled=false",
    "-c", "features.plugins=false", "-c", "features.hooks=false", "-c", "features.codex_hooks=false",
    "-c", "hooks={}", "-c", "notify=[]", "-c", "features.multi_agent=false", "-c", "features.in_app_local_automation=false", "-c", "features.remote_control=false", "-c", "features.unified_exec=false",
  ]);
}
