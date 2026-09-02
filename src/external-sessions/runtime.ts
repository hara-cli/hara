import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";
import { redactSensitiveText } from "../security/secrets.js";
import {
  probeExternalCommand,
  resolveExternalCommand,
  runExternalCommandCapture,
  spawnExternalCommandDetached,
  type ExternalCommandCaptureResult,
  type ExternalCommandOptions,
} from "./process.js";
import {
  ExternalSessionInputError,
  type ExternalRuntimeAgentKind,
  type ExternalRuntimeLaunchOptions,
  type ExternalSessionAdapter,
  type ExternalSessionAdapterPage,
  type ExternalSessionInfo,
  type ExternalSessionMessage,
  type ExternalSessionReadResult,
  type ExternalSessionSourceInfo,
  type ExternalTerminalKey,
  type ExternalTerminalSnapshot,
  type ExternalTurnResult,
  type ExternalTurnSink,
} from "./types.js";

interface HerdrAgent {
  agent?: unknown;
  agent_status?: unknown;
  cwd?: unknown;
  display_agent?: unknown;
  foreground_cwd?: unknown;
  interactive_ready?: unknown;
  name?: unknown;
  pane_id?: unknown;
  revision?: unknown;
  state_change_seq?: unknown;
  terminal_id?: unknown;
  title?: unknown;
  workspace_id?: unknown;
}

interface RuntimeRef {
  target: string;
  nativeIdentity: string;
  stateChangeSeq: number | null;
  info: ExternalSessionInfo;
}

interface RunningTurn {
  turnId: string;
  interrupted: boolean;
}

interface HerdrResponse {
  result?: {
    type?: unknown;
    agents?: unknown;
    agent?: unknown;
    root_pane?: unknown;
    workspace?: unknown;
  };
}

export interface HaraRuntimeAdapterOptions extends ExternalCommandOptions {
  identityKey: Buffer;
  identityHome?: string;
  sessionName?: string;
  runtimeRoot?: string;
}

const MAX_TERMINAL_TEXT = 128 * 1024;
const DEFAULT_RUNTIME_SESSION = "hara-runtime";
// A first Herdr launch can validate terminal capabilities and agent manifests before opening its
// socket. Desktop starts it only on explicit user action, so allow one bounded cold-start window.
const SERVER_START_TIMEOUT_MS = 30_000;
const TURN_TIMEOUT_MS = 10 * 60_000;
const SAFE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+\[\]-]{0,159}$/u;
const CODEX_EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh"]);
const CLAUDE_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const CLAUDE_PERMISSION_MODES = new Set(["manual", "acceptEdits", "plan", "auto", "dontAsk"]);
const CODEX_SANDBOX_MODES = new Set(["read-only", "workspace-write"]);
const TERMINAL_KEYS = new Set<ExternalTerminalKey>([
  "enter", "esc", "up", "down", "left", "right", "tab", "shift+tab", "ctrl+c", "ctrl+d", "ctrl+l",
]);

const digest = (kind: "session" | "workspace" | "message", value: string, identityKey: Buffer): string => (
  createHmac("sha256", identityKey)
    .update(`hara.external.runtime.${kind}\0${value}`, "utf8")
    .digest("hex")
    .slice(0, 24)
);

const cleanInline = (value: unknown, limit: number): string => (
  typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, limit)
    : ""
);

const cleanPath = (value: unknown): string => (
  typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/gu, "").trim().slice(0, 4_096)
    : ""
);

const cleanCounter = (value: unknown): number | null => (
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null
);

const safeTerminalText = (value: unknown): string => redactSensitiveText(
  typeof value === "string" ? value : "",
).text
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
  .trim()
  .slice(-MAX_TERMINAL_TEXT);

const runtimeAgentKind = (value: unknown): ExternalSessionInfo["agentKind"] => {
  const normalized = cleanInline(value, 40).toLowerCase();
  if (normalized === "codex" || normalized === "claude") return normalized;
  return "other";
};

const runtimeState = (value: unknown): ExternalSessionInfo["state"] => {
  if (value === "idle" || value === "done") return "idle";
  if (value === "working") return "working";
  if (value === "blocked") return "waiting";
  return "unknown";
};

const parseJsonResponse = (result: ExternalCommandCaptureResult): HerdrResponse | null => {
  if (!result.ok || !result.stdout.trim()) return null;
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as HerdrResponse : null;
  } catch {
    return null;
  }
};

