// P3 is a closed execution seam. These guards exercise synthetic admission without granting
// model/provider access; serialized policy, lineage and ledger data are never execution authority.
import { join } from "node:path";
import { isWorkspaceAgentId } from "./agent-binding.js";
import { channelSessionId } from "./channel-session.js";
import { canonical, exact, plain, UUID, WorkspaceJsonState } from "./local-state.js";
import { currentWorkspaceResourceBinding, inspectWorkspaceResourceFile, sameWorkspaceResourceBinding,
  workspaceStateHome, type WorkspaceResourceBinding, type WorkspaceResourceStorage } from "./resource-context.js";
import { WorkspaceSessionLease } from "./session-lease.js";

export interface ChannelAutonomyPolicy {
  schemaVersion: 1;
  mode: "off" | "mention" | "ambient";
  mutedAgentIds: string[];
  pausedUntil?: string;
  cooldownMs: 600000;
}
export const CHANNEL_AUTONOMY_LIMITS = Object.freeze({ maxHops: 1, maxSpeechesPerAgentPerTurn: 1,
  cooldownMs: 600000, maxStartsPerMinute: 3, pauseMs: 30 * 60000 } as const);
export const CHANNEL_AUTONOMY_BUDGET = Object.freeze({ maxRounds: 3, maxToolCalls: 32, maxTokens: 16000, timeoutMs: 60000 } as const);
const MAX_ROOTS = 1024;
// The three governance state tools are explicit exceptions, not general read authority. This
// module only checks names and synthetic accounting; it never executes their parameters. Real
// integration must also cap task_intake at applyTaskBrief through the trusted execution permit.
const readonlyTools = new Set(["workspace_read", "workspace_verify", "workspace_receipt_read", "workspace_context_lookup",
  "workspace_memory_search", "workspace_skill", "channel_sync", "agent_list", "task_intake", "task_checkpoint", "todo_write"]);
type Refusal = "ambient_disabled" | "invalid_channel_autonomy" | "untrusted_source" | "untrusted_admission"
  | "root_turn_replayed" | "root_capacity" | "depth_limit" | "hop_limit" | "already_spoken" | "not_member"
  | "mode_off" | "mention_only" | "muted" | "paused" | "cooldown" | "channel_rate" | "clock_regressed"
  | "answer_only" | "brief_required" | "tool_forbidden" | "round_budget" | "tool_budget" | "token_budget"
  | "unknown_usage" | "model_pending" | "no_model_pending" | "deadline" | "admission_closed";
