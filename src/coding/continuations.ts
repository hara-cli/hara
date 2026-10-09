import { createHmac, timingSafeEqual } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { externalSessionIdentityKey } from "../external-sessions/identity.js";
import { bindPrivateHaraStateFile, readPrivateStateFileSnapshotSync, withPrivateStateLockSync, writePrivateStateFileSync } from "../security/private-state.js";
import { MAX_ASSISTANT_CONTINUATION_ITEMS, type AssistantContinuation } from "../providers/types.js";

export interface CodingContinuationScope {
  workerId: string;
  providerSessionId: string;
  cwd: string;
  providerId: string;
  model: string;
  profileId?: string;
  /** Device-private derived identity only, never the provider's raw runtimeKey. */
  connectionIdentity: string;
}

export interface CodingContinuationInput extends Omit<CodingContinuationScope, "connectionIdentity"> {
  /** Trusted factory only; used in a device-keyed HMAC and never persisted or displayed. */
  connectionRuntimeKey?: string;
}

/** Host-owned only. Unknown/evicted keys fail closed; undefined means a signed known absence. */
export interface CodingContinuationStore {
  load(key: string): AssistantContinuation | undefined;
  save(key: string, continuation: AssistantContinuation | undefined): void;
}

const MAX_VALUE_BYTES = 128_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_ENTRIES = 128;
const KEY = /^[a-f0-9]{64}$/;
type Json = Record<string, unknown>;
type Entry = { key: string; continuation: AssistantContinuation | null };
type Payload = { version: 1; scope: CodingContinuationScope; entries: Entry[] };

function object(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("coding continuation state is invalid");
  return value as Json;
}
function only(value: Json, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error("coding continuation state has unsupported fields");
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    const record = value as Json;
    return "{" + Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => JSON.stringify(key) + ":" + canonical(record[key])).join(",") + "}";
  }
  return JSON.stringify(value) ?? "null";
}
function scopedValue(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 1024 && !/[\u0000-\u001f\u007f]/.test(value);
}
function validateScope(value: CodingContinuationInput): Omit<CodingContinuationScope, "connectionIdentity"> {
  const scope = object(value);
  only(scope, ["workerId", "providerSessionId", "cwd", "providerId", "model", "profileId", "connectionRuntimeKey"]);
  if (!scopedValue(scope.workerId) || !scopedValue(scope.providerId) || !scopedValue(scope.model)
    || typeof scope.providerSessionId !== "string" || !/^ext_(?:pi|opencode)_[a-f0-9]{24}$/.test(scope.providerSessionId)
    || typeof scope.cwd !== "string" || !isAbsolute(scope.cwd) || realpathSync.native(scope.cwd) !== scope.cwd || !lstatSync(scope.cwd).isDirectory()
    || (scope.profileId !== undefined && !scopedValue(scope.profileId))
    || (scope.connectionRuntimeKey !== undefined && (typeof scope.connectionRuntimeKey !== "string" || !KEY.test(scope.connectionRuntimeKey)))) throw new Error("coding continuation scope is invalid");
  return { workerId: scope.workerId, providerSessionId: scope.providerSessionId, cwd: scope.cwd, providerId: scope.providerId, model: scope.model,
    ...(scope.profileId === undefined ? {} : { profileId: scope.profileId }) };
}

/** Strictly validate provider-owned data before it can become durable authority. Never redact or
 * normalize opaque reasoning: it must round-trip byte-for-byte, or the operation must fail. */
export function validateCodingContinuation(value: unknown): AssistantContinuation {
  if (Buffer.byteLength(JSON.stringify(value) ?? "") > MAX_VALUE_BYTES) throw new Error("coding continuation is oversized");
  const continuation = object(value);
  if (continuation.type === "chat_reasoning") {
    only(continuation, ["type", "text"]);
    if (typeof continuation.text !== "string") throw new Error("coding continuation text is invalid");
  } else if (continuation.type === "responses_reasoning") {
    only(continuation, ["type", "items"]);
    if (!Array.isArray(continuation.items) || continuation.items.length > MAX_ASSISTANT_CONTINUATION_ITEMS) throw new Error("coding continuation items are invalid");
    const ids = new Set<string>();
    for (const value of continuation.items) {
      const item = object(value);
      only(item, ["type", "id", "summary", "content", "encrypted_content", "status"]);
      if (item.type !== "reasoning" || !scopedValue(item.id) || ids.has(item.id) || !Array.isArray(item.summary)
        || (item.content !== undefined && !Array.isArray(item.content))
        || (item.encrypted_content !== undefined && item.encrypted_content !== null && typeof item.encrypted_content !== "string")
        || (item.status !== undefined && !["in_progress", "completed", "incomplete"].includes(String(item.status)))) throw new Error("coding continuation reasoning item is invalid");
      ids.add(item.id);
      for (const [parts, expected] of [[item.summary, "summary_text"], [item.content ?? [], "reasoning_text"]] as const) {
        for (const value of parts as unknown[]) {
          const part = object(value); only(part, ["type", "text"]);
          if (part.type !== expected || typeof part.text !== "string") throw new Error("coding continuation reasoning content is invalid");
        }
      }
    }
  } else throw new Error("coding continuation type is unsupported");
  // Erase undefined-only properties exactly as the JSON transport does, but preserve opaque strings.
  return JSON.parse(JSON.stringify(continuation)) as AssistantContinuation;
}

