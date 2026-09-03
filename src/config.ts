import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import type { SandboxMode } from "./sandbox.js";
import type { HooksConfig } from "./hooks.js";
import type { NotifyMode } from "./notify.js";
import { agentMaxRounds, agentRunTimeoutMs } from "./agent/limits.js";
import {
  bindPrivateHaraStateFile,
  ensurePrivateHaraState,
  readPrivateStateFileSnapshotSync,
  withPrivateStateLockSync,
  writePrivateStateFileSync,
  type PrivateStateFileSnapshot,
} from "./security/private-state.js";
import { readVerifiedRegularFileSnapshotSync } from "./fs-read.js";
import { projectRepositoryTrustedAtStartup } from "./security/project-trust.js";
import { isHomeWorkspace } from "./context/workspace-scope.js";
import {
  TOKEN_PLAN_KNOWN_INTERACTIVE_AGENT_MODELS,
  TOKEN_PLAN_OPENAI_BASE_URL,
} from "./providers/alibaba.js";
import { DEEPSEEK_RESPONSES_MODELS } from "./providers/deepseek.js";
import {
  MINIMAX_TOKEN_PLAN_BASE_URL,
  MINIMAX_TOKEN_PLAN_MODELS,
} from "./providers/minimax.js";
import {
  VOLCENGINE_AGENT_PLAN_BASE_URL,
  VOLCENGINE_AGENT_PLAN_MODELS,
} from "./providers/volcengine.js";

export type ProviderId =
  | "anthropic"
  | "token-plan"
  | "minimax-token-plan"
  | "volcengine-agent-plan"
  | "qwen"
  | "qwen-oauth"
  | "openai"
  | "glm"
  | "deepseek"
  | "openrouter"
  | "ollama"
  | "lmstudio"
  | "hara-gateway";
export type ApprovalMode = "suggest" | "auto-edit" | "full-auto";
export type VisionModelSource = "current" | "custom";

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Optional bounded, non-secret capability hint shown before the trusted server is launched. This lets
   * the model select one relevant lazy MCP server without speculatively executing every configured host. */
  description?: string;
  /** Optional trusted process directory. Plugin-contributed servers bind this to their immutable package root. */
  cwd?: string;
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
  /** Optional explicit vision-first model. When set, every image is described by this model before the
   *  conversation model runs. Only images and a focused transcription prompt are sent on this route. */
  visionModel: string | undefined;
  /** Reuse the active connection, or use an independently configured provider/credential boundary. */
  visionSource: VisionModelSource;
  /** Provider/protocol adapter for a custom vision route. Current-provider routes deliberately omit it. */
  visionProvider: ProviderId | undefined;
  /** Endpoint for a custom Personal/BYOK vision-first model. Managed/current routes ignore it. */
  visionBaseURL: string | undefined;
  /** Credential for a custom Personal/BYOK vision-first model. Managed/current routes ignore it. */
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
  /** startup update check (cached daily npm probe → one-line notice on launch). default on. */
  updateCheck: boolean;
  /** User-owned HTTP(S) proxy for model/provider, organization and web-tool traffic. Standard proxy env
   * variables take precedence; project config is deliberately not allowed to choose this route. */
  proxy: string | undefined;
  /** Optional user-selected package registry for npm/pnpm/yarn/bun install commands. Never selected from
   * repository config, because changing an install source is a software supply-chain trust decision. */
  packageRegistry: string | undefined;
  /** App-level failover: on a recoverable turn error (overload / rate-limit / timeout / context-overflow),
   *  retry once on this model. For a CROSS-PROVIDER fallback (e.g. primary Qwen, fallback DeepSeek) set
   *  `fallbackProvider` — its endpoint + env key are then resolved for you (setting `fallbackBaseURL`
   *  overrides). Without `fallbackProvider` the fallback stays on the PRIMARY endpoint (only correct when
   *  the same endpoint also serves `fallbackModel`). Unset `fallbackModel` = no fallback. */
  fallbackModel: string | undefined;
  fallbackProvider: ProviderId | undefined;
  fallbackBaseURL: string | undefined;
  fallbackApiKey: string | undefined;
  /** Thinking/reasoning effort dial (provider-mapped):
   *   - unset    → each provider's default (anthropic = adaptive, openai = unset, etc.)
   *   - "off"    → no extended thinking; on adaptive-only Anthropic models we just omit `thinking`
   *   - "minimal"→ the provider's smallest non-zero reasoning level when it exposes one
   *   - "low"    → small budget (anthropic budget_tokens, openai reasoning_effort:"low")
   *   - "medium" → balanced (anthropic adaptive, openai reasoning_effort:"medium")
   *   - "high"   → large budget (anthropic budget_tokens up, openai reasoning_effort:"high")
   *   - "xhigh"  → provider-native extra-high reasoning where available
   *   - "max"    → provider-native maximum reasoning where available
   *  Provider/model capability metadata decides which values are offered; adapters retain compatibility
   *  mappings only for previously persisted values. */
  reasoningEffort: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | undefined;
  /** lifecycle hooks (PreToolUse/PostToolUse) — shell commands run around tool calls */
  hooks: HooksConfig;
  /** Guardian safety layer: an internal HIGH-RISK classifier + a conservative cheap-model veto + a hard
   *  circuit-breaker, layered on top of permission rules / hooks / the approval gate. "on" (default) engages
   *  ONLY on genuinely dangerous actions (rm -rf, dd, curl|sh, sudo, force-push, out-of-project writes, …)
   *  so normal work is untouched (zero added latency). "off" disables it. Also switchable via HARA_GUARDIAN. */
  guardian: "on" | "off";
  /** ping when a (non-trivial) turn finishes: off | bell (terminal BEL) | system (OS notification + bell) */
  notify: NotifyMode;
  /** Hard active provider/tool ceiling for one run; engine-owned human waits are excluded (default 30 minutes). */
  runTimeoutMs: number;
  /** hard provider/tool-round ceiling for one agent run (default 64). */
  maxAgentRounds: number;
  /** modal (vim) keybindings in the TUI input box (opt-in) */
  vimMode: boolean;
  mcpServers: Record<string, McpServerConfig>;
  cwd: string;
}

