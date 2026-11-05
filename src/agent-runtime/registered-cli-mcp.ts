import { runtimeProxyFailure } from "../security/runtime-proxy.js";
// A short-lived transport for one frozen Workspace attempt. It never executes a tool itself:
// calls yield to the same Hara governor used by Pi, then receive its actual tool-result receipt.
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { NeutralMsg, ToolResult, ToolSpec, TurnArgs, TurnResult } from "../providers/types.js";
import type { ExternalCommandCaptureResult } from "../external-sessions/process.js";
import { CLI_TOOL_GUIDANCE } from "./tool-guidance.js";

export const WORKSPACE_MCP_TOKEN_ENV = "HARA_WORKSPACE_MCP_TOKEN";
export interface WorkspaceMcpEndpoint {
  readonly url: string;
  readonly env: NodeJS.ProcessEnv;
  readonly attemptMarker?: string;
  /** Host-only, once per immutable attempt; bind after the actual native contract is known. */
  prepare?(contract: string): void | Promise<void>;
  close(): Promise<void>;
}

/** Host-only composition: the closures, never renderer arguments, choose audience and tools. */
export interface WorkspaceMcpAttemptInput {
  signal: AbortSignal;
  assertCurrent(): void;
  tools(): readonly ToolSpec[];
  call(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  /** Host-owned process secret. Each endpoint still has an immutable attempt/lease closure. */
  bearerToken?: string;
  /** Host deadline; authentication never extends beyond the attempt. */
  expiresAt?: number;
}
export async function createWorkspaceMcpEndpoint(input: WorkspaceMcpAttemptInput): Promise<WorkspaceMcpEndpoint> {
  input.assertCurrent();
  if (input.expiresAt !== undefined && (!Number.isFinite(input.expiresAt) || input.expiresAt <= Date.now())) throw new Error("Workspace MCP attempt expired");
  if (input.signal.aborted) throw new Error("Workspace MCP attempt ended");
  if (input.bearerToken !== undefined && !/^[a-f0-9]{64}$/.test(input.bearerToken)) throw new Error("Invalid Workspace MCP bearer");
  let token = input.bearerToken ?? randomBytes(32).toString("hex"), closed = false, closing: Promise<void> | undefined;
  const env: NodeJS.ProcessEnv = { [WORKSPACE_MCP_TOKEN_ENV]: token };
  const expected = Buffer.from("Bearer " + token);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(), enableJsonResponse: true, maxRequestBodySize: 256 * 1024,
  });
  const server = new Server({ name: "hara", version: "1.0.0" }, { capabilities: { tools: { listChanged: true } },
    instructions: "These are the frozen tools of this Hara Workspace attempt. Hara governs every call, including task understanding, budgets, evidence and Desk confirmation. Never infer approval from MCP connectivity. " + CLI_TOOL_GUIDANCE });
  const assertLive = () => {
    if (closed || input.signal.aborted || input.expiresAt !== undefined && Date.now() >= input.expiresAt) throw new Error("Workspace MCP attempt ended");
    input.assertCurrent();
  };
  const safeRequest = async <T>(operation: () => Promise<T>): Promise<T> => {
    try { return await operation(); }
    catch { throw new McpError(ErrorCode.InvalidRequest, "Workspace MCP request unavailable"); }
  };
  server.setRequestHandler(ListToolsRequestSchema, async () => safeRequest(async () => {
    assertLive();
    return { tools: input.tools().map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.input_schema })) };
  }));
  server.setRequestHandler(CallToolRequestSchema, async request => safeRequest(async () => {
    assertLive();
    if (!input.tools().some(tool => tool.name === request.params.name)) {
      return { content: [{ type: "text" as const, text: "Error: tool is outside this Workspace attempt" }], isError: true };
    }
    const result = await input.call(request.params.name, request.params.arguments ?? {});
    assertLive();
    return { content: [{ type: "text" as const, text: result.content }], ...(result.isError ? { isError: true } : {}) };
  }));
  await server.connect(transport);
  const reject = (response: ServerResponse, code: number) => {
    response.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify({ error: "Workspace MCP request refused" }));
  };
  let authority = "";
  const http = createServer((request, response) => {
    const authorization = request.headers.authorization;
    const supplied = typeof authorization === "string" && authorization.length <= 80 ? Buffer.from(authorization) : Buffer.alloc(0);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { reject(response, 401); return; }
    if (request.url !== "/mcp" || request.headers.host !== authority
      || (request.headers.origin !== undefined && request.headers.origin !== "http://" + authority)
      || !["127.0.0.1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? "")) { reject(response, 403); return; }
    try { assertLive(); } catch { reject(response, 403); return; }
    void transport.handleRequest(request, response).catch(() => {
      if (!response.headersSent) reject(response, 400);
      else response.destroy();
    });
  });
  http.requestTimeout = 15_000; http.headersTimeout = 15_000; http.keepAliveTimeout = 1_000;
  const close = (): Promise<void> => closing ??= (async () => {
    closed = true; token = ""; expected.fill(0); delete env[WORKSPACE_MCP_TOKEN_ENV];
    input.signal.removeEventListener("abort", onAbort);
    await server.close().catch(() => {});
    await new Promise<void>(resolve => { http.close(() => resolve()); http.closeAllConnections(); });
  })();
  const onAbort = () => { void close().catch(() => {}); };
  try {
    await new Promise<void>((resolve, rejectListen) => {
      http.once("error", rejectListen);
      http.listen(0, "127.0.0.1", () => { http.off("error", rejectListen); resolve(); });
    });
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("Workspace MCP listener unavailable");
    authority = "127.0.0.1:" + address.port;
    input.signal.addEventListener("abort", onAbort, { once: true });
    if (input.signal.aborted) { await close(); throw new Error("Workspace MCP attempt ended"); }
    return { url: "http://" + authority + "/mcp", env, close };
  } catch (error) { await close(); throw error; }
}

interface PendingCall {
  call: { id: string; name: string; input: Record<string, unknown> };
  resolve(result: ToolResult): void;
}

/** One CLI process per attempt, no app-server/resume. Each MCP call yields a model boundary to
 * runGovernedAgent; only that governor can execute/approve it. The next step releases its result. */
export function createRegisteredCliMcpTurn(input: {
  signal: AbortSignal;
  jsonEvents?: boolean;
  /** Pi completion is committed by the Host only after native settle and shared tree drain. */
  deferNativeCompletion?: boolean;
  /** Host-only serialization for an embedded native RPC runtime with its own system prompt. */
  prompt?(args: TurnArgs): string;
  parseOutput?(output: string): TurnResult;
  beforeTool?(): void;
  assertCurrent(): void;
  bearerToken?: string;
  createEndpoint?(input: WorkspaceMcpAttemptInput): Promise<WorkspaceMcpEndpoint>;
  decorateResult?(result: ToolResult, args: TurnArgs): ToolResult;
  takeUsage?(): TurnResult["usage"];
  launch(endpoint: WorkspaceMcpEndpoint, prompt: string, activity: () => void, args: TurnArgs): Promise<ExternalCommandCaptureResult>;
}) {
  const stopped = new AbortController();
  const pending = new Map<string, PendingCall>(), queue: PendingCall[] = [];
  let endpoint: WorkspaceMcpEndpoint | undefined, physical: Promise<void> | undefined;
  let tools: readonly ToolSpec[] = [], finished: TurnResult | undefined, wake: (() => void) | undefined;
  let preview: TurnArgs["onAssistantPreview"];
  let activity: (() => void) | undefined, closed = false, ended = false;
  let closing: Promise<void> | undefined, deferredCompletion: PendingCall | undefined;
  const notify = () => { wake?.(); wake = undefined; };
  const flush = (history: readonly NeutralMsg[], args?: TurnArgs) => {
    for (const message of history) if (message.role === "tool") for (const result of message.results) {
      const call = pending.get(result.id);
      if (call) { pending.delete(result.id); call.resolve(args && input.decorateResult ? input.decorateResult(result, args) : result); }
    }
  };
  const close = (history: readonly NeutralMsg[] = []): Promise<void> => closing ??= (async () => {
    closed = true; flush(history); stopped.abort();
    for (const { call, resolve } of pending.values()) resolve({ id: call.id, name: call.name, content: "Error: Workspace attempt ended", isError: true });
    pending.clear(); queue.length = 0; deferredCompletion = undefined; notify();
    try { await endpoint?.close(); await physical; }
    finally { input.signal.removeEventListener("abort", onAbort); }
  })();
  const onAbort = () => { void close().catch(() => {}); };
  input.signal.addEventListener("abort", onAbort, { once: true });
  return {
    signal: AbortSignal.any([input.signal, stopped.signal]),
    async turn(args: TurnArgs): Promise<TurnResult> {
      input.assertCurrent();
      if (closed || args.signal?.aborted) return { text: "", toolUses: [], stop: "error", errorMsg: "interrupted" };
      tools = args.tools; activity = args.onActivity; preview = args.onAssistantPreview; flush(args.history, args);
      if (!physical) {
        endpoint = await (input.createEndpoint ?? createWorkspaceMcpEndpoint)({ signal: AbortSignal.any([input.signal, stopped.signal]), assertCurrent: input.assertCurrent,
          bearerToken: input.bearerToken,
          tools: () => tools, call(name, parameters) {
            input.assertCurrent(); input.beforeTool?.();
            if (closed || finished || ended || pending.size >= 16) throw new Error("Workspace MCP call limit reached");
            if (input.deferNativeCompletion && name === "task_checkpoint" && (parameters.done === true
              || (parameters.completion as { state?: unknown } | undefined)?.state === "verified")) {
              if (deferredCompletion) return Promise.resolve({ id: randomUUID(), name, content: "A completion proposal is already pending Host verification", isError: true });
              const call = { id: randomUUID(), name, input: parameters };
              deferredCompletion = { call, resolve() {} };
              return Promise.resolve({ id: call.id, name, content: JSON.stringify({ completionDeferred: true, committed: false,
                instruction: "Finish your reply. Hara verifies this proposal only after the native run settles and the protected process tree drains. This is not a successful completion receipt." }) });
            }
            return new Promise<ToolResult>(resolve => {
              const call = { id: randomUUID(), name, input: parameters };
              const item = { call, resolve }; pending.set(call.id, item); queue.push(item); notify();
            });
          } });
        const prompt = input.prompt?.(args) ?? [args.system, CLI_TOOL_GUIDANCE, ...args.history.map(message => message.role === "user" ? "User: " + message.content
          : message.role === "assistant" ? "Assistant: " + message.text : "")]
          .filter(Boolean).join("\n\n");
        if (!prompt.trim() || prompt.length > 200_000 || args.history.some(message => message.role === "user" && message.images?.length)) {
          await close(); return { text: "", toolUses: [], stop: "error", errorMsg: "Native Agent Runtime context is unsupported or too large" };
        }
        physical = (async () => {
          try {
            const result = await input.launch(endpoint!, prompt, () => activity?.(), { ...args, onAssistantPreview: value => preview?.(value) });
            const nativeControlFailure = result.errorCode === "codex_thread_start_failed" || result.errorCode === "codex_resume_failed_history_preserved"
              ? result.errorCode : undefined;
            if (!result.ok) finished = { text: "", toolUses: [], stop: "error",
              ...(result.nativeFailureKind || nativeControlFailure ? { errorMetadata: {
                ...(result.nativeFailureKind ? { code: result.nativeFailureKind } : {}),
                ...(nativeControlFailure ? { nativeControlFailure } : {}),
              } } : {}),
              errorMsg: result.runtimeFailure ?? "registered Runtime failed (" + (result.errorCode ?? (result.timedOut ? "timeout" : "exit")) + "); no fallback was selected" };
            else if (input.parseOutput) finished = input.parseOutput(result.stdout);
            else if (input.jsonEvents === false) finished = { text: result.stdout.trim(), toolUses: [], stop: "end" };
            else {
              // JSON events contain native session IDs and internal calls. Persist only the final text.
              let text = "", usage: TurnResult["usage"];
              for (const line of result.stdout.split(/\r?\n/u)) {
                try {
                  const event = JSON.parse(line);
                  if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") text = event.item.text;
                  if (event.type === "turn.completed" && event.usage) {
                    const { input_tokens: a, output_tokens: b } = event.usage;
                    if (Number.isSafeInteger(a) && a >= 0 && Number.isSafeInteger(b) && b >= 0) usage = { input: a, output: b };
                  }
                } catch { /* older fixture/CLI text output is handled below */ }
              }
              if (!text && !result.stdout.trimStart().startsWith("{")) text = result.stdout.trim();
              finished = { text, toolUses: [], stop: "end", ...(usage ? { usage } : {}) };
            }
          } catch (error) { finished = { text: "", toolUses: [], stop: "error", errorMsg: runtimeProxyFailure(error) ?? "Native Agent Runtime launch failed; no fallback was selected" }; }
          finally {
            if (!closed && finished && finished.stop !== "error" && deferredCompletion) {
              pending.set(deferredCompletion.call.id, deferredCompletion); queue.push(deferredCompletion);
            }
            deferredCompletion = undefined; notify();
          }
        })();
      }
      while (!closed) {
        input.assertCurrent();
        const next = queue.shift();
        if (next) return { text: "", toolUses: [next.call], stop: "tool_use", ...(input.takeUsage ? { usage: input.takeUsage() } : {}) };
        if (finished) { const result = finished; finished = undefined; ended = true;
          return input.takeUsage ? { ...result, usage: input.takeUsage() } : result; }
        if (ended) return { text: "", toolUses: [], stop: "error", errorMsg: "Native CLI ended before the governed task completed; no automatic replay" };
        await new Promise<void>(resolve => {
          const onAbort = () => { void close().catch(() => {}); settle(); };
          const settle = () => { args.signal?.removeEventListener("abort", onAbort); resolve(); };
          wake = settle;
          if (args.signal?.aborted) onAbort(); else args.signal?.addEventListener("abort", onAbort, { once: true });
        });
      }
      return { text: "", toolUses: [], stop: "error", errorMsg: "interrupted" };
    },
    close,
  };
}
