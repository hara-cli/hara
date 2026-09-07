import {
  bindPrivateHaraStateFile,
  readPrivateStateFileSnapshotSync,
  withPrivateStateLockSync,
  writePrivateStateFileSync,
  type PrivateStateFileBinding,
} from "../security/private-state.js";
import { redactSensitiveText, redactSensitiveValue } from "../security/secrets.js";

export const DEFAULT_REMOTE_COMMAND_RECEIPTS = 64;
export const DEFAULT_REMOTE_COMMAND_REPLAY_RESULTS = 8;
export const MAX_REMOTE_COMMAND_RESULT_BYTES = 256 * 1024;
const MAX_REMOTE_COMMAND_LEDGER_BYTES = 4 * 1024 * 1024;
const REMOTE_COMMAND_LEDGER_VERSION = 1 as const;
const DEFAULT_REMOTE_COMMAND_LEDGER_FILE = "remote-command-receipts.json";

export type RemoteCommandOutcome =
  | { kind: "result"; json: string }
  | { kind: "result_omitted"; message: string }
  | { kind: "error"; code: number; message: string };

export interface RemoteCommandReceipt {
  version: 1;
  commandId: string;
  method: string;
  resourceHash: string;
  requestHash: string;
  startedAt: string;
  completedAt?: string;
  outcome?: RemoteCommandOutcome;
}

interface RemoteCommandSnapshot {
  version: typeof REMOTE_COMMAND_LEDGER_VERSION;
  updatedAt: string;
  receipts: RemoteCommandReceipt[];
}

export type RemoteCommandClaim =
  | { kind: "new" }
  | { kind: "completed"; outcome: RemoteCommandOutcome }
  | { kind: "uncertain"; message: string }
  | { kind: "conflict"; message: string }
  | { kind: "busy"; message: string };

export interface RemoteCommandLedgerOptions {
  home?: string;
  filename?: string;
  maxReceipts?: number;
  maxReplayResults?: number;
  now?: () => Date;
}

function validIso(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
}

function validHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function validCommandId(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function validMethod(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= 120
    && /^[a-z][a-z0-9._-]*$/u.test(value);
}

function parseOutcome(value: unknown): RemoteCommandOutcome | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<RemoteCommandOutcome>;
  if (candidate.kind === "result") {
    if (
      typeof candidate.json !== "string"
      || Buffer.byteLength(candidate.json, "utf8") > MAX_REMOTE_COMMAND_RESULT_BYTES
    ) return null;
    try {
      JSON.parse(candidate.json);
      return { kind: "result", json: candidate.json };
    } catch {
      return null;
    }
  }
  if (candidate.kind === "result_omitted") {
    return typeof candidate.message === "string" && candidate.message.length <= 2_000
      ? { kind: "result_omitted", message: candidate.message }
      : null;
  }
  if (candidate.kind === "error") {
    return Number.isSafeInteger(candidate.code)
      && typeof candidate.message === "string"
      && candidate.message.length <= 2_000
      ? { kind: "error", code: candidate.code!, message: candidate.message }
      : null;
  }
  return null;
}

function parseReceipt(value: unknown): RemoteCommandReceipt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<RemoteCommandReceipt>;
  if (
    candidate.version !== 1
    || !validCommandId(candidate.commandId)
    || !validMethod(candidate.method)
    || !validHash(candidate.resourceHash)
    || !validHash(candidate.requestHash)
    || !validIso(candidate.startedAt)
  ) return null;
  if (candidate.completedAt === undefined && candidate.outcome === undefined) {
    return {
      version: 1,
      commandId: candidate.commandId,
      method: candidate.method,
      resourceHash: candidate.resourceHash,
      requestHash: candidate.requestHash,
      startedAt: candidate.startedAt,
    };
  }
  if (!validIso(candidate.completedAt)) return null;
  const outcome = parseOutcome(candidate.outcome);
  if (!outcome) return null;
  return {
    version: 1,
    commandId: candidate.commandId,
    method: candidate.method,
    resourceHash: candidate.resourceHash,
    requestHash: candidate.requestHash,
    startedAt: candidate.startedAt,
    completedAt: candidate.completedAt,
    outcome,
  };
}

function parseSnapshot(text: string, maxReceipts: number): RemoteCommandSnapshot | null {
  if (Buffer.byteLength(text, "utf8") > MAX_REMOTE_COMMAND_LEDGER_BYTES) return null;
  try {
    const candidate = JSON.parse(text) as Partial<RemoteCommandSnapshot>;
    if (
      candidate.version !== REMOTE_COMMAND_LEDGER_VERSION
      || !validIso(candidate.updatedAt)
      || !Array.isArray(candidate.receipts)
      || candidate.receipts.length > maxReceipts
    ) return null;
    const receipts = candidate.receipts.map(parseReceipt);
    if (receipts.some((receipt) => !receipt)) return null;
    const concrete = receipts as RemoteCommandReceipt[];
    if (new Set(concrete.map((receipt) => receipt.commandId)).size !== concrete.length) return null;
    return {
      version: REMOTE_COMMAND_LEDGER_VERSION,
      updatedAt: candidate.updatedAt,
      receipts: concrete,
    };
  } catch {
    return null;
  }
}

