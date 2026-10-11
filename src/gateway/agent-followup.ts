// Shared, host-authored ownership for explicitly approved Feishu reply threads. This is not a listener,
// a model router or a tool grant. The existing gateway admits events; an opted-in Serve owns execution.
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import {
  bindPrivateHaraStateFile, readPrivateStateFileSnapshotSync, withPrivateStateLockSync, writePrivateStateFileSync,
} from "../security/private-state.js";
import { redactSensitiveText } from "../security/secrets.js";
import type { ChatAdapter, InboundMsg } from "./telegram.js";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const SCOPE = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const ID = /^[A-Za-z0-9_.:-]{1,256}$/u;
const HOUR = 3_600_000;
const MAX_BYTES = 4 * 1024 * 1024;

export interface FollowupOrigin {
  scope: string; chatId: string; senderId: string; rootMessageId: string; threadId?: string;
}
interface Candidate extends FollowupOrigin {
  id: string; messageId: string; senderName: string; observedAt: number;
}
export interface AgentFollowupGrant {
  id: string; origin: FollowupOrigin; sessionId: string; parentSessionId: string; agentRef: string;
  profileId: string; spaceId: "personal"; cwd: string; createdAt: number; expiresAt: number;
  maxMessages: number; accepted: number; lastAcceptedAt: number;
  status: "active" | "paused" | "revoked" | "closed";
}
export interface AgentFollowupEvent {
  id: string; grantId: string; scope: string; messageId: string; createdAt: number;
  text: string; status: "pending" | "running" | "complete" | "unknown" | "sending" | "delivered" | "delivery_unknown" | "suppressed";
  reply?: string; taskId?: string; turnId?: string; outcome?: "completed" | "paused" | "failed";
}
interface Store { version: 1; candidates: Candidate[]; grants: AgentFollowupGrant[]; events: AgentFollowupEvent[] }

function string(value: unknown, max = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
}
function matches(value: unknown, pattern: RegExp): value is string { return typeof value === "string" && pattern.test(value); }
function origin(value: unknown): value is FollowupOrigin {
  if (!value || typeof value !== "object") return false;
  const v = value as FollowupOrigin;
  return matches(v.scope, SCOPE) && string(v.chatId) && string(v.senderId) && matches(v.rootMessageId, ID)
    && (v.threadId === undefined || matches(v.threadId, ID));
}
function timestamp(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0; }
function parse(text: string): Store {
  const v = JSON.parse(text) as Store;
  if (!v || v.version !== 1 || !Array.isArray(v.candidates) || !Array.isArray(v.grants) || !Array.isArray(v.events)
    || v.candidates.length > 32 || v.grants.length > 64 || v.events.length > 512
    || !v.candidates.every((c) => origin(c) && matches(c.id, UUID) && matches(c.messageId, ID) && string(c.senderName, 120) && timestamp(c.observedAt))
    || !v.grants.every((g) => matches(g.id, UUID) && origin(g.origin) && string(g.sessionId) && string(g.parentSessionId)
      && string(g.agentRef, 180) && string(g.profileId, 128) && g.spaceId === "personal" && string(g.cwd, 4096) && isAbsolute(g.cwd)
      && timestamp(g.createdAt) && timestamp(g.expiresAt) && g.expiresAt > g.createdAt && g.expiresAt - g.createdAt <= 24 * HOUR
      && Number.isSafeInteger(g.maxMessages) && g.maxMessages >= 1 && g.maxMessages <= 8
      && Number.isSafeInteger(g.accepted) && g.accepted >= 0 && g.accepted <= g.maxMessages
      && Number.isSafeInteger(g.lastAcceptedAt) && g.lastAcceptedAt >= 0 && ["active", "paused", "revoked", "closed"].includes(g.status))
    || !v.events.every((e) => matches(e.id, UUID) && matches(e.grantId, UUID) && matches(e.scope, SCOPE) && matches(e.messageId, ID)
      && timestamp(e.createdAt) && typeof e.text === "string" && e.text.length <= 8000
      && ["pending", "running", "complete", "unknown", "sending", "delivered", "delivery_unknown", "suppressed"].includes(e.status)
      && (e.reply === undefined || (typeof e.reply === "string" && e.reply.length <= 3500))
      && (e.taskId === undefined || string(e.taskId)) && (e.turnId === undefined || string(e.turnId))
      && (e.outcome === undefined || ["completed", "paused", "failed"].includes(e.outcome)))) throw new Error("invalid Agent follow-up store");
  for (const rows of [v.candidates, v.grants, v.events]) if (new Set(rows.map((row) => row.id)).size !== rows.length) {
    throw new Error("duplicate Agent follow-up identity");
  }
  if (new Set(v.events.map((e) => `${e.scope}:${e.messageId}`)).size !== v.events.length
    || v.events.some((e) => !v.grants.some((g) => g.id === e.grantId && g.origin.scope === e.scope))) {
    throw new Error("invalid Agent follow-up ownership");
  }
  return v;
}

