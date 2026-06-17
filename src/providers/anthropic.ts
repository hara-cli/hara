import Anthropic from "@anthropic-ai/sdk";
import type { Provider, NeutralMsg, TurnArgs, TurnResult } from "./types.js";

function toAnthropic(history: NeutralMsg[]): Anthropic.MessageParam[] {
  const msgs: Anthropic.MessageParam[] = [];
  for (const m of history) {
    if (m.role === "user") {
      msgs.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      const content: Anthropic.ContentBlockParam[] = [];
      if (m.text) content.push({ type: "text", text: m.text });
      for (const tu of m.toolUses) content.push({ type: "tool_use", id: tu.id, name: tu.name, input: tu.input });
      msgs.push({ role: "assistant", content: content.length ? content : [{ type: "text", text: "(no output)" }] });
    } else {
      msgs.push({
        role: "user",
        content: m.results.map((r) => ({
          type: "tool_result" as const,
          tool_use_id: r.id,
          content: r.content,
          is_error: r.isError,
        })),
      });
    }
  }
  return msgs;
}

export function createAnthropicProvider(opts: { apiKey: string; model: string; baseURL?: string }): Provider {
  const client = new Anthropic({ apiKey: opts.apiKey, ...(opts.baseURL ? { baseURL: opts.baseURL } : {}) });
  return {
    id: "anthropic",
    model: opts.model,
    async turn({ system, history, tools, onText }: TurnArgs): Promise<TurnResult> {
      const stream = client.messages.stream({
        model: opts.model,
        max_tokens: 32000,
        thinking: { type: "adaptive" },
        system,
        tools: tools as Anthropic.Tool[],
        messages: toAnthropic(history),
      });
      stream.on("text", onText);

      let msg: Anthropic.Message;
      try {
        msg = await stream.finalMessage();
      } catch (e) {
        const errorMsg = e instanceof Anthropic.APIError ? `${e.status ?? ""} ${e.message}` : String(e);
        return { text: "", toolUses: [], stop: "error", errorMsg };
      }

      const text = msg.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      const toolUses = msg.content
        .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
        .map((b) => ({ id: b.id, name: b.name, input: b.input }));
      const stop = msg.stop_reason === "tool_use" ? "tool_use" : "end";
      return { text, toolUses, stop };
    },
  };
}
