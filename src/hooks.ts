// Lifecycle hooks — run user/plugin shell commands around tool calls (codex/Claude-Code parity).
// PreToolUse runs BEFORE a tool: a non-zero exit BLOCKS the call (its output becomes the denial message).
// PostToolUse runs AFTER: observe-only (format, log, notify). Configured in config.json `hooks` + contributed
// by plugins. The command receives {tool, payload} as JSON on stdin + HARA_TOOL_NAME in the env.
import { spawnSync } from "node:child_process";
import { loadConfig } from "./config.js";
import { pluginHooks } from "./plugins/plugins.js";

export type HookEvent = "PreToolUse" | "PostToolUse";
export interface HookEntry {
  matcher?: string; // regex (or literal) tested against the tool name; omit/"*" = all tools
  command: string; // shell command to run
}
export type HooksConfig = Partial<Record<HookEvent, HookEntry[]>>;

let cache: HooksConfig | null = null;
export function resetHooksCache(): void {
  cache = null;
}
function merged(): HooksConfig {
  if (cache) return cache;
  const cfg = loadConfig().hooks ?? {};
  const plg = pluginHooks();
  cache = {
    PreToolUse: [...(cfg.PreToolUse ?? []), ...(plg.PreToolUse ?? [])],
    PostToolUse: [...(cfg.PostToolUse ?? []), ...(plg.PostToolUse ?? [])],
  };
  return cache;
}
const matches = (m: string | undefined, name: string): boolean => {
  if (!m || m === "*") return true;
  try {
    return new RegExp(m).test(name);
  } catch {
    return m === name;
  }
};

/** True if any hook is configured (lets the loop skip the work entirely in the common case). */
export function hasHooks(): boolean {
  const h = merged();
  return !!(h.PreToolUse?.length || h.PostToolUse?.length);
}

/** Run hooks for an event matching `toolName`. PreToolUse: a non-zero exit BLOCKS (returns the message);
 *  PostToolUse: observe-only, never blocks. Sync (hooks are short, opt-in); 30s timeout each. */
export function runHooks(event: HookEvent, toolName: string, payload: unknown, cwd: string): { block: boolean; message: string } {
  for (const h of merged()[event] ?? []) {
    if (!matches(h.matcher, toolName)) continue;
    let r: ReturnType<typeof spawnSync>;
    try {
      r = spawnSync(h.command, {
        shell: true,
        cwd,
        input: JSON.stringify({ tool: toolName, payload }),
        encoding: "utf8",
        timeout: 30_000,
        env: { ...process.env, HARA_TOOL_NAME: toolName },
      });
    } catch {
      continue;
    }
    if (event === "PreToolUse" && r.status !== 0 && r.status !== null) {
      const msg = (String(r.stdout ?? "") + String(r.stderr ?? "")).trim();
      return { block: true, message: `⛔ blocked by a PreToolUse hook${msg ? `: ${msg}` : ` (exit ${r.status})`}` };
    }
  }
  return { block: false, message: "" };
}
