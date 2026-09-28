import { createHmac, randomUUID } from "node:crypto";
import { isAbsolute, basename } from "node:path";
import { redactSensitiveText } from "../security/secrets.js";
import { opaqueProviderSessionId, type ExternalSessionOwnershipStore } from "./identity.js";
import {
  probeExternalCommand,
  runExternalCommandAttached,
  runExternalCommandCapture,
  type ExternalCommandOptions,
} from "./process.js";
import type {
  ExternalProviderTerminalResult,
  ExternalSessionAdapter,
  ExternalSessionAdapterPage,
  ExternalSessionInfo,
  ExternalSessionMessage,
  ExternalSessionReadResult,
  ExternalSessionSourceInfo,
  ExternalTurnResult,
  ExternalTurnSink,
} from "./types.js";

interface OpenCodeSessionRow {
  id?: unknown;
  title?: unknown;
  updated?: unknown;
  created?: unknown;
  directory?: unknown;
}

interface OpenCodeSessionExport {
  info?: unknown;
  messages?: unknown;
}

interface OpenCodeRef {
  nativeId: string;
  cwd: string;
  owned: boolean;
  info: ExternalSessionInfo;
}

interface OpenCodeRuntime {
  abort: AbortController;
  turnId: string;
}

export interface OpenCodeRuntimeAdapterOptions extends ExternalCommandOptions {
  identityKey: Buffer;
  ownership?: ExternalSessionOwnershipStore;
}

const MAX_INDEX_SESSIONS = 5_000;
const MAX_MESSAGE_TEXT = 128 * 1024;
const MAX_TRANSCRIPT_MESSAGES = 1_000;
const MAX_JSONL_FRAME_BYTES = 1024 * 1024;
const HARA_AGENT = "hara-guarded";
const SAFE_PERMISSIONS = new Set([
  "read", "glob", "grep", "list", "lsp", "todoread", "todowrite", "edit", "write", "apply_patch",
]);

/**
 * OpenCode's native CLI auto-rejects permission prompts in non-interactive `run` mode. A dedicated
 * Hara agent therefore gets a small, deterministic tool boundary: workspace reads and edits are
 * available, while shell, sub-Agent, web, MCP, questions, and external-directory access remain denied.
 * A future server adapter can surface individual permission requests through ExternalTurnSink.confirm.
 */
const HARA_OPENCODE_CONFIG = JSON.stringify({
  agent: {
    [HARA_AGENT]: {
      name: "Hara guarded coding runtime",
      description: "Continue an explicitly claimed OpenCode coding session inside Hara's local safety boundary.",
      mode: "primary",
      permission: {
        "*": "deny",
        read: "allow",
        glob: "allow",
        grep: "allow",
        list: "allow",
        lsp: "allow",
        todoread: "allow",
        todowrite: "allow",
        edit: "allow",
        write: "allow",
        apply_patch: "allow",
        bash: "deny",
        task: "deny",
        external_directory: "deny",
        webfetch: "deny",
        websearch: "deny",
        question: "deny",
      },
    },
  },
});

const digest = (kind: "session" | "workspace", value: string, identityKey: Buffer): string => createHmac("sha256", identityKey)
  .update(`hara.external.opencode.${kind}\0${value}`, "utf8")
  .digest("hex")
  .slice(0, 24);

const safeText = (value: unknown, maximum = MAX_MESSAGE_TEXT): string => redactSensitiveText(
  typeof value === "string" ? value : "",
).text
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
  .trim()
  .slice(0, maximum);

const safeDelta = (value: unknown, maximum = MAX_MESSAGE_TEXT): string => redactSensitiveText(
  typeof value === "string" ? value : "",
).text
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
  .slice(0, maximum);

const safeTitle = (value: unknown, opaqueId: string): string => (
  safeText(value, 120) || `OpenCode session · ${opaqueId.slice(-6).toUpperCase()}`
);

const isoFromMilliseconds = (value: unknown): string => {
  const milliseconds = typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
  const date = new Date(Math.min(milliseconds, 8_640_000_000_000_000));
  return Number.isNaN(date.valueOf()) ? new Date(0).toISOString() : date.toISOString();
};

const nativeSessionId = (value: unknown): value is string => (
  typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/u.test(value)
);

const objectRecord = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
);