const PROVIDER_DEFAULTS: Record<ProviderId, { model: string; baseURL?: string; envKey: string }> = {
  anthropic: { model: "claude-opus-4-8", envKey: "ANTHROPIC_API_KEY" },
  "token-plan": {
    model: "qwen3.8-max",
    baseURL: TOKEN_PLAN_OPENAI_BASE_URL,
    envKey: "OPENAI_API_KEY",
  },
  "minimax-token-plan": {
    model: "MiniMax-M3",
    baseURL: MINIMAX_TOKEN_PLAN_BASE_URL,
    envKey: "MINIMAX_API_KEY",
  },
  "volcengine-agent-plan": {
    model: "auto",
    baseURL: VOLCENGINE_AGENT_PLAN_BASE_URL,
    envKey: "ARK_API_KEY",
  },
  qwen: {
    model: "qwen-plus",
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    envKey: "DASHSCOPE_API_KEY",
  },
  "qwen-oauth": { model: "coder-model", envKey: "QWEN_OAUTH_TOKEN" },
  openai: { model: "gpt-4o-mini", envKey: "OPENAI_API_KEY" },
  // GLM / DeepSeek / OpenRouter expose OpenAI-compatible endpoints. Official DeepSeek V4 models are
  // routed through Responses; its other model ids keep using Chat. The preset baseURL is
  // applied by loadConfig (merged.baseURL ?? d.baseURL), so the setup wizard never asks for a URL.
  glm: {
    model: "glm-4.6",
    baseURL: "https://open.bigmodel.cn/api/paas/v4",
    envKey: "GLM_API_KEY",
  },
  deepseek: {
    model: "deepseek-v4-flash",
    baseURL: "https://api.deepseek.com",
    envKey: "DEEPSEEK_API_KEY",
  },
  openrouter: {
    model: "openai/gpt-4o-mini",
    baseURL: "https://openrouter.ai/api/v1",
    envKey: "OPENROUTER_API_KEY",
  },
  ollama: {
    model: "qwen3",
    baseURL: "http://127.0.0.1:11434/v1",
    envKey: "",
  },
  lmstudio: {
    model: "local-model",
    baseURL: "http://127.0.0.1:1234/v1",
    envKey: "",
  },
  "hara-gateway": { model: "", envKey: "HARA_GATEWAY_TOKEN" }, // B-end: enrolled device → token in ~/.hara/org.json, routed by the gateway
};

export type ProviderLocation = "cloud" | "local" | "managed";
export type ProviderAuth = "api-key" | "oauth" | "none" | "managed";

export interface ProviderCatalogEntry {
  id: ProviderId;
  label: string;
  location: ProviderLocation;
  auth: ProviderAuth;
  defaultModel: string;
  defaultBaseURL?: string;
  customBaseURL: boolean;
  /** Setup-time suggestions only. A live key-scoped `/models` response is authoritative. */
  knownModels?: readonly string[];
  /** Kept loadable for existing profiles but hidden from new-connection setup. */
  legacy?: boolean;
}

const PROVIDER_LABELS: Record<ProviderId, Omit<ProviderCatalogEntry, "id" | "defaultModel" | "defaultBaseURL">> = {
  anthropic: { label: "Anthropic", location: "cloud", auth: "api-key", customBaseURL: true },
  "token-plan": {
    label: "Alibaba Cloud Model Studio Token Plan",
    location: "cloud",
    auth: "api-key",
    customBaseURL: false,
    knownModels: TOKEN_PLAN_KNOWN_INTERACTIVE_AGENT_MODELS,
  },
  "minimax-token-plan": {
    label: "MiniMax Token Plan",
    location: "cloud",
    auth: "api-key",
    customBaseURL: false,
    knownModels: MINIMAX_TOKEN_PLAN_MODELS,
  },
  "volcengine-agent-plan": {
    label: "Volcengine Ark Agent Plan",
    location: "cloud",
    auth: "api-key",
    customBaseURL: false,
    knownModels: VOLCENGINE_AGENT_PLAN_MODELS,
  },
  openai: { label: "OpenAI / compatible", location: "cloud", auth: "api-key", customBaseURL: true },
  qwen: { label: "Qwen (legacy DashScope)", location: "cloud", auth: "api-key", customBaseURL: true, legacy: true },
  "qwen-oauth": { label: "Qwen Code OAuth (legacy, not Token Plan)", location: "cloud", auth: "oauth", customBaseURL: false, legacy: true },
  glm: { label: "GLM (Zhipu)", location: "cloud", auth: "api-key", customBaseURL: true },
  deepseek: {
    label: "DeepSeek",
    location: "cloud",
    auth: "api-key",
    customBaseURL: true,
    knownModels: DEEPSEEK_RESPONSES_MODELS,
  },
  openrouter: { label: "OpenRouter", location: "cloud", auth: "api-key", customBaseURL: true },
  ollama: { label: "Ollama", location: "local", auth: "none", customBaseURL: true },
  lmstudio: { label: "LM Studio", location: "local", auth: "none", customBaseURL: true },
  "hara-gateway": { label: "Hara Enterprise Gateway", location: "managed", auth: "managed", customBaseURL: false },
};

