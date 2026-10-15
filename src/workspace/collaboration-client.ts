import { loadMobileState, type MobileCompanionState } from "../mobile/state.js";
import { createHmac, randomBytes } from "node:crypto";

// This is a hosted collaboration client, not an execution grant or a replacement for local spaces.
export const WORKSPACE_COLLABORATION_FEATURE = "workspace.collaboration.v1";
export const WORKSPACE_HISTORY_FEATURE = "workspace.collaboration.history.v1";
export const WORKSPACE_HISTORY_METHOD = "workspace.collaboration.history";
export const WORKSPACE_MEMBERS_FEATURE = "workspace.collaboration.members.v1";
export const WORKSPACE_MEMBERS_METHOD = "workspace.collaboration.members";
export const WORKSPACE_MENTIONS_FEATURE = "workspace.collaboration.mentions.v1";
export const WORKSPACE_MENTIONS_METHOD = "workspace.collaboration.send-with-mentions";
export const WORKSPACE_COLLABORATION_METHODS = [
  "workspace.collaboration.list", "workspace.collaboration.bootstrap",
  "workspace.collaboration.sync", "workspace.collaboration.send", "workspace.collaboration.create-channel",
] as const;
export type CollaborationErrorCode = "AUTH_REQUIRED" | "SCOPE_CHANGED" | "ACCESS_CHANGED"
  | "PROJECTION_PENDING" | "DIRECTORY_STALE" | "HISTORY_STALE" | "MEMBERS_STALE" | "MENTION_TARGET_UNAVAILABLE" | "INVALID_INPUT" | "UNAVAILABLE" | "OUTCOME_UNKNOWN";
export type CollaborationResult<T> = { ok: true; value: T } | { ok: false; error: { code: CollaborationErrorCode } };
export interface CollaborationDirectory {
  schemaVersion: 1;
  /** Opaque process/session boundary, not an Account credential. Required on every selected-scope RPC. */
  accountScope: string;
  accountRegion: "CN" | "GLOBAL";
  workspaces: { workspaceId: string; membership: { role: "OWNER" | "ADMIN" | "MEMBER"; membershipVersion: number; policyVersion: number } }[];
  nextCursor: string | null;
}
export interface CollaborationChannel { id: string; slug: string; displayName: string }
/** Account-authoritative human identity only. This is neither an Agent registry nor an execution grant. */
export interface CollaborationMember { principalId: string; kind: "human"; displayName: string; role: "OWNER" | "ADMIN" | "MEMBER" }
export interface CollaborationMembers { workspaceId: string; members: CollaborationMember[]; nextCursor: string | null }
export interface CollaborationMention { kind: "human"; principalId: string }
export interface CollaborationBootstrap {
  workspaceId: string;
  displayName: string;
  cursor: string;
  membership: { principalId: string; role: "OWNER" | "ADMIN" | "MEMBER"; epoch: number };
  channels: CollaborationChannel[];
}
export interface CollaborationMessage { id: string; channelId: string; senderPrincipalId: string; body: string; createdAt: string; sequence?: string; mentions?: CollaborationMention[] }
export interface CollaborationHistory { workspaceId: string; channelId: string; messages: CollaborationMessage[]; nextBefore: string | null }
export interface CollaborationSync {
  workspaceId: string; cursor: string; hasMore: boolean;
  events: { id: string; type: string; message: CollaborationMessage | null; channel?: CollaborationChannel | null }[];
}
export interface CollaborationSent { workspaceId: string; messageId: string; channelId: string; senderPrincipalId: string; createdAt: string; sequence?: string; mentions?: CollaborationMention[] }
export interface CollaborationCreated { workspaceId: string; channel: CollaborationChannel }

class Failure extends Error {
  constructor(readonly code: CollaborationErrorCode) { super(code); }
}
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Failure("UNAVAILABLE");
  return value as Record<string, unknown>;
};
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const workspace = (value: unknown): value is string => typeof value === "string" && value.startsWith("ws_") && uuid(value.slice(3));
const role = (value: unknown): value is "OWNER" | "ADMIN" | "MEMBER" => value === "OWNER" || value === "ADMIN" || value === "MEMBER";
const version = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1;
const timestamp = (value: unknown): value is string => text(value, 40) && Number.isFinite(Date.parse(value));
const publicIdentity = (value: unknown, max: number): value is string => text(value, max) && value.trim() === value
  && !/[\u0000-\u001f\u007f]/.test(value) && !/[^\s@]+@[^\s@]+\.[^\s@]+/u.test(value);
