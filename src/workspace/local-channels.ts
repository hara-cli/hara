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
import { channelRoleUnrelated, type ChannelPrefilterProfile } from "./channel-prefilter.js";
import { readChannelAutonomy, parseChannelAutonomyUpdate, assertChannelAutonomyProductionDispatch, type ChannelAutonomyPolicy } from "./channel-autonomy.js";

export interface LocalChannel { id: string; name: string; memberIds: string[]; createdAt: string; autonomy?: ChannelAutonomyPolicy; lastMessageAt?: string; preview?: string; messageCount?: number; activityAvailable?: boolean }
interface Catalog { schemaVersion: 1; revision: number; resourceBinding: WorkspaceResourceBinding; channels: LocalChannel[] }
type ReplyState = "queued" | "running" | "completed" | "cancelled" | "failed" | "interrupted" | "passed";
interface Reply {
  agentId: string; displayName: string; requestId: string; runId: string | null; startIndex: number; endIndex: number | null;
  state: ReplyState; questionId?: string; wokenBy?: string; wakeNote?: string;
  passedBy?: "prefilter"; passReason?: "role_unrelated"; depth?: number;
}
interface ChannelTurn {
  id: string; digest: string; body: string; createdAt: string;
  state: "queued" | "running" | "completed" | "cancelled" | "interrupted"; replies: Reply[];
  origin?: "user" | "autonomy"; rootTurnId?: string;
}
interface ChannelHistory { schemaVersion: 1; revision: number; resourceBinding: WorkspaceResourceBinding; channelId: string; turns: ChannelTurn[] }
export interface LocalChannelMessage {
  id: string; turnId: string; agentId: string | null; displayName: string; createdAt: string;
  message: { role: "user"; content: string } | { role: "assistant"; text: string; tools: string[] }
    | { role: "tool"; results: { id: string; name: string; content: string; isError: boolean }[] };
}
interface ActiveTurn {
  turnId: string; cancelled: boolean; runId: string | null; agentId: string | null;
  promise: Promise<void>; lease: WorkspaceSessionLease;
}
interface ChannelHost {
  agents(): WorkspaceAgentView[];
  /** Host-private persona projection; never sent to the renderer or written into PASS reasons. */
  prefilterProfiles?(): ChannelPrefilterProfile[];
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
export const LOCAL_CHANNEL_QUEUE_LIMIT = 5;
const optionalReplyKeys = ["questionId", "wokenBy", "wakeNote", "passedBy", "passReason", "depth"];
const optionalTurnKeys = ["origin", "rootTurnId"];
const asciiWordEnd = /[A-Za-z0-9_]$/, asciiWordStart = /^[A-Za-z0-9_]/;

/** Longest exact member name wins; an e-mail address or a partial ASCII word is not a mention. */
export function channelMentions(body: string, members: { agentId: string; displayName: string }[]): string[] {
  const names = members.flatMap(row => [{ agentId: row.agentId, name: row.displayName.toLowerCase() }, { agentId: row.agentId, name: row.agentId.toLowerCase() }])
    .filter(row => row.name.length > 0).sort((a, b) => b.name.length - a.name.length);
  const found: string[] = [];
  for (let at = body.indexOf("@"); at >= 0; at = body.indexOf("@", at + 1)) {
    if (at > 0 && /[\p{L}\p{N}_.]/u.test(body[at - 1]!)) continue;
    const rest = body.slice(at + 1), lower = rest.toLowerCase();
    const hit = names.find(row => lower.startsWith(row.name) && !(asciiWordEnd.test(row.name) && asciiWordStart.test(rest.slice(row.name.length))));
    if (hit && !found.includes(hit.agentId)) found.push(hit.agentId);
  }
  return found;
}

/** Private persisted room queue. A queued turn has never been dispatched and is not a runtime resume. */
export class WorkspaceLocalChannels {
  private readonly catalog: WorkspaceJsonState<Catalog>;
  private readonly active = new Map<string, ActiveTurn>();
  private readonly cleanupFailed = new Set<string>();
  /** Socket identities are transient: a restart requires an explicit current client to resume the queue. */
  private readonly queuedClients = new Map<string, string>();
  private closed = false;
  constructor(private readonly storage: WorkspaceResourceStorage, private readonly host: ChannelHost) {
    this.catalog = new WorkspaceJsonState(storage, "local-channels.json", value => {
      if (!plain(value) || !exact(value, ["schemaVersion", "revision", "resourceBinding", "channels"]) || value.schemaVersion !== 1 || !positive(value.revision)
        || !sameWorkspaceResourceBinding(value.resourceBinding as WorkspaceResourceBinding, this.catalog.binding()) || !Array.isArray(value.channels)) throw new Error("invalid local channel catalog; retained");
      const seen = new Set<string>();
      for (const row of value.channels) {
        if (!plain(row) || !exact(row, ["id", "name", "memberIds", "createdAt", ...(Object.hasOwn(row, "autonomy") ? ["autonomy"] : [])]) || typeof row.id !== "string" || !UUID.test(row.id) || seen.has(row.id)
          || !text(row.name, 80) || !ids(row.memberIds) || !time(row.createdAt)) throw new Error("invalid local channel metadata; retained");
        readChannelAutonomy(row.autonomy, row.memberIds);
        seen.add(row.id);
      }
      return structuredClone(value) as unknown as Catalog;
    }, () => ({ schemaVersion: 1, revision: 0, resourceBinding: this.catalog.binding(), channels: [] }));
  }
  private accepting() { return !this.closed && this.host.accepting(); }
  private clientKey(channelId: string, turnId: string) { return channelId + ":" + turnId; }
  private view(channel: LocalChannel): LocalChannel { return { ...channel, autonomy: readChannelAutonomy(channel.autonomy, channel.memberIds) }; }
  list() {
    const value = this.catalog.read();
    return { revision: value.revision, channels: value.channels.map(channel => {
      try {
        const messages = this.snapshot(channel.id).messages.filter(row => row.message.role !== "tool"), last = messages.at(-1);
        const preview = last?.message.role === "assistant" ? last.message.text : last?.message.role === "user" ? last.message.content : "";
        return { ...this.view(channel), messageCount: messages.length, activityAvailable: true,
          ...(last ? { lastMessageAt: last.createdAt, preview: redactSensitiveText(preview).text.replace(/\s+/gu, " ").slice(0, 160) } : {}) };
      } catch { return { ...this.view(channel), activityAvailable: false }; }
    }) };
  }
  get(channelId: string): LocalChannel {
    if (!UUID.test(channelId)) throw new Error("invalid local channel identity");
    const row = this.catalog.read().channels.find(row => row.id === channelId);
    if (!row) throw new Error("local channel is not in this Workspace");
    return this.view(row);
  }
  private members(memberIds: unknown, roster = this.host.agents(), retained: readonly string[] = []): asserts memberIds is string[] {
    if (!ids(memberIds) || memberIds.some(id => !roster.some(agent => agent.agentId === id && agent.kind === "colleague" && (agent.state === "active" || agent.state === "archived" && retained.includes(id)))))
      throw new Error("channel members must be active colleagues in this Workspace");
  }
  create(id: string, name: string, memberIds: unknown, expectedRevision: number) {
    if (!this.accepting() || !UUID.test(id) || !text(name, 80)) throw new Error("invalid local channel creation");
    this.members(memberIds);
    const prior = this.catalog.read().channels.find(row => row.id === id);
    if (prior) {
      if (prior.name !== name || canonical(prior.memberIds) !== canonical(memberIds)) throw new Error("channel request identity already used");
      return this.list();
    }
    this.catalog.update(expectedRevision, value => { value.channels.push({ id, name, memberIds, createdAt: new Date().toISOString(), autonomy: readChannelAutonomy(undefined, memberIds) }); return value; });
    this.host.changed(); return this.list();
  }
  update(channelId: string, name: string, memberIds: unknown, expectedRevision: number, autonomy?: unknown) {
    if (!this.accepting() || !text(name, 80)) throw new Error("channel is not accepting changes or name is invalid");
    const channel = this.get(channelId), active = this.active.get(channelId); this.members(memberIds, this.host.agents(), channel.memberIds);
    if (active && (autonomy === undefined || name !== channel.name || canonical(memberIds) !== canonical(channel.memberIds)))
      throw new Error("channel is busy; only autonomy settings may change while colleagues are replying");
    const policy = autonomy === undefined
      ? readChannelAutonomy({ ...channel.autonomy!, mutedAgentIds: channel.autonomy!.mutedAgentIds.filter(id => memberIds.includes(id)) }, memberIds)
      : parseChannelAutonomyUpdate(autonomy, memberIds);
    const lease = active?.lease ?? WorkspaceSessionLease.acquire(this.storage, channelSessionId(channelId, "room-queue"));
    try {
      this.catalog.update(expectedRevision, value => {
        lease.assertCurrent(); const row = value.channels.find(row => row.id === channelId)!;
        row.name = name; row.memberIds = memberIds; row.autonomy = policy; return value;
      });
    } finally { if (!active) lease.release(); }
    this.host.changed(); return this.list();
  }
  private history(channelId: string) {
    return new WorkspaceJsonState<ChannelHistory>(this.storage, "local-channel-" + channelId + ".json", value => {
      if (!plain(value) || !exact(value, ["schemaVersion", "revision", "resourceBinding", "channelId", "turns"]) || value.schemaVersion !== 1 || !positive(value.revision)
        || value.channelId !== channelId || !sameWorkspaceResourceBinding(value.resourceBinding as WorkspaceResourceBinding, this.catalog.binding()) || !Array.isArray(value.turns)) throw new Error("invalid channel history; retained");
      const seen = new Set<string>();
      for (const turn of value.turns) {
        if (!plain(turn) || !exact(turn, ["id", "digest", "body", "createdAt", "state", "replies", ...optionalTurnKeys.filter(key => Object.hasOwn(turn, key))]) || typeof turn.id !== "string" || !UUID.test(turn.id) || seen.has(turn.id)
          || typeof turn.digest !== "string" || !/^[a-f0-9]{64}$/.test(turn.digest) || !messageBody(turn.body) || !time(turn.createdAt)
          || !["queued", "running", "completed", "cancelled", "interrupted"].includes(String(turn.state)) || !Array.isArray(turn.replies)
          || (turn.origin !== undefined && !["user", "autonomy"].includes(String(turn.origin)))
          || (turn.rootTurnId !== undefined && (typeof turn.rootTurnId !== "string" || !UUID.test(turn.rootTurnId)))
          || ((turn.origin ?? "user") === "user" && turn.rootTurnId !== undefined && turn.rootTurnId !== turn.id)) throw new Error("invalid channel turn; retained");
        const members = new Set<string>();
        for (const reply of turn.replies) {
          if (!plain(reply) || !exact(reply, ["agentId", "displayName", "requestId", "runId", "startIndex", "endIndex", "state", ...optionalReplyKeys.filter(key => Object.hasOwn(reply, key))]) || !isWorkspaceAgentId(reply.agentId) || members.has(reply.agentId)
            || !text(reply.displayName, 200) || typeof reply.requestId !== "string" || !UUID.test(reply.requestId) || (reply.runId !== null && (typeof reply.runId !== "string" || !UUID.test(reply.runId)))
            || (reply.questionId !== undefined && (typeof reply.questionId !== "string" || !UUID.test(reply.questionId)))
            || (reply.wokenBy !== undefined && (!isWorkspaceAgentId(reply.wokenBy) || reply.wokenBy === reply.agentId))
            || (reply.wakeNote !== undefined && (reply.wokenBy === undefined || !messageBody(reply.wakeNote, WAKE_NOTE_MAX)))
            || (reply.depth !== undefined && (!nonnegative(reply.depth) || reply.depth > 1))
            || !nonnegative(reply.startIndex) || (reply.endIndex !== null && (!nonnegative(reply.endIndex) || reply.endIndex < reply.startIndex))
            || !["queued", "running", "completed", "cancelled", "failed", "interrupted", "passed"].includes(String(reply.state))) throw new Error("invalid channel reply; retained");
          if (reply.state === "passed") {
            if (reply.passedBy !== "prefilter" || reply.passReason !== "role_unrelated" || reply.runId !== null || reply.startIndex !== 0 || reply.endIndex !== null
              || reply.questionId !== undefined || reply.wokenBy !== undefined) throw new Error("invalid prefilter pass; retained");
          } else if (reply.passedBy !== undefined || reply.passReason !== undefined) throw new Error("pass metadata is only valid on passed replies");
          if (turn.state === "queued" && (reply.runId !== null || !["queued", "passed"].includes(String(reply.state)))) throw new Error("queued turn already contains a started reply; retained");
          members.add(reply.agentId);
        }
        seen.add(turn.id);
      }
      if (value.turns.filter(turn => (turn as ChannelTurn).state === "queued").length > LOCAL_CHANNEL_QUEUE_LIMIT) throw new Error("channel queue exceeds its limit; retained");
      return structuredClone(value) as unknown as ChannelHistory;
    }, () => ({ schemaVersion: 1, revision: 0, resourceBinding: this.catalog.binding(), channelId, turns: [] }));
  }
  snapshot(channelId: string) {
    const channel = this.get(channelId), value = this.history(channelId).read(), active = this.active.get(channelId);
    const messages: LocalChannelMessage[] = [], started = new Set<string>();
    for (const turn of value.turns) {
      messages.push({ id: turn.id, turnId: turn.id, agentId: null, displayName: "", createdAt: turn.createdAt, message: { role: "user", content: turn.body } });
      for (const reply of turn.replies) {
        if (reply.runId) started.add(reply.requestId);
        if (reply.state === "passed" || (!reply.runId && ["queued", "cancelled"].includes(reply.state))) continue;
        const conversation = new WorkspaceConversationStore(this.storage, reply.agentId, channelId).read();
        const accepted = conversation.requests.find(row => row.requestId === reply.requestId);
        if (!accepted && !reply.runId) continue;
        if (!accepted || (reply.runId && accepted.runId !== reply.runId)) throw new Error("channel response ownership changed");
        started.add(reply.requestId);
        const history = conversation.history.slice(reply.startIndex + 1, reply.endIndex ?? undefined);
        history.forEach((message, index) => messages.push({ id: turn.id + ":" + reply.agentId + ":" + index, turnId: turn.id, agentId: reply.agentId, displayName: reply.displayName, createdAt: turn.createdAt,
          message: message.role === "assistant" ? { role: "assistant", text: message.text, tools: message.toolUses.map(tool => tool.name) }
            : message.role === "tool" ? { role: "tool", results: message.results.map(row => ({ ...row, isError: row.isError ?? false })) } : { role: "user", content: message.content } }));
      }
    }
    const pendingCount = value.turns.filter(turn => turn.state === "queued").length, last = value.turns.filter(turn => turn.state !== "queued").at(-1);
    return { channel, revision: value.revision,
      state: active ? active.cancelled ? "draining" : "running" : this.cleanupFailed.has(channelId) || last?.state === "running" ? "interrupted" : pendingCount ? "queued" : last?.state ?? "idle",
      pendingCount, queueNeedsResume: pendingCount > 0 && !active,
      turns: value.turns.map(turn => ({ id: turn.id, origin: turn.origin ?? "user", rootTurnId: turn.rootTurnId ?? turn.id, state: !active && turn.state === "running" ? "interrupted" : turn.state,
        replies: turn.replies.map(reply => ({ agentId: reply.agentId, displayName: reply.displayName, started: started.has(reply.requestId), depth: reply.depth ?? 0,
          state: !active && turn.state !== "queued" && ["queued", "running"].includes(reply.state) ? "interrupted" : reply.state,
          ...(reply.wokenBy ? { wokenBy: reply.wokenBy } : {}),
          ...(reply.state === "passed" ? { passedBy: reply.passedBy!, passReason: reply.passReason! } : {}) })) })), messages };
  }
  receipt(channelId: string, requestId: string) {
    this.get(channelId); if (!UUID.test(requestId)) throw new Error("invalid channel receipt");
    const turns = this.history(channelId).read().turns, turn = turns.find(row => row.id === requestId), queue = turns.filter(row => row.state === "queued");
    return { channelId, requestId, state: turn ? "accepted" : "unknown", queued: turn?.state === "queued", position: turn?.state === "queued" ? queue.findIndex(row => row.id === requestId) + 1 : 0 };
  }
  private name(agentId: string, roster = this.host.agents()) { return roster.find(row => row.agentId === agentId)?.identity.displayName ?? agentId; }
  private context(channelId: string, wake?: { by: string; note?: string }) {
    const snapshot = this.snapshot(channelId), active = this.active.get(channelId), turnIndex = active ? snapshot.turns.findIndex(turn => turn.id === active.turnId) : snapshot.turns.length - 1;
    const visible = new Set(snapshot.turns.slice(0, turnIndex + 1).map(turn => turn.id)), roster = this.host.agents();
    return JSON.stringify({ channel: snapshot.channel.name, members: snapshot.channel.memberIds.map(id => ({ agentId: id, name: this.name(id, roster) })),
      messages: snapshot.messages.filter(row => visible.has(row.turnId)).map(row => ({ sender: row.agentId ? row.displayName : "User", message: row.message })),
      ...(wake ? { wokenBy: { agentId: wake.by, name: this.name(wake.by, roster), ...(wake.note ? { note: wake.note } : {}) } } : {}) });
  }
  sync(channelId: string) { return this.context(channelId); }
  peerWake(channelId: string, runId: string, agentId: string, target: string, note?: string) {
    const channel = this.get(channelId), active = this.active.get(channelId);
    if (!active || active.cancelled || active.runId !== runId || active.agentId !== agentId) throw new Error("peer wake is only available to the colleague currently replying in this channel turn");
    if (note !== undefined && !messageBody(note, WAKE_NOTE_MAX)) return { ok: false as const, error: "wake note must be 1-" + WAKE_NOTE_MAX + " plain characters" };
    const roster = this.host.agents(), wanted = target.replace(/^@/, "").trim().toLowerCase();
    const matches = channel.memberIds.filter(id => id.toLowerCase() === wanted || this.name(id, roster).toLowerCase() === wanted);
    if (matches.length !== 1) return { ok: false as const, error: matches.length ? "more than one channel member has that name; wake by exact agentId" : "peer wake target is not a member of this channel" };
    const targetId = matches[0]!;
    if (targetId === agentId) return { ok: false as const, error: "a colleague cannot wake itself" };
    this.members([targetId], roster); active.lease.assertCurrent();
    const state = this.history(channelId), value = state.read(), turn = value.turns.find(row => row.id === active.turnId)!;
    this.assertUserTurnDispatch(turn);
    const prior = turn.replies.find(row => row.agentId === targetId);
    if (prior && !["queued", "passed"].includes(prior.state)) return { ok: false as const, error: "that colleague already replied in this turn; no re-entry" };
    if (!prior || prior.state === "passed") {
      state.update(value.revision, next => {
        active.lease.assertCurrent();
        const replies = next.turns.find(row => row.id === active.turnId)!.replies;
        const previous = replies.findIndex(row => row.agentId === targetId);
        const entry: Reply = previous >= 0 ? replies.splice(previous, 1)[0]! : { agentId: targetId, displayName: this.name(targetId, roster), requestId: randomUUID(), runId: null, startIndex: 0, endIndex: null, state: "queued", depth: 0 };
        delete entry.passedBy; delete entry.passReason;
        entry.state = "queued"; entry.depth = 0; entry.wokenBy = agentId;
        if (note) entry.wakeNote = redactSensitiveText(note).text;
        replies.push(entry); return next;
      });
      this.host.changed();
    }
    return { ok: true as const, queued: true, alreadyQueued: prior?.state === "queued", agentId: targetId, displayName: this.name(targetId, roster) };
  }
  private recoverInterrupted(value: ChannelHistory, lease: WorkspaceSessionLease): ChannelHistory {
    lease.assertCurrent();
    for (const old of value.turns) if (old.state === "running") {
      old.state = "interrupted";
      for (const row of old.replies) {
        const wasRunning = row.state === "running";
        if (["queued", "running"].includes(row.state)) row.state = "interrupted";
        if (row.endIndex !== null || row.state === "passed" || (!row.runId && !wasRunning)) continue;
        const conversation = new WorkspaceConversationStore(this.storage, row.agentId, value.channelId).read();
        row.runId ??= conversation.requests.find(entry => entry.requestId === row.requestId)?.runId ?? null;
        if (row.runId) row.endIndex = conversation.history.length;
      }
    }
    return value;
  }
  private assertUserTurnDispatch(turn: ChannelTurn) {
    if ((turn.origin ?? "user") !== "user" || (turn.rootTurnId ?? turn.id) !== turn.id || turn.replies.some(reply => (reply.depth ?? 0) !== 0))
      assertChannelAutonomyProductionDispatch();
  }
  private begin(channelId: string, turnId: string, clientId: string, lease: WorkspaceSessionLease) {
    const state = this.history(channelId), before = state.read();
    this.assertUserTurnDispatch(before.turns.find(row => row.id === turnId)!);
    state.update(before.revision, next => { this.recoverInterrupted(next, lease); next.turns.find(row => row.id === turnId)!.state = "running"; return next; });
    const active: ActiveTurn = { turnId, cancelled: false, runId: null, agentId: null, promise: Promise.resolve(), lease };
    this.active.set(channelId, active); this.cleanupFailed.delete(channelId);
    active.promise = this.run(clientId, channelId, active);
    this.host.changed();
  }
  send(clientId: string, channelId: string, body: string, requestId: string, recipientIds: unknown, questionId?: string) {
    const channel = this.get(channelId), roster = this.host.agents();
    if (!this.accepting() || !messageBody(body) || !UUID.test(requestId) || !ids(recipientIds) || recipientIds.some(id => !channel.memberIds.includes(id))) throw new Error("invalid local channel message or recipients");
    this.members(recipientIds, roster);
    const available = channel.memberIds.filter(id => roster.some(row => row.agentId === id && row.kind === "colleague" && row.state === "active"));
    const mentioned = channelMentions(body, available.map(id => ({ agentId: id, displayName: this.name(id, roster) })));
    const recipients = recipientIds.length ? [...recipientIds, ...mentioned.filter(id => !recipientIds.includes(id))] : recipientIds;
    const state = this.history(channelId), before = state.read(), digest = createHash("sha256").update(canonical(questionId ? [body, recipientIds, questionId] : [body, recipientIds])).digest("hex");
    const duplicate = before.turns.find(row => row.id === requestId);
    if (duplicate) {
      if (duplicate.digest !== digest) throw new Error("channel message identity already used");
      const receipt = this.receipt(channelId, requestId);
      return { channelId, requestId, accepted: true, queued: receipt.queued, position: receipt.position };
    }
    const pendingCount = before.turns.filter(turn => turn.state === "queued").length, existing = this.active.get(channelId);
    if (questionId && (existing || pendingCount > 0)) throw new Error("channel question answers cannot be queued; wait for the current turn and queue to finish");
    if (pendingCount >= LOCAL_CHANNEL_QUEUE_LIMIT) throw new Error("channel queue is full (maximum 5); message was not accepted");
    const lease = existing?.lease ?? WorkspaceSessionLease.acquire(this.storage, channelSessionId(channelId, "room-queue"));
    let retained = false;
    try {
      lease.assertCurrent();
      const profiles = recipients.length >= 3 && !questionId ? this.host.prefilterProfiles?.() : undefined;
      const replies: Reply[] = recipients.map(agentId => {
        const unrelated = profiles !== undefined && !mentioned.includes(agentId) && channelRoleUnrelated(body, profiles.find(row => row.agentId === agentId));
        return { agentId, displayName: this.name(agentId, roster), requestId: randomUUID(), runId: null, startIndex: 0, endIndex: null, depth: 0,
          state: unrelated ? "passed" : "queued", ...(unrelated ? { passedBy: "prefilter" as const, passReason: "role_unrelated" as const } : {}), ...(questionId ? { questionId } : {}) };
      });
      state.update(before.revision, value => {
        lease.assertCurrent();
        value.turns.push({ id: requestId, digest, body: redactSensitiveText(body).text, createdAt: new Date().toISOString(), state: "queued", replies, origin: "user", rootTurnId: requestId });
        return value;
      });
      this.queuedClients.set(this.clientKey(channelId, requestId), clientId);
      const queued = Boolean(existing) || pendingCount > 0;
      if (!queued) { this.begin(channelId, requestId, clientId, lease); retained = true; }
      this.host.changed();
      return { channelId, requestId, accepted: true, queued, position: queued ? pendingCount + 1 : 0 };
    } finally { if (!existing && !retained) lease.release(); }
  }
  resumeQueue(clientId: string, channelId: string) {
    this.get(channelId);
    if (!this.accepting()) throw new Error("channel is not accepting new work");
    if (this.active.has(channelId)) return { channelId, resumed: false, pendingCount: this.snapshot(channelId).pendingCount };
    const state = this.history(channelId), before = state.read(), queued = before.turns.filter(turn => turn.state === "queued");
    if (!queued.length) return { channelId, resumed: false, pendingCount: 0 };
    const lease = WorkspaceSessionLease.acquire(this.storage, channelSessionId(channelId, "room-queue"));
    let retained = false;
    try {
      lease.assertCurrent();
      for (const turn of queued) this.queuedClients.set(this.clientKey(channelId, turn.id), clientId);
      this.begin(channelId, queued[0]!.id, clientId, lease); retained = true;
      return { channelId, resumed: true, pendingCount: queued.length - 1 };
    } finally { if (!retained) lease.release(); }
  }
  clearQueue(channelId: string) {
    this.get(channelId);
    if (!this.accepting()) throw new Error("channel is not accepting queue changes");
    const active = this.active.get(channelId), lease = active?.lease ?? WorkspaceSessionLease.acquire(this.storage, channelSessionId(channelId, "room-queue"));
    try {
      lease.assertCurrent();
      const state = this.history(channelId), before = state.read();
      const cleared = before.turns.filter(turn => turn.state === "queued").map(turn => turn.id);
      if (cleared.length) state.update(before.revision, next => {
        lease.assertCurrent();
        for (const turn of next.turns) if (turn.state === "queued") {
          turn.state = "cancelled";
          for (const reply of turn.replies) if (reply.state === "queued") reply.state = "cancelled";
        }
        return next;
      });
      for (const id of cleared) this.queuedClients.delete(this.clientKey(channelId, id));
      this.host.changed(); return { channelId, cleared: cleared.length };
    } finally { if (!active) lease.release(); }
  }
  private changeReply(channelId: string, turnId: string, requestId: string, change: (reply: Reply) => void) {
    const active = this.active.get(channelId);
    if (!active || active.turnId !== turnId) throw new Error("channel turn is not owned");
    active.lease.assertCurrent();
    const state = this.history(channelId), value = state.read();
    state.update(value.revision, next => { change(next.turns.find(row => row.id === turnId)!.replies.find(row => row.requestId === requestId)!); return next; });
    this.host.changed();
  }
  private async runTurn(clientId: string, channelId: string, active: ActiveTurn) {
    const turnId = active.turnId;
    while (true) {
      const turn = this.history(channelId).read().turns.find(row => row.id === turnId)!;
      const reply = turn.replies.find(row => row.state === "queued");
      if (!reply || active.cancelled || !this.accepting()) break;
      active.lease.assertCurrent(); this.assertUserTurnDispatch(turn);
      let admitted = false, attempted = false;
      try {
        if (!this.get(channelId).memberIds.includes(reply.agentId)) throw new Error("queued colleague is no longer a channel member");
        this.members([reply.agentId]);
        const store = new WorkspaceConversationStore(this.storage, reply.agentId, channelId), startIndex = store.read().history.length;
        this.changeReply(channelId, turnId, reply.requestId, row => { row.startIndex = startIndex; row.state = "running"; });
        attempted = true;
        const accepted = this.host.start(reply.agentId, turn.body, reply.requestId, channelId,
          this.context(channelId, reply.wokenBy ? { by: reply.wokenBy, note: reply.wakeNote } : undefined), clientId, reply.questionId);
        active.runId = accepted.runId; active.agentId = reply.agentId; active.lease.setDraining(true);
        this.changeReply(channelId, turnId, reply.requestId, row => { row.runId = accepted.runId; });
        admitted = true;
        await this.host.wait(accepted.runId); active.lease.setDraining(false);
        const completed = store.read();
        this.changeReply(channelId, turnId, reply.requestId, row => {
          row.endIndex = completed.history.length;
          row.state = completed.attempt?.state === "completed" ? "completed" : completed.attempt?.state === "cancelled" ? "cancelled" : "failed";
        });
      } catch {
        if (attempted && !admitted) {
          // A throwing start may already have accepted the request. Pause rather than infer rejection.
          active.cancelled = true;
          if (!active.runId) {
            const accepted = new WorkspaceConversationStore(this.storage, reply.agentId, channelId).read().requests.find(row => row.requestId === reply.requestId);
            if (accepted) { active.runId = accepted.runId; active.agentId = reply.agentId; active.lease.setDraining(true); }
          }
        }
        if (active.runId && active.agentId) {
          try { this.host.cancel(active.agentId, active.runId); } catch { /* Already settled. */ }
          await this.host.wait(active.runId); active.lease.setDraining(false);
          if (!admitted) active.cancelled = true; // Accepted but receipt publication failed: never replay or advance the queue.
        }
        this.changeReply(channelId, turnId, reply.requestId, row => {
          row.state = "failed";
          if (active.runId) { row.runId = active.runId; row.endIndex = new WorkspaceConversationStore(this.storage, row.agentId, channelId).read().history.length; }
        });
      } finally { active.runId = null; active.agentId = null; }
    }
    const state = this.history(channelId), value = state.read();
    state.update(value.revision, next => {
      active.lease.assertCurrent(); const turn = next.turns.find(row => row.id === turnId)!;
      turn.state = active.cancelled || !this.accepting() ? "cancelled" : "completed";
      for (const row of turn.replies) if (row.state === "queued") row.state = "cancelled";
      return next;
    });
    this.host.changed();
  }
  private async run(clientId: string, channelId: string, active: ActiveTurn) {
    try {
      while (true) {
        await this.runTurn(this.queuedClients.get(this.clientKey(channelId, active.turnId)) ?? clientId, channelId, active);
        this.queuedClients.delete(this.clientKey(channelId, active.turnId));
        active.lease.assertCurrent();
        if (active.cancelled || !this.accepting()) break;
        const state = this.history(channelId), before = state.read(), next = before.turns.find(turn => turn.state === "queued");
        if (!next) break;
        this.assertUserTurnDispatch(next);
        active.turnId = next.id;
        state.update(before.revision, value => { active.lease.assertCurrent(); value.turns.find(turn => turn.id === next.id)!.state = "running"; return value; });
        this.host.changed();
      }
    } catch { this.cleanupFailed.add(channelId); /* Preserve uncertain running/queued records; explicit recovery only. */ }
    finally {
      this.active.delete(channelId);
      try { active.lease.release(); } catch { this.cleanupFailed.add(channelId); }
      this.host.changed();
    }
  }
  cancel(channelId: string) {
    this.get(channelId); const active = this.active.get(channelId); if (!active) return;
    active.cancelled = true;
    if (active.agentId && active.runId) { try { this.host.cancel(active.agentId, active.runId); } catch { /* Physical draining remains owned. */ } }
    this.host.changed();
  }
  running() { return this.active.size; }
  async wait(channelId: string) { await this.active.get(channelId)?.promise; }
  async close() { this.closed = true; for (const channelId of this.active.keys()) this.cancel(channelId); await Promise.all([...this.active.values()].map(row => row.promise)); }
}
