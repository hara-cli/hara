import { createHmac, randomUUID } from "node:crypto";
import { basename } from "node:path";
import type {
  CanUseTool,
  SDKMessage,
  SDKSessionInfo,
  SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { redactSensitiveText } from "../security/secrets.js";
import { opaqueProviderSessionId, type ExternalSessionOwnershipStore } from "./identity.js";
import { normalizeExternalUserQuestions, validateExternalUserAnswers } from "./questions.js";
import {
  probeExternalCommand,
  resolveExternalCommandRuntime,
  runExternalCommandAttached,
  runExternalCommandCapture,
  type ExternalCommandOptions,
} from "./process.js";
import type {
  ExternalSessionAdapter,
  ExternalSessionAdapterCreateInput,
  ExternalCodingSessionInput,
  ExternalCodingSessionResumeInput,
  ExternalSessionAdapterPage,
  ExternalSessionForkResult,
  ExternalSessionInfo,
  ExternalSessionMessage,
  ExternalProviderTerminalResult,
  ExternalSessionReadResult,
  ExternalRuntimePreparedSession,
  ExternalSessionSourceInfo,
  ExternalTurnResult,
  ExternalTurnSink,
} from "./types.js";
import { ExternalSessionInputError } from "./types.js";

const MAX_TEXT_BYTES = 128 * 1024;
const MAX_MESSAGES = 1_000;

export type ClaudeAgentSdkFacade = Pick<
  typeof import("@anthropic-ai/claude-agent-sdk"),
  "forkSession" | "getSessionInfo" | "getSessionMessages" | "listSessions" | "query"
>;

let officialSdk: Promise<ClaudeAgentSdkFacade> | undefined;
const loadOfficialSdk = (): Promise<ClaudeAgentSdkFacade> => {
  officialSdk ??= import("@anthropic-ai/claude-agent-sdk");
  return officialSdk;
};

interface ClaudeNativeRef {
  nativeId: string;
  cwd?: string;
  owned: boolean;
  info: ExternalSessionInfo;
  codingWorkspace?: string;
  fresh?: boolean;
}

const digest = (kind: string, value: string, identityKey: Buffer): string => createHmac("sha256", identityKey)
  .update(`hara.external.claude.${kind}\0${value}`, "utf8")
  .digest("hex")
  .slice(0, 24);

const safeText = (value: unknown, max = MAX_TEXT_BYTES): string => {
  const text = typeof value === "string" ? value : "";
  return redactSensitiveText(text)
    .text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
    .trim()
    .slice(0, max);
};

const safeTimestamp = (value: unknown): string => {
  const timestamp = typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const date = new Date(timestamp);
  return Number.isNaN(date.valueOf()) ? new Date(0).toISOString() : date.toISOString();
};

const extractMessageText = (payload: unknown): string => {
  if (typeof payload === "string") return safeText(payload);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "";
  const content = (payload as Record<string, unknown>).content;
  if (typeof content === "string") return safeText(content);
  if (!Array.isArray(content)) return "";
  const chunks: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object" || Array.isArray(block)) continue;
    const record = block as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") chunks.push(record.text);
    else if (record.type === "image" || record.type === "document") chunks.push(`[${String(record.type)}]`);
  }
  return safeText(chunks.join("\n"));
};

const mapSession = (session: SDKSessionInfo, identityKey: Buffer): ExternalSessionInfo | null => {
  if (typeof session.sessionId !== "string" || !session.sessionId) return null;
  const id = opaqueProviderSessionId("claude", session.sessionId, identityKey);
  const cwd = typeof session.cwd === "string" && session.cwd ? session.cwd : "";
  const workspaceName = cwd ? basename(cwd) || "Workspace" : "Workspace";
  // `summary` and `firstPrompt` are transcript previews, not safe list metadata. Only an explicit
  // provider title may cross the list boundary; otherwise derive a neutral Hara label.
  const title = safeText(session.customTitle, 120)
    || `Claude session · ${id.slice(-6).toUpperCase()}`;
  return {
    id,
    sourceId: "claude",
    title,
    workspaceName: workspaceName.slice(0, 120),
    workspaceId: `ws_${digest("workspace", cwd || session.sessionId, identityKey)}`,
    state: "stored",
    createdAt: safeTimestamp(session.createdAt ?? session.lastModified),
    updatedAt: safeTimestamp(session.lastModified),
    origin: "cli",
    ephemeral: false,
  };
};

