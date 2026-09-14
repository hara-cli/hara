// Private sender enrollment for Desktop-managed chat connectors.
//
// Raw platform user ids never cross the authenticated loopback API. An unknown Feishu DM receives a short
// pairing code; Desktop sees only that code plus an opaque request id and must explicitly approve it locally.
import { randomBytes, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import {
  bindPrivateHaraStateFile,
  readPrivateStateFileSnapshotSync,
  withPrivateStateLockSync,
  writePrivateStateFileSync,
} from "../security/private-state.js";

const MAX_STORE_BYTES = 64 * 1024;
const MAX_AUTHORIZED_SENDERS = 32;
const MAX_PENDING_REQUESTS = 8;
const PENDING_TTL_MS = 10 * 60_000;
const RUNTIME_SCOPE = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const REQUEST_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const PAIRING_CODE = /^[A-F0-9]{6}$/u;

interface AuthorizedSender {
  senderId: string;
  authorizedAt: number;
}

interface PendingSender {
  id: string;
  code: string;
  senderId: string;
  requestedAt: number;
  expiresAt: number;
}

interface SenderAuthorizationFile {
  version: 1;
  authorized: AuthorizedSender[];
  pending: PendingSender[];
}

export interface GatewayPendingAuthorization {
  id: string;
  code: string;
  requestedAt: number;
  expiresAt: number;
}

export interface GatewaySenderAuthorizationSummary {
  state: "ready" | "missing" | "unreadable";
  authorized: boolean;
  pending?: GatewayPendingAuthorization;
}

function checkedScope(value: string): string {
  const scope = value.trim().toLowerCase();
  if (!RUNTIME_SCOPE.test(scope)) throw new Error("invalid gateway authorization scope");
  return scope;
}

function normalizedSenderId(value: number | string): string {
  const senderId = String(value).trim();
  if (!senderId || senderId.length > 512 || /[\u0000-\u001f\u007f]/u.test(senderId)) {
    throw new Error("invalid gateway sender identity");
  }
  return senderId;
}

function validTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function binding(home: string, runtimeScope: string) {
  return bindPrivateHaraStateFile(home, ["gateway"], `authorization-${checkedScope(runtimeScope)}.json`);
}

function emptyStore(): SenderAuthorizationFile {
  return { version: 1, authorized: [], pending: [] };
}

function parseStore(text: string): SenderAuthorizationFile {
  const value = JSON.parse(text) as Record<string, unknown>;
  if (!value || Array.isArray(value) || value.version !== 1) {
    throw new Error("unsupported gateway sender authorization store");
  }
  if (!Array.isArray(value.authorized) || !Array.isArray(value.pending)) {
    throw new Error("invalid gateway sender authorization store");
  }
  if (value.authorized.length > MAX_AUTHORIZED_SENDERS || value.pending.length > MAX_PENDING_REQUESTS) {
    throw new Error("gateway sender authorization store exceeds its bounds");
  }
  const authorized = value.authorized.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("invalid authorized sender");
    const record = entry as Record<string, unknown>;
    if (typeof record.senderId !== "string" || !validTimestamp(record.authorizedAt)) {
      throw new Error("invalid authorized sender");
    }
    return { senderId: normalizedSenderId(record.senderId), authorizedAt: record.authorizedAt };
  });
  const pending = value.pending.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("invalid pending sender");
    const record = entry as Record<string, unknown>;
    if (
      typeof record.id !== "string"
      || !REQUEST_ID.test(record.id)
      || typeof record.code !== "string"
      || !PAIRING_CODE.test(record.code)
      || typeof record.senderId !== "string"
      || !validTimestamp(record.requestedAt)
      || !validTimestamp(record.expiresAt)
      || record.expiresAt <= record.requestedAt
    ) throw new Error("invalid pending sender");
    return {
      id: record.id,
      code: record.code,
      senderId: normalizedSenderId(record.senderId),
      requestedAt: record.requestedAt,
      expiresAt: record.expiresAt,
    };
  });
  if (new Set(authorized.map((entry) => entry.senderId)).size !== authorized.length) {
    throw new Error("duplicate authorized gateway sender");
  }
  if (new Set(pending.map((entry) => entry.id)).size !== pending.length) {
    throw new Error("duplicate pending gateway sender request");
  }
  return { version: 1, authorized, pending };
}

function readStore(home: string, runtimeScope: string): {
  store: SenderAuthorizationFile;
  existingText?: string;
} {
  const target = binding(home, runtimeScope);
  const snapshot = readPrivateStateFileSnapshotSync(target.path, MAX_STORE_BYTES);
  return snapshot
    ? { store: parseStore(snapshot.text), existingText: snapshot.text }
    : { store: emptyStore() };
}