function sanitizeOutcome(outcome: RemoteCommandOutcome): RemoteCommandOutcome {
  if (outcome.kind === "result") {
    try {
      const safe = redactSensitiveValue(JSON.parse(outcome.json)).value;
      const json = JSON.stringify(safe);
      return typeof json === "string" && Buffer.byteLength(json, "utf8") <= MAX_REMOTE_COMMAND_RESULT_BYTES
        ? { kind: "result", json }
        : {
            kind: "result_omitted",
            message: "this remote command completed, but its result exceeded the durable replay limit; inspect the authoritative session",
          };
    } catch {
      return {
        kind: "result_omitted",
        message: "this remote command completed, but its result could not be retained; inspect the authoritative session",
      };
    }
  }
  const message = redactSensitiveText(outcome.message).text.slice(0, 2_000);
  return outcome.kind === "error"
    ? { kind: "error", code: outcome.code, message }
    : { kind: "result_omitted", message };
}

/**
 * Private, bounded command receipts for provider-owned sessions.
 *
 * A `started` receipt is fsync'd before the external side effect. If Serve disappears before the terminal
 * outcome is saved, a replacement refuses both that UUID and new mutations for the same resource until an
 * authoritative read observes it outside a live working/waiting state. This favors an explicit inspection
 * over duplicating a remote coding-agent instruction.
 */
export class RemoteCommandLedger {
  private readonly receipts = new Map<string, RemoteCommandReceipt>();
  /** Only receipts loaded without an outcome represent a crash window. Current-process work is live. */
  private readonly restoredUncertain = new Set<string>();
  /** Terminal provider work whose result is known in memory but has not crossed the durable boundary. */
  private readonly durabilityUncertain = new Set<string>();
  private readonly binding?: PrivateStateFileBinding;
  private readonly home?: string;
  private readonly maxReceipts: number;
  private readonly maxReplayResults: number;
  private readonly now: () => Date;
  private persistedText: string | null = null;

  constructor(options: RemoteCommandLedgerOptions = {}) {
    this.maxReceipts = Math.max(1, Math.min(1_024, Math.trunc(options.maxReceipts ?? DEFAULT_REMOTE_COMMAND_RECEIPTS)));
    this.maxReplayResults = Math.max(0, Math.min(this.maxReceipts, Math.trunc(
      options.maxReplayResults ?? DEFAULT_REMOTE_COMMAND_REPLAY_RESULTS,
    )));
    this.now = options.now ?? (() => new Date());
    this.home = options.home;
    if (!options.home) return;
    this.binding = bindPrivateHaraStateFile(
      options.home,
      ["serve"],
      options.filename ?? DEFAULT_REMOTE_COMMAND_LEDGER_FILE,
    );
    withPrivateStateLockSync(options.home, ["serve"], "remote-command-receipts", () => {
      const current = readPrivateStateFileSnapshotSync(this.binding!.path, MAX_REMOTE_COMMAND_LEDGER_BYTES);
      this.persistedText = current?.text ?? null;
      if (!current) return;
      const snapshot = parseSnapshot(current.text, this.maxReceipts);
      if (!snapshot) {
        throw new Error("remote command receipt ledger is malformed; inspect or remove it before restarting Hara Serve");
      }
      for (const receipt of snapshot.receipts) {
        this.receipts.set(receipt.commandId, receipt);
        if (!receipt.outcome) this.restoredUncertain.add(receipt.commandId);
      }
    });
  }

  claim(input: {
    commandId: string;
    method: string;
    resourceHash: string;
    requestHash: string;
  }): RemoteCommandClaim {
    const prior = this.receipts.get(input.commandId);
    if (prior) {
      if (
        prior.method !== input.method
        || prior.resourceHash !== input.resourceHash
        || prior.requestHash !== input.requestHash
      ) {
        return { kind: "conflict", message: "commandId was already used for a different remote command" };
      }
      if (this.durabilityUncertain.has(input.commandId)) {
        return {
          kind: "uncertain",
          message: "this remote command reached a terminal state, but its durable result is uncertain; read or resume the authoritative session before retrying",
        };
      }
      if (prior.outcome) return { kind: "completed", outcome: prior.outcome };
      return {
        kind: "uncertain",
        message: "this remote command started before Hara restarted; read or resume the authoritative session before retrying",
      };
    }

    const uncertainCommandIds = new Set([...this.restoredUncertain, ...this.durabilityUncertain]);
    if ([...uncertainCommandIds].some((commandId) => (
      this.receipts.get(commandId)?.resourceHash === input.resourceHash
    ))) {
      return {
        kind: "uncertain",
        message: "a remote command for this session has an uncertain outcome; read or resume it before sending another mutation",
      };
    }

    this.evictCompletedForCapacity();
    if (this.receipts.size >= this.maxReceipts) {
      return { kind: "busy", message: "too many remote commands have unresolved outcomes" };
    }
    const startedAt = this.now().toISOString();
    this.receipts.set(input.commandId, {
      version: 1,
      commandId: input.commandId,
      method: input.method,
      resourceHash: input.resourceHash,
      requestHash: input.requestHash,
      startedAt,
    });
    try {
      this.persist();
    } catch (error) {
      this.receipts.delete(input.commandId);
      throw error;
    }
    return { kind: "new" };
  }

