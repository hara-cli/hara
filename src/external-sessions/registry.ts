import { randomBytes } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { CodexAppServerAdapter } from "./codex.js";
import { ClaudeAgentSdkAdapter } from "./claude.js";
import { HaraRuntimeAdapter } from "./runtime.js";
import { OpenCodeRuntimeAdapter } from "./opencode.js";
import { OpenCodeCodingWorkerAdapter } from "./opencode-worker.js";
import { HARA_CODE_RUNTIME_UNAVAILABLE_MESSAGE, resolveHaraCodeRuntime } from "../opencode-runtime.js";
import { ExternalSessionOwnershipStore, externalSessionIdentityKey } from "./identity.js";
import type { ExternalCommandOptions } from "./process.js";
import {
  ExternalSessionInputError,
  type ExternalSessionAdapter,
  type ExternalSessionCreateInput,
  type ExternalCodingSessionInput,
  type ExternalCodingSessionResumeInput,
  type ExternalSessionForkResult,
  type ExternalSessionListInput,
  type ExternalSessionListResult,
  type ExternalSessionReadResult,
  type ExternalRuntimeRecoverInput,
  type ExternalSessionService,
  type ExternalSessionSourceInfo,
  type ExternalSessionSourceId,
  type ExternalProviderTerminalResult,
  type ExternalSteerResult,
  type ExternalTerminalKey,
  type ExternalNativeTerminalOpenInput,
  type ExternalNativeTerminalResult,
  type ExternalTerminalSnapshot,
  type ExternalTerminalStream,
  type ExternalTerminalStreamOpenInput,
  type ExternalTerminalStreamSink,
  type ExternalTurnResult,
  type ExternalTurnSink,
} from "./types.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const CURSOR_TTL_MS = 10 * 60 * 1_000;
const SOURCE_ORDER: ExternalSessionSourceId[] = ["runtime", "codex", "claude", "opencode"];

interface CursorRecord {
  sourceId: ExternalSessionSourceId;
  providerCursor: string;
  search: string;
  expiresAt: number;
}

export interface ExternalSessionRegistryOptions {
  haraVersion: string;
  adapters?: ExternalSessionAdapter[];
  identityKey?: Buffer;
  identityHome?: string;
  codex?: Partial<ExternalCommandOptions> & { managedDaemon?: boolean };
  claude?: Partial<ExternalCommandOptions>;
  opencode?: Partial<ExternalCommandOptions>;
  runtime?: Partial<ExternalCommandOptions> & { sessionName?: string; runtimeRoot?: string };
}

/** Missing optional native packages are a capability state, never an ambient PATH fallback. */
export class UnavailableOpenCodeAdapter implements ExternalSessionAdapter {
  readonly id = "opencode" as const;

  async inspect(): Promise<ExternalSessionSourceInfo & { installed: false; available: false; remediation: string }> {
    return { id: this.id, label: "OpenCode", state: "not_installed", reason: "command_not_found",
      installed: false, available: false, remediation: HARA_CODE_RUNTIME_UNAVAILABLE_MESSAGE,
      capabilities: { listMetadata: false, read: false, create: false, fork: false, resume: false,
        observeLive: false, submit: false, steer: false, interrupt: false } };
  }

  async list(): Promise<{ sessions: [] }> { return { sessions: [] }; }
  async createCodingSession(): Promise<ExternalSessionReadResult> { throw new ExternalSessionInputError(HARA_CODE_RUNTIME_UNAVAILABLE_MESSAGE); }
  async resumeCodingSession(): Promise<ExternalSessionReadResult> { throw new ExternalSessionInputError(HARA_CODE_RUNTIME_UNAVAILABLE_MESSAGE); }
  async read(): Promise<ExternalSessionReadResult> { throw new ExternalSessionInputError(HARA_CODE_RUNTIME_UNAVAILABLE_MESSAGE); }
  async resume(): Promise<ExternalSessionReadResult> { throw new ExternalSessionInputError(HARA_CODE_RUNTIME_UNAVAILABLE_MESSAGE); }
  async submit(): Promise<ExternalTurnResult> { throw new ExternalSessionInputError(HARA_CODE_RUNTIME_UNAVAILABLE_MESSAGE); }
}

export class ExternalSessionRegistry implements ExternalSessionService {
  private readonly adapters: Map<ExternalSessionSourceId, ExternalSessionAdapter>;
  private readonly cursors = new Map<string, CursorRecord>();
  private readonly writers = new Set<string>();

