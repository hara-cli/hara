import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  NATIVE_HUB_LIMITS, NativeHubError, nativeIntentDigest, nativeSha256, parseNativeActionRef,
  parseNativeCommitParams, parseNativeControlFacts, parseNativeControlIntent, parseNativePrepareParams, parseNativeView,
  type NativeControlEffect, type NativeControlIntent, type NativeControlResult, type NativeControlTarget,
  type PreparedNativeControl,
} from "./native-control-contract.js";
import { type NativeHubAuth, type NativeHubSession } from "./native-control-auth.js";
import { type NativeActionRef, type NativeControlJournal, type NativeJournalEntry } from "./native-control-journal.js";

export interface NativeControlView {
  readonly workspaceId: string;
  readonly viewEpoch: number;
  readonly admissionEpoch: number;
  readonly maintenance: boolean;
  readonly journal: NativeControlJournal;
}
type Fence = () => void;
type Step<T> = T | Promise<T>;
type OtherEffect = Extract<NativeControlEffect, { kind: "launch" | "cleanup" }>;
type OtherResult = { effect: OtherEffect } | { rejected: "unsupported" | "busy" | "quota_exceeded" };

/** Trusted, per-scope Host ports. There are no default launcher, policy, or IO effects. */
export interface NativeControlPorts {
  /** Resolve the current main-window selection from Host state, never request parameters. */
  current(session: NativeHubSession): NativeControlView | null;
  facts(view: NativeControlView, target: NativeControlTarget): unknown;
  preflight(view: NativeControlView, target: NativeControlTarget): Promise<void>;
  /** Assert phase-specific postconditions and current launch, policy and selection witnesses. */
  assertEffectCurrent(view: NativeControlView, intent: NativeControlIntent, entry: NativeJournalEntry): void;
  /** Adapters invoke fence inside their own compare-and-publish boundary, after every blocking step. */
  stageGrant(intent: NativeControlIntent, entry: NativeJournalEntry, token: string, fence: Fence): Step<void>;
  publishGrant(intent: NativeControlIntent, entry: NativeJournalEntry, fence: Fence): Step<string>;
  publishHandoff(intent: NativeControlIntent, entry: NativeJournalEntry, fence: Fence): Step<string>;
  invalidateGrant(intent: NativeControlIntent, entry: NativeJournalEntry, fence: Fence): Step<string>;
  removeHandoff(intent: NativeControlIntent, entry: NativeJournalEntry, fence: Fence): Step<"removed" | "unknown">;
  applyOther(intent: NativeControlIntent, entry: NativeJournalEntry, fence: Fence): Step<OtherResult>;
}
interface Pending {
  readonly frozen: PreparedNativeControl;
  readonly session: NativeHubSession;
  readonly view: NativeControlView;
  readonly deadline: number;
  readonly selectionKey: string;
}

const denied = (code: "unauthorized" | "scope_changed" | "stale_intent" | "busy"): never => {
  throw new NativeHubError(code);
};
const safeFailure = (error: unknown): never => {
  throw error instanceof NativeHubError ? error : new NativeHubError("store_unavailable");
};
const identityOf = (view: NativeControlView) => JSON.stringify([
  view.workspaceId, view.viewEpoch, view.admissionEpoch, view.journal.binding,
]);
const actionRef = (value: NativeActionRef): NativeActionRef =>
  ({ operationId: value.operationId, intentDigest: value.intentDigest });
const pendingResult = (ref: NativeActionRef): NativeControlResult =>
  Object.freeze({ ...actionRef(ref), status: "pending", effect: null, error: null });
const unknownResult = (ref: NativeActionRef): NativeControlResult =>
  Object.freeze({ ...actionRef(ref), status: "unknown", effect: null, error: "outcome_unknown" });

/** Host-owned command state machine. confirm is reserved for the Native callback adapter. */
export class NativeHubControl {
  readonly #pending = new Map<string, Pending>();
  readonly #preparing = new Map<string, Promise<PreparedNativeControl>>();
  readonly #working = new Set<string>();

  constructor(private readonly auth: NativeHubAuth, private readonly ports: NativeControlPorts,
    private readonly now: () => number = () => performance.now()) {}

  /** Re-usable authorization gate for the future private read adapter. */
  authorizeView(session: NativeHubSession, input: unknown): NativeControlView {
    const view = this.#view(session, true), selection = parseNativeView(input);
    if (selection.workspaceId !== view.workspaceId || selection.viewEpoch !== view.viewEpoch) return denied("scope_changed");
    return view;
  }

