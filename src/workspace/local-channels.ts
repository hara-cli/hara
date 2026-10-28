import { createHash, randomUUID } from "node:crypto";
import { isWorkspaceAgentId } from "./agent-binding.js";
import type { WorkspaceAgentView } from "./agents.js";
import type { WorkspaceResourceBinding, WorkspaceResourceStorage } from "./resource-context.js";
import { sameWorkspaceResourceBinding } from "./resource-context.js";
import { canonical, exact, messageBody, plain, positive, text, UUID, WorkspaceJsonState } from "./local-state.js";
import { WorkspaceConversationStore } from "./conversations.js";
import { WorkspaceSessionLease } from "./session-lease.js";
import { channelSessionId } from "./channel-session.js";
import { redactSensitiveText } from "../security/secrets.js";

export interface LocalChannel { id: string; name: string; memberIds: string[]; createdAt: string }
interface Catalog { schemaVersion: 1; revision: number; resourceBinding: WorkspaceResourceBinding; channels: LocalChannel[] }
type ReplyState = "queued" | "running" | "completed" | "cancelled" | "failed" | "interrupted";
interface Reply { agentId: string; displayName: string; requestId: string; runId: string | null; startIndex: number; endIndex: number | null; state: ReplyState; questionId?: string;
  /** Peer wake (Raft-learned): the member whose reply queued this one, and its optional untrusted note. */
  wokenBy?: string; wakeNote?: string }
interface ChannelTurn { id: string; digest: string; body: string; createdAt: string; state: "running" | "completed" | "cancelled" | "interrupted"; replies: Reply[] }
interface ChannelHistory { schemaVersion: 1; revision: number; resourceBinding: WorkspaceResourceBinding; channelId: string; turns: ChannelTurn[] }
export interface LocalChannelMessage { id: string; turnId: string; agentId: string | null; displayName: string; createdAt: string;
  message: { role: "user"; content: string } | { role: "assistant"; text: string; tools: string[] } | { role: "tool"; results: { id: string; name: string; content: string; isError: boolean }[] } }
interface ActiveTurn { cancelled: boolean; runId: string | null; agentId: string | null; promise: Promise<void>; lease: WorkspaceSessionLease }
interface ChannelHost {
  agents(): WorkspaceAgentView[];
  start(agentId: string, body: string, requestId: string, channelId: string, context: string, clientId: string, questionId?: string): { runId: string };
  wait(runId: string): Promise<void>;
  cancel(agentId: string, runId: string): void;
  changed(): void;
  accepting(): boolean;
}
const time = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v));
const ids = (v: unknown): v is string[] => Array.isArray(v) && v.every(isWorkspaceAgentId) && new Set(v).size === v.length;
const nonnegative = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const WAKE_NOTE_MAX = 500;
const optionalReplyKeys = ["questionId", "wokenBy", "wakeNote"];
/** ASCII word chars only — so `@Bob` never matches inside `@Bobby`, while `@小明你好` still resolves `小明`. */
const asciiWordEnd = /[A-Za-z0-9_]$/, asciiWordStart = /^[A-Za-z0-9_]/;

/** `@displayName` / `@agentId` mentions of channel members, in body order. The longest name wins at each `@`; an ASCII name
 * ending in a letter/digit must not run into another ASCII word char. CJK names need no trailing separator. */
export function channelMentions(body: string, members: { agentId: string; displayName: string }[]): string[] {
  const names = members.flatMap(row => [{ agentId: row.agentId, name: row.displayName.toLowerCase() }, { agentId: row.agentId, name: row.agentId.toLowerCase() }])
    .filter(row => row.name.length > 0).sort((a, b) => b.name.length - a.name.length);
  const found: string[] = [];
  for (let at = body.indexOf("@"); at >= 0; at = body.indexOf("@", at + 1)) {
    if (at > 0 && /[\p{L}\p{N}_.]/u.test(body[at - 1]!)) continue; // an e-mail address, not a mention
    const rest = body.slice(at + 1), lower = rest.toLowerCase();
    const hit = names.find(row => lower.startsWith(row.name) && !(asciiWordEnd.test(row.name) && asciiWordStart.test(rest.slice(row.name.length))));
    if (hit && !found.includes(hit.agentId)) found.push(hit.agentId);
  }
  return found;
}