export const PROVIDER_IDS = Object.freeze(Object.keys(PROVIDER_DEFAULTS) as ProviderId[]);

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(PROVIDER_DEFAULTS, value);
}

export function providerRequiresApiKey(provider: ProviderId): boolean {
  return PROVIDER_LABELS[provider].auth === "api-key";
}

export function providerIsLocal(provider: ProviderId): boolean {
  return PROVIDER_LABELS[provider].location === "local";
}

/** Redacted, deterministic catalog shared by CLI setup, serve and Desktop. */
export function providerCatalog(): ProviderCatalogEntry[] {
  return PROVIDER_IDS.map((id) => ({
    id,
    ...PROVIDER_LABELS[id],
    defaultModel: PROVIDER_DEFAULTS[id].model,
    ...(PROVIDER_DEFAULTS[id].baseURL ? { defaultBaseURL: PROVIDER_DEFAULTS[id].baseURL } : {}),
  }));
}

export const CONFIG_KEYS = ["provider", "apiKey", "model", "baseURL", "approval", "sandbox", "theme", "evolve", "assetCapture", "computerUse", "computerApps", "visionModel", "visionSource", "visionProvider", "visionBaseURL", "visionApiKey", "embedProvider", "embedModel", "embedBaseURL", "embedApiKey", "routeModel", "routeBaseURL", "routeApiKey", "guardian", "notify", "runTimeoutMs", "maxAgentRounds", "vimMode", "autoCompact", "fileCheckpoints", "updateCheck", "proxy", "packageRegistry", "fallbackModel", "fallbackProvider", "fallbackBaseURL", "fallbackApiKey", "reasoningEffort"] as const;
export const REASONING_EFFORTS: NonNullable<HaraConfig["reasoningEffort"]>[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
export const APPROVAL_MODES: ApprovalMode[] = ["suggest", "auto-edit", "full-auto"];
export const SANDBOX_MODES: SandboxMode[] = ["off", "workspace-write", "read-only"];
export const COMPUTER_USE_MODES: HaraConfig["computerUse"][] = ["off", "read", "click", "full"];
const PROJECT_ROOT_MARKERS = [".git", "package.json", "Cargo.toml", "go.mod", "pyproject.toml", ".hg"];
const MAX_PROJECT_CONFIG_BYTES = 256 * 1024;
const MAX_GLOBAL_CONFIG_BYTES = 1024 * 1024;
const KNOWN_CONFIG_KEYS = new Set<string>([
  ...CONFIG_KEYS,
  "hooks", "mcpServers", "modelVision", "overlays", "profiles",
]);
/** Deliberately narrow: these keys change presentation/model preference, but cannot redirect credentials,
 * execute code, grant tools more authority, or disable a safety layer. Everything else requires a launch-
 * time trust decision so cloning/chdir into a repository never silently changes the process trust boundary. */
const SAFE_PROJECT_CONFIG_KEYS = new Set(["model", "theme", "vimMode", "autoCompact", "reasoningEffort"]);
const projectConfigWarnings = new Set<string>();

function printableConfigKeys(keys: string[]): string {
  // A repository controls JSON property names too. Only schema names are safe diagnostics; an unknown key
  // may itself contain a copied token and must never be treated as printable metadata.
  const safe = [...new Set(keys.map((key) => (
    KNOWN_CONFIG_KEYS.has(key) ? key : "<unknown-key>"
  )))].sort();
  const shown = safe.slice(0, 32);
  return `${shown.join(", ")}${safe.length > shown.length ? `, … (+${safe.length - shown.length})` : ""}`;
}

function warnProjectConfig(kind: string, message: string): void {
  if (projectConfigWarnings.has(kind)) return;
  projectConfigWarnings.add(kind);
  try { process.stderr.write(`hara: ${message}\n`); } catch { /* best effort */ }
}

function validSafeProjectValue(key: string, value: unknown): boolean {
  if (key === "model") return typeof value === "string" && value.trim().length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
  if (key === "theme") return value === "dark" || value === "light";
  if (key === "reasoningEffort") return REASONING_EFFORTS.includes(value as NonNullable<HaraConfig["reasoningEffort"]>);
  if (key === "vimMode" || key === "autoCompact") return typeof value === "boolean" || value === "true" || value === "false";
  return false;
}

function filterProjectConfig(input: Record<string, any>): Record<string, any> {
  const blocked = Object.keys(input).filter((key) => !SAFE_PROJECT_CONFIG_KEYS.has(key));
  if (projectRepositoryTrustedAtStartup()) {
    if (blocked.length) {
      const names = printableConfigKeys(blocked);
      warnProjectConfig(`trusted:${names}`, `trusted project config enabled for privileged key(s): ${names}.`);
    }
    return input;
  }
  if (blocked.length) {
    const names = printableConfigKeys(blocked);
    warnProjectConfig(
      `ignored:${names}`,
      `ignored untrusted project config key(s): ${names}. Set HARA_TRUST_PROJECT_CONFIG=1 before starting hara only for a repository you trust.`,
    );
  }
  const invalid = Object.entries(input)
    .filter(([key, value]) => SAFE_PROJECT_CONFIG_KEYS.has(key) && !validSafeProjectValue(key, value))
    .map(([key]) => key);
  if (invalid.length) {
    const names = printableConfigKeys(invalid);
    warnProjectConfig(`invalid-safe:${names}`, `ignored invalid project config value(s) for key(s): ${names}.`);
  }
  return Object.fromEntries(Object.entries(input).filter(([key, value]) => (
    SAFE_PROJECT_CONFIG_KEYS.has(key) && validSafeProjectValue(key, value)
  )));
}

export function configPath(): string {
  return join(homedir(), ".hara", "config.json");
}

interface RawConfigState {
  value: Record<string, any>;
  snapshot: PrivateStateFileSnapshot;
}

function readRawConfigState(): RawConfigState | null {
  ensurePrivateHaraState();
  const binding = bindPrivateHaraStateFile(homedir(), [], "config.json");
  const snapshot = readPrivateStateFileSnapshotSync(binding.path, MAX_GLOBAL_CONFIG_BYTES);
  if (!snapshot) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshot.text);
  } catch {
    throw new Error("global Hara config is not valid JSON; refusing to replace or ignore it");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("global Hara config must contain a JSON object; refusing to replace or ignore it");
  }
  return { value: parsed as Record<string, any>, snapshot };
}

