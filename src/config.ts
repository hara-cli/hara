import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

export type ProviderId = "anthropic" | "qwen" | "qwen-oauth" | "openai";
export type ApprovalMode = "suggest" | "auto-edit" | "full-auto";

export interface HaraConfig {
  provider: ProviderId;
  apiKey: string | undefined;
  model: string;
  baseURL: string | undefined;
  approval: ApprovalMode;
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

export const CONFIG_KEYS = ["provider", "apiKey", "model", "baseURL", "approval"] as const;
export const APPROVAL_MODES: ApprovalMode[] = ["suggest", "auto-edit", "full-auto"];
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

  return { provider, apiKey, model, baseURL, approval, cwd: process.cwd() };
}

export function providerEnvKey(provider: ProviderId): string {
  return (PROVIDER_DEFAULTS[provider] ?? PROVIDER_DEFAULTS.anthropic).envKey;
}
