import OpenAI from "openai";
import type { Provider, NeutralMsg, ToolUse, TurnArgs, TurnResult } from "./types.js";
import { imageToBase64 } from "../images.js";

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

/** Reasoning models on OpenAI (o-series + gpt-5) accept `reasoning_effort` on chat-completions.
 *  Non-reasoning models reject it. We only attach the param when the model id matches a known
 *  reasoning family — keeps DeepSeek/GLM/Qwen requests clean. Exported for tests. */
export function isReasoningModel(model: string): boolean {
  return /^(o1|o3|o4|gpt-5)/i.test(model);
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
    async turn({ system, history, tools, onText, onReasoning, signal }: TurnArgs): Promise<TurnResult> {
      const oaiTools = tools.map((t) => ({
        type: "function" as const,
        function: { name: t.name, description: t.description, parameters: t.input_schema },
      }));
      const params: any = {
        model: opts.model,
        messages: toOpenAI(system, history),
        max_tokens: 8192,
        stream: true,
        stream_options: { include_usage: true },
      };
      if (oaiTools.length) params.tools = oaiTools;
      // reasoning_effort: only attach for OpenAI reasoning models, and only when the user picked a
      // non-default level. "off" means "don't ask the model to reason" — for reasoning models we
      // pass "minimal" (gpt-5 / o-series accept it); on chat-style models that put reasoning in
      // the stream (DeepSeek/GLM) we can't silence it server-side, so the UI just won't render.
      if (opts.reasoningEffort && opts.reasoningEffort !== undefined && isReasoningModel(opts.model)) {
        params.reasoning_effort = opts.reasoningEffort === "off" ? "minimal" : opts.reasoningEffort;
      }

      // Stream: emit text deltas live; accumulate tool-call args by index; grab usage from the tail chunk.
      let text = "";
      const acc = new Map<number, { id: string; name: string; args: string }>();
      let finish: string | undefined;
      let usage = { input: 0, output: 0 };
      try {
        const stream = await client.chat.completions.create(params, { signal });
        for await (const chunk of stream as any) {
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

      const toolUses: ToolUse[] = [...acc.values()]
        .filter((t) => t.id && t.name)
        .map((t) => {
          let input: any = {};
          try {
            input = JSON.parse(t.args || "{}");
          } catch {
            input = {};
          }
          return { id: t.id, name: t.name, input };
        });
      const stop = finish === "tool_calls" || toolUses.length ? "tool_use" : "end";
      return { text, toolUses, stop, usage };
    },
  };
}