  complete(commandId: string, outcome: RemoteCommandOutcome): void {
    const receipt = this.receipts.get(commandId);
    if (!receipt) throw new Error("remote command receipt disappeared before completion");
    if (!receipt.outcome) {
      receipt.completedAt = this.now().toISOString();
      receipt.outcome = sanitizeOutcome(outcome);
      this.trimReplayResults();
    }
    // Mark the whole resource uncertain until the terminal outcome crosses the durable boundary. This
    // preserves live steer/interrupt while a provider turn is actually running, yet fail-closes every new
    // mutation if the provider finished and only the receipt write failed.
    this.durabilityUncertain.add(commandId);
    try {
      this.persist();
    } catch (error) {
      throw error;
    }
    this.durabilityUncertain.delete(commandId);
    this.restoredUncertain.delete(commandId);
  }

  /** Resolve only the uncertainty barrier after an authoritative provider read reaches a non-live state. */
  reconcileResource(resourceHash: string, state: string): number {
    if (state !== "stored" && state !== "idle" && state !== "error") return 0;
    const reconciledCommandIds: string[] = [];
    const uncertainCommandIds = new Set([...this.restoredUncertain, ...this.durabilityUncertain]);
    for (const commandId of uncertainCommandIds) {
      const receipt = this.receipts.get(commandId);
      if (!receipt || receipt.resourceHash !== resourceHash) continue;
      if (!receipt.outcome) {
        receipt.completedAt = this.now().toISOString();
        receipt.outcome = {
          kind: "result_omitted",
          message: "the authoritative remote session was inspected after restart; the prior command remains deduplicated but its exact result is unavailable",
        };
      }
      reconciledCommandIds.push(commandId);
    }
    if (reconciledCommandIds.length > 0) {
      this.trimReplayResults();
      this.persist();
      for (const commandId of reconciledCommandIds) {
        this.restoredUncertain.delete(commandId);
        this.durabilityUncertain.delete(commandId);
      }
    }
    return reconciledCommandIds.length;
  }

  snapshot(): RemoteCommandReceipt[] {
    return [...this.receipts.values()].map((receipt) => structuredClone(receipt));
  }

  private evictCompletedForCapacity(): void {
    if (this.receipts.size < this.maxReceipts) return;
    const completed = [...this.receipts.values()]
      .filter((receipt) => (
        receipt.outcome
        && !this.restoredUncertain.has(receipt.commandId)
        && !this.durabilityUncertain.has(receipt.commandId)
      ))
      .sort((left, right) => (left.completedAt ?? left.startedAt).localeCompare(right.completedAt ?? right.startedAt));
    for (const receipt of completed) {
      this.receipts.delete(receipt.commandId);
      if (this.receipts.size < this.maxReceipts) return;
    }
  }

  private trimReplayResults(): void {
    const exact = [...this.receipts.values()]
      .filter((receipt) => receipt.outcome?.kind === "result")
      .sort((left, right) => (right.completedAt ?? right.startedAt).localeCompare(left.completedAt ?? left.startedAt));
    for (const receipt of exact.slice(this.maxReplayResults)) {
      receipt.outcome = {
        kind: "result_omitted",
        message: "this remote command remains deduplicated, but its exact result aged out; inspect the authoritative session",
      };
    }
  }

  private persist(): void {
    if (!this.binding || !this.home) return;
    withPrivateStateLockSync(this.home, ["serve"], "remote-command-receipts", () => {
      const current = readPrivateStateFileSnapshotSync(this.binding!.path, MAX_REMOTE_COMMAND_LEDGER_BYTES);
      if ((current?.text ?? null) !== this.persistedText) {
        throw new Error("remote command receipt ledger changed outside the active Hara Serve writer");
      }
      const text = `${JSON.stringify({
        version: REMOTE_COMMAND_LEDGER_VERSION,
        updatedAt: this.now().toISOString(),
        receipts: [...this.receipts.values()],
      } satisfies RemoteCommandSnapshot, null, 2)}\n`;
      if (Buffer.byteLength(text, "utf8") > MAX_REMOTE_COMMAND_LEDGER_BYTES) {
        throw new Error("remote command receipt ledger exceeded its private storage limit");
      }
      writePrivateStateFileSync(this.binding!, text, this.persistedText === null
        ? { expectedMissing: true }
        : { expectedText: this.persistedText });
      this.persistedText = text;
    });
  }
}
