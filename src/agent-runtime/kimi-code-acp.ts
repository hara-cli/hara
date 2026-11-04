import { JsonlRpcClient, ExternalJsonlRpcRequestError, ExternalJsonlRpcTransportError, type ExternalCommandOptions, type ExternalCommandCaptureResult } from "../external-sessions/process.js";
import { classifyRuntimeFailure } from "./failure-diagnostics.js";
import { isForbiddenNativeTool } from "./expanded-protocol.js";
import { WORKSPACE_MCP_TOKEN_ENV, type WorkspaceMcpEndpoint } from "./registered-cli-mcp.js";
const object = (value: unknown): Record<string, any> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : null;
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_.:/-]{1,120}$/.test(value);
export const KIMI_CODE_ENV = Object.freeze({ KIMI_DISABLE_CRON: "1", KIMI_DISABLE_TELEMETRY: "1", KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT: "false" });
/** Native ACP owns filesystem/terminal operations under Seatbelt. Never advertise Host fs/terminal
 * capabilities, call authenticate/login, or copy the user's provider/configuration into Hara. */
export async function initializeKimiCodeSession(client: JsonlRpcClient, input: {
  cwd: string; endpoint: WorkspaceMcpEndpoint; tier: "controlled" | "full-protected"; model: string | null; assertCurrent(): void;
}): Promise<string> {
  const initialized = object(await client.call("initialize", { protocolVersion: 1, clientInfo: { name: "hara", version: "1" },
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }));
  if (initialized?.protocolVersion !== 1 || initialized.agentInfo?.name !== "Kimi Code CLI" || initialized.agentCapabilities?.mcpCapabilities?.http !== true) throw new Error("version_incompatible");
  input.assertCurrent();
  const session = object(await client.call("session/new", { cwd: input.cwd, mcpServers: [{ type: "http", name: "hara", url: input.endpoint.url,
    headers: [{ name: "Authorization", value: "Bearer " + input.endpoint.env[WORKSPACE_MCP_TOKEN_ENV] }] }] }));
  const sessionId = session?.sessionId, modeId = input.tier === "controlled" ? "plan" : "auto";
  if (!identifier(sessionId) || !Array.isArray(session?.modes?.availableModes) || !session.modes.availableModes.some((mode: any) => mode?.id === modeId)) throw new Error("version_incompatible");
  input.assertCurrent(); await client.call("session/set_mode", { sessionId, modeId });
  if (input.model && input.model !== "default") {
    input.assertCurrent(); await client.call("session/set_config_option", { sessionId, configId: "model", value: input.model });
  }
  input.assertCurrent(); return sessionId;
}
/** Convert bounded native ACP observations to the existing closed Kimi message parser. Native tool
 * metadata is evidence only; it cannot mint Hara grants/receipts or supply process ownership. */
