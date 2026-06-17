import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";

export interface HaraConfig {
  apiKey: string | undefined;
  model: string;
  cwd: string;
}

const DEFAULT_MODEL = "claude-opus-4-8";

/** Resolve config from env first, then ~/.hara/config.json. */
export function loadConfig(): HaraConfig {
  let apiKey = process.env.ANTHROPIC_API_KEY;
  let model = process.env.HARA_MODEL ?? DEFAULT_MODEL;

  const cfgPath = join(homedir(), ".hara", "config.json");
  if (existsSync(cfgPath)) {
    try {
      const j = JSON.parse(readFileSync(cfgPath, "utf8")) as {
        apiKey?: string;
        model?: string;
      };
      apiKey ??= j.apiKey;
      if (j.model && !process.env.HARA_MODEL) model = j.model;
    } catch {
      // ignore malformed config
    }
  }

  return { apiKey, model, cwd: process.cwd() };
}
