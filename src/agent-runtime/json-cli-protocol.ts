// Hara-owned adapters for documented Gemini stream events and Kimi CLI print messages.
// Native tool events are observations, never Hara tool calls, grants or completion receipts.
import { writeFileSync } from "node:fs";
import { runtimeErrorFirstLine } from "../security/runtime-error.js";
import { redactSensitiveText } from "../security/secrets.js";
import type { NormalizedNativeRuntimeEvent } from "./execution-policy.js";
import { join } from "node:path";
import type { TurnResult } from "../providers/types.js";
import { classifyRuntimeFailure, type RuntimeFailureKind } from "./failure-diagnostics.js";
import { WORKSPACE_MCP_TOKEN_ENV, type WorkspaceMcpEndpoint } from "./registered-cli-mcp.js";

export type JsonCliRuntimeId = "gemini" | "kimi";
export interface JsonCliEvent { kind: "text" | "tool" | "completed" | "error"; text?: string; tool?: string }
export interface JsonCliResult { turn: TurnResult; events: JsonCliEvent[]; failure?: RuntimeFailureKind; errorFirstLine?: string }
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const callId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_.:/-]{1,200}$/u.test(value);
const toolName = (value: unknown): string | undefined => typeof value === "string" && /^[A-Za-z][A-Za-z0-9_.:/-]{0,119}$/.test(value) ? value : undefined;
const invalid = (events: JsonCliEvent[], failure: RuntimeFailureKind = "version_incompatible", errorFirstLine?: string): JsonCliResult => ({
  turn: { text: "", toolUses: [], stop: "error", errorMsg: failure }, events: [...events.slice(0, 2047).map(event => ({ kind: event.kind, ...(event.tool ? { tool: event.tool } : {}) })), { kind: "error" }], failure, ...(errorFirstLine ? { errorFirstLine } : {}),
});
function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  return Array.isArray(value) ? value.filter(part => object(part) && part.type === "text" && typeof part.text === "string").map(part => part.text).join("") : "";
}
/** Bounded, terminal-aware parsing. Unknown/malformed output cannot record a successful version.
 * Kimi print has no TurnEnd frame: success requires exit zero (checked by caller) and a final
 * assistant message with text and no outstanding native tool call. */
