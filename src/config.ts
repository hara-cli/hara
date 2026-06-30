import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import type { SandboxMode } from "./sandbox.js";
import type { HooksConfig } from "./hooks.js";
import type { NotifyMode } from "./notify.js";

export type ProviderId = "anthropic" | "qwen" | "qwen-oauth" | "openai" | "glm" | "deepseek" | "openrouter" | "hara-gateway";
export type ApprovalMode = "suggest" | "auto-edit" | "full-auto";

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface HaraConfig {
  provider: ProviderId;
  apiKey: string | undefined;
  model: string;
  baseURL: string | undefined;
  approval: ApprovalMode;
  sandbox: SandboxMode;
  theme: "dark" | "light";
  evolve: "off" | "light" | "proactive";
  /** proactive code-asset capture at session end: off | ask (propose) | auto (save personal/project only). */
  assetCapture: "off" | "ask" | "auto";
  /** screen control (native): off (disabled) | read (screenshot only) | click (+pointer) | full (+keyboard). */
  computerUse: "off" | "read" | "click" | "full";
  /** apps the agent may click/type into (frontmost-window allowlist; empty = no interaction allowed). */
  computerApps: string[];
  /** Optional vision "sidecar": when set, pasted images are OCR'd/described by this model into text
   *  so a text-only main model (DeepSeek, coding models…) can use them. Endpoint/key default to the
   *  main provider's; override only if vision lives elsewhere. */
  visionModel: string | undefined;
  visionBaseURL: string | undefined;
  visionApiKey: string | undefined;
  /** Per-model vision-capability overrides the user has confirmed (model id → "yes"|"no"). Built-in
   *  detection (classifyVision) handles known families; this records answers for unknown ones so we
   *  ask at most once per model and stay correct when the main model is switched. */
  modelVision: Record<string, "yes" | "no">;
  /** Semantic index (opt-in): embedding provider for `hara index` + semantic codebase_search/recall.
   *  off = lexical only (default, zero new deps). ollama = local/offline; qwen = DashScope; openai = compatible. */
  embedProvider: "off" | "ollama" | "qwen" | "openai";
  embedModel: string | undefined;
  embedBaseURL: string | undefined;
  embedApiKey: string | undefined;
  /** Per-turn model routing (opt-in): trivial/non-coding turns route to `routeModel`; real coding/action
   *  turns stay on `model`. routeBaseURL/routeApiKey default to the primary's (same provider, diff model). */
  routeModel: string | undefined;
  routeBaseURL: string | undefined;
  routeApiKey: string | undefined;
  /** auto-compact the conversation when the last turn fills context past ~85% (à la Claude Code). default on. */
  autoCompact: boolean;
  /** shadow-git file checkpoints before each turn → `/checkpoint restore <n>` reverts the agent's edits. default on. */
  fileCheckpoints: boolean;
  /** App-level failover: on a recoverable turn error (overload / rate-limit / timeout / context-overflow),
   *  retry once on this model. baseURL/apiKey default to the primary's. Unset = no fallback. */
  fallbackModel: string | undefined;
  fallbackBaseURL: string | undefined;
  fallbackApiKey: string | undefined;
  /** Thinking/reasoning effort dial (provider-mapped):
   *   - unset    → each provider's default (anthropic = adaptive, openai = unset, etc.)
   *   - "off"    → no extended thinking; on adaptive-only Anthropic models we just omit `thinking`
   *   - "low"    → small budget (anthropic budget_tokens, openai reasoning_effort:"low")
   *   - "medium" → balanced (anthropic adaptive, openai reasoning_effort:"medium")
   *   - "high"   → large budget (anthropic budget_tokens up, openai reasoning_effort:"high")
   *  GLM/DeepSeek-style models put reasoning in the stream and can't be silenced here — "off" just
   *  means we don't render it (handled at the UI layer). */
  reasoningEffort: "off" | "low" | "medium" | "high" | undefined;
  /** lifecycle hooks (PreToolUse/PostToolUse) — shell commands run around tool calls */
  hooks: HooksConfig;
  /** ping when a (non-trivial) turn finishes: off | bell (terminal BEL) | system (OS notification + bell) */
  notify: NotifyMode;
  /** modal (vim) keybindings in the TUI input box (opt-in) */
  vimMode: boolean;
  mcpServers: Record<string, McpServerConfig>;
  cwd: string;
}