  constructor(options: ExternalSessionRegistryOptions) {
    const adapters = options.adapters ?? (() => {
      const identityKey = options.identityKey ?? externalSessionIdentityKey(options.identityHome);
      const ownership = new ExternalSessionOwnershipStore(options.identityHome);
      const opencodeRuntime = options.opencode?.command !== undefined
        ? { available: true as const, command: options.opencode.command }
        : resolveHaraCodeRuntime(options.opencode?.env ?? process.env);
      return [
        new HaraRuntimeAdapter({
          command: options.runtime?.command ?? process.env.HARA_HERDR_PATH ?? "herdr",
          argsPrefix: options.runtime?.argsPrefix,
          spawnProcess: options.runtime?.spawnProcess,
          timeoutMs: options.runtime?.timeoutMs,
          env: options.runtime?.env,
          sessionName: options.runtime?.sessionName,
          runtimeRoot: options.runtime?.runtimeRoot,
          identityHome: options.identityHome,
          identityKey,
        }),
        new CodexAppServerAdapter({
          command: options.codex?.command ?? "codex",
          argsPrefix: options.codex?.argsPrefix,
          spawnProcess: options.codex?.spawnProcess,
          timeoutMs: options.codex?.timeoutMs,
          env: options.codex?.env,
          haraVersion: options.haraVersion,
          identityKey,
          ownership,
          managedDaemon: options.codex?.managedDaemon,
        }),
        new ClaudeAgentSdkAdapter({
          command: options.claude?.command ?? "claude",
          argsPrefix: options.claude?.argsPrefix,
          spawnProcess: options.claude?.spawnProcess,
          timeoutMs: options.claude?.timeoutMs,
          env: options.claude?.env,
          identityKey,
          ownership,
        }),
        opencodeRuntime.available ? new OpenCodeCodingWorkerAdapter({
          command: opencodeRuntime.command,
          argsPrefix: options.opencode?.argsPrefix,
          spawnProcess: options.opencode?.spawnProcess,
          timeoutMs: options.opencode?.timeoutMs,
          env: options.opencode?.env,
          identityKey,
          identityHome: options.identityHome,
          ownership,
          history: new OpenCodeRuntimeAdapter({
            command: opencodeRuntime.command,
            argsPrefix: options.opencode?.argsPrefix,
            spawnProcess: options.opencode?.spawnProcess,
            timeoutMs: options.opencode?.timeoutMs,
            env: options.opencode?.env,
            identityKey,
            ownership,
          }),
          prepareTurn: async (_input, sink) => {
            if (!sink.prepareCodingHost || !sink.signal || sink.signal.aborted) {
              throw new ExternalSessionInputError("the guarded Hara coding host is unavailable");
            }
            // OpenCode supplies its own combined cancellation signal after reserving the writer.
            return await sink.prepareCodingHost(sink.signal);
          },
        }) : new UnavailableOpenCodeAdapter(),
      ];
    })();
    this.adapters = new Map(adapters.map((adapter) => [adapter.id, adapter]));
  }

  private pruneCursors(now = Date.now()): void {
    for (const [cursor, record] of this.cursors) {
      if (record.expiresAt <= now) this.cursors.delete(cursor);
    }
  }

  private wrapCursor(sourceId: ExternalSessionSourceId, providerCursor: string, search: string): string {
    this.pruneCursors();
    const cursor = `extcur_${randomBytes(18).toString("base64url")}`;
    this.cursors.set(cursor, {
      sourceId,
      providerCursor,
      search,
      expiresAt: Date.now() + CURSOR_TTL_MS,
    });
    return cursor;
  }

  private unwrapCursor(cursor: string, sourceId: ExternalSessionSourceId, search: string): string {
    this.pruneCursors();
    const record = this.cursors.get(cursor);
    if (!record || record.sourceId !== sourceId || record.search !== search) {
      throw new ExternalSessionInputError("external session cursor is invalid or expired");
    }
    this.cursors.delete(cursor);
    return record.providerCursor;
  }

  async listSources(): Promise<{ sources: ExternalSessionSourceInfo[] }> {
    const inspected = await Promise.all([...this.adapters.values()].map((adapter) => adapter.inspect()));
    return {
      sources: inspected.sort((left, right) => (
        SOURCE_ORDER.indexOf(left.id) - SOURCE_ORDER.indexOf(right.id)
      )),
    };
  }

