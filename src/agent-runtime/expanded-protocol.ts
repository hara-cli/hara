import { classifyRuntimeFailure, type RuntimeFailureKind } from "./failure-diagnostics.js";
import { runtimeErrorFirstLine } from "../security/runtime-error.js";
import type { ExpandedRuntimeId } from "./expanded-models.js";
import type { ExternalCommandCaptureResult } from "../external-sessions/process.js";

export interface NativeToolObservation {
  name: string;
  state: "started" | "completed" | "failed";
  effect: "read" | "write" | "execute" | "unknown";
  risk?: "external-publish";
  deletionTarget?: string;
}
const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
export function nativeToolObservation(name: unknown, state: NativeToolObservation["state"], kind?: unknown, input?: unknown): NativeToolObservation {
  const safeName = typeof name === "string" && /^[a-zA-Z][a-zA-Z0-9_.:-]{0,79}$/.test(name) ? name : "native_tool";
  const text = typeof kind === "string" ? kind : safeName;
  const effect = /write|edit|create|patch|delete|remove/i.test(text) ? "write"
    : /bash|shell|exec|terminal/i.test(text) ? "execute"
    : /read|view|list|glob|grep|search/i.test(text) ? "read" : "unknown";
  let details = object(input);
  if (!details && typeof input === "string" && input.length <= 65536) try { details = object(JSON.parse(input)); } catch { /* unknown input shape */ }
  const command = typeof details?.command === "string" ? details.command.slice(0, 65536) : "";
  const risk = /\b(?:git\s+push|npm\s+publish|pnpm\s+publish|gh\s+(?:release\s+create|pr\s+merge))\b/.test(command);
  const path = details?.path ?? details?.filePath;
  const deletionTarget = /delete|remove|unlink/.test(text) && typeof path === "string" && path.length <= 4096 && !/[\r\n\0]/.test(path) ? path : undefined;
  if (isForbiddenNativeTool(safeName)) throw new Error("runtime_permission_denied");
  return { name: safeName, state, effect, ...(risk ? { risk: "external-publish" as const } : {}), ...(deletionTarget ? { deletionTarget } : {}) };
}
/** Hara Scheduler tools remain governed MCP calls. Never authorize a runtime's native scheduler,
 * wakeup or persistent background-agent tool. This is an additional refusal, not an execution
 * interception guarantee: always-approve CLIs can execute before emitting observations. */