/** Local room metadata, transcript references and execution queue. No Account or collab dependency. */
export class WorkspaceLocalChannels {
  private readonly catalog: WorkspaceJsonState<Catalog>;
  private readonly active = new Map<string, ActiveTurn>();
  private readonly cleanupFailed = new Set<string>();
  constructor(private readonly storage: WorkspaceResourceStorage, private readonly host: ChannelHost) {
    this.catalog = new WorkspaceJsonState(storage, "local-channels.json", value => {
      if (!plain(value) || !exact(value, ["schemaVersion", "revision", "resourceBinding", "channels"]) || value.schemaVersion !== 1 || !positive(value.revision)
        || !sameWorkspaceResourceBinding(value.resourceBinding as WorkspaceResourceBinding, this.catalog.binding()) || !Array.isArray(value.channels)) throw new Error("invalid local channel catalog; retained");
      const seen = new Set<string>();
      for (const row of value.channels) {
        if (!plain(row) || !exact(row, ["id", "name", "memberIds", "createdAt"]) || typeof row.id !== "string" || !UUID.test(row.id) || seen.has(row.id)
          || !text(row.name, 80) || !ids(row.memberIds) || !time(row.createdAt)) throw new Error("invalid local channel metadata; retained");
        seen.add(row.id);
      }
      return structuredClone(value) as unknown as Catalog;
    }, () => ({ schemaVersion: 1, revision: 0, resourceBinding: this.catalog.binding(), channels: [] }));
  }
  list() { const value = this.catalog.read(); return { revision: value.revision, channels: value.channels }; }
  get(channelId: string): LocalChannel {
    if (!UUID.test(channelId)) throw new Error("invalid local channel identity");
    const row = this.catalog.read().channels.find(row => row.id === channelId);
    if (!row) throw new Error("local channel is not in this Workspace");
    return row;
  }
  private members(memberIds: unknown): asserts memberIds is string[] {
    if (!ids(memberIds) || memberIds.some(id => !this.host.agents().some(agent => agent.agentId === id && agent.kind === "colleague" && agent.state === "active")))
      throw new Error("channel members must be active colleagues in this Workspace");
  }
  create(id: string, name: string, memberIds: unknown, expectedRevision: number) {
    if (!this.host.accepting() || !UUID.test(id) || !text(name, 80)) throw new Error("invalid local channel creation");
    this.members(memberIds);
    const prior = this.catalog.read().channels.find(row => row.id === id);
    if (prior) {
      if (prior.name !== name || canonical(prior.memberIds) !== canonical(memberIds)) throw new Error("channel request identity already used");
      return this.list();
    }
    this.catalog.update(expectedRevision, value => { value.channels.push({ id, name, memberIds, createdAt: new Date().toISOString() }); return value; });
    this.host.changed(); return this.list();
  }
  update(channelId: string, name: string, memberIds: unknown, expectedRevision: number) {
    if (!this.host.accepting() || !text(name, 80) || this.active.has(channelId)) throw new Error("channel is busy or name is invalid");
    this.get(channelId); this.members(memberIds);
    const lease = WorkspaceSessionLease.acquire(this.storage, channelSessionId(channelId, "room-queue"));
    try { this.catalog.update(expectedRevision, value => { lease.assertCurrent(); const row = value.channels.find(row => row.id === channelId)!; row.name = name; row.memberIds = memberIds; return value; }); }
    finally { lease.release(); }
    this.host.changed(); return this.list();
  }
  private history(channelId: string) {
    return new WorkspaceJsonState<ChannelHistory>(this.storage, `local-channel-${channelId}.json`, value => {
      if (!plain(value) || !exact(value, ["schemaVersion", "revision", "resourceBinding", "channelId", "turns"]) || value.schemaVersion !== 1 || !positive(value.revision)
        || value.channelId !== channelId || !sameWorkspaceResourceBinding(value.resourceBinding as WorkspaceResourceBinding, this.catalog.binding()) || !Array.isArray(value.turns)) throw new Error("invalid channel history; retained");
      const seen = new Set<string>();
      for (const turn of value.turns) {
        if (!plain(turn) || !exact(turn, ["id", "digest", "body", "createdAt", "state", "replies"]) || typeof turn.id !== "string" || !UUID.test(turn.id) || seen.has(turn.id)
          || typeof turn.digest !== "string" || !/^[a-f0-9]{64}$/.test(turn.digest) || !messageBody(turn.body) || !time(turn.createdAt)
          || !["running", "completed", "cancelled", "interrupted"].includes(String(turn.state)) || !Array.isArray(turn.replies)) throw new Error("invalid channel turn; retained");
        const members = new Set<string>();
        for (const reply of turn.replies) {
          if (!plain(reply) || !exact(reply, ["agentId", "displayName", "requestId", "runId", "startIndex", "endIndex", "state", ...optionalReplyKeys.filter(key => Object.hasOwn(reply, key))]) || !isWorkspaceAgentId(reply.agentId) || members.has(reply.agentId)
            || !text(reply.displayName, 200) || typeof reply.requestId !== "string" || !UUID.test(reply.requestId) || (reply.runId !== null && (typeof reply.runId !== "string" || !UUID.test(reply.runId)))
            || (reply.questionId !== undefined && (typeof reply.questionId !== "string" || !UUID.test(reply.questionId)))
            || (reply.wokenBy !== undefined && (!isWorkspaceAgentId(reply.wokenBy) || reply.wokenBy === reply.agentId))
            || (reply.wakeNote !== undefined && (reply.wokenBy === undefined || !messageBody(reply.wakeNote, WAKE_NOTE_MAX)))
            || !nonnegative(reply.startIndex) || (reply.endIndex !== null && (!nonnegative(reply.endIndex) || reply.endIndex < reply.startIndex))
            || !["queued", "running", "completed", "cancelled", "failed", "interrupted"].includes(String(reply.state))) throw new Error("invalid channel reply; retained");
          members.add(reply.agentId);
        }
        seen.add(turn.id);
      }
      return structuredClone(value) as unknown as ChannelHistory;
    }, () => ({ schemaVersion: 1, revision: 0, resourceBinding: this.catalog.binding(), channelId, turns: [] }));
  }
  snapshot(channelId: string) {
    const channel = this.get(channelId), value = this.history(channelId).read(), active = this.active.get(channelId);
    const messages: LocalChannelMessage[] = [];
    for (const turn of value.turns) {
      messages.push({ id: turn.id, turnId: turn.id, agentId: null, displayName: "", createdAt: turn.createdAt, message: { role: "user", content: turn.body } });
      for (const reply of turn.replies) {
        if (!reply.runId && reply.state === "queued") continue;
        const conversation = new WorkspaceConversationStore(this.storage, reply.agentId, channelId).read();
        const accepted = conversation.requests.find(row => row.requestId === reply.requestId);
        if (!accepted && !reply.runId) continue;
        // The accepted request must belong to this reply; no stale/foreign session can enter a room.
        if (!accepted || (reply.runId && accepted.runId !== reply.runId)) throw new Error("channel response ownership changed");
        const history = conversation.history.slice(reply.startIndex + 1, reply.endIndex ?? undefined);
        history.forEach((message, index) => messages.push({ id: `${turn.id}:${reply.agentId}:${index}`, turnId: turn.id, agentId: reply.agentId, displayName: reply.displayName, createdAt: turn.createdAt,
          message: message.role === "assistant" ? { role: "assistant", text: message.text, tools: message.toolUses.map(tool => tool.name) }
            : message.role === "tool" ? { role: "tool", results: message.results.map(row => ({ ...row, isError: row.isError ?? false })) } : { role: "user", content: message.content } }));
      }
    }
    const last = value.turns.at(-1);
    return { channel, revision: value.revision, state: active ? active.cancelled ? "draining" : "running" : this.cleanupFailed.has(channelId) || last?.state === "running" ? "interrupted" : last?.state ?? "idle",
      turns: value.turns.map(turn => ({ id: turn.id, state: !active && turn.state === "running" ? "interrupted" : turn.state,
        replies: turn.replies.map(reply => ({ agentId: reply.agentId, displayName: reply.displayName, state: !active && ["queued", "running"].includes(reply.state) ? "interrupted" : reply.state,
          ...(reply.wokenBy ? { wokenBy: reply.wokenBy } : {}) })) })), messages };
  }
  receipt(channelId: string, requestId: string) {
    this.get(channelId); if (!UUID.test(requestId)) throw new Error("invalid channel receipt");
    return { channelId, requestId, state: this.history(channelId).read().turns.some(row => row.id === requestId) ? "accepted" : "unknown" };
  }
  private name(agentId: string) { return this.host.agents().find(row => row.agentId === agentId)?.identity.displayName ?? agentId; }
  private context(channelId: string, wake?: { by: string; note?: string }) {
    const snapshot = this.snapshot(channelId);
    return JSON.stringify({ channel: snapshot.channel.name, members: snapshot.channel.memberIds.map(id => ({ agentId: id, name: this.name(id) })),
      messages: snapshot.messages.map(row => ({ sender: row.agentId ? row.displayName : "User", message: row.message })),
      // A peer's wake note is conversation data from another participant, never user authority.
      ...(wake ? { wokenBy: { agentId: wake.by, name: this.name(wake.by), ...(wake.note ? { note: wake.note } : {}) } } : {}) });
  }
  /** channel_sync: the same JSON a reply receives at start, re-read now so replies written mid-turn are visible. Read-only. */
  sync(channelId: string) { return this.context(channelId); }
  /** channel_peer_wake: the reply running right now queues another member into the same turn. Still serial; no re-entry. */
  peerWake(channelId: string, runId: string, agentId: string, target: string, note?: string) {
    const channel = this.get(channelId), active = this.active.get(channelId);
    // Outside an active reply is a host misuse; expected wake refusals return structured {ok:false} so the
    // colleague can keep working (throw would mark the tool isError and can end the channel run early).
    if (!active || active.cancelled || active.runId !== runId || active.agentId !== agentId) throw new Error("peer wake is only available to the colleague currently replying in this channel turn");
    if (note !== undefined && !messageBody(note, WAKE_NOTE_MAX)) return { ok: false as const, error: `wake note must be 1-${WAKE_NOTE_MAX} plain characters` };
    const wanted = target.replace(/^@/, "").trim().toLowerCase();
    const matches = channel.memberIds.filter(id => id.toLowerCase() === wanted || this.name(id).toLowerCase() === wanted);
    if (matches.length !== 1) {
      return { ok: false as const, error: matches.length ? "more than one channel member has that name; wake by exact agentId" : "peer wake target is not a member of this channel" };
    }
    const targetId = matches[0]!;
    if (targetId === agentId) return { ok: false as const, error: "a colleague cannot wake itself" };
    this.members([targetId]); active.lease.assertCurrent();
    const state = this.history(channelId), value = state.read(), prior = value.turns.at(-1)!.replies.find(row => row.agentId === targetId);
    if (prior && prior.state !== "queued") return { ok: false as const, error: "that colleague already replied in this turn; no re-entry" };
    if (!prior) {
      state.update(value.revision, next => { active.lease.assertCurrent();
        next.turns.at(-1)!.replies.push({ agentId: targetId, displayName: this.name(targetId), requestId: randomUUID(), runId: null, startIndex: 0, endIndex: null, state: "queued",
          wokenBy: agentId, ...(note ? { wakeNote: redactSensitiveText(note).text } : {}) }); return next; });
      this.host.changed();
    }
    return { ok: true as const, queued: true, alreadyQueued: Boolean(prior), agentId: targetId, displayName: this.name(targetId) };
  }
  send(clientId: string, channelId: string, body: string, requestId: string, recipientIds: unknown, questionId?: string) {
    const channel = this.get(channelId);
    if (!this.host.accepting() || !messageBody(body) || !UUID.test(requestId) || !ids(recipientIds) || recipientIds.some(id => !channel.memberIds.includes(id))) throw new Error("invalid local channel message or recipients");
    this.members(recipientIds);
    // Mentions widen a non-empty recipient list only; with no recipients the message is a note to the room and starts nobody.
    const available = channel.memberIds.filter(id => this.host.agents().some(row => row.agentId === id && row.kind === "colleague" && row.state === "active"));
    const recipients = recipientIds.length ? [...recipientIds, ...channelMentions(body, available.map(id => ({ agentId: id, displayName: this.name(id) })))
      .filter(id => !recipientIds.includes(id))] : recipientIds;
    const state = this.history(channelId), before = state.read(), digest = createHash("sha256").update(canonical(questionId ? [body, recipientIds, questionId] : [body, recipientIds])).digest("hex");
    const duplicate = before.turns.find(row => row.id === requestId);
    if (duplicate) { if (duplicate.digest !== digest) throw new Error("channel message identity already used"); return { channelId, requestId, accepted: true }; }
    if (this.active.has(channelId)) throw new Error("channel colleagues are still working");
    const lease = WorkspaceSessionLease.acquire(this.storage, channelSessionId(channelId, "room-queue"));
    try {
      state.update(before.revision, value => {
        for (const old of value.turns) {
          if (old.state === "running") old.state = "interrupted";
          for (const row of old.replies) {
            if (["queued", "running"].includes(row.state)) row.state = "interrupted";
            if (row.endIndex !== null) continue;
            const conversation = new WorkspaceConversationStore(this.storage, row.agentId, channelId).read();
            row.runId ??= conversation.requests.find(entry => entry.requestId === row.requestId)?.runId ?? null;
            if (row.runId) row.endIndex = conversation.history.length;
          }
        }
        value.turns.push({ id: requestId, digest, body: redactSensitiveText(body).text, createdAt: new Date().toISOString(), state: "running", replies: recipients.map(agentId => ({ agentId,
          displayName: this.host.agents().find(row => row.agentId === agentId)!.identity.displayName, requestId: randomUUID(), runId: null, startIndex: 0, endIndex: null, state: "queued", ...(questionId ? { questionId } : {}) })) }); return value;
      });
    } catch (error) { lease.release(); throw error; }
    const active: ActiveTurn = { cancelled: false, runId: null, agentId: null, promise: Promise.resolve(), lease }; this.active.set(channelId, active);
    this.cleanupFailed.delete(channelId);
    active.promise = this.run(clientId, channelId, requestId, active); this.host.changed();
    return { channelId, requestId, accepted: true };
  }
  private changeReply(channelId: string, turnId: string, index: number, change: (reply: Reply) => void) {
    const active = this.active.get(channelId); if (!active) throw new Error("channel turn is not owned"); active.lease.assertCurrent();
    const state = this.history(channelId), value = state.read(); state.update(value.revision, next => { change(next.turns.find(row => row.id === turnId)!.replies[index]!); return next; }); this.host.changed();
  }
  private async run(clientId: string, channelId: string, turnId: string, active: ActiveTurn) {
    try {
      // Re-read every step: channel_peer_wake may append replies while an earlier one is running.
      for (let index = 0; ; index++) {
        const turn = this.history(channelId).read().turns.find(row => row.id === turnId)!, reply = turn.replies[index];
        if (!reply) break;
        active.lease.assertCurrent();
        if (active.cancelled || !this.host.accepting()) break;
        let admitted = false;
        try {
          const store = new WorkspaceConversationStore(this.storage, reply.agentId, channelId), startIndex = store.read().history.length;
          this.changeReply(channelId, turnId, index, row => { row.startIndex = startIndex; row.state = "running"; });
          const accepted = this.host.start(reply.agentId, turn.body, reply.requestId, channelId, this.context(channelId, reply.wokenBy ? { by: reply.wokenBy, note: reply.wakeNote } : undefined), clientId, reply.questionId);
          active.runId = accepted.runId; active.agentId = reply.agentId;
          this.changeReply(channelId, turnId, index, row => { row.runId = accepted.runId; });
          admitted = true;
          await this.host.wait(accepted.runId); active.lease.assertCurrent();
          const completed = store.read();
          this.changeReply(channelId, turnId, index, row => { row.endIndex = completed.history.length;
            row.state = completed.attempt?.state === "completed" ? "completed" : completed.attempt?.state === "cancelled" ? "cancelled" : "failed"; });
        } catch {
          if (active.runId && active.agentId) {
            try { this.host.cancel(active.agentId, active.runId); } catch { /* Already settled. */ }
            await this.host.wait(active.runId);
            if (!admitted) active.cancelled = true; // A room-receipt write failed after acceptance: stop the queue.
          }
          this.changeReply(channelId, turnId, index, row => { row.state = "failed";
            if (active.runId) { row.runId = active.runId; row.endIndex = new WorkspaceConversationStore(this.storage, row.agentId, channelId).read().history.length; }
          });
        } finally { active.runId = null; active.agentId = null; }
      }
      const state = this.history(channelId), value = state.read();
      state.update(value.revision, next => { active.lease.assertCurrent(); const turn = next.turns.find(row => row.id === turnId)!; turn.state = active.cancelled || !this.host.accepting() ? "cancelled" : "completed";
        for (const row of turn.replies) if (row.state === "queued") row.state = "cancelled"; return next; });
    } catch { /* State/lease failures are preserved as interrupted; never replay a participant request. */ }
    finally { this.active.delete(channelId); try { active.lease.release(); } catch { this.cleanupFailed.add(channelId); } this.host.changed(); }
  }
  cancel(channelId: string) {
    this.get(channelId); const active = this.active.get(channelId); if (!active) return;
    active.cancelled = true;
    if (active.agentId && active.runId) { try { this.host.cancel(active.agentId, active.runId); } catch { /* Already settled; remaining queued replies still stop. */ } }
    this.host.changed();
  }
  running() { return this.active.size; }
  async wait(channelId: string) { await this.active.get(channelId)?.promise; }
  async close() { for (const channelId of this.active.keys()) this.cancel(channelId); await Promise.all([...this.active.values()].map(row => row.promise)); }
}
