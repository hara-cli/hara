import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import type { SandboxMode } from "./sandbox.js";

export type ProviderId = "anthropic" | "qwen" | "qwen-oauth" | "openai";
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
};

export const CONFIG_KEYS = ["provider", "apiKey", "model", "baseURL", "approval", "sandbox", "theme", "evolve", "assetCapture", "visionModel", "visionBaseURL", "visionApiKey"] as const;
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

export function writeConfigValue(key: string, value: string): void {
  const p = configPath();
  const cfg = readRawConfig();
  cfg[key] = value;
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

/** Record (or clear, with cap=null) a confirmed per-model vision capability in `modelVision`. */
export function setModelVisionOverride(model: string, cap: "yes" | "no" | null): void {
  const p = configPath();
  const cfg = readRawConfig();
  const map: Record<string, string> = cfg.modelVision && typeof cfg.modelVision === "object" ? cfg.modelVision : {};
  if (cap === null) delete map[model];
  else map[model] = cap;
  cfg.modelVision = map;
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

/**
 * Effective config. Precedence (high→low): env vars > selected profile >
 * project `.hara/config.json` > global `~/.hara/config.json` > provider defaults.
 */
export function loadConfig(opts: { profile?: string } = {}): HaraConfig {
  const global = readRawConfig();
  const { profiles, ...globalBase } = global;
  const project = readProjectConfig(process.cwd());
  const profileName = process.env.HARA_PROFILE ?? opts.profile;
  const profile = profileName && profiles && profiles[profileName] ? profiles[profileName] : {};
  const merged: Record<string, any> = { ...globalBase, ...project, ...profile };

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
  const visionModel = process.env.HARA_VISION_MODEL ?? merged.visionModel;
  const visionBaseURL = process.env.HARA_VISION_BASE_URL ?? merged.visionBaseURL;
  const visionApiKey = process.env.HARA_VISION_API_KEY ?? merged.visionApiKey;
  const modelVision = merged.modelVision && typeof merged.modelVision === "object" ? (merged.modelVision as Record<string, "yes" | "no">) : {};
  const mcpServers: Record<string, McpServerConfig> = {
    ...(globalBase.mcpServers ?? {}),
    ...(project.mcpServers ?? {}),
    ...(profile.mcpServers ?? {}),
  };

  return { provider, apiKey, model, baseURL, approval, sandbox, theme, evolve, assetCapture, visionModel, visionBaseURL, visionApiKey, modelVision, mcpServers, cwd: process.cwd() };
}

export function providerEnvKey(provider: ProviderId): string {
  return (PROVIDER_DEFAULTS[provider] ?? PROVIDER_DEFAULTS.anthropic).envKey;
}
