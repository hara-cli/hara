// Credential-preserving cross-gateway delivery.
//
// A Hara agent running under the WeChat gateway must not inherit the Feishu gateway's App Secret. Instead it
// writes one bounded, owner-only request into the verified live Feishu runtime's private queue. The Feishu
// process performs the send with its own in-memory adapter and writes an equally bounded receipt. Credentials
// never cross the process boundary and a restart reuses the same platform idempotency key.

import { createHash, randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import {
  bindPrivateHaraStateFile,
  ensurePrivateStateSubdirectory,
  PrivateStateConflictError,
  readPrivateStateFileSnapshotSync,
  removePrivateStateFile,
  withPrivateStateLockSync,
  writePrivateStateFileSync,
} from "../security/private-state.js";
import type { ChatAdapter } from "./telegram.js";
import { liveGatewayRuntimeScopes } from "./runtime-state.js";

const NAME = /^(?:request|result)-([a-f0-9]{64})\.json$/u;
const SCOPE = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const PLATFORM = /^[a-z0-9][a-z0-9_-]{0,31}$/u;
const MAX_REQUEST_BYTES = 72 * 1024;
const MAX_RECEIPT_BYTES = 8 * 1024;
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_TARGET_CHARS = 512;
const MAX_QUEUE_ITEMS = 512;
const RETENTION_MS = 24 * 60 * 60_000;
const DEFAULT_WAIT_MS = 35_000;
const DEFAULT_POLL_MS = 150;

interface GatewayOutboundRequest {
  version: 1;
  id: string;
  platform: string;
  target: string;
  text: string;
  createdAt: number;
}

interface GatewayOutboundReceipt {
  version: 1;
  id: string;
  status: "sent" | "failed";
  completedAt: number;
  error?: "invalid_request" | "transport_failed";
}

export type GatewayOutboundSubmission =
  | { status: "sent"; requestId: string }
  | { status: "queued"; requestId: string }
  | { status: "failed"; requestId?: string; error: string };

export interface GatewayOutboundBrokerOptions {
  home?: string;
  now?: () => number;
  waitMs?: number;
  pollMs?: number;
}

function checkedScope(value: string): string {
  const scope = value.trim().toLowerCase();
  if (!SCOPE.test(scope)) throw new Error("invalid gateway outbound scope");
  return scope;
}

function checkedPlatform(value: string): string {
  const platform = value.trim().toLowerCase();
  if (!PLATFORM.test(platform)) throw new Error("invalid gateway outbound platform");
  return platform;
}

function checkedTarget(value: string): string {
  const target = value.trim();
  if (!target || target.length > MAX_TARGET_CHARS || /[\u0000-\u001f\u007f]/u.test(target)) {
    throw new Error("invalid gateway outbound target");
  }
  return target;
}

function checkedText(value: string): string {
  const text = value.trim();
  if (!text) throw new Error("gateway outbound text is empty");
  if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) throw new Error("gateway outbound text exceeds 64 KiB");
  return text;
}

function checkedId(value: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error("invalid gateway outbound request id");
  return value;
}

function queueComponents(scopeValue: string): ["gateway", string] {
  return ["gateway", `outbound-${checkedScope(scopeValue)}`];
}

function requestBinding(home: string, scope: string, id: string) {
  return bindPrivateHaraStateFile(home, queueComponents(scope), `request-${checkedId(id)}.json`);
}

function receiptBinding(home: string, scope: string, id: string) {
  return bindPrivateHaraStateFile(home, queueComponents(scope), `result-${checkedId(id)}.json`);
}

