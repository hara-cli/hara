import { createHmac, randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import {
  bindPrivateHaraStateFile,
  ensurePrivateStateSubdirectory,
  readPrivateStateFileSnapshotSync,
  withPrivateStateLockSync,
  writePrivateStateFileSync,
} from "../security/private-state.js";
import { redactSensitiveText } from "../security/secrets.js";
import { toolSubprocessEnv } from "../security/subprocess-env.js";
import { opaqueProviderSessionId, type ExternalSessionOwnershipStore } from "./identity.js";
import { probeExternalCommand, runExternalCommandCapture, type ExternalCommandOptions } from "./process.js";
import type {
  ExternalCodingSessionInput,
  ExternalCodingSessionResumeInput,
  ExternalSessionAdapter,
  ExternalSessionAdapterPage,
  ExternalSessionInfo,
  ExternalSessionMessage,
  ExternalSessionReadResult,
  ExternalSessionSourceInfo,
  ExternalProviderTerminalResult,
  ExternalTurnResult,
  ExternalTurnSink,
} from "./types.js";

const WORKER_AGENT = "hara-worker";
const MCP_NAME = "hara";
const STATE = ["external-sessions", "opencode-workers"];
const OPAQUE_ID = /^ext_opencode_[a-f0-9]{24}$/u;
const NATIVE_ID = /^ses_[a-zA-Z0-9_-]{1,160}$/u;
const FRAME_LIMIT = 1024 * 1024;
const TEXT_LIMIT = 512 * 1024;
const NATIVE_TOOLS = ["invalid", "bash", "shell", "read", "write", "edit", "patch", "apply_patch", "glob", "grep",
  "list", "task", "todowrite", "todoread", "question", "webfetch", "websearch", "lsp", "skill", "plan_enter", "plan_exit",
  "execute", "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"];

export interface OpenCodeWorkerMetrics {
  providerRounds: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface OpenCodeWorkerTurnResult extends ExternalTurnResult {
  metrics?: OpenCodeWorkerMetrics;
}

/** Host-only bridge. The model never supplies providers, MCP endpoints, or execution limits. */
export interface OpenCodeWorkerTurnBridge {
  /** Exact provider/model selection exposed by the host's bounded model route. */
  model: string;
  provider: Record<string, Record<string, unknown>>;
  /** A host-owned MCP endpoint/command that executes through Hara's normal tool policy. */
  mcp: {
    type: "local";
    command: string[];
    environment?: Record<string, string>;
  } | {
    type: "remote";
    url: string;
    headers?: Record<string, string>;
  };
  /** Unprefixed MCP tool names, registered by OpenCode as hara_<name>. */
  toolNames: readonly string[];
  budget: { maxProviderRounds: number; maxToolCalls: number; maxTokens: number; timeoutMs: number };
  /** Authoritative host counters. Preserve this live getter when wrapping a real Hara bridge. */
  readonly metrics?: OpenCodeWorkerMetrics;
  progress(metrics: OpenCodeWorkerMetrics): boolean;
  systemPrompt?: string;
  close?(): Promise<void>;
}

export interface OpenCodeCodingWorkerAdapterOptions extends ExternalCommandOptions {
  identityKey: Buffer;
  identityHome?: string;
  ownership?: ExternalSessionOwnershipStore;
  /** Optional existing history adapter; worker admission never claims its arbitrary sessions. */
  history?: ExternalSessionAdapter;
  /** Missing bridge fails closed before model dispatch. Must preserve the Hara authorization context. */
  prepareTurn?: (
    input: { sessionId: string; cwd: string },
    sink: ExternalTurnSink,
  ) => Promise<OpenCodeWorkerTurnBridge>;
}

interface WorkerBinding {
  version: 1;
  id: string;
  nativeId: string;
  cwd: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

const record = (value: unknown): Record<string, unknown> | null => (
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
);
const safeText = (value: unknown, max = TEXT_LIMIT): string => redactSensitiveText(typeof value === "string" ? value : "").text
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ").slice(0, max);
const parse = (text: string): Record<string, unknown> => {
  try {
    const value = record(JSON.parse(text));
    if (value) return value;
  } catch { /* Provider frames are deliberately not included in errors. */ }
  throw new Error("OpenCode returned invalid structured worker data");
};

/**
 * Durable OpenCode workers use their own private DB and exactly one host tool bridge. Native tools,
 * user plugins/skills/config, and arbitrary provider history are never adopted as worker authority.
 * Worktree admission, approvals, tool policy, and model budget remain owned by the Hara host.
 */
export class OpenCodeCodingWorkerAdapter implements ExternalSessionAdapter {
  readonly id = "opencode" as const;
  private readonly home: string;
  private readonly bindings = new Map<string, WorkerBinding>();
  private readonly running = new Map<string, AbortController>();

  constructor(private readonly options: OpenCodeCodingWorkerAdapterOptions) {
    this.home = options.identityHome ?? homedir();
    // The private index stores only ids. Native ids and canonical paths stay in private bindings.
    const index = bindPrivateHaraStateFile(this.home, STATE, "index.json");
    const snapshot = readPrivateStateFileSnapshotSync(index.path, 1024 * 1024);
    if (snapshot) {
      const indexValue = parse(snapshot.text);
      const rows = indexValue.ids;
      if (indexValue.version !== 1 || !Array.isArray(rows) || rows.length > 5_000 || rows.some((id) => typeof id !== "string" || !OPAQUE_ID.test(id))) {
        throw new Error("the OpenCode worker index is invalid");
      }
      for (const id of rows as string[]) this.load(id);
    }
  }

  private load(id: string): WorkerBinding | undefined {
    if (!OPAQUE_ID.test(id)) return undefined;
    const file = bindPrivateHaraStateFile(this.home, [...STATE, id], "binding.json");
    const snapshot = readPrivateStateFileSnapshotSync(file.path, 32 * 1024);
    if (!snapshot) return undefined;
    const value = parse(snapshot.text);
    if (value.version !== 1 || value.id !== id || typeof value.nativeId !== "string" || !NATIVE_ID.test(value.nativeId)
      || opaqueProviderSessionId("opencode", value.nativeId, this.options.identityKey) !== id
      || typeof value.cwd !== "string" || !isAbsolute(value.cwd) || typeof value.title !== "string"
      || typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") {
      throw new Error("the OpenCode worker binding is invalid");
    }
    const binding = value as unknown as WorkerBinding;
    this.bindings.set(id, binding);
    return binding;
  }

  private save(binding: WorkerBinding): void {
    const file = bindPrivateHaraStateFile(this.home, [...STATE, binding.id], "binding.json");
    writePrivateStateFileSync(file, `${JSON.stringify(binding)}\n`);
    this.bindings.set(binding.id, binding);
    withPrivateStateLockSync(this.home, STATE, "index", () => {
      const index = bindPrivateHaraStateFile(this.home, STATE, "index.json");
      const snapshot = readPrivateStateFileSnapshotSync(index.path, 1024 * 1024);
      const value = snapshot ? parse(snapshot.text) : { version: 1, ids: [] };
      const existing = value.ids;
      if (value.version !== 1 || !Array.isArray(existing) || existing.some((id) => typeof id !== "string" || !OPAQUE_ID.test(id))) {
        throw new Error("the OpenCode worker index is invalid");
      }
      const ids = [...new Set([...existing, ...this.bindings.keys()])].slice(-5_000);
      writePrivateStateFileSync(index, `${JSON.stringify({ version: 1, ids })}\n`);
    });
  }

  private info(binding: WorkerBinding): ExternalSessionInfo {
    return {
      id: binding.id, sourceId: "opencode", title: safeText(binding.title, 120),
      workspaceName: safeText(basename(binding.cwd), 120) || "Workspace",
      workspaceId: `ws_${createHmac("sha256", this.options.identityKey).update(`hara.external.opencode.workspace\0${binding.cwd}`).digest("hex").slice(0, 24)}`,
      state: this.running.has(binding.id) ? "working" : "idle",
      createdAt: binding.createdAt, updatedAt: binding.updatedAt, origin: "subAgent", ephemeral: false,
    };
  }

  private binding(sessionId: string): WorkerBinding {
    const binding = this.bindings.get(sessionId) ?? this.load(sessionId);
    if (!binding || (this.options.ownership && !this.options.ownership.has(sessionId))) {
      throw new Error("the OpenCode coding session is not owned by Hara");
    }
    let available = false;
    try { available = realpathSync(binding.cwd) === binding.cwd && statSync(binding.cwd).isDirectory(); } catch { /* Do not disclose native paths. */ }
    if (!available) {
      throw new Error("the OpenCode coding worktree is no longer available");
    }
    return binding;
  }

  private command(binding: WorkerBinding, bridge?: OpenCodeWorkerTurnBridge): ExternalCommandOptions {
    const dirs = [...STATE, binding.id];
    const root = ensurePrivateStateSubdirectory(this.home, [".hara", ...dirs]).path;
    const paths = Object.fromEntries(["home", "config", "data", "cache", "state", "tmp", "managed"].map((name) => [name,
      ensurePrivateStateSubdirectory(this.home, [".hara", ...dirs, name]).path]));
    const configDir = ensurePrivateStateSubdirectory(this.home, [".hara", ...dirs, "config", "opencode"]).path;
    const pluginDirs = [...dirs, "config", "opencode"];
    const dependencies = { "@opencode-ai/plugin": "1.18.32" };
    // Config loading checks this dependency even in pure mode; satisfy it without a registry install.
    for (const [subdirs, name, value] of [
      [pluginDirs, "package.json", { private: true, dependencies }],
      [pluginDirs, "package-lock.json", { lockfileVersion: 3, packages: { "": { dependencies }, "node_modules/@opencode-ai/plugin": { version: "1.18.32" } } }],
      [[...pluginDirs, "node_modules", "@opencode-ai", "plugin"], "package.json", { name: "@opencode-ai/plugin", version: "1.18.32" }],
    ] as const) writePrivateStateFileSync(bindPrivateHaraStateFile(this.home, subdirs, name), JSON.stringify(value));
    const models = bindPrivateHaraStateFile(this.home, dirs, "models.json");
    writePrivateStateFileSync(models, "{}\n");
    const npmrc = bindPrivateHaraStateFile(this.home, dirs, "npmrc");
    writePrivateStateFileSync(npmrc, "\n");
    const toolNames = bridge?.toolNames.map((name) => `${MCP_NAME}_${name}`) ?? [];
    const permission = { "*": "deny", ...Object.fromEntries(toolNames.map((name) => [name, "allow"])) };
    const config = {
      autoupdate: false, share: "disabled", snapshot: false, plugin: [], skills: { paths: [], urls: [] }, instructions: [],
      enabled_providers: bridge ? Object.keys(bridge.provider) : [], provider: bridge?.provider ?? {},
      ...(bridge ? { model: bridge.model, small_model: bridge.model } : {}),
      default_agent: WORKER_AGENT, permission,
      tools: Object.fromEntries(NATIVE_TOOLS.map((name) => [name, false])),
      agent: {
        [WORKER_AGENT]: { mode: "primary", permission, steps: bridge?.budget.maxProviderRounds ?? 1,
          prompt: bridge?.systemPrompt ?? "Complete the assigned coding task using the available Hara tools in the owned worktree. Report verified results concisely." },
        build: { disable: true }, plan: { disable: true }, general: { disable: true }, explore: { disable: true },
        title: { disable: true }, summary: { disable: true },
      },
      mcp: bridge ? { [MCP_NAME]: { ...bridge.mcp, enabled: true, timeout: 30_000 } } : {},
      formatter: false, lsp: false, compaction: { auto: false, prune: false }, experimental: { batch_tool: false, openTelemetry: false },
    };
    const inherited = toolSubprocessEnv(this.options.env ?? process.env);
    // Never inherit the caller's OpenCode flags, provider/profile overrides, or plugin configuration.
    for (const name of Object.keys(inherited)) if (/^(?:OPENCODE_|XDG_|OTEL_|HARA_SUBPROCESS_ENV_ALLOW$)/iu.test(name)) delete inherited[name];
    return { ...this.options, env: {
      ...inherited, HOME: paths.home, USERPROFILE: paths.home,
      XDG_CONFIG_HOME: paths.config, XDG_DATA_HOME: paths.data, XDG_CACHE_HOME: paths.cache, XDG_STATE_HOME: paths.state,
      TMPDIR: paths.tmp, TMP: paths.tmp, TEMP: paths.tmp,
      OPENCODE_TEST_HOME: paths.home, OPENCODE_TEST_MANAGED_CONFIG_DIR: paths.managed,
      OPENCODE_CONFIG_DIR: configDir, OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_DB: join(root, "opencode.db"),
      OPENCODE_PERMISSION: JSON.stringify(permission),
      OPENCODE_PURE: "1", OPENCODE_DISABLE_DEFAULT_PLUGINS: "1", OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1",
      OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: "1", OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_MODELS_PATH: models.path,
      OPENCODE_DISABLE_LSP_DOWNLOAD: "1", OPENCODE_DISABLE_FFF: "1", OPENCODE_DISABLE_AUTOCOMPACT: "1", OPENCODE_DISABLE_PRUNE: "1",
      OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "1",
      OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX: String(Math.min(8192, bridge?.budget.maxTokens ?? 8192)),
      npm_config_offline: "true", npm_config_registry: "http://127.0.0.1:1", npm_config_userconfig: npmrc.path,
      npm_config_globalconfig: npmrc.path, NO_COLOR: "1",
    } };
  }

  async inspect(): Promise<ExternalSessionSourceInfo> {
    if (this.options.history) return await this.options.history.inspect();
    const probe = await probeExternalCommand(this.options);
    const ready = probe.installed && !probe.failed;
    return { id: "opencode", label: "OpenCode", state: !probe.installed ? "not_installed" : ready ? "ready" : "error",
      ...(probe.version ? { version: probe.version } : {}), capabilities: {
        listMetadata: ready, read: ready, create: false, fork: false, resume: ready, observeLive: false,
        submit: ready && Boolean(this.options.prepareTurn), steer: false, interrupt: ready,
      } };
  }

  async list(input: { cursor?: string; limit: number; search?: string }): Promise<ExternalSessionAdapterPage> {
    if (input.cursor && !input.cursor.startsWith("worker:")) {
      if (!this.options.history) throw new Error("the OpenCode worker cursor is invalid");
      return await this.options.history.list(input);
    }
    const offset = input.cursor ? Number(input.cursor.slice(7)) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("the OpenCode worker cursor is invalid");
    const query = input.search?.toLocaleLowerCase() ?? "";
    const own = [...this.bindings.values()].map((binding) => this.info(binding)).filter((info) => !query
      || `${info.title}\n${info.workspaceName}`.toLocaleLowerCase().includes(query));
    const sessions = own.slice(offset, offset + input.limit);
    if (offset + sessions.length < own.length) return { sessions, nextCursor: `worker:${offset + sessions.length}` };
    if (!this.options.history) return { sessions };
    if (sessions.length === input.limit) return { sessions, nextCursor: `worker:${offset + sessions.length}` };
    const history = await this.options.history.list({ limit: input.limit - sessions.length, search: input.search });
    return { sessions: [...sessions, ...history.sessions.filter((info) => !this.bindings.has(info.id))],
      ...(history.nextCursor ? { nextCursor: history.nextCursor } : {}) };
  }

  async createCodingSession(input: ExternalCodingSessionInput): Promise<ExternalSessionReadResult> {
    if (String(input.agentKind) !== "opencode") throw new Error("the coding worker provider does not match OpenCode");
    if (!isAbsolute(input.cwd) || realpathSync(input.cwd) !== input.cwd || !statSync(input.cwd).isDirectory()) {
      throw new Error("OpenCode requires the canonical owned coding worktree");
    }
    const nativeId = `ses_${randomUUID().replaceAll("-", "")}`;
    const id = opaqueProviderSessionId("opencode", nativeId, this.options.identityKey);
    const now = new Date().toISOString();
    const binding: WorkerBinding = { version: 1, id, nativeId, cwd: input.cwd, title: safeText(input.title, 120) || "Hara coding task", createdAt: now, updatedAt: now };
    const seed = bindPrivateHaraStateFile(this.home, [...STATE, id], "seed.json");
    writePrivateStateFileSync(seed, JSON.stringify({ info: { id: nativeId, slug: `hara-${id.slice(-12)}`, title: binding.title,
      version: "1.18.32", time: { created: Date.now(), updated: Date.now() }, permission: [] }, messages: [] }));
    const result = await runExternalCommandCapture(this.command(binding), ["--pure", "import", seed.path], { cwd: binding.cwd });
    if (!result.ok) throw new Error("OpenCode could not reserve the coding conversation");
    await this.exported(binding);
    this.options.ownership?.add("opencode", id);
    this.save(binding);
    return { session: this.info(binding), messages: [], readOnly: false, controlMode: "managed" };
  }

  async resumeCodingSession(input: ExternalCodingSessionResumeInput): Promise<ExternalSessionReadResult> {
    const binding = this.binding(input.providerSessionId);
    if (String(input.agentKind) !== "opencode" || binding.cwd !== input.cwd) throw new Error("the saved OpenCode coding session is not owned by Hara in this worktree");
    if (this.running.has(binding.id)) throw new Error("this OpenCode worker already has a Hara-controlled turn");
    await this.exported(binding);
    return { session: this.info(binding), messages: [], readOnly: false, controlMode: "managed" };
  }

  private async exported(binding: WorkerBinding): Promise<Record<string, unknown>> {
    const result = await runExternalCommandCapture(this.command(binding), ["--pure", "export", binding.nativeId], { cwd: binding.cwd });
    if (!result.ok) throw new Error("the original OpenCode coding conversation is unavailable");
    const exported = parse(result.stdout);
    const info = record(exported.info);
    if (info?.id !== binding.nativeId || info.directory !== binding.cwd
      || (Array.isArray(info.permission) && info.permission.some((value) => record(value)?.action === "allow"))
      || (info.permission !== undefined && !Array.isArray(info.permission))) {
      throw new Error("OpenCode returned a different or unsafe owned coding conversation");
    }
    return exported;
  }

  async read(sessionId: string): Promise<ExternalSessionReadResult> {
    if (!this.bindings.has(sessionId) && !this.load(sessionId)) {
      if (!this.options.history?.read) throw new Error("the OpenCode session is unavailable");
      return await this.options.history.read(sessionId);
    }
    const binding = this.binding(sessionId);
    const exported = await this.exported(binding);
    const messages: ExternalSessionMessage[] = Array.isArray(exported.messages) ? exported.messages.flatMap((value, index): ExternalSessionMessage[] => {
      const message = record(value); const info = record(message?.info);
      if (info?.role !== "user" && info?.role !== "assistant") return [];
      const text = Array.isArray(message?.parts) ? message.parts.map((part) => record(part)).filter((part) => part?.type === "text")
        .map((part) => safeText(part?.text)).join("\n") : "";
      return text ? [{ id: `msg_${createHmac("sha256", this.options.identityKey).update(`${sessionId}\0${index}`).digest("hex").slice(0, 24)}`,
        role: info.role, text: safeText(text) }] : [];
    }).slice(-1_000) : [];
    return { session: this.info(binding), messages, readOnly: false, controlMode: "managed" };
  }

  async resume(sessionId: string): Promise<ExternalSessionReadResult> {
    if (this.bindings.has(sessionId) || this.load(sessionId)) return await this.read(sessionId);
    if (!this.options.history?.resume) throw new Error("the OpenCode session is unavailable");
    return await this.options.history.resume(sessionId);
  }

  async submit(sessionId: string, text: string, sink: ExternalTurnSink): Promise<OpenCodeWorkerTurnResult> {
    if (!this.bindings.has(sessionId) && !this.load(sessionId)) {
      if (!this.options.history?.submit) throw new Error("the OpenCode session is unavailable");
      return await this.options.history.submit(sessionId, text, sink);
    }
    const binding = this.binding(sessionId);
    if (this.running.has(sessionId)) throw new Error("this OpenCode worker already has a Hara-controlled turn");
    if (!this.options.prepareTurn) throw new Error("the guarded Hara tool and model bridge is unavailable for this OpenCode worker");
    const turnId = `turn_${randomUUID()}`;
    const abort = new AbortController();
    this.running.set(sessionId, abort);
    const cancel = (): void => abort.abort();
    sink.signal?.addEventListener("abort", cancel, { once: true });
    if (sink.signal?.aborted) cancel();
    let bridge: OpenCodeWorkerTurnBridge | undefined;
    let buffer = "";
    const replies = new Map<string, string>();
    const starts = new Set<string>(); const finishes = new Set<string>(); const tools = new Set<string>();
    // Native SDK counters are diagnostic only when the real Hara host owns execution accounting.
    const sdkMetrics: OpenCodeWorkerMetrics = { providerRounds: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0 };
    const metrics: OpenCodeWorkerMetrics = { ...sdkMetrics };
    let failed = false;
    let exhausted = false;
    try {
      if (abort.signal.aborted) return { sessionId, turnId, status: "interrupted", reply: "" };
      await this.exported(binding);
      if (abort.signal.aborted) return { sessionId, turnId, status: "interrupted", reply: "" };
      const hostSignal = sink.signal ? AbortSignal.any([sink.signal, abort.signal]) : abort.signal;
      bridge = await this.options.prepareTurn({ sessionId, cwd: binding.cwd }, { ...sink, signal: hostSignal });
      this.validateBridge(bridge);
      if (abort.signal.aborted) return { sessionId, turnId, status: "interrupted", reply: "" };
      const hostOwnsMetrics = "metrics" in bridge;
      const executionMetrics = (): OpenCodeWorkerMetrics => {
        // Presence with invalid/missing values must not silently downgrade to SDK authority.
        const current = hostOwnsMetrics ? bridge!.metrics : sdkMetrics;
        if (!current || typeof current !== "object" || Array.isArray(current)) {
          throw new Error("the Hara coding host returned invalid execution counters");
        }
        const snapshot = { providerRounds: current.providerRounds, toolCalls: current.toolCalls,
          inputTokens: current.inputTokens, outputTokens: current.outputTokens };
        if (Object.values(snapshot).some((value) => !Number.isSafeInteger(value) || value < 0)) {
          throw new Error("the Hara coding host returned invalid execution counters");
        }
        return snapshot;
      };
      const progress = (): void => {
        Object.assign(metrics, executionMetrics());
        if (metrics.providerRounds > bridge!.budget.maxProviderRounds || metrics.toolCalls > bridge!.budget.maxToolCalls
          || metrics.inputTokens + metrics.outputTokens > bridge!.budget.maxTokens || !bridge!.progress({ ...metrics })) {
          exhausted = true; abort.abort();
        }
      };
      progress();
      if (exhausted) return { sessionId, turnId, status: "failed", reply: "", metrics,
        error: "the shared Hara coding execution budget was reached" };
      const consume = (line: string): void => {
        if (!line.trim() || abort.signal.aborted) return;
        if (Buffer.byteLength(line) > FRAME_LIMIT) throw new Error("OpenCode emitted an overlong worker event");
        const event = parse(line);
        if (event.sessionID !== binding.nativeId) throw new Error("OpenCode emitted a foreign worker event");
        const part = record(event.part); const id = typeof part?.id === "string" ? part.id : "";
        if (event.type === "error") { failed = true; return; }
        if (!id) return;
        if (event.type === "step_start" && !starts.has(id)) { starts.add(id); sdkMetrics.providerRounds += 1; progress(); }
        if (event.type === "step_finish" && !finishes.has(id)) {
          finishes.add(id); const tokens = record(part?.tokens); const cache = record(tokens?.cache);
          const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
          sdkMetrics.inputTokens += count(tokens?.input) + count(cache?.read) + count(cache?.write);
          sdkMetrics.outputTokens += count(tokens?.output) + count(tokens?.reasoning); progress();
        }
        if (event.type === "text") {
          const next = safeText(part?.text); const prior = replies.get(id) ?? "";
          replies.set(id, next); if (next.startsWith(prior)) sink.text(next.slice(prior.length));
        }
        if (event.type === "tool_use" && !tools.has(id)) {
          const name = typeof part?.tool === "string" ? part.tool : "";
          if (!bridge!.toolNames.some((tool) => `${MCP_NAME}_${tool}` === name)) throw new Error("OpenCode attempted a tool outside the Hara worker bridge");
          tools.add(id); sdkMetrics.toolCalls += 1; progress();
          const state = record(part?.state); sink.tool(name, safeText(state?.title, 180) || safeText(state?.status, 32));
        }
      };
      const result = await runExternalCommandCapture(this.command(binding, bridge), ["--pure", "run", "--dir", binding.cwd,
        "--format", "json", "--session", binding.nativeId, "--agent", WORKER_AGENT, "--model", bridge.model, "--", text], {
        cwd: binding.cwd, timeoutMs: bridge.budget.timeoutMs, signal: abort.signal, maxOutputBytes: 16 * 1024 * 1024,
        onStdout: (chunk) => {
          buffer += chunk;
          if (Buffer.byteLength(buffer) > FRAME_LIMIT * 2) throw new Error("OpenCode worker event buffer exceeded its limit");
          for (;;) {
            const newline = buffer.indexOf("\n"); if (newline < 0) break;
            const line = buffer.slice(0, newline).replace(/\r$/u, ""); buffer = buffer.slice(newline + 1); consume(line);
          }
        },
      });
      if (buffer.trim()) consume(buffer);
      // The host may finish usage accounting after the last SDK event; never return a stale SDK sum.
      if (abort.signal.aborted) Object.assign(metrics, executionMetrics());
      else progress();
      const reply = safeText([...replies.values()].join("\n\n"));
      binding.updatedAt = new Date().toISOString(); this.save(binding);
      if (exhausted) return { sessionId, turnId, status: "failed", reply, metrics, error: "the shared Hara coding execution budget was reached" };
      if (abort.signal.aborted || result.errorCode === "interrupted") return { sessionId, turnId, status: "interrupted", reply, metrics };
      if (!result.ok || failed || finishes.size === 0) return { sessionId, turnId, status: "failed", reply, metrics, error: "OpenCode could not complete this guarded coding turn" };
      return { sessionId, turnId, status: "completed", reply, metrics };
    } finally {
      // Direct service.interrupt(), deadline, and ordinary completion all revoke
      // the host bridge as well as the external process; no late tool may start.
      abort.abort();
      sink.signal?.removeEventListener("abort", cancel);
      this.running.delete(sessionId);
      await bridge?.close?.();
    }
  }

  private validateBridge(bridge: OpenCodeWorkerTurnBridge): void {
    if (!bridge || !/^[A-Za-z0-9_.-]+\/[^\s/]+$/u.test(bridge.model) || typeof bridge.progress !== "function"
      || !Array.isArray(bridge.toolNames) || bridge.toolNames.length === 0 || bridge.toolNames.length > 128
      || bridge.toolNames.some((name) => !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/u.test(name))
      || Object.keys(bridge.provider).length !== 1 || !Object.hasOwn(bridge.provider, bridge.model.split("/")[0])) {
      throw new Error("the host OpenCode tool/model bridge is invalid");
    }
    for (const value of Object.values(bridge.budget)) if (!Number.isSafeInteger(value) || value < 1) throw new Error("the OpenCode execution budget is invalid");
    if (bridge.mcp.type === "local") {
      if (!Array.isArray(bridge.mcp.command) || !isAbsolute(bridge.mcp.command[0] ?? "")
        || bridge.mcp.command.some((value) => typeof value !== "string")) throw new Error("the host MCP command is invalid");
      return;
    }
    const endpoint = new URL(bridge.mcp.url);
    if (endpoint.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(endpoint.hostname)
      || endpoint.username || endpoint.password || endpoint.hash) throw new Error("the Hara worker MCP endpoint must be loopback HTTP");
  }

  async interrupt(sessionId: string): Promise<void> {
    if (this.bindings.has(sessionId)) this.running.get(sessionId)?.abort();
    else await this.options.history?.interrupt?.(sessionId);
  }

  async resumeInTerminal(sessionId: string): Promise<ExternalProviderTerminalResult> {
    if (this.bindings.has(sessionId) || this.load(sessionId)) {
      throw new Error("owned OpenCode coding workers must continue through their guarded Hara task");
    }
    if (!this.options.history?.resumeInTerminal) throw new Error("this OpenCode session does not support terminal recovery");
    return await this.options.history.resumeInTerminal(sessionId);
  }

  async close(): Promise<void> {
    for (const abort of this.running.values()) abort.abort();
    await this.options.history?.close?.();
  }
}
