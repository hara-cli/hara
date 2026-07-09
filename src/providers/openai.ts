import OpenAI from "openai";
import type { Provider, NeutralMsg, ToolUse, TurnArgs, TurnResult } from "./types.js";
import { imageToBase64 } from "../images.js";
import { reasoningParams } from "./reasoning.js";
import { resolvePlatform } from "./registry.js";

/** Assemble streamed tool-call fragments into tool uses. CRITICAL: non-empty arguments that don't parse
 *  mean the model was cut off MID tool-call (almost always the output-length limit on a big write_file /
 *  bash). Silently substituting `{}` makes the model loop forever — it calls write_file with no path, bash
 *  with `command: undefined` (`/bin/sh: undefined: command not found`), sees the failure, and retries,
 *  never realizing its OUTPUT was truncated. So we surface it as an actionable error instead. Exported for
 *  tests. */
export function assembleToolCalls(
  entries: { id: string; name: string; args: string }[],
  finish?: string,
): { toolUses: ToolUse[]; error?: string } {
  let truncated = false;
  const toolUses: ToolUse[] = entries
    .filter((t) => t.id && t.name)
    .map((t) => {
      let input: any = {};
      const raw = (t.args || "").trim();
      if (raw) {
        try {
          input = JSON.parse(raw);
        } catch {
          truncated = true;
        }
      }
      return { id: t.id, name: t.name, input };
    });
  if (truncated) {
    const why = finish === "length" ? "the model hit its output-length limit mid tool-call" : "the model emitted malformed tool-call arguments";
    return { toolUses: [], error: `Tool call dropped — ${why}, so its arguments were incomplete. For a large file, write it in smaller parts (several write_file/edit calls) rather than one giant call.` };
  }
  return { toolUses };
}

// Re-exported for callers that still import it from here (the reasoning-family check now lives in reasoning.ts).
export { isReasoningModel } from "./reasoning.js";

/** Build OpenAI chat-completions messages from neutral history. */
export function toOpenAI(system: string, history: NeutralMsg[]): any[] {
  const msgs: any[] = [{ role: "system", content: system }];
  for (const m of history) {
    if (m.role === "user") {
      if (m.images?.length) {
        // multimodal content parts: text + image_url data URLs (Qwen-VL / GLM-4V / OpenAI vision)
        const parts: any[] = [];
        if (m.content) parts.push({ type: "text", text: m.content });
        for (const img of m.images) {
          const data = imageToBase64(img.path);
          if (data) parts.push({ type: "image_url", image_url: { url: `data:${img.mediaType};base64,${data}` } });
        }
        msgs.push({ role: "user", content: parts.length ? parts : m.content });
      } else {
        msgs.push({ role: "user", content: m.content });
      }
    } else if (m.role === "assistant") {
      const tool_calls = m.toolUses.map((tu) => ({
        id: tu.id,
        type: "function",
        function: { name: tu.name, arguments: JSON.stringify(tu.input ?? {}) },
      }));
      msgs.push({
        role: "assistant",
        content: m.text || null,
        ...(tool_calls.length ? { tool_calls } : {}),
      });
    } else {
      for (const r of m.results) {
        msgs.push({
          role: "tool",
          tool_call_id: r.id,
          content: r.isError ? `ERROR: ${r.content}` : r.content,
        });
      }
    }
  }
  return msgs;
}

/** OpenAI-compatible provider (works with OpenAI, Qwen/DashScope, GLM, Kimi, …). */
export function createOpenAIProvider(opts: {
  apiKey: string;
  model: string;
  baseURL?: string;
  label?: string;
  reasoningEffort?: "off" | "low" | "medium" | "high";
}): Provider {
  const client = new OpenAI({ apiKey: opts.apiKey, maxRetries: 4, ...(opts.baseURL ? { baseURL: opts.baseURL } : {}) });
  return {
    id: opts.label ?? "openai",
    model: opts.model,
    async turn({ system, history, tools, onText, onReasoning, onActivity, signal }: TurnArgs): Promise<TurnResult> {
      const oaiTools = tools.map((t) => ({
        type: "function" as const,
        function: { name: t.name, description: t.description, parameters: t.input_schema },
      }));
      const params: any = {
        model: opts.model,
        messages: toOpenAI(system, history),
        max_tokens: 32000, // was 8192 — too small: a big write_file's args got truncated → unparseable → loop
        stream: true,
        stream_options: { include_usage: true },
      };
      if (oaiTools.length) params.tools = oaiTools;
      // Reasoning: the registry says HOW this platform expresses the thinking dial (DashScope →
      // enable_thinking, OpenAI reasoning models → reasoning_effort, …); the applier turns hara's dial
      // into the params to merge. UNSET → {} (model default, zero impact). One data-driven line replaces
      // the old per-platform if/else — a new platform is a registry row, not code here.
      const caps = resolvePlatform(opts.label, opts.baseURL);
      Object.assign(params, reasoningParams(caps.reasoning, opts.reasoningEffort, opts.model));

      // Stream: emit text deltas live; accumulate tool-call args by index; grab usage from the tail chunk.
      let text = "";
      const acc = new Map<number, { id: string; name: string; args: string }>();
      let finish: string | undefined;
      let usage = { input: 0, output: 0 };
      try {
        const stream = await client.chat.completions.create(params, { signal });
        for await (const chunk of stream as any) {
          onActivity?.(); // ANY chunk (reasoning, tool-args, content, even a keep-alive) → the model is alive
          const choice = chunk.choices?.[0];
          const delta = choice?.delta;
          if (delta?.content) {
            text += delta.content;
            onText(delta.content);
          }
          const rc = (delta as any)?.reasoning_content ?? (delta as any)?.reasoning; // GLM-5 / DeepSeek
          // reasoningEffort="off" + a stream-reasoning model: server can't be silenced, so we just
          // don't surface it. Anything else (incl. undefined) shows the reasoning live.
          if (rc && opts.reasoningEffort !== "off") onReasoning?.(rc);
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              const cur = acc.get(idx) ?? { id: "", name: "", args: "" };
              if (tc.id) cur.id = tc.id;
              if (tc.function?.name) cur.name = tc.function.name;
              if (tc.function?.arguments) cur.args += tc.function.arguments;
              acc.set(idx, cur);
            }
          }
          if (choice?.finish_reason) finish = choice.finish_reason;
          if (chunk.usage) usage = { input: chunk.usage.prompt_tokens ?? 0, output: chunk.usage.completion_tokens ?? 0 };
        }
      } catch (e: any) {
        if (signal?.aborted) return { text: "", toolUses: [], stop: "error", errorMsg: "interrupted" };
        return { text: "", toolUses: [], stop: "error", errorMsg: `${e?.status ?? ""} ${e?.message ?? e}` };
      }

      const { toolUses, error: argsError } = assembleToolCalls([...acc.values()], finish);
      if (argsError) return { text, toolUses: [], stop: "error", errorMsg: argsError, usage };
      const stop = finish === "tool_calls" || toolUses.length ? "tool_use" : "end";
      return { text, toolUses, stop, usage };
    },
  };
}