function withConfigLock<T>(fn: () => T): T {
  return withPrivateStateLockSync(homedir(), [], "config", fn, {
    busyMessage: "global Hara config is busy; retry the operation",
  });
}

function configRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : {};
}

export function readRawConfig(): Record<string, any> {
  try {
    const current = readRawConfigState();
    if (current) return current.value;
  } catch {
    // Retry once under the writer fence. A namespace race succeeds here; a static malformed/unsafe config
    // throws again and can never be mistaken for an empty file by a later update.
  }
  return withConfigLock(() => readRawConfigState()?.value ?? {});
}

const ROUTING_CONFIG_KEYS = new Set([
  "provider", "apiKey", "model", "baseURL",
  "fallbackProvider", "fallbackApiKey", "fallbackModel", "fallbackBaseURL",
  "visionApiKey", "visionModel", "visionSource", "visionProvider", "visionBaseURL",
  "embedProvider", "embedApiKey", "embedModel", "embedBaseURL",
  "routeApiKey", "routeModel", "routeBaseURL",
]);

/** Empty routing values are not meaningful credentials/endpoints. Ignore them at each precedence layer so
 *  an empty project override (or launcher-exported empty env var) cannot hide a valid global config value. */
function withoutBlankRoutingValues(input: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(input)) {
    if (ROUTING_CONFIG_KEYS.has(key) && typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) continue;
      out[key] = trimmed;
    } else {
      out[key] = value;
    }
  }
  return out;
}

function nonBlankEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function projectConfigReadFailure(kind: string): Record<string, any> {
  warnProjectConfig(`unsafe-file:${kind}`, `ignored an unsafe project .hara/config.json (${kind}); no project values were loaded.`);
  return {};
}

/** Nearest project override `.hara/config.json`, searching a canonical cwd up to the repo root. Project
 * configuration is repository input, not private Hara state: its `.hara` parent and final entry must remain
 * ordinary single-link filesystem objects while a bounded O_NOFOLLOW descriptor is read. */