export function isForbiddenNativeTool(name: unknown): boolean {
  if (typeof name !== "string") return false;
  if (/^(?:mcp__)?hara(?:__|[./:])/.test(name)) return false;
  const canonical = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  return /^(?:cron|schedule|wakeup|background|spawnbackground|startbackground|persistentagent)/.test(canonical)
    || canonical === "task" || canonical === "spawnagent";
}
export interface ExpandedRunResult { text: string; completed: boolean; tools: NativeToolObservation[]; failure: RuntimeFailureKind | null; errorFirstLine?: string }
/** Parse content-free tool observations separately from final response text. Exit zero alone is not success. */
export function parseExpandedRun(id: "copilot" | "cursor", result: ExternalCommandCaptureResult, env?: NodeJS.ProcessEnv): ExpandedRunResult {
  let assembled = "", deltas = "", terminal = false, failure: RuntimeFailureKind | null = null, frames = 0;
  const tools: NativeToolObservation[] = [];
  let errorFirstLine = runtimeErrorFirstLine(result.errorFirstLine, env);
  // Only documented error-message fields cross this boundary, never whole frames or RPC data.
  const observeError = (value: unknown): void => {
    const message = typeof value === "string" ? value : object(value)?.message;
    errorFirstLine ??= runtimeErrorFirstLine(message, env);
  };
  const fail = (): ExpandedRunResult => ({ text: "", completed: false, tools,
    failure: failure ?? classifyRuntimeFailure({ code: result.errorCode, timedOut: result.timedOut }),
    ...(errorFirstLine ? { errorFirstLine } : {}) });
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (Buffer.byteLength(line) > 1024 * 1024 || ++frames > 4096) return fail();
    let frame: Record<string, unknown> | null;
    try { frame = object(JSON.parse(line)); } catch { return fail(); }
    if (!frame || typeof frame.type !== "string") return fail();
    // Replayed records and subagent terminals cannot close the main attempt.
    if (frame.checkpoint === true || frame.agentId !== undefined) continue;
    const data = object(frame.data) ?? {};
    if (frame.type === "error" || frame.type === "session.error" || frame.is_error === true) {
      failure = classifyRuntimeFailure({ stderr: JSON.stringify(frame.error ?? data ?? frame).slice(0, 65_536) });
      observeError(frame.error ?? data.message ?? frame.message ?? frame.result);
      terminal = false;
    }
    if (id === "copilot") {
      if (frame.type === "assistant.turn_start") terminal = false;
      if (frame.type === "assistant.message_delta" && typeof data.deltaContent === "string") deltas += data.deltaContent;
      if (frame.type === "assistant.message" && typeof data.content === "string") assembled = data.content;
      if (frame.type === "tool.execution_start" || frame.type === "tool.execution_complete")
        tools.push(nativeToolObservation(data.toolName, frame.type.endsWith("_start") ? "started" : data.success === false ? "failed" : "completed", undefined, data.arguments));
      if (frame.type === "session.idle") {
        if (data.aborted === true) failure = "runtime_failed";
        else if (data.mode !== "autopilot") terminal = true;
      }
      if (frame.type === "result") {
        const code = frame.exitCode ?? data.exitCode;
        if (typeof code === "number" && code !== 0) { failure = "runtime_failed"; observeError(frame.error ?? data.message); }
        else terminal = true;
        if (typeof frame.result === "string") assembled = frame.result;
      }
    } else {
      if (frame.type === "assistant") {
        const message = object(frame.message);
        if (Array.isArray(message?.content)) {
          const text = message.content.map(item => object(item)).filter(item => item?.type === "text" && typeof item.text === "string").map(item => item!.text).join("");
          if (text) assembled = text;
        }
      }
      if (frame.type === "tool_call") {
        const call = object(frame.tool_call) ?? {};
        const names = Object.keys(call);
        const payload = object(call[names[0] ?? ""]);
        const name = typeof frame.name === "string" ? frame.name : names[0] === "function" ? payload?.name : names[0];
        tools.push(nativeToolObservation(name, frame.subtype === "completed" ? "completed" : "started", undefined, payload?.args ?? payload?.arguments));
      }
      if (frame.type === "result") {
        if (frame.is_error === true || frame.subtype !== "success") {
          failure = classifyRuntimeFailure({ stderr: JSON.stringify(frame.error ?? frame.result ?? "").slice(0, 65_536) });
          observeError(frame.error ?? frame.result);
        } else { terminal = true; if (typeof frame.result === "string") assembled = frame.result; }
      }
    }
    if (assembled.length + deltas.length > 200_000 || tools.length > 1024) return fail();
  }
  if (!result.ok || !terminal || failure) return fail();
  return { text: (assembled || deltas).trim(), completed: true, tools, failure: null };
}
export function expandedCliArgs(input: { id: ExpandedRuntimeId; prompt: string; model: string | null; effort: string | null;
  fullProtected: boolean; mcpConfigPath?: string }): string[] {
  const model = input.model ? ["--model", input.model] : [];
  if (input.id === "copilot") return ["-p", input.prompt, "--output-format", "json", "--no-auto-update", ...(input.fullProtected ? ["--allow-all-tools", "--allow-all-paths"] : ["--allow-tool=read", "--allow-tool=hara", "--deny-tool=write", "--deny-tool=shell"]),
    ...model, ...(input.effort ? ["--effort", input.effort] : []),
    ...(input.mcpConfigPath ? ["--additional-mcp-config=@" + input.mcpConfigPath] : [])];
  if (input.effort) throw new Error("invalid_model");
  if (input.id === "cursor") return ["--print", "--output-format", "stream-json", ...(input.fullProtected ? ["--force"] : ["--mode", "ask"]), "--sandbox", "disabled", "--approve-mcps", "--trust", ...model, input.prompt];
  return ["agent", "--no-leader", ...(input.fullProtected ? ["--always-approve"] : []), ...model, "stdio"];
}
/** Reject foreign-session updates instead of attributing their text/tool effects to this attempt. */
export function grokUpdate(params: Record<string, unknown>, sessionId: string): { text?: string; tool?: NativeToolObservation } {
  if (params.sessionId !== sessionId) throw new Error("runtime_failed");
  const update = object(params.update);
  if (!update) throw new Error("runtime_failed");
  if (update.sessionUpdate === "agent_message_chunk") {
    const content = object(update.content);
    return content?.type === "text" && typeof content.text === "string" ? { text: content.text } : {};
  }
  if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
    const meta = object(update._meta), native = object(meta?.["x.ai/tool"]);
    return { tool: nativeToolObservation(native?.name ?? update.name ?? update.title,
      update.status === "completed" ? "completed" : update.status === "failed" ? "failed" : "started", update.kind, update.rawInput) };
  }
  return {};
}
export function grokPermissionResult(params: Record<string, unknown> | undefined, input: {
  sessionId: string | null; active: boolean; fullProtected: boolean; aborted: boolean;
}): Record<string, unknown> {
  if (!params || !input.sessionId || params.sessionId !== input.sessionId || !input.active || !input.fullProtected || input.aborted)
    return { outcome: { outcome: "cancelled" } };
  const call = object(params.toolCall), meta = object(call?._meta), native = object(meta?.["x.ai/tool"]);
  if (!call || isForbiddenNativeTool(native?.name) || isForbiddenNativeTool(call.name) || isForbiddenNativeTool(call.title))
    return { outcome: { outcome: "cancelled" } };
  const options = Array.isArray(params.options) ? params.options : [];
  const selected = options.map(object).find(option => option?.kind === "allow_once" && typeof option.optionId === "string"
    && option.optionId.length > 0 && option.optionId.length < 200 && !/[\r\n\0]/.test(option.optionId));
  return selected ? { outcome: { outcome: "selected", optionId: selected.optionId } } : { outcome: { outcome: "cancelled" } };
}