const sequence = (value: unknown): value is string => typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;
const input = (condition: unknown): void => { if (!condition) throw new Failure("INVALID_INPUT"); };
const valid = (condition: unknown): void => { if (!condition) throw new Failure("UNAVAILABLE"); };
function mentions(value: unknown, strict = false): CollaborationMention[] {
  valid(Array.isArray(value) && value.length <= 10);
  const items = (value as unknown[]).map(value => {
    const item = record(value);
    valid(item.kind === "human" && publicIdentity(item.principalId, 128)
      && (!strict || (Object.keys(item).length === 2 && Object.keys(item).every(key => key === "kind" || key === "principalId"))));
    return { kind: "human" as const, principalId: item.principalId as string };
  });
  valid(new Set(items.map(item => item.principalId)).size === items.length);
  return items.sort((a, b) => a.principalId < b.principalId ? -1 : a.principalId > b.principalId ? 1 : 0);
}
function channel(value: unknown): CollaborationChannel {
  const item = record(value);
  valid(uuid(item.id) && item.kind === "TEXT" && text(item.slug, 80) && text(item.displayName, 160));
  return { id: item.id as string, slug: item.slug as string, displayName: item.displayName as string };
}
function message(value: unknown): CollaborationMessage {
  const item = record(value);
  valid(uuid(item.id) && uuid(item.channelId) && text(item.senderPrincipalId, 128)
    && text(item.body, 8192) && Buffer.byteLength(item.body as string, "utf8") <= 8192 && timestamp(item.createdAt)
    && (item.sequence === undefined || sequence(item.sequence)));
  return { id: item.id as string, channelId: item.channelId as string, senderPrincipalId: item.senderPrincipalId as string,
    body: item.body as string, createdAt: item.createdAt as string, ...(item.sequence === undefined ? {} : { sequence: item.sequence as string }),
    ...(item.mentions === undefined ? {} : { mentions: mentions(item.mentions) }) };
}
function origin(value: string, insecureLoopback = false): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/"
    || (url.protocol !== "https:" && !(insecureLoopback && url.protocol === "http:"
      && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) throw new Failure("UNAVAILABLE");
  return url.origin;
}
async function errorCode(response: Response): Promise<string | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 4096) { await reader.cancel(); return undefined; }
      chunks.push(part.value);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const code: unknown = body?.error?.code ?? body?.code;
    return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(code) ? code : undefined;
  } catch { return undefined; }
  finally { reader.releaseLock(); }
}

interface Options {
  collabOrigin: string;
  // Account origin override and insecure HTTP are test-only injections, never RPC parameters.
  accountOrigin?: string;
  allowInsecureLoopback?: boolean;
  fetcher?: typeof fetch;
  loadState?: () => MobileCompanionState | null;
  now?: () => number;
  timeoutMs?: number;
}

/** Tokens remain in Core. Every Collab operation obtains a fresh assertion from Account; no inferred
 * enrollment, token fallback, automatic POST retry, credential writes or model call occurs here. */