const mapMessage = (message: SessionMessage, nativeSessionId: string, identityKey: Buffer): ExternalSessionMessage | null => {
  const text = extractMessageText(message.message);
  if (!text) return null;
  const role = message.type === "assistant" ? "assistant" : message.type === "user" ? "user" : "notice";
  return {
    id: `msg_${digest("message", `${nativeSessionId}\0${message.uuid}`, identityKey)}`,
    role,
    text,
  };
};

export interface ClaudeAgentSdkAdapterOptions extends ExternalCommandOptions {
  identityKey: Buffer;
  ownership?: ExternalSessionOwnershipStore;
  /** Hermetic tests may inject the official SDK surface without reading a real user's session store. */
  sdk?: ClaudeAgentSdkFacade;
  /** Hermetic authentication probe. Production asks the verified Claude CLI and retains no account fields. */
  authenticationStatus?: () => Promise<"authenticated" | "missing" | "unknown">;
}

export class ClaudeAgentSdkAdapter implements ExternalSessionAdapter {
  readonly id = "claude" as const;
  private readonly refs = new Map<string, ClaudeNativeRef>();
  private readonly running = new Map<string, {
    handle: ReturnType<ClaudeAgentSdkFacade["query"]>;
    turnId: string;
    nativeId: string;
    interrupted: boolean;
  }>();
  private authenticationCache?: { value: "authenticated" | "missing" | "unknown"; expiresAt: number };

  constructor(private readonly options: ClaudeAgentSdkAdapterOptions) {}

  private async authenticationStatus(force = false): Promise<"authenticated" | "missing" | "unknown"> {
    const now = Date.now();
    if (!force && this.authenticationCache && this.authenticationCache.expiresAt > now) {
      return this.authenticationCache.value;
    }
    let value: "authenticated" | "missing" | "unknown";
    if (this.options.authenticationStatus) {
      value = await this.options.authenticationStatus();
    } else {
      const result = await runExternalCommandCapture(this.options, ["auth", "status", "--json"], {
        timeoutMs: 5_000,
        maxOutputBytes: 16 * 1024,
        retainStdoutOnFailure: true,
      });
      try {
        // Current Claude Code intentionally exits 1 for loggedIn:false while still returning this bounded
        // JSON document on stdout. Only the explicit boolean is authoritative; an old/failed CLI that exits
        // non-zero without the schema remains unknown and gets a chance to surface its real SDK error.
        const parsed = JSON.parse(result.stdout) as { loggedIn?: unknown };
        value = parsed.loggedIn === true ? "authenticated" : parsed.loggedIn === false ? "missing" : "unknown";
      } catch {
        value = "unknown";
      }
    }
    this.authenticationCache = { value, expiresAt: now + 5_000 };
    return value;
  }

  private async requireAuthentication(): Promise<void> {
    if (await this.authenticationStatus(true) !== "missing") return;
    throw new ExternalSessionInputError(
      "Claude Code authentication is not available to Hara. The history remains readable, but continuing it requires a Claude Code login or provider configuration visible to Hara; the original terminal may be using temporary environment variables.",
    );
  }

  async inspect(): Promise<ExternalSessionSourceInfo> {
    const probe = await probeExternalCommand(this.options);
    const commandReady = probe.installed && !probe.failed;
    let adapterReady = Boolean(this.options.sdk);
    if (commandReady && !adapterReady) {
      try {
        await loadOfficialSdk();
        adapterReady = true;
      } catch {
        adapterReady = false;
      }
    }
    const ready = commandReady && adapterReady;
    return {
      id: this.id,
      label: "Claude Code",
      state: !probe.installed
        ? "not_installed"
        : probe.failed ? "error" : adapterReady ? "ready" : "adapter_required",
      ...(probe.version ? { version: probe.version } : {}),
      ...(!probe.installed
        ? { reason: "command_not_found" as const }
        : probe.failed
          ? { reason: "probe_failed" as const }
          : !adapterReady ? { reason: "official_adapter_not_bundled" as const } : {}),
      capabilities: {
        listMetadata: ready,
        read: ready,
        create: false,
        fork: ready,
        resume: ready,
        observeLive: false,
        submit: ready,
        steer: false,
        interrupt: ready,
      },
    };
  }

  private remember(session: SDKSessionInfo, owned: boolean): ExternalSessionInfo | null {
    const info = mapSession(session, this.options.identityKey);
    if (!info) return null;
    const prior = this.refs.get(info.id);
    this.refs.set(info.id, {
      nativeId: session.sessionId,
      ...(typeof session.cwd === "string" && session.cwd ? { cwd: session.cwd } : {}),
      owned: owned || this.options.ownership?.has(info.id) === true,
      info,
      ...(prior?.codingWorkspace && prior.codingWorkspace === session.cwd ? { codingWorkspace: prior.codingWorkspace } : {}),
    });
    return info;
  }

