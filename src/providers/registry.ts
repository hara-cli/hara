// Provider registry — THE dictionary. One row per platform declares how to talk to it: the wire protocol,
// how it expresses the thinking dial, and how it caches. Adding a platform (a new Aliyun plan, a new
// OpenAI-compatible vendor) is a row here, not scattered if/else across the provider code. The transports
// (chat / responses / anthropic) and the reasoning styles (reasoning.ts) are the finite reusable pieces
// the rows point at.
import type { ReasoningStyle } from "./reasoning.js";

/** The wire protocol used to talk to a platform (which transport builds the request + reads the stream). */
export type WireApi = "chat" | "responses" | "anthropic";

/** How a platform caches the prompt prefix (informational + drives whether we set cache_control):
 *  - `auto`          — the server caches a stable prefix on its own (OpenAI, DashScope) — nothing to send.
 *  - `cache_control` — explicit Anthropic breakpoints (we set them, see anthropic.ts applyCacheControl).
 *  - `none`          — no prompt caching. */
export type CacheMode = "auto" | "cache_control" | "none";

export interface PlatformCaps {
  /** Wire protocol → transport. */
  wireApi: WireApi;
  /** How the thinking dial is expressed (reasoning.ts). */
  reasoning: ReasoningStyle;
  /** Prefix caching behavior. */
  cache: CacheMode;
}

/** Base capabilities per wire protocol (the sensible default before per-platform overrides). */
const BY_WIRE: Record<WireApi, PlatformCaps> = {
  chat: { wireApi: "chat", reasoning: "reasoning_effort", cache: "auto" },
  responses: { wireApi: "responses", reasoning: "reasoning_object", cache: "auto" },
  anthropic: { wireApi: "anthropic", reasoning: "thinking_budget", cache: "cache_control" },
};

/** Endpoint-shape rules, matched against the baseURL. FIRST match wins — most specific first. This is what
 *  makes a *custom* profile (e.g. `custom:qwen3.7-plus` pointing at coding.dashscope) resolve correctly
 *  without the user declaring a provider id: the DashScope host implies chat + enable_thinking. */
const BY_BASEURL: { test: RegExp; caps: PlatformCaps }[] = [
  // Alibaba Token Plan — OpenAI-compatible; new models use the Responses API.
  { test: /token-plan.*maas\.aliyuncs\.com\/compatible-mode/i, caps: { wireApi: "responses", reasoning: "reasoning_object", cache: "auto" } },
  // Alibaba DashScope — OpenAI-compatible chat (coding plan /v1, pay-as-you-go /compatible-mode): the key
  // difference is `enable_thinking`, which actually turns Qwen/GLM thinking off (the DashScope speedup).
  { test: /dashscope\.aliyuncs\.com\/(v1|compatible-mode)|maas\.aliyuncs\.com\/compatible-mode/i, caps: { wireApi: "chat", reasoning: "enable_thinking", cache: "auto" } },
  // Local Ollama (OpenAI-compat, default port 11434): `think` toggles a local reasoning model's thinking
  // (measured deepseek-r1:14b 17s → 0.6s); no cache. LM Studio (1234) is the same shape.
  { test: /(localhost|127\.0\.0\.1|0\.0\.0\.0):(11434|1234)/i, caps: { wireApi: "chat", reasoning: "ollama_think", cache: "none" } },
  // ANY vendor's Anthropic-compatible endpoint (path ends in /anthropic): DeepSeek, Kimi/Moonshot, Zhipu
  // GLM, MiniMax, Aliyun apps/anthropic … all expose `.../anthropic` with thinking + explicit cache. One
  // row covers the whole ecosystem — talk to it with the anthropic transport.
  { test: /\/anthropic\/?($|\?)/i, caps: { wireApi: "anthropic", reasoning: "thinking_budget", cache: "cache_control" } },
  // DeepSeek OpenAI-compatible (chat): DeepSeek V4 (v4-pro/v4-flash) exposes a per-request thinking switch
  // (`thinking: {type}`) + `reasoning_effort` (high|max) on this path — the `deepseek` style sends both.
  { test: /api\.deepseek\.com/i, caps: { wireApi: "chat", reasoning: "deepseek", cache: "auto" } },
];

/** Per-provider-id overrides (built-in providers whose id alone fixes the shape). */
const BY_PROVIDER: Record<string, Partial<PlatformCaps>> = {
  anthropic: { wireApi: "anthropic", reasoning: "thinking_budget", cache: "cache_control" },
  qwen: { wireApi: "chat", reasoning: "enable_thinking", cache: "auto" }, // DashScope
  "qwen-oauth": { wireApi: "chat", reasoning: "enable_thinking", cache: "auto" },
  glm: { wireApi: "chat", reasoning: "none", cache: "auto" }, // Zhipu native /paas/v4 — different thinking param; leave alone (its /anthropic endpoint resolves via baseURL)
  deepseek: { wireApi: "chat", reasoning: "deepseek", cache: "auto" }, // V4: thinking:{type} + reasoning_effort(high|max)
  ollama: { wireApi: "chat", reasoning: "ollama_think", cache: "none" }, // local; `think` toggles reasoning
  openai: { wireApi: "chat", reasoning: "reasoning_effort", cache: "auto" },
  openrouter: { wireApi: "chat", reasoning: "none", cache: "auto" },
  "hara-gateway": { wireApi: "chat", reasoning: "none", cache: "auto" },
};

/** Resolve a platform's capabilities from (provider id, baseURL, explicit wireApi override). Precedence:
 *  an explicit `wireApi` from config wins the transport; then the baseURL shape (so custom DashScope/
 *  token-plan/anthropic endpoints Just Work); then the provider-id override; else the wire default. */
export function resolvePlatform(providerId?: string, baseURL?: string, wireApiOverride?: WireApi): PlatformCaps {
  // baseURL shape is the strongest signal for a custom profile; else the provider-id override; else chat.
  const byUrl = baseURL ? BY_BASEURL.find((r) => r.test.test(baseURL))?.caps : undefined;
  const byProv = providerId ? BY_PROVIDER[providerId] : undefined;
  const resolved: PlatformCaps = byUrl ?? { ...BY_WIRE.chat, ...(byProv ?? {}) };
  // An explicit wireApi from config wins the transport. When it changes the wire, the reasoning style
  // follows that wire's default (reasoning is wire-dependent — reasoning_effort on chat vs reasoning_object
  // on responses); cache is kept from the resolved row (it tracks the endpoint, not the wire).
  if (wireApiOverride && wireApiOverride !== resolved.wireApi) {
    return { ...resolved, wireApi: wireApiOverride, reasoning: BY_WIRE[wireApiOverride].reasoning };
  }
  return resolved;
}