function writeStore(
  home: string,
  runtimeScope: string,
  store: SenderAuthorizationFile,
  existingText?: string,
): void {
  const target = binding(home, runtimeScope);
  const text = `${JSON.stringify(store, null, 2)}\n`;
  writePrivateStateFileSync(target, text, existingText === undefined
    ? { expectedMissing: true }
    : { expectedText: existingText });
}

function prunePending(store: SenderAuthorizationFile, now: number): SenderAuthorizationFile {
  return {
    ...store,
    pending: store.pending.filter((entry) => entry.expiresAt > now),
  };
}

function redactedPending(entry: PendingSender): GatewayPendingAuthorization {
  return {
    id: entry.id,
    code: entry.code,
    requestedAt: entry.requestedAt,
    expiresAt: entry.expiresAt,
  };
}

/** Read authorized sender ids only inside the gateway process. Callers must never serialize this Set. */
export function loadAuthorizedGatewaySenders(
  runtimeScope: string,
  home: string = homedir(),
  now: number = Date.now(),
): Set<string> {
  const { store } = readStore(home, runtimeScope);
  const current = prunePending(store, now);
  return new Set(current.authorized.map((entry) => entry.senderId));
}

/** Redacted status for Desktop. No platform user id or authorized-user count crosses this boundary. */
export function inspectGatewaySenderAuthorization(
  runtimeScope: string,
  home: string = homedir(),
  now: number = Date.now(),
): GatewaySenderAuthorizationSummary {
  try {
    const { store } = readStore(home, runtimeScope);
    const current = prunePending(store, now);
    const pending = [...current.pending].sort((left, right) => right.requestedAt - left.requestedAt)[0];
    return {
      state: current.authorized.length > 0 || pending ? "ready" : "missing",
      authorized: current.authorized.length > 0,
      ...(pending ? { pending: redactedPending(pending) } : {}),
    };
  } catch {
    return { state: "unreadable", authorized: false };
  }
}

/** Register an unknown private sender and return a code that can be matched in Desktop. */
export function requestGatewaySenderAuthorization(
  runtimeScope: string,
  senderValue: number | string,
  home: string = homedir(),
  now: number = Date.now(),
): GatewayPendingAuthorization | null {
  const senderId = normalizedSenderId(senderValue);
  const scope = checkedScope(runtimeScope);
  return withPrivateStateLockSync(home, ["gateway"], `authorization-${scope}`, () => {
    const { store: loaded, existingText } = readStore(home, scope);
    const store = prunePending(loaded, now);
    if (store.authorized.some((entry) => entry.senderId === senderId)) return null;
    const existing = store.pending.find((entry) => entry.senderId === senderId);
    if (existing) return redactedPending(existing);
    let code: string;
    do {
      code = randomBytes(3).toString("hex").toUpperCase();
    } while (store.pending.some((entry) => entry.code === code));
    const pending: PendingSender = {
      id: randomUUID(),
      code,
      senderId,
      requestedAt: now,
      expiresAt: now + PENDING_TTL_MS,
    };
    store.pending = [...store.pending, pending]
      .sort((left, right) => right.requestedAt - left.requestedAt)
      .slice(0, MAX_PENDING_REQUESTS);
    writeStore(home, scope, store, existingText);
    return redactedPending(pending);
  }, { busyMessage: "gateway sender authorization is busy; retry shortly" });
}

/** Approve one exact opaque request. The raw sender id remains private and becomes effective on the next DM. */
export function approveGatewaySenderAuthorization(
  runtimeScope: string,
  requestId: string,
  home: string = homedir(),
  now: number = Date.now(),
): GatewaySenderAuthorizationSummary {
  if (!REQUEST_ID.test(requestId)) throw new Error("invalid gateway authorization request");
  const scope = checkedScope(runtimeScope);
  return withPrivateStateLockSync(home, ["gateway"], `authorization-${scope}`, () => {
    const { store: loaded, existingText } = readStore(home, scope);
    const store = prunePending(loaded, now);
    const pending = store.pending.find((entry) => entry.id === requestId);
    if (!pending) throw new Error("gateway authorization request expired or was not found");
    if (!store.authorized.some((entry) => entry.senderId === pending.senderId)) {
      store.authorized = [
        ...store.authorized,
        { senderId: pending.senderId, authorizedAt: now },
      ].slice(-MAX_AUTHORIZED_SENDERS);
    }
    store.pending = store.pending.filter((entry) => entry.senderId !== pending.senderId);
    writeStore(home, scope, store, existingText);
    return { state: "ready", authorized: true };
  }, { busyMessage: "gateway sender authorization is busy; retry shortly" });
}
