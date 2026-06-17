import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

export interface HaraConfig {
  apiKey: string | undefined;
  model: string;
  cwd: string;
}

const DEFAULT_MODEL = "claude-opus-4-8";

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

/** Resolve effective config: env vars take precedence over the config file. */
export function loadConfig(): HaraConfig {
  const raw = readRawConfig();
  const apiKey = process.env.ANTHROPIC_API_KEY ?? raw.apiKey;
  const model = process.env.HARA_MODEL ?? raw.model ?? DEFAULT_MODEL;
  return { apiKey, model, cwd: process.cwd() };
}
