import {
  DECISION_ENGINES,
  DECISION_MODES,
  loadConfig,
  updateRawConfig,
  type DecisionEngineId,
  type DecisionMode,
} from "./config.js";
import {
  judgeActionWithTypeSafe,
  normalizeTypeSafeBaseURL,
  TYPESAFE_DEFAULT_BASE_URL,
  TYPESAFE_DEFAULT_MODEL,
} from "./decision/typesafe.js";
import { redactSensitiveText } from "./security/secrets.js";

export interface DecisionSettingsState {
  engine: DecisionEngineId;
  mode: DecisionMode;
  model: string;
  baseURL: string;
  credential: "stored" | "environment" | "missing";
  engineEditable: boolean;
  modeEditable: boolean;
  modelEditable: boolean;
  baseURLEditable: boolean;
  credentialEditable: boolean;
}

export interface DecisionSettingsInput {
  engine: DecisionEngineId;
  mode: DecisionMode;
  model: string;
  baseURL: string;
  apiKey?: string;
  clearApiKey?: boolean;
}

export interface DecisionSettingsTestInput {
  model?: string;
  baseURL?: string;
  apiKey?: string;
  clearApiKey?: boolean;
}

export interface DecisionSettingsTestResult {
  ok: boolean;
  decision?: "allow" | "review" | "block";
  confidence?: number;
  model?: string;
  elapsedMs?: number;
  error?: string;
}

function envValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function cleanModel(value: string | undefined): string {
  const model = value?.trim() || TYPESAFE_DEFAULT_MODEL;
  if (model.length > 256 || /[\u0000-\u001f\u007f]/u.test(model)) {
    throw new Error("decision model must be 1-256 printable characters");
  }
  return model;
}

function cleanApiKey(value: string | undefined): string | undefined {
  const key = value?.trim();
  if (!key) return undefined;
  if (key.length > 4096 || /\s/u.test(key) || /[\u0000-\u001f\u007f]/u.test(key)) {
    throw new Error("TypeSafe API key must be a non-empty value without whitespace");
  }
  return key;
}

function environmentCredential(): string | undefined {
  return envValue("HARA_DECISION_API_KEY") ?? envValue("TYPESAFE_API_KEY");
}

export function decisionSettingsSnapshot(targetCwd: string): DecisionSettingsState {
  const config = loadConfig({ cwd: targetCwd });
  const environmentKey = environmentCredential();
  return {
    engine: config.decisionEngine,
    mode: config.decisionMode,
    model: config.decisionModel,
    baseURL: config.decisionBaseURL,
    credential: environmentKey ? "environment" : config.decisionApiKey ? "stored" : "missing",
    engineEditable: process.env.HARA_DECISION_ENGINE === undefined,
    modeEditable: process.env.HARA_DECISION_MODE === undefined,
    modelEditable: process.env.HARA_DECISION_MODEL === undefined,
    baseURLEditable: process.env.HARA_DECISION_BASE_URL === undefined,
    credentialEditable: !environmentKey,
  };
}

/** Persist only the global user policy. Repository config cannot opt a task into an external judge. */
export function saveDecisionSettings(input: DecisionSettingsInput, targetCwd: string): DecisionSettingsState {
  if (!DECISION_ENGINES.includes(input.engine)) {
    throw new Error(`decision engine must be one of: ${DECISION_ENGINES.join(", ")}`);
  }
  if (!DECISION_MODES.includes(input.mode)) {
    throw new Error(`decision mode must be one of: ${DECISION_MODES.join(", ")}`);
  }
  const model = cleanModel(input.model);
  const baseURL = normalizeTypeSafeBaseURL(input.baseURL || TYPESAFE_DEFAULT_BASE_URL);
  const apiKey = cleanApiKey(input.apiKey);
  if (input.clearApiKey === true && apiKey) throw new Error("apiKey and clearApiKey are mutually exclusive");

  const effective = loadConfig({ cwd: targetCwd });
  if (process.env.HARA_DECISION_ENGINE !== undefined && input.engine !== effective.decisionEngine) {
    throw new Error("decision engine is controlled by HARA_DECISION_ENGINE");
  }
  if (process.env.HARA_DECISION_MODE !== undefined && input.mode !== effective.decisionMode) {
    throw new Error("decision mode is controlled by HARA_DECISION_MODE");
  }
  if (process.env.HARA_DECISION_MODEL !== undefined && model !== effective.decisionModel) {
    throw new Error("decision model is controlled by HARA_DECISION_MODEL");
  }
  if (process.env.HARA_DECISION_BASE_URL !== undefined && baseURL !== effective.decisionBaseURL) {
    throw new Error("decision endpoint is controlled by HARA_DECISION_BASE_URL");
  }
  if (environmentCredential() && (apiKey || input.clearApiKey === true)) {
    throw new Error("TypeSafe credential is controlled by the Engine launch environment");
  }

  updateRawConfig((config) => {
    if (process.env.HARA_DECISION_ENGINE === undefined) config.decisionEngine = input.engine;
    if (process.env.HARA_DECISION_MODE === undefined) config.decisionMode = input.mode;
    if (process.env.HARA_DECISION_MODEL === undefined) config.decisionModel = model;
    if (process.env.HARA_DECISION_BASE_URL === undefined) config.decisionBaseURL = baseURL;
    if (!environmentCredential()) {
      if (apiKey) config.decisionApiKey = apiKey;
      else if (input.clearApiKey === true) delete config.decisionApiKey;
    }
  });
  return decisionSettingsSnapshot(targetCwd);
}

/** Test unsaved values with a fixed, content-free action. No chat, screenshot, recipient, or project data leaves Hara. */
export async function testDecisionSettings(
  input: DecisionSettingsTestInput,
  targetCwd: string,
): Promise<DecisionSettingsTestResult> {
  const current = loadConfig({ cwd: targetCwd });
  const apiKey = input.clearApiKey === true
    ? undefined
    : cleanApiKey(input.apiKey) ?? current.decisionApiKey;
  try {
    const result = await judgeActionWithTypeSafe({
      mode: "shadow",
      apiKey,
      baseURL: normalizeTypeSafeBaseURL(input.baseURL ?? current.decisionBaseURL),
      model: cleanModel(input.model ?? current.decisionModel),
      proxy: current.proxy,
    }, {
      task: "Verify the Hara action guard connection with a synthetic local-only check.",
      tool: "computer",
      category: "read",
      classifierReason: "connection test",
      detail: "Take a local screenshot without clicking, typing, sending, or changing data.",
    }, { timeoutMs: 10_000 });
    return {
      ok: true,
      decision: result.decision,
      confidence: result.confidence,
      model: result.model,
      elapsedMs: result.elapsedMs,
    };
  } catch (error) {
    return {
      ok: false,
      error: redactSensitiveText(error instanceof Error ? error.message : String(error)).text.slice(0, 300),
    };
  }
}