export function normalizeJsonCliOutput(runtime: JsonCliRuntimeId, output: string, diagnosticEnv?: NodeJS.ProcessEnv): JsonCliResult {
  const events: JsonCliEvent[] = []; let text = "", completed = false, finalAssistant = false;
  const pendingCalls = new Set<string>();
  let usage: TurnResult["usage"], warning: RuntimeFailureKind | undefined, firstErrorLine: string | undefined;
  // Only trusted Host opt-in projects a documented message field. Never serialize error.data,
  // arbitrary JSON frames or later lines into diagnostics.
  const errorLine = (value: Record<string, any>) => diagnosticEnv ? runtimeErrorFirstLine(
    object(value.error) ? value.error.message : typeof value.error === "string" ? value.error : value.message, diagnosticEnv) : undefined;
  if (!output.trim() || Buffer.byteLength(output) > 4 * 1024 * 1024) return invalid(events);
  const lines = output.split(/\r?\n/u).filter(line => line.trim());
  if (lines.length > 8192) return invalid(events);
  for (const line of lines) {
    if (Buffer.byteLength(line) > 1024 * 1024) return invalid(events);
    let value: Record<string, any>;
    try { const parsed = JSON.parse(line); if (!object(parsed)) return invalid(events); value = parsed; }
    catch { return invalid(events); }
    if (events.length >= 2048) return invalid(events);
    if (runtime === "gemini") {
      if (value.type === "message" && value.role === "assistant" && typeof value.content === "string") {
        if (completed) return invalid(events);
        text = value.delta === true ? text + value.content : value.content;
        events.push({ kind: "text", text: value.content });
      } else if (value.type === "tool_use") {
        if (completed || !callId(value.tool_id) || pendingCalls.has(value.tool_id)) return invalid(events);
        pendingCalls.add(value.tool_id);
        events.push({ kind: "tool", ...(toolName(value.tool_name ?? value.name) ? { tool: toolName(value.tool_name ?? value.name) } : {}) });
      } else if (value.type === "tool_result") {
        if (completed || !callId(value.tool_id) || !pendingCalls.delete(value.tool_id) || !["success", "error"].includes(value.status)) return invalid(events);
      } else if (value.type === "error") {
        warning = classifyRuntimeFailure({ stderr: JSON.stringify(value.error ?? value.message ?? value).slice(0, 64 * 1024) });
        firstErrorLine ??= errorLine(value); events.push({ kind: "error" });
        if (completed) return invalid(events, warning, firstErrorLine);
      } else if (value.type === "result") {
        if (completed || pendingCalls.size || value.status !== "success") return invalid(events, warning ?? classifyRuntimeFailure({ stderr: JSON.stringify(value.error ?? {}).slice(0, 64 * 1024) }), firstErrorLine ?? errorLine(value));
        completed = true;
        const stats = value.stats;
        if (object(stats) && count(stats.input_tokens) && count(stats.output_tokens)) usage = { input: stats.input_tokens, output: stats.output_tokens,
          ...(count(stats.cached_input_tokens) ? { cachedInput: stats.cached_input_tokens } : {}) };
        events.push({ kind: "completed" });
      }
    } else {
      if (value.error !== undefined || value.type === "error") return invalid(events, classifyRuntimeFailure({ stderr: JSON.stringify(value.error ?? value).slice(0, 64 * 1024) }), errorLine(value));
      if (value.role === "assistant") {
        const content = textContent(value.content), calls = Array.isArray(value.tool_calls) ? value.tool_calls : [];
        for (const call of calls) {
          if (events.length >= 2048 || !callId(call?.id) || pendingCalls.has(call.id)) return invalid(events);
          pendingCalls.add(call.id); events.push({ kind: "tool", ...(toolName(call?.function?.name) ? { tool: toolName(call.function.name) } : {}) });
        }
        if (content) { text = content; events.push({ kind: "text", text: content }); }
        finalAssistant = Boolean(content) && calls.length === 0 && pendingCalls.size === 0;
      } else if (value.role === "tool") {
        if (!callId(value.tool_call_id) || !pendingCalls.delete(value.tool_call_id)) return invalid(events);
        finalAssistant = false; // A tool result alone cannot complete an assistant turn.
      }
    }
    if (text.length > 512 * 1024) return invalid(events);
  }
  if (runtime === "kimi") { completed = finalAssistant; if (completed) events.push({ kind: "completed" }); }
  if (!completed || !text.trim()) return invalid(events, warning ?? "runtime_failed", firstErrorLine);
  return { turn: { text, toolUses: [], stop: "end", ...(usage ? { usage } : {}) }, events };
}

// Explicit built-in allowlist excludes cross-task scheduling and unknown additions. Native shell
// is scoped to this attempt by the shared ownership/drain boundary; Hara owns durable scheduling.
export const GEMINI_NATIVE_TOOLS = Object.freeze(["read_file", "list_directory", "glob", "grep_search", "replace", "write_file", "web_fetch", "google_web_search", "run_shell_command"]);
const safeNativeString = (value: unknown, max: number): string | undefined => typeof value === "string" && value.length <= max
  && !/[\u0000-\u001f\u007f]/u.test(value) ? redactSensitiveText(value).text : undefined;
function nativeCall(value: Record<string, any>, name: unknown, id: unknown): NormalizedNativeRuntimeEvent {
  const operation = toolName(name) ?? "native-tool", path = safeNativeString(value.file_path ?? value.path ?? value.absolute_path, 4096);
  const command = safeNativeString(value.command, 4096), eventId = safeNativeString(id, 120);
  return { type: command ? "command" : path ? "file" : "tool", status: "started", operation,
    ...(eventId ? { id: eventId } : {}), ...(path ? { path } : {}), ...(command ? { command } : {}) };
}
/** Observations reach the shared policy while the CLI is running, including failed runs. No tool
 * arguments or output are persisted as receipts. This is observation, never a pre-execution grant. */
