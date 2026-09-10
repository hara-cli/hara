import { platform } from "node:os";
import {
  COMPUTER_USE_MODES,
  loadConfig,
  updateRawConfig,
  type HaraConfig,
} from "./config.js";

export interface StructuredBrowserStatus {
  installed: boolean;
  enabled: boolean;
  version?: string;
}

export interface ComputerSettingsState {
  mode: HaraConfig["computerUse"];
  apps: string[];
  modeEditable: boolean;
  appsEditable: boolean;
  platform: NodeJS.Platform;
  backend: string;
  browser: StructuredBrowserStatus;
}

export interface ComputerSettingsInput {
  mode: HaraConfig["computerUse"];
  apps: string[];
}

const MAX_APPS = 32;
const MAX_APP_NAME = 80;

export function normalizeComputerApps(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("computer app allowlist must be an array of app names");
  if (value.length > MAX_APPS) throw new Error(`computer app allowlist supports at most ${MAX_APPS} apps`);
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "string") throw new Error("computer app allowlist entries must be strings");
    const name = raw.trim();
    if (!name) continue;
    if (name.length > MAX_APP_NAME || /[\u0000-\u001f\u007f]/u.test(name)) {
      throw new Error(`computer app names must be 1-${MAX_APP_NAME} printable characters`);
    }
    const key = name.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(name);
  }
  return result;
}

export function computerSettingsSnapshot(
  targetCwd: string,
  backend: string,
  browser: StructuredBrowserStatus,
): ComputerSettingsState {
  const config = loadConfig({ cwd: targetCwd });
  return {
    mode: config.computerUse,
    apps: [...config.computerApps],
    modeEditable: process.env.HARA_COMPUTER_USE === undefined,
    appsEditable: process.env.HARA_COMPUTER_APPS === undefined,
    platform: platform(),
    backend,
    browser: { ...browser },
  };
}

/** Persist only the global user policy. Project files cannot silently widen the screen-control boundary. */
export function saveComputerSettings(input: ComputerSettingsInput, targetCwd: string): void {
  if (!COMPUTER_USE_MODES.includes(input.mode)) {
    throw new Error(`computer mode must be one of: ${COMPUTER_USE_MODES.join(", ")}`);
  }
  const apps = normalizeComputerApps(input.apps);
  const effective = loadConfig({ cwd: targetCwd });
  if (process.env.HARA_COMPUTER_USE !== undefined && input.mode !== effective.computerUse) {
    throw new Error("Computer Use mode is overridden by HARA_COMPUTER_USE; remove the environment override before editing Settings");
  }
  if (
    process.env.HARA_COMPUTER_APPS !== undefined
    && JSON.stringify(apps) !== JSON.stringify(effective.computerApps)
  ) {
    throw new Error("Computer Use app allowlist is overridden by HARA_COMPUTER_APPS; remove the environment override before editing Settings");
  }
  updateRawConfig((config) => {
    if (process.env.HARA_COMPUTER_USE === undefined) config.computerUse = input.mode;
    if (process.env.HARA_COMPUTER_APPS === undefined) config.computerApps = apps;
  });
}