/** No executable authority is restored from this file. Serve must install a new live activation after a
 * human card; starting/running/unknown receipts are retained, never aged out to make space for retries. */
export class AgentFollowupStore {
  constructor(readonly home: string = homedir()) {}
  private transaction<T>(fn: (store: Store) => T): T {
    return withPrivateStateLockSync(this.home, ["gateway"], "agent-followups", () => {
      const target = bindPrivateHaraStateFile(this.home, ["gateway"], "agent-followups.json");
      const previous = readPrivateStateFileSnapshotSync(target.path, MAX_BYTES);
      const state: Store = previous ? parse(previous.text) : { version: 1, candidates: [], grants: [], events: [] };
      const result = fn(state);
      const next = JSON.stringify(state);
      if (Buffer.byteLength(next) > MAX_BYTES) throw new Error("Agent follow-up store is full");
      if (next !== previous?.text) writePrivateStateFileSync(target, next,
        previous ? { expectedText: previous.text } : { expectedMissing: true });
      return structuredClone(result);
    });
  }
  private admissible(scope: string, m: InboundMsg, allowed: boolean, now: number): boolean {
    return matches(scope, SCOPE) && allowed && m.chatType === "group" && m.senderType === "user"
      && string(m.chatId) && string(m.userId) && matches(m.messageId, ID)
      && timestamp(m.createdAtMs) && m.createdAtMs <= now + 60_000 && m.createdAtMs >= now - HOUR
      && m.replyContext?.valid !== false;
  }
  /** Metadata-only candidate: no group body is stored before the user's scoped confirmation. */
  observe(scope: string, m: InboundMsg, allowed: boolean, now = Date.now()): void {
    if (!this.admissible(scope, m, allowed, now) || !m.mentions?.some((mention) => mention.isSelf)) return;
    this.transaction((store) => {
      store.candidates = store.candidates.filter((c) => c.observedAt > now - HOUR);
      if (store.candidates.some((c) => c.scope === scope && c.messageId === m.messageId)) return;
      store.candidates.push({ id: randomUUID(), scope, chatId: String(m.chatId), senderId: String(m.userId),
        rootMessageId: m.replyContext?.rootMessageId ?? m.replyContext?.parentMessageId ?? m.messageId!,
        ...(m.replyContext?.threadId ? { threadId: m.replyContext.threadId } : {}), messageId: m.messageId!,
        senderName: redactSensitiveText(m.userName && m.userName !== String(m.userId) ? m.userName : "Authorized sender")
          .text.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 120) || "Authorized sender",
        observedAt: now });
      store.candidates = store.candidates.slice(-32);
    });
  }
  candidates(now = Date.now()): Array<{ id: string; chatId: string; senderName: string; observedAt: number;
    messageId: string; rootMessageId: string; threadId?: string }> {
    return this.transaction((s) => s.candidates.filter((c) => c.observedAt > now - HOUR)
      .map(({ id, chatId, senderName, observedAt, messageId, rootMessageId, threadId }) => ({
        id, chatId, senderName, observedAt, messageId, rootMessageId, ...(threadId ? { threadId } : {}),
      })));
  }
  grant(candidateId: string, input: Pick<AgentFollowupGrant, "sessionId" | "parentSessionId" | "agentRef" | "profileId" | "spaceId" | "cwd">,
    minutes: number, maxMessages: number, now = Date.now()): AgentFollowupGrant {
    if (!matches(candidateId, UUID) || !Number.isSafeInteger(minutes) || minutes < 1 || minutes > 1440
      || !Number.isSafeInteger(maxMessages) || maxMessages < 1 || maxMessages > 8 || input.spaceId !== "personal") {
      throw new Error("invalid scoped follow-up grant");
    }
    return this.transaction((s) => {
      const c = s.candidates.find((c) => c.id === candidateId && c.observedAt > now - HOUR);
      if (!c) throw new Error("follow-up source expired; observe a fresh authorized mention first");
      if (s.grants.length >= 64) throw new Error("follow-up grant store is full");
      if (s.grants.some((g) => g.status !== "revoked" && g.status !== "closed" && g.expiresAt > now
        && g.origin.scope === c.scope && g.origin.chatId === c.chatId && g.origin.senderId === c.senderId
        && (g.origin.rootMessageId === c.rootMessageId || (g.origin.threadId && g.origin.threadId === c.threadId)))) {
        throw new Error("this thread already has an owner; revoke it explicitly before transferring");
      }
      const g: AgentFollowupGrant = { id: randomUUID(), origin: { scope: c.scope, chatId: c.chatId, senderId: c.senderId,
        rootMessageId: c.rootMessageId, ...(c.threadId ? { threadId: c.threadId } : {}) }, ...input,
        createdAt: now, expiresAt: now + minutes * 60_000, maxMessages, accepted: 0, lastAcceptedAt: 0, status: "active" };
      // Validate host inputs before committing, using the same restore parser.
      parse(JSON.stringify({ ...s, grants: [...s.grants, g] }));
      s.grants.push(g); return g;
    });
  }
  list(parentSessionId: string): AgentFollowupGrant[] {
    return this.transaction((s) => s.grants.filter((g) => g.parentSessionId === parentSessionId));
  }
  revalidate(scope: string, allowed: (senderId: string) => boolean): void {
    this.transaction((s) => {
      s.candidates = s.candidates.filter((c) => c.scope !== scope || allowed(c.senderId));
      for (const g of s.grants) {
        if (g.origin.scope !== scope || allowed(g.origin.senderId) || ["revoked", "closed"].includes(g.status)) continue;
        if (g.status === "active") g.status = "paused";
        for (const e of s.events.filter((e) => e.grantId === g.id && ["pending", "complete"].includes(e.status))) {
          e.status = "suppressed"; e.text = ""; delete e.reply;
        }
      }
    });
  }
  get(id: string): AgentFollowupGrant | undefined { return this.transaction((s) => s.grants.find((g) => g.id === id)); }
  stop(id: string, parentSessionId: string, status: "paused" | "revoked" | "closed"): void {
    this.transaction((s) => {
      const g = s.grants.find((g) => g.id === id && g.parentSessionId === parentSessionId);
      if (!g) throw new Error("follow-up is not owned by this conversation");
      if (g.status === "revoked" || g.status === "closed") return;
      if (g.status === status) return;
      g.status = status;
      for (const e of s.events.filter((e) => e.grantId === id && ["pending", "complete"].includes(e.status))) {
        e.status = "suppressed"; e.text = ""; delete e.reply;
      }
    });
  }
  /** Resolve only authenticated reply ancestry. No body/name/recent-window heuristic or implicit fallback. */
  admit(scope: string, m: InboundMsg, allowed: boolean, now = Date.now()): "none" | "queued" | "duplicate" | "blocked" | "ambiguous" {
    if (!this.admissible(scope, m, allowed, now)) return "none";
    return this.transaction((s) => {
      if (s.events.some((e) => e.scope === scope && e.messageId === m.messageId)) return "duplicate";
      const r = m.replyContext;
      if (!r || (!r.parentMessageId && !r.rootMessageId && !r.threadId)) return "none";
      const historical = s.grants.filter((g) => g.origin.scope === scope && g.origin.chatId === String(m.chatId)
        && g.origin.senderId === String(m.userId) && (r.rootMessageId === g.origin.rootMessageId
          || r.parentMessageId === g.origin.rootMessageId
          || s.events.some((e) => e.grantId === g.id && e.messageId === r.parentMessageId)
          || (g.origin.threadId && r.threadId === g.origin.threadId)));
      if (!historical.length) return "none";
      const current = historical.filter((g) => !["revoked", "closed"].includes(g.status) && g.expiresAt > now);
      if (!current.length) return "blocked";
      const matches = current;
      if (matches.length !== 1) return "ambiguous";
      const g = matches[0]!;
      if ((r.rootMessageId && r.rootMessageId !== g.origin.rootMessageId)
        || (r.threadId && g.origin.threadId && r.threadId !== g.origin.threadId)) return "ambiguous";
      if (g.status !== "active" || g.expiresAt <= now || m.createdAtMs! < g.createdAt || g.accepted >= g.maxMessages
        || now - g.lastAcceptedAt < 30_000 || !m.text.trim() || m.text.length > 8000 || s.events.length >= 512
        || m.images?.length || m.files?.length || ["[图片]", "[附件]"].includes(m.text.trim())
        || s.events.some((e) => e.grantId === g.id && ["running", "unknown"].includes(e.status))) return "blocked";
      s.events.push({ id: randomUUID(), grantId: g.id, scope, messageId: m.messageId!, text: m.text,
        createdAt: now, status: "pending" });
      g.accepted++; g.lastAcceptedAt = now; return "queued";
    });
  }
  claim(grantId: string, now = Date.now()): AgentFollowupEvent | undefined {
    return this.transaction((s) => {
      const g = s.grants.find((g) => g.id === grantId);
      if (!g || g.status !== "active" || g.expiresAt <= now
        || s.events.some((e) => e.grantId === grantId && ["running", "unknown"].includes(e.status))) return;
      const e = s.events.find((e) => e.grantId === grantId && e.status === "pending");
      if (e) e.status = "running"; return e;
    });
  }
  finish(id: string, result: { reply: string; outcome: "completed" | "paused" | "failed"; taskId?: string; turnId?: string }, now = Date.now()): void {
    this.transaction((s) => {
      const e = s.events.find((e) => e.id === id);
      if (!e || e.status !== "running") throw new Error("follow-up execution receipt is not running");
      const g = s.grants.find((g) => g.id === e.grantId)!;
      e.text = "";
      if (g.status !== "active" || g.expiresAt <= now) { e.status = "suppressed"; return; }
      e.status = "complete"; e.outcome = result.outcome;
      e.reply = redactSensitiveText(result.reply).text.slice(0, 3500);
      if (result.taskId && string(result.taskId)) e.taskId = result.taskId;
      if (result.turnId && string(result.turnId)) e.turnId = result.turnId;
      // A paused/failed task needs a human, not another group's repeated "continue" loop.
      if (result.outcome !== "completed") g.status = "paused";
    });
  }
  /** One attempt per completed event. An outcome-unknown send is quarantined, not blindly retried. */
  nextDelivery(scope: string, now = Date.now()): { event: AgentFollowupEvent; grant: AgentFollowupGrant } | undefined {
    return this.transaction((s) => {
      const e = s.events.find((e) => e.scope === scope && e.status === "complete");
      if (!e) return;
      const g = s.grants.find((g) => g.id === e.grantId)!;
      if (g.status === "revoked" || g.status === "closed" || g.expiresAt <= now) { e.status = "suppressed"; delete e.reply; return; }
      e.status = "sending"; return { event: e, grant: g };
    });
  }
  delivered(id: string, success: boolean): void {
    this.transaction((s) => {
      const e = s.events.find((e) => e.id === id);
      if (!e || e.status !== "sending") throw new Error("follow-up delivery receipt is not sending");
      e.status = success ? "delivered" : "delivery_unknown";
      if (success) delete e.reply;
      const g = s.grants.find((g) => g.id === e.grantId)!;
      if (!success && g.status === "active") {
        g.status = "paused";
        for (const pending of s.events.filter((entry) => entry.grantId === g.id && entry.status === "pending")) {
          pending.status = "suppressed"; pending.text = "";
        }
      } else if (success && g.status === "active" && g.accepted === g.maxMessages
        && !s.events.some((entry) => entry.grantId === g.id && ["pending", "running", "complete", "sending"].includes(entry.status))) {
        g.status = "closed";
      }
    });
  }
  receipts(parentSessionId: string): Array<Omit<AgentFollowupEvent, "text" | "reply" | "scope" | "messageId">> {
    return this.transaction((s) => s.events.filter((e) => s.grants.some((g) => g.id === e.grantId && g.parentSessionId === parentSessionId))
      .map(({ text: _text, reply: _reply, scope: _scope, messageId: _message, ...rest }) => rest));
  }
}

/** Runs in the existing credential-bearing gateway's outbound lane, not in Serve or the model process. */
export async function processAgentFollowupDelivery(adapter: ChatAdapter, scope: string, signal: AbortSignal,
  store = new AgentFollowupStore()): Promise<boolean> {
  if (adapter.name !== "feishu" || !adapter.reply || signal.aborted) return false;
  const next = store.nextDelivery(scope);
  if (!next) return false;
  try {
    if (signal.aborted) throw new Error("follow-up delivery cancelled");
    const label = next.event.outcome === "completed" ? "本次处理结束" : "需要你在 Hara 中继续确认";
    await adapter.reply(next.grant.origin.chatId, next.event.messageId,
      `[Hara Agent · ${next.grant.agentRef}] ${label}\n${next.event.reply || "未取得可确认的结果；请查看 Hara 原对话。"}`.slice(0, 3500),
      signal, `agent-followup:${next.event.id}`);
    store.delivered(next.event.id, true);
  } catch { store.delivered(next.event.id, false); }
  return true;
}
