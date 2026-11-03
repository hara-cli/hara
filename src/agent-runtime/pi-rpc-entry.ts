// The bundled Pi engine's official RPC mode in a dedicated protected process. No Hara profile startup.
// Native tools execute here; only explicitly supplied Hara MCP tools cross back to the Host governor.
import { closeSync, lstatSync, readSync, realpathSync } from "node:fs";
import { join, dirname, isAbsolute, relative } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  AgentSessionRuntime, ModelRuntime, SettingsManager, SessionManager,
  createAgentSession, createExtensionRuntime, runRpcMode, type ResourceLoader, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ToolSpec } from "../providers/types.js";
import { classifyRuntimeFailure } from "./failure-diagnostics.js";
import { assertHostPiVersion } from "./pi-session.js";
import { PI_NATIVE_TOOL_NAMES, piWorkspaceToolName } from "./pi-native-tools.js";

export interface PiNativeChildConfig {
  schemaVersion: 1; sdkVersion: "1.5.0"; cwd: string; root: string; system: string;
  model: { baseURL: string; token: string };
  mcp: { url: string; token: string; tools: ToolSpec[] };
  sessionFile: string | null;
}
function refused(): never { throw new Error("Pi protected RPC configuration refused"); }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function schemaKey(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(schemaKey).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + schemaKey((value as Record<string, unknown>)[key])).join(",") + "}";
  return JSON.stringify(value);
}
const within = (root: string, path: string) => { const tail = relative(root, path); return tail !== ".." && !tail.startsWith("../") && !isAbsolute(tail); };
export function readPiNativeChildConfig(): PiNativeChildConfig {
  // One inherited pipe, consumed and closed BEFORE loading a session or any tool. No capability file.
  const chunks: Buffer[] = []; let length = 0;
  try {
    for (;;) {
      const buffer = Buffer.alloc(65536), bytes = readSync(3, buffer, 0, buffer.length, null);
      if (!bytes) break;
      length += bytes; if (length > 512 * 1024) return refused();
      chunks.push(buffer.subarray(0, bytes));
    }
  } finally { closeSync(3); }
  let config: unknown;
  try { config = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return refused(); }
  if (!object(config) || JSON.stringify(Object.keys(config).sort()) !== JSON.stringify(["schemaVersion", "sdkVersion", "cwd", "root", "system", "model", "mcp", "sessionFile"].sort())
    || config.schemaVersion !== 1 || config.sdkVersion !== "1.5.0" || typeof config.root !== "string" || typeof config.cwd !== "string"
    || realpathSync.native(config.root) !== config.root || realpathSync.native(config.cwd) !== config.cwd || config.cwd !== realpathSync.native(process.cwd())
    || (lstatSync(config.root).mode & 0o077)
    || typeof config.system !== "string" || !config.system.trim() || Buffer.byteLength(config.system) > 256 * 1024
    || !object(config.model) || !object(config.mcp) || !Array.isArray(config.mcp.tools) || config.mcp.tools.length > 128) return refused();
  const base = new URL(String(config.model.baseURL)), mcp = new URL(String(config.mcp.url));
  if (base.protocol !== "http:" || base.hostname !== "127.0.0.1" || !base.port || !/^\/pi\/[a-f0-9]{64}\/v1\/?$/.test(base.pathname)
    || base.search || base.hash || base.username || base.password || !/^[A-Za-z0-9_-]{43}$/.test(String(config.model.token))
    || mcp.protocol !== "http:" || mcp.hostname !== "127.0.0.1" || !mcp.port || mcp.pathname !== "/mcp"
    || mcp.search || mcp.hash || mcp.username || mcp.password || !/^[a-f0-9]{64}$/.test(String(config.mcp.token))) return refused();
  const names = new Set<string>();
  for (const tool of config.mcp.tools) {
    if (!object(tool) || typeof tool.name !== "string" || names.has(tool.name) || typeof tool.description !== "string" || !object(tool.input_schema)) return refused();
    piWorkspaceToolName(tool.name); names.add(tool.name);
  }
  if (config.sessionFile !== null && (typeof config.sessionFile !== "string" || realpathSync.native(config.sessionFile) !== config.sessionFile
    || !within(join(config.root, "agent/sessions"), config.sessionFile) || !lstatSync(config.sessionFile).isFile())) return refused();
  if (process.env.HOME !== join(config.root, "home") || process.env.PI_CODING_AGENT_DIR !== join(config.root, "agent")) return refused();
  return config as unknown as PiNativeChildConfig;
}
export async function mainPiNativeRpc(args: string[]): Promise<never> {
  let stage: "configuration" | "model" | "mcp" | "session" | "rpc" = "configuration";
  try {
  assertHostPiVersion();
  if (args.length !== 4 || args[0] !== "--mode" || args[1] !== "rpc" || args[2] !== "--config-fd" || args[3] !== "3") return refused();
  const input = readPiNativeChildConfig();
  process.title = "hara-pi-rpc";
  const agentDir = join(input.root, "agent");
  stage = "model";
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"),
    modelsStorePath: join(agentDir, "models-store.json"), refreshOnCreate: false, allowModelNetwork: false });
  modelRuntime.refresh = async (options = {}) => ({ aborted: options.signal?.aborted ?? false, errors: new Map() });
  modelRuntime.registerProvider("hara", { baseUrl: input.model.baseURL, api: "openai-completions", apiKey: input.model.token,
    models: [{ id: "coding", name: "Hara frozen connection", reasoning: false, input: ["text"], contextWindow: 131072, maxTokens: 16384,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsDeveloperRole: false, supportsStore: false,
        supportsReasoningEffort: false, supportsUsageInStreaming: true, supportsLongCacheRetention: false, supportsMidConvoSystemMessages: false, thinkingFormat: "deepseek" } }] });
  const model = modelRuntime.getModel("hara", "coding"); if (!model) return refused();
  const settingsManager = SettingsManager.inMemory({ defaultProvider: "hara", defaultModel: "coding", defaultThinkingLevel: "off", enabledModels: ["hara/coding"],
    defaultProjectTrust: "never", defaultTools: [...PI_NATIVE_TOOL_NAMES], compaction: { enabled: false }, retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
    cacheWarming: "off", enableAnalytics: false, enableInstallTelemetry: false, enableSkillCommands: false, packages: [], extensions: [], skills: [], prompts: [], themes: [],
    images: { blockImages: true }, transport: "sse", quietStartup: true });
  const extensionRuntime = createExtensionRuntime();
  const resourceLoader: ResourceLoader = {
    getExtensions: () => ({ extensions: [], errors: [], runtime: extensionRuntime }), getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }), getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => input.system, getSystemPromptSource: () => undefined, getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
    extendResources() {}, async reload() {},
  };
  stage = "mcp";
  const client = new Client({ name: "hara-pi-rpc", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(input.mcp.url), { requestInit: { headers: { Authorization: "Bearer " + input.mcp.token } } }));
  const inventory = await client.listTools();
  if (inventory.tools.length !== input.mcp.tools.length || inventory.tools.some(tool => !input.mcp.tools.some(trusted => trusted.name === tool.name
    && schemaKey(trusted.input_schema) === schemaKey(tool.inputSchema)))) return refused();
  const customTools: ToolDefinition[] = input.mcp.tools.map(tool => ({ name: piWorkspaceToolName(tool.name), label: tool.name, description: tool.description,
    parameters: tool.input_schema as ToolDefinition["parameters"], executionMode: "sequential",
    async execute(_id, parameters, signal) {
      const result = await client.callTool({ name: tool.name, arguments: parameters as Record<string, unknown> }, undefined, { signal });
      if (!Array.isArray(result.content) || result.content.some(part => part.type !== "text" || typeof part.text !== "string")) throw new Error("Hara MCP result refused");
      if (result.isError) throw new Error("Hara MCP refused: " + result.content.map(part => (part as { text: string }).text).join("\n").slice(0, 65536));
      return { content: result.content as { type: "text"; text: string }[], details: {} };
    } }));
  stage = "session";
  const manager = input.sessionFile ? SessionManager.open(input.sessionFile, join(agentDir, "sessions")) : SessionManager.create(input.cwd, join(agentDir, "sessions"));
  const created = await createAgentSession({ cwd: input.cwd, agentDir, modelRuntime, model, thinkingLevel: "off", scopedModels: [{ model, thinkingLevel: "off" }],
    resourceLoader, settingsManager, sessionManager: manager, tools: [...PI_NATIVE_TOOL_NAMES, ...customTools.map(tool => tool.name)], customTools });
  if (created.modelFallbackMessage || created.session.model?.provider !== "hara" || created.session.model.id !== "coding"
    || JSON.stringify(created.session.getActiveToolNames().sort()) !== JSON.stringify([...PI_NATIVE_TOOL_NAMES, ...customTools.map(tool => tool.name)].sort())) return refused();
  const services = { cwd: input.cwd, agentDir, modelRuntime, settingsManager, resourceLoader, diagnostics: [] };
  stage = "rpc";
  const runtime = new AgentSessionRuntime(created.session, services, async () => refused());
  process.once("exit", () => { void client.close().catch(() => {}); });
  return runRpcMode(runtime);
  } catch (error) {
    const kind = classifyRuntimeFailure({ stderr: error instanceof Error ? error.message : "" });
    throw new Error("Pi protected RPC startup refused: " + stage + ":" + kind);
  }
}