  async prepare(session: NativeHubSession, input: unknown): Promise<PreparedNativeControl> {
    const view = this.#view(session, true), params = parseNativePrepareParams(input);
    if (params.workspaceId !== view.workspaceId || params.viewEpoch !== view.viewEpoch) return denied("scope_changed");
    this.#sweep();
    const key = JSON.stringify([session.id, identityOf(view), params.target]);
    const existing = [...this.#pending.values()].find(pending => pending.selectionKey === key);
    if (existing) {
      this.#assertFrozen(session, existing);
      return existing.frozen;
    }
    const preparing = this.#preparing.get(key);
    if (preparing) return preparing;
    if (this.#preparing.size + this.#pending.size >= NATIVE_HUB_LIMITS.pending) return denied("busy");
    const task = this.#prepare(session, view, params.target, key);
    this.#preparing.set(key, task);
    try { return await task; }
    finally { this.#preparing.delete(key); }
  }

  async #prepare(session: NativeHubSession, view: NativeControlView, target: NativeControlTarget,
    selectionKey: string): Promise<PreparedNativeControl> {
    try {
      const before = this.#facts(view, target);
      await this.ports.preflight(view, target);
      const current = this.#view(session, true, view);
      const facts = this.#facts(current, target);
      if (JSON.stringify(facts) !== JSON.stringify(before)) return denied("stale_intent");
      const operationId = randomUUID();
      const intent = parseNativeControlIntent({
        schemaVersion: 1, operationId, hostInstanceId: this.auth.hostInstanceId, nativeSessionId: session.id,
        workspaceId: current.workspaceId, viewEpoch: current.viewEpoch, binding: current.journal.binding,
        admissionEpoch: current.admissionEpoch, target, facts,
      });
      const frozen = Object.freeze({
        intent, intentDigest: nativeIntentDigest(intent), challenge: randomBytes(32).toString("hex"),
        expiresInMs: NATIVE_HUB_LIMITS.challengeMs,
      });
      this.#pending.set(operationId, { frozen, session, view: current, deadline: this.now() + NATIVE_HUB_LIMITS.challengeMs, selectionKey });
      return frozen;
    } catch (error) { return safeFailure(error); }
  }

  cancel(session: NativeHubSession, input: unknown): NativeControlResult {
    const view = this.#view(session, false), ref = parseNativeActionRef(input);
    const stored = view.journal.get(ref);
    if (stored) return this.#result(stored);
    const pending = this.#pending.get(ref.operationId);
    if (pending?.session === session) {
      this.#assertFrozen(session, pending);
      if (ref.intentDigest !== pending.frozen.intentDigest) throw new NativeHubError("conflict");
      this.#pending.delete(ref.operationId);
      return Object.freeze({ ...ref, status: "rejected", effect: null, error: "stale_intent" });
    }
    return unknownResult(ref);
  }

  status(session: NativeHubSession, input: unknown): NativeControlResult {
    const view = this.#view(session, false), ref = parseNativeActionRef(input);
    const stored = view.journal.get(ref);
    if (stored) return this.#result(stored);
    const pending = this.#pending.get(ref.operationId);
    if (!pending || pending.session !== session) return unknownResult(ref);
    this.#assertFrozen(session, pending);
    if (ref.intentDigest !== pending.frozen.intentDigest) throw new NativeHubError("conflict");
    return pendingResult(ref);
  }

  async confirm(session: NativeHubSession, input: unknown): Promise<NativeControlResult> {
    const view = this.#view(session, false), { challenge, ...ref } = parseNativeCommitParams(input);
    const stored = view.journal.get(ref);
    if (stored) return this.#result(stored);
    const pending = this.#pending.get(ref.operationId);
    if (!pending || pending.session !== session) return denied("stale_intent");
    if (pending.frozen.intentDigest !== ref.intentDigest) throw new NativeHubError("conflict");
    if (!timingSafeEqual(Buffer.from(challenge, "hex"), Buffer.from(pending.frozen.challenge, "hex")))
      return denied("unauthorized");
    this.#assertFrozen(session, pending);
    if (this.#working.has(ref.operationId)) return pendingResult(ref);
    this.#working.add(ref.operationId);
    try {
      const { intent } = pending.frozen;
      const fence = () => { this.#assertFrozen(session, pending); };
      await this.ports.preflight(view, intent.target);
      fence();
      const { entry, claimed } = view.journal.claim(intent, ref, fence);
      this.#pending.delete(ref.operationId);
      if (!claimed) return this.#result(entry);
      return await this.#apply(session, view, intent, entry);
    } catch (error) {
      this.#view(session, false, view);
      // A caller can lose the response after a filesystem publication. Query
      // the same claim and keep any unproven phase. Never dispatch it again.
      const committed = view.journal.get(ref);
      if (committed) return committed.outcome ?? unknownResult(ref);
      return safeFailure(error);
    } finally {
      this.#pending.delete(ref.operationId);
      this.#working.delete(ref.operationId);
    }
  }

  async #apply(session: NativeHubSession, view: NativeControlView, intent: NativeControlIntent,
    initial: NativeJournalEntry): Promise<NativeControlResult> {
    const { journal } = view;
    let entry = initial;
    const authorityFence = () => this.ports.assertEffectCurrent(this.#view(session, true, view), intent, entry);
    const effectFence = () => { authorityFence(); journal.assertPublishable(entry); };
    const change = (step: Parameters<NativeControlJournal["advance"]>[1]) => {
      // The journal moves its old file while replacing it. The authority
      // fence here must not try to read that exact journal during its CAS.
      entry = journal.advance(entry, step, authorityFence);
    };
    const settle = () => entry.outcome ?? unknownResult(entry);
    effectFence();
    if (intent.target.kind === "rotate" || intent.target.kind === "revoke") {
      const connectionId = intent.target.connectionId, kind = intent.target.kind;
      const catalogDigest = await this.ports.invalidateGrant(intent, entry, effectFence);
      if (kind === "revoke") change({ phase: "revoked", catalogDigest, effect: { kind, connectionId, handoff: "unknown" } });
      else change({ phase: "previous_revoked", catalogDigest });
      effectFence();
      const handoff = await this.ports.removeHandoff(intent, entry, effectFence);
      if (kind === "revoke") {
        change({ phase: "settled", effect: { kind, connectionId, handoff } });
        return settle();
      }
      if (handoff !== "removed") return unknownResult(entry);
    }
    if (intent.target.kind === "grant" || intent.target.kind === "rotate") {
      const connectionId = entry.connectionId, grantEpoch = entry.grantEpoch;
      if (connectionId === null || grantEpoch === null) throw new NativeHubError("store_unavailable");
      effectFence();
      const token = randomBytes(32).toString("hex");
      change({ phase: "staged", tokenDigest: nativeSha256(token) });
      effectFence();
      await this.ports.stageGrant(intent, entry, token, effectFence);
      effectFence();
      const catalogDigest = await this.ports.publishGrant(intent, entry, effectFence);
      change({ phase: "catalog_committed", catalogDigest });
      effectFence();
      const handoffDigest = await this.ports.publishHandoff(intent, entry, effectFence);
      change({ phase: "handoff_committed", handoffDigest, effect: { kind: intent.target.kind, connectionId, grantEpoch } });
    } else {
      effectFence();
      const result = await this.ports.applyOther(intent, entry, effectFence);
      change({ phase: "settled", ...result });
    }
    this.#view(session, false, view);
    return settle();
  }

  #view(session: NativeHubSession, mutation: boolean, expected?: NativeControlView): NativeControlView {
    this.auth.assertCurrent(session);
    let view: NativeControlView | null;
    try { view = this.ports.current(session); } catch (error) { return safeFailure(error); }
    if (!view || (expected && (view.journal !== expected.journal || identityOf(view) !== identityOf(expected)))) return denied("scope_changed");
    if (mutation && view.maintenance) return denied("busy");
    return Object.freeze({ ...view });
  }

  #facts(view: NativeControlView, target: NativeControlTarget) {
    try { return parseNativeControlFacts(this.ports.facts(view, target)); }
    catch (error) { return safeFailure(error); }
  }

  #assertFrozen(session: NativeHubSession, pending: Pending): void {
    const { intent } = pending.frozen, view = this.#view(session, true, pending.view);
    if (view.workspaceId !== intent.workspaceId || view.viewEpoch !== intent.viewEpoch || view.admissionEpoch !== intent.admissionEpoch
      || view.journal.binding.scopeKey !== intent.binding.scopeKey || view.journal.binding.generation !== intent.binding.generation)
      return denied("scope_changed");
    if (pending.session !== session || this.#pending.get(intent.operationId) !== pending || pending.deadline <= this.now())
      return denied("stale_intent");
    const facts = this.#facts(view, intent.target);
    if (JSON.stringify(facts) !== JSON.stringify(intent.facts)) return denied("stale_intent");
  }

  #sweep(): void {
    for (const [operationId, pending] of this.#pending) {
      try { this.#assertFrozen(pending.session, pending); }
      catch { this.#pending.delete(operationId); }
    }
  }

  #result(entry: NativeJournalEntry): NativeControlResult {
    return entry.outcome ?? (entry.hostInstanceId === this.auth.hostInstanceId && this.#working.has(entry.operationId)
      ? pendingResult(entry) : unknownResult(entry));
  }
}
