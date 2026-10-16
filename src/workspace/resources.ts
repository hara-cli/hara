// Host-private, explicitly bound adapters for the existing stores. No new RPC, UI capability,
// enrollment, automatic migration, provider call, or permission grant is introduced here.
import * as sessions from "../session/store.js";
import * as memory from "../memory/store.js";
import * as profiles from "../profile/profile.js";
import type { SessionStore } from "../serve/sessions.js";
import { searchHybrid } from "../search/hybrid.js";
import { sanitizeMemoryForPrompt } from "../memory/guard.js";
import {
  currentWorkspaceResourceBinding, sameWorkspaceResourceBinding, WorkspaceResourceStorage,
  type WorkspaceResourceScope,
} from "./resource-context.js";

type DirectConnection = Pick<profiles.Profile, "id" | "label" | "provider" | "apiKey" | "baseURL" | "model">;
const CURSOR_PREFIX = "hara-workspace-session-v1:";
const DIRECT_PROVIDERS = new Set(["anthropic", "token-plan", "minimax-token-plan", "volcengine-agent-plan",
  "volcengine-coding-plan", "qwen", "qwen-oauth", "openai", "glm", "deepseek", "openrouter", "ollama", "lmstudio"]);
function optionalText(value: unknown, max: number): boolean {
  return value === undefined || (typeof value === "string" && value.length > 0 && value.length <= max
    && !/[\u0000-\u001f\u007f-\u009f]/.test(value));
}

/** The caller is the trusted host composition layer, not an Agent or renderer. It must verify current
 * membership/audience before using a hosted scope; this storage facade cannot establish that authority.
 * A separate instance stays bound to its original scope while other instances run concurrently. */
export class WorkspaceResources {
  private readonly storage: WorkspaceResourceStorage;
  readonly sessions: SessionStore & {
    exists(id: string): boolean;
    ensureIndex(): Promise<void>;
  };
  readonly connections;
  readonly memory;

  constructor(hostHome: string, scope: WorkspaceResourceScope) {
    this.storage = new WorkspaceResourceStorage(hostHome, scope);
    const bind = <A extends unknown[], R>(fn: (...args: A) => R) => (...args: A): R => this.storage.run(() => fn(...args));
    const bindAsync = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) => async (...args: A): Promise<R> => this.storage.run(() => fn(...args));
    this.sessions = Object.freeze({
      load: bind(sessions.loadSession), save: bind(sessions.saveSession), list: bind(sessions.listSessions),
      listPage: bind((options: sessions.SessionMetadataPageOptions = {}) => {
        const binding = currentWorkspaceResourceBinding()!;
        let cursor: string | undefined;
        if (options.cursor !== undefined) {
          try {
            if (typeof options.cursor !== "string" || !options.cursor.startsWith(CURSOR_PREFIX)
              || options.cursor.length > 16_384) throw new Error();
            const parsed = JSON.parse(Buffer.from(options.cursor.slice(CURSOR_PREFIX.length), "base64url").toString("utf8"));
            if (!parsed || Object.keys(parsed).length !== 2 || !sameWorkspaceResourceBinding(parsed.binding, binding)
              || typeof parsed.cursor !== "string" || !parsed.cursor || parsed.cursor.length > 8192) throw new Error();
            cursor = parsed.cursor;
          } catch { throw new Error("session cursor does not belong to this Workspace resource scope"); }
        }
        const page = sessions.listSessionMetadataPage({ ...options, cursor });
        return { ...page, ...(page.nextCursor ? { nextCursor: CURSOR_PREFIX
          + Buffer.from(JSON.stringify({ binding, cursor: page.nextCursor })).toString("base64url") } : {}) };
      }),
      recordTaskState: bind(sessions.recordSessionTaskState), recordProviderRetry: bind(sessions.recordSessionProviderRetry),
      recordRuntimeItem: bind(sessions.recordSessionRuntimeItem), recordCompactionState: bind(sessions.recordSessionCompactionState),
      recordApprovalState: bind(sessions.recordSessionApprovalState), readJournal: bind(sessions.readSessionJournal),
      acquire: bind(sessions.acquireSessionLock), release: bind(sessions.releaseSessionLock), delete: bind(sessions.deleteSession),
      exists: bind(sessions.sessionFileExists), ensureIndex: bindAsync(sessions.ensureSessionMetadataIndex),
    });
    this.connections = Object.freeze({
      // These results may contain secrets and are HOST-PRIVATE. Renderers continue to use redacted DTOs.
      list: bind(profiles.listProfiles), get: bind(profiles.getProfile),
      addDirect: bind((input: DirectConnection, options: { activate?: boolean } = {}) => {
        if (!input || typeof input !== "object" || Array.isArray(input)
          || !Object.keys(input).every(key => ["id", "label", "provider", "apiKey", "baseURL", "model"].includes(key))
          || input.id === "personal" || typeof input.apiKey !== "string" || !input.apiKey.trim() || input.apiKey.length > 16_384
          || /[\u0000-\u0020\u007f-\u009f]/.test(input.apiKey) || !DIRECT_PROVIDERS.has(input.provider ?? "")
          || !optionalText(input.label, 80) || !optionalText(input.model, 256) || !optionalText(input.baseURL, 4096)) {
          throw new Error("a direct Workspace connection requires an independently supplied key and non-reserved id");
        }
        return profiles.addProfile({ ...input, kind: "byok" }, options);
      }),
      select: bind(profiles.useProfile), remove: bind(profiles.removeProfile), setModel: bind(profiles.setModel),
    });
    this.memory = Object.freeze({
      roots: bind(memory.memoryRoots), digest: bind(memory.memoryDigest), append: bindAsync(memory.appendMemory),
      appendOnce: bindAsync(memory.appendMemoryOnce), replace: bindAsync(memory.replaceMemory), forget: bindAsync(memory.forgetMemory),
      recentLogs: bind(memory.readRecentLogs), scaffold: bindAsync(memory.scaffoldMemory),
      search: bindAsync(async (query: string, cwd: string, limit: number = 5) => {
        if (typeof query !== "string" || !query.trim() || query.length > 512
          || !Number.isSafeInteger(limit) || limit < 1 || limit > 10) throw new Error("invalid Workspace memory search");
        const hits = await searchHybrid(query, cwd, { indexName: "memory", roots: memory.memoryRoots(cwd), limit });
        return hits.map(hit => ({ ...hit, title: sanitizeMemoryForPrompt(hit.title).text.trim() || "memory",
          snippet: sanitizeMemoryForPrompt(hit.snippet).text.trim() })).filter(hit => hit.snippet);
      }),
    });
  }

  get scope(): WorkspaceResourceScope { return this.storage.scope; }
  /** Deliberate private storage creation/reopen only. New scopes never adopt legacy state. */
  initialize(): void { this.storage.initialize(); }
}