const PROVIDER_DEFAULTS: Record<ProviderId, { model: string; baseURL?: string; envKey: string }> = {
  anthropic: { model: "claude-opus-4-8", envKey: "ANTHROPIC_API_KEY" },
  qwen: {
    model: "qwen-plus",
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    envKey: "DASHSCOPE_API_KEY",
  },
  "qwen-oauth": { model: "coder-model", envKey: "QWEN_OAUTH_TOKEN" },
  openai: { model: "gpt-4o-mini", envKey: "OPENAI_API_KEY" },
  // GLM / DeepSeek / OpenRouter are OpenAI-compatible: buildProvider routes them through the
  // openai path (createOpenAIProvider) using the preset baseURL below. The preset baseURL is
  // applied by loadConfig (merged.baseURL ?? d.baseURL), so the setup wizard never asks for a URL.
  glm: {
    model: "glm-4.6",
    baseURL: "https://open.bigmodel.cn/api/paas/v4",
    envKey: "GLM_API_KEY",
  },
  deepseek: {
    model: "deepseek-chat",
    baseURL: "https://api.deepseek.com",
    envKey: "DEEPSEEK_API_KEY",
  },
  openrouter: {
    model: "openai/gpt-4o-mini",
    baseURL: "https://openrouter.ai/api/v1",
    envKey: "OPENROUTER_API_KEY",
  },
  "hara-gateway": { model: "", envKey: "HARA_GATEWAY_TOKEN" }, // B-end: enrolled device → token in ~/.hara/org.json, routed by the gateway
};

export const CONFIG_KEYS = ["provider", "apiKey", "model", "baseURL", "approval", "sandbox", "theme", "evolve", "assetCapture", "computerUse", "computerApps", "visionModel", "visionBaseURL", "visionApiKey", "embedProvider", "embedModel", "embedBaseURL", "embedApiKey", "routeModel", "routeBaseURL", "routeApiKey", "notify", "vimMode", "autoCompact", "fileCheckpoints", "fallbackModel", "fallbackBaseURL", "fallbackApiKey", "reasoningEffort"] as const;
export const REASONING_EFFORTS: NonNullable<HaraConfig["reasoningEffort"]>[] = ["off", "low", "medium", "high"];
export const APPROVAL_MODES: ApprovalMode[] = ["suggest", "auto-edit", "full-auto"];
export const SANDBOX_MODES: SandboxMode[] = ["off", "workspace-write", "read-only"];
const PROJECT_ROOT_MARKERS = [".git", "package.json", "Cargo.toml", "go.mod", "pyproject.toml", ".hg"];

export function configPath(): string {
  return join(homedir(), ".hara", "config.json");
}

export function readRawConfig(): Record<string, any> {
  const p = configPath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Record<string, any>;
  } catch {
    return {};
  }
}

/** Nearest project override `.hara/config.json`, searching cwd up to the repo root. */
function readProjectConfig(cwd: string): Record<string, any> {
  let dir = resolve(cwd);
  for (;;) {
    const p = join(dir, ".hara", "config.json");
    if (existsSync(p)) {
      try {
        return JSON.parse(readFileSync(p, "utf8")) as Record<string, any>;
      } catch {
        return {};
      }
    }
    if (PROJECT_ROOT_MARKERS.some((m) => existsSync(join(dir, m)))) break; // stop at repo root
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return {};
}

/** Write the config 0600 (it can hold `apiKey`) + tighten an existing file. */
function persistConfig(p: string, cfg: Record<string, unknown>): void {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(p, 0o600);
  } catch {
    /* best-effort */
  }
}

export function writeConfigValue(key: string, value: string): void {
  const p = configPath();
  const cfg = readRawConfig();
  cfg[key] = value;
  persistConfig(p, cfg);
}

/** Record (or clear, with cap=null) a confirmed per-model vision capability in `modelVision`. */
export function setModelVisionOverride(model: string, cap: "yes" | "no" | null): void {
  const p = configPath();
  const cfg = readRawConfig();
  const map: Record<string, string> = cfg.modelVision && typeof cfg.modelVision === "object" ? cfg.modelVision : {};
  if (cap === null) delete map[model];
  else map[model] = cap;
  cfg.modelVision = map;
  persistConfig(p, cfg);
}

/**
 * Effective config. Precedence (high→low): env vars > project `.hara/config.json` >
 * named overlay (`overlays.<name>` in global config) > global `~/.hara/config.json`
 * > provider defaults.
 *
 * NOTE: `--profile` / `HARA_PROFILE` is the IDENTITY-profile selector (personal ↔ org A
 * ↔ org B) — see src/profile/profile.ts. The legacy `profiles:{name:partial}` overlay
 * mechanism (a tiny in-config preset / overlay) has been renamed to `overlays:{...}`
 * to free the "profile" word for identity. We still read the legacy `profiles:{...}`
 * key for one release for back-compat. Overlays are addressed by env var
 * `HARA_OVERLAY=<name>` (or `opts.overlay`).
 */
