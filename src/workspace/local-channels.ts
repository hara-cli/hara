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
interface Reply { agentId: string; displayName: string; requestId: string; runId: string | null; startIndex: number; endIndex: number | null; state: ReplyState }
interface ChannelTurn { id: string; digest: string; body: string; createdAt: string; state: "running" | "completed" | "cancelled" | "interrupted"; replies: Reply[] }
interface ChannelHistory { schemaVersion: 1; revision: number; resourceBinding: WorkspaceResourceBinding; channelId: string; turns: ChannelTurn[] }
export interface LocalChannelMessage { id: string; turnId: string; agentId: string | null; displayName: string; createdAt: string;
  message: { role: "user"; content: string } | { role: "assistant"; text: string; tools: string[] } | { role: "tool"; results: { id: string; name: string; content: string; isError: boolean }[] } }
interface ActiveTurn { cancelled: boolean; runId: string | null; agentId: string | null; promise: Promise<void>; lease: WorkspaceSessionLease }
interface ChannelHost {
  agents(): WorkspaceAgentView[];
  start(agentId: string, body: string, requestId: string, channelId: string, context: string, clientId: string): { runId: string };
  wait(runId: string): Promise<void>;
  cancel(agentId: string, runId: string): void;
  changed(): void;
  accepting(): boolean;
}
const time = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v));
const ids = (v: unknown): v is string[] => Array.isArray(v) && v.every(isWorkspaceAgentId) && new Set(v).size === v.length;
const nonnegative = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;

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
          if (!plain(reply) || !exact(reply, ["agentId", "displayName", "requestId", "runId", "startIndex", "endIndex", "state"]) || !isWorkspaceAgentId(reply.agentId) || members.has(reply.agentId)
            || !text(reply.displayName, 200) || typeof reply.requestId !== "string" || !UUID.test(reply.requestId) || (reply.runId !== null && (typeof reply.runId !== "string" || !UUID.test(reply.runId)))
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
        replies: turn.replies.map(reply => ({ agentId: reply.agentId, displayName: reply.displayName, state: !active && ["queued", "running"].includes(reply.state) ? "interrupted" : reply.state })) })), messages };
  }
  receipt(channelId: string, requestId: string) {
    this.get(channelId); if (!UUID.test(requestId)) throw new Error("invalid channel receipt");
    return { channelId, requestId, state: this.history(channelId).read().turns.some(row => row.id === requestId) ? "accepted" : "unknown" };
  }
  private context(channelId: string) {
    const snapshot = this.snapshot(channelId);
    return JSON.stringify({ channel: snapshot.channel.name, members: snapshot.channel.memberIds.map(id => ({ agentId: id, name: this.host.agents().find(row => row.agentId === id)?.identity.displayName ?? id })),
      messages: snapshot.messages.map(row => ({ sender: row.agentId ? row.displayName : "User", message: row.message })) });
  }
  send(clientId: string, channelId: string, body: string, requestId: string, recipientIds: unknown) {
    const channel = this.get(channelId);
    if (!this.host.accepting() || !messageBody(body) || !UUID.test(requestId) || !ids(recipientIds) || recipientIds.some(id => !channel.memberIds.includes(id))) throw new Error("invalid local channel message or recipients");
    this.members(recipientIds);
    const state = this.history(channelId), before = state.read(), digest = createHash("sha256").update(canonical([body, recipientIds])).digest("hex");
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
        value.turns.push({ id: requestId, digest, body: redactSensitiveText(body).text, createdAt: new Date().toISOString(), state: "running", replies: recipientIds.map(agentId => ({ agentId,
          displayName: this.host.agents().find(row => row.agentId === agentId)!.identity.displayName, requestId: randomUUID(), runId: null, startIndex: 0, endIndex: null, state: "queued" })) }); return value;
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
      const turn = this.history(channelId).read().turns.find(row => row.id === turnId)!;
      for (const [index, reply] of turn.replies.entries()) {
        active.lease.assertCurrent();
        if (active.cancelled || !this.host.accepting()) break;
        let admitted = false;
        try {
          const store = new WorkspaceConversationStore(this.storage, reply.agentId, channelId), startIndex = store.read().history.length;
          this.changeReply(channelId, turnId, index, row => { row.startIndex = startIndex; row.state = "running"; });
          const accepted = this.host.start(reply.agentId, turn.body, reply.requestId, channelId, this.context(channelId), clientId);
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
