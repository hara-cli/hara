// Provider-facing context normalization. Durable history stays exact; each model request receives a bounded
// snapshot so old tool output, tool-call payloads, and images cannot crowd out the current task. Inspired by
// Codex's ContextManager normalization and OpenClaw's tool-result context guard.
import type { NeutralMsg, ToolSpec, ToolUse } from "../providers/types.js";
import { contextWindow } from "../statusbar.js";

export const MAX_MODEL_HISTORY_CHARS = 600_000;
export const MIN_MODEL_HISTORY_CHARS = 48_000;
export const MAX_USER_ITEM_CHARS = 64_000;
export const MAX_ASSISTANT_ITEM_CHARS = 24_000;
export const MAX_TOOL_INPUT_STRING_CHARS = 12_000;
export const RECENT_IMAGE_TURNS = 2;

const GUARD_NOTE =
  "[Hara context guard: older/oversized context was bounded for this model request. The durable transcript is unchanged. " +
  "Prefer current task state and recent messages; re-read files or ask the user before relying on an omitted exact value.]";

export interface PreparedHistory {
  history: NeutralMsg[];
  changed: boolean;
  originalChars: number;
  preparedChars: number;
  budgetChars: number;
  omittedImages: number;
}

interface PrepareOptions {
  model: string;
  system?: string;
  tools?: ToolSpec[];
  /** Tests and overflow retry can impose a tighter ceiling. */
  maxChars?: number;
  budgetScale?: number;
}

function jsonChars(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return 1_000;
  }
}

export function historyChars(history: NeutralMsg[]): number {
  let total = 0;
  for (const message of history) {
    if (message.role === "user") {
      total += message.content.length + (message.images?.reduce((sum, image) => sum + image.path.length + image.mediaType.length + 64, 0) ?? 0);
    } else if (message.role === "assistant") {
      total += message.text.length + jsonChars(message.toolUses);
    } else {
      total += message.results.reduce((sum, result) => sum + result.content.length + result.id.length + result.name.length + 32, 0);
    }
  }
  return total;
}

export function modelHistoryBudget(options: PrepareOptions): number {
  if (options.maxChars !== undefined) return Math.max(2_000, Math.floor(options.maxChars));
  // Use a conservative blended chars/token allowance: English commonly has more, while CJK/code can have
  // fewer. Reserve system/tool schema room and cap giant-window models at a responsive working set.
  const gross = Math.min(MAX_MODEL_HISTORY_CHARS, Math.floor(contextWindow(options.model) * 1.5));
  const overhead = (options.system?.length ?? 0) + jsonChars(options.tools ?? []);
  const scale = Math.max(0.2, Math.min(1, options.budgetScale ?? 1));
  return Math.max(MIN_MODEL_HISTORY_CHARS, Math.floor((gross - overhead) * scale));
}

function safeSliceEnd(value: string, end: number): string {
  let at = Math.max(0, Math.min(value.length, end));
  if (at > 0 && /[\uD800-\uDBFF]/.test(value[at - 1] ?? "")) at--;
  return value.slice(0, at);
}

function safeSliceStart(value: string, start: number): string {
  let at = Math.max(0, Math.min(value.length, start));
  if (at < value.length && /[\uDC00-\uDFFF]/.test(value[at] ?? "")) at++;
  return value.slice(at);
}

function clip(value: string, max: number, label: string): string {
  const cap = Math.max(0, Math.floor(max));
  if (value.length <= cap) return value;
  const marker = `\n…[hara: ${value.length - cap} chars omitted from ${label}]…\n`;
  if (marker.length >= cap) return marker.slice(0, cap);
  const room = cap - marker.length;
  const head = Math.floor(room * 0.6);
  const tail = room - head;
  return safeSliceEnd(value, head) + marker + safeSliceStart(value, value.length - tail);
}

