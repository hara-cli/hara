import { parseClaudeCliOutput } from "./claude-cli.js";
/** Extra eligibility for observational success history; never changes execution authority.
 * Codex partial output or exit zero cannot establish a completed protocol turn. */
export function runtimeUseProtocolSucceeded(runtime: "codex" | "claude", output: string): boolean {
  if (!output.trim() || Buffer.byteLength(output) > 2 * 1024 * 1024) return false;
  if (runtime === "claude") { const result = parseClaudeCliOutput(output); return result.ok && Boolean(result.text.trim()); }
  let completed = false, frames = 0;
  for (const line of output.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    if (++frames > 4096 || Buffer.byteLength(line) > 1024 * 1024) return false;
    let frame: any; try { frame = JSON.parse(line); } catch { return false; }
    if (!frame || typeof frame !== "object" || Array.isArray(frame) || typeof frame.type !== "string") return false;
    if (frame.type === "error" || frame.type === "turn.failed" || frame.item?.type === "error") completed = false;
    if (frame.type === "turn.completed") completed = true;
  }
  return completed;
}
