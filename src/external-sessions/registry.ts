import { randomBytes } from "node:crypto";
import { CodexAppServerAdapter } from "./codex.js";
import { ClaudeAgentSdkAdapter } from "./claude.js";
import { ExternalSessionOwnershipStore, externalSessionIdentityKey } from "./identity.js";
import type { ExternalCommandOptions } from "./process.js";
import {
  ExternalSessionInputError,
  type ExternalSessionAdapter,
  type ExternalSessionForkResult,
  type ExternalSessionListInput,
  type ExternalSessionListResult,
  type ExternalSessionReadResult,
  type ExternalSessionService,
  type ExternalSessionSourceInfo,
  type ExternalSessionSourceId,
  type ExternalTurnResult,
  type ExternalTurnSink,
} from "./types.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const CURSOR_TTL_MS = 10 * 60 * 1_000;
const SOURCE_ORDER: ExternalSessionSourceId[] = ["codex", "claude"];

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
  codex?: Partial<ExternalCommandOptions>;
  claude?: Partial<ExternalCommandOptions>;
}

export class ExternalSessionRegistry implements ExternalSessionService {
  private readonly adapters: Map<ExternalSessionSourceId, ExternalSessionAdapter>;
  private readonly cursors = new Map<string, CursorRecord>();

  constructor(options: ExternalSessionRegistryOptions) {
    const adapters = options.adapters ?? (() => {
      const identityKey = options.identityKey ?? externalSessionIdentityKey(options.identityHome);
      const ownership = new ExternalSessionOwnershipStore(options.identityHome);
      return [
        new CodexAppServerAdapter({
          command: options.codex?.command ?? "codex",
          argsPrefix: options.codex?.argsPrefix,
          spawnProcess: options.codex?.spawnProcess,
          timeoutMs: options.codex?.timeoutMs,
          env: options.codex?.env,
          haraVersion: options.haraVersion,
          identityKey,
          ownership,
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
    const page = await adapter.list({
      limit,
      ...(providerCursor ? { cursor: providerCursor } : {}),
      ...(search ? { search } : {}),
    });
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

  private adapterForSession(sessionId: string): ExternalSessionAdapter {
    if (typeof sessionId !== "string" || !/^ext_(?:codex|claude)_[a-f0-9]{24}$/.test(sessionId)) {
      throw new ExternalSessionInputError("external session id is invalid");
    }
    const sourceId: ExternalSessionSourceId = sessionId.startsWith("ext_codex_") ? "codex" : "claude";
    const adapter = this.adapters.get(sourceId);
    if (!adapter) throw new ExternalSessionInputError("external session source is unavailable");
    return adapter;
  }

  async readSession(sessionId: string): Promise<ExternalSessionReadResult> {
    const adapter = this.adapterForSession(sessionId);
    if (!adapter.read) throw new ExternalSessionInputError("external session source does not support reading");
    return await adapter.read(sessionId);
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
    return await adapter.submit(sessionId, text, sink);
  }

  async interrupt(sessionId: string): Promise<void> {
    const adapter = this.adapterForSession(sessionId);
    await adapter.interrupt?.(sessionId);
  }

  async close(): Promise<void> {
    await Promise.all([...this.adapters.values()].map((adapter) => adapter.close?.() ?? Promise.resolve()));
  }
}

export const createExternalSessionRegistry = (options: ExternalSessionRegistryOptions): ExternalSessionService => (
  new ExternalSessionRegistry(options)
);