const terminalDelta = (before: string, after: string): string => {
  if (!after) return "";
  if (!before) return after;
  if (after.startsWith(before)) return after.slice(before.length).trim();
  const maxOverlap = Math.min(before.length, after.length, 32 * 1024);
  for (let length = maxOverlap; length >= 32; length -= 1) {
    if (before.endsWith(after.slice(0, length))) return after.slice(length).trim();
  }
  return after;
};

const isServerAbsent = (result: ExternalCommandCaptureResult): boolean => (
  !result.ok && result.errorCode === "server_not_running"
);

const launchArguments = (
  agentKind: ExternalRuntimeAgentKind,
  input: ExternalRuntimeLaunchOptions | undefined,
): string[] => {
  const launch = input ?? {};
  if (launch.model !== undefined && !SAFE_MODEL_ID.test(launch.model)) {
    throw new ExternalSessionInputError("runtime model id is invalid");
  }
  if (agentKind === "codex") {
    if (launch.permissionMode !== undefined) {
      throw new ExternalSessionInputError("permissionMode applies only to Claude Code");
    }
    if (launch.effort !== undefined && !CODEX_EFFORTS.has(launch.effort)) {
      throw new ExternalSessionInputError("Codex effort must be minimal, low, medium, high, or xhigh");
    }
    if (launch.sandboxMode !== undefined && !CODEX_SANDBOX_MODES.has(launch.sandboxMode)) {
      throw new ExternalSessionInputError("Codex sandbox mode is invalid");
    }
    if (launch.serviceTier !== undefined && launch.serviceTier !== "fast") {
      throw new ExternalSessionInputError("Codex service tier is invalid");
    }
    const args = [
      "-c", "check_for_update_on_startup=false",
      "--no-alt-screen",
      // Hara Live cannot safely answer an arbitrary provider terminal approval dialog remotely.
      "-a", "never",
      "-s", launch.sandboxMode ?? "workspace-write",
    ];
    if (launch.model) args.push("-m", launch.model);
    if (launch.effort) args.push("-c", `model_reasoning_effort=\"${launch.effort}\"`);
    if (launch.serviceTier === "fast") args.push("-c", "service_tier=\"fast\"");
    return args;
  }

  if (launch.sandboxMode !== undefined || launch.serviceTier !== undefined) {
    throw new ExternalSessionInputError("sandboxMode and serviceTier apply only to Codex");
  }
  if (launch.effort !== undefined && !CLAUDE_EFFORTS.has(launch.effort)) {
    throw new ExternalSessionInputError("Claude Code effort must be low, medium, high, xhigh, or max");
  }
  if (launch.permissionMode !== undefined && !CLAUDE_PERMISSION_MODES.has(launch.permissionMode)) {
    throw new ExternalSessionInputError("Claude Code permission mode is invalid");
  }
  const args = ["--permission-mode", launch.permissionMode ?? "acceptEdits"];
  if (launch.model) args.push("--model", launch.model);
  if (launch.effort) args.push("--effort", launch.effort);
  return args;
};

export class HaraRuntimeAdapter implements ExternalSessionAdapter {
  readonly id = "runtime" as const;
  private readonly command: ExternalCommandOptions;
  private readonly runtimeRoot: string;
  private readonly refs = new Map<string, RuntimeRef>();
  private readonly firstSeen = new Map<string, string>();
  private readonly running = new Map<string, RunningTurn>();
  private serverStart?: Promise<boolean>;

  constructor(private readonly options: HaraRuntimeAdapterOptions) {
    const sessionName = options.sessionName ?? DEFAULT_RUNTIME_SESSION;
    if (!/^[a-z][a-z0-9_-]{0,31}$/u.test(sessionName)) {
      throw new Error("Hara runtime session name is invalid");
    }
    const sourceEnv = options.env ?? process.env;
    const runtimeEnv = { ...sourceEnv };
    const pathKey = Object.keys(runtimeEnv).find((candidate) => candidate.toUpperCase() === "PATH") ?? "PATH";
    const currentPath = String(runtimeEnv[pathKey] ?? "");
    const providerBins = ["codex", "claude"]
      .map((command) => resolveExternalCommand(command, sourceEnv, options.identityHome ?? homedir()))
      .filter((command): command is string => Boolean(command))
      .map((command) => dirname(command));
    runtimeEnv[pathKey] = [...new Set([...providerBins, ...currentPath.split(delimiter).filter(Boolean)])].join(delimiter);
    this.command = {
      ...options,
      argsPrefix: [...(options.argsPrefix ?? []), "--session", sessionName],
      env: runtimeEnv,
    };
    this.runtimeRoot = options.runtimeRoot
      ?? join(options.identityHome ?? homedir(), ".hara", "external-sessions", "runtime");
  }

