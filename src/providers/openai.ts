import OpenAI from "openai";
import type { Provider, NeutralMsg, ToolUse, TurnArgs, TurnResult } from "./types.js";

/** Build OpenAI chat-completions messages from neutral history. */
function toOpenAI(system: string, history: NeutralMsg[]): any[] {
  const msgs: any[] = [{ role: "system", content: system }];
  for (const m of history) {
    if (m.role === "user") {
      msgs.push({ role: "user", content: m.content });
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
}): Provider {
  const client = new OpenAI({ apiKey: opts.apiKey, ...(opts.baseURL ? { baseURL: opts.baseURL } : {}) });
  return {
    id: opts.label ?? "openai",
    model: opts.model,
    async turn({ system, history, tools, onText }: TurnArgs): Promise<TurnResult> {
      const oaiTools = tools.map((t) => ({
        type: "function" as const,
        function: { name: t.name, description: t.description, parameters: t.input_schema },
      }));
      const params: any = {
        model: opts.model,
        messages: toOpenAI(system, history),
        max_tokens: 8192,
      };
      if (oaiTools.length) params.tools = oaiTools;

      let resp: any;
      try {
        resp = await client.chat.completions.create(params);
      } catch (e: any) {
        return { text: "", toolUses: [], stop: "error", errorMsg: `${e?.status ?? ""} ${e?.message ?? e}` };
      }

      const choice = resp.choices?.[0];
      const text: string = choice?.message?.content ?? "";
      if (text) onText(text);

      const toolUses: ToolUse[] = (choice?.message?.tool_calls ?? []).map((tc: any) => {
        let input: any = {};
        try {
          input = JSON.parse(tc.function?.arguments || "{}");
        } catch {
          input = {};
        }
        return { id: tc.id, name: tc.function?.name, input };
      });

      const stop = choice?.finish_reason === "tool_calls" || toolUses.length ? "tool_use" : "end";
      return { text, toolUses, stop };
    },
  };
}