export function loadConfig(opts: { overlay?: string } = {}): HaraConfig {
  const global = readRawConfig();
  // Strip both the new (`overlays`) and legacy (`profiles`) overlay containers from the base merge.
  // The legacy `profiles` key is kept readable for back-compat with users who already have it.
  const { overlays, profiles, ...globalBase } = global;
  const project = readProjectConfig(process.cwd());
  const overlayName = process.env.HARA_OVERLAY ?? opts.overlay;
  const overlayMap = overlays && typeof overlays === "object" ? overlays : profiles && typeof profiles === "object" ? profiles : null;
  const overlay = overlayName && overlayMap && overlayMap[overlayName] ? overlayMap[overlayName] : {};
  const merged: Record<string, any> = { ...globalBase, ...project, ...overlay };

  const provider = (process.env.HARA_PROVIDER ?? merged.provider ?? "anthropic") as ProviderId;
  const d = PROVIDER_DEFAULTS[provider] ?? PROVIDER_DEFAULTS.anthropic;
  const model = process.env.HARA_MODEL ?? merged.model ?? d.model;
  const baseURL = process.env.HARA_BASE_URL ?? merged.baseURL ?? d.baseURL;
  const apiKey = process.env.HARA_API_KEY ?? process.env[d.envKey] ?? merged.apiKey;
  const approval = (process.env.HARA_APPROVAL ?? merged.approval ?? "suggest") as ApprovalMode;
  const sandbox = (process.env.HARA_SANDBOX ?? merged.sandbox ?? "off") as SandboxMode;
  const theme = (process.env.HARA_THEME ?? merged.theme ?? "dark") as "dark" | "light";
  const evolve = (process.env.HARA_EVOLVE ?? merged.evolve ?? "proactive") as "off" | "light" | "proactive";
  const assetCapture = (process.env.HARA_ASSET_CAPTURE ?? merged.assetCapture ?? "ask") as "off" | "ask" | "auto";
  const computerUse = (process.env.HARA_COMPUTER_USE ?? merged.computerUse ?? "off") as "off" | "read" | "click" | "full";
  const computerApps = String(process.env.HARA_COMPUTER_APPS ?? merged.computerApps ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const visionModel = process.env.HARA_VISION_MODEL ?? merged.visionModel;
  const visionBaseURL = process.env.HARA_VISION_BASE_URL ?? merged.visionBaseURL;
  const visionApiKey = process.env.HARA_VISION_API_KEY ?? merged.visionApiKey;
  const modelVision = merged.modelVision && typeof merged.modelVision === "object" ? (merged.modelVision as Record<string, "yes" | "no">) : {};
  const embedProvider = (process.env.HARA_EMBED_PROVIDER ?? merged.embedProvider ?? "off") as "off" | "ollama" | "qwen" | "openai";
  const embedModel = process.env.HARA_EMBED_MODEL ?? merged.embedModel;
  const embedBaseURL = process.env.HARA_EMBED_BASE_URL ?? merged.embedBaseURL;
  const embedApiKey = process.env.HARA_EMBED_API_KEY ?? merged.embedApiKey;
  const routeModel = process.env.HARA_ROUTE_MODEL ?? merged.routeModel;
  const routeBaseURL = process.env.HARA_ROUTE_BASE_URL ?? merged.routeBaseURL;
  const routeApiKey = process.env.HARA_ROUTE_API_KEY ?? merged.routeApiKey;
  const mcpServers: Record<string, McpServerConfig> = {
    ...(globalBase.mcpServers ?? {}),
    ...(project.mcpServers ?? {}),
    ...(overlay.mcpServers ?? {}),
  };
  const hooks = (merged.hooks && typeof merged.hooks === "object" ? merged.hooks : {}) as HooksConfig;
  const notify = (process.env.HARA_NOTIFY ?? merged.notify ?? "off") as NotifyMode;
  const vimMode = process.env.HARA_VIM === "1" || merged.vimMode === true || merged.vimMode === "true";
  const autoCompact = !(process.env.HARA_AUTO_COMPACT === "0" || merged.autoCompact === false || merged.autoCompact === "false"); // default ON
  const fileCheckpoints = !(process.env.HARA_CHECKPOINTS === "0" || merged.fileCheckpoints === false || merged.fileCheckpoints === "false"); // default ON
  const fallbackModel = process.env.HARA_FALLBACK_MODEL ?? merged.fallbackModel;
  const fallbackBaseURL = process.env.HARA_FALLBACK_BASE_URL ?? merged.fallbackBaseURL;
  const fallbackApiKey = process.env.HARA_FALLBACK_API_KEY ?? merged.fallbackApiKey;
  const reasoningRaw = process.env.HARA_REASONING_EFFORT ?? merged.reasoningEffort;
  const reasoningEffort = reasoningRaw && (["off", "low", "medium", "high"] as const).includes(reasoningRaw as never)
    ? (reasoningRaw as "off" | "low" | "medium" | "high")
    : undefined;

  return { provider, apiKey, model, baseURL, approval, sandbox, theme, evolve, assetCapture, computerUse, computerApps, visionModel, visionBaseURL, visionApiKey, modelVision, embedProvider, embedModel, embedBaseURL, embedApiKey, routeModel, routeBaseURL, routeApiKey, hooks, notify, vimMode, autoCompact, fileCheckpoints, fallbackModel, fallbackBaseURL, fallbackApiKey, reasoningEffort, mcpServers, cwd: process.cwd() };
}

export function providerEnvKey(provider: ProviderId): string {
  return (PROVIDER_DEFAULTS[provider] ?? PROVIDER_DEFAULTS.anthropic).envKey;
}

/** Preset base URL for a provider (undefined for anthropic/openai which use their SDK defaults).
 *  Used by `hara setup` to write a self-contained baseURL for GLM/DeepSeek/OpenRouter. */
export function providerDefaultBaseURL(provider: ProviderId): string | undefined {
  return PROVIDER_DEFAULTS[provider]?.baseURL;
}
