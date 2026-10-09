import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual, createHash } from "node:crypto";
import type { Socket } from "node:net";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { AssistantContinuation, NeutralMsg, Provider, ToolSpec, ToolUse } from "../providers/types.js";
import { validateCodingContinuation, type CodingContinuationStore } from "./continuations.js";

export interface CodingHostBudget {
  maxProviderRounds: number;
  maxToolCalls: number;
  maxTokens: number;
  timeoutMs: number;
}

export interface CodingHostMetrics {
  providerRounds: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface CodingHostOptions {
  provider: Provider;
  tools: ToolSpec[];
  executeTool(name: string, input: Record<string, unknown>, signal: AbortSignal): Promise<string | { content: string; isError?: boolean }>;
  assertCurrent(): void | Promise<void>;
  budget: CodingHostBudget;
  signal?: AbortSignal;
  system?: string;
  organizationPolicyVersion?: number;
  /** Synchronous accounting only, including cancelled operations. Never authorizes more work. */
  onUsage?(metrics: CodingHostMetrics): void;
  /** False revokes this bridge. Metrics are copies and contain no prompts, credentials or paths. */
  onProgress?(metrics: CodingHostMetrics): boolean;
  /** Private host-owned state only. Restored provider reasoning never comes from client fields. */
  continuationStore?: CodingContinuationStore;
}

export interface CodingHostBridge {
  model: "hara/coding";
  provider: Record<string, Record<string, unknown>>;
  mcp: { type: "remote"; url: string; headers: Record<string, string> };
  toolNames: string[];
  budget: CodingHostBudget;
  readonly metrics: CodingHostMetrics;
  close(): Promise<void>;
}

const MAX_PAYLOAD = 1024 * 1024;
const PROTOCOL_VERSIONS = new Set(["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"]);
type JsonRecord = Record<string, unknown>;

class HostError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

function record(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HostError(400, "unsupported_payload");
  return value as JsonRecord;
}

function keys(value: JsonRecord, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new HostError(400, "unsupported_payload");
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,256}$/.test(value)) throw new HostError(400, "unsupported_identifier");
  return value;
}

function textContent(value: unknown, nullable = false): string {
  if (typeof value === "string") return value;
  if (nullable && value === null) return "";
  if (Array.isArray(value)) return value.map((part) => {
    const item = record(part);
    keys(item, ["type", "text"]);
    if (item.type !== "text" || typeof item.text !== "string") throw new HostError(400, "unsupported_content");
    return item.text;
  }).join("");
  throw new HostError(400, "unsupported_content");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    const object = value as JsonRecord;
    return "{" + Object.keys(object).sort().map((key) => JSON.stringify(key) + ":" + canonical(object[key])).join(",") + "}";
  }
  return JSON.stringify(value) ?? "null";
}

