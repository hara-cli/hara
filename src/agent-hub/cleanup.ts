import { randomUUID } from "node:crypto";
import { HUB_LIMITS, sha256 } from "./attachments.js";
import { AgentHubError, hubAssert, plain } from "./errors.js";
import type { HubStoredMessage } from "./contracts.js";
import type { AgentHubPrivateStore, HubFileSnapshot } from "./private-store.js";
import { HUB_UUID } from "./metadata.js";

export interface HubCleanupCandidate {
  fileId: string; messageKey: string | null; messageId: string | null; connectionId: string | null;
  attachmentId: string | null; name: string | null; unpublished: boolean; receivedAt: string;
  snapshot: HubFileSnapshot; metadataDigest: string | null;
}
export interface HubCleanupPlan {
  schemaVersion: 1; planId: string; scopeKey: string; generation: string; catalogDigest: string;
  expiresAt: string; candidates: HubCleanupCandidate[]; payloadBytes: number; digest: string;
}
export interface HubCleanupAuthority {
  /** Explicit current reference/recovery check. Unknown is protected; never default-allow. */
  canDelete(candidate: Readonly<HubCleanupCandidate>): boolean;
  /** Native human action bound to this digest; a message or approved:true is not a proof. */
  authorize(planDigest: string, proof: unknown): void;
}
export interface HubCleanupReceipt { planId: string; complete: boolean; processedFiles: number; removedPayloadBytes: number; alreadyMissingFiles: number }
interface Journal { schemaVersion: 1; plan: HubCleanupPlan; receipt: HubCleanupReceipt }
export interface CleanupAccess<S> {
  disk: AgentHubPrivateStore; scopeKey: string; generation: string; now(): Date; assertCurrent(): void;
  authority?: HubCleanupAuthority;
  catalog(): { text: string | null; entries: { key: string; connectionId: string; messageId: string }[] };
  metadata(key: string): { value: HubStoredMessage<S>; text: string };
}
function leasedFiles(disk: AgentHubPrivateStore): Set<string> {
  const leases = disk.names().filter(name => name.startsWith("reader-")); hubAssert(leases.length <= 8, "store_unavailable");
  return new Set(leases.map(name => {
    const raw = disk.read(name); hubAssert(raw !== null, "store_unavailable"); const value: unknown = JSON.parse(raw);
    hubAssert(plain(value) && value.schemaVersion === 1 && typeof value.fileId === "string" && /^attachment-[a-f0-9]{64}-[0-3]\.bin$/.test(value.fileId), "store_unavailable");
    return value.fileId;
  }));
}
function allowed<S>(access: CleanupAccess<S>, candidate: HubCleanupCandidate): boolean {
  if (leasedFiles(access.disk).has(candidate.fileId)) return false;
  try { return access.authority?.canDelete(structuredClone(candidate)) === true; } catch { return false; }
}
const metadataDigest = <S>(value: HubStoredMessage<S>) => sha256(JSON.stringify({ ...value, attachments: value.attachments.map(row => ({ ...row, state: "available" })) }));
const planDigest = (plan: Omit<HubCleanupPlan, "digest">) => sha256(JSON.stringify(plan));
export function planHubCleanup<S>(access: CleanupAccess<S>, targetBytes: number): HubCleanupPlan {
  hubAssert(Number.isSafeInteger(targetBytes) && targetBytes > 0 && targetBytes <= HUB_LIMITS.quotaBytes);
  const catalog = access.catalog(), published = new Set(catalog.entries.map(row => row.key)), referenced = new Set<string>();
  const candidates: HubCleanupCandidate[] = [];
  for (const name of access.disk.names().filter(name => /^message-[a-f0-9]{64}\.json$/.test(name))) {
    const key = name.slice(8, -5), meta = access.metadata(key);
    for (const attachment of meta.value.attachments) {
      referenced.add(attachment.fileId);
      if (attachment.state !== "available") continue;
      const snapshot = access.disk.inspect(attachment.fileId);
      if (!snapshot) { hubAssert(!published.has(key), "store_unavailable"); continue; }
      hubAssert(snapshot.size === attachment.bytes, "store_unavailable");
      const candidate = { fileId: attachment.fileId, messageKey: key, messageId: meta.value.messageId, connectionId: meta.value.connectionId,
        attachmentId: attachment.attachmentId, name: attachment.name, unpublished: !published.has(key),
        receivedAt: meta.value.receivedAt, snapshot, metadataDigest: metadataDigest(meta.value) };
      if (allowed(access, candidate)) candidates.push(candidate);
    }
  }
  // Only attachment copies are reclaimable. Preserve text, message metadata, receipts and recovery records.
  for (const name of access.disk.names().filter(name => /^attachment-[a-f0-9]{64}-[0-3]\.bin$/.test(name) && !referenced.has(name))) {
    const snapshot = access.disk.inspect(name); hubAssert(snapshot && snapshot.size <= HUB_LIMITS.fileBytes, "store_unavailable");
    const candidate = { fileId: name, messageKey: null, messageId: null, connectionId: null, attachmentId: null, name: null,
      unpublished: true, receivedAt: new Date(snapshot.mtimeMs).toISOString(), snapshot, metadataDigest: null };
    if (allowed(access, candidate)) candidates.push(candidate);
  }
  candidates.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.fileId.localeCompare(b.fileId));
  const selected: HubCleanupCandidate[] = []; let payloadBytes = 0;
  for (const candidate of candidates) { selected.push(candidate); payloadBytes += candidate.snapshot.size; if (payloadBytes >= targetBytes || selected.length === 32) break; }
  const plan = { schemaVersion: 1 as const, planId: randomUUID(), scopeKey: access.scopeKey, generation: access.generation,
    catalogDigest: sha256(catalog.text ?? ""), expiresAt: new Date(access.now().getTime() + 300_000).toISOString(), candidates: selected, payloadBytes };
  hubAssert(Buffer.byteLength(JSON.stringify(plan)) < HUB_LIMITS.metadataBytes - 2048, "quota_exceeded");
  return { ...plan, digest: planDigest(plan) };
}
export function applyHubCleanup<S>(access: CleanupAccess<S>, plan: HubCleanupPlan, proof: unknown): HubCleanupReceipt {
  const { digest, ...unsigned } = plan;
  hubAssert(HUB_UUID.test(plan.planId) && plan.schemaVersion === 1 && plan.scopeKey === access.scopeKey && plan.generation === access.generation
    && plan.candidates.length > 0 && plan.candidates.length <= 32 && digest === planDigest(unsigned), "invalid_request");
  for (const candidate of plan.candidates) hubAssert(/^attachment-[a-f0-9]{64}-[0-3]\.bin$/.test(candidate.fileId)
    && candidate.snapshot.nlink === 1 && Number.isSafeInteger(candidate.snapshot.size) && candidate.snapshot.size > 0
    && candidate.snapshot.size <= HUB_LIMITS.fileBytes && typeof candidate.unpublished === "boolean", "invalid_request");
  hubAssert(new Set(plan.candidates.map(row => row.fileId)).size === plan.candidates.length, "invalid_request");
  const journalName = `cleanup-${plan.planId}.json`, prior = access.disk.read(journalName);
  let journal: Journal;
  if (prior) {
    const value: unknown = JSON.parse(prior);
    hubAssert(plain(value) && value.schemaVersion === 1 && plain(value.plan) && value.plan.digest === digest && plain(value.receipt)
      && value.receipt.planId === plan.planId && Number.isSafeInteger(value.receipt.processedFiles)
      && Number(value.receipt.processedFiles) >= 0 && Number(value.receipt.processedFiles) <= plan.candidates.length
      && typeof value.receipt.complete === "boolean" && Number.isSafeInteger(value.receipt.removedPayloadBytes)
      && Number(value.receipt.removedPayloadBytes) >= 0 && Number(value.receipt.removedPayloadBytes) <= plan.payloadBytes
      && Number.isSafeInteger(value.receipt.alreadyMissingFiles) && Number(value.receipt.alreadyMissingFiles) >= 0
      && Number(value.receipt.alreadyMissingFiles) <= Number(value.receipt.processedFiles)
      && (!value.receipt.complete || value.receipt.processedFiles === plan.candidates.length), "store_unavailable");
    journal = value as unknown as Journal;
    if (journal.receipt.complete) return structuredClone(journal.receipt);
  } else {
    hubAssert(Date.parse(plan.expiresAt) >= access.now().getTime() && sha256(access.catalog().text ?? "") === plan.catalogDigest, "conflict");
    journal = { schemaVersion: 1, plan: structuredClone(plan), receipt: { planId: plan.planId, complete: false, processedFiles: 0, removedPayloadBytes: 0, alreadyMissingFiles: 0 } };
  }
  const published = new Set(access.catalog().entries.map(row => row.key));
  const currentReferences = new Map<string, string>();
  for (const name of access.disk.names().filter(name => /^message-[a-f0-9]{64}\.json$/.test(name))) {
    const key = name.slice(8, -5); for (const row of access.metadata(key).value.attachments) currentReferences.set(row.fileId, key);
  }
  for (const candidate of plan.candidates) {
    if (candidate.messageKey) hubAssert(currentReferences.get(candidate.fileId) === candidate.messageKey
      && candidate.unpublished === !published.has(candidate.messageKey), "conflict");
    else hubAssert(!currentReferences.has(candidate.fileId) && candidate.unpublished, "conflict");
  }
  // Recheck every remaining reference before recording a newly accepted cleanup intent.
  for (const candidate of plan.candidates.slice(journal.receipt.processedFiles)) hubAssert(allowed(access, candidate), "unauthorized");
  try { hubAssert(access.authority && access.authority.authorize(digest, proof) === undefined, "unauthorized"); }
  catch { throw new AgentHubError("unauthorized"); }
  const fence = () => access.assertCurrent();
  let journalText = prior;
  if (!prior) { journalText = JSON.stringify(journal); access.disk.write(journalName, journalText, null, fence, true); }
  for (let index = journal.receipt.processedFiles; index < plan.candidates.length; index++) {
    const candidate = plan.candidates[index]; hubAssert(allowed(access, candidate), "unauthorized"); access.assertCurrent();
    const before = access.disk.inspect(candidate.fileId);
    if (before) hubAssert(JSON.stringify(before) === JSON.stringify(candidate.snapshot), "conflict");
    if (candidate.messageKey) {
      const meta = access.metadata(candidate.messageKey), attachment = meta.value.attachments.find(row => row.attachmentId === candidate.attachmentId);
      hubAssert(attachment && attachment.fileId === candidate.fileId && attachment.bytes === candidate.snapshot.size
        && meta.value.messageId === candidate.messageId && meta.value.connectionId === candidate.connectionId, "conflict");
      if (attachment.state === "available") {
        hubAssert(metadataDigest(meta.value) === candidate.metadataDigest, "conflict");
        if (!candidate.unpublished) {
          attachment.state = "expired";
          access.disk.write(`message-${candidate.messageKey}.json`, JSON.stringify(meta.value), meta.text, () => {
            access.assertCurrent(); hubAssert(allowed(access, candidate), "unauthorized");
          }, true);
        }
      } else hubAssert(!candidate.unpublished && attachment.state === "expired", "conflict");
    }
    const current = access.disk.inspect(candidate.fileId);
    if (current) {
      hubAssert(JSON.stringify(current) === JSON.stringify(candidate.snapshot), "conflict");
      access.assertCurrent(); hubAssert(allowed(access, candidate), "unauthorized");
      access.disk.remove(candidate.fileId, current); journal.receipt.removedPayloadBytes += current.size;
    } else journal.receipt.alreadyMissingFiles++;
    journal.receipt.processedFiles = index + 1;
    const next = JSON.stringify(journal); access.disk.write(journalName, next, journalText, fence, true); journalText = next;
  }
  journal.receipt.complete = true;
  access.disk.write(journalName, JSON.stringify(journal), journalText, fence, true);
  return structuredClone(journal.receipt);
}
