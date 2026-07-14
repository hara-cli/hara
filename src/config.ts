import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import type { SandboxMode } from "./sandbox.js";
import type { HooksConfig } from "./hooks.js";
import type { NotifyMode } from "./notify.js";
import { agentMaxRounds, agentRunTimeoutMs } from "./agent/limits.js";
import { ensurePrivateHaraState } from "./security/private-state.js";
import { readVerifiedRegularFileSnapshotSync } from "./fs-read.js";
import { projectRepositoryTrustedAtStartup } from "./security/project-trust.js";
import { isHomeWorkspace } from "./context/workspace-scope.js";

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
  /** startup update check (cached daily npm probe → one-line notice on launch). default on. */
  updateCheck: boolean;
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
   *   - "low"    → small budget (anthropic budget_tokens, openai reasoning_effort:"low")
   *   - "medium" → balanced (anthropic adaptive, openai reasoning_effort:"medium")
   *   - "high"   → large budget (anthropic budget_tokens up, openai reasoning_effort:"high")
   *  GLM/DeepSeek-style models put reasoning in the stream and can't be silenced here — "off" just
   *  means we don't render it (handled at the UI layer). */
  reasoningEffort: "off" | "low" | "medium" | "high" | "max" | undefined;
  /** lifecycle hooks (PreToolUse/PostToolUse) — shell commands run around tool calls */
  hooks: HooksConfig;
  /** Guardian safety layer: an internal HIGH-RISK classifier + a conservative cheap-model veto + a hard
   *  circuit-breaker, layered on top of permission rules / hooks / the approval gate. "on" (default) engages
   *  ONLY on genuinely dangerous actions (rm -rf, dd, curl|sh, sudo, force-push, out-of-project writes, …)
   *  so normal work is untouched (zero added latency). "off" disables it. Also switchable via HARA_GUARDIAN. */
  guardian: "on" | "off";
  /** ping when a (non-trivial) turn finishes: off | bell (terminal BEL) | system (OS notification + bell) */
  notify: NotifyMode;
  /** hard wall-clock ceiling for one agent run; activity cannot renew it forever (default 30 minutes). */
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

export const CONFIG_KEYS = ["provider", "apiKey", "model", "baseURL", "approval", "sandbox", "theme", "evolve", "assetCapture", "computerUse", "computerApps", "visionModel", "visionBaseURL", "visionApiKey", "embedProvider", "embedModel", "embedBaseURL", "embedApiKey", "routeModel", "routeBaseURL", "routeApiKey", "guardian", "notify", "runTimeoutMs", "maxAgentRounds", "vimMode", "autoCompact", "fileCheckpoints", "updateCheck", "fallbackModel", "fallbackProvider", "fallbackBaseURL", "fallbackApiKey", "reasoningEffort"] as const;
export const REASONING_EFFORTS: NonNullable<HaraConfig["reasoningEffort"]>[] = ["off", "low", "medium", "high", "max"];
export const APPROVAL_MODES: ApprovalMode[] = ["suggest", "auto-edit", "full-auto"];
export const SANDBOX_MODES: SandboxMode[] = ["off", "workspace-write", "read-only"];
const PROJECT_ROOT_MARKERS = [".git", "package.json", "Cargo.toml", "go.mod", "pyproject.toml", ".hg"];
const MAX_PROJECT_CONFIG_BYTES = 256 * 1024;
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

function configRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : {};
}

export function readRawConfig(): Record<string, any> {
  ensurePrivateHaraState();
  const p = configPath();
  if (!existsSync(p)) return {};
  try {
    return configRecord(JSON.parse(readFileSync(p, "utf8")));
  } catch {
    return {};
  }
}

