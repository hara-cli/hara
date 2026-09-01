import { createHmac, randomUUID } from "node:crypto";
import { basename } from "node:path";
import { redactSensitiveText } from "../security/secrets.js";
import type { ExternalSessionOwnershipStore } from "./identity.js";
import {
  ExternalJsonlRpcRequestError,
  JsonlRpcClient,
  probeExternalCommand,
  runExternalCommandStatus,
  runJsonlRpcSequence,
  type ExternalCommandOptions,
  type JsonlRpcRequest,
} from "./process.js";
import type {
  ExternalSessionAdapter,
  ExternalSessionAdapterPage,
  ExternalSessionForkResult,
  ExternalSessionInfo,
  ExternalSessionMessage,
  ExternalSessionReadResult,
  ExternalSessionSourceInfo,
  ExternalSteerResult,
  ExternalTurnResult,
  ExternalTurnSink,
} from "./types.js";

interface CodexThreadStatus {
  type?: unknown;
  activeFlags?: unknown;
}

interface CodexThread {
  id?: unknown;
  name?: unknown;
  cwd?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  status?: unknown;
  source?: unknown;
  ephemeral?: unknown;
}

interface CodexThreadListResponse {
  data?: unknown;
  nextCursor?: unknown;
}

interface CodexThreadResponse {
  thread?: unknown;
}

interface CodexTurnsListResponse {
  data?: unknown;
  nextCursor?: unknown;
}

interface CodexTurnStartResponse {
  turn?: unknown;
}

interface CodexNativeRef {
  nativeId: string;
  cwd: string;
  owned: boolean;
  /** True only when the thread is loaded in the official daemon Hara is connected to. */
  live: boolean;
  info: ExternalSessionInfo;
}

interface CodexRuntime {
  client: JsonlRpcClient;
  abort: AbortController;
  nativeThreadId: string;
  nativeTurnId?: string;
  haraSessionId: string;
  haraTurnId: string;
  state: "working" | "waiting";
  nativeTurnReady: Promise<string>;
  resolveNativeTurn(turnId: string): void;
}

const MAX_MESSAGE_TEXT = 128 * 1024;
const MAX_TRANSCRIPT_MESSAGES = 1_000;
const RECENT_TRANSCRIPT_TURNS = 50;

const digest = (kind: "session" | "workspace", value: string, identityKey: Buffer): string => createHmac("sha256", identityKey)
  .update(`hara.external.codex.${kind}\0${value}`, "utf8")
  .digest("hex")
  .slice(0, 24);

const isoFromSeconds = (value: unknown): string => {
  const seconds = typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
  const milliseconds = Math.min(seconds * 1_000, 8_640_000_000_000_000);
  const date = new Date(milliseconds);
  return Number.isNaN(date.valueOf()) ? new Date(0).toISOString() : date.toISOString();
};

const stateFromStatus = (value: unknown): ExternalSessionInfo["state"] => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "unknown";
  const status = value as CodexThreadStatus;
  if (status.type === "notLoaded") return "stored";
  if (status.type === "idle") return "idle";
  if (status.type === "systemError") return "error";
  if (status.type !== "active") return "unknown";
  const flags = Array.isArray(status.activeFlags) ? status.activeFlags : [];
  return flags.includes("waitingOnApproval") || flags.includes("waitingOnUserInput") ? "waiting" : "working";
};

const originFromSource = (value: unknown): ExternalSessionInfo["origin"] => {
  if (value === "cli" || value === "vscode" || value === "exec" || value === "appServer" || value === "unknown") {
    return value;
  }
  if (value && typeof value === "object" && !Array.isArray(value) && "subAgent" in value) return "subAgent";
  return "unknown";
};

const safeTitle = (value: unknown, opaqueId: string): string => {
  if (typeof value === "string") {
    const title = value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 120);
    if (title) return title;
  }
  return `Codex session · ${opaqueId.slice(-6).toUpperCase()}`;
};