export async function runKimiCodeAcp(input: {
  launch: ExternalCommandOptions & { args: readonly string[] }; cwd: string; endpoint: WorkspaceMcpEndpoint; prompt: string;
  tier: "controlled" | "full-protected"; model: string | null; signal: AbortSignal; timeoutMs: number;
  onSpawn(): void; onStdout(chunk: string): void; assertCurrent(): void;
}): Promise<ExternalCommandCaptureResult> {
  let client: JsonlRpcClient | undefined, sessionId: string | null = null, active = false, text = "", failed = false, expired = false, bytes = 0;
  const frames: string[] = [], pending = new Set<string>(), tools = new Map<string, { name: string; arguments: string }>();
  const replies = new Map<string, { fingerprint: string; result: Record<string, unknown> }>();
  const emit = (value: unknown) => {
    const line = JSON.stringify(value) + "\n"; bytes += Buffer.byteLength(line);
    if (bytes > 4 * 1024 * 1024) throw new Error("runtime_failed");
    frames.push(line); input.onStdout(line);
  };
  const refuse = () => { failed = true; client?.close(); };
  const timer = setTimeout(() => { expired = true; refuse(); }, input.timeoutMs); timer.unref();
  try {
    input.assertCurrent();
    client = JsonlRpcClient.start({ ...input.launch, cwd: input.cwd, appServerArgs: input.launch.args, jsonRpcVersion: "2.0", captureErrorFirstLine: true,
      signal: input.signal, timeoutMs: input.timeoutMs, maxOutputBytes: 4 * 1024 * 1024, onSpawn: input.onSpawn,
      onNotification(method, params) {
        if (method !== "session/update") return;
        const update = object(params.update); if (!update) { refuse(); return; }
        if (!["agent_message_chunk", "tool_call", "tool_call_update"].includes(update.sessionUpdate)) return;
        if (!active || params.sessionId !== sessionId || input.signal.aborted) { refuse(); return; }
        try {
          input.assertCurrent(); input.onStdout('{"role":"meta","type":"activity"}\n');
          if (update.sessionUpdate === "agent_message_chunk") {
            if (update.content?.type === "text" && typeof update.content.text === "string") { text += update.content.text; if (text.length > 512 * 1024) throw new Error("runtime_failed"); }
          } else {
            const id = update.toolCallId;
            if (!identifier(id) || tools.size >= 1024) throw new Error("runtime_failed");
            if (update.sessionUpdate === "tool_call") {
              if (tools.has(id) || typeof update.title !== "string" || isForbiddenNativeTool(update.title)) throw new Error("runtime_permission_denied");
              const name = update.title.split(/[ (]/, 1)[0], args = JSON.stringify(object(update.rawInput) ?? {});
              tools.set(id, { name, arguments: args }); pending.add(id);
              emit({ role: "assistant", content: [], tool_calls: [{ id, function: { name, arguments: args } }] });
            }
            const known = tools.get(id); if (!known) throw new Error("runtime_failed");
            if (object(update.rawInput)) {
              const args = JSON.stringify(update.rawInput);
              if (args !== known.arguments) { known.arguments = args;
                // Argument updates refine an observation, never duplicate a protocol tool call.
                input.onStdout(JSON.stringify({ role: "assistant", content: [], tool_calls: [{ id, function: { name: known.name, arguments: args } }] }) + "\n");
              }
            }
            if (["completed", "failed"].includes(update.status)) {
              if (!pending.delete(id)) throw new Error("runtime_failed");
              emit({ role: "tool", tool_call_id: id, is_error: update.status === "failed", content: "" });
            }
          }
        } catch { refuse(); }
      },
      onServerRequest(request, reply, reject) {
        if (request.method !== "session/request_permission") { reject(-32601, "Unsupported client method"); return; }
        const params = request.params, call = object(params?.toolCall), key = JSON.stringify(request.id), fingerprint = JSON.stringify(params);
        if (!active || !sessionId || params?.sessionId !== sessionId || input.signal.aborted || input.tier !== "full-protected") { reply({ outcome: { outcome: "cancelled" } }); return; }
        try {
          input.assertCurrent(); const prior = replies.get(key);
          if (prior) { if (prior.fingerprint !== fingerprint) throw new Error("runtime_failed"); reply(prior.result); return; }
          if (replies.size >= 64) throw new Error("runtime_failed");
          const option = call && !isForbiddenNativeTool(call.title) && !isForbiddenNativeTool(call.name) && Array.isArray(params?.options)
            ? params.options.find((item: any) => item?.kind === "allow_once" && identifier(item.optionId)) : null;
          const result = option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } };
          replies.set(key, { fingerprint, result }); reply(result);
        } catch { reject(-32602, "Permission request unavailable"); refuse(); }
      },
    });
    sessionId = await initializeKimiCodeSession(client, input); active = true;
    const result = object(await client.call("session/prompt", { sessionId, prompt: [{ type: "text", text: input.prompt }] }));
    active = false; input.assertCurrent();
    if (failed || input.signal.aborted || result?.stopReason !== "end_turn" || pending.size || !text.trim()) throw new Error("runtime_failed");
    emit({ role: "assistant", content: [{ type: "text", text }] });
    return { ok: true, stdout: frames.join(""), code: 0, timedOut: false };
  } catch (error) {
    const typed = error instanceof ExternalJsonlRpcRequestError || error instanceof ExternalJsonlRpcTransportError ? error : null;
    const kind = input.signal.aborted ? "interrupted" : expired ? "timeout" : typed?.runtimeFailureKind ?? classifyRuntimeFailure({ code: error instanceof Error ? error.message : undefined });
    return { ok: false, stdout: "", code: null, timedOut: kind === "timeout", errorCode: kind, ...(typed?.errorFirstLine ? { errorFirstLine: typed.errorFirstLine } : {}) };
  } finally { active = false; clearTimeout(timer); await client?.closeAndWait(); }
}
