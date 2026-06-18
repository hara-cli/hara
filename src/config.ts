import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

export type ProviderId = "anthropic" | "qwen" | "qwen-oauth" | "openai";

export interface HaraConfig {
  provider: ProviderId;
  apiKey: string | undefined;
  model: string;
  baseURL: string | undefined;
  cwd: string;
}

const PROVIDER_DEFAULTS: Record<ProviderId, { model: string; baseURL?: string; envKey: string }> = {
  anthropic: { model: "claude-opus-4-8", envKey: "ANTHROPIC_API_KEY" },
  qwen: {
    model: "qwen-plus",
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    envKey: "DASHSCOPE_API_KEY",
  },
  // free "Qwen Code" OAuth tier — auth comes from ~/.hara/qwen-oauth.json, not an apiKey
  "qwen-oauth": { model: "coder-model", envKey: "QWEN_OAUTH_TOKEN" },
  openai: { model: "gpt-4o-mini", envKey: "OPENAI_API_KEY" },
};

export const CONFIG_KEYS = ["provider", "apiKey", "model", "baseURL"] as const;

export function configPath(): string {
  return join(homedir(), ".hara", "config.json");
}

export function readRawConfig(): Record<string, string> {
  const p = configPath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

export function writeConfigValue(key: string, value: string): void {
  const p = configPath();
  const cfg = readRawConfig();
  cfg[key] = value;
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

/** Effective config: env vars take precedence over the config file; provider sets the defaults. */
export function loadConfig(): HaraConfig {
  const raw = readRawConfig();
  const provider = (process.env.HARA_PROVIDER ?? raw.provider ?? "anthropic") as ProviderId;
  const d = PROVIDER_DEFAULTS[provider] ?? PROVIDER_DEFAULTS.anthropic;
  const model = process.env.HARA_MODEL ?? raw.model ?? d.model;
  const baseURL = process.env.HARA_BASE_URL ?? raw.baseURL ?? d.baseURL;
  const apiKey = process.env.HARA_API_KEY ?? process.env[d.envKey] ?? raw.apiKey;
  return { provider, apiKey, model, baseURL, cwd: process.cwd() };
}

export function providerEnvKey(provider: ProviderId): string {
  return (PROVIDER_DEFAULTS[provider] ?? PROVIDER_DEFAULTS.anthropic).envKey;
}
