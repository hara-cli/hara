// Host-private terminal outcomes + durable notification effects. No SDK/global credentials/tick here.
import { createHash } from "node:crypto";
import { parseDeliver } from "../cron/deliver.js";
import { redactSensitiveText } from "../security/secrets.js";
import { redactToolSubprocessOutput } from "../security/subprocess-env.js";
import { canonical, plain, text, UUID, WorkspaceJsonState } from "./local-state.js";
import { sameWorkspaceResourceBinding, type WorkspaceResourceBinding, type WorkspaceResourceStorage } from "./resource-context.js";
import type { WorkspaceFeatures, WorkspaceSchedule } from "./features.js";
import type { LegacyCommandReview } from "./legacy-command.js";

const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const cooldown = 6 * 3600_000;
function syncFence(action: () => void) {
  const value: unknown = action(); if (value === undefined) return;
  if (value && typeof (value as { then?: unknown }).then === "function") void Promise.resolve(value).catch(() => {});
  throw new Error("Notification authority must be synchronous");
}
export interface LegacyTerminalOutcome {
  requestId: string; runId: string; scheduleId: string; definitionHash: string; status: "ok" | "error" | "timed_out";
  output: string; hadStdout: boolean; finishedAt: number;
}
interface Count { scheduleId: string; definitionHash: string; consecutiveErrors: number; lastAlertAt: number | null }
export interface LegacyNotificationEffect {
  id: string; requestId: string; scheduleId: string; definitionHash: string; kind: "outcome" | "alert";
  target: string; body: string; state: "pending" | "sending" | "sent" | "unknown" | "blocked"; receiptId: string | null;
}
interface State { revision: number; resourceBinding: WorkspaceResourceBinding; outcomes: { requestId: string; hash: string; scheduleId: string; definitionHash: string; runId: string; status: string }[]; counts: Count[]; effects: LegacyNotificationEffect[] }
export interface LegacyNotificationReview { workspaceId: string; resourceBinding: WorkspaceResourceBinding; effectId: string; scheduleId: string; definitionHash: string; kind: "outcome" | "alert"; target: string }
export interface LegacyNotificationPermit {
  review: LegacyNotificationReview; assertCurrent(): void;
  /** A thrown request/unknown response is NOT evidence that nothing was sent. Never auto-retry it. */
  send(input: Readonly<{ target: string; text: string; idempotencyKey: string; signal: AbortSignal }>): Promise<{ state: "sent"; receiptId: string } | { state: "not_sent" } | { state: "unknown" }>;
}
export class WorkspaceLegacyOutcomes {
  private readonly state: WorkspaceJsonState<State>;
  private readonly active = new Map<string, Promise<LegacyNotificationEffect>>();
  constructor(private readonly storage: WorkspaceResourceStorage, private readonly features: WorkspaceFeatures,
    private readonly options: { authorize(review: Readonly<LegacyNotificationReview>): LegacyNotificationPermit | undefined;
      knownSecrets?: readonly string[]; now?: () => number; deliveryTimeoutMs?: number }) {
    if (options.deliveryTimeoutMs !== undefined && (!Number.isSafeInteger(options.deliveryTimeoutMs) || options.deliveryTimeoutMs < 10 || options.deliveryTimeoutMs > 300000)) throw new Error("Invalid explicit notification deadline");
    this.state = new WorkspaceJsonState(storage, "workspace-legacy-outcomes-v1.json", raw => {
      if (!plain(raw) || !sameWorkspaceResourceBinding(raw.resourceBinding as WorkspaceResourceBinding, this.state.binding())
        || !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 1 || !Array.isArray(raw.outcomes) || raw.outcomes.length > 256
        || !Array.isArray(raw.counts) || raw.counts.length > 4096 || !Array.isArray(raw.effects) || raw.effects.length > 512) throw new Error("Invalid legacy outcome ledger; no effects replayed");
      for (const row of raw.outcomes) if (!plain(row) || typeof row.requestId !== "string" || !UUID.test(row.requestId) || !digest(row.hash) || !text(row.scheduleId)
        || !digest(row.definitionHash) || typeof row.runId !== "string" || !UUID.test(row.runId) || !["ok", "error", "timed_out"].includes(String(row.status))) throw new Error("Invalid terminal outcome identity");
      for (const row of raw.counts) if (!plain(row) || !text(row.scheduleId) || !digest(row.definitionHash) || !Number.isSafeInteger(row.consecutiveErrors) || Number(row.consecutiveErrors) < 0
        || !(row.lastAlertAt === null || typeof row.lastAlertAt === "number" && Number.isFinite(row.lastAlertAt) && row.lastAlertAt >= 0)) throw new Error("Invalid legacy error counter");
      for (const row of raw.effects) if (!plain(row) || !digest(row.id) || typeof row.requestId !== "string" || !UUID.test(row.requestId) || !text(row.scheduleId) || !digest(row.definitionHash)
        || !["outcome", "alert"].includes(String(row.kind)) || !text(row.target, 4096) || typeof row.body !== "string" || row.body.length > 2000
        || !["pending", "sending", "sent", "unknown", "blocked"].includes(String(row.state)) || !(row.receiptId === null || text(row.receiptId))) throw new Error("Invalid notification effect");
      if (new Set(raw.outcomes.map(row => row.requestId)).size !== raw.outcomes.length || new Set(raw.effects.map(row => row.id)).size !== raw.effects.length
        || new Set(raw.counts.map(row => row.scheduleId)).size !== raw.counts.length) throw new Error("Duplicate legacy effect identity");
      return structuredClone(raw) as unknown as State;
    }, () => ({ revision: 0, resourceBinding: this.state.binding(), outcomes: [], counts: [], effects: [] }));
  }
  private row(id: string) {
    const row = this.features.schedules().find(row => row.id === id);
    if (!row || row.workspaceId !== this.storage.scope.workspaceId || row.source !== "legacy-v1" || !plain(row.definition.legacy)
      || row.definition.legacy.quarantined !== false) throw new Error("Reviewed schedule outcome unavailable");
    return row;
  }
  private route(row: WorkspaceSchedule): string | undefined {
    const route = row.definition.deliver; if (route === undefined) return undefined;
    if (!text(route, 4096) || "error" in parseDeliver(route) || redactSensitiveText(route).redactions.length
      || this.options.knownSecrets?.some(value => value.length >= 4 && route.includes(value))) throw new Error("Reviewed delivery target unavailable");
    return route;
  }
  preflight(review: Readonly<LegacyCommandReview>): void {
    const row = this.row(review.scheduleId);
    if (hash(row) !== review.definitionHash || review.workspaceId !== this.storage.scope.workspaceId
      || !sameWorkspaceResourceBinding(review.resourceBinding, this.state.binding())) throw new Error("Notification preflight scope changed");
    this.route(row); const current = this.state.read();
    if (current.outcomes.length >= 256 && !current.outcomes.some(row => row.requestId === review.requestId) || current.effects.length > 510) throw new Error("Outcome retention requires inspection before launch");
  }
  list() {
    const raw = this.state.read();
    return { ...raw, effects: raw.effects.map(row => row.state === "sending" && !this.active.has(row.id) ? { ...row, state: "unknown" as const } : row) };
  }
  completed(requestId: string, scheduleId: string, definitionHash: string) {
    const state = this.state.read(), row = state.outcomes.find(row => row.requestId === requestId); if (!row) return null;
    if (row.scheduleId !== scheduleId || row.definitionHash !== definitionHash) throw new Error("Outcome identity conflicts; no work replayed");
    return { runId: row.runId, status: row.status, effects: state.effects.filter(row => row.requestId === requestId).map(row => row.id) };
  }
  record(outcome: LegacyTerminalOutcome): string[] {
    if (!outcome || typeof outcome.requestId !== "string" || !UUID.test(outcome.requestId) || typeof outcome.runId !== "string" || !UUID.test(outcome.runId)
      || !["ok", "error", "timed_out"].includes(outcome.status) || typeof outcome.output !== "string" || outcome.output.length > 8000
      || typeof outcome.hadStdout !== "boolean" || !Number.isFinite(outcome.finishedAt) || outcome.finishedAt < 0) throw new Error("Confirmed bounded terminal outcome required");
    const row = this.row(outcome.scheduleId); if (hash(row) !== outcome.definitionHash) throw new Error("Outcome definition changed; source preserved");
    const before = this.state.read(), identity = hash(outcome), previous = before.outcomes.find(row => row.requestId === outcome.requestId);
    if (previous) {
      if (previous.hash !== identity) throw new Error("Outcome identity conflicts; nothing incremented or resent");
      return before.effects.filter(row => row.requestId === outcome.requestId).map(row => row.id);
    }
    if (before.outcomes.length >= 256 || before.effects.length > 510) throw new Error("Outcome retention requires inspection; no identities discarded");
    const target = this.route(row), old = before.counts.find(item => item.scheduleId === row.id && item.definitionHash === outcome.definitionHash);
    const legacyCount = typeof row.definition.consecutiveErrors === "number" ? row.definition.consecutiveErrors : 0;
    const errors = outcome.status === "ok" ? 0 : (old?.consecutiveErrors ?? legacyCount) + 1;
    if (!Number.isSafeInteger(errors) || errors < 0) throw new Error("Error counter requires review");
    // The old scheduler treats 0 as "never alerted", not a cooldown starting at Unix epoch.
    const lastAlertAt = old?.lastAlertAt ?? (typeof row.definition.lastAlertAt === "number" && row.definition.lastAlertAt > 0 ? row.definition.lastAlertAt : null);
    const newEffects: LegacyNotificationEffect[] = [];
    const enqueue = (kind: "outcome" | "alert", body: string) => {
      const secrets = Object.fromEntries((this.options.knownSecrets ?? []).map((value, i) => [`SECRET_${i}`, value]));
      const safe = redactToolSubprocessOutput(body, {}, secrets).slice(0, 2000);
      newEffects.push({ id: hash([this.state.binding(), outcome.requestId, outcome.runId, kind, target]), requestId: outcome.requestId,
        scheduleId: row.id, definitionHash: outcome.definitionHash, kind, target: target!, body: safe, state: "pending", receiptId: null });
    };
    if (target) {
      const mode = row.definition.deliverMode ?? "always";
      if (!["always", "on-output", "on-error"].includes(String(mode))) throw new Error("Delivery noise policy requires review");
      if (mode === "always" || mode === "on-output" && outcome.hadStdout || mode === "on-error" && outcome.status !== "ok") {
        enqueue("outcome", `⏰ ${row.name} ${outcome.status === "ok" ? "✓" : "✗"}\n${outcome.output.slice(0, 1500)}`);
      }
      const threshold = row.definition.alertAfter ?? 3;
      if (!Number.isSafeInteger(threshold) || Number(threshold) < 1 || Number(threshold) > 1000) throw new Error("Alert threshold requires review");
      if (outcome.status !== "ok" && errors >= Number(threshold) && (lastAlertAt === null || outcome.finishedAt - lastAlertAt > cooldown)
        && !before.effects.some(item => item.scheduleId === row.id && item.kind === "alert" && item.state !== "sent")) {
        enqueue("alert", `🚨 ${row.name} has failed ${errors}× in a row; inspect scoped receipt ${outcome.requestId}.`);
      }
    }
    this.state.update(before.revision, value => ({ ...value, outcomes: [...value.outcomes, { requestId: outcome.requestId, hash: identity, scheduleId: row.id,
      definitionHash: outcome.definitionHash, runId: outcome.runId, status: outcome.status }],
      counts: [...value.counts.filter(item => item.scheduleId !== row.id), { scheduleId: row.id, definitionHash: outcome.definitionHash, consecutiveErrors: errors, lastAlertAt }],
      effects: [...value.effects, ...newEffects] }));
    return newEffects.map(row => row.id);
  }
  flush(id: string): Promise<LegacyNotificationEffect> {
    const pending = this.active.get(id); if (pending) return pending;
    const effect = this.list().effects.find(row => row.id === id); if (!effect) return Promise.reject(new Error("Scoped notification unavailable"));
    if (effect.state !== "pending") return Promise.resolve(effect);
    const before = this.state.read(); this.state.update(before.revision, value => ({ ...value, effects: value.effects.map(row => row.id === id ? { ...row, state: "sending" } : row) }));
    const operation = Promise.resolve().then(() => this.send(effect)); this.active.set(id, operation);
    void operation.finally(() => this.active.delete(id)).catch(() => {}); return operation;
  }
  private async send(effect: LegacyNotificationEffect) {
    let next: LegacyNotificationEffect["state"] = "blocked", receiptId: string | null = null, invoked = false;
    try {
      const row = this.row(effect.scheduleId); if (hash(row) !== effect.definitionHash || this.route(row) !== effect.target) throw new Error();
      const review: LegacyNotificationReview = { workspaceId: this.storage.scope.workspaceId, resourceBinding: this.state.binding(),
        effectId: effect.id, scheduleId: effect.scheduleId, definitionHash: effect.definitionHash, kind: effect.kind, target: effect.target };
      const permit = this.options.authorize(Object.freeze(structuredClone(review)));
      if (permit && typeof (permit as unknown as { then?: unknown }).then === "function") { void Promise.resolve(permit).catch(() => {}); throw new Error(); }
      if (!permit || canonical(permit.review) !== canonical(review) || typeof permit.send !== "function") throw new Error();
      syncFence(() => permit.assertCurrent());
      invoked = true; const abort = new AbortController(); let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<{ state: "unknown" }>(resolve => { timer = setTimeout(() => { abort.abort(); resolve({ state: "unknown" }); }, this.options.deliveryTimeoutMs ?? 30000); });
      let result: Awaited<ReturnType<LegacyNotificationPermit["send"]>>;
      try { result = await Promise.race([Promise.resolve().then(() => permit.send(Object.freeze({ target: effect.target, text: effect.body, idempotencyKey: effect.id, signal: abort.signal }))), deadline]); }
      finally { if (timer) clearTimeout(timer); }
      syncFence(() => permit.assertCurrent());
      if (result?.state === "sent" && text(result.receiptId, 128) && /^[A-Za-z0-9_-]+$/.test(result.receiptId)
        && !redactSensitiveText(result.receiptId).redactions.length
        && !this.options.knownSecrets?.some(secret => secret.length >= 4 && result.receiptId.includes(secret))) { next = "sent"; receiptId = result.receiptId; }
      else if (result?.state === "not_sent") next = "blocked"; else next = "unknown";
    } catch { next = invoked ? "unknown" : "blocked"; }
    const current = this.state.read();
    this.state.update(current.revision, value => ({ ...value, effects: value.effects.map(row => row.id === effect.id ? { ...row, state: next, receiptId } : row),
      counts: value.counts.map(row => row.scheduleId === effect.scheduleId && row.definitionHash === effect.definitionHash && effect.kind === "alert" && next === "sent"
        ? { ...row, lastAlertAt: (this.options.now ?? Date.now)() } : row) }));
    return this.list().effects.find(row => row.id === effect.id)!;
  }
}