function readProjectConfig(cwd: string): Record<string, any> {
  let dir: string;
  try {
    dir = realpathSync.native(resolve(cwd));
  } catch {
    dir = resolve(cwd);
  }
  for (;;) {
    // ~/.hara/config.json is the global control-plane file already loaded by loadConfig(). Never read it
    // a second time as repository input, and never climb through Home into a parent repository.
    if (isHomeWorkspace(dir)) break;
    const hara = join(dir, ".hara");
    const p = join(hara, "config.json");
    let haraInfo;
    try {
      haraInfo = lstatSync(hara);
    } catch (error: any) {
      if (error?.code !== "ENOENT") return projectConfigReadFailure("unreadable parent");
    }
    if (haraInfo) {
      if (haraInfo.isSymbolicLink()) return projectConfigReadFailure("symlink parent");
      if (haraInfo.isDirectory()) {
        let fileInfo;
        try {
          const canonicalParent = realpathSync.native(hara);
          if (canonicalParent !== hara) return projectConfigReadFailure("non-canonical parent");
          fileInfo = lstatSync(p);
        } catch (error: any) {
          if (error?.code !== "ENOENT") return projectConfigReadFailure("unreadable file");
        }
        if (fileInfo) {
          if (fileInfo.isSymbolicLink()) return projectConfigReadFailure("symlink file");
          if (!fileInfo.isFile()) return projectConfigReadFailure("non-regular file");
          try {
            const snapshot = readVerifiedRegularFileSnapshotSync(p, MAX_PROJECT_CONFIG_BYTES, {
              action: "read project config",
              protectSensitive: false,
              rejectHardLinks: true,
            });
            const parentAfter = lstatSync(hara);
            if (
              !parentAfter.isDirectory()
              || parentAfter.isSymbolicLink()
              || parentAfter.dev !== haraInfo.dev
              || parentAfter.ino !== haraInfo.ino
              || realpathSync.native(hara) !== hara
            ) return projectConfigReadFailure("changed parent");
            return filterProjectConfig(configRecord(JSON.parse(snapshot.text)));
          } catch (error: any) {
            if (error?.code === "HARA_HARD_LINKED_FILE") return projectConfigReadFailure("hard-linked file");
            if (error?.code === "HARA_FILE_TOO_LARGE") return projectConfigReadFailure("oversized file");
            if (/changed while (?:opening|reading)|File changed/i.test(error?.message ?? "")) {
              return projectConfigReadFailure("changed file");
            }
            return projectConfigReadFailure("invalid file");
          }
        }
      }
    }
    if (PROJECT_ROOT_MARKERS.some((m) => existsSync(join(dir, m)))) break; // stop at repo root
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return {};
}

/** Atomically replace the global 0600 config through the shared private-state CAS boundary. */
function persistConfig(cfg: Record<string, unknown>, expectedText?: string, expectedMissing = false): void {
  ensurePrivateHaraState();
  const binding = bindPrivateHaraStateFile(homedir(), [], "config.json");
  writePrivateStateFileSync(binding, JSON.stringify(cfg, null, 2) + "\n", { expectedText, expectedMissing });
}

/** Mutate global config without exposing a second direct-write implementation to feature modules. */
export function updateRawConfig(
  mutate: (config: Record<string, any>) => Record<string, any> | void,
): void {
  withConfigLock(() => {
    const state = readRawConfigState();
    const config = state?.value ?? {};
    const replacement = mutate(config);
    persistConfig(replacement ?? config, state?.snapshot.text, !state);
  });
}

export function writeConfigValue(key: string, value: string): void {
  updateRawConfig((config) => {
    config[key] = value;
  });
}

export interface PersonalProviderConfigUpdate {
  provider: ProviderId;
  model: string;
  baseURL?: string;
  /** Undefined keeps the current key only when the provider is unchanged. Empty string is also treated as
   * undefined; use clearApiKey for an explicit removal. */
  apiKey?: string;
  clearApiKey?: boolean;
  /** Default reasoning dial for new work using this Personal connection. Undefined preserves the
   * existing value; clearReasoningEffort restores the provider/model default. */
  reasoningEffort?: HaraConfig["reasoningEffort"];
  clearReasoningEffort?: boolean;
}

export interface NormalizedPersonalProviderConfigUpdate extends PersonalProviderConfigUpdate {
  model: string;
  baseURL?: string;
  apiKey?: string;
}

function cleanProviderModel(value: string): string {
  const model = value.trim();
  if (!model || model.length > 256 || /[\u0000-\u001f\u007f]/.test(model)) {
    throw new Error("model must be 1–256 printable characters");
  }
  return model;
}

function loopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

function cleanProviderBaseURL(provider: ProviderId, value: string | undefined): string | undefined {
  const raw = value?.trim() || PROVIDER_DEFAULTS[provider].baseURL;
  if (!raw) return undefined;
  if (raw.length > 2_048 || /[\u0000-\u001f\u007f]/.test(raw)) throw new Error("base URL is invalid");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("base URL must be an absolute http(s) URL");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("base URL must use http or https");
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("base URL cannot contain credentials, query parameters, or a fragment");
  }
  if (url.protocol === "http:" && !loopbackHost(url.hostname)) {
    throw new Error("non-loopback provider endpoints must use https");
  }
  if (providerIsLocal(provider) && !loopbackHost(url.hostname)) {
    throw new Error(`${provider} is labeled local and must use localhost/127.0.0.1/::1; use an OpenAI-compatible cloud profile for a remote host`);
  }
  const normalized = raw.replace(/\/+$/, "");
  if (provider === "token-plan") {
    const expected = new URL(TOKEN_PLAN_OPENAI_BASE_URL);
    const pathname = url.pathname.replace(/\/+$/, "");
    if (
      url.protocol !== expected.protocol
      || url.host.toLowerCase() !== expected.host.toLowerCase()
      || pathname !== expected.pathname.replace(/\/+$/, "")
    ) {
      throw new Error(`token-plan uses the fixed Beijing endpoint ${TOKEN_PLAN_OPENAI_BASE_URL}`);
    }
    return TOKEN_PLAN_OPENAI_BASE_URL;
  }
  if (provider === "minimax-token-plan") {
    const expected = new URL(MINIMAX_TOKEN_PLAN_BASE_URL);
    const pathname = url.pathname.replace(/\/+$/, "");
    if (
      url.protocol !== expected.protocol
      || url.host.toLowerCase() !== expected.host.toLowerCase()
      || pathname !== expected.pathname.replace(/\/+$/, "")
    ) {
      throw new Error(`minimax-token-plan uses the fixed endpoint ${MINIMAX_TOKEN_PLAN_BASE_URL}`);
    }
    return MINIMAX_TOKEN_PLAN_BASE_URL;
  }
  if (provider === "volcengine-agent-plan") {
    const expected = new URL(VOLCENGINE_AGENT_PLAN_BASE_URL);
    const pathname = url.pathname.replace(/\/+$/, "");
    if (
      url.protocol !== expected.protocol
      || url.host.toLowerCase() !== expected.host.toLowerCase()
      || pathname !== expected.pathname.replace(/\/+$/, "")
    ) {
      throw new Error(`volcengine-agent-plan uses the fixed Beijing endpoint ${VOLCENGINE_AGENT_PLAN_BASE_URL}`);
    }
    return VOLCENGINE_AGENT_PLAN_BASE_URL;
  }
  return normalized;
}

