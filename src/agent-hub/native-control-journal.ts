import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import {
  assertPrivateStateDirectory, bindPrivateHaraStateFile, readPrivateStateFileSnapshotSync,
  withPrivateStateLockSync, writePrivateStateFileSync, type PrivateStateFileBinding,
} from "../security/private-state.js";
import { parseRegistryBinding, registryInstance, registryRecord } from "./registry-contract.js";
import {
  NATIVE_HUB_LIMITS, NativeHubError, parseNativeControlResult,
  type NativeControlEffect, type NativeControlIntent, type NativeControlResult, type NativeControlTarget,
} from "./native-control-contract.js";

export type NativeScopeBinding = NativeControlIntent["binding"];
export type NativeActionRef = Pick<NativeControlIntent, "operationId"> & { readonly intentDigest: string };
export type NativeJournalPhase =
  "claimed" | "previous_revoked" | "staged" | "catalog_committed" | "handoff_committed" | "revoked" | "settled";
type OperationKind = NativeControlTarget["kind"];
type Outcome = Extract<NativeControlResult, { status: "applied" | "rejected" }>;

export interface NativeJournalEntry extends NativeActionRef {
  readonly hostInstanceId: string;
  readonly kind: OperationKind;
  readonly phase: NativeJournalPhase;
  readonly connectionId: string | null;
  readonly grantEpoch: number | null;
  readonly launchRef: string | null;
  readonly policyDigest: string;
  readonly tokenDigest: string | null;
  readonly catalogDigest: string | null;
  readonly handoffDigest: string | null;
  readonly outcome: Outcome | null;
}
interface RevocationSlot { connectionId: string; operation: NativeJournalEntry | null }
interface State { entries: NativeJournalEntry[]; revocations: RevocationSlot[] }

export type NativeJournalWriteLane = "ordinary" | "reserved-revoke";
export interface NativeJournalPolicy {
  /** Trusted synchronous peak admission, with the quota transaction outside the journal lock. */
  transaction<T>(lane: NativeJournalWriteLane, action: () => T): T;
  admit(lane: NativeJournalWriteLane, previousBytes: number, nextBytes: number): void;
  /** The adapter accounts for physical publication separately from reservation. */
  publish<T>(previousBytes: number, nextBytes: number, action: () => T): T;
}
const REVOKE_SLOT_BYTES = 1024;
const MAX_JOURNAL_BYTES = 640 * 1024;
const KINDS = ["launch", "grant", "rotate", "revoke", "cleanup"] as const;
const PHASES = ["claimed", "previous_revoked", "staged", "catalog_committed", "handoff_committed", "revoked", "settled"] as const;
const invalid = (): never => { throw new NativeHubError("store_unavailable"); };
const isDigest = (value: unknown): value is string => typeof value === "string" && value.length === 64 && /^[a-f0-9]{64}$/.test(value);
const sameBinding = (a: NativeScopeBinding, b: NativeScopeBinding) => a.scopeKey === b.scopeKey && a.generation === b.generation;
const matches = (row: NativeJournalEntry, ref: NativeActionRef) => row.operationId === ref.operationId;

