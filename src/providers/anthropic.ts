import Anthropic from "@anthropic-ai/sdk";
import type { Provider, NeutralMsg, SystemPromptPart, TurnArgs, TurnResult } from "./types.js";
import { imageToBase64 } from "../images.js";

export function toAnthropic(history: NeutralMsg[]): Anthropic.MessageParam[] {
  const msgs: Anthropic.MessageParam[] = [];
  // Append a user message, merging into the previous one if it's also `user` — Anthropic requires
  // alternating roles, and tool-results map to a user message, so a mid-turn-injected user message
  // (type-ahead steering) lands right after one. Merging keeps the request valid; dormant otherwise.
  const pushUser = (content: string | Anthropic.ContentBlockParam[]): void => {
    const last = msgs[msgs.length - 1];
    if (last && last.role === "user") {
      const toBlocks = (c: typeof last.content): Anthropic.ContentBlockParam[] =>
        typeof c === "string" ? [{ type: "text", text: c }] : c;
      last.content = [...toBlocks(last.content), ...toBlocks(content)];
    } else {
      msgs.push({ role: "user", content });
    }
  };
  for (const m of history) {
    if (m.role === "user") {
      if (m.images?.length) {
        const blocks: Anthropic.ContentBlockParam[] = [];
        if (m.content) blocks.push({ type: "text", text: m.content });
        for (const img of m.images) {
          const data = imageToBase64(img.path);
          if (data) blocks.push({ type: "image", source: { type: "base64", media_type: img.mediaType as Anthropic.Base64ImageSource["media_type"], data } });
        }
        pushUser(blocks.length ? blocks : m.content);
      } else {
        pushUser(m.content);
      }
    } else if (m.role === "assistant") {
      const content: Anthropic.ContentBlockParam[] = [];
      if (m.text) content.push({ type: "text", text: m.text });
      for (const tu of m.toolUses) content.push({ type: "tool_use", id: tu.id, name: tu.name, input: tu.input });
      msgs.push({ role: "assistant", content: content.length ? content : [{ type: "text", text: "(no output)" }] });
    } else {
      pushUser(
        m.results.map((r) => ({
          type: "tool_result" as const,
          tool_use_id: r.id,
          content: r.content,
          is_error: r.isError,
        })),
      );
    }
  }
  return msgs;
}

const CACHE = { type: "ephemeral" as const };

/** Attach Anthropic prompt-cache breakpoints so each turn re-reads the static prefix and the
 *  conversation prefix FROM CACHE instead of re-billing + re-processing the whole prompt — the single
 *  biggest latency + cost win as history grows (uncached, a long session pays full input every turn).
 *
 *  Anthropic caps breakpoints at 4 and orders the cache prefix `tools → system → messages`. Structured Hara
 *  prompts spend up to two marks on the static and session boundaries, leaving the changing turn suffix
 *  uncached; legacy strings keep one system mark. We then spend up to two rolling marks near the message
 *  tail: the last message (so THIS turn's full prefix is written) and one ~2 back (so the NEXT turn — which
 *  appends new messages — still finds a long cached prefix to read).
 *  Mutates `messages` in place (toAnthropic hands us a fresh array each turn); returns the request-shaped
 *  system. Exported pure for tests. */
export function applyCacheControl(
  system: string,
  messages: Anthropic.MessageParam[],
  systemParts?: SystemPromptPart[],
): { system: string | Anthropic.TextBlockParam[]; messages: Anthropic.MessageParam[] } {
  const mark = (m: Anthropic.MessageParam): void => {
    if (typeof m.content === "string") {
      if (m.content.length) m.content = [{ type: "text", text: m.content, cache_control: CACHE }];
    } else if (m.content.length) {
      (m.content[m.content.length - 1] as { cache_control?: typeof CACHE }).cache_control = CACHE;
    }
  };
  const idxs = new Set<number>();
  if (messages.length) idxs.add(messages.length - 1);
  if (messages.length >= 3) idxs.add(messages.length - 3);
  for (const i of idxs) mark(messages[i]);
  // Only cache system when it's substantial enough to matter (an empty text block would 400).
  let cachedSystem: string | Anthropic.TextBlockParam[] = system;
  const renderedParts = systemParts?.map((part) => part.content).join("\n\n");
  if (system && systemParts?.length && renderedParts === system) {
    const sections: { stability: SystemPromptPart["stability"]; text: string }[] = [];
    for (const part of systemParts) {
      const tail = sections.at(-1);
      if (tail?.stability === part.stability) tail.text += `\n\n${part.content}`;
      else sections.push({ stability: part.stability, text: part.content });
    }
    cachedSystem = sections.map((section, index): Anthropic.TextBlockParam => ({
      type: "text",
      // Anthropic concatenates adjacent text blocks directly. Preserve the authoritative rendered string
      // byte-for-byte across our cache boundaries.
      text: section.text + (index < sections.length - 1 ? "\n\n" : ""),
      ...(section.stability === "turn" ? {} : { cache_control: CACHE }),
    }));
  } else if (system) {
    // Legacy/custom callers still receive the original single cached system block.
    cachedSystem = [{ type: "text", text: system, cache_control: CACHE }];
  }
  return { system: cachedSystem, messages };
}