function parseRequest(text: string, expectedId: string, expectedPlatform?: string): GatewayOutboundRequest {
  if (Buffer.byteLength(text, "utf8") > MAX_REQUEST_BYTES) throw new Error("invalid gateway outbound request");
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("invalid gateway outbound request"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid gateway outbound request");
  const request = value as Partial<GatewayOutboundRequest>;
  if (
    request.version !== 1
    || request.id !== expectedId
    || typeof request.platform !== "string"
    || checkedPlatform(request.platform) !== request.platform
    || (expectedPlatform !== undefined && request.platform !== expectedPlatform)
    || typeof request.target !== "string"
    || checkedTarget(request.target) !== request.target
    || typeof request.text !== "string"
    || checkedText(request.text) !== request.text
    || !Number.isFinite(request.createdAt)
    || (request.createdAt as number) <= 0
  ) throw new Error("invalid gateway outbound request");
  return request as GatewayOutboundRequest;
}

function parseReceipt(text: string, expectedId: string): GatewayOutboundReceipt {
  if (Buffer.byteLength(text, "utf8") > MAX_RECEIPT_BYTES) throw new Error("invalid gateway outbound receipt");
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("invalid gateway outbound receipt"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid gateway outbound receipt");
  const receipt = value as Partial<GatewayOutboundReceipt>;
  if (
    receipt.version !== 1
    || receipt.id !== expectedId
    || (receipt.status !== "sent" && receipt.status !== "failed")
    || !Number.isFinite(receipt.completedAt)
    || (receipt.completedAt as number) <= 0
    || (receipt.error !== undefined && receipt.error !== "invalid_request" && receipt.error !== "transport_failed")
    || (receipt.status === "sent" && receipt.error !== undefined)
    || (receipt.status === "failed" && receipt.error === undefined)
  ) throw new Error("invalid gateway outbound receipt");
  return receipt as GatewayOutboundReceipt;
}

function removeSnapshot(binding: ReturnType<typeof requestBinding>, maxBytes: number): void {
  const snapshot = readPrivateStateFileSnapshotSync(binding.path, maxBytes);
  if (!snapshot) return;
  try {
    removePrivateStateFile(binding.path, snapshot, binding.directory);
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function pruneQueue(home: string, scope: string, now: number): void {
  const directory = ensurePrivateStateSubdirectory(home, [".hara", ...queueComponents(scope)]);
  const cutoff = now - RETENTION_MS;
  for (const name of readdirSync(directory.path)) {
    const match = NAME.exec(name);
    if (!match) continue;
    const binding = name.startsWith("request-")
      ? requestBinding(home, scope, match[1])
      : receiptBinding(home, scope, match[1]);
    const snapshot = readPrivateStateFileSnapshotSync(
      binding.path,
      name.startsWith("request-") ? MAX_REQUEST_BYTES : MAX_RECEIPT_BYTES,
    );
    if (!snapshot || snapshot.mtimeMs >= cutoff) continue;
    try { removePrivateStateFile(binding.path, snapshot, binding.directory); } catch { /* raced or unsafe: retain */ }
  }
}

function readReceipt(home: string, scope: string, id: string): GatewayOutboundReceipt | null {
  const snapshot = readPrivateStateFileSnapshotSync(receiptBinding(home, scope, id).path, MAX_RECEIPT_BYTES);
  return snapshot ? parseReceipt(snapshot.text, id) : null;
}

function writeReceiptOnce(home: string, scope: string, receipt: GatewayOutboundReceipt): void {
  const binding = receiptBinding(home, scope, receipt.id);
  const text = `${JSON.stringify(receipt)}\n`;
  try {
    writePrivateStateFileSync(binding, text, { expectedMissing: true });
  } catch (error) {
    if (!(error instanceof PrivateStateConflictError)) throw error;
    const existing = readPrivateStateFileSnapshotSync(binding.path, MAX_RECEIPT_BYTES);
    if (!existing || parseReceipt(existing.text, receipt.id).status !== receipt.status) throw error;
  }
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted || ms <= 0) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

/** Enqueue one immutable text send for a specific verified runtime scope and wait for its bounded receipt. */
export async function submitGatewayOutbound(
  scopeValue: string,
  platformValue: string,
  targetValue: string,
  textValue: string,
  idempotencyKey: string = randomUUID(),
  signal?: AbortSignal,
  options: GatewayOutboundBrokerOptions = {},
): Promise<GatewayOutboundSubmission> {
  const scope = checkedScope(scopeValue);
  const platform = checkedPlatform(platformValue);
  const target = checkedTarget(targetValue);
  const message = checkedText(textValue);
  const home = options.home ?? homedir();
  const now = options.now ?? Date.now;
  const requestId = createHash("sha256")
    .update("hara-gateway-outbound-v1\0")
    .update(scope)
    .update("\0")
    .update(idempotencyKey)
    .update("\0")
    .update(platform)
    .update("\0")
    .update(target)
    .update("\0")
    .update(message)
    .digest("hex");
  const request: GatewayOutboundRequest = {
    version: 1,
    id: requestId,
    platform,
    target,
    text: message,
    createdAt: now(),
  };
  const serialized = `${JSON.stringify(request)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_REQUEST_BYTES) {
    return { status: "failed", error: "message is too large for connected-gateway delivery" };
  }

  const existingReceipt = readReceipt(home, scope, requestId);
  if (existingReceipt) {
    return existingReceipt.status === "sent"
      ? { status: "sent", requestId }
      : { status: "failed", requestId, error: "the connected gateway could not deliver this message" };
  }

  withPrivateStateLockSync(home, queueComponents(scope), "outbound-queue", () => {
    pruneQueue(home, scope, now());
    if (readReceipt(home, scope, requestId)) return;
    const binding = requestBinding(home, scope, requestId);
    const existing = readPrivateStateFileSnapshotSync(binding.path, MAX_REQUEST_BYTES);
    if (existing) {
      const parsed = parseRequest(existing.text, requestId, platform);
      if (parsed.target !== target || parsed.text !== message) throw new Error("gateway outbound idempotency conflict");
      return;
    }
    const directory = ensurePrivateStateSubdirectory(home, [".hara", ...queueComponents(scope)]);
    const queued = readdirSync(directory.path).filter((name) => name.startsWith("request-") && NAME.test(name));
    if (queued.length >= MAX_QUEUE_ITEMS) throw new Error("connected gateway outbound queue is full");
    writePrivateStateFileSync(binding, serialized, { expectedMissing: true });
  }, { busyMessage: "connected gateway outbound queue is busy; retry shortly" });

  const deadline = Date.now() + Math.max(0, options.waitMs ?? DEFAULT_WAIT_MS);
  const pollMs = Math.max(10, Math.min(1_000, options.pollMs ?? DEFAULT_POLL_MS));
  while (!signal?.aborted && Date.now() <= deadline) {
    const receipt = readReceipt(home, scope, requestId);
    if (receipt) {
      return receipt.status === "sent"
        ? { status: "sent", requestId }
        : { status: "failed", requestId, error: "the connected gateway could not deliver this message" };
    }
    await wait(Math.min(pollMs, Math.max(0, deadline - Date.now())), signal);
  }
  return { status: "queued", requestId };
}

/** Resolve exactly one live target gateway. Multiple connected accounts are rejected until the caller can
 * choose an account explicitly; guessing could send a private message through the wrong company tenant. */
export async function sendThroughConnectedGateway(
  platformValue: string,
  target: string,
  text: string,
  idempotencyKey?: string,
  signal?: AbortSignal,
  options: GatewayOutboundBrokerOptions = {},
): Promise<GatewayOutboundSubmission> {
  const platform = checkedPlatform(platformValue);
  const scopes = await liveGatewayRuntimeScopes(platform, { home: options.home });
  if (scopes.length === 0) return { status: "failed", error: `${platform} gateway is not running` };
  if (scopes.length > 1) {
    return { status: "failed", error: `more than one ${platform} account is connected; account selection is required` };
  }
  return submitGatewayOutbound(scopes[0], platform, target, text, idempotencyKey, signal, options);
}

async function processRequest(
  adapter: ChatAdapter,
  runtimeScope: string,
  home: string,
  id: string,
  signal: AbortSignal,
  now: () => number,
): Promise<void> {
  const requestFile = requestBinding(home, runtimeScope, id);
  const existingReceipt = readReceipt(home, runtimeScope, id);
  if (existingReceipt) {
    removeSnapshot(requestFile, MAX_REQUEST_BYTES);
    return;
  }
  const snapshot = readPrivateStateFileSnapshotSync(requestFile.path, MAX_REQUEST_BYTES);
  if (!snapshot) return;
  let request: GatewayOutboundRequest;
  try {
    request = parseRequest(snapshot.text, id, adapter.name);
  } catch {
    writeReceiptOnce(home, runtimeScope, {
      version: 1,
      id,
      status: "failed",
      completedAt: now(),
      error: "invalid_request",
    });
    removeSnapshot(requestFile, MAX_REQUEST_BYTES);
    return;
  }
  if (signal.aborted) return;
  let receipt: GatewayOutboundReceipt;
  try {
    await adapter.send(request.target, request.text, signal, request.id);
    receipt = { version: 1, id, status: "sent", completedAt: now() };
  } catch {
    receipt = { version: 1, id, status: "failed", completedAt: now(), error: "transport_failed" };
  }
  writeReceiptOnce(home, runtimeScope, receipt);
  removeSnapshot(requestFile, MAX_REQUEST_BYTES);
}

/** Process a bounded snapshot of the queue. Exported for hermetic adapter tests. */
export async function processGatewayOutboundOnce(
  adapter: ChatAdapter,
  runtimeScopeValue: string,
  signal: AbortSignal,
  options: GatewayOutboundBrokerOptions = {},
): Promise<number> {
  const runtimeScope = checkedScope(runtimeScopeValue);
  const home = options.home ?? homedir();
  const now = options.now ?? Date.now;
  const directory = ensurePrivateStateSubdirectory(home, [".hara", ...queueComponents(runtimeScope)]);
  const ids = readdirSync(directory.path)
    .map((name) => ({ name, match: NAME.exec(name) }))
    .filter((entry) => entry.name.startsWith("request-") && entry.match)
    .map((entry) => entry.match![1])
    .sort()
    .slice(0, 32);
  for (const id of ids) {
    if (signal.aborted) break;
    await processRequest(adapter, runtimeScope, home, id, signal, now);
  }
  return ids.length;
}

/** Long-lived worker owned by the credential-bearing gateway process. It never opens another adapter and
 * never reads another gateway's queue. */
export async function serveGatewayOutboundRequests(
  adapter: ChatAdapter,
  runtimeScope: string,
  signal: AbortSignal,
  options: GatewayOutboundBrokerOptions = {},
): Promise<void> {
  const pollMs = Math.max(25, Math.min(2_000, options.pollMs ?? DEFAULT_POLL_MS));
  while (!signal.aborted) {
    try {
      const processed = await processGatewayOutboundOnce(adapter, runtimeScope, signal, options);
      if (!processed) await wait(pollMs, signal);
    } catch {
      console.error(`hara gateway: ${adapter.name} outbound broker encountered private-state trouble; retrying`);
      await wait(Math.max(500, pollMs), signal);
    }
  }
}