const externalThread = (value: unknown, identityKey: Buffer): CodexNativeRef | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const thread = value as CodexThread;
  if (typeof thread.id !== "string" || !thread.id || typeof thread.cwd !== "string" || !thread.cwd) return null;
  const id = `ext_codex_${digest("session", thread.id, identityKey)}`;
  const workspaceName = basename(thread.cwd) || "Workspace";
  const info: ExternalSessionInfo = {
    id,
    sourceId: "codex",
    title: safeTitle(thread.name, id),
    workspaceName: workspaceName.slice(0, 120),
    workspaceId: `ws_${digest("workspace", thread.cwd, identityKey)}`,
    state: stateFromStatus(thread.status),
    createdAt: isoFromSeconds(thread.createdAt),
    updatedAt: isoFromSeconds(thread.updatedAt),
    origin: originFromSource(thread.source),
    ephemeral: thread.ephemeral === true,
  };
  return { nativeId: thread.id, cwd: thread.cwd, owned: false, live: false, info };
};

const safeText = (value: unknown, max = MAX_MESSAGE_TEXT): string => redactSensitiveText(
  typeof value === "string" ? value : "",
).text
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
  .trim()
  .slice(0, max);

/** Preserve provider delta boundaries, including meaningful leading/trailing whitespace. */
const safeDelta = (value: unknown, max = MAX_MESSAGE_TEXT): string => redactSensitiveText(
  typeof value === "string" ? value : "",
).text
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
  .slice(0, max);

const messageId = (nativeThreadId: string, nativeItemId: string, identityKey: Buffer): string => (
  `msg_${digest("session", `${nativeThreadId}\0message\0${nativeItemId}`, identityKey)}`
);

const userInputText = (content: unknown): string => {
  if (!Array.isArray(content)) return "";
  const chunks: string[] = [];
  for (const input of content) {
    if (!input || typeof input !== "object" || Array.isArray(input)) continue;
    const record = input as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") chunks.push(record.text);
    else if (record.type === "image" || record.type === "localImage") chunks.push("[image]");
    else if (record.type === "skill" && typeof record.name === "string") chunks.push(`/${record.name}`);
    else if (record.type === "mention" && typeof record.name === "string") chunks.push(`@${record.name}`);
  }
  return safeText(chunks.join("\n"));
};

const transcriptMessages = (threadValue: unknown, identityKey: Buffer): ExternalSessionMessage[] => {
  if (!threadValue || typeof threadValue !== "object" || Array.isArray(threadValue)) return [];
  const thread = threadValue as Record<string, unknown>;
  if (typeof thread.id !== "string" || !Array.isArray(thread.turns)) return [];
  const messages: ExternalSessionMessage[] = [];
  for (const turn of thread.turns) {
    if (!turn || typeof turn !== "object" || Array.isArray(turn)) continue;
    const items = (turn as Record<string, unknown>).items;
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const record = item as Record<string, unknown>;
      if (typeof record.id !== "string") continue;
      if (record.type === "userMessage") {
        const text = userInputText(record.content);
        if (text) messages.push({ id: messageId(thread.id, record.id, identityKey), role: "user", text });
      } else if (record.type === "agentMessage") {
        const text = safeText(record.text);
        if (text) messages.push({ id: messageId(thread.id, record.id, identityKey), role: "assistant", text });
      } else if (record.type === "contextCompaction") {
        messages.push({
          id: messageId(thread.id, record.id, identityKey),
          role: "notice",
          text: "Earlier context was compacted by Codex.",
        });
      }
      if (messages.length >= MAX_TRANSCRIPT_MESSAGES) return messages;
    }
  }
  return messages;
};

export interface CodexAppServerAdapterOptions extends ExternalCommandOptions {
  haraVersion: string;
  /** Per-Serve secret: prevents a renderer from testing guessed native IDs or local paths against digests. */
  identityKey: Buffer;
  ownership?: ExternalSessionOwnershipStore;
  /** Prefer the official shared App Server daemon. Disabled automatically for hermetic fixture prefixes. */
  managedDaemon?: boolean;
}