function readEntry(input: unknown): NativeJournalEntry {
  const row = registryRecord(input, ["operationId", "intentDigest", "hostInstanceId", "kind", "phase",
    "connectionId", "grantEpoch", "launchRef", "policyDigest", "tokenDigest", "catalogDigest", "handoffDigest", "outcome"]);
  if (!registryInstance(row.operationId) || !registryInstance(row.hostInstanceId) || !isDigest(row.intentDigest)
    || !KINDS.includes(row.kind as OperationKind) || !PHASES.includes(row.phase as NativeJournalPhase)
    || (row.connectionId !== null && !registryInstance(row.connectionId))
    || (row.grantEpoch !== null && (!Number.isSafeInteger(row.grantEpoch) || Number(row.grantEpoch) < 1))
    || (row.launchRef !== null && !registryInstance(row.launchRef)) || !isDigest(row.policyDigest)
    || [row.tokenDigest, row.catalogDigest, row.handoffDigest].some(value => value !== null && !isDigest(value))) return invalid();
  const kind = row.kind as OperationKind, phase = row.phase as NativeJournalPhase;
  const grant = kind === "grant" || kind === "rotate", connected = grant || kind === "revoke";
  if ([row.connectionId, row.grantEpoch, row.launchRef].some(value => (value !== null) !== connected)) return invalid();
  const usesToken = phase === "staged" || phase === "catalog_committed" || phase === "handoff_committed";
  const hasCatalog = phase === "catalog_committed" || phase === "handoff_committed"
    || phase === "revoked" || phase === "previous_revoked" || (phase === "settled" && kind === "revoke");
  if ((row.tokenDigest !== null) !== usesToken || (usesToken && !grant)
    || ((row.catalogDigest !== null) !== hasCatalog)
    || (grant && phase === "settled") || (phase === "previous_revoked" && kind !== "rotate") || (phase === "revoked" && kind !== "revoke")
    || (row.handoffDigest !== null) !== (phase === "handoff_committed")) return invalid();
  const outcome = row.outcome === null ? null : parseNativeControlResult(row.outcome);
  if ((outcome !== null) !== ["handoff_committed", "revoked", "settled"].includes(phase)) return invalid();
  if (outcome && (outcome.operationId !== row.operationId || outcome.intentDigest !== row.intentDigest
    || (outcome.status !== "applied" && outcome.status !== "rejected")
    || (outcome.status === "rejected" && (phase !== "settled" || connected))
    || (outcome.status === "applied" && (outcome.effect.kind !== kind
      || (connected && (!("connectionId" in outcome.effect) || outcome.effect.connectionId !== row.connectionId))
      || (grant && (!("grantEpoch" in outcome.effect) || outcome.effect.grantEpoch !== row.grantEpoch))
      || (phase === "revoked" && (outcome.effect.kind !== "revoke" || outcome.effect.handoff !== "unknown")))))) return invalid();
  return Object.freeze({ ...row, outcome }) as unknown as NativeJournalEntry;
}

function lookup(state: State, ref: NativeActionRef): NativeJournalEntry | null {
  const row = state.entries.find(value => matches(value, ref))
    ?? state.revocations.find(slot => slot.operation && matches(slot.operation, ref))?.operation ?? null;
  if (row && row.intentDigest !== ref.intentDigest) throw new NativeHubError("conflict");
  return row;
}
function findRevocation(state: State, connectionId: string | null): RevocationSlot {
  const slot = state.revocations.find(value => value.connectionId === connectionId);
  if (!slot) return invalid();
  return slot;
}
function render(state: State, binding: NativeScopeBinding): string {
  // Whitespace is paid at grant claim. A revoke and all its phases replace the
  // same number of bytes even with the whole ordinary history retained.
  const slots = state.revocations.map(slot => {
    const entry = JSON.stringify(slot);
    if (Buffer.byteLength(entry) > REVOKE_SLOT_BYTES) return invalid();
    return entry.padEnd(REVOKE_SLOT_BYTES, " ");
  });
  return '{"schemaVersion":1,"binding":' + JSON.stringify(binding)
    + ',"entries":' + JSON.stringify(state.entries) + ',"revocations":[' + slots.join(",") + ']}';
}

export class NativeControlJournal {
  readonly binding: NativeScopeBinding;
  readonly #namespace: readonly string[];
  readonly #file: PrivateStateFileBinding;
  #existed = false;

  constructor(private readonly home: string, binding: NativeScopeBinding, private readonly policy: NativeJournalPolicy) {
    this.binding = Object.freeze(parseRegistryBinding(binding));
    this.#namespace = ["agent-hub-native", binding.scopeKey, binding.generation];
    this.#file = bindPrivateHaraStateFile(home, this.#namespace, "operations.json");
  }

  get(ref: NativeActionRef): NativeJournalEntry | null {
    return this.#read(() => lookup(this.#snapshot().state, ref));
  }