/** Anthropic models whose only valid `thinking` setting is `{type: "adaptive"}` — they reject any
 *  explicit `budget_tokens`. We detect them by id family so "off"/low/high still degrade gracefully
 *  (we just omit the field or stay on adaptive instead of sending a 400-triggering body). */
function isAdaptiveOnly(model: string): boolean {
  // Known adaptive-only families per Anthropic docs: opus-4-7 / opus-4-8 / claude-fable.
  // Conservative: regex on the family slug so future micro-versions (opus-4-8-20260101) match.
  return /^(claude-)?(opus-4-7|opus-4-8|fable)/i.test(model) || /(opus-4-7|opus-4-8|fable)/i.test(model);
}

/** Map hara's reasoningEffort dial to Anthropic's `thinking` parameter (or omit it).
 *  Exported for unit testing. */
export function buildThinkingParam(model: string, effort?: "off" | "low" | "medium" | "high" | "max"):
  | { type: "enabled"; budget_tokens: number }
  | { type: "adaptive" }
  | undefined {
  // Unset = preserve hara's prior behavior (adaptive thinking on by default).
  if (effort === undefined) return { type: "adaptive" };
  if (effort === "off") return undefined; // omit thinking entirely (works on every model, incl. adaptive-only)
  const adaptiveOnly = isAdaptiveOnly(model);
  if (adaptiveOnly) return { type: "adaptive" }; // can't honor budget on these — fall back to adaptive instead of 400'ing
  if (effort === "low") return { type: "enabled", budget_tokens: 4096 };
  if (effort === "medium") return { type: "adaptive" };
  if (effort === "max") return { type: "enabled", budget_tokens: 32000 }; // top of the dial — biggest budget
  // high
  return { type: "enabled", budget_tokens: 24000 };
}

export function createAnthropicProvider(opts: { apiKey: string; model: string; baseURL?: string; reasoningEffort?: "off" | "low" | "medium" | "high" | "max" }): Provider {
  const client = new Anthropic({ apiKey: opts.apiKey, maxRetries: 4, ...(opts.baseURL ? { baseURL: opts.baseURL } : {}) });
  return {
    id: "anthropic",
    model: opts.model,
    async turn({ system, systemParts, history, tools, onText, onReasoning, signal }: TurnArgs): Promise<TurnResult> {
      const thinking = buildThinkingParam(opts.model, opts.reasoningEffort);
      const { system: cachedSystem, messages } = applyCacheControl(system, toAnthropic(history), systemParts);
      const stream = client.messages.stream(
        {
          model: opts.model,
          max_tokens: 32000,
          ...(thinking ? { thinking } : {}),
          system: cachedSystem,
          tools: tools as Anthropic.Tool[],
          messages,
        },
        { signal },
      );
      stream.on("text", onText);
      if (onReasoning) (stream as any).on("thinking", onReasoning); // thinking deltas (if emitted)

      let msg: Anthropic.Message;
      try {
        msg = await stream.finalMessage();
      } catch (e) {
        if (signal?.aborted) return { text: "", toolUses: [], stop: "error", errorMsg: "interrupted" };
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
      // Cache-aware input accounting: Anthropic's input_tokens EXCLUDES cache reads/writes, so a
      // cached session under-reported context fullness badly (ctx% stayed tiny → auto-compact never
      // fired → overflow). Total context = fresh + cache_creation + cache_read (CC's zY5 equivalent).
      const u = msg.usage as { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } | undefined;
      const usage = { input: (u?.input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0), output: u?.output_tokens ?? 0 };
      return { text, toolUses, stop, usage };
    },
  };
}