export class CodexAppServerAdapter implements ExternalSessionAdapter {
  readonly id = "codex" as const;
  private readonly refs = new Map<string, CodexNativeRef>();
  private readonly running = new Map<string, CodexRuntime>();
  private daemonTransport?: Promise<boolean>;

  constructor(private readonly options: CodexAppServerAdapterOptions) {}

  private usesManagedDaemon(): Promise<boolean> {
    const eligible = this.options.managedDaemon ?? !(this.options.argsPrefix?.length);
    if (!eligible) return Promise.resolve(false);
    this.daemonTransport ??= runExternalCommandStatus(this.options, ["app-server", "daemon", "start"]);
    return this.daemonTransport;
  }

  private async appServerArgs(): Promise<readonly string[]> {
    return await this.usesManagedDaemon()
      ? ["app-server", "proxy"]
      : ["app-server", "--stdio"];
  }

  async inspect(): Promise<ExternalSessionSourceInfo> {
    const probe = await probeExternalCommand(this.options);
    const ready = probe.installed && !probe.failed;
    const observeLive = ready && await this.usesManagedDaemon();
    return {
      id: this.id,
      label: "Codex",
      state: !probe.installed ? "not_installed" : probe.failed ? "error" : "ready",
      ...(probe.version ? { version: probe.version } : {}),
      ...(!probe.installed
        ? { reason: "command_not_found" as const }
        : probe.failed ? { reason: "probe_failed" as const } : {}),
      capabilities: {
        listMetadata: ready,
        read: ready,
        create: false,
        fork: ready,
        resume: ready,
        observeLive,
        submit: ready,
        // A Hara-started turn can always accept follow-ups through the same App Server client. The
        // shared daemon additionally permits steering a provider turn that was already active.
        steer: ready,
        interrupt: ready,
      },
    };
  }

  async list(input: { cursor?: string; limit: number; search?: string }): Promise<ExternalSessionAdapterPage> {
    const daemon = await this.usesManagedDaemon();
    const result = await runJsonlRpcSequence<CodexThreadListResponse>({
      ...this.options,
      appServerArgs: await this.appServerArgs(),
      requests: [
        {
          id: 1,
          method: "initialize",
          params: {
            clientInfo: { name: "hara", title: "Hara", version: this.options.haraVersion },
            capabilities: {
              experimentalApi: false,
              requestAttestation: false,
              optOutNotificationMethods: [],
            },
          },
        },
        { method: "initialized" },
        {
          id: 2,
          method: "thread/list",
          params: {
            limit: input.limit,
            sortKey: "updated_at",
            sortDirection: "desc",
            ...(input.cursor ? { cursor: input.cursor } : {}),
            ...(input.search ? { searchTerm: input.search } : {}),
          },
        },
      ],
      resultId: 2,
    });
    const rows = Array.isArray(result?.data) ? result.data : [];
    const sessions = rows.slice(0, input.limit).flatMap((row) => {
      const mapped = externalThread(row, this.options.identityKey);
      if (!mapped) return [];
      const prior = this.refs.get(mapped.info.id);
      if (prior?.owned || this.options.ownership?.has(mapped.info.id)) mapped.owned = true;
      mapped.live = daemon && ["idle", "working", "waiting"].includes(mapped.info.state);
      const runtime = this.running.get(mapped.info.id);
      if (runtime) {
        mapped.live = true;
        mapped.info = { ...mapped.info, state: runtime.state };
      }
      this.refs.set(mapped.info.id, mapped);
      return [mapped.info];
    });
    return {
      sessions,
      ...(typeof result?.nextCursor === "string" && result.nextCursor
        ? { nextCursor: result.nextCursor }
        : {}),
    };
  }

  private ref(sessionId: string): CodexNativeRef {
    const ref = this.refs.get(sessionId);
    if (!ref) throw new Error("external Codex session is no longer in the current device index; refresh the list");
    return ref;
  }