  async inspect(): Promise<ExternalSessionSourceInfo> {
    const probe = await probeExternalCommand(this.command);
    const ready = probe.installed && !probe.failed;
    return {
      id: this.id,
      label: "Hara Live",
      state: !probe.installed ? "not_installed" : probe.failed ? "error" : "ready",
      ...(probe.version ? { version: probe.version } : {}),
      ...(!probe.installed
        ? { reason: "command_not_found" as const }
        : probe.failed ? { reason: "probe_failed" as const } : {}),
      capabilities: {
        listMetadata: ready,
        read: ready,
        create: ready,
        fork: false,
        resume: false,
        observeLive: ready,
        submit: ready,
        steer: false,
        interrupt: ready,
        terminalView: ready,
        terminalInput: ready,
      },
    };
  }

  private remember(agent: HerdrAgent): RuntimeRef | null {
    const terminalId = cleanInline(agent.terminal_id, 256);
    const paneId = cleanInline(agent.pane_id, 256);
    const workspaceNativeId = cleanInline(agent.workspace_id, 256);
    if (!terminalId || !paneId || !workspaceNativeId) return null;
    const id = `ext_runtime_${digest("session", terminalId, this.options.identityKey)}`;
    const cwd = cleanPath(agent.foreground_cwd) || cleanPath(agent.cwd);
    const agentKind = runtimeAgentKind(agent.agent);
    const providerLabel = agentKind === "other" ? cleanInline(agent.display_agent ?? agent.agent, 40) : agentKind;
    const fallback = providerLabel ? `${providerLabel} relay · ${id.slice(-6).toUpperCase()}` : `Live relay · ${id.slice(-6).toUpperCase()}`;
    const title = cleanInline(agent.name ?? agent.title, 120) || fallback;
    const now = new Date().toISOString();
    const createdAt = this.firstSeen.get(id) ?? now;
    this.firstSeen.set(id, createdAt);
    const info: ExternalSessionInfo = {
      id,
      sourceId: "runtime",
      title,
      workspaceName: (basename(cwd) || "Workspace").slice(0, 120),
      workspaceId: `ws_${digest("workspace", workspaceNativeId, this.options.identityKey)}`,
      state: runtimeState(agent.agent_status),
      createdAt,
      updatedAt: now,
      origin: "haraRuntime",
      agentKind,
      ephemeral: false,
    };
    const ref = {
      target: paneId,
      nativeIdentity: terminalId,
      stateChangeSeq: cleanCounter(agent.state_change_seq),
      info,
    };
    this.refs.set(id, ref);
    return ref;
  }

