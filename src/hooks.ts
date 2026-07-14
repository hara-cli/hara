// Lifecycle hooks — run user/plugin shell commands around tool calls (codex/Claude-Code parity).
// PreToolUse runs BEFORE a tool: non-zero, timeout, signal, or launch failure BLOCKS the call.
// PostToolUse runs AFTER: observe-only (format, log, notify). Configured in config.json `hooks` + contributed
// by plugins. The command receives {tool, payload} as JSON on stdin + HARA_TOOL_NAME in the env.
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { pluginHooks } from "./plugins/plugins.js";
import { redactToolSubprocessOutput } from "./security/subprocess-env.js";
import { runShell } from "./sandbox.js";

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
 *  PostToolUse remains observe-only. Every child owns a cancellable process group; no hook may hold the
 *  event loop past the parent run deadline, and an aborted batch never starts its next command. */
export async function runHooks(
  event: HookEvent,
  toolName: string,
  payload: unknown,
  cwd: string,
  timeoutMs = 30_000,
  signal?: AbortSignal,
): Promise<{ block: boolean; message: string }> {
  for (const h of merged(cwd)[event] ?? []) {
    if (signal?.aborted) {
      return event === "PreToolUse"
        ? { block: true, message: "⛔ blocked because the agent run was cancelled before the PreToolUse hook completed" }
        : { block: false, message: "" };
    }
    if (!matches(h.matcher, toolName)) continue;
    try {
      // Hooks are user/plugin-configured external code. Route them through the same command preflight and
      // macOS protected-read mask as Bash, even though hooks remain observe-only after a tool has run.
      await runShell(h.command, cwd, "off", {
        signal,
        timeout: timeoutMs,
        maxBuffer: 256 * 1024,
        input: JSON.stringify({ tool: toolName, payload }),
        env: { HARA_TOOL_NAME: toolName },
      });
    } catch (error) {
      if (event === "PreToolUse") {
        const failure = error as Error & { stdout?: string; stderr?: string; code?: number };
        const output = redactToolSubprocessOutput(`${failure.stdout ?? ""}${failure.stderr ?? ""}`.trim());
        const detail = redactToolSubprocessOutput(failure.message || String(error));
        return {
          block: true,
          message: `⛔ blocked by a PreToolUse hook${output ? `: ${output}` : detail ? ` (${detail})` : ""}`,
        };
      }
      // PostToolUse is best-effort: a policy-blocked or broken observer must never rewrite the result of a
      // tool that already completed. In particular, do not retry it through an unsandboxed fallback shell.
      continue;
    }
  }
  return { block: false, message: "" };
}