export class ChannelAutonomyError extends Error {
  constructor(readonly reason: Refusal) { super(`Channel autonomy refused (${reason})`); }
}
function refuse(reason: Refusal): never { throw new ChannelAutonomyError(reason); }
const milliseconds = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
function members(value: readonly string[]): void {
  if (!Array.isArray(value) || value.some(id => !isWorkspaceAgentId(id)) || new Set(value).size !== value.length) refuse("invalid_channel_autonomy");
}
function memberList(value: unknown, roster?: readonly string[]): value is string[] {
  return Array.isArray(value) && value.every(id => isWorkspaceAgentId(id) && (!roster || roster.includes(id)))
    && new Set(value).size === value.length;
}
function iso(value: unknown): string {
  if (typeof value !== "string") refuse("invalid_channel_autonomy");
  const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.exec(value);
  if (!match) refuse("invalid_channel_autonomy");
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()
    || Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59) refuse("invalid_channel_autonomy");
  const parsed = Date.parse(value);
  if (!milliseconds(parsed)) refuse("invalid_channel_autonomy");
  return new Date(parsed).toISOString();
}
/** Read compatibility is deliberately broader than public write admission. ambient is inert data. */
export function readChannelAutonomy(value: unknown | undefined, memberIds: readonly string[]): ChannelAutonomyPolicy {
  members(memberIds);
  if (value === undefined) return { schemaVersion: 1, mode: "mention", mutedAgentIds: [], cooldownMs: 600000 };
  const optional = ["mutedAgentIds", "pausedUntil", "cooldownMs"];
  if (!plain(value) || !exact(value, ["schemaVersion", "mode", ...optional.filter(key => Object.hasOwn(value, key))])
    || value.schemaVersion !== 1 || typeof value.mode !== "string" || !["off", "mention", "ambient"].includes(value.mode)
    || (Object.hasOwn(value, "mutedAgentIds") && !memberList(value.mutedAgentIds, memberIds))
    || (Object.hasOwn(value, "cooldownMs") && value.cooldownMs !== 600000)) refuse("invalid_channel_autonomy");
  return { schemaVersion: 1, mode: value.mode as ChannelAutonomyPolicy["mode"],
    mutedAgentIds: value.mutedAgentIds === undefined ? [] : [...value.mutedAgentIds as string[]],
    ...(Object.hasOwn(value, "pausedUntil") ? { pausedUntil: iso(value.pausedUntil) } : {}), cooldownMs: 600000 };
}
export function parseChannelAutonomyUpdate(value: unknown, memberIds: readonly string[], nowMs = Date.now()): ChannelAutonomyPolicy {
  if (value === undefined || !milliseconds(nowMs)) refuse("invalid_channel_autonomy");
  const policy = readChannelAutonomy(value, memberIds);
  if (policy.mode === "ambient") refuse("ambient_disabled");
  if (policy.pausedUntil && Date.parse(policy.pausedUntil) > nowMs + CHANNEL_AUTONOMY_LIMITS.pauseMs) refuse("invalid_channel_autonomy");
  return policy;
}
/** No enable flag, environment branch, provider callback or serialized object can open P3. */
export function assertChannelAutonomyProductionDispatch(): never { return refuse("ambient_disabled"); }

declare const sourceBrand: unique symbol;
declare const admissionBrand: unique symbol;
export interface ChannelAutonomySource { readonly [sourceBrand]: true }
export interface ChannelAutonomyAdmission { readonly [admissionBrand]: true }
interface Source { rootTurnId: string; origin: "user" | "autonomy"; depth: 0 | 1 }
interface Admission extends Source { agentId: string; startedAt: number; lastObservedMs: number; modelCalls: number; toolCalls: number;
  tokens: number; brief: boolean; modelPending: boolean; closed: boolean }
interface Root { turnId: string; acceptedAt: number; spokenAgentIds: string[]; hops: 0 | 1 }
interface Ledger { schemaVersion: 1; revision: number; resourceBinding: WorkspaceResourceBinding; channelId: string;
  roots: Root[]; lastAutonomousAt: Record<string, number>; starts: number[]; clockMs: number }
export interface ChannelAutonomyGuardHost {
  policy(): ChannelAutonomyPolicy;
  members(): readonly string[];
  lease: WorkspaceSessionLease;
  /** Trusted synthetic clock only. This never controls execution admission. */
  now?(): number;
}
export type ChannelAutonomyAdmissionResult = { accepted: false; reason: Refusal }
  | { accepted: true; admission: ChannelAutonomyAdmission };

/** Host-only synthetic state machine. It has no model/tool execution callback and creates no
 * RuntimeStage identity, run, attempt, conversation, provider, approval card or executable permit. */