export class WorkspaceCollaborationClient {
  private readonly accountOrigin: string;
  private readonly collabOrigin: string;
  private readonly fetcher: typeof fetch;
  private readonly loadState: () => MobileCompanionState | null;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly scopeKey = randomBytes(32);
  constructor(options: Options) {
    this.accountOrigin = origin(options.accountOrigin ?? "https://api.hara.nanhara.tech", options.allowInsecureLoopback);
    this.collabOrigin = origin(options.collabOrigin, options.allowInsecureLoopback);
    this.fetcher = options.fetcher ?? fetch;
    this.loadState = options.loadState ?? (() => loadMobileState());
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 8000;
  }
  private scope(state: MobileCompanionState): string {
    return createHmac("sha256", this.scopeKey).update(JSON.stringify([
      state.account.id, state.account.region, state.desktop.id, state.accessToken,
    ])).digest("hex");
  }
  private state(expectedScope?: unknown): MobileCompanionState {
    const state = this.loadState();
    if (!state || state.accessTokenExpiresAt <= this.now() + 1000) throw new Failure("AUTH_REQUIRED");
    if (expectedScope !== undefined && expectedScope !== this.scope(state)) throw new Failure("SCOPE_CHANGED");
    return state;
  }
  private unchanged(initial: MobileCompanionState): void {
    const current = this.loadState();
    if (!current || current.account.id !== initial.account.id || current.account.region !== initial.account.region
      || current.desktop.id !== initial.desktop.id || current.accessToken !== initial.accessToken
      || current.accessTokenExpiresAt <= this.now()) throw new Failure("SCOPE_CHANGED");
  }
  private async result<T>(operation: () => Promise<T>): Promise<CollaborationResult<T>> {
    try { return { ok: true, value: await operation() }; }
    catch (error) { return { ok: false, error: { code: error instanceof Failure ? error.code : "UNAVAILABLE" } }; }
  }
  private async request(base: string, path: string, token: string, initial: MobileCompanionState,
    body?: unknown, key?: string): Promise<unknown> {
    this.unchanged(initial);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const mutation = key !== undefined;
    try {
      const response = await this.fetcher(base + path, {
        method: body === undefined ? "GET" : "POST", redirect: "error", signal: controller.signal,
        headers: { Accept: "application/json", "Cache-Control": "no-store", Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(key ? { "Idempotency-Key": key } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!response.ok) {
        // Do not reflect upstream error text, HTML, request IDs, tokens, or message bodies.
        const code = await errorCode(response);
        if (response.status === 401) throw new Failure("AUTH_REQUIRED");
        if (base === this.collabOrigin && path.endsWith("/messages/with-mentions")
          && response.status === 400 && code === "MENTION_TARGET_UNAVAILABLE") throw new Failure("MENTION_TARGET_UNAVAILABLE");
        if (base === this.collabOrigin && path.endsWith("/messages/with-mentions")
          && response.status === 404 && code !== "CHANNEL_NOT_FOUND") throw new Failure("OUTCOME_UNKNOWN");
        if (base === this.accountOrigin && path.startsWith("/v1/workspaces?")) {
          if ([400, 409].includes(response.status)) throw new Failure("DIRECTORY_STALE");
          if (response.status === 404 || response.status >= 500) throw new Failure("UNAVAILABLE");
        }
        if (base === this.accountOrigin && path.includes("/members?")) {
          if ((response.status === 400 && code === "WORKSPACE_MEMBERS_CURSOR_INVALID")
            || (response.status === 409 && code === "WORKSPACE_MEMBERS_CURSOR_STALE")) throw new Failure("MEMBERS_STALE");
          if (response.status === 404 || response.status >= 500) throw new Failure("UNAVAILABLE");
        }
        if (base === this.collabOrigin && body === undefined && path.includes("/channels/") && path.includes("/messages?")) {
          if ((response.status === 400 && code === "HISTORY_CURSOR_INVALID") || (response.status === 409 && code === "HISTORY_CURSOR_STALE")) throw new Failure("HISTORY_STALE");
          if (response.status === 404) throw new Failure("UNAVAILABLE");
        }
        if ([403, 404, 409].includes(response.status)) throw new Failure("ACCESS_CHANGED");
        if (response.status === 400) throw new Failure("INVALID_INPUT");
        if (response.status === 503 && !mutation && base === this.collabOrigin && code === "AUTH_PROJECTION_LAG") throw new Failure("PROJECTION_PENDING");
        throw new Failure(mutation ? "OUTCOME_UNKNOWN" : "UNAVAILABLE");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Failure(mutation ? "OUTCOME_UNKNOWN" : "UNAVAILABLE");
      const chunks: Uint8Array[] = []; let bytes = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          // 100 legal 8 KiB messages can expand 6x under JSON escaping. Keep a hard streaming cap
          // above that contract ceiling, not one that permanently rejects a valid cursor page.
          if (bytes > 6 * 1024 * 1024) { await reader.cancel(); throw new Failure(mutation ? "OUTCOME_UNKNOWN" : "UNAVAILABLE"); }
          chunks.push(part.value);
        }
      } finally { reader.releaseLock(); }
      this.unchanged(initial);
      try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { throw new Failure(mutation ? "OUTCOME_UNKNOWN" : "UNAVAILABLE"); }
    } catch (error) {
      // A failed/aborted response belongs to its original sign-in too. Account drift must
      // outrank a retryable read error, otherwise Desktop can retain the old account's text.
      this.unchanged(initial);
      if (error instanceof Failure) throw error;
      throw new Failure(mutation ? "OUTCOME_UNKNOWN" : "UNAVAILABLE");
    } finally { clearTimeout(timer); }
  }
  private async context(workspaceId: string, initial: MobileCompanionState): Promise<string> {
    input(workspace(workspaceId));
    const response = record(await this.request(this.accountOrigin, `/v1/workspaces/${workspaceId}/context`, initial.accessToken, initial, {}));
    valid(response.workspaceId === workspaceId && response.tokenType === "Bearer" && text(response.token, 16384)
      && Number.isInteger(response.expiresInSeconds) && (response.expiresInSeconds as number) > 0 && (response.expiresInSeconds as number) <= 600);
    return response.token as string;
  }
  private async scoped(workspaceId: string, path: string, initial: MobileCompanionState, body?: unknown, key?: string) {
    const token = await this.context(workspaceId, initial);
    try {
      const response = record(await this.request(this.collabOrigin, `/v1/workspaces/${workspaceId}/${path}`, token, initial, body, key));
      valid(response.schemaVersion === 1 && response.workspaceId === workspaceId);
      return record(response.data);
    } catch (error) {
      // A malformed successful mutation cannot be called safely failed: retain its idempotency identity.
      if (key && error instanceof Failure && error.code === "UNAVAILABLE") throw new Failure("OUTCOME_UNKNOWN");
      throw error;
    }
  }
  list(params: Record<string, unknown> = {}): Promise<CollaborationResult<CollaborationDirectory>> {
    return this.result(async () => {
      input(Object.keys(params).every(key => key === "cursor") && (params.cursor === undefined || text(params.cursor, 4096)));
      const initial = this.state();
      const response = record(await this.request(this.accountOrigin, `/v1/workspaces?limit=50${params.cursor ? `&cursor=${encodeURIComponent(params.cursor as string)}` : ""}`, initial.accessToken, initial));
      valid(response.schemaVersion === 1 && response.accountRegion === (initial.account.region === "cn" ? "CN" : "GLOBAL")
        && Array.isArray(response.workspaces) && response.workspaces.length <= 50 && (response.nextCursor === null || text(response.nextCursor, 4096)));
      const workspaces = (response.workspaces as unknown[]).map(value => {
        const item = record(value), membership = record(item.membership);
        valid(workspace(item.workspaceId) && role(membership.role) && version(membership.membershipVersion) && version(membership.policyVersion));
        return { workspaceId: item.workspaceId as string, membership: { role: membership.role as "OWNER" | "ADMIN" | "MEMBER",
          membershipVersion: membership.membershipVersion as number, policyVersion: membership.policyVersion as number } };
      });
      valid(new Set(workspaces.map(item => item.workspaceId)).size === workspaces.length);
      return { schemaVersion: 1, accountScope: this.scope(initial), accountRegion: response.accountRegion as "CN" | "GLOBAL", workspaces, nextCursor: response.nextCursor as string | null };
    });
  }
  bootstrap(params: Record<string, unknown>): Promise<CollaborationResult<CollaborationBootstrap>> {
    return this.result(async () => {
      input(Object.keys(params).length === 2 && workspace(params.workspaceId) && text(params.accountScope, 64));
      const workspaceId = params.workspaceId as string, initial = this.state(params.accountScope);
      const data = await this.scoped(workspaceId, "bootstrap", initial), membership = record(data.membership);
      valid(text(data.cursor, 4096) && text(membership.principalId, 128) && role(membership.role) && version(membership.epoch)
        && Array.isArray(data.channels) && data.channels.length <= 1000);
      const channels = (data.channels as unknown[]).map(channel);
      valid(new Set(channels.map(item => item.id)).size === channels.length);
      return { workspaceId, displayName: text(data.displayName, 160) ? data.displayName : workspaceId,
        cursor: data.cursor as string, membership: { principalId: membership.principalId as string,
          role: membership.role as "OWNER" | "ADMIN" | "MEMBER", epoch: membership.epoch as number }, channels };
    });
  }
  members(params: Record<string, unknown>): Promise<CollaborationResult<CollaborationMembers>> {
    return this.result(async () => {
      input(Object.keys(params).every(key => ["workspaceId", "accountScope", "cursor"].includes(key))
        && workspace(params.workspaceId) && text(params.accountScope, 64)
        && (params.cursor === undefined || text(params.cursor, 4096)));
      const workspaceId = params.workspaceId as string, initial = this.state(params.accountScope);
      const path = `/v1/workspaces/${workspaceId}/members?limit=50`
        + (params.cursor === undefined ? "" : "&cursor=" + encodeURIComponent(params.cursor as string));
      const response = record(await this.request(this.accountOrigin, path, initial.accessToken, initial));
      valid(response.schemaVersion === 1 && response.workspaceId === workspaceId
        && response.accountRegion === (initial.account.region === "cn" ? "CN" : "GLOBAL")
        && Array.isArray(response.members) && response.members.length <= 50
        && (response.nextCursor === null || text(response.nextCursor, 4096)) && response.nextCursor !== params.cursor);
      const members = (response.members as unknown[]).map(value => {
        const item = record(value);
        valid(publicIdentity(item.principalId, 128) && item.kind === "human"
          && publicIdentity(item.displayName, 120) && role(item.role));
        return { principalId: item.principalId as string, kind: "human" as const, displayName: item.displayName as string,
          role: item.role as "OWNER" | "ADMIN" | "MEMBER" };
      });
      valid(new Set(members.map(item => item.principalId)).size === members.length && (members.length > 0 || response.nextCursor === null));
      return { workspaceId, members, nextCursor: response.nextCursor as string | null };
    });
  }
  sync(params: Record<string, unknown>): Promise<CollaborationResult<CollaborationSync>> {
    return this.result(async () => {
      input(Object.keys(params).every(key => ["workspaceId", "cursor", "accountScope"].includes(key)) && workspace(params.workspaceId) && text(params.cursor, 4096) && text(params.accountScope, 64));
      const workspaceId = params.workspaceId as string;
      const data = await this.scoped(workspaceId, `sync?limit=100&cursor=${encodeURIComponent(params.cursor as string)}`, this.state(params.accountScope));
      valid(text(data.cursor, 4096) && typeof data.hasMore === "boolean" && Array.isArray(data.events) && data.events.length <= 100);
      const events = (data.events as unknown[]).map(value => { const event = record(value);
        valid(text(event.id, 160) && text(event.type, 80));
        valid(event.realmSeq === undefined || sequence(event.realmSeq));
        const payload = event.type === "channel.created" ? record(event.payload) : null;
        return { id: event.id as string, type: event.type as string,
          message: event.message === null ? null : message({ ...record(event.message), ...(event.realmSeq === undefined ? {} : { sequence: event.realmSeq }) }),
          channel: payload ? channel({ id: payload.channelId, kind: payload.kind, slug: payload.slug, displayName: payload.displayName }) : null };
      });
      return { workspaceId, cursor: data.cursor as string, hasMore: data.hasMore as boolean, events };
    });
  }
  send(params: Record<string, unknown>): Promise<CollaborationResult<CollaborationSent>> {
    return this.result(async () => {
      input(Object.keys(params).length === 5 && Object.keys(params).every(key => ["workspaceId", "channelId", "body", "idempotencyKey", "accountScope"].includes(key)) && text(params.accountScope, 64)
        && workspace(params.workspaceId) && uuid(params.channelId) && text(params.body, 8192) && (params.body as string).trim()
        && Buffer.byteLength(params.body as string, "utf8") <= 8192 && text(params.idempotencyKey, 128) && /^[A-Za-z0-9_-]+$/.test(params.idempotencyKey as string));
      const workspaceId = params.workspaceId as string;
      const data = await this.scoped(workspaceId, `channels/${params.channelId}/messages`, this.state(params.accountScope), { body: params.body }, params.idempotencyKey as string);
      if (!uuid(data.messageId) || data.channelId !== params.channelId || !text(data.senderPrincipalId, 128) || !timestamp(data.createdAt)
        || (data.realmSeq !== undefined && !sequence(data.realmSeq))) throw new Failure("OUTCOME_UNKNOWN");
      return { workspaceId, messageId: data.messageId, channelId: data.channelId as string,
        senderPrincipalId: data.senderPrincipalId, createdAt: data.createdAt, ...(data.realmSeq === undefined ? {} : { sequence: data.realmSeq as string }) };
    });
  }
  createChannel(params: Record<string, unknown>): Promise<CollaborationResult<CollaborationCreated>> {
    return this.result(async () => {
      input(Object.keys(params).length === 5 && Object.keys(params).every(key => ["workspaceId", "slug", "displayName", "idempotencyKey", "accountScope"].includes(key)) && text(params.accountScope, 64)
        && workspace(params.workspaceId) && text(params.slug, 80) && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(params.slug as string)
        && text(params.displayName, 160) && (params.displayName as string).trim() && text(params.idempotencyKey, 128) && /^[A-Za-z0-9_-]+$/.test(params.idempotencyKey as string));
      const workspaceId = params.workspaceId as string;
      const data = await this.scoped(workspaceId, "channels", this.state(params.accountScope), { slug: params.slug, displayName: params.displayName }, params.idempotencyKey as string);
      if (!uuid(data.channelId) || data.slug !== params.slug || data.displayName !== params.displayName) throw new Failure("OUTCOME_UNKNOWN");
      return { workspaceId, channel: { id: data.channelId, slug: data.slug as string, displayName: data.displayName as string } };
    });
  }
  sendWithMentions(params: Record<string, unknown>): Promise<CollaborationResult<CollaborationSent>> {
    return this.result(async () => {
      input(Object.keys(params).length === 6 && Object.keys(params).every(key => ["workspaceId", "channelId", "body", "idempotencyKey", "accountScope", "mentions"].includes(key))
        && text(params.accountScope, 64) && workspace(params.workspaceId) && uuid(params.channelId)
        && text(params.body, 8192) && (params.body as string).trim() && Buffer.byteLength(params.body as string, "utf8") <= 8192
        && text(params.idempotencyKey, 128) && /^[A-Za-z0-9_-]+$/.test(params.idempotencyKey as string)
        && Array.isArray(params.mentions) && params.mentions.length > 0);
      let targets: CollaborationMention[];
      try { targets = mentions(params.mentions, true); } catch { throw new Failure("INVALID_INPUT"); }
      const workspaceId = params.workspaceId as string;
      const data = await this.scoped(workspaceId, `channels/${params.channelId}/messages/with-mentions`, this.state(params.accountScope),
        { body: params.body, mentions: targets }, params.idempotencyKey as string);
      let confirmed: CollaborationMention[];
      try { confirmed = mentions(data.mentions); } catch { throw new Failure("OUTCOME_UNKNOWN"); }
      if (!uuid(data.messageId) || data.channelId !== params.channelId || !text(data.senderPrincipalId, 128) || !timestamp(data.createdAt)
        || (data.realmSeq !== undefined && !sequence(data.realmSeq)) || JSON.stringify(confirmed) !== JSON.stringify(targets)) throw new Failure("OUTCOME_UNKNOWN");
      return { workspaceId, messageId: data.messageId, channelId: data.channelId as string, senderPrincipalId: data.senderPrincipalId,
        createdAt: data.createdAt, mentions: confirmed, ...(data.realmSeq === undefined ? {} : { sequence: data.realmSeq as string }) };
    });
  }
  history(params: Record<string, unknown>): Promise<CollaborationResult<CollaborationHistory>> {
    return this.result(async () => {
      input(Object.keys(params).every(key => ["workspaceId", "channelId", "accountScope", "before"].includes(key))
        && workspace(params.workspaceId) && uuid(params.channelId) && text(params.accountScope, 64)
        && (params.before === undefined || text(params.before, 4096)));
      const workspaceId = params.workspaceId as string;
      const path = "channels/" + params.channelId + "/messages?limit=50"
        + (params.before === undefined ? "" : "&before=" + encodeURIComponent(params.before as string));
      const data = await this.scoped(workspaceId, path, this.state(params.accountScope));
      valid(data.channelId === params.channelId && Array.isArray(data.messages) && data.messages.length <= 50
        && (data.nextBefore === null || text(data.nextBefore, 4096)) && data.nextBefore !== params.before);
      const messages = (data.messages as unknown[]).map(message);
      valid(messages.every((item, index) => item.channelId === params.channelId && sequence(item.sequence)
        && (index === 0 || BigInt(item.sequence!) > BigInt(messages[index - 1].sequence!)))
        && new Set(messages.map(item => item.id)).size === messages.length
        && (messages.length > 0 || data.nextBefore === null));
      return { workspaceId, channelId: params.channelId as string, messages, nextBefore: data.nextBefore as string | null };
    });
  }
}

/** Default-off. A malformed/partial host configuration cannot break pure-local startup or leak credentials. */
export function configuredWorkspaceCollaboration(env: NodeJS.ProcessEnv = process.env): WorkspaceCollaborationClient | undefined {
  if (env.HARA_WORKSPACE_COLLAB_ENABLED !== "1" || !env.HARA_WORKSPACE_COLLAB_ORIGIN) return undefined;
  try { return new WorkspaceCollaborationClient({ collabOrigin: env.HARA_WORKSPACE_COLLAB_ORIGIN }); }
  catch { return undefined; }
}