const ROUTING_CONFIG_KEYS = new Set([
  "provider", "apiKey", "model", "baseURL",
  "fallbackProvider", "fallbackApiKey", "fallbackModel", "fallbackBaseURL",
  "visionApiKey", "visionModel", "visionBaseURL",
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

/** Write the config 0600 (it can hold `apiKey`) + tighten an existing file. */
function persistConfig(p: string, cfg: Record<string, unknown>): void {
  ensurePrivateHaraState();
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  try { chmodSync(dirname(p), 0o700); } catch { /* best effort */ }
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

  const provider = (nonBlankEnv(process.env.HARA_PROVIDER) ?? merged.provider ?? "anthropic") as ProviderId;
  const d = PROVIDER_DEFAULTS[provider] ?? PROVIDER_DEFAULTS.anthropic;
  const model = nonBlankEnv(process.env.HARA_MODEL) ?? merged.model ?? d.model;
  const baseURL = nonBlankEnv(process.env.HARA_BASE_URL) ?? merged.baseURL ?? d.baseURL;
  const apiKey = nonBlankEnv(process.env.HARA_API_KEY) ?? nonBlankEnv(process.env[d.envKey]) ?? merged.apiKey;
  const approval = (process.env.HARA_APPROVAL ?? merged.approval ?? "suggest") as ApprovalMode;
  const sandbox = (process.env.HARA_SANDBOX ?? merged.sandbox ?? "off") as SandboxMode;
  const theme = (process.env.HARA_THEME ?? merged.theme ?? "dark") as "dark" | "light";
  const evolve = (process.env.HARA_EVOLVE ?? merged.evolve ?? "proactive") as "off" | "light" | "proactive";
  const assetCapture = (process.env.HARA_ASSET_CAPTURE ?? merged.assetCapture ?? "ask") as "off" | "ask" | "auto";
  const computerUse = (process.env.HARA_COMPUTER_USE ?? merged.computerUse ?? "off") as "off" | "read" | "click" | "full";
  const computerApps = String(process.env.HARA_COMPUTER_APPS ?? merged.computerApps ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const visionModel = nonBlankEnv(process.env.HARA_VISION_MODEL) ?? merged.visionModel;
  const visionBaseURL = nonBlankEnv(process.env.HARA_VISION_BASE_URL) ?? merged.visionBaseURL;
  const visionApiKey = nonBlankEnv(process.env.HARA_VISION_API_KEY) ?? merged.visionApiKey;
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
  const fallbackModel = nonBlankEnv(process.env.HARA_FALLBACK_MODEL) ?? merged.fallbackModel;
  const fallbackProvider = (nonBlankEnv(process.env.HARA_FALLBACK_PROVIDER) ?? merged.fallbackProvider) as ProviderId | undefined;
  const fallbackBaseURL = nonBlankEnv(process.env.HARA_FALLBACK_BASE_URL) ?? merged.fallbackBaseURL;
  const fallbackApiKey = nonBlankEnv(process.env.HARA_FALLBACK_API_KEY) ?? merged.fallbackApiKey;
  const reasoningRaw = process.env.HARA_REASONING_EFFORT ?? merged.reasoningEffort;
  const reasoningEffort = reasoningRaw && (["off", "low", "medium", "high", "max"] as const).includes(reasoningRaw as never)
    ? (reasoningRaw as "off" | "low" | "medium" | "high" | "max")
    : undefined;

  return { provider, apiKey, model, baseURL, approval, sandbox, theme, evolve, assetCapture, computerUse, computerApps, visionModel, visionBaseURL, visionApiKey, modelVision, embedProvider, embedModel, embedBaseURL, embedApiKey, routeModel, routeBaseURL, routeApiKey, guardian, hooks, notify, runTimeoutMs, maxAgentRounds, vimMode, autoCompact, fileCheckpoints, updateCheck, fallbackModel, fallbackProvider, fallbackBaseURL, fallbackApiKey, reasoningEffort, mcpServers, cwd: effectiveCwd };
}

export function providerEnvKey(provider: ProviderId): string {
  return (PROVIDER_DEFAULTS[provider] ?? PROVIDER_DEFAULTS.anthropic).envKey;
}

/** Preset base URL for a provider (undefined for anthropic/openai which use their SDK defaults).
 *  Used by `hara setup` to write a self-contained baseURL for GLM/DeepSeek/OpenRouter. */
export function providerDefaultBaseURL(provider: ProviderId): string | undefined {
  return PROVIDER_DEFAULTS[provider]?.baseURL;
}
