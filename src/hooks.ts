// Lifecycle hooks — run user/plugin shell commands around tool calls (codex/Claude-Code parity).
// PreToolUse runs BEFORE a tool: non-zero, timeout, signal, or launch failure BLOCKS the call.
// PostToolUse runs AFTER: observe-only (format, log, notify). Configured in config.json `hooks` + contributed
// by plugins. The command receives {tool, payload} as JSON on stdin + HARA_TOOL_NAME in the env.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { pluginHooks } from "./plugins/plugins.js";

export type HookEvent = "PreToolUse" | "PostToolUse";
export interface HookEntry {
  matcher?: string; // regex (or literal) tested against the tool name; omit/"*" = all tools
  command: string; // shell command to run
}
export type HooksConfig = Partial<Record<HookEvent, HookEntry[]>>;

const cache = new Map<string, HooksConfig>();
export function resetHooksCache(): void {
  cache.clear();
}
function merged(cwd: string): HooksConfig {
  const key = resolve(cwd);
  const cached = cache.get(key);
  if (cached) return cached;
  const cfg = loadConfig({ cwd: key }).hooks ?? {};
  const plg = pluginHooks();
  const value = {
    PreToolUse: [...(cfg.PreToolUse ?? []), ...(plg.PreToolUse ?? [])],
    PostToolUse: [...(cfg.PostToolUse ?? []), ...(plg.PostToolUse ?? [])],
  };
  cache.set(key, value);
  return value;
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
export function hasHooks(cwd = process.cwd()): boolean {
  const h = merged(cwd);
  return !!(h.PreToolUse?.length || h.PostToolUse?.length);
}

/** Run hooks for an event matching `toolName`. Any abnormal PreToolUse termination fails closed;
 *  PostToolUse remains observe-only. Sync (hooks are short, opt-in); 30s timeout each. */
export function runHooks(
  event: HookEvent,
  toolName: string,
  payload: unknown,
  cwd: string,
  timeoutMs = 30_000,
): { block: boolean; message: string } {
  for (const h of merged(cwd)[event] ?? []) {
    if (!matches(h.matcher, toolName)) continue;
    let r: ReturnType<typeof spawnSync>;
    try {
      r = spawnSync(h.command, {
        shell: true,
        cwd,
        input: JSON.stringify({ tool: toolName, payload }),
        encoding: "utf8",
        timeout: timeoutMs,
        env: { ...process.env, HARA_TOOL_NAME: toolName },
      });
    } catch (error) {
      if (event === "PreToolUse") {
        const detail = error instanceof Error ? error.message : String(error);
        return { block: true, message: `⛔ blocked because a PreToolUse hook could not start${detail ? `: ${detail}` : ""}` };
      }
      continue;
    }
    // A hook is allowed to ignore stdin. On Linux, a command that exits successfully before Node finishes
    // writing `input` can report EPIPE in r.error *alongside status=0*. The wait status is authoritative in
    // that case; true launch/write failures still have status=null, while timeouts/signals remain blocked.
    if (event === "PreToolUse" && (r.status !== 0 || !!r.signal)) {
      const output = (String(r.stdout ?? "") + String(r.stderr ?? "")).trim();
      const failure = r.error?.message || (r.signal ? `terminated by ${r.signal}` : `exit ${r.status ?? "unknown"}`);
      return { block: true, message: `⛔ blocked by a PreToolUse hook${output ? `: ${output}` : ` (${failure})`}` };
    }
  }
  return { block: false, message: "" };
}