const parseJson = (text: string, context: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`OpenCode returned invalid ${context}`);
  }
};

const sessionPermissionCompatible = (value: unknown): boolean => {
  if (value === undefined || value === null) return true;
  if (!Array.isArray(value)) return false;
  return value.every((entry) => {
    const rule = objectRecord(entry);
    if (!rule || typeof rule.permission !== "string" || typeof rule.action !== "string") return false;
    if (rule.action !== "allow") return rule.action === "deny" || rule.action === "ask";
    return rule.permission !== "*" && SAFE_PERMISSIONS.has(rule.permission);
  });
};

const exportedMessages = (
  nativeId: string,
  value: unknown,
  identityKey: Buffer,
): ExternalSessionMessage[] => {
  if (!Array.isArray(value)) return [];
  const result: ExternalSessionMessage[] = [];
  for (const item of value) {
    const message = objectRecord(item);
    const info = objectRecord(message?.info);
    if (!message || !info || !nativeSessionId(info.id) || (info.role !== "user" && info.role !== "assistant")) continue;
    const chunks: string[] = [];
    if (Array.isArray(message.parts)) {
      for (const rawPart of message.parts) {
        const part = objectRecord(rawPart);
        if (part?.type === "text") {
          const text = safeText(part.text);
          if (text) chunks.push(text);
        } else if (info.role === "user" && part?.type === "file") {
          chunks.push("[attachment]");
        }
      }
    }
    const text = safeText(chunks.join("\n"));
    if (!text) continue;
    result.push({
      id: `msg_${digest("session", `${nativeId}\0message\0${info.id}`, identityKey)}`,
      role: info.role,
      text,
    });
    if (result.length >= MAX_TRANSCRIPT_MESSAGES) break;
  }
  return result;
};

export class OpenCodeRuntimeAdapter implements ExternalSessionAdapter {
  readonly id = "opencode" as const;
  private readonly refs = new Map<string, OpenCodeRef>();
  private readonly running = new Map<string, OpenCodeRuntime>();
  private readonly command: ExternalCommandOptions;

  constructor(private readonly options: OpenCodeRuntimeAdapterOptions) {
    this.command = {
      command: options.command,
      argsPrefix: options.argsPrefix,
      spawnProcess: options.spawnProcess,
      timeoutMs: options.timeoutMs,
      env: {
        ...(options.env ?? process.env),
        // This invocation-only agent is loaded after project config. It neither stores credentials nor
        // modifies the user's OpenCode configuration on disk.
        OPENCODE_CONFIG_CONTENT: HARA_OPENCODE_CONFIG,
        OPENCODE_PERMISSION: JSON.stringify({ "*": "deny" }),
      },
    };
  }

  async inspect(): Promise<ExternalSessionSourceInfo> {
    const probe = await probeExternalCommand(this.options);
    const ready = probe.installed && !probe.failed;
    return {
      id: this.id,
      label: "OpenCode",
      state: !probe.installed ? "not_installed" : probe.failed ? "error" : "ready",
      ...(probe.version ? { version: probe.version } : {}),
      ...(!probe.installed
        ? { reason: "command_not_found" as const }
        : probe.failed ? { reason: "probe_failed" as const } : {}),
      capabilities: {
        listMetadata: ready,
        read: ready,
        create: false,
        fork: false,
        resume: ready,
        observeLive: false,
        submit: ready,
        steer: false,
        interrupt: ready,
      },
    };
  }

  private remember(row: OpenCodeSessionRow): OpenCodeRef | null {
    if (!nativeSessionId(row.id) || typeof row.directory !== "string" || !isAbsolute(row.directory)) return null;
    const id = opaqueProviderSessionId("opencode", row.id, this.options.identityKey);
    const prior = this.refs.get(id);
    const owned = prior?.owned === true || this.options.ownership?.has(id) === true;
    const running = this.running.has(id);
    const workspaceName = basename(row.directory) || "Workspace";
    const info: ExternalSessionInfo = {
      id,
      sourceId: "opencode",
      title: safeTitle(row.title, id),
      workspaceName: safeText(workspaceName, 120) || "Workspace",
      workspaceId: `ws_${digest("workspace", row.directory, this.options.identityKey)}`,
      state: running ? "working" : owned ? "idle" : "stored",
      createdAt: isoFromMilliseconds(row.created),
      updatedAt: running ? new Date().toISOString() : isoFromMilliseconds(row.updated),
      origin: "exec",
      ephemeral: false,
    };
    const ref = { nativeId: row.id, cwd: row.directory, owned, info };
    this.refs.set(id, ref);
    return ref;
  }