  claim(intent: NativeControlIntent, ref: NativeActionRef, fence: () => void): {
    entry: NativeJournalEntry; claimed: boolean;
  } {
    if (!sameBinding(this.binding, intent.binding) || intent.operationId !== ref.operationId) return invalid();
    const kind = intent.target.kind;
    const lane = kind === "revoke" ? "reserved-revoke" : "ordinary";
    return this.#write<{ entry: NativeJournalEntry; claimed: boolean }>(lane, fence, state => {
      const prior = lookup(state, ref);
      if (prior) return { result: { entry: prior, claimed: false }, write: false };
      fence();
      const connectionId = kind === "grant" ? randomUUID()
        : kind === "rotate" || kind === "revoke" ? intent.target.connectionId : null;
      const grantEpoch = kind === "grant" ? 1 : kind === "rotate" ? (intent.facts.grantEpoch ?? 0) + 1 : intent.facts.grantEpoch;
      const entry = readEntry({ ...ref, hostInstanceId: intent.hostInstanceId, kind, phase: "claimed",
        connectionId, grantEpoch, launchRef: intent.facts.launch?.launchRef ?? null, policyDigest: intent.facts.policyDigest,
        tokenDigest: null, catalogDigest: null, handoffDigest: null, outcome: null });
      if (kind === "rotate" || kind === "revoke") {
        const original = state.entries.find(row => row.kind === "grant" && row.connectionId === connectionId);
        if (!original || original.launchRef !== entry.launchRef) throw new NativeHubError("stale_intent");
      }
      if (kind === "revoke") {
        const slot = findRevocation(state, connectionId);
        if (slot.operation) throw new NativeHubError("conflict");
        slot.operation = entry;
      } else {
        if (state.entries.length >= NATIVE_HUB_LIMITS.terminal
          || state.entries.filter(value => !value.outcome).length >= NATIVE_HUB_LIMITS.pending) throw new NativeHubError("busy");
        if (entry.launchRef && state.entries.some(value => value.launchRef === entry.launchRef && !value.outcome))
          throw new NativeHubError("busy");
        if (kind === "grant") {
          if (!connectionId || state.revocations.length >= NATIVE_HUB_LIMITS.connections) throw new NativeHubError("busy");
          for (const row of state.entries) {
            if (row.kind !== "grant" || row.launchRef !== entry.launchRef) continue;
            const retired = findRevocation(state, row.connectionId).operation?.outcome;
            if (retired?.status !== "applied" || retired.effect.kind !== "revoke" || retired.effect.handoff !== "removed")
              throw new NativeHubError("conflict");
          }
          state.revocations.push({ connectionId, operation: null });
        } else if (kind === "rotate" && findRevocation(state, connectionId).operation) {
          throw new NativeHubError("stale_intent");
        }
        state.entries.push(entry);
      }
      return { result: { entry, claimed: true }, write: true };
    });
  }

  assertPublishable(entry: NativeJournalEntry): void {
    if (entry.kind !== "grant" && entry.kind !== "rotate") return;
    this.#read(() => {
      const state = this.#snapshot().state;
      if (lookup(state, entry)?.phase !== entry.phase || findRevocation(state, entry.connectionId).operation)
        throw new NativeHubError("stale_intent");
    });
  }

  advance(entry: NativeJournalEntry, change: {
    phase: NativeJournalPhase; tokenDigest?: string; catalogDigest?: string; handoffDigest?: string;
    effect?: NativeControlEffect; rejected?: "unsupported" | "quota_exceeded" | "busy";
  }, fence: () => void): NativeJournalEntry {
    const lane = entry.kind === "revoke" ? "reserved-revoke" : "ordinary";
    return this.#write(lane, fence, state => {
      const current = lookup(state, entry);
      if (!current || JSON.stringify(current) !== JSON.stringify(entry)) return invalid();
      if ((entry.kind === "grant" || entry.kind === "rotate") && findRevocation(state, entry.connectionId).operation)
        throw new NativeHubError("stale_intent");
      const phase = change.phase;
      const valid = entry.kind === "grant" ? (entry.phase === "claimed" && phase === "staged")
          || (entry.phase === "staged" && phase === "catalog_committed")
          || (entry.phase === "catalog_committed" && phase === "handoff_committed")
        : entry.kind === "rotate" ? (entry.phase === "claimed" && phase === "previous_revoked")
          || (entry.phase === "previous_revoked" && phase === "staged")
          || (entry.phase === "staged" && phase === "catalog_committed")
          || (entry.phase === "catalog_committed" && phase === "handoff_committed")
        : entry.kind === "revoke" ? (entry.phase === "claimed" && phase === "revoked")
          || (entry.phase === "revoked" && phase === "settled")
        : entry.phase === "claimed" && phase === "settled";
      if (!valid) return invalid();
      const ref = { operationId: entry.operationId, intentDigest: entry.intentDigest };
      const outcome: Outcome | null = change.effect ? { ...ref, status: "applied", effect: change.effect, error: null }
        : change.rejected ? { ...ref, status: "rejected", effect: null, error: change.rejected } : null;
      const next = readEntry({ ...entry, phase, outcome,
        tokenDigest: change.tokenDigest ?? entry.tokenDigest,
        catalogDigest: phase === "staged" ? null : change.catalogDigest ?? entry.catalogDigest,
        handoffDigest: change.handoffDigest ?? entry.handoffDigest });
      if (entry.kind === "revoke") findRevocation(state, entry.connectionId).operation = next;
      else state.entries[state.entries.indexOf(current)] = next;
      return { result: next, write: true };
    });
  }

  #snapshot(): { state: State; text: string | null } {
    assertPrivateStateDirectory(this.#file.directory);
    const snapshot = readPrivateStateFileSnapshotSync(this.#file.path, MAX_JOURNAL_BYTES);
    assertPrivateStateDirectory(this.#file.directory);
    if (!snapshot) {
      if (this.#existed || readdirSync(this.#file.directory.path).some(name => /^\.hara-(claim|private)-/.test(name)))
        return invalid();
      return { state: { entries: [], revocations: [] }, text: null };
    }
    const envelope = registryRecord(JSON.parse(snapshot.text), ["schemaVersion", "binding", "entries", "revocations"]);
    this.#existed = true;
    if (envelope.schemaVersion !== 1 || !sameBinding(parseRegistryBinding(envelope.binding), this.binding)
      || !Array.isArray(envelope.entries) || envelope.entries.length > NATIVE_HUB_LIMITS.terminal
      || !Array.isArray(envelope.revocations) || envelope.revocations.length > NATIVE_HUB_LIMITS.connections) return invalid();
    const entries = envelope.entries.map(readEntry);
    if (entries.some(entry => entry.kind === "revoke") || entries.filter(entry => !entry.outcome).length > NATIVE_HUB_LIMITS.pending)
      return invalid();
    const revocations = envelope.revocations.map(value => {
      const slot = registryRecord(value, ["connectionId", "operation"]);
      const operation = slot.operation === null ? null : readEntry(slot.operation);
      if (!registryInstance(slot.connectionId)
        || operation && (operation.kind !== "revoke" || operation.connectionId !== slot.connectionId)) return invalid();
      return { connectionId: slot.connectionId, operation };
    });
    const ids = new Set<string>();
    const slots = new Set(revocations.map(slot => slot.connectionId));
    if (slots.size !== revocations.length) return invalid();
    for (const entry of [...entries, ...revocations.flatMap(slot => slot.operation ? [slot.operation] : [])]) {
      if (ids.has(entry.operationId) || (entry.connectionId && !slots.has(entry.connectionId))) return invalid();
      ids.add(entry.operationId);
    }
    return { state: { entries, revocations }, text: snapshot.text };
  }

  #read<T>(action: () => T): T {
    try { return action(); }
    catch (error) {
      if (error instanceof NativeHubError && error.code !== "invalid_request") throw error;
      return invalid();
    }
  }

  #write<T>(lane: NativeJournalWriteLane, fence: () => void,
    action: (state: State) => { result: T; write: boolean }): T {
    return this.#read(() => this.policy.transaction(lane, () => withPrivateStateLockSync(this.home, this.#namespace, "operations", () => {
      const { state, text } = this.#snapshot();
      const { result, write } = action(state);
      if (!write) return result;
      const next = render(state, this.binding);
      const previousBytes = text === null ? 0 : Buffer.byteLength(text), nextBytes = Buffer.byteLength(next);
      if (nextBytes > MAX_JOURNAL_BYTES || (lane === "reserved-revoke" && nextBytes !== previousBytes)) return invalid();
      this.policy.admit(lane, previousBytes, nextBytes);
      this.policy.publish(previousBytes, nextBytes, () => writePrivateStateFileSync(this.#file, next, {
        ...(text === null ? { expectedMissing: true } : { expectedText: text }), assertCurrent: fence,
      }));
      const published = readPrivateStateFileSnapshotSync(this.#file.path, MAX_JOURNAL_BYTES);
      assertPrivateStateDirectory(this.#file.directory);
      if (published?.text !== next) return invalid();
      this.#existed = true;
      return result;
    }, { attempts: 10, waitMs: 5 })));
  }
}