export class ChannelAutonomyGuard {
  readonly #binding: WorkspaceResourceBinding;
  readonly #ledger: WorkspaceJsonState<Ledger>;
  readonly #sources = new WeakMap<object, Source>();
  readonly #admissions = new WeakMap<object, Admission>();
  readonly #policy: () => ChannelAutonomyPolicy;
  readonly #members: () => readonly string[];
  readonly #lease: WorkspaceSessionLease;
  readonly #now: () => number;
  #ledgerSnapshot?: string;
  constructor(private readonly storage: WorkspaceResourceStorage, readonly channelId: string, host: ChannelAutonomyGuardHost) {
    if (!UUID.test(channelId) || !(host.lease instanceof WorkspaceSessionLease)
      || host.lease.sessionId !== channelSessionId(channelId, "room-queue")) refuse("invalid_channel_autonomy");
    this.#policy = host.policy; this.#members = host.members; this.#lease = host.lease; this.#now = host.now ?? Date.now;
    this.#binding = storage.run(() => ({ ...currentWorkspaceResourceBinding()! }));
    this.#ledger = new WorkspaceJsonState(storage, `local-channel-autonomy-${channelId}.json`, value => this.parseLedger(value),
      () => ({ schemaVersion: 1, revision: 0, resourceBinding: { ...this.#binding }, channelId,
        roots: [], lastAutonomousAt: {}, starts: [], clockMs: 0 }));
    this.assertCurrent();
  }
  private assertCurrent(): void {
    this.#lease.assertCurrent();
    this.storage.run(() => {
      if (!sameWorkspaceResourceBinding(this.#binding, currentWorkspaceResourceBinding()!)) throw new Error("Channel autonomy resource changed");
      // A foreign Workspace can use the same room UUID. Check the exact live lease inside OUR
      // scoped storage as well as the caller-held lease receipt; sessionId alone is insufficient.
      const snapshot = inspectWorkspaceResourceFile(join(workspaceStateHome(), ".hara", "workspace-run-locks", `${this.#lease.sessionId}.json`), 4096).snapshot;
      const owner: unknown = snapshot ? JSON.parse(snapshot.text) : null;
      if (!plain(owner) || owner.sessionId !== this.#lease.sessionId || owner.attemptId !== this.#lease.attemptId
        || !sameWorkspaceResourceBinding(owner.resourceBinding as WorkspaceResourceBinding, this.#binding)) throw new Error("Channel autonomy requires this Workspace's current room lease");
    });
  }
  private parseLedger(value: unknown): Ledger {
    const invalid = (): never => { throw new Error("Invalid channel autonomy ledger; retained, no admission"); };
    if (!plain(value) || !exact(value, ["schemaVersion", "revision", "resourceBinding", "channelId", "roots", "lastAutonomousAt", "starts", "clockMs"])
      || value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1 || value.channelId !== this.channelId
      || !sameWorkspaceResourceBinding(value.resourceBinding as WorkspaceResourceBinding, this.#binding) || !milliseconds(value.clockMs)
      || !Array.isArray(value.roots) || value.roots.length > MAX_ROOTS || !plain(value.lastAutonomousAt)
      || !Array.isArray(value.starts) || value.starts.length > CHANNEL_AUTONOMY_LIMITS.maxStartsPerMinute) return invalid();
    const seen = new Set<string>();
    for (const root of value.roots) {
      if (!plain(root) || !exact(root, ["turnId", "acceptedAt", "spokenAgentIds", "hops"]) || typeof root.turnId !== "string" || !UUID.test(root.turnId)
        || seen.has(root.turnId) || !milliseconds(root.acceptedAt) || root.acceptedAt > value.clockMs
        || !memberList(root.spokenAgentIds) || !(root.hops === 0 || root.hops === 1)) return invalid();
      seen.add(root.turnId);
    }
    if (Object.entries(value.lastAutonomousAt).some(([id, at]) => !isWorkspaceAgentId(id) || !milliseconds(at) || at > Number(value.clockMs))
      || value.starts.some((at, index, all) => !milliseconds(at) || at > Number(value.clockMs) || (index > 0 && at < Number(all[index - 1])))) return invalid();
    return structuredClone(value) as unknown as Ledger;
  }
  private clock(state: Ledger): number {
    const now = this.#now();
    if (!milliseconds(now) || now < state.clockMs) refuse("clock_regressed");
    return now;
  }
  private readLedger(): Ledger {
    const state = this.#ledger.read(), snapshot = canonical(state);
    if (this.#ledgerSnapshot !== undefined && this.#ledgerSnapshot !== snapshot) throw new Error("Channel autonomy ledger changed outside its owner; retained");
    this.#ledgerSnapshot = snapshot; return state;
  }
  private updateLedger(before: Ledger, change: (state: Ledger) => Ledger): void {
    const next = this.#ledger.update(before.revision, state => {
      if (canonical(state) !== this.#ledgerSnapshot) throw new Error("Channel autonomy ledger changed outside its owner; retained");
      return change(state);
    });
    this.#ledgerSnapshot = canonical(next);
  }
  private policy(): ChannelAutonomyPolicy { return readChannelAutonomy(this.#policy(), this.#members()); }
  private eligible(policy: ChannelAutonomyPolicy, agentId: string, now: number): Refusal | null {
    if (!this.#members().includes(agentId)) return "not_member";
    if (policy.mode === "off") return "mode_off";
    if (policy.mode === "mention") return "mention_only";
    if (policy.mutedAgentIds.includes(agentId)) return "muted";
    if (policy.pausedUntil && Date.parse(policy.pausedUntil) > now) return "paused";
    return null;
  }
  /** Call only after the trusted Host first accepts a user turn. Duplicate requests, disk reloads
   * and process restarts must not reconstruct this witness. Existing roots fail closed forever. */
  acceptUserTurn(turnId: string, spokenAgentIds: readonly string[] = []): ChannelAutonomySource {
    this.assertCurrent();
    const roster = this.#members(); members(roster);
    if (!UUID.test(turnId) || !memberList(spokenAgentIds, roster)) refuse("invalid_channel_autonomy");
    const before = this.readLedger(), now = this.clock(before);
    this.updateLedger(before, state => {
      this.assertCurrent();
      if (state.roots.some(root => root.turnId === turnId)) refuse("root_turn_replayed");
      if (state.roots.length >= MAX_ROOTS) refuse("root_capacity");
      state.clockMs = now; state.roots.push({ turnId, acceptedAt: now, spokenAgentIds: [...spokenAgentIds], hops: 0 }); return state;
    });
    const source = Object.freeze({}) as ChannelAutonomySource;
    this.#sources.set(source, { rootTurnId: turnId, origin: "user", depth: 0 }); return source;
  }
  autonomousSource(admission: ChannelAutonomyAdmission): ChannelAutonomySource {
    this.assertCurrent();
    const data = this.admission(admission), source = Object.freeze({}) as ChannelAutonomySource;
    this.#sources.set(source, { rootTurnId: data.rootTurnId, origin: "autonomy", depth: 1 }); return source;
  }
  admitSynthetic(source: ChannelAutonomySource, agentId: string): ChannelAutonomyAdmissionResult {
    this.assertCurrent();
    const data = source && typeof source === "object" ? this.#sources.get(source) : undefined;
    if (!data) return { accepted: false, reason: "untrusted_source" };
    if (data.origin !== "user" || data.depth !== 0) return { accepted: false, reason: "depth_limit" };
    const before = this.readLedger(), now = this.clock(before);
    const check = (state: Ledger): Refusal | null => {
      const policyRefusal = this.eligible(this.policy(), agentId, now); if (policyRefusal) return policyRefusal;
      const root = state.roots.find(row => row.turnId === data.rootTurnId);
      if (!root) return "untrusted_source";
      if (root.spokenAgentIds.includes(agentId)) return "already_spoken";
      if (root.hops >= CHANNEL_AUTONOMY_LIMITS.maxHops) return "hop_limit";
      if (Object.hasOwn(state.lastAutonomousAt, agentId) && now - state.lastAutonomousAt[agentId]! < CHANNEL_AUTONOMY_LIMITS.cooldownMs) return "cooldown";
      if (state.starts.filter(at => at > now - 60000).length >= CHANNEL_AUTONOMY_LIMITS.maxStartsPerMinute) return "channel_rate";
      return null;
    };
    const reason = check(before); if (reason) return { accepted: false, reason };
    this.updateLedger(before, state => {
      this.assertCurrent(); const changed = check(state); if (changed) refuse(changed);
      const root = state.roots.find(row => row.turnId === data.rootTurnId)!;
      root.hops = 1; root.spokenAgentIds.push(agentId); state.lastAutonomousAt[agentId] = now;
      state.starts = [...state.starts.filter(at => at > now - 60000), now]; state.clockMs = now; return state;
    });
    const admission = Object.freeze({}) as ChannelAutonomyAdmission;
    this.#admissions.set(admission, { rootTurnId: data.rootTurnId, origin: "autonomy", depth: 1, agentId, startedAt: now, lastObservedMs: now,
      modelCalls: 0, toolCalls: 0, tokens: 0, brief: false, modelPending: false, closed: false });
    return { accepted: true, admission };
  }
  private admission(value: ChannelAutonomyAdmission): Admission {
    const data = value && typeof value === "object" ? this.#admissions.get(value) : undefined;
    if (!data) refuse("untrusted_admission"); return data;
  }
  private active(value: ChannelAutonomyAdmission): Admission {
    this.assertCurrent(); const data = this.admission(value);
    if (data.closed) refuse("admission_closed");
    let now: number;
    try { now = this.clock(this.readLedger()); } catch (error) { data.closed = true; throw error; }
    const policyRefusal = this.eligible(this.policy(), data.agentId, now);
    if (now < data.lastObservedMs) { data.closed = true; refuse("clock_regressed"); }
    data.lastObservedMs = now;
    if (policyRefusal) { data.closed = true; refuse(policyRefusal); }
    if (now - data.startedAt >= CHANNEL_AUTONOMY_BUDGET.timeoutMs) { data.closed = true; refuse("deadline"); }
    return data;
  }
  acceptBrief(value: ChannelAutonomyAdmission, intent: unknown): void {
    const data = this.active(value);
    if (intent !== "answer") { data.closed = true; refuse("answer_only"); } data.brief = true;
  }
  beforeModel(value: ChannelAutonomyAdmission): void {
    const data = this.active(value);
    if (data.modelPending) refuse("model_pending");
    if (data.modelCalls > 0 && !data.brief) refuse("brief_required");
    if (data.modelCalls >= CHANNEL_AUTONOMY_BUDGET.maxRounds) refuse("round_budget");
    if (data.tokens >= CHANNEL_AUTONOMY_BUDGET.maxTokens) refuse("token_budget");
    data.modelCalls++; data.modelPending = true;
  }
  /** Synthetic, known usage only. This is not a claim that native CLI/provider spend is capped:
   * production dispatch remains closed until enforceable input/output accounting is integrated. */
  recordUsage(value: ChannelAutonomyAdmission, inputTokens: unknown, outputTokens: unknown): void {
    const data = this.active(value);
    if (!data.modelPending) refuse("no_model_pending");
    if (!milliseconds(inputTokens) || !milliseconds(outputTokens) || !Number.isSafeInteger(data.tokens + inputTokens + outputTokens)) {
      data.closed = true; refuse("unknown_usage");
    }
    data.modelPending = false; data.tokens += inputTokens + outputTokens;
    if (data.tokens > CHANNEL_AUTONOMY_BUDGET.maxTokens) { data.closed = true; refuse("token_budget"); }
  }
  beforeTool(value: ChannelAutonomyAdmission, name: string): void {
    const data = this.active(value);
    if (!readonlyTools.has(name)) refuse("tool_forbidden");
    if (data.modelPending) refuse("model_pending");
    if (name !== "task_intake" && !data.brief) refuse("brief_required");
    if (data.tokens >= CHANNEL_AUTONOMY_BUDGET.maxTokens) refuse("token_budget");
    if (data.toolCalls >= CHANNEL_AUTONOMY_BUDGET.maxToolCalls) refuse("tool_budget");
    data.toolCalls++;
  }
  complete(value: ChannelAutonomyAdmission): void {
    const data = this.active(value);
    if (data.modelPending) refuse("model_pending");
    if (!data.brief) refuse("brief_required"); data.closed = true;
  }
  describe(value: ChannelAutonomyAdmission): Readonly<{ origin: "autonomy"; rootTurnId: string; depth: 1; budget: typeof CHANNEL_AUTONOMY_BUDGET }> {
    this.assertCurrent(); const data = this.admission(value);
    return Object.freeze({ origin: "autonomy", rootTurnId: data.rootTurnId, depth: 1, budget: CHANNEL_AUTONOMY_BUDGET });
  }
}