  async listSessions(input: ExternalSessionListInput = {}): Promise<ExternalSessionListResult> {
    const sourceId = input.sourceId ?? "codex";
    const limit = input.limit ?? DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new ExternalSessionInputError(`limit must be an integer from 1 to ${MAX_LIMIT}`);
    }
    const search = input.search?.trim() ?? "";
    if (search.length > 200) throw new ExternalSessionInputError("search must not exceed 200 characters");
    const sourceSnapshot = await this.listSources();
    const source = sourceSnapshot.sources.find((candidate) => candidate.id === sourceId);
    const adapter = this.adapters.get(sourceId);
    if (!source || !adapter || source.state !== "ready" || !source.capabilities.listMetadata) {
      return {
        sources: sourceSnapshot.sources,
        sessions: [],
        page: { limit, hasMore: false },
      };
    }
    const providerCursor = input.cursor ? this.unwrapCursor(input.cursor, sourceId, search) : undefined;
    let page;
    try {
      page = await adapter.list({
        limit,
        ...(providerCursor ? { cursor: providerCursor } : {}),
        ...(search ? { search } : {}),
      });
    } catch {
      // Provider CLIs are independently installed and can be older than the adapter protocol (on
      // Windows this commonly presents as App Server exiting with code 2). One broken provider must
      // not fail the whole Session Center or hide Hara Live / the other provider. Return a sanitized,
      // capability-disabled source snapshot; raw stderr, native ids, and local paths stay server-side.
      const failedSources = sourceSnapshot.sources.map((candidate) => candidate.id === sourceId
        ? {
            ...candidate,
            state: "error" as const,
            reason: "probe_failed" as const,
            capabilities: Object.fromEntries(
              Object.keys(candidate.capabilities).map((capability) => [capability, false]),
            ) as unknown as ExternalSessionSourceInfo["capabilities"],
          }
        : candidate);
      return {
        sources: failedSources,
        sessions: [],
        page: { limit, hasMore: false },
      };
    }
    const nextCursor = page.nextCursor ? this.wrapCursor(sourceId, page.nextCursor, search) : undefined;
    return {
      sources: sourceSnapshot.sources,
      sessions: page.sessions,
      page: {
        limit,
        hasMore: Boolean(nextCursor),
        ...(nextCursor ? { nextCursor } : {}),
      },
    };
  }

  async createSession(input: ExternalSessionCreateInput): Promise<ExternalSessionReadResult> {
    if (!input || input.sourceId !== "runtime") {
      throw new ExternalSessionInputError("only Hara Live can create a terminal relay session");
    }
    const adapter = this.adapters.get(input.sourceId);
    if (!adapter?.create) throw new ExternalSessionInputError("Hara Live runtime is unavailable");
    const providerAdapter = this.adapters.get(input.agentKind);
    return await adapter.create({
      cwd: input.cwd,
      agentKind: input.agentKind,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.launch !== undefined ? { launch: input.launch } : {}),
      ...(providerAdapter?.prepareRuntimeSession ? {
        prepare: (cwd: string) => providerAdapter.prepareRuntimeSession!({
          cwd,
          agentKind: input.agentKind,
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.launch !== undefined ? { launch: input.launch } : {}),
        }),
      } : {}),
    });
  }

  async recoverRuntimeSession(input: ExternalRuntimeRecoverInput): Promise<ExternalSessionReadResult> {
    if (!input || input.sourceId !== "runtime") {
      throw new ExternalSessionInputError("only Hara Live can recover a terminal relay session");
    }
    const runtimeAdapter = this.adapters.get("runtime");
    if (!runtimeAdapter?.create) throw new ExternalSessionInputError("Hara Live runtime is unavailable");
    const providerAdapter = this.adapterForSession(input.providerSessionId);
    if (providerAdapter.id !== input.agentKind) {
      throw new ExternalSessionInputError("the provider session does not match the requested coding runtime");
    }
    if (!providerAdapter.prepareRuntimeContinuation) {
      throw new ExternalSessionInputError("this provider cannot restore a Hara Live terminal");
    }
    return await runtimeAdapter.create({
      cwd: input.cwd,
      agentKind: input.agentKind,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.launch !== undefined ? { launch: input.launch } : {}),
      prepare: async (cwd: string) => {
        await this.indexProviderSession(input.providerSessionId, providerAdapter);
        return await providerAdapter.prepareRuntimeContinuation!(input.providerSessionId, {
          cwd,
          agentKind: input.agentKind,
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.launch !== undefined ? { launch: input.launch } : {}),
        });
      },
    });
  }

  private codingInput(input: ExternalCodingSessionInput): ExternalCodingSessionInput {
    if (!input || (input.agentKind !== "codex" && input.agentKind !== "claude" && input.agentKind !== "opencode")
      || typeof input.cwd !== "string" || !isAbsolute(input.cwd)) {
      throw new ExternalSessionInputError("a coding worker requires a provider and an absolute worktree directory");
    }
    let cwd: string;
    try {
      cwd = realpathSync(input.cwd);
      if (!statSync(cwd).isDirectory()) throw new Error("not a directory");
    } catch {
      throw new ExternalSessionInputError("the coding worker worktree is no longer available");
    }
    return { agentKind: input.agentKind, cwd, ...(input.title !== undefined ? { title: input.title } : {}) };
  }

  async createCodingSession(input: ExternalCodingSessionInput): Promise<ExternalSessionReadResult> {
    const bounded = this.codingInput(input);
    const adapter = this.adapters.get(bounded.agentKind);
    if (!adapter?.createCodingSession) throw new ExternalSessionInputError("this provider cannot create a structured coding worker");
    return await adapter.createCodingSession(bounded);
  }

  async resumeCodingSession(input: ExternalCodingSessionResumeInput): Promise<ExternalSessionReadResult> {
    const bounded = this.codingInput(input);
    const adapter = this.adapterForSession(input.providerSessionId);
    if (adapter.id !== bounded.agentKind || !adapter.resumeCodingSession) {
      throw new ExternalSessionInputError("the saved coding session does not match its worker provider");
    }
    return await this.withWriter(input.providerSessionId, async () => {
      // Index only locates a native id. The adapter must separately require existing Hara ownership
      // and the exact canonical worktree before it resumes anything.
      await this.indexProviderSession(input.providerSessionId, adapter);
      return await adapter.resumeCodingSession!({ ...bounded, providerSessionId: input.providerSessionId });
    });
  }

  private async withWriter<T>(sessionId: string, action: () => Promise<T>): Promise<T> {
    if (this.writers.has(sessionId)) throw new ExternalSessionInputError("this external session already has a Hara-controlled writer");
    this.writers.add(sessionId);
    try { return await action(); }
    finally { this.writers.delete(sessionId); }
  }

  private adapterForSession(sessionId: string): ExternalSessionAdapter {
    if (typeof sessionId !== "string" || !/^ext_(?:codex|claude|opencode|runtime)_[a-f0-9]{24}$/.test(sessionId)) {
      throw new ExternalSessionInputError("external session id is invalid");
    }
    const sourceId: ExternalSessionSourceId = sessionId.startsWith("ext_codex_")
      ? "codex"
      : sessionId.startsWith("ext_claude_")
        ? "claude"
        : sessionId.startsWith("ext_opencode_") ? "opencode" : "runtime";
    const adapter = this.adapters.get(sourceId);
    if (!adapter) throw new ExternalSessionInputError("external session source is unavailable");
    return adapter;
  }

  async readSession(sessionId: string): Promise<ExternalSessionReadResult> {
    const adapter = this.adapterForSession(sessionId);
    if (!adapter.read) throw new ExternalSessionInputError("external session source does not support reading");
    return await adapter.read(sessionId);
  }

  async resumeSession(sessionId: string): Promise<ExternalSessionReadResult> {
    const adapter = this.adapterForSession(sessionId);
    if (!adapter.resume) throw new ExternalSessionInputError("external session source does not support native resume");
    return await adapter.resume(sessionId);
  }

  async forkSession(sessionId: string): Promise<ExternalSessionForkResult> {
    const adapter = this.adapterForSession(sessionId);
    if (!adapter.fork) throw new ExternalSessionInputError("external session source does not support forking");
    return await adapter.fork(sessionId);
  }

  async submit(sessionId: string, text: string, sink: ExternalTurnSink): Promise<ExternalTurnResult> {
    const adapter = this.adapterForSession(sessionId);
    if (!adapter.submit) throw new ExternalSessionInputError("external session source does not support continuation");
    if (typeof text !== "string" || !text.trim()) throw new ExternalSessionInputError("text is required");
    if (Buffer.byteLength(text, "utf8") > 256 * 1024) {
      throw new ExternalSessionInputError("external session input exceeds 256 KiB");
    }
    return await this.withWriter(sessionId, () => adapter.submit!(sessionId, text, sink));
  }

  async steer(sessionId: string, text: string): Promise<ExternalSteerResult> {
    const adapter = this.adapterForSession(sessionId);
    if (!adapter.steer) throw new ExternalSessionInputError("external session source does not support steering");
    if (typeof text !== "string" || !text.trim()) throw new ExternalSessionInputError("text is required");
    if (Buffer.byteLength(text, "utf8") > 256 * 1024) {
      throw new ExternalSessionInputError("external session input exceeds 256 KiB");
    }
    return await adapter.steer(sessionId, text);
  }

  async interrupt(sessionId: string): Promise<void> {
    const adapter = this.adapterForSession(sessionId);
    await adapter.interrupt?.(sessionId);
  }

  async removeSession(sessionId: string): Promise<void> {
    const adapter = this.adapterForSession(sessionId);
    if (!adapter.remove) {
      throw new ExternalSessionInputError("this external session cannot be removed by Hara");
    }
    await adapter.remove(sessionId);
  }

  async terminalSnapshot(sessionId: string): Promise<ExternalTerminalSnapshot> {
    const adapter = this.adapterForSession(sessionId);
    if (!adapter.terminalSnapshot) {
      throw new ExternalSessionInputError("this external session does not expose a live terminal");
    }
    return await adapter.terminalSnapshot(sessionId);
  }

  async terminalInput(sessionId: string, text: string): Promise<void> {
    const adapter = this.adapterForSession(sessionId);
    if (!adapter.terminalInput) {
      throw new ExternalSessionInputError("this external session does not accept terminal input");
    }
    if (typeof text !== "string" || !text.trim()) throw new ExternalSessionInputError("terminal text is required");
    if (Buffer.byteLength(text, "utf8") > 64 * 1024) {
      throw new ExternalSessionInputError("terminal input exceeds 64 KiB");
    }
    await adapter.terminalInput(sessionId, text);
  }

  async terminalKey(sessionId: string, key: ExternalTerminalKey): Promise<void> {
    const adapter = this.adapterForSession(sessionId);
    if (!adapter.terminalKey) {
      throw new ExternalSessionInputError("this external session does not accept terminal keys");
    }
    await adapter.terminalKey(sessionId, key);
  }

  async openTerminalStream(
    sessionId: string,
    input: ExternalTerminalStreamOpenInput,
    sink: ExternalTerminalStreamSink,
  ): Promise<ExternalTerminalStream> {
    const adapter = this.adapterForSession(sessionId);
    if (!adapter.openTerminalStream) {
      throw new ExternalSessionInputError("this external session does not expose a streaming terminal");
    }
    return await adapter.openTerminalStream(sessionId, input, sink);
  }

  async openNativeTerminal(
    sessionId: string,
    input: ExternalNativeTerminalOpenInput,
  ): Promise<ExternalNativeTerminalResult> {
    const adapter = this.adapterForSession(sessionId);
    if (!adapter.openNativeTerminal) {
      throw new ExternalSessionInputError("this external session does not support a native terminal handoff");
    }
    return await adapter.openNativeTerminal(sessionId, input);
  }

  private async indexProviderSession(
    sessionId: string,
    adapter: ExternalSessionAdapter,
  ): Promise<void> {
    let cursor: string | undefined;
    for (let pageNumber = 0; pageNumber < 50; pageNumber += 1) {
      const page = await adapter.list({ limit: 100, ...(cursor ? { cursor } : {}) });
      if (page.sessions.some((session) => session.id === sessionId)) return;
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    throw new ExternalSessionInputError("the provider session is no longer available on this device");
  }

  async resumeInTerminal(sessionId: string): Promise<ExternalProviderTerminalResult> {
    let targetId = sessionId;
    let adapter = this.adapterForSession(targetId);
    if (adapter.id === "runtime") {
      if (!adapter.read) throw new ExternalSessionInputError("the Hara Live session cannot be inspected");
      const live = await adapter.read(targetId);
      if (!live.session.providerSessionId) {
        throw new ExternalSessionInputError(
          "this older Hara Live session has no persistent provider recovery link; use its live terminal while it remains available",
        );
      }
      targetId = live.session.providerSessionId;
      adapter = this.adapterForSession(targetId);
    }
    if (adapter.id !== "codex" && adapter.id !== "claude" && adapter.id !== "opencode") {
      throw new ExternalSessionInputError("this external session does not have a provider terminal");
    }
    if (!adapter.resumeInTerminal) {
      throw new ExternalSessionInputError("this provider does not support terminal recovery");
    }
    return await this.withWriter(targetId, async () => {
      await this.indexProviderSession(targetId, adapter);
      return await adapter.resumeInTerminal!(targetId);
    });
  }

  async close(): Promise<void> {
    await Promise.all([...this.adapters.values()].map((adapter) => adapter.close?.() ?? Promise.resolve()));
  }
}

export const createExternalSessionRegistry = (options: ExternalSessionRegistryOptions): ExternalSessionService => (
  new ExternalSessionRegistry(options)
);
