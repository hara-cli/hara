import OpenAI from "openai";
import { imageToBase64 } from "../images.js";
import { safeModelNetworkFailureMessage } from "../network/model-fetch.js";
import { safeProviderErrorMessage } from "./errors.js";
import { assembleToolCalls } from "./openai.js";
import { reasoningParams, type Effort, type ReasoningStyle } from "./reasoning.js";
import { applyReasoningParams, reasoningRouteKey, sendWithReasoningFallback } from "./reasoning-fallback.js";
import type {
  NeutralMsg,
  Provider,
  ResponsesReasoningItem,
  ToolUse,
  TurnArgs,
  TurnResult,
} from "./types.js";

const TEXT_ONLY_IMAGE_NOTE = "[Image attachment omitted: this Responses endpoint accepts text only.]";

/** Build a complete, provider-neutral history for a stateless Responses endpoint. DeepSeek does not
 * support previous_response_id/conversation/store, so every turn deliberately replays all message,
 * function_call, and function_call_output items. */
export function toResponsesInput(
  history: NeutralMsg[],
  supportsImages = true,
): any[] {
  const input: any[] = [];
  for (const message of history) {
    if (message.role === "user") {
      if (!message.images?.length) {
        input.push({ role: "user", content: message.content });
        continue;
      }

      if (!supportsImages) {
        const description = message.imageDescription?.trim();
        input.push({
          role: "user",
          // Persistent clients normally append this description to `content` before the neutral message is
          // recorded. Include it here only when an older/custom caller supplied the structured field without
          // doing so, so a stateless Responses replay never silently drops the already-paid-for image context.
          content: [message.content, ...(
            description && !message.content.includes(description)
              ? [`[Attached image description]\n${description}`]
              : description
                ? []
                : [TEXT_ONLY_IMAGE_NOTE]
          )]
            .filter(Boolean)
            .join("\n\n"),
        });
        continue;
      }

      const parts: any[] = [];
      if (message.content) parts.push({ type: "input_text", text: message.content });
      for (const image of message.images) {
        const data = imageToBase64(image.path);
        if (data) {
          parts.push({
            type: "input_image",
            image_url: `data:${image.mediaType};base64,${data}`,
            detail: "auto",
          });
        }
      }
      input.push({ role: "user", content: parts.length ? parts : message.content });
      continue;
    }

    if (message.role === "assistant") {
      if (message.continuation?.type === "responses_reasoning") {
        input.push(...message.continuation.items);
      }
      if (message.text.trim()) input.push({ role: "assistant", content: message.text });
      for (const toolUse of message.toolUses) {
        input.push({
          type: "function_call",
          call_id: toolUse.id,
          name: toolUse.name,
          arguments: JSON.stringify(toolUse.input ?? {}),
        });
      }
      continue;
    }

    for (const result of message.results) {
      input.push({
        type: "function_call_output",
        call_id: result.id,
        output: result.isError ? `ERROR: ${result.content}` : result.content,
      });
    }
  }
  return input;
}

type PendingFunctionCall = {
  key: string;
  index: number;
  id: string;
  name: string;
  args: string;
};

type PendingReasoningItem = {
  key: string;
  index: number;
  item: ResponsesReasoningItem;
};

function reasoningParts<Type extends "reasoning_text" | "summary_text">(
  value: unknown,
  type: Type,
): Array<{ type: Type; text: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const candidate = part as Record<string, unknown>;
    return candidate.type === type && typeof candidate.text === "string"
      ? [{ type, text: candidate.text }]
      : [];
  });
}

function normalizedReasoningItem(item: any, fallbackId: string): ResponsesReasoningItem | null {
  if (!item || item.type !== "reasoning") return null;
  const id = typeof item.id === "string" && item.id ? item.id : fallbackId;
  if (!id) return null;
  const summary = reasoningParts(item.summary, "summary_text");
  const content = reasoningParts(item.content, "reasoning_text");
  const encrypted = typeof item.encrypted_content === "string" || item.encrypted_content === null
    ? item.encrypted_content
    : undefined;
  if (!summary.length && !content.length && encrypted === undefined) {
    return { type: "reasoning", id, summary: [] };
  }
  return {
    type: "reasoning",
    id,
    summary,
    ...(content.length ? { content } : {}),
    ...(encrypted !== undefined ? { encrypted_content: encrypted } : {}),
    ...(["in_progress", "completed", "incomplete"].includes(item.status) ? { status: item.status } : {}),
  };
}