/** No-follow private CAS storage, authenticated to one exact worker/session/cwd/provider/model/profile.
 * This is never exposed to a coding model, MCP tools, API payloads or renderer views. */
export function createCodingContinuationStore(home: string, input: CodingContinuationInput): CodingContinuationStore {
  const publicScope = validateScope(input);
  const identity = externalSessionIdentityKey(home);
  const mac = (domain: string, value: unknown): string => createHmac("sha256", identity).update("hara.coding.continuations." + domain + "\0" + canonical(value)).digest("hex");
  const connectionIdentity = input.connectionRuntimeKey === undefined
    ? "offline_mock_" + mac("offline-mock-connection", { providerId: publicScope.providerId, model: publicScope.model, profileId: publicScope.profileId })
    : "connection_" + mac("connection", input.connectionRuntimeKey);
  const scope: CodingContinuationScope = { ...publicScope, connectionIdentity };
  const subdirs = ["agent-teams", "coding-continuations", mac("scope", scope).slice(0, 40)];
  const binding = bindPrivateHaraStateFile(home, subdirs, "state.json");
  const read = (): { payload: Payload; text?: string } => {
    const previous = readPrivateStateFileSnapshotSync(binding.path, MAX_FILE_BYTES);
    if (!previous) throw new Error("coding continuation state is missing");
    const stored = object(JSON.parse(previous.text)); only(stored, ["version", "scope", "entries", "integrity"]);
    const { integrity, ...unsigned } = stored;
    if (stored.version !== 1 || canonical(stored.scope) !== canonical(scope) || !Array.isArray(stored.entries) || stored.entries.length > MAX_ENTRIES
      || typeof integrity !== "string" || !KEY.test(integrity)
      || !timingSafeEqual(Buffer.from(integrity, "hex"), Buffer.from(mac("payload", unsigned), "hex"))) throw new Error("coding continuation binding or integrity changed");
    const seen = new Set<string>();
    const entries: Entry[] = stored.entries.map((value) => {
      const entry = object(value); only(entry, ["key", "continuation"]);
      if (typeof entry.key !== "string" || !KEY.test(entry.key) || seen.has(entry.key)) throw new Error("coding continuation key is invalid");
      seen.add(entry.key);
      return { key: entry.key, continuation: entry.continuation === null ? null : validateCodingContinuation(entry.continuation) };
    });
    return { payload: { version: 1, scope, entries }, text: previous.text };
  };
  const encode = (payload: Payload): string => JSON.stringify({ ...payload, integrity: mac("payload", payload) }) + "\n";
  const checkKey = (key: string): void => { if (typeof key !== "string" || !KEY.test(key)) throw new Error("coding continuation key is invalid"); };
  // Establish even an empty store durably. Once returned, a deleted file cannot be silently
  // recreated by save() while a running bridge still holds cached reasoning in memory.
  withPrivateStateLockSync(home, subdirs, "update", () => {
    const existing = readPrivateStateFileSnapshotSync(binding.path, MAX_FILE_BYTES);
    if (existing) read();
    else writePrivateStateFileSync(binding, encode({ version: 1, scope, entries: [] }), { expectedMissing: true });
  });
  return {
    load(key) {
      checkKey(key);
      const entry = read().payload.entries.find((entry) => entry.key === key);
      if (!entry) throw new Error("coding continuation is missing or evicted");
      return entry.continuation === null ? undefined : structuredClone(entry.continuation);
    },
    save(key, value) {
      checkKey(key);
      const continuation = value === undefined ? null : validateCodingContinuation(value);
      withPrivateStateLockSync(home, subdirs, "update", () => {
        const previous = read();
        const found = previous.payload.entries.find((entry) => entry.key === key);
        if (found) {
          if (canonical(found.continuation) !== canonical(continuation)) throw new Error("coding continuation key conflict");
          return;
        }
        previous.payload.entries.push({ key, continuation });
        while (previous.payload.entries.length > MAX_ENTRIES || Buffer.byteLength(encode(previous.payload)) > MAX_FILE_BYTES) previous.payload.entries.shift();
        writePrivateStateFileSync(binding, encode(previous.payload), previous.text === undefined ? { expectedMissing: true } : { expectedText: previous.text });
      });
    },
  };
}
