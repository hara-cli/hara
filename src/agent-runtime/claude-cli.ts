import type { NormalizedNativeRuntimeEvent } from "./execution-policy.js";

/** Per-child settings only: host login remains in the original HOME and securityd ACL. */
export function claudeRuntimeEnvironment(input: NodeJS.ProcessEnv, privateTempRoot?: string): NodeJS.ProcessEnv {
  const env = { ...input };
  // An ambient plugin-dir override must not bypass the settings-source boundary.
  delete env.CLAUDE_CODE_PLUGIN_DIRS;
  env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = "1";
  env.CLAUDE_CODE_DISABLE_AGENT_VIEW = "1";
  env.CLAUDE_CODE_DISABLE_CRON = "1";
  if (privateTempRoot) env.CLAUDE_CODE_TMPDIR = privateTempRoot;
  return env;
}

interface ClaudeOutput { ok: boolean; text: string; error?: string }
/** Native protocol observations are never proof of writes; Host snapshot verification owns that. */
export function parseClaudeCliOutput(output: string,
  observe?: (event: NormalizedNativeRuntimeEvent) => void): ClaudeOutput {
  const failed = (error = "Claude native output did not contain a successful terminal result"): ClaudeOutput => ({ ok: false, text: "", error });
  if (Buffer.byteLength(output) > 2 * 1024 * 1024) return failed();
  let terminal = false, text = "", frames = 0;
  const calls = new Map<string, NormalizedNativeRuntimeEvent>();
  for (const line of output.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    if (++frames > 4096 || Buffer.byteLength(line) > 1024 * 1024 || terminal) return failed();
    let frame: any;
    try { frame = JSON.parse(line); } catch { return failed(); }
    if (!frame || typeof frame !== "object" || Array.isArray(frame) || typeof frame.type !== "string") return failed();
    if (frame.type === "assistant" && frame.error) return failed(JSON.stringify(frame.error).slice(0, 65536));
    if (frame.type === "result") {
      if (frame.subtype !== "success" || frame.is_error !== false || typeof frame.result !== "string") {
        return failed(JSON.stringify(frame.errors ?? frame.result ?? frame.subtype ?? "runtime_failed").slice(0, 65536));
      }
      terminal = true; text = frame.result;
    } else if (frame.type === "error") return failed();
    else if (frame.type === "assistant" && Array.isArray(frame.message?.content)) {
      for (const block of frame.message.content) {
        if (block?.type !== "tool_use" || typeof block.id !== "string" || block.id.length > 200 || typeof block.name !== "string"
          || !block.input || typeof block.input !== "object" || Array.isArray(block.input) || calls.size >= 1024 || calls.has(block.id)) continue;
        let event: NormalizedNativeRuntimeEvent | undefined;
        if (block.name === "Bash" && typeof block.input.command === "string") event = {
          type: "command", status: "started", id: block.id, command: block.input.command.slice(0, 65536) };
        if (["Read", "Write", "Edit", "MultiEdit", "Delete"].includes(block.name) && typeof block.input.file_path === "string") event = {
          type: "file", status: "started", id: block.id, path: block.input.file_path.slice(0, 4096),
          operation: block.name === "Read" ? "read" : block.name === "Delete" ? "delete" : "write" };
        if (event) { calls.set(block.id, event); observe?.(event); }
      }
    } else if (frame.type === "user" && Array.isArray(frame.message?.content)) {
      for (const block of frame.message.content) {
        const event = block?.type === "tool_result" ? calls.get(block.tool_use_id) : undefined;
        if (event) { observe?.({ ...event, status: block.is_error ? "failed" : "completed" }); calls.delete(block.tool_use_id); }
      }
    }
  }
  return terminal ? { ok: true, text } : failed();
}
