import {
  CURRENT_SESSION_VERSION, VERSION, ModelRuntime, SettingsManager, createAgentSession, createExtensionRuntime,
  type AgentSession, type ResourceLoader, type SessionManager, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { bindPrivateHaraStateFile, readPrivateStateFileSnapshotSync, writePrivateStateFileSync } from "../security/private-state.js";
import type { CodingHostBridge, CodingHostBudget } from "../coding/host.js";

export const HOST_PI_SDK_VERSION = "1.1.0";
declare const __HARA_BUNDLED_PI_SDK_VERSION__: string | undefined;
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export function assertHostPiVersion(): void {
  const version = typeof __HARA_BUNDLED_PI_SDK_VERSION__ === "undefined" ? VERSION : __HARA_BUNDLED_PI_SDK_VERSION__;
  if (version !== HOST_PI_SDK_VERSION || CURRENT_SESSION_VERSION !== 3) throw new Error("Pi SDK version is unsupported");
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Pi host bridge is invalid");
  return value as Record<string, unknown>;
}

/** Only the Hara-owned loopback model/tool proxy is accepted, never a renderer endpoint or ambient key. */
export function hostPiBridgeOptions(bridge: CodingHostBridge, budget: CodingHostBudget) {
  const hara = object(bridge.provider.hara), options = object(hara.options);
  const base = new URL(String(options.baseURL)), mcp = new URL(bridge.mcp.url);
  if (bridge.model !== "hara/coding" || hara.npm !== "@ai-sdk/openai-compatible" || base.protocol !== "http:"
    || base.hostname !== "127.0.0.1" || !base.port || base.pathname !== "/v1" || base.search || base.hash || base.username || base.password
    || mcp.origin !== base.origin || mcp.pathname !== "/mcp" || mcp.search || mcp.hash || mcp.username || mcp.password
    || typeof options.apiKey !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(options.apiKey)
    || bridge.mcp.headers.Authorization !== "Bearer " + options.apiKey || bridge.mcp.type !== "remote") throw new Error("Pi host bridge is invalid");
  if (!Array.isArray(bridge.toolNames) || bridge.toolNames.some((name) => !TOOL_NAME.test(name))
    || new Set(bridge.toolNames).size !== bridge.toolNames.length) throw new Error("Pi host tool whitelist is invalid");
  for (const field of ["maxProviderRounds", "maxToolCalls", "maxTokens", "timeoutMs"] as const) {
    if (!Number.isSafeInteger(budget[field]) || budget[field] < 1 || !Number.isSafeInteger(bridge.budget[field])
      || bridge.budget[field] < 1 || bridge.budget[field] > budget[field]) throw new Error("Pi host budget is invalid");
  }
  return { baseURL: base.href, token: options.apiKey, names: new Set(bridge.toolNames.map((name) => "hara_" + name)) };
}

function resources(system: string): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => system, getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources: () => {}, reload: async () => {},
  };
}

/** Shared SDK primitive, NOT a general-Agent Driver or execution grant. The host supplies its frozen
 * model bridge, validated SessionManager, authorized tool implementations and persona. The caller owns
 * durable state, task governance, bridge closure and physical drain before disposing the session. */
export async function createHostBoundPiSession(input: {
  home: string;
  subdirs: string[];
  cwd: string;
  bridge: CodingHostBridge;
  budget: CodingHostBudget;
  manager: SessionManager;
  tools: ToolDefinition[];
  system: string;
  signal: AbortSignal;
}): Promise<{ session: AgentSession; dispose(): void }> {
  assertHostPiVersion();
  const check = (): void => { if (input.signal.aborted) throw new Error("Pi session creation cancelled"); };
  check();
  const host = hostPiBridgeOptions(input.bridge, input.budget);
  if (typeof input.system !== "string" || !input.system.trim() || Buffer.byteLength(input.system) > 256 * 1024) throw new Error("Pi host system prompt is invalid");
  if (input.tools.length !== host.names.size || new Set(input.tools.map((tool) => tool.name)).size !== host.names.size
    || input.tools.some((tool) => !host.names.has(tool.name))) throw new Error("Pi custom tools differ from the host whitelist");
  const runtimePath = (filename: string) => {
    const binding = bindPrivateHaraStateFile(input.home, input.subdirs, filename);
    const previous = readPrivateStateFileSnapshotSync(binding.path, 4096);
    if (previous) {
      let value: unknown;
      try { value = JSON.parse(previous.text); } catch { throw new Error("Pi isolated runtime configuration changed"); }
      if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length) throw new Error("Pi isolated runtime configuration changed");
    } else writePrivateStateFileSync(binding, "{}\n", { expectedMissing: true });
    return binding;
  };
  const auth = runtimePath("auth.json"), models = runtimePath("models.json"), store = runtimePath("models-store.json");
  const runtime = await ModelRuntime.create({ authPath: auth.path, modelsPath: models.path, modelsStorePath: store.path,
    refreshOnCreate: false, allowModelNetwork: false, signal: input.signal });
  check();
  // registerProvider must not discover another provider/account while a frozen Hara route is running.
  runtime.refresh = async (options = {}) => ({ aborted: options.signal?.aborted ?? false, errors: new Map() });
  runtime.registerProvider("hara", {
    baseUrl: host.baseURL, api: "openai-completions", apiKey: host.token,
    models: [{ id: "coding", name: "Hara current model", reasoning: false, input: ["text"], contextWindow: 131072, maxTokens: 16384,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsDeveloperRole: false, supportsStore: false, supportsReasoningEffort: false, supportsUsageInStreaming: true,
        supportsLongCacheRetention: false, supportsMidConvoSystemMessages: false, thinkingFormat: "deepseek" },
    }],
  });
  const model = runtime.getModel("hara", "coding");
  if (!model) throw new Error("Pi host model is missing");
  const settings = SettingsManager.inMemory({
    defaultProvider: "hara", defaultModel: "coding", defaultThinkingLevel: "off", enabledModels: ["hara/coding"], steeringMode: "all",
    compaction: { enabled: false }, retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } }, cacheWarming: "off",
    enableInstallTelemetry: false, enableAnalytics: false, enableSkillCommands: false, defaultProjectTrust: "never",
    packages: [], extensions: [], skills: [], prompts: [], themes: [], defaultTools: [], images: { blockImages: true }, transport: "sse", quietStartup: true,
  });
  check();
  const created = await createAgentSession({ cwd: input.cwd, agentDir: auth.directory.path, modelRuntime: runtime, model,
    scopedModels: [{ model, thinkingLevel: "off" }], thinkingLevel: "off", resourceLoader: resources(input.system),
    noTools: "builtin", tools: [...host.names], customTools: input.tools, sessionManager: input.manager, settingsManager: settings });
  const session = created.session;
  if (created.modelFallbackMessage || session.model?.provider !== "hara" || session.model.id !== "coding"
    || JSON.stringify(session.getActiveToolNames().sort()) !== JSON.stringify([...host.names].sort())) {
    session.dispose(); throw new Error("Pi model or tool authority changed");
  }
  if (input.signal.aborted) { session.dispose(); throw new Error("Pi session creation cancelled"); }
  const abort = (): void => { session.clearQueue(); void session.abort().catch(() => {}); };
  input.signal.addEventListener("abort", abort, { once: true });
  let disposed = false;
  return { session, dispose() {
    if (disposed) return;
    disposed = true;
    input.signal.removeEventListener("abort", abort);
    session.dispose();
  } };
}