  private async listNative(): Promise<RuntimeRef[]> {
    const result = await runExternalCommandCapture(this.command, ["agent", "list"], {
      timeoutMs: 5_000,
      maxOutputBytes: 2 * 1024 * 1024,
    });
    if (isServerAbsent(result)) return [];
    const response = parseJsonResponse(result);
    const agents = response?.result?.type === "agent_list" && Array.isArray(response.result.agents)
      ? response.result.agents
      : null;
    if (!agents) {
      if (!result.ok) throw new Error("Hara Live runtime is unavailable");
      throw new Error("Hara Live runtime returned an invalid agent list");
    }
    const refs: RuntimeRef[] = [];
    for (const value of agents) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const ref = this.remember(value as HerdrAgent);
      if (ref) refs.push(ref);
    }
    return refs;
  }

  async list(input: { cursor?: string; limit: number; search?: string }): Promise<ExternalSessionAdapterPage> {
    if (input.cursor) throw new ExternalSessionInputError("Hara Live does not use provider cursors");
    const search = input.search?.toLocaleLowerCase() ?? "";
    const refs = await this.listNative();
    const sessions = refs
      .map((ref) => ref.info)
      .filter((info) => !search || `${info.title}\n${info.workspaceName}\n${info.agentKind ?? ""}`.toLocaleLowerCase().includes(search))
      .slice(0, input.limit);
    return { sessions };
  }

  private async ref(sessionId: string): Promise<RuntimeRef> {
    const existing = this.refs.get(sessionId);
    // Pane ids are native runtime handles and may eventually be reused. Revalidate the terminal identity
    // before every operation so a stale opaque Hara id can never read from or send input to another pane.
    if (existing) return await this.currentAgent(existing);
    await this.listNative();
    const discovered = this.refs.get(sessionId);
    if (!discovered) throw new ExternalSessionInputError("Hara Live session is no longer available");
    return await this.currentAgent(discovered);
  }

  private async terminalText(ref: RuntimeRef): Promise<string> {
    const result = await runExternalCommandCapture(this.command, [
      "agent", "read", ref.target,
      "--source", "recent-unwrapped",
      "--lines", "240",
      "--format", "text",
    ], { timeoutMs: 8_000, maxOutputBytes: 2 * 1024 * 1024 });
    if (!result.ok) throw new Error("Hara Live could not read this session");
    return safeTerminalText(result.stdout);
  }

  private async currentAgent(ref: RuntimeRef): Promise<RuntimeRef> {
    const response = parseJsonResponse(await runExternalCommandCapture(this.command, [
      "agent", "get", ref.target,
    ], { timeoutMs: 8_000, maxOutputBytes: 512 * 1024 }));
    const agent = response?.result?.agent;
    if (!agent || typeof agent !== "object" || Array.isArray(agent)) {
      throw new Error("Hara Live could not inspect this session");
    }
    const current = this.remember(agent as HerdrAgent);
    if (!current || current.info.id !== ref.info.id) {
      throw new Error("Hara Live session identity changed");
    }
    return current;
  }

  private async waitForAgent(
    ref: RuntimeRef,
    statuses: readonly ("idle" | "working" | "blocked" | "done")[],
    timeoutMs: number,
  ): Promise<RuntimeRef | null> {
    const result = await runExternalCommandCapture(this.command, [
      "agent", "wait", ref.target,
      ...statuses.flatMap((status) => ["--until", status]),
      "--timeout", String(Math.max(250, timeoutMs)),
    ], { timeoutMs: Math.max(1_000, timeoutMs + 2_000), maxOutputBytes: 512 * 1024 });
    const agent = parseJsonResponse(result)?.result?.agent;
    if (!result.ok || !agent || typeof agent !== "object" || Array.isArray(agent)) return null;
    const current = this.remember(agent as HerdrAgent);
    return current?.info.id === ref.info.id ? current : null;
  }

  /**
   * Herdr deliberately gives an agent five seconds to expose a post-submit state transition. Some Claude
   * Code themes keep rendering a pre-work animation beyond that gate even though the prompt was already
   * accepted. `agent_prompt_stalled` is therefore not safe to retry: wait for the same terminal identity to
   * become working, then settled, and use the monotonic native state sequence to close the narrow race where
   * a fast answer finishes between those two waits.
   */
  private async recoverAcceptedStalledPrompt(
    ref: RuntimeRef,
    baselineStateChangeSeq: number | null,
    runtime: RunningTurn,
    deadline: number,
  ): Promise<boolean> {
    const progressed = (candidate: RuntimeRef): boolean => (
      baselineStateChangeSeq !== null
      && candidate.stateChangeSeq !== null
      && candidate.stateChangeSeq !== baselineStateChangeSeq
    );
    const settled = (candidate: RuntimeRef): boolean => (
      candidate.info.state === "idle" || candidate.info.state === "waiting"
    );
    let current = await this.currentAgent(ref);
    if (progressed(current) && settled(current)) return true;

    while (!runtime.interrupted && current.info.state !== "working" && Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const active = await this.waitForAgent(ref, ["working"], Math.min(30_000, remaining));
      if (active) {
        current = active;
        break;
      }
      current = await this.currentAgent(ref);
      if (progressed(current) && settled(current)) return true;
    }
    if (runtime.interrupted) return true;
    if (current.info.state !== "working") return false;

    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    const finished = await this.waitForAgent(ref, ["idle", "done", "blocked"], remaining);
    if (finished && settled(finished)) return true;
    current = await this.currentAgent(ref);
    return progressed(current) && settled(current);
  }

  async read(sessionId: string): Promise<ExternalSessionReadResult> {
    const ref = await this.ref(sessionId);
    const text = await this.terminalText(ref);
    const messages: ExternalSessionMessage[] = text ? [{
      id: `msg_${digest("message", `${ref.nativeIdentity}\0${text}`, this.options.identityKey)}`,
      role: "assistant",
      text,
    }] : [];
    return { session: ref.info, messages, readOnly: false, controlMode: "live" };
  }

  private async ensureServer(): Promise<boolean> {
    const current = await runExternalCommandCapture(this.command, ["agent", "list"], { timeoutMs: 2_000 });
    if (current.ok) return true;
    if (!isServerAbsent(current)) return false;
    this.serverStart ??= (async () => {
      try {
        mkdirSync(this.runtimeRoot, { recursive: true, mode: 0o700 });
      } catch {
        return false;
      }
      if (!await spawnExternalCommandDetached(this.command, ["server"], { cwd: this.runtimeRoot })) return false;
      const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 125));
        const probe = await runExternalCommandCapture(this.command, ["agent", "list"], { timeoutMs: 1_500 });
        if (probe.ok) return true;
        // The socket may appear before the server accepts requests. Treat bounded command/transport
        // failures as cold-start states until the deadline; only an executable failure is terminal.
        if (probe.errorCode === "command_not_found" || probe.errorCode === "spawn_failed") return false;
      }
      return false;
    })();
    const started = await this.serverStart;
    if (!started) this.serverStart = undefined;
    return started;
  }

  async create(input: {
    cwd: string;
    agentKind: ExternalRuntimeAgentKind;
    title?: string;
    launch?: ExternalRuntimeLaunchOptions;
  }): Promise<ExternalSessionReadResult> {
    if (!isAbsolute(input.cwd)) throw new ExternalSessionInputError("runtime workspace must be an absolute directory");
    let cwd: string;
    try {
      cwd = realpathSync(input.cwd);
      if (!statSync(cwd).isDirectory()) throw new Error("not a directory");
    } catch {
      throw new ExternalSessionInputError("runtime workspace is unavailable");
    }
    if (input.agentKind !== "codex" && input.agentKind !== "claude") {
      throw new ExternalSessionInputError("runtime agent kind is invalid");
    }
    if (!await this.ensureServer()) throw new Error("Hara Live runtime could not start");

    const title = cleanInline(input.title, 80) || `Hara ${input.agentKind === "codex" ? "Codex" : "Claude"}`;
    const workspace = parseJsonResponse(await runExternalCommandCapture(this.command, [
      "workspace", "create", "--cwd", cwd, "--label", title, "--no-focus",
    ], { timeoutMs: 10_000, maxOutputBytes: 512 * 1024 }));
    const rootPane = workspace?.result?.root_pane;
    const workspaceValue = workspace?.result?.workspace;
    const paneId = rootPane && typeof rootPane === "object" && !Array.isArray(rootPane)
      ? cleanInline((rootPane as Record<string, unknown>).pane_id, 256)
      : "";
    const workspaceId = workspaceValue && typeof workspaceValue === "object" && !Array.isArray(workspaceValue)
      ? cleanInline((workspaceValue as Record<string, unknown>).workspace_id, 256)
      : "";
    if (!paneId || !workspaceId) throw new Error("Hara Live could not create a workspace");

    const name = `hara-${input.agentKind}-${randomBytes(3).toString("hex")}`;
    const providerArgs = launchArguments(input.agentKind, input.launch);
    const started = await runExternalCommandCapture(this.command, [
      "agent", "start", name,
      "--kind", input.agentKind,
      "--pane", paneId,
      "--timeout", "120000",
      "--", ...providerArgs,
    ], { timeoutMs: 125_000, maxOutputBytes: 512 * 1024 });
    const response = parseJsonResponse(started);
    const agent = response?.result?.agent;
    if (!started.ok || !agent || typeof agent !== "object" || Array.isArray(agent)) {
      // This workspace was created by the current operation and has never held user work, so closing it
      // is a safe rollback. Failure to roll back is intentionally ignored; the runtime remains inspectable.
      await runExternalCommandCapture(this.command, ["workspace", "close", workspaceId], { timeoutMs: 5_000 });
      const safeReason = started.ok ? "invalid_response" : started.errorCode ?? "command_failed";
      throw new Error(`Hara Live could not start ${input.agentKind === "codex" ? "Codex" : "Claude Code"} (${safeReason})`);
    }
    const ref = this.remember(agent as HerdrAgent);
    if (!ref) throw new Error("Hara Live returned an invalid agent session");
    return await this.read(ref.info.id);
  }

  async submit(sessionId: string, text: string, sink: ExternalTurnSink): Promise<ExternalTurnResult> {
    const ref = await this.ref(sessionId);
    if (this.running.has(sessionId)) throw new ExternalSessionInputError("this Hara Live session is already working");
    const runtime: RunningTurn = { turnId: `extturn_${randomUUID()}`, interrupted: false };
    this.running.set(sessionId, runtime);
    try {
      const deadline = Date.now() + TURN_TIMEOUT_MS;
      const baseline = await this.currentAgent(ref);
      const before = await this.terminalText(ref);
      sink.notice("Message relayed to the original terminal session through Hara Live.");
      const prompted = await runExternalCommandCapture(this.command, [
        "agent", "prompt", ref.target, text,
        "--wait",
        "--until", "idle",
        "--until", "done",
        "--until", "blocked",
        "--timeout", String(TURN_TIMEOUT_MS - 5_000),
      ], { timeoutMs: TURN_TIMEOUT_MS, maxOutputBytes: 512 * 1024 });
      const response = parseJsonResponse(prompted);
      let finalRef = response?.result?.agent && typeof response.result.agent === "object" && !Array.isArray(response.result.agent)
        ? this.remember(response.result.agent as HerdrAgent)
        : null;
      const settled = prompted.ok || (
        prompted.errorCode === "agent_prompt_stalled"
        && await this.recoverAcceptedStalledPrompt(ref, baseline.stateChangeSeq, runtime, deadline)
      );
      if (settled) finalRef = await this.currentAgent(ref).catch(() => finalRef);
      const waitingForInput = finalRef?.info.state === "waiting";
      const completed = settled && !waitingForInput;
      const after = await this.terminalText(ref);
      const captured = terminalDelta(before, after);
      const reply = captured || (runtime.interrupted
        ? "The terminal session was interrupted."
        : "The terminal session accepted the message; no new terminal output was captured.");
      sink.text(reply);
      return {
        sessionId,
        turnId: runtime.turnId,
        status: runtime.interrupted ? "interrupted" : completed ? "completed" : "failed",
        reply,
        ...(!completed && !runtime.interrupted ? {
          error: prompted.timedOut
            ? "runtime turn timed out"
            : waitingForInput
              ? "runtime is waiting for interactive input"
            : prompted.errorCode === "agent_prompt_stalled"
              ? "runtime accepted the message but did not expose a settled state before the deadline"
              : "runtime turn failed",
        } : {}),
      };
    } finally {
      this.running.delete(sessionId);
    }
  }

  async interrupt(sessionId: string): Promise<void> {
    const ref = await this.ref(sessionId);
    const runtime = this.running.get(sessionId);
    if (runtime) runtime.interrupted = true;
    const result = await runExternalCommandCapture(this.command, [
      "agent", "send-keys", ref.target, "ctrl+c",
    ], { timeoutMs: 8_000, maxOutputBytes: 256 * 1024 });
    if (!result.ok && !runtime) throw new Error("Hara Live could not stop this session");
  }

  async terminalSnapshot(sessionId: string): Promise<ExternalTerminalSnapshot> {
    const ref = await this.ref(sessionId);
    const result = await runExternalCommandCapture(this.command, [
      "agent", "read", ref.target,
      "--source", "visible",
      "--format", "text",
    ], { timeoutMs: 8_000, maxOutputBytes: 2 * 1024 * 1024 });
    if (!result.ok) throw new Error("Hara Live could not mirror this terminal");
    const current = await this.currentAgent(ref);
    return {
      sessionId,
      text: safeTerminalText(result.stdout),
      state: current.info.state,
      updatedAt: new Date().toISOString(),
    };
  }

  async terminalInput(sessionId: string, text: string): Promise<void> {
    const ref = await this.ref(sessionId);
    const result = await runExternalCommandCapture(this.command, [
      "agent", "prompt", ref.target, text,
    ], { timeoutMs: 12_000, maxOutputBytes: 256 * 1024 });
    if (!result.ok) {
      throw new Error(result.errorCode === "agent_blocked"
        ? "Hara Live terminal is waiting for an explicit key choice"
        : "Hara Live could not send terminal input");
    }
  }

  async terminalKey(sessionId: string, key: ExternalTerminalKey): Promise<void> {
    if (!TERMINAL_KEYS.has(key)) throw new ExternalSessionInputError("terminal key is not allowed");
    const ref = await this.ref(sessionId);
    const result = await runExternalCommandCapture(this.command, [
      "agent", "send-keys", ref.target, key,
    ], { timeoutMs: 8_000, maxOutputBytes: 256 * 1024 });
    if (!result.ok) throw new Error("Hara Live could not send this terminal key");
  }
}