  async createCodingSession(input: ExternalCodingSessionInput): Promise<ExternalSessionReadResult> {
    if (input.agentKind !== "claude") throw new Error("the coding worker provider does not match Claude Code");
    await this.requireAuthentication();
    const nativeId = randomUUID();
    const now = Date.now();
    const info = this.remember({ sessionId: nativeId, cwd: input.cwd, lastModified: now, createdAt: now,
      summary: "", customTitle: input.title ?? "Hara coding task" }, true);
    if (!info) throw new Error("Claude Code could not reserve the coding session");
    const ref = this.ref(info.id);
    ref.codingWorkspace = input.cwd;
    ref.fresh = true;
    this.options.ownership?.add("claude", info.id);
    // This reserves the exact UUID, not a claim that a model turn/history already exists. If the
    // first turn never starts, recovery fails closed instead of silently creating another session.
    return { session: info, messages: [], readOnly: false, controlMode: "managed" };
  }

  async resumeCodingSession(input: ExternalCodingSessionResumeInput): Promise<ExternalSessionReadResult> {
    const ref = this.ref(input.providerSessionId);
    if (input.agentKind !== "claude" || !ref.owned || ref.cwd !== input.cwd) {
      throw new Error("the saved Claude coding session is not owned by Hara in this worktree");
    }
    if (this.running.has(input.providerSessionId)) throw new Error("the saved Claude coding session already has a Hara-controlled turn");
    await this.requireAuthentication();
    const sdk = this.options.sdk ?? await loadOfficialSdk();
    const metadata = await sdk.getSessionInfo(ref.nativeId, { dir: input.cwd });
    if (!metadata || metadata.sessionId !== ref.nativeId || metadata.cwd !== input.cwd) {
      throw new Error("Claude Code did not find the original coding session in its owned worktree");
    }
    const info = this.remember(metadata, true);
    if (!info || info.id !== input.providerSessionId) throw new Error("Claude Code returned a different coding session");
    this.ref(info.id).codingWorkspace = input.cwd;
    return { session: info, messages: [], readOnly: false, controlMode: "managed" };
  }

  private ref(sessionId: string): ClaudeNativeRef {
    const ref = this.refs.get(sessionId);
    if (!ref) throw new Error("external Claude session is no longer in the current device index; refresh the list");
    return ref;
  }

  async prepareRuntimeSession(
    _input: Omit<ExternalSessionAdapterCreateInput, "prepare">,
  ): Promise<ExternalRuntimePreparedSession> {
    const nativeSessionId = randomUUID();
    const providerSessionId = opaqueProviderSessionId("claude", nativeSessionId, this.options.identityKey);
    let settled = false;
    return {
      providerSessionId,
      nativeSessionId,
      nativeLaunchMode: "create",
      commit: () => {
        if (settled) return;
        settled = true;
        this.options.ownership?.add("claude", providerSessionId);
      },
      rollback: async () => {
        settled = true;
      },
    };
  }

  async prepareRuntimeContinuation(
    sessionId: string,
    input: Omit<ExternalSessionAdapterCreateInput, "prepare">,
  ): Promise<ExternalRuntimePreparedSession> {
    const ref = this.ref(sessionId);
    if (!ref.cwd || ref.cwd !== input.cwd) {
      throw new Error("the saved Claude Code session belongs to a different workspace");
    }
    await this.requireAuthentication();
    let committed = false;
    return {
      providerSessionId: sessionId,
      nativeSessionId: ref.nativeId,
      nativeLaunchMode: "resume",
      commit: () => {
        if (committed) return;
        committed = true;
        ref.owned = true;
        this.options.ownership?.add("claude", sessionId);
      },
      // The provider history predates this replacement terminal and is never rolled back with it.
      rollback: async () => undefined,
    };
  }

  async resumeInTerminal(sessionId: string): Promise<ExternalProviderTerminalResult> {
    const ref = this.ref(sessionId);
    const result = await runExternalCommandAttached(this.options, ["--resume", ref.nativeId], {
      ...(ref.cwd ? { cwd: ref.cwd } : {}),
    });
    return { sessionId, sourceId: "claude", ...result };
  }

  async list(input: { cursor?: string; limit: number; search?: string }): Promise<ExternalSessionAdapterPage> {
    const offset = input.cursor ? Number(input.cursor) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("external Claude cursor is invalid");
    const sdk = this.options.sdk ?? await loadOfficialSdk();
    const rows = await sdk.listSessions({ limit: input.limit, offset, includeProgrammatic: true });
    const queryText = input.search?.toLocaleLowerCase() ?? "";
    const sessions = rows.flatMap((row) => {
      const info = this.remember(row, false);
      if (!info) return [];
      if (queryText && !`${info.title}\n${info.workspaceName}`.toLocaleLowerCase().includes(queryText)) return [];
      return [info];
    });
    return {
      sessions,
      ...(rows.length === input.limit ? { nextCursor: String(offset + rows.length) } : {}),
    };
  }