function continuationKey(text: string, tools: ToolUse[], history: NeutralMsg[]): string {
  // Bind the exact position as well as tool IDs. Repeated visible replies must not overwrite another
  // turn's private reasoning. Hash only the stable wire projection, not private continuation fields
  // that clients discard (and are never allowed to supply authoritatively).
  const wireHistory = history.map((message) => message.role === "assistant"
    ? { role: "assistant", text: message.text, toolUses: message.toolUses }
    : message);
  return createHash("sha256").update(canonical({ text, tools, history: wireHistory })).digest("hex");
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => {});
    return Promise.reject(new HostError(409, "host_cancelled"));
  }
  return new Promise((resolve, reject) => {
    const aborted = (): void => reject(new HostError(409, "host_cancelled"));
    signal.addEventListener("abort", aborted, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

async function readPayload(request: IncomingMessage): Promise<JsonRecord> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers["content-type"] ?? "")) {
    throw new HostError(415, "json_required");
  }
  if (Number(request.headers["content-length"] ?? 0) > MAX_PAYLOAD) throw new HostError(413, "payload_too_large");
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_PAYLOAD) throw new HostError(413, "payload_too_large");
    chunks.push(bytes);
  }
  try { return record(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
  catch (error) {
    if (error instanceof HostError) throw error;
    throw new HostError(400, "invalid_json");
  }
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(JSON.stringify(value));
}

/** Session-scoped local transport only. All model and tool authority remains in the supplied Hara host. */
export async function createCodingHostBridge(options: CodingHostOptions): Promise<CodingHostBridge> {
  const budget = { ...options.budget };
  for (const name of ["maxProviderRounds", "maxToolCalls", "maxTokens", "timeoutMs"] as const) {
    if (!Number.isSafeInteger(budget[name]) || budget[name] <= 0) throw new Error("invalid coding host budget");
  }
  if (budget.timeoutMs > 2_147_483_647) throw new Error("invalid coding host timeout");
  const tools = structuredClone(options.tools);
  const byName = new Map<string, ToolSpec>();
  const aliases = new Map<string, ToolSpec>();
  const inputValidators = new Map<string, (input: unknown) => { valid: boolean }>();
  for (const tool of tools) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(tool.name) || byName.has(tool.name)) throw new Error("invalid coding host tool allowlist");
    record(tool.input_schema);
    byName.set(tool.name, tool);
    // SDK validation compiles only host-provided schemas. Remote references are not fetched.
    inputValidators.set(tool.name, new AjvJsonSchemaValidator().getValidator(tool.input_schema));
  }
  for (const tool of tools) {
    for (const alias of [tool.name, `hara_${tool.name}`]) {
      if (aliases.has(alias)) throw new Error("ambiguous coding host tool allowlist");
      aliases.set(alias, tool);
    }
  }
  const token = randomBytes(32).toString("base64url");
  const authorization = Buffer.from(`Bearer ${token}`);
  const lifecycle = new AbortController();
  const continuations = new Map<string, AssistantContinuation>();
  const counters: CodingHostMetrics = { providerRounds: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const sockets = new Set<Socket>();
  let providerBusy = false;
  let toolQueue = Promise.resolve();
  let mcpSession: string | undefined;
  let mcpInitialized = false;
  let mcpEnded = false;
  let closed: Promise<void> | undefined;
  let origin = "";

  const active = (signal: AbortSignal = lifecycle.signal): void => {
    if (signal.aborted || lifecycle.signal.aborted) throw new HostError(409, "host_cancelled");
  };
  const assertCurrent = async (signal: AbortSignal = lifecycle.signal): Promise<void> => {
    active(signal);
    try { await abortable(Promise.resolve().then(() => options.assertCurrent()), signal); }
    catch (error) {
      if (!(error instanceof HostError)) lifecycle.abort();
      throw new HostError(409, "host_binding_changed");
    }
    active(signal);
  };
  const usage = (): void => {
    try { options.onUsage?.({ ...counters }); }
    catch { lifecycle.abort(); throw new HostError(409, "host_binding_changed"); }
  };
  const authorizeProgress = (): void => {
    active();
    let permitted = true;
    try { permitted = options.onProgress?.({ ...counters }) !== false; }
    catch { lifecycle.abort(); throw new HostError(409, "host_binding_changed"); }
    if (counters.providerRounds > budget.maxProviderRounds || counters.toolCalls > budget.maxToolCalls
      || counters.totalTokens > budget.maxTokens || !permitted) {
      lifecycle.abort();
      throw new HostError(429, "host_budget_exhausted");
    }
  };
  const progress = (): void => {
    usage();
    authorizeProgress();
  };

  function parseTools(value: unknown): ToolSpec[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new HostError(400, "unsupported_tools");
    const seen = new Set<string>();
    return value.map((entry) => {
      const wrapper = record(entry);
      keys(wrapper, ["type", "function"]);
      if (wrapper.type !== "function") throw new HostError(400, "unsupported_tools");
      const definition = record(wrapper.function);
      keys(definition, ["name", "description", "parameters", "strict"]);
      const name = identifier(definition.name);
      const trusted = aliases.get(name);
      if (!trusted || seen.has(name)) throw new HostError(400, "unsupported_tool");
      seen.add(name);
      return { ...trusted, name };
    });
  }

  function parseMessages(value: unknown): { system: string; history: NeutralMsg[] } {
    if (!Array.isArray(value) || value.length === 0 || value.length > 4096) throw new HostError(400, "unsupported_messages");
    const systems = [options.system ?? ""];
    const history: NeutralMsg[] = [];
    const pending = new Map<string, string>();
    let conversationStarted = false;
    for (const entry of value) {
      const message = record(entry);
      if (message.role === "system") {
        keys(message, ["role", "content"]);
        if (conversationStarted) throw new HostError(400, "unsupported_messages");
        systems.push(textContent(message.content));
      } else if (message.role === "user") {
        keys(message, ["role", "content"]);
        if (pending.size) throw new HostError(400, "unclosed_tool_calls");
        conversationStarted = true;
        history.push({ role: "user", content: textContent(message.content) });
      } else if (message.role === "assistant") {
        keys(message, ["role", "content", "tool_calls", "reasoning_content"]);
        if (pending.size) throw new HostError(400, "unclosed_tool_calls");
        conversationStarted = true;
        const text = textContent(message.content ?? null, true);
        if (message.tool_calls !== undefined && !Array.isArray(message.tool_calls)) throw new HostError(400, "unsupported_tools");
        const toolUses: ToolUse[] = (message.tool_calls as unknown[] | undefined ?? []).map((entry) => {
          const call = record(entry);
          keys(call, ["id", "type", "function"]);
          if (call.type !== "function") throw new HostError(400, "unsupported_tools");
          const definition = record(call.function);
          keys(definition, ["name", "arguments"]);
          const id = identifier(call.id);
          const name = identifier(definition.name);
          if (!aliases.has(name) || pending.has(id) || typeof definition.arguments !== "string") throw new HostError(400, "unsupported_tool");
          let input: JsonRecord;
          try { input = record(JSON.parse(definition.arguments)); }
          catch { throw new HostError(400, "unsupported_tool_arguments"); }
          if (!inputValidators.get(aliases.get(name)!.name)!(input).valid) throw new HostError(400, "unsupported_tool_arguments");
          pending.set(id, name);
          return { id, name, input };
        });
        const key = continuationKey(text, toolUses, history);
        let continuation = continuations.get(key);
        if (!continuation && options.continuationStore) {
          try { continuation = options.continuationStore.load(key); }
          catch { lifecycle.abort(); throw new HostError(409, "host_continuation_unavailable"); }
        }
        // Only provider-owned cached state is authoritative; a child cannot inject private reasoning.
        if (message.reasoning_content !== undefined && typeof message.reasoning_content !== "string") throw new HostError(400, "unsupported_content");
        history.push({ role: "assistant", text, toolUses, ...(continuation ? { continuation: structuredClone(continuation) } : {}) });
      } else if (message.role === "tool") {
        keys(message, ["role", "content", "tool_call_id"]);
        const id = identifier(message.tool_call_id);
        const name = pending.get(id);
        if (!name) throw new HostError(400, "foreign_tool_result");
        pending.delete(id);
        const result = { id, name, content: textContent(message.content) };
        const previous = history.at(-1);
        if (previous?.role === "tool") previous.results.push(result);
        else history.push({ role: "tool", results: [result] });
      } else throw new HostError(400, "unsupported_message_role");
    }
    if (pending.size || history.length === 0) throw new HostError(400, "unclosed_tool_calls");
    return { system: systems.filter(Boolean).join("\n\n"), history };
  }

  async function completion(body: JsonRecord, response: ServerResponse, signal: AbortSignal): Promise<void> {
    keys(body, ["model", "messages", "tools", "stream", "stream_options", "temperature", "top_p", "max_tokens", "max_completion_tokens", "frequency_penalty", "presence_penalty", "seed", "stop", "parallel_tool_calls", "tool_choice", "reasoning_effort"]);
    if (body.model !== "coding" && body.model !== "hara/coding") throw new HostError(400, "unsupported_model");
    if (body.stream !== undefined && typeof body.stream !== "boolean") throw new HostError(400, "unsupported_stream");
    if (body.tool_choice !== undefined && body.tool_choice !== "auto" && body.tool_choice !== "none") throw new HostError(400, "unsupported_tool_choice");
    const requestedTools = parseTools(body.tools);
    const injectedTools = body.tool_choice === "none" ? [] : requestedTools;
    const { system, history } = parseMessages(body.messages);
    const inputEstimate = Buffer.byteLength(JSON.stringify({ system, history, tools: injectedTools }));
    if (providerBusy) throw new HostError(429, "provider_busy");
    providerBusy = true;
    let dispatched = false;
    let accounted = false;
    try {
      await assertCurrent(signal);
      if (counters.providerRounds >= budget.maxProviderRounds || counters.totalTokens + inputEstimate > budget.maxTokens) throw new HostError(429, "host_budget_exhausted");
      counters.providerRounds += 1;
      progress();
      const prepared = await abortable(Promise.resolve(options.provider.prepareTurn?.(history, signal)), signal);
      await assertCurrent(signal);
      if (options.organizationPolicyVersion !== undefined && prepared?.organizationPolicyVersion !== undefined
        && prepared.organizationPolicyVersion !== options.organizationPolicyVersion) {
        lifecycle.abort();
        throw new HostError(409, "host_binding_changed");
      }
      dispatched = true;
      // Child generation hints are not forwarded: the existing Hara model/profile stays authoritative.
      const result = await abortable(options.provider.turn({
        system, history, tools: injectedTools, signal,
        organizationPolicyVersion: options.organizationPolicyVersion ?? prepared?.organizationPolicyVersion,
        onText: () => {}, onReasoning: () => {}, onActivity: () => {},
      }), signal);
      await assertCurrent(signal);
      const outputEstimate = Buffer.byteLength(JSON.stringify(result));
      const validCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
      if (result.usage && (!validCount(result.usage.input) || !validCount(result.usage.output))) throw new HostError(502, "unsupported_provider_usage");
      counters.inputTokens += result.usage?.input ?? inputEstimate;
      counters.outputTokens += result.usage?.output ?? outputEstimate;
      counters.totalTokens = counters.inputTokens + counters.outputTokens;
      accounted = true;
      progress();
      if (outputEstimate > MAX_PAYLOAD) throw new HostError(502, "provider_result_too_large");
      if (result.stop === "error") throw new HostError(502, "provider_operation_failed");
      if (typeof result.text !== "string" || !Array.isArray(result.toolUses)) throw new HostError(502, "unsupported_provider_result");
      const allowedNames = new Set(injectedTools.map((tool) => tool.name));
      const ids = new Set<string>();
      for (const tool of result.toolUses) {
        identifier(tool.id);
        if (!allowedNames.has(tool.name) || ids.has(tool.id)) throw new HostError(502, "unsupported_provider_tool");
        ids.add(tool.id);
        record(tool.input);
        if (!inputValidators.get(aliases.get(tool.name)!.name)!(tool.input).valid) throw new HostError(502, "unsupported_provider_tool_arguments");
      }
      const key = continuationKey(result.text, result.toolUses, history);
      let continuation: AssistantContinuation | undefined;
      if (result.continuation !== undefined) {
        try { continuation = validateCodingContinuation(result.continuation); }
        catch { throw new HostError(502, "unsupported_provider_continuation"); }
        continuations.set(key, continuation);
        if (continuations.size > 64) continuations.delete(continuations.keys().next().value!);
      }
      try { options.continuationStore?.save(key, continuation); }
      catch { lifecycle.abort(); throw new HostError(409, "host_continuation_unavailable"); }
      const toolCalls = result.toolUses.map((tool) => ({ id: tool.id, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.input) } }));
      const reasoning = continuation?.type === "chat_reasoning" ? continuation.text : undefined;
      const message = { role: "assistant", content: result.text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}), ...(reasoning === undefined ? {} : { reasoning_content: reasoning }) };
      const finish = toolCalls.length ? "tool_calls" : "stop";
      const usage = { prompt_tokens: result.usage?.input ?? inputEstimate, completion_tokens: result.usage?.output ?? outputEstimate, total_tokens: (result.usage?.input ?? inputEstimate) + (result.usage?.output ?? outputEstimate) };
      const base = { id: `chatcmpl-${randomUUID()}`, created: Math.floor(Date.now() / 1000), model: "hara/coding" };
      if (!body.stream) json(response, 200, { ...base, object: "chat.completion", choices: [{ index: 0, message, finish_reason: finish }], usage });
      else {
        response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
        const event = (delta: unknown, finishReason: string | null = null): void => {
          response.write(`data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
        };
        event({ role: "assistant", content: result.text, ...(reasoning === undefined ? {} : { reasoning_content: reasoning }) });
        if (toolCalls.length) event({ tool_calls: toolCalls.map((call, index) => ({ index, ...call })) });
        event({}, finish);
        response.write(`data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [], usage })}\n\ndata: [DONE]\n\n`);
        response.end();
      }
    } finally {
      // Failed/cancelled requests can still consume input tokens upstream. Never make retries free.
      if (dispatched && !accounted) {
        counters.inputTokens += inputEstimate;
        counters.totalTokens = counters.inputTokens + counters.outputTokens;
        // Accounting must reach the parent before this operation settles, even after revocation.
        // Do not call the authorization/progress gate again on a cancelled bridge.
        usage();
        if (!lifecycle.signal.aborted) authorizeProgress();
      }
      providerBusy = false;
      await assertCurrent(signal);
    }
  }

  async function callTool(name: string, input: JsonRecord, signal: AbortSignal): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
    const operation = toolQueue.then(async () => {
      await assertCurrent(signal);
      if (counters.toolCalls >= budget.maxToolCalls || counters.totalTokens >= budget.maxTokens) throw new HostError(429, "host_budget_exhausted");
      counters.toolCalls += 1;
      progress();
      // Keep the serialization fence until the callback itself settles, even if its HTTP peer leaves.
      let result: Awaited<ReturnType<CodingHostOptions["executeTool"]>>;
      try { result = await options.executeTool(name, input, signal); }
      finally { await assertCurrent(signal); }
      progress();
      const output = typeof result === "string" ? { content: result } : result;
      if (!output || typeof output.content !== "string" || Buffer.byteLength(output.content) > MAX_PAYLOAD) throw new HostError(502, "unsupported_tool_result");
      return { content: [{ type: "text" as const, text: output.content }], ...(output.isError === undefined ? {} : { isError: output.isError }) };
    });
    toolQueue = operation.then(() => {}, () => {});
    return abortable(operation, signal);
  }

  async function mcp(request: IncomingMessage, response: ServerResponse, body: JsonRecord, signal: AbortSignal): Promise<void> {
    keys(body, ["jsonrpc", "id", "method", "params"]);
    if (body.jsonrpc !== "2.0" || typeof body.method !== "string" || (body.id !== undefined && typeof body.id !== "string" && typeof body.id !== "number")) throw new HostError(400, "unsupported_jsonrpc");
    const params = body.params === undefined ? {} : record(body.params);
    let result: unknown;
    if (body.method === "initialize") {
      if (mcpSession || mcpEnded || body.id === undefined || request.headers["mcp-session-id"] !== undefined) throw new HostError(409, "mcp_already_initialized");
      keys(params, ["protocolVersion", "capabilities", "clientInfo"]);
      if (typeof params.protocolVersion !== "string" || !PROTOCOL_VERSIONS.has(params.protocolVersion)) throw new HostError(400, "unsupported_mcp_protocol");
      record(params.capabilities); record(params.clientInfo);
      mcpSession = randomUUID();
      result = { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "hara-coding-host", version: "1.0.0" } };
    } else {
      if (!mcpSession || request.headers["mcp-session-id"] !== mcpSession) throw new HostError(404, "foreign_mcp_session");
      if (body.method === "notifications/initialized") {
        if (body.id !== undefined) throw new HostError(400, "unsupported_jsonrpc");
        keys(params, []);
        mcpInitialized = true;
        await assertCurrent(signal);
        response.writeHead(202, { "Mcp-Session-Id": mcpSession, "Cache-Control": "no-store" }); response.end(); return;
      }
      if (!mcpInitialized || body.id === undefined) throw new HostError(400, "mcp_not_initialized");
      if (body.method === "tools/list") {
        keys(params, []);
        result = { tools: tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.input_schema })) };
      } else if (body.method === "tools/call") {
        keys(params, ["name", "arguments", "_meta"]);
        if (typeof params.name !== "string" || !byName.has(params.name)) throw new HostError(400, "unsupported_tool");
        const input = params.arguments === undefined ? {} : record(params.arguments);
        if (!inputValidators.get(params.name)!(input).valid) throw new HostError(400, "unsupported_tool_arguments");
        result = await callTool(params.name, input, signal);
      } else if (body.method === "ping") { keys(params, []); result = {}; }
      else throw new HostError(400, "unsupported_mcp_method");
    }
    await assertCurrent(signal);
    response.setHeader("Mcp-Session-Id", mcpSession!);
    json(response, 200, { jsonrpc: "2.0", id: body.id, result });
  }

  const server = createServer((request, response) => {
    let rpcId: unknown = null;
    const requestAbort = new AbortController();
    const signal = AbortSignal.any([lifecycle.signal, requestAbort.signal]);
    const disconnected = (): void => {
      if (!response.writableFinished) { requestAbort.abort(); lifecycle.abort(); }
    };
    response.on("close", disconnected);
    void (async () => {
      const supplied = Buffer.from(typeof request.headers.authorization === "string" ? request.headers.authorization : "");
      if (supplied.length !== authorization.length || !timingSafeEqual(supplied, authorization)) throw new HostError(401, "unauthorized");
      if (request.headers.host !== new URL(origin).host || (request.headers.origin !== undefined && request.headers.origin !== origin)) throw new HostError(403, "foreign_origin");
      await assertCurrent(signal);
      if (request.url === "/mcp" && request.method === "GET") {
        if (!mcpSession || request.headers["mcp-session-id"] !== mcpSession) throw new HostError(404, "foreign_mcp_session");
        await assertCurrent(signal); response.writeHead(405, { Allow: "POST, DELETE" }); response.end(); return;
      }
      if (request.url === "/mcp" && request.method === "DELETE") {
        if (!mcpSession || request.headers["mcp-session-id"] !== mcpSession) throw new HostError(404, "foreign_mcp_session");
        await assertCurrent(signal); mcpInitialized = false; mcpSession = undefined; mcpEnded = true;
        json(response, 200, {}); return;
      }
      if (request.method !== "POST") throw new HostError(405, "unsupported_http_method");
      if (request.url !== "/mcp" && request.url !== "/v1/chat/completions") throw new HostError(404, "unsupported_endpoint");
      const body = await readPayload(request);
      if (request.url === "/mcp") rpcId = body.id ?? null;
      await assertCurrent(signal);
      if (request.url === "/mcp") await mcp(request, response, body, signal);
      else await completion(body, response, signal);
      await assertCurrent(signal);
    })().catch((error: unknown) => {
      if (!response.headersSent && !response.destroyed) {
        const failure = error instanceof HostError ? error : new HostError(500, "host_operation_failed");
        if (request.url === "/mcp") {
          const code = failure.code === "unsupported_mcp_method" ? -32601 : failure.status === 400 ? -32602 : -32603;
          json(response, failure.status, { jsonrpc: "2.0", id: rpcId, error: { code, message: failure.code } });
        } else json(response, failure.status, { error: { message: failure.code, type: "hara_coding_host_error" } });
      } else if (!response.writableEnded) response.destroy();
      request.resume();
    }).finally(() => response.removeListener("close", disconnected));
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.requestTimeout = Math.min(budget.timeoutMs, 30_000);
  server.headersTimeout = Math.min(budget.timeoutMs, 30_000);
  const externalAbort = (): void => lifecycle.abort();
  options.signal?.addEventListener("abort", externalAbort, { once: true });
  const timer = setTimeout(() => lifecycle.abort(), budget.timeoutMs);
  timer.unref();
  const close = (): Promise<void> => {
    if (closed) return closed;
    lifecycle.abort();
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", externalAbort);
    continuations.clear();
    closed = new Promise<void>((resolve) => {
      server.close(() => resolve());
      for (const socket of sockets) socket.destroy();
    });
    return closed;
  };
  lifecycle.signal.addEventListener("abort", () => { queueMicrotask(() => { void close(); }); }, { once: true });
  if (options.signal?.aborted) { await close(); throw new Error("coding host cancelled before startup"); }
  try {
    await assertCurrent();
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error): void => reject(error);
      server.once("error", failed);
      server.listen(0, "127.0.0.1", () => { server.removeListener("error", failed); resolve(); });
    });
    active();
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("coding host loopback unavailable");
    origin = `http://127.0.0.1:${address.port}`;
    return {
      model: "hara/coding",
      provider: { hara: { npm: "@ai-sdk/openai-compatible", models: { coding: { name: "Hara current connection", limit: { context: 128_000, output: 16_384 } } }, options: { baseURL: `${origin}/v1`, apiKey: token, includeUsage: true } } },
      mcp: { type: "remote", url: `${origin}/mcp`, headers: { Authorization: `Bearer ${token}` } },
      toolNames: tools.map((tool) => tool.name),
      budget: { ...budget },
      get metrics() { return { ...counters }; },
      close,
    };
  } catch (error) { await close(); throw error; }
}
