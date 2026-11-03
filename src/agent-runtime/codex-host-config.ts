import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Disable only user MCPs declared in the host config; auth and the user's config file stay intact.
 * A config shape we cannot enumerate safely keeps the prior launch behavior. */
export function codexHostToolOverrides(home: string): string[] {
  const config = join(home, ".codex", "config.toml");
  let source: string;
  try {
    if (statSync(config).size > 1024 * 1024) return [];
    source = readFileSync(config, "utf8");
  } catch { return []; }
  const names = new Set<string>();
  for (const line of source.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (/^mcp_servers\s*=/u.test(trimmed)) return [];
    if (!trimmed.startsWith("[mcp_servers.")) continue;
    const section = /^\[mcp_servers\.([A-Za-z0-9_-]+)(?:\.[A-Za-z0-9_-]+)*\]$/u.exec(trimmed);
    if (!section || section[1] === "hara") return [];
    names.add(section[1]);
  }
  return [...names].sort().flatMap(name => ["-c", `mcp_servers.${name}.enabled=false`])
    .concat(["-c", "features.plugins=false"]);
}