  async read(sessionId: string): Promise<ExternalSessionReadResult> {
    const ref = this.ref(sessionId);
    const sdk = this.options.sdk ?? await loadOfficialSdk();
    const rows = await sdk.getSessionMessages(ref.nativeId, {
      ...(ref.cwd ? { dir: ref.cwd } : {}),
      limit: MAX_MESSAGES,
    });
    const authentication = await this.authenticationStatus();
    const authenticationRequired = authentication === "missing";
    const writable = ref.owned && !authenticationRequired;
    return {
      session: ref.info,
      messages: rows.flatMap((row) => {
        const mapped = mapMessage(row, ref.nativeId, this.options.identityKey);
        return mapped ? [mapped] : [];
      }),
      readOnly: !writable,
      controlMode: writable ? "managed" : "history",
      ...(authenticationRequired ? { continuationUnavailableReason: "authentication_required" as const } : {}),
    };
  }

  async resume(sessionId: string): Promise<ExternalSessionReadResult> {
    const ref = this.ref(sessionId);
    if (this.running.has(sessionId)) throw new Error("this external Claude session already has a Hara-controlled turn");
    await this.requireAuthentication();
    const sdk = this.options.sdk ?? await loadOfficialSdk();
    const metadata = await sdk.getSessionInfo(ref.nativeId, ref.cwd ? { dir: ref.cwd } : {});
    if (!metadata || metadata.sessionId !== ref.nativeId) {
      throw new Error("Claude Code could not resume the selected original session");
    }
    const info = this.remember(metadata, true);
    if (!info || info.id !== sessionId) throw new Error("Claude Code resumed a different session than the one selected");
    this.options.ownership?.add("claude", sessionId);
    return await this.read(sessionId);
  }

  async fork(sessionId: string): Promise<ExternalSessionForkResult> {
    const source = this.ref(sessionId);
    const sdk = this.options.sdk ?? await loadOfficialSdk();
    const forked = await sdk.forkSession(source.nativeId, {
      ...(source.cwd ? { dir: source.cwd } : {}),
      title: `${source.info.title} · Hara fork`.slice(0, 120),
    });
    const metadata = await sdk.getSessionInfo(forked.sessionId, source.cwd ? { dir: source.cwd } : {});
    if (!metadata) throw new Error("Claude created a fork but did not return its metadata");
    const info = this.remember(metadata, true);
    if (!info) throw new Error("Claude returned an invalid fork");
    this.options.ownership?.add("claude", info.id);
    const read = await this.read(info.id);
    return { sourceSessionId: sessionId, ...read };
  }

  private permissionHandler(sink: ExternalTurnSink): CanUseTool {
    return async (toolName, input, prompt) => {
      if (toolName === "AskUserQuestion") {
        const raw = Array.isArray(input.questions) ? input.questions : [];
        const request = normalizeExternalUserQuestions({ questions: raw.map((question, index) => (
          question && typeof question === "object" && !Array.isArray(question)
            ? { ...question, id: String(index), isOther: true }
            : question
        )) });
        if (!request || !sink.askUser || prompt.signal.aborted
          || new Set(request.questions.map((question) => question.question)).size !== request.questions.length
          || request.questions.some((question) => ["__proto__", "constructor", "prototype"].includes(question.question))) {
          return { behavior: "deny", message: "User input is unavailable; no answer was selected." };
        }
        try {
          const response = await sink.askUser(request, prompt.signal);
          const answers = prompt.signal.aborted ? undefined : validateExternalUserAnswers(request, response);
          const updatedAnswers: Record<string, string> = {};
          for (const question of request.questions) {
            // Official SDK sdk-tools.d.ts defines answer keys as question text, not the UI header.
            // Partial/cancelled forms must not be
            // treated as an approval of AskUserQuestion, which could otherwise invent a default.
            const answer = answers?.[question.id]?.answers;
            if (!answer?.length || Object.hasOwn(updatedAnswers, question.question)
              || ["__proto__", "constructor", "prototype"].includes(question.question)) {
              return { behavior: "deny", message: "The question was cancelled or incomplete; no answer was selected." };
            }
            updatedAnswers[question.question] = answer.join(", ");
          }
          return { behavior: "allow", updatedInput: { ...input, answers: updatedAnswers } };
        } catch {
          return { behavior: "deny", message: "User input was cancelled; no answer was selected." };
        }
      }
      const previewSource = prompt.title || prompt.description || prompt.displayName || `Claude wants to use ${toolName}`;
      const detail = typeof input.command === "string" ? `\n${input.command.slice(0, 800)}` : "";
      const question = safeText(`${previewSource}${detail}`, 1_200) || `Claude wants to use ${toolName}`;
      const verdict = await sink.confirm({ question, allowAlways: Boolean(prompt.suggestions?.length) }, prompt.signal);
      if (verdict === false) return { behavior: "deny", message: "The user denied this action in Hara." };
      return {
        behavior: "allow",
        ...(verdict === "always" && prompt.suggestions?.length ? { updatedPermissions: prompt.suggestions } : {}),
      };
    };
  }