  private initializeRequests(
    next: { id: number; method: string; params: Record<string, unknown> },
    options: { experimentalApi?: boolean } = {},
  ): Array<{
    id?: number;
    method: string;
    params?: Record<string, unknown>;
  }> {
    return [
      {
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "hara", title: "Hara", version: this.options.haraVersion },
          capabilities: {
            experimentalApi: options.experimentalApi === true,
            requestAttestation: false,
            optOutNotificationMethods: [],
          },
        },
      },
      { method: "initialized" },
      next,
    ];
  }

  /**
   * Read only the newest bounded turn window. `summary` retains user/assistant text while excluding
   * potentially unbounded command output and other heavy tool payloads. Provider cursors remain in Core;
   * the renderer receives a neutral notice when older history exists.
   */
  private async recentMessages(ref: CodexNativeRef): Promise<ExternalSessionMessage[]> {
    let result: CodexTurnsListResponse;
    try {
      result = await runJsonlRpcSequence<CodexTurnsListResponse>({
        ...this.options,
        appServerArgs: await this.appServerArgs(),
        timeoutMs: this.options.timeoutMs ?? 30_000,
        requests: this.initializeRequests({
          id: 2,
          method: "thread/turns/list",
          params: {
            threadId: ref.nativeId,
            limit: RECENT_TRANSCRIPT_TURNS,
            sortDirection: "desc",
            itemsView: "summary",
          },
        }, { experimentalApi: true }),
        resultId: 2,
        maxOutputBytes: 16 * 1024 * 1024,
      });
    } catch (error) {
      const unsupported = error instanceof ExternalJsonlRpcRequestError && error.code === -32601;
      const overLimit = error instanceof Error && (
        error.message === "external session adapter exceeded its output limit"
        || error.message === "external session adapter returned an overlong JSONL frame"
      );
      if (!unsupported && !overLimit) throw error;
      return [{
        id: messageId(ref.nativeId, unsupported ? "hara-transcript-update-required" : "hara-transcript-too-large", this.options.identityKey),
        role: "notice",
        text: unsupported
          ? "Update Codex to read this transcript safely in Hara. The original session remains unchanged."
          : "This Codex transcript is too large to display safely in Hara. The original session remains unchanged.",
      }];
    }
    const newestFirst = Array.isArray(result.data)
      ? result.data.slice(0, RECENT_TRANSCRIPT_TURNS)
      : [];
    const messages = transcriptMessages({
      id: ref.nativeId,
      turns: newestFirst.reverse(),
    }, this.options.identityKey);
    if (typeof result.nextCursor === "string" && result.nextCursor) {
      messages.unshift({
        id: messageId(ref.nativeId, "hara-recent-transcript-window", this.options.identityKey),
        role: "notice",
        text: `Showing the latest ${RECENT_TRANSCRIPT_TURNS} Codex turns. Earlier history remains in Codex.`,
      });
    }
    return messages;
  }

  async read(sessionId: string): Promise<ExternalSessionReadResult> {
    const ref = this.ref(sessionId);
    return {
      session: ref.info,
      messages: await this.recentMessages(ref),
      readOnly: !ref.owned && !ref.live,
      controlMode: ref.owned ? "managed" : ref.live ? "live" : "history",
    };
  }

  async fork(sessionId: string): Promise<ExternalSessionForkResult> {
    const source = this.ref(sessionId);
    const result = await runJsonlRpcSequence<CodexThreadResponse>({
      ...this.options,
      appServerArgs: await this.appServerArgs(),
      timeoutMs: this.options.timeoutMs ?? 30_000,
      requests: this.initializeRequests({
        id: 2,
        method: "thread/fork",
        params: {
          threadId: source.nativeId,
          approvalsReviewer: "user",
          excludeTurns: true,
          ephemeral: false,
        },
      }, { experimentalApi: true }),
      resultId: 2,
      maxOutputBytes: 16 * 1024 * 1024,
    });
    const mapped = externalThread(result.thread, this.options.identityKey);
    if (!mapped) throw new Error("Codex returned an invalid fork");
    mapped.owned = true;
    mapped.live = await this.usesManagedDaemon();
    this.options.ownership?.add("codex", mapped.info.id);
    this.refs.set(mapped.info.id, mapped);
    return {
      sourceSessionId: sessionId,
      session: mapped.info,
      messages: await this.recentMessages(mapped),
      readOnly: false,
      controlMode: "managed",
    };
  }

  private approvalQuestion(request: JsonlRpcRequest): { question: string; allowAlways: boolean } {
    const params = request.params ?? {};
    if (request.method === "item/commandExecution/requestApproval") {
      const command = typeof params.command === "string" ? `\n${params.command.slice(0, 800)}` : "";
      return { question: safeText(`Codex wants to run a command.${command}`, 1_200), allowAlways: true };
    }
    if (request.method === "item/fileChange/requestApproval") {
      const reason = typeof params.reason === "string" ? ` ${params.reason}` : "";
      return { question: safeText(`Codex wants to change project files.${reason}`, 1_200), allowAlways: true };
    }
    if (request.method === "item/tool/requestUserInput") {
      const questions = Array.isArray(params.questions) ? params.questions : [];
      const text = questions.flatMap((question) => {
        if (!question || typeof question !== "object" || Array.isArray(question)) return [];
        const value = (question as Record<string, unknown>).question;
        return typeof value === "string" ? [value] : [];
      }).join("\n");
      return {
        question: safeText(`Codex needs a choice. Allow Hara to use the first suggested option?\n${text}`, 1_200),
        allowAlways: false,
      };
    }
    return { question: "Codex requests additional permissions for this turn.", allowAlways: false };
  }

  private async answerServerRequest(
    request: JsonlRpcRequest,
    sink: ExternalTurnSink,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (request.method === "item/commandExecution/requestApproval") {
      const prompt = this.approvalQuestion(request);
      const verdict = await sink.confirm(prompt, signal);
      return { decision: verdict === false ? "decline" : verdict === "always" ? "acceptForSession" : "accept" };
    }
    if (request.method === "item/fileChange/requestApproval") {
      const prompt = this.approvalQuestion(request);
      const verdict = await sink.confirm(prompt, signal);
      return { decision: verdict === false ? "decline" : verdict === "always" ? "acceptForSession" : "accept" };
    }
    if (request.method === "item/tool/requestUserInput") {
      const prompt = this.approvalQuestion(request);
      const verdict = await sink.confirm(prompt, signal);
      const answers: Record<string, { answers: string[] }> = {};
      const questions = Array.isArray(request.params?.questions) ? request.params.questions : [];
      for (const question of questions) {
        if (!question || typeof question !== "object" || Array.isArray(question)) continue;
        const record = question as Record<string, unknown>;
        if (typeof record.id !== "string") continue;
        const options = Array.isArray(record.options) ? record.options : [];
        const first = options[0] && typeof options[0] === "object" && !Array.isArray(options[0])
          ? (options[0] as Record<string, unknown>).label
          : undefined;
        answers[record.id] = { answers: verdict !== false && typeof first === "string" ? [first] : [] };
      }
      return { answers };
    }
    if (request.method === "item/permissions/requestApproval") {
      sink.notice("Codex requested a granular permission profile that Hara cannot safely project; no additional permissions were granted.");
      return { permissions: {}, scope: "turn" };
    }
    throw new Error("unsupported Codex server request");
  }

  private toolEvent(params: Record<string, unknown>, sink: ExternalTurnSink): void {
    const item = params.item;
    if (!item || typeof item !== "object" || Array.isArray(item)) return;
    const record = item as Record<string, unknown>;
    if (record.type === "commandExecution") {
      sink.tool("Command", safeText(record.command, 600) || "Command completed");
    } else if (record.type === "fileChange") {
      const count = Array.isArray(record.changes) ? record.changes.length : 0;
      sink.tool("File change", count ? `${count} file change${count === 1 ? "" : "s"}` : "File change completed");
    } else if (record.type === "mcpToolCall") {
      const tool = safeText(record.tool, 120) || "tool";
      sink.tool("MCP", tool);
    }
  }

  private setState(ref: CodexNativeRef, state: ExternalSessionInfo["state"]): void {
    ref.info = { ...ref.info, state, updatedAt: new Date().toISOString() };
  }

  private async activeTurnId(client: JsonlRpcClient, nativeThreadId: string): Promise<string> {
    const result = await client.call<CodexTurnsListResponse>("thread/turns/list", {
      threadId: nativeThreadId,
      limit: 1,
      sortDirection: "desc",
      itemsView: "notLoaded",
    });
    const first = Array.isArray(result.data) ? result.data[0] : undefined;
    if (!first || typeof first !== "object" || Array.isArray(first)) return "";
    const turnId = (first as Record<string, unknown>).id;
    return typeof turnId === "string" ? turnId : "";
  }

  async submit(sessionId: string, text: string, sink: ExternalTurnSink): Promise<ExternalTurnResult> {
    let ref = this.ref(sessionId);
    if (this.running.has(sessionId)) throw new Error("this external Codex session already has a Hara-controlled turn");
    if (!ref.owned && !ref.live) {
      const forked = await this.fork(sessionId);
      ref = this.ref(forked.session.id);
      sessionId = ref.info.id;
      sink.notice("Hara forked the Codex session before continuing, so the original remains unchanged.");
    }
    const priorState = ref.info.state;
    const appServerArgs = await this.appServerArgs();
    const haraTurnId = `extturn_${randomUUID()}`;
    const abort = new AbortController();
    let complete: ((result: ExternalTurnResult) => void) | undefined;
    let replyText = "";
    let terminalSettled = false;
    const terminal = new Promise<ExternalTurnResult>((resolve) => {
      complete = resolve;
    });
    const finish = (result: ExternalTurnResult): void => {
      if (terminalSettled) return;
      terminalSettled = true;
      complete?.(result);
    };
    let resolveNativeTurn = (_turnId: string): void => {};
    const nativeTurnReady = new Promise<string>((resolve) => {
      resolveNativeTurn = resolve;
    });
    let nativeTurnResolved = false;
    const settleNativeTurn = (turnId: string): void => {
      if (nativeTurnResolved) return;
      nativeTurnResolved = true;
      resolveNativeTurn(turnId);
    };
    let runtime: CodexRuntime;
    const client = JsonlRpcClient.start({
      ...this.options,
      appServerArgs,
      maxOutputBytes: 64 * 1024 * 1024,
      onNotification: (method, params) => {
        if (method === "item/agentMessage/delta" && typeof params.delta === "string") {
          const delta = safeDelta(params.delta);
          if (delta) {
            replyText += delta;
            sink.text(delta);
          }
        } else if (method === "item/completed") {
          this.toolEvent(params, sink);
        } else if (method === "turn/completed") {
          const turn = params.turn && typeof params.turn === "object" && !Array.isArray(params.turn)
            ? params.turn as Record<string, unknown>
            : {};
          const providerStatus = turn.status;
          const status = providerStatus === "interrupted" ? "interrupted" : providerStatus === "failed" ? "failed" : "completed";
          this.setState(ref, status === "failed" ? "error" : "idle");
          finish({
            sessionId,
            turnId: haraTurnId,
            status,
            reply: replyText,
            ...(status === "failed" ? { error: "Codex turn failed" } : {}),
          });
        }
      },
      onClose: (error) => finish({
        sessionId,
        turnId: haraTurnId,
        status: abort.signal.aborted ? "interrupted" : "failed",
        reply: replyText,
        ...(!abort.signal.aborted ? { error: safeText(error.message, 2_000) || "Codex session adapter closed" } : {}),
      }),
      onServerRequest: (request, respond, reject) => {
        runtime.state = "waiting";
        this.setState(ref, "waiting");
        void this.answerServerRequest(request, sink, abort.signal)
          .then((result) => {
            runtime.state = "working";
            this.setState(ref, "working");
            respond(result);
          })
          .catch(() => reject(-32601, "request is not supported by Hara"));
      },
    });
    runtime = {
      client,
      abort,
      nativeThreadId: ref.nativeId,
      haraSessionId: sessionId,
      haraTurnId,
      state: "working",
      nativeTurnReady,
      resolveNativeTurn: settleNativeTurn,
    };
    this.running.set(sessionId, runtime);
    this.setState(ref, "working");
    try {
      await client.call("initialize", {
        clientInfo: { name: "hara", title: "Hara", version: this.options.haraVersion },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          optOutNotificationMethods: [],
        },
      });
      client.notify("initialized");
      const resumed = await client.call<CodexThreadResponse>("thread/resume", {
        threadId: ref.nativeId,
        approvalsReviewer: "user",
        excludeTurns: true,
      });
      const resumedThread = resumed.thread && typeof resumed.thread === "object" && !Array.isArray(resumed.thread)
        ? resumed.thread as Record<string, unknown>
        : {};
      const resumedState = stateFromStatus(resumedThread.status);
      const active = ref.live && (
        resumedState === "working"
        || resumedState === "waiting"
        || (resumedState === "unknown" && (priorState === "working" || priorState === "waiting"))
      );
      if (active) {
        const nativeTurnId = await this.activeTurnId(client, ref.nativeId);
        if (!nativeTurnId) throw new Error("Codex reports an active session but did not expose a steerable turn; refresh and retry");
        runtime.nativeTurnId = nativeTurnId;
        runtime.resolveNativeTurn(nativeTurnId);
        await client.call("turn/steer", {
          threadId: ref.nativeId,
          input: [{ type: "text", text, text_elements: [] }],
          expectedTurnId: nativeTurnId,
        });
        sink.notice("Hara added your message to the active Codex turn.");
      } else {
        const started = await client.call<CodexTurnStartResponse>("turn/start", {
          threadId: ref.nativeId,
          input: [{ type: "text", text, text_elements: [] }],
          approvalsReviewer: "user",
        });
        if (started.turn && typeof started.turn === "object" && !Array.isArray(started.turn)) {
          const nativeTurnId = (started.turn as Record<string, unknown>).id;
          if (typeof nativeTurnId === "string") {
            runtime.nativeTurnId = nativeTurnId;
            runtime.resolveNativeTurn(nativeTurnId);
          }
        }
      }
      return await terminal;
    } catch (error) {
      throw error;
    } finally {
      settleNativeTurn("");
      this.running.delete(sessionId);
      abort.abort();
      client.close();
    }
  }

  async steer(sessionId: string, text: string): Promise<ExternalSteerResult> {
    const runtime = this.running.get(sessionId);
    if (!runtime) throw new Error("this Codex session has no active Hara-visible turn");
    const nativeTurnId = runtime.nativeTurnId || await runtime.nativeTurnReady;
    if (!nativeTurnId) throw new Error("the active Codex turn ended before the follow-up could be delivered");
    await runtime.client.call("turn/steer", {
      threadId: runtime.nativeThreadId,
      input: [{ type: "text", text, text_elements: [] }],
      expectedTurnId: nativeTurnId,
    });
    return { sessionId, turnId: runtime.haraTurnId, accepted: true };
  }

  async interrupt(sessionId: string): Promise<void> {
    const runtime = this.running.get(sessionId);
    if (!runtime) return;
    runtime.abort.abort();
    if (runtime.nativeTurnId) {
      await runtime.client.call("turn/interrupt", {
        threadId: runtime.nativeThreadId,
        turnId: runtime.nativeTurnId,
      }).catch(() => {});
    }
    runtime.client.close();
  }

  async close(): Promise<void> {
    const runtimes = [...this.running.values()];
    this.running.clear();
    for (const runtime of runtimes) {
      runtime.abort.abort();
      runtime.client.close();
    }
  }
}