function itemKey(event: any, item?: any): string {
  return String(event?.item_id ?? item?.id ?? `output:${event?.output_index ?? 0}`);
}

function incompleteReason(response: any): string {
  const reason = response?.incomplete_details?.reason;
  return reason
    ? `Responses generation was incomplete (${reason}). Increase the output allowance or ask the model to split large edits into smaller tool calls.`
    : "Responses generation was incomplete. Ask the model to split large edits into smaller tool calls and retry.";
}

/** OpenAI Responses transport. It intentionally uses neither response ids nor server-side storage: this
 * keeps the same durable-history semantics across OpenAI-compatible providers and is required by
 * DeepSeek's stateless Responses implementation. */
export function createResponsesProvider(opts: {
  apiKey: string;
  model: string;
  baseURL?: string;
  label?: string;
  reasoningEffort?: Effort;
  reasoningStyle?: ReasoningStyle;
  supportsImages?: boolean;
  /** Explicit persistence policy for compatible Responses endpoints. Alibaba defaults to storing a
   * response for seven days; Hara owns durable history locally and therefore disables it there. */
  store?: boolean;
  /** Alibaba's opt-in server-side Session cache. It lowers repeat-prefix latency/usage without making
   * Hara depend on an expiring previous_response_id. Never send this vendor header to other endpoints. */
  dashscopeSessionCache?: boolean;
  /** The thinking level was chosen by the engine, not by a user or rule, so an endpoint that rejects the
   * field may be retried without it. Absent (the default) keeps an explicit choice failing visibly. */
  reasoningAdvisory?: boolean;
  omitAuthorization?: boolean;
  fetch?: typeof fetch;
}): Provider {
  const defaultHeaders: Record<string, string | null> = {};
  if (opts.omitAuthorization) defaultHeaders.Authorization = null;
  if (opts.dashscopeSessionCache) defaultHeaders["x-dashscope-session-cache"] = "enable";
  const client = new OpenAI({
    apiKey: opts.apiKey,
    maxRetries: 4,
    ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    ...(Object.keys(defaultHeaders).length ? { defaultHeaders } : {}),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });

  return {
    id: opts.label ?? "openai",
    model: opts.model,
    async turn({ system, history, tools, onText, onReasoning, onActivity, signal }: TurnArgs): Promise<TurnResult> {
      const responseTools = tools.map((tool) => ({
        type: "function" as const,
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      }));
      const params: any = {
        model: opts.model,
        instructions: system,
        input: toResponsesInput(history, opts.supportsImages !== false),
        max_output_tokens: 32000,
        stream: true,
      };
      if (opts.store !== undefined) params.store = opts.store;
      if (responseTools.length) params.tools = responseTools;
      // An explicit thinking choice is a latency/cost contract. If an endpoint rejects the field, surface
      // the error instead of retrying without it and silently turning the provider default back on. Only an
      // engine-chosen level is advisory enough to drop — nobody asked for it, so a plain request beats a
      // failed one.
      const reasoningStyle = opts.reasoningStyle ?? "reasoning_object";
      const reasoningRoute = reasoningRouteKey(opts.label, opts.baseURL, opts.model, reasoningStyle);
      const reasoningKeys = applyReasoningParams(
        params,
        reasoningParams(reasoningStyle, opts.reasoningEffort, opts.model),
        reasoningRoute,
      );

      let text = "";
      let usage = { input: 0, output: 0 };
      let terminal: "completed" | "incomplete" | "failed" | undefined;
      let terminalResponse: any;
      let streamFailure: string | undefined;
      let lastSequenceNumber = -1;
      const calls = new Map<string, PendingFunctionCall>();
      const reasoningItems = new Map<string, PendingReasoningItem>();
      const reasoningText = new Map<string, string>();
      const textDeltaItems = new Set<string>();
      const completedTextItems = new Set<string>();

      const acceptText = (value: unknown, key: string) => {
        if (typeof value !== "string" || !value || completedTextItems.has(key)) return;
        text += value;
        onText(value);
      };
      const acceptFunctionItem = (event: any, item: any, replaceArgs = false) => {
        if (!item || item.type !== "function_call") return;
        const key = itemKey(event, item);
        const current = calls.get(key) ?? {
          key,
          index: Number(event?.output_index ?? calls.size),
          id: "",
          name: "",
          args: "",
        };
        if (item.call_id) current.id = String(item.call_id);
        if (item.name) current.name = String(item.name);
        if (typeof item.arguments === "string" && (replaceArgs || !current.args)) {
          current.args = item.arguments;
        }
        calls.set(key, current);
      };
      const acceptReasoningItem = (event: any, item: any) => {
        if (!item || item.type !== "reasoning") return;
        const key = itemKey(event, item);
        const normalized = normalizedReasoningItem(item, key);
        if (!normalized) return;
        const streamed = reasoningText.get(key);
        if (streamed && !(normalized.content?.length)) {
          normalized.content = [{ type: "reasoning_text", text: streamed }];
        }
        reasoningItems.set(key, {
          key,
          index: Number(event?.output_index ?? reasoningItems.size),
          item: normalized,
        });
      };
      const recoverTerminalOutput = (response: any) => {
        for (const [outputIndex, item] of (response?.output ?? []).entries()) {
          const event = { item_id: item?.id, output_index: outputIndex };
          if (item?.type === "reasoning") {
            acceptReasoningItem(event, item);
            continue;
          }
          if (item?.type === "function_call") {
            acceptFunctionItem(event, item, true);
            continue;
          }
          if (item?.type !== "message") continue;
          const key = itemKey(event, item);
          if (textDeltaItems.has(key) || completedTextItems.has(key)) continue;
          for (const part of item.content ?? []) {
            if (part?.type === "output_text") acceptText(part.text, key);
          }
          completedTextItems.add(key);
        }
      };

      try {
        const stream = await sendWithReasoningFallback(
          reasoningRoute,
          params,
          reasoningKeys,
          (body) => client.responses.create(body as typeof params, { signal }),
          { allowRemoval: opts.reasoningAdvisory === true },
        );
        for await (const event of stream as any) {
          onActivity?.();
          if (Number.isInteger(event?.sequence_number)) {
            if (event.sequence_number <= lastSequenceNumber) {
              streamFailure = "Responses stream sequence_number was not strictly increasing.";
              break;
            }
            lastSequenceNumber = event.sequence_number;
          }
          if (terminal) {
            streamFailure = `Responses stream emitted ${String(event?.type ?? "an unknown event")} after response.${terminal}.`;
            break;
          }
          switch (event?.type) {
            case "response.output_text.delta": {
              const key = itemKey(event);
              textDeltaItems.add(key);
              acceptText(event.delta, key);
              break;
            }
            case "response.output_text.done": {
              const key = itemKey(event);
              if (!textDeltaItems.has(key)) acceptText(event.text, key);
              completedTextItems.add(key);
              break;
            }
            case "response.reasoning_text.delta": {
              const key = itemKey(event);
              if (typeof event.delta === "string") {
                reasoningText.set(key, (reasoningText.get(key) ?? "") + event.delta);
                const pending = reasoningItems.get(key);
                if (pending) pending.item.content = [{ type: "reasoning_text", text: reasoningText.get(key)! }];
              }
              if (opts.reasoningEffort !== "off" && typeof event.delta === "string") {
                onReasoning?.(event.delta);
              }
              break;
            }
            case "response.reasoning_summary_text.delta":
              if (opts.reasoningEffort !== "off" && typeof event.delta === "string") {
                onReasoning?.(event.delta);
              }
              break;
            case "response.output_item.added":
              acceptFunctionItem(event, event.item);
              acceptReasoningItem(event, event.item);
              break;
            case "response.function_call_arguments.delta": {
              const key = itemKey(event);
              const current = calls.get(key) ?? {
                key,
                index: Number(event.output_index ?? calls.size),
                id: "",
                name: "",
                args: "",
              };
              if (typeof event.delta === "string") current.args += event.delta;
              calls.set(key, current);
              break;
            }
            case "response.function_call_arguments.done": {
              const key = itemKey(event);
              const current = calls.get(key) ?? {
                key,
                index: Number(event.output_index ?? calls.size),
                id: "",
                name: "",
                args: "",
              };
              if (typeof event.name === "string") current.name = event.name;
              if (typeof event.arguments === "string") current.args = event.arguments;
              calls.set(key, current);
              break;
            }
            case "response.output_item.done":
              acceptFunctionItem(event, event.item, true);
              acceptReasoningItem(event, event.item);
              break;
            case "response.completed":
              terminal = "completed";
              terminalResponse = event.response;
              recoverTerminalOutput(event.response);
              break;
            case "response.incomplete":
              terminal = "incomplete";
              terminalResponse = event.response;
              recoverTerminalOutput(event.response);
              break;
            case "response.failed":
              terminal = "failed";
              terminalResponse = event.response;
              recoverTerminalOutput(event.response);
              break;
            case "error":
              streamFailure = safeProviderErrorMessage(
                event?.error?.message ?? event?.message,
                [opts.apiKey],
                "Responses stream failed.",
              );
              break;
          }
          if (streamFailure) break;
        }
      } catch (error: any) {
        if (signal?.aborted) return { text: "", toolUses: [], stop: "error", errorMsg: "interrupted" };
        const networkFailure = safeModelNetworkFailureMessage(error);
        return {
          text: "",
          toolUses: [],
          stop: "error",
          errorMsg: networkFailure ?? safeProviderErrorMessage(error, [opts.apiKey]),
        };
      }

      if (terminalResponse?.usage) {
        usage = {
          input: terminalResponse.usage.input_tokens ?? 0,
          output: terminalResponse.usage.output_tokens ?? 0,
        };
      }
      if (streamFailure) return { text, toolUses: [], stop: "error", errorMsg: streamFailure, usage };
      if (!terminal) {
        return {
          text,
          toolUses: [],
          stop: "error",
          errorMsg: "Responses stream ended before response.completed/response.incomplete/response.failed.",
          usage,
        };
      }
      if (terminal === "failed") {
        const message = safeProviderErrorMessage(
          terminalResponse?.error?.message,
          [opts.apiKey],
          "Responses generation failed.",
        );
        return { text, toolUses: [], stop: "error", errorMsg: message, usage };
      }

      const orderedCalls = [...calls.values()]
        .sort((a, b) => a.index - b.index)
        .map(({ id, name, args }) => ({ id, name, args }));
      const assembled = assembleToolCalls(orderedCalls, terminal === "incomplete" ? "length" : undefined);
      if (assembled.error) {
        return { text, toolUses: [], stop: "error", errorMsg: assembled.error, usage };
      }
      if (terminal === "incomplete") {
        return { text, toolUses: [], stop: "error", errorMsg: incompleteReason(terminalResponse), usage };
      }
      const stop = assembled.toolUses.length ? "tool_use" : "end";
      // Stateless Responses requires completed reasoning output items to be included in the next request.
      // Keep them only for actionable tool-call turns; final-answer reasoning never enters durable history.
      const continuationItems = [...reasoningItems.values()]
        .sort((left, right) => left.index - right.index)
        .map(({ item }) => item)
        .filter((item) => item.content?.length || item.summary.length || item.encrypted_content !== undefined);
      return {
        text,
        toolUses: assembled.toolUses as ToolUse[],
        stop,
        usage,
        ...(assembled.toolUses.length && continuationItems.length
          ? { continuation: { type: "responses_reasoning" as const, items: continuationItems } }
          : {}),
      };
    },
  };
}