export function createJsonCliNativeObserver(runtime: JsonCliRuntimeId, observe: (event: NormalizedNativeRuntimeEvent) => void) {
  let pending = "", bytes = 0, seen = 0, stopped = false;
  const emit = (event: NormalizedNativeRuntimeEvent) => { if (seen++ < 1024) observe(event); };
  const line = (text: string) => {
    let value; try { value = JSON.parse(text); } catch { return; }
    if (!object(value)) return;
    if (runtime === "gemini") {
      if (value.type === "tool_use") emit(nativeCall(object(value.parameters) ? value.parameters : {}, value.tool_name ?? value.name, value.tool_id));
      else if (value.type === "tool_result") emit({ type: "tool", status: value.status === "error" ? "failed" : "completed",
        ...(safeNativeString(value.tool_id, 120) ? { id: safeNativeString(value.tool_id, 120) } : {}) });
    } else if (value.role === "assistant" && Array.isArray(value.tool_calls)) {
      for (const call of value.tool_calls.slice(0, 1024)) {
        let args = call?.function?.arguments;
        if (typeof args === "string" && args.length <= 64 * 1024) { try { args = JSON.parse(args); } catch { args = {}; } }
        emit(nativeCall(object(args) ? args : {}, call?.function?.name, call?.id));
      }
    } else if (runtime === "kimi" && value.role === "tool") emit({ type: "tool", status: value.is_error === true ? "failed" : "completed",
      ...(safeNativeString(value.tool_call_id, 120) ? { id: safeNativeString(value.tool_call_id, 120) } : {}) });
  };
  return { onStdout(chunk: string) {
    if (stopped) return;
    bytes += Buffer.byteLength(chunk); if (bytes > 4 * 1024 * 1024) { stopped = true; pending = ""; return; }
    pending += chunk;
    let newline: number;
    while ((newline = pending.indexOf("\n")) >= 0) { const row = pending.slice(0, newline); pending = pending.slice(newline + 1); if (Buffer.byteLength(row) <= 1024 * 1024) line(row); }
    if (Buffer.byteLength(pending) > 1024 * 1024) { stopped = true; pending = ""; }
  }, finish() { if (!stopped && pending.trim()) line(pending); pending = ""; stopped = true; } };
}

export function jsonCliRequiredFlags(runtime: JsonCliRuntimeId): string[] {
  return runtime === "gemini" ? ["--yolo", "--output-format", "--allowed-mcp-server-names", "--extensions", "--prompt"] : ["--prompt", "--output-format", "--auto", "--plan"];
}
export function jsonCliHelpCompatible(runtime: JsonCliRuntimeId, help: string): boolean {
  return help.length <= 256 * 1024 && (runtime !== "kimi" || /(?:^|\n)\s*acp(?:\s|$)/.test(help)) && jsonCliRequiredFlags(runtime).every(flag => new RegExp(`(?:^|[\\s,])${flag}(?=[\\s,=]|$)`, "m").test(help));
}

/** `directory` is an exclusive, mode-0700 attempt directory created by trusted Host composition.
 * No user's settings, trust database, MCP file or credential is read/copied/updated. */
export function writeJsonCliMcp(runtime: JsonCliRuntimeId, endpoint: WorkspaceMcpEndpoint, directory: string, timeoutMs: number) {
  const path = join(directory, runtime === "gemini" ? "gemini-settings.json" : "kimi-mcp.json");
  const token = endpoint.env[WORKSPACE_MCP_TOKEN_ENV];
  if (!token || !/^[a-f0-9]{64}$/.test(token)) throw new Error("Invalid Workspace MCP attempt token");
  const server = { ...(runtime === "gemini" ? { httpUrl: endpoint.url, trust: true, timeout: timeoutMs } : { url: endpoint.url }),
    headers: { Authorization: runtime === "gemini" ? "Bearer ${" + WORKSPACE_MCP_TOKEN_ENV + "}" : "Bearer " + token } };
  const config = runtime === "gemini" ? { mcpServers: { hara: server }, mcp: { allowed: ["hara"], serverCommand: "" },
    telemetry: { enabled: false, logPrompts: false },
    hooksConfig: { enabled: false }, skills: { enabled: false },
    tools: { core: [...GEMINI_NATIVE_TOOLS], discoveryCommand: "", callCommand: "", sandbox: false },
    advanced: { ignoreLocalEnv: true } }
    : { mcpServers: { hara: server } };
  const contents = JSON.stringify(config) + "\n";
  writeFileSync(path, contents, { mode: 0o600, flag: "wx" });
  return { path, contents, env: runtime === "gemini" ? {
    GEMINI_CLI_TRUSTED_FOLDERS_PATH: join(directory, "trusted-folders.json"), GEMINI_CLI_TRUST_WORKSPACE: "true" } : {} };
}
export function jsonCliArgs(input: { runtime: JsonCliRuntimeId; prompt: string; cwd: string; model: string | null; mcpPath: string; tier?: "full-protected" | "controlled" }): string[] {
  const model = input.model && input.model !== "default" ? ["--model", input.model] : [];
  return input.runtime === "gemini" ? ["--output-format", "stream-json", ...(input.tier === "controlled" ? ["--approval-mode", "plan"] : ["--yolo"]), "--allowed-mcp-server-names", "hara", "--extensions", "none", ...model, "--prompt", input.prompt]
    : ["acp"];
}