function providerEndpointIdentity(provider: ProviderId, value: string | undefined): string {
  const cleaned = cleanProviderBaseURL(provider, value);
  if (!cleaned) return "";
  const url = new URL(cleaned);
  const pathname = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.host.toLowerCase()}${pathname}`;
}

/** Validate a Desktop/serve candidate without persisting it. Kept beside the writer so a connection test
 * and the eventual save cannot disagree about endpoint or credential safety. */
export function normalizePersonalProviderConfig(input: PersonalProviderConfigUpdate): NormalizedPersonalProviderConfigUpdate {
  if (!isProviderId(input.provider) || input.provider === "hara-gateway") {
    throw new Error("provider is not a configurable personal provider");
  }
  const model = cleanProviderModel(input.model);
  const baseURL = cleanProviderBaseURL(input.provider, input.baseURL);
  const apiKey = input.apiKey?.trim();
  if (apiKey && (apiKey.length > 32 * 1024 || /[\u0000-\u001f\u007f]/.test(apiKey))) {
    throw new Error("API key is invalid");
  }
  if (apiKey && !providerRequiresApiKey(input.provider)) {
    throw new Error(`${input.provider} does not accept an API key`);
  }
  if (
    input.reasoningEffort !== undefined
    && !REASONING_EFFORTS.includes(input.reasoningEffort)
  ) {
    throw new Error(`reasoning effort must be one of: ${REASONING_EFFORTS.join(", ")}`);
  }
  return {
    provider: input.provider,
    model,
    ...(baseURL ? { baseURL } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(input.clearApiKey === true ? { clearApiKey: true } : {}),
    ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}),
    ...(input.clearReasoningEffort === true ? { clearReasoningEffort: true } : {}),
  };
}

/**
 * Resolve a credential that may safely be reused for a Desktop connection test/save.
 *
 * A provider id is not a credential boundary by itself: OpenAI-compatible providers allow a custom
 * endpoint. Never replay a stored or environment key when that endpoint changes, even when the provider id
 * stays the same. Local/OAuth providers never receive this flat API-key slot.
 */
export function reusablePersonalProviderApiKey(
  input: NormalizedPersonalProviderConfigUpdate,
  raw: Record<string, any>,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (!providerRequiresApiKey(input.provider)) return undefined;
  if (input.apiKey) return input.apiKey;
  if (input.clearApiKey) return undefined;
  const previousProvider = isProviderId(raw.provider) ? raw.provider : "anthropic";
  if (previousProvider !== input.provider) return undefined;
  const previousEndpoint = providerEndpointIdentity(previousProvider, typeof raw.baseURL === "string" ? raw.baseURL : undefined);
  const candidateEndpoint = providerEndpointIdentity(input.provider, input.baseURL);
  if (previousEndpoint !== candidateEndpoint) return undefined;
  const envKey = providerEnvKey(input.provider);
  return nonBlankEnv(env.HARA_API_KEY)
    ?? (envKey ? nonBlankEnv(env[envKey]) : undefined)
    ?? nonBlankEnv(typeof raw.apiKey === "string" ? raw.apiKey : undefined);
}

/** Atomically update the legacy/personal provider slot without returning or logging its credential. */
export function updatePersonalProviderConfig(input: PersonalProviderConfigUpdate): void {
  const normalized = normalizePersonalProviderConfig(input);
  const { model, baseURL, apiKey, reasoningEffort } = normalized;

  updateRawConfig((config) => {
    const previousProvider = isProviderId(config.provider) ? config.provider : "anthropic";
    const previousEndpoint = providerEndpointIdentity(
      previousProvider,
      typeof config.baseURL === "string" ? config.baseURL : undefined,
    );
    const nextEndpoint = providerEndpointIdentity(normalized.provider, baseURL);
    const endpointChanged =
      previousProvider !== normalized.provider || previousEndpoint !== nextEndpoint;
    config.provider = normalized.provider;
    config.model = model;
    if (baseURL) config.baseURL = baseURL;
    else delete config.baseURL;

    if (!providerRequiresApiKey(normalized.provider) || normalized.clearApiKey === true) {
      delete config.apiKey;
    } else if (apiKey) {
      config.apiKey = apiKey;
    } else if (endpointChanged) {
      // A flat legacy key belongs to one exact endpoint, not merely a provider label.
      delete config.apiKey;
    }

    if (normalized.clearReasoningEffort === true) delete config.reasoningEffort;
    else if (reasoningEffort !== undefined) config.reasoningEffort = reasoningEffort;
  });
}

/** Clear the single user-owned model connection without deleting the Personal Space itself.
 * Vision-first routing is connection-owned, so deleting this route must also delete its model,
 * endpoint, and credential. Organization profiles and unrelated personal settings remain untouched. */
export function clearPersonalProviderConfig(): void {
  updateRawConfig((config) => {
    delete config.provider;
    delete config.model;
    delete config.baseURL;
    delete config.apiKey;
    delete config.reasoningEffort;
    delete config.visionModel;
    delete config.visionSource;
    delete config.visionProvider;
    delete config.visionBaseURL;
    delete config.visionApiKey;
  });
}

/** Record (or clear, with cap=null) a confirmed per-model vision capability in `modelVision`. */
export function setModelVisionOverride(model: string, cap: "yes" | "no" | null): void {
  updateRawConfig((config) => {
    const map: Record<string, string> = config.modelVision && typeof config.modelVision === "object" ? config.modelVision : {};
    if (cap === null) delete map[model];
    else map[model] = cap;
    config.modelVision = map;
  });
}

/**
 * Effective config. Precedence (high→low): env vars > allowed/trusted project `.hara/config.json` >
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
export function loadConfig(opts: { overlay?: string; cwd?: string } = {}): HaraConfig {
  const global = readRawConfig();
  // Strip both the new (`overlays`) and legacy (`profiles`) overlay containers from the base merge.
  // The legacy `profiles` key is kept readable for back-compat with users who already have it.
  const { overlays, profiles, ...globalBase } = global;
  const effectiveCwd = resolve(opts.cwd ?? process.cwd());
  const project = readProjectConfig(effectiveCwd);
  const overlayName = nonBlankEnv(process.env.HARA_OVERLAY) ?? nonBlankEnv(opts.overlay);
  const overlayMap = overlays && typeof overlays === "object" ? overlays : profiles && typeof profiles === "object" ? profiles : null;
  const overlay = configRecord(overlayName && overlayMap ? overlayMap[overlayName] : undefined);
  const merged: Record<string, any> = {
    ...withoutBlankRoutingValues(globalBase),
    ...withoutBlankRoutingValues(overlay),
    ...withoutBlankRoutingValues(project),
  };

  const requestedProvider = nonBlankEnv(process.env.HARA_PROVIDER) ?? merged.provider ?? "anthropic";
  const provider: ProviderId = isProviderId(requestedProvider) ? requestedProvider : "anthropic";
  const d = PROVIDER_DEFAULTS[provider];
  const model = nonBlankEnv(process.env.HARA_MODEL) ?? merged.model ?? d.model;
  const baseURL = nonBlankEnv(process.env.HARA_BASE_URL) ?? merged.baseURL ?? d.baseURL;
  const providerEnvApiKey = d.envKey ? nonBlankEnv(process.env[d.envKey]) : undefined;
  const apiKey = nonBlankEnv(process.env.HARA_API_KEY) ?? providerEnvApiKey ?? merged.apiKey;
  const approval = (process.env.HARA_APPROVAL ?? merged.approval ?? "suggest") as ApprovalMode;
  const sandbox = (process.env.HARA_SANDBOX ?? merged.sandbox ?? "off") as SandboxMode;
  const theme = (process.env.HARA_THEME ?? merged.theme ?? "dark") as "dark" | "light";
  const evolve = (process.env.HARA_EVOLVE ?? merged.evolve ?? "proactive") as "off" | "light" | "proactive";
  const assetCapture = (process.env.HARA_ASSET_CAPTURE ?? merged.assetCapture ?? "ask") as "off" | "ask" | "auto";
  const requestedComputerUse = nonBlankEnv(process.env.HARA_COMPUTER_USE) ?? merged.computerUse ?? "off";
  const computerUse = COMPUTER_USE_MODES.includes(requestedComputerUse as HaraConfig["computerUse"])
    ? requestedComputerUse as HaraConfig["computerUse"]
    : "off";
  const computerApps = String(process.env.HARA_COMPUTER_APPS ?? merged.computerApps ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const visionModel = nonBlankEnv(process.env.HARA_VISION_MODEL) ?? merged.visionModel;
  const requestedVisionProvider = nonBlankEnv(process.env.HARA_VISION_PROVIDER) ?? merged.visionProvider;
  const visionProvider = isProviderId(requestedVisionProvider) && requestedVisionProvider !== "hara-gateway"
    ? requestedVisionProvider
    : undefined;
  const visionBaseURL = nonBlankEnv(process.env.HARA_VISION_BASE_URL) ?? merged.visionBaseURL;
  const visionApiKey = nonBlankEnv(process.env.HARA_VISION_API_KEY) ?? merged.visionApiKey;
  const requestedVisionSource = nonBlankEnv(process.env.HARA_VISION_SOURCE) ?? merged.visionSource;
  const visionSource: VisionModelSource = requestedVisionSource === "custom"
    || (requestedVisionSource !== "current" && Boolean(visionProvider || visionBaseURL || visionApiKey))
    ? "custom"
    : "current";
  const modelVision = merged.modelVision && typeof merged.modelVision === "object" ? (merged.modelVision as Record<string, "yes" | "no">) : {};
  const embedProvider = (nonBlankEnv(process.env.HARA_EMBED_PROVIDER) ?? merged.embedProvider ?? "off") as "off" | "ollama" | "qwen" | "openai";
  const embedModel = nonBlankEnv(process.env.HARA_EMBED_MODEL) ?? merged.embedModel;
  const embedBaseURL = nonBlankEnv(process.env.HARA_EMBED_BASE_URL) ?? merged.embedBaseURL;
  const embedApiKey = nonBlankEnv(process.env.HARA_EMBED_API_KEY) ?? merged.embedApiKey;
  const routeModel = nonBlankEnv(process.env.HARA_ROUTE_MODEL) ?? merged.routeModel;
  const routeBaseURL = nonBlankEnv(process.env.HARA_ROUTE_BASE_URL) ?? merged.routeBaseURL;
  const routeApiKey = nonBlankEnv(process.env.HARA_ROUTE_API_KEY) ?? merged.routeApiKey;
  const mcpServers: Record<string, McpServerConfig> = {
    ...(globalBase.mcpServers ?? {}),
    ...(overlay.mcpServers ?? {}),
    ...(project.mcpServers ?? {}),
  };
  const hooks = (merged.hooks && typeof merged.hooks === "object" ? merged.hooks : {}) as HooksConfig;
  // Guardian: default ON; env HARA_GUARDIAN=0/off/false or config guardian:"off" disables it.
  const guardianRaw = process.env.HARA_GUARDIAN ?? merged.guardian;
  const guardian: "on" | "off" = guardianRaw === "0" || guardianRaw === "off" || guardianRaw === "false" ? "off" : "on";
  const notify = (process.env.HARA_NOTIFY ?? merged.notify ?? "off") as NotifyMode;
  const runTimeoutMs = agentRunTimeoutMs(process.env.HARA_RUN_TIMEOUT_MS ?? merged.runTimeoutMs);
  const maxAgentRounds = agentMaxRounds(process.env.HARA_MAX_AGENT_ROUNDS ?? merged.maxAgentRounds);
  const vimMode = process.env.HARA_VIM === "1" || merged.vimMode === true || merged.vimMode === "true";
  const autoCompact = !(process.env.HARA_AUTO_COMPACT === "0" || merged.autoCompact === false || merged.autoCompact === "false"); // default ON
  const fileCheckpoints = !(process.env.HARA_CHECKPOINTS === "0" || merged.fileCheckpoints === false || merged.fileCheckpoints === "false"); // default ON
  const updateCheck = !(process.env.HARA_UPDATE_CHECK === "0" || merged.updateCheck === false || merged.updateCheck === "false"); // default ON
  const userProxy = typeof overlay.proxy === "string" && overlay.proxy.trim()
    ? overlay.proxy.trim()
    : typeof globalBase.proxy === "string" && globalBase.proxy.trim()
      ? globalBase.proxy.trim()
      : undefined;
  const proxy = userProxy;
  const packageRegistry = nonBlankEnv(process.env.HARA_PACKAGE_REGISTRY)
    ?? (typeof merged.packageRegistry === "string" && merged.packageRegistry.trim() ? merged.packageRegistry.trim() : undefined);
  const fallbackModel = nonBlankEnv(process.env.HARA_FALLBACK_MODEL) ?? merged.fallbackModel;
  const requestedFallbackProvider = nonBlankEnv(process.env.HARA_FALLBACK_PROVIDER) ?? merged.fallbackProvider;
  const fallbackProvider = isProviderId(requestedFallbackProvider) ? requestedFallbackProvider : undefined;
  const fallbackBaseURL = nonBlankEnv(process.env.HARA_FALLBACK_BASE_URL) ?? merged.fallbackBaseURL;
  const fallbackApiKey = nonBlankEnv(process.env.HARA_FALLBACK_API_KEY) ?? merged.fallbackApiKey;
  const reasoningRaw = process.env.HARA_REASONING_EFFORT ?? merged.reasoningEffort;
  const reasoningEffort = reasoningRaw && REASONING_EFFORTS.includes(
    reasoningRaw as NonNullable<HaraConfig["reasoningEffort"]>,
  )
    ? (reasoningRaw as NonNullable<HaraConfig["reasoningEffort"]>)
    : undefined;

  return { provider, apiKey, model, baseURL, approval, sandbox, theme, evolve, assetCapture, computerUse, computerApps, visionModel, visionSource, visionProvider, visionBaseURL, visionApiKey, modelVision, embedProvider, embedModel, embedBaseURL, embedApiKey, routeModel, routeBaseURL, routeApiKey, guardian, hooks, notify, runTimeoutMs, maxAgentRounds, vimMode, autoCompact, fileCheckpoints, updateCheck, proxy, packageRegistry, fallbackModel, fallbackProvider, fallbackBaseURL, fallbackApiKey, reasoningEffort, mcpServers, cwd: effectiveCwd };
}

export function providerEnvKey(provider: ProviderId): string {
  return (PROVIDER_DEFAULTS[provider] ?? PROVIDER_DEFAULTS.anthropic).envKey;
}

/** Preset base URL for a provider (undefined for anthropic/openai which use their SDK defaults).
 *  Used by `hara setup` to write a self-contained baseURL for GLM/DeepSeek/OpenRouter. */
export function providerDefaultBaseURL(provider: ProviderId): string | undefined {
  return PROVIDER_DEFAULTS[provider]?.baseURL;
}

export function providerDefaultModel(provider: ProviderId): string {
  return PROVIDER_DEFAULTS[provider]?.model ?? PROVIDER_DEFAULTS.anthropic.model;
}