  async submit(sessionId: string, text: string, sink: ExternalTurnSink): Promise<ExternalTurnResult> {
    if (sink.signal?.aborted) throw new Error("the coding turn was cancelled before dispatch");
    const ref = this.ref(sessionId);
    if (this.running.has(sessionId)) throw new Error("this external Claude session already has a Hara-controlled turn");
    if (!ref.owned) {
      throw new Error("resume the original Claude session explicitly before sending a message");
    }
    await this.requireAuthentication();
    const launch = resolveExternalCommandRuntime(this.options.command, this.options.env ?? process.env);
    if (!launch) throw new Error("Claude Code is no longer installed at its verified location");
    const sdk = this.options.sdk ?? await loadOfficialSdk();
    if (sink.signal?.aborted) throw new Error("the coding turn was cancelled before dispatch");
    const turnId = `extturn_${randomUUID()}`;
    const fresh = ref.fresh === true;
    // Consume the new-session mode before starting. A failed/retried turn may only resume this id,
    // never silently start a replacement conversation.
    ref.fresh = false;
    const handle = sdk.query({
      prompt: text,
      options: {
        ...(fresh ? { sessionId: ref.nativeId } : { resume: ref.nativeId }),
        ...(ref.cwd ? { cwd: ref.cwd } : {}),
        pathToClaudeCodeExecutable: launch.command,
        env: { ...launch.env, CLAUDE_AGENT_SDK_CLIENT_APP: "hara/external-session" },
        permissionMode: "default",
        canUseTool: this.permissionHandler(sink),
      },
    });
    const runtime = { handle, turnId, nativeId: ref.nativeId, interrupted: false };
    this.running.set(sessionId, runtime);
    const cancel = (): void => { runtime.interrupted = true; handle.close(); };
    sink.signal?.addEventListener("abort", cancel, { once: true });
    if (sink.signal?.aborted) cancel();
    let reply = "";
    let failure = "";
    let interrupted = false;
    try {
      for await (const message of handle) {
        const frame = message as SDKMessage;
        if (ref.codingWorkspace && (!("session_id" in frame) || frame.session_id !== ref.nativeId)) {
          throw new Error("Claude Code returned output for a different coding session");
        }
        if (frame.type === "assistant" && frame.parent_tool_use_id === null) {
          const chunk = extractMessageText(frame.message);
          if (chunk) {
            reply += (reply ? "\n" : "") + chunk;
            sink.text(chunk);
          }
        } else if (frame.type === "tool_use_summary") {
          const summary = safeText(frame.summary, 600);
          if (summary) sink.tool("Claude Code", summary);
        } else if (frame.type === "result") {
          if (frame.subtype === "success") {
            if (!reply && frame.result) {
              reply = safeText(frame.result);
              if (reply) sink.text(reply);
            }
          } else {
            failure = safeText(frame.errors.join("\n"), 2_000) || "Claude Code turn failed";
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/abort|closed|interrupt/iu.test(message)) interrupted = true;
      else failure = safeText(message, 2_000) || "Claude Code turn failed";
    } finally {
      sink.signal?.removeEventListener("abort", cancel);
      this.running.delete(sessionId);
      handle.close();
    }
    return {
      sessionId,
      turnId,
      status: interrupted || runtime.interrupted ? "interrupted" : failure ? "failed" : "completed",
      reply,
      ...(failure ? { error: failure } : {}),
    };
  }

  async interrupt(sessionId: string): Promise<void> {
    const runtime = this.running.get(sessionId);
    if (runtime) {
      runtime.interrupted = true;
      runtime.handle.close();
    }
  }

  async close(): Promise<void> {
    for (const runtime of this.running.values()) {
      runtime.interrupted = true;
      runtime.handle.close();
    }
    this.running.clear();
  }
}