function boundValue(value: unknown, stringCap: number, depth = 0): unknown {
  if (typeof value === "string") return clip(value, stringCap, "historical tool input");
  if (value === null || typeof value !== "object") return value;
  if (depth >= 8) return "[hara: nested historical tool input omitted]";
  if (Array.isArray(value)) {
    const kept = value.slice(0, 80).map((item) => boundValue(item, stringCap, depth + 1));
    if (value.length > kept.length) kept.push(`[hara: ${value.length - kept.length} array items omitted]`);
    return kept;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  const out: Record<string, unknown> = {};
  for (const [key, item] of entries.slice(0, 80)) out[key] = boundValue(item, stringCap, depth + 1);
  if (entries.length > 80) out._hara_omitted_keys = entries.length - 80;
  return out;
}

function boundToolUses(toolUses: ToolUse[], stringCap: number): ToolUse[] {
  // Never cap the call ARRAY independently: provider protocols require every following tool_result id to
  // have a matching tool_use. Payloads may shrink, or an entire old exchange may fall out of the suffix,
  // but identities within a retained exchange stay one-to-one.
  return toolUses.map((use) => ({ ...use, input: boundValue(use.input, stringCap) }));
}

function addGuard(history: NeutralMsg[]): NeutralMsg[] {
  return [{ role: "user", content: GUARD_NOTE }, ...history];
}

/** Create a bounded provider snapshot without mutating or deleting the durable transcript. Tool call/result
 *  identities and ordering remain intact; only model-visible payload text is clipped. */
export function prepareHistoryForModel(history: NeutralMsg[], options: PrepareOptions): PreparedHistory {
  const originalChars = historyChars(history);
  const budgetChars = modelHistoryBudget(options);
  const userIndices = history.flatMap((message, index) => message.role === "user" ? [index] : []);
  const latestUser = userIndices.at(-1) ?? -1;
  const recentUsers = new Set(userIndices.slice(-3));
  const imageUsers = new Set(userIndices.slice(-RECENT_IMAGE_TURNS));
  let changed = false;
  let omittedImages = 0;

  let snapshot: NeutralMsg[] = history.map((message, index): NeutralMsg => {
    if (message.role === "user") {
      const cap = index === latestUser ? MAX_USER_ITEM_CHARS : recentUsers.has(index) ? 40_000 : 20_000;
      let content = clip(message.content, cap, "user message");
      if (content !== message.content) changed = true;
      let images = message.images?.map((image) => ({ ...image }));
      if (images?.length && !imageUsers.has(index)) {
        omittedImages += images.length;
        content += `\n\n[hara: ${images.length} older image attachment(s) omitted from this model round; reattach if needed]`;
        images = undefined;
        changed = true;
      }
      return { role: "user", content, ...(images?.length ? { images } : {}) };
    }
    if (message.role === "assistant") {
      const text = clip(message.text, MAX_ASSISTANT_ITEM_CHARS, "assistant message");
      const toolUses = boundToolUses(message.toolUses, MAX_TOOL_INPUT_STRING_CHARS);
      if (text !== message.text || jsonChars(toolUses) !== jsonChars(message.toolUses)) changed = true;
      return { role: "assistant", text, toolUses };
    }
    const results = message.results.map((result) => {
      const content = clip(result.content, 24_000, `tool result ${result.name}`);
      if (content !== result.content) changed = true;
      return { ...result, content };
    });
    return { role: "tool", results };
  });

  const reduce = (toolCap: number, assistantCap: number, oldUserCap: number, recentUserCap: number, inputCap: number): void => {
    snapshot = snapshot.map((message, index): NeutralMsg => {
      if (message.role === "tool") {
        return { role: "tool", results: message.results.map((result) => ({ ...result, content: clip(result.content, toolCap, `tool result ${result.name}`) })) };
      }
      if (message.role === "assistant") {
        return { role: "assistant", text: clip(message.text, assistantCap, "assistant message"), toolUses: boundToolUses(message.toolUses, inputCap) };
      }
      const cap = index === latestUser ? Math.max(recentUserCap, 24_000) : recentUsers.has(index) ? recentUserCap : oldUserCap;
      return { ...message, content: clip(message.content, cap, "user message") };
    });
    changed = true;
  };

  if (historyChars(snapshot) + GUARD_NOTE.length > budgetChars) reduce(2_000, 4_000, 6_000, 16_000, 2_000);
  if (historyChars(snapshot) + GUARD_NOTE.length > budgetChars) reduce(512, 1_500, 1_500, 8_000, 768);
  if (historyChars(snapshot) + GUARD_NOTE.length > budgetChars) reduce(128, 512, 512, 4_000, 256);

  if (changed) snapshot = addGuard(snapshot);

  // Extremely long threads can exceed the ceiling through message structure alone. Retain the largest suffix
  // beginning at a user boundary. The durable thread remains available for explicit compaction/export.
  if (historyChars(snapshot) > budgetChars) {
    const starts = snapshot.flatMap((message, index) => message.role === "user" ? [index] : []).reverse();
    let suffix: NeutralMsg[] | null = null;
    for (const start of starts) {
      const candidate = snapshot.slice(start);
      if (historyChars(candidate) + GUARD_NOTE.length <= budgetChars) suffix = candidate;
      else if (suffix) break;
    }
    if (suffix) snapshot = addGuard(suffix[0]?.role === "user" && suffix[0].content === GUARD_NOTE ? suffix.slice(1) : suffix);
    else {
      const latest = [...snapshot].reverse().find((message) => message.role === "user");
      snapshot = [{ role: "user", content: `${GUARD_NOTE}\n\n${latest?.role === "user" ? clip(latest.content, Math.max(1_000, budgetChars - GUARD_NOTE.length - 8), "latest user message") : "Continue the active task from durable task state."}` }];
    }
    changed = true;
  }

  return { history: snapshot, changed, originalChars, preparedChars: historyChars(snapshot), budgetChars, omittedImages };
}
