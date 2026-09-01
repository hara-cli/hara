import { createHmac, randomUUID } from "node:crypto";
import { basename } from "node:path";
import type {
  CanUseTool,
  SDKMessage,
  SDKSessionInfo,
  SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { redactSensitiveText } from "../security/secrets.js";
import type { ExternalSessionOwnershipStore } from "./identity.js";
import {
  probeExternalCommand,
  resolveExternalCommandRuntime,
  type ExternalCommandOptions,
} from "./process.js";
import type {
  ExternalSessionAdapter,
  ExternalSessionAdapterPage,
  ExternalSessionForkResult,
  ExternalSessionInfo,
  ExternalSessionMessage,
  ExternalSessionReadResult,
  ExternalSessionSourceInfo,
  ExternalTurnResult,
  ExternalTurnSink,
} from "./types.js";

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
  const id = `ext_claude_${digest("session", session.sessionId, identityKey)}`;
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
}

export class ClaudeAgentSdkAdapter implements ExternalSessionAdapter {
  readonly id = "claude" as const;
  private readonly refs = new Map<string, ClaudeNativeRef>();
  private readonly running = new Map<string, { close(): void }>();

  constructor(private readonly options: ClaudeAgentSdkAdapterOptions) {}

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
    this.refs.set(info.id, {
      nativeId: session.sessionId,
      ...(typeof session.cwd === "string" && session.cwd ? { cwd: session.cwd } : {}),
      owned: owned || this.options.ownership?.has(info.id) === true,
      info,
    });
    return info;
  }

  private ref(sessionId: string): ClaudeNativeRef {
    const ref = this.refs.get(sessionId);
    if (!ref) throw new Error("external Claude session is no longer in the current device index; refresh the list");
    return ref;
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
    return {
      session: ref.info,
      messages: rows.flatMap((row) => {
        const mapped = mapMessage(row, ref.nativeId, this.options.identityKey);
        return mapped ? [mapped] : [];
      }),
      readOnly: !ref.owned,
      controlMode: ref.owned ? "managed" : "history",
    };
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
    let ref = this.ref(sessionId);
    if (this.running.has(sessionId)) throw new Error("this external Claude session already has a Hara-controlled turn");
    if (!ref.owned) {
      const forked = await this.fork(sessionId);
      ref = this.ref(forked.session.id);
      sessionId = ref.info.id;
      sink.notice("Hara forked the Claude session before continuing, so the original remains unchanged.");
    }
    const launch = resolveExternalCommandRuntime(this.options.command, this.options.env ?? process.env);
    if (!launch) throw new Error("Claude Code is no longer installed at its verified location");
    const sdk = this.options.sdk ?? await loadOfficialSdk();
    const turnId = `extturn_${randomUUID()}`;
    const handle = sdk.query({
      prompt: text,
      options: {
        resume: ref.nativeId,
        ...(ref.cwd ? { cwd: ref.cwd } : {}),
        pathToClaudeCodeExecutable: launch.command,
        env: { ...launch.env, CLAUDE_AGENT_SDK_CLIENT_APP: "hara/external-session" },
        permissionMode: "default",
        canUseTool: this.permissionHandler(sink),
      },
    });
    this.running.set(sessionId, handle);
    let reply = "";
    let failure = "";
    let interrupted = false;
    try {
      for await (const message of handle) {
        const frame = message as SDKMessage;
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
      this.running.delete(sessionId);
      handle.close();
    }
    return {
      sessionId,
      turnId,
      status: interrupted ? "interrupted" : failure ? "failed" : "completed",
      reply,
      ...(failure ? { error: failure } : {}),
    };
  }

  async interrupt(sessionId: string): Promise<void> {
    this.running.get(sessionId)?.close();
  }

  async close(): Promise<void> {
    for (const handle of this.running.values()) handle.close();
    this.running.clear();
  }
}
