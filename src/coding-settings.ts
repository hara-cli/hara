import { readRawConfig, updateRawConfig } from "./config.js";

export const CODING_EXECUTOR_PREFERENCES = Object.freeze([
  "auto", "opencode", "pi", "codex", "claude",
] as const);

export type CodingExecutorPreference = typeof CODING_EXECUTOR_PREFERENCES[number];
export type CodingExecutorId = Exclude<CodingExecutorPreference, "auto">;

export interface CodingSettingsState {
  version: 1;
  revision: number;
  executor: CodingExecutorPreference;
  effectiveExecutor: CodingExecutorId;
  /** Engineering default; this is not a claim of benchmark superiority. */
  recommendedExecutor: "opencode";
  executorEditable: boolean;
  experimental: boolean;
}

export interface CodingSettingsInput {
  executor: CodingExecutorPreference;
  expectedRevision: number;
}

interface StoredCodingSettings {
  version: 1;
  revision: number;
  executor: CodingExecutorPreference;
}

// Capture trusted host launch policy once. Repository input and later extension mutations cannot
// select a different executor by changing process.env during a task.
const launchExecutorOverride = process.env.HARA_CODING_EXECUTOR;

export function normalizeCodingExecutorPreference(value: unknown): CodingExecutorPreference {
  if (typeof value !== "string" || !CODING_EXECUTOR_PREFERENCES.includes(value as CodingExecutorPreference)) {
    throw new Error(`coding executor must be one of: ${CODING_EXECUTOR_PREFERENCES.join(", ")}`);
  }
  return value as CodingExecutorPreference;
}

/** Resolve only the engineering default. Runtime availability must never silently change selection. */
export function resolveCodingExecutorPreference(preference: CodingExecutorPreference): CodingExecutorId {
  const executor = normalizeCodingExecutorPreference(preference);
  return executor === "auto" ? "opencode" : executor;
}

function closedRecord(value: unknown, allowedKeys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("coding settings must be an object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("coding settings must be a plain object");
  }
  if (Object.keys(value).some((key) => !allowedKeys.includes(key))) {
    throw new Error("coding settings contains unsupported fields");
  }
  return value as Record<string, unknown>;
}

function validRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function storedCodingSettings(value: unknown): StoredCodingSettings {
  if (value === undefined) return { version: 1, revision: 0, executor: "auto" };
  const record = closedRecord(value, ["version", "revision", "executor"]);
  if (record.version !== 1) throw new Error("unsupported coding settings version");
  if (!validRevision(record.revision)) throw new Error("invalid coding settings revision");
  return { version: 1, revision: record.revision, executor: normalizeCodingExecutorPreference(record.executor) };
}

function snapshot(stored: StoredCodingSettings): CodingSettingsState {
  const executor = launchExecutorOverride === undefined
    ? stored.executor
    : normalizeCodingExecutorPreference(launchExecutorOverride);
  const effectiveExecutor = resolveCodingExecutorPreference(executor);
  return {
    version: 1,
    revision: stored.revision,
    executor,
    effectiveExecutor,
    recommendedExecutor: "opencode",
    executorEditable: launchExecutorOverride === undefined,
    experimental: effectiveExecutor === "pi",
  };
}

/** Read only global private control-plane state. Even trusted repository config is not an executor policy. */
export function codingSettingsSnapshot(_targetCwd?: string): CodingSettingsState {
  return snapshot(storedCodingSettings(readRawConfig().codingSettings));
}

/** Only the trusted host settings path may call this. No package, path, network or credential is accepted. */
export function saveCodingSettings(input: CodingSettingsInput, _targetCwd?: string): CodingSettingsState {
  const record = closedRecord(input, ["executor", "expectedRevision"]);
  const executor = normalizeCodingExecutorPreference(record.executor);
  if (!validRevision(record.expectedRevision)) throw new Error("expectedRevision must be a non-negative safe integer");
  if (launchExecutorOverride !== undefined) {
    normalizeCodingExecutorPreference(launchExecutorOverride);
    throw new Error("coding executor is controlled by HARA_CODING_EXECUTOR; restart without the environment override before editing Settings");
  }
  let saved: StoredCodingSettings | undefined;
  updateRawConfig((config) => {
    const current = storedCodingSettings(config.codingSettings);
    if (current.revision !== record.expectedRevision) {
      throw new Error("coding settings changed; refresh Settings before saving");
    }
    if (current.revision === Number.MAX_SAFE_INTEGER) throw new Error("coding settings revision is exhausted");
    saved = { version: 1, revision: current.revision + 1, executor };
    config.codingSettings = saved;
  });
  return snapshot(saved!);
}