  private async index(maxCount = MAX_INDEX_SESSIONS): Promise<OpenCodeRef[]> {
    const result = await runExternalCommandCapture(this.command, [
      "--pure", "session", "list", "--format", "json", "--max-count", String(maxCount),
    ], { timeoutMs: 30_000, maxOutputBytes: 16 * 1024 * 1024 });
    if (!result.ok) throw new Error("OpenCode session history is unavailable");
    if (!result.stdout.trim()) return [];
    const parsed = parseJson(result.stdout, "session index");
    if (!Array.isArray(parsed) || parsed.length > maxCount) throw new Error("OpenCode returned an invalid session index");
    return parsed.flatMap((row) => {
      const mapped = this.remember(objectRecord(row) ?? {});
      return mapped ? [mapped] : [];
    });
  }

  async list(input: { cursor?: string; limit: number; search?: string }): Promise<ExternalSessionAdapterPage> {
    const offset = input.cursor === undefined
      ? 0
      : /^\d{1,7}$/u.test(input.cursor) ? Number(input.cursor) : Number.NaN;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= MAX_INDEX_SESSIONS) {
      throw new Error("OpenCode session cursor is invalid");
    }
    const query = input.search?.trim().toLocaleLowerCase() ?? "";
    const requestedCount = query
      ? MAX_INDEX_SESSIONS
      : Math.min(MAX_INDEX_SESSIONS, offset + input.limit + 1);
    const refs = await this.index(requestedCount);
    const visible = query
      ? refs.filter((ref) => `${ref.info.title}\n${ref.info.workspaceName}`.toLocaleLowerCase().includes(query))
      : refs;
    const sessions = visible.slice(offset, offset + input.limit).map((ref) => ({ ...ref.info }));
    const nextOffset = offset + sessions.length;
    return {
      sessions,
      ...(nextOffset < visible.length ? { nextCursor: String(nextOffset) } : {}),
    };
  }

  private async ref(sessionId: string): Promise<OpenCodeRef> {
    const current = this.refs.get(sessionId);
    if (current) return current;
    await this.index();
    const indexed = this.refs.get(sessionId);
    if (!indexed) throw new Error("external OpenCode session is no longer in the current device index; refresh the list");
    return indexed;
  }

  private async exported(ref: OpenCodeRef): Promise<{ info: Record<string, unknown>; messages: unknown }> {
    const result = await runExternalCommandCapture(this.command, ["--pure", "export", ref.nativeId], {
      cwd: ref.cwd,
      timeoutMs: 30_000,
      maxOutputBytes: 16 * 1024 * 1024,
    });
    if (!result.ok) throw new Error("OpenCode could not read the selected session");
    const parsed = objectRecord(parseJson(result.stdout, "session export")) as OpenCodeSessionExport | null;
    const info = objectRecord(parsed?.info);
    if (!info || info.id !== ref.nativeId) throw new Error("OpenCode returned a different session than the one selected");
    return { info, messages: parsed?.messages };
  }

  async read(sessionId: string): Promise<ExternalSessionReadResult> {
    const ref = await this.ref(sessionId);
    const exported = await this.exported(ref);
    const owned = ref.owned || this.options.ownership?.has(sessionId) === true;
    ref.owned = owned;
    ref.info = {
      ...ref.info,
      state: this.running.has(sessionId) ? "working" : owned ? "idle" : "stored",
    };
    return {
      session: { ...ref.info },
      messages: exportedMessages(ref.nativeId, exported.messages, this.options.identityKey),
      readOnly: !owned,
      controlMode: owned ? "managed" : "history",
    };
  }

  async resume(sessionId: string): Promise<ExternalSessionReadResult> {
    const ref = await this.ref(sessionId);
    if (this.running.has(sessionId)) throw new Error("this external OpenCode session already has a Hara-controlled turn");
    await this.exported(ref);
    ref.owned = true;
    ref.info = { ...ref.info, state: "idle" };
    this.options.ownership?.add("opencode", sessionId);
    return await this.read(sessionId);
  }

  async submit(sessionId: string, text: string, sink: ExternalTurnSink): Promise<ExternalTurnResult> {
    const ref = await this.ref(sessionId);
    if (!ref.owned && this.options.ownership?.has(sessionId) !== true) {
      throw new Error("resume the OpenCode session through Hara before continuing it");
    }
    if (this.running.has(sessionId)) throw new Error("this external OpenCode session already has a Hara-controlled turn");
    const exported = await this.exported(ref);
    if (!sessionPermissionCompatible(exported.info.permission)) {
      throw new Error("this OpenCode session has permission overrides that cannot be safely continued by Hara");
    }

    const turnId = `turn_${randomUUID()}`;
    const abort = new AbortController();
    this.running.set(sessionId, { abort, turnId });
    ref.info = { ...ref.info, state: "working", updatedAt: new Date().toISOString() };
    const replies: string[] = [];
    let buffer = "";
    let providerError = false;

    const consume = (line: string): void => {
      if (!line.trim()) return;
      if (Buffer.byteLength(line, "utf8") > MAX_JSONL_FRAME_BYTES) throw new Error("OpenCode emitted an overlong event");
      const event = objectRecord(parseJson(line, "event stream"));
      if (!event || event.sessionID !== ref.nativeId || typeof event.type !== "string") {
        throw new Error("OpenCode emitted an event for a different session");
      }
      if (event.type === "text") {
        const part = objectRecord(event.part);
        const delta = safeDelta(part?.text);
        if (delta) {
          replies.push(delta);
          sink.text(delta);
        }
      } else if (event.type === "tool_use") {
        const part = objectRecord(event.part);
        const state = objectRecord(part?.state);
        const name = safeText(part?.tool, 80) || "tool";
        const status = safeText(state?.status, 32);
        const title = safeText(state?.title, 180);
        sink.tool(name, title || status || "completed");
      } else if (event.type === "error") {
        providerError = true;
      }
    };

    try {
      const result = await runExternalCommandCapture(this.command, [
        "--pure", "run", "--dir", ref.cwd, "--format", "json", "--session", ref.nativeId,
        "--agent", HARA_AGENT, "--", text,
      ], {
        cwd: ref.cwd,
        timeoutMs: 10 * 60_000,
        maxOutputBytes: 16 * 1024 * 1024,
        signal: abort.signal,
        onStdout: (chunk) => {
          buffer += chunk;
          if (Buffer.byteLength(buffer, "utf8") > MAX_JSONL_FRAME_BYTES * 2) {
            throw new Error("OpenCode event buffer exceeded its limit");
          }
          for (;;) {
            const newline = buffer.indexOf("\n");
            if (newline < 0) break;
            const line = buffer.slice(0, newline).replace(/\r$/u, "");
            buffer = buffer.slice(newline + 1);
            consume(line);
          }
        },
      });
      if (buffer.trim()) consume(buffer.replace(/\r$/u, ""));
      const reply = safeText(replies.join("\n\n"), MAX_MESSAGE_TEXT * 4);
      if (result.errorCode === "interrupted") {
        ref.info = { ...ref.info, state: "idle", updatedAt: new Date().toISOString() };
        return { sessionId, turnId, status: "interrupted", reply };
      }
      if (!result.ok || providerError) {
        ref.info = { ...ref.info, state: "error", updatedAt: new Date().toISOString() };
        return {
          sessionId,
          turnId,
          status: "failed",
          reply,
          error: "OpenCode could not complete this guarded turn",
        };
      }
      ref.info = { ...ref.info, state: "idle", updatedAt: new Date().toISOString() };
      return { sessionId, turnId, status: "completed", reply };
    } finally {
      this.running.delete(sessionId);
    }
  }

  async interrupt(sessionId: string): Promise<void> {
    this.running.get(sessionId)?.abort.abort();
  }

  async resumeInTerminal(sessionId: string): Promise<ExternalProviderTerminalResult> {
    const ref = await this.ref(sessionId);
    const result = await runExternalCommandAttached(this.options, [ref.cwd, "--session", ref.nativeId], { cwd: ref.cwd });
    return { sessionId, sourceId: "opencode", ...result };
  }

  async close(): Promise<void> {
    for (const runtime of this.running.values()) runtime.abort.abort();
    this.running.clear();
  }
}
