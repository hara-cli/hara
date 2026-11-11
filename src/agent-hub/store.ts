import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { AgentHubPrivateStore } from "./private-store.js";
import { AgentHubError, exact, hubAssert, plain } from "./errors.js";
import { HUB_LIMITS, parseHubAttachments, sha256 } from "./attachments.js";
import { payloadDigest, parseHubMetadata, storedAttachments, textPreview } from "./metadata.js";
import { planHubCleanup, applyHubCleanup, type HubCleanupAuthority, type HubCleanupPlan } from "./cleanup.js";
import { activeHubReadFiles, startHubRead, renewHubRead, releaseHubRead } from "./reader-leases.js";
import type { HaraStorageQuota } from "../storage/quota.js";
import type { AgentHubBoundaryContract, AgentHubDirectory, HubStoredMessage, HubVisibleMessage, RegisteredHubAgent } from "./contracts.js";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const HEX = /^[a-f0-9]{64}$/;
interface Grant { connectionId: string; agent: RegisteredHubAgent; epoch: number; generation: string; tokenHash: string; revoked: boolean }
interface Entry<R> { key: string; connectionId: string; requestId: string; messageId: string; digest: string; seq: number; receipt: R }
interface Catalog<R> { schema: 2; nextSeq: number; grants: Grant[]; entries: Entry<R>[]; read: Record<string, number> }
export interface AgentHubOptions<S, R> {
  /** Explicit Host-owned home, never derived from an ingress request. */
  home: string;
  /** Opaque C0 resource binding from the trusted Host, not a request-supplied Workspace. */
  scopeKey: string; generation: string;
  /** C1 Host authority check. A C0 syntax parser or client-declared capability is not this proof. */
  assertCurrent(): void;
  directory: AgentHubDirectory; boundary: AgentHubBoundaryContract<S, R>;
  globalQuota: HaraStorageQuota; cleanupAuthority?: HubCleanupAuthority;
  quotaBytes?: number; now?: () => Date;
}
function validAgent(value: unknown): value is RegisteredHubAgent {
  return plain(value) && exact(value, ["agentId", "instanceId", "alias", "displayName", "engine"])
    && [value.agentId, value.instanceId, value.alias].every(part => typeof part === "string" && ID.test(part))
    && typeof value.displayName === "string" && value.displayName.length > 0 && value.displayName.length <= 160
    && !/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(value.displayName)
    && ["claude", "codex", "opencode", "other"].includes(value.engine as string);
}
const copy = <T>(value: T): T => structuredClone(value);
/** A passive mailbox. No provider/Host task/tool/scheduler dependencies or callbacks are accepted. */
export class AgentHubStore<S, R> {
  private readonly disk: AgentHubPrivateStore;
  private readonly quota: number;
  constructor(private readonly options: AgentHubOptions<S, R>) {
    hubAssert(HEX.test(options.scopeKey) && UUID.test(options.generation));
    this.disk = new AgentHubPrivateStore(options.home, options.scopeKey, options.globalQuota);
    this.quota = options.quotaBytes ?? HUB_LIMITS.quotaBytes;
    hubAssert(Number.isSafeInteger(this.quota) && this.quota >= 4096 && this.quota <= HUB_LIMITS.quotaBytes);
  }
  /** Cold/expired census belongs to listener startup, before any request deadline starts. */
  async prepare(): Promise<void> { this.assertCurrent(); await this.options.globalQuota.prepare(); this.assertCurrent(); }
  private assertCurrent(): void {
    try { hubAssert(this.options.assertCurrent() === undefined, "unauthorized"); }
    catch { throw new AgentHubError("unauthorized"); }
  }
  private transaction<T>(fn: () => T): T {
    return this.disk.transaction(() => { this.assertCurrent(); return fn(); });
  }
  private catalog(): { value: Catalog<R>; text: string | null } {
    const text = this.disk.read("catalog.json");
    if (text === null) {
      hubAssert(this.disk.usage().messages === 0, "store_unavailable");
      return { text, value: { schema: 2, nextSeq: 1, grants: [], entries: [], read: {} } };
    }
    const value: unknown = JSON.parse(text);
    hubAssert(plain(value) && exact(value, ["schema", "nextSeq", "grants", "entries", "read"]) && value.schema === 2
      && Number.isSafeInteger(value.nextSeq) && Number(value.nextSeq) >= 1 && plain(value.read)
      && Array.isArray(value.grants) && value.grants.length <= HUB_LIMITS.connections
      && Array.isArray(value.entries) && value.entries.length <= HUB_LIMITS.messages, "store_unavailable");
    const connections = new Set<string>();
    for (const row of value.grants) {
      hubAssert(plain(row) && exact(row, ["connectionId", "agent", "epoch", "generation", "tokenHash", "revoked"])
        && typeof row.connectionId === "string" && UUID.test(row.connectionId) && !connections.has(row.connectionId)
        && typeof row.generation === "string" && UUID.test(row.generation)
        && validAgent(row.agent) && Number.isSafeInteger(row.epoch) && Number(row.epoch) >= 1
        && typeof row.tokenHash === "string" && HEX.test(row.tokenHash) && typeof row.revoked === "boolean", "store_unavailable");
      connections.add(row.connectionId);
    }
    let seq = 0; const requests = new Set<string>(), ids = new Set<string>();
    for (const row of value.entries) {
      hubAssert(plain(row) && exact(row, ["key", "connectionId", "requestId", "messageId", "digest", "seq", "receipt"])
        && typeof row.key === "string" && HEX.test(row.key) && typeof row.connectionId === "string" && connections.has(row.connectionId)
        && typeof row.requestId === "string" && UUID.test(row.requestId) && typeof row.messageId === "string" && UUID.test(row.messageId)
        && typeof row.digest === "string" && HEX.test(row.digest) && Number.isSafeInteger(row.seq) && Number(row.seq) > seq
        && Number(row.seq) < Number(value.nextSeq) && this.options.boundary.isSavedReceipt(row.receipt), "store_unavailable");
      hubAssert(!requests.has(row.key) && !ids.has(row.messageId), "store_unavailable");
      requests.add(row.key); ids.add(row.messageId); seq = Number(row.seq);
    }
    for (const [connection, read] of Object.entries(value.read)) hubAssert(connections.has(connection)
      && Number.isSafeInteger(read) && Number(read) >= 0 && Number(read) < Number(value.nextSeq), "store_unavailable");
    return { text, value: value as unknown as Catalog<R> };
  }
  private write(catalog: Catalog<R>, previous: string | null, additionalBytes = 0, revoking = false, fence = () => this.assertCurrent()): void {
    const next = JSON.stringify(catalog);
    hubAssert(Buffer.byteLength(next) <= HUB_LIMITS.catalogBytes, "quota_exceeded");
    // Include the replacement staging file in the peak budget; do not silently evict user content.
    if (!revoking) hubAssert(this.disk.usage().bytes + additionalBytes + Buffer.byteLength(next) <= this.quota, "quota_exceeded");
    this.disk.write("catalog.json", next, previous, fence, revoking);
  }
  private registered(agentId: string): RegisteredHubAgent {
    let agent: RegisteredHubAgent | null;
    try { agent = this.options.directory.registeredAgent(agentId); } catch { throw new AgentHubError("registry_unavailable"); }
    hubAssert(validAgent(agent) && agent.agentId === agentId, "registry_unavailable"); return copy(agent);
  }
  private current(grant: Grant): void {
    this.assertCurrent();
    hubAssert(!grant.revoked && grant.generation === this.options.generation, "unauthorized");
    const registered = this.registered(grant.agent.agentId);
    hubAssert(registered.instanceId === grant.agent.instanceId && registered.alias === grant.agent.alias
      && registered.engine === grant.agent.engine, "unauthorized");
  }
  private authorized(catalog: Catalog<R>, token: unknown): Grant {
    hubAssert(typeof token === "string" && HEX.test(token), "unauthorized");
    const hash = Buffer.from(sha256(token), "hex");
    const grant = catalog.grants.find(row => timingSafeEqual(hash, Buffer.from(row.tokenHash, "hex")));
    hubAssert(grant, "unauthorized"); this.current(grant); return grant;
  }
  /** Trusted Host API only. No ingress endpoint exposes token issuance, listing, rotation or revocation. */
  issueGrant(agentId: string): { connectionId: string; token: string; from: string } {
    return this.transaction(() => {
      const { value, text } = this.catalog(), agent = this.registered(agentId);
      hubAssert(value.grants.length < HUB_LIMITS.connections, "quota_exceeded");
      const token = randomBytes(32).toString("hex"), connectionId = randomUUID();
      value.grants.push({ connectionId, agent, epoch: 1, generation: this.options.generation, tokenHash: sha256(token), revoked: false });
      this.write(value, text); return { connectionId, token, from: agent.alias };
    });
  }
  rotateGrant(connectionId: string): { connectionId: string; token: string; from: string } {
    return this.transaction(() => {
      const { value, text } = this.catalog(), grant = value.grants.find(row => row.connectionId === connectionId);
      hubAssert(grant, "unauthorized"); this.current(grant);
      hubAssert(grant.epoch < Number.MAX_SAFE_INTEGER, "store_unavailable");
      const token = randomBytes(32).toString("hex"); grant.epoch++; grant.tokenHash = sha256(token);
      this.write(value, text); return { connectionId, token, from: grant.agent.alias };
    });
  }
  revokeGrant(connectionId: string): void {
    this.transaction(() => {
      const { value, text } = this.catalog(), grant = value.grants.find(row => row.connectionId === connectionId);
      hubAssert(grant, "unauthorized"); grant.revoked = true; this.write(value, text, 0, true);
    });
  }
  /** Admission before streaming a body; receive() rechecks after streaming and under the write lock. */
  authorize(token: unknown): void { this.transaction(() => { this.authorized(this.catalog().value, token); }); }
  receive(token: unknown, input: unknown): R {
    return this.transaction(() => {
      const { value, text: previous } = this.catalog(), grant = this.authorized(value, token);
      hubAssert(plain(input) && exact(input, ["requestId", "from", "text", "attachments"])
        && typeof input.requestId === "string" && UUID.test(input.requestId)
        && typeof input.from === "string" && input.from === grant.agent.alias
        && typeof input.text === "string" && Buffer.byteLength(input.text) <= HUB_LIMITS.textBytes
        && Buffer.from(input.text).toString("utf8") === input.text);
      const attachments = parseHubAttachments(input.attachments);
      hubAssert(input.text.trim().length > 0 || attachments.length > 0);
      const textHash = sha256(input.text), digest = payloadDigest(textHash, attachments), key = sha256(`${grant.connectionId}:${input.requestId}`);
      const prior = value.entries.find(row => row.key === key);
      if (prior) { hubAssert(prior.digest === digest, "conflict"); return copy(prior.receipt); }
      hubAssert(value.entries.length < HUB_LIMITS.messages && value.nextSeq < Number.MAX_SAFE_INTEGER, "quota_exceeded");
      const filename = `message-${key}.json`, orphan = this.disk.read(filename);
      let message: HubStoredMessage<S>;
      if (orphan !== null) {
        message = parseHubMetadata(orphan, key, this.options.boundary);
        hubAssert(message.connectionId === grant.connectionId && message.requestId === input.requestId && message.digest === digest, "conflict");
        // The parser above admits historical display records. Recovery is a new publication:
        // preserve only provenance equal to the current factory for this authenticated grant.
        const expectedSource = this.options.boundary.externalSource(copy(grant.agent));
        hubAssert(this.options.boundary.isExternalSource(expectedSource), "store_unavailable");
        hubAssert(isDeepStrictEqual(message.source, expectedSource), "conflict");
      } else {
        const source = this.options.boundary.externalSource(copy(grant.agent));
        hubAssert(this.options.boundary.isExternalSource(source), "store_unavailable");
        message = { schema: 2, messageId: randomUUID(), requestId: input.requestId, connectionId: grant.connectionId, digest, source,
          receivedAt: (this.options.now?.() ?? new Date()).toISOString(),
          text: { fileId: `body-${key}.bin`, bytes: Buffer.byteLength(input.text), sha256: textHash, preview: textPreview(input.text) },
          attachments: storedAttachments(key, attachments) };
      }
      const encoded = JSON.stringify(message); hubAssert(Buffer.byteLength(encoded) <= HUB_LIMITS.metadataBytes, "quota_exceeded");
      const seq = value.nextSeq++, receipt = this.options.boundary.savedReceipt({ messageId: message.messageId,
        requestId: message.requestId, connectionId: grant.connectionId, seq, savedAt: message.receivedAt });
      hubAssert(this.options.boundary.isSavedReceipt(receipt), "store_unavailable");
      value.entries.push({ key, connectionId: grant.connectionId, requestId: message.requestId, messageId: message.messageId, digest, seq, receipt });
      const blobs = [{ fileId: message.text.fileId, bytes: Buffer.from(input.text), digest: textHash },
        ...message.attachments.map((row, index) => ({ fileId: row.fileId, bytes: Buffer.from(attachments[index].base64, "base64"), digest: row.sha256 }))];
      const additional = (orphan === null ? Buffer.byteLength(encoded) : 0)
        + blobs.reduce((sum, row) => sum + (this.disk.inspect(row.fileId) ? 0 : row.bytes.length), 0);
      const peak = additional + Buffer.byteLength(JSON.stringify(value));
      hubAssert(this.disk.usage().bytes + peak <= this.quota, "quota_exceeded");
      this.options.globalQuota.admitGrowth(peak);
      const fence = () => this.current(grant);
      for (const blob of blobs) this.disk.writeBlob(blob.fileId, blob.bytes, blob.digest, fence);
      if (orphan === null) this.disk.write(filename, encoded, null, fence);
      // Assets/metadata may be orphaned by a crash; deterministic names permit bounded verified reuse.
      this.write(value, previous, 0, false, fence); return copy(receipt);
    });
  }
  private metadata(key: string): { value: HubStoredMessage<S>; text: string } {
    const text = this.disk.read(`message-${key}.json`); hubAssert(text !== null, "store_unavailable");
    return { text, value: parseHubMetadata(text, key, this.options.boundary) };
  }
  private selected(connectionId: string, messageId: string) {
    hubAssert(UUID.test(connectionId) && UUID.test(messageId));
    const entry = this.catalog().value.entries.find(row => row.connectionId === connectionId && row.messageId === messageId);
    hubAssert(entry, "invalid_request"); const meta = this.metadata(entry.key);
    hubAssert(meta.value.messageId === entry.messageId && meta.value.connectionId === entry.connectionId
      && meta.value.requestId === entry.requestId && meta.value.digest === entry.digest, "store_unavailable");
    return { entry, ...meta };
  }
  receipt(token: unknown, requestId: string): R | null {
    return this.transaction(() => {
      hubAssert(UUID.test(requestId)); const { value } = this.catalog(), grant = this.authorized(value, token);
      return copy(value.entries.find(row => row.connectionId === grant.connectionId && row.requestId === requestId)?.receipt ?? null);
    });
  }
  /** Metadata only; a page cannot trigger any body/attachment read or exceed its UTF-8 byte budget. */
  messages(connectionId: string, afterSeq = 0, limit = 50, pageBytes = HUB_LIMITS.pageBytes): HubVisibleMessage<S>[] {
    return this.transaction(() => {
      hubAssert(UUID.test(connectionId) && Number.isSafeInteger(afterSeq) && afterSeq >= 0
        && Number.isSafeInteger(limit) && limit >= 1 && limit <= 50
        && Number.isSafeInteger(pageBytes) && pageBytes >= HUB_LIMITS.metadataBytes && pageBytes <= HUB_LIMITS.pageBytes);
      const results: HubVisibleMessage<S>[] = []; let bytes = 2;
      for (const row of this.catalog().value.entries.filter(row => row.connectionId === connectionId && row.seq > afterSeq)) {
        const stored = this.metadata(row.key).value;
        hubAssert(stored.messageId === row.messageId && stored.connectionId === row.connectionId
          && stored.requestId === row.requestId && stored.digest === row.digest, "store_unavailable");
        const item: HubVisibleMessage<S> = { schema: 2, messageId: stored.messageId, requestId: stored.requestId,
          connectionId: stored.connectionId, source: stored.source, receivedAt: stored.receivedAt, seq: row.seq,
          textPreview: stored.text.preview, textBytes: stored.text.bytes,
          attachments: stored.attachments.map(({ fileId: _, ...attachment }) => attachment) };
        const cost = Buffer.byteLength(JSON.stringify(item)) + (results.length ? 1 : 0);
        if (bytes + cost > pageBytes) { hubAssert(results.length > 0, "quota_exceeded"); break; }
        results.push(item); bytes += cost; if (results.length === limit) break;
      }
      return results;
    });
  }
  readText(connectionId: string, messageId: string): string {
    return this.transaction(() => {
      const meta = this.selected(connectionId, messageId).value;
      const bytes = this.disk.readChunk(meta.text.fileId, 0, HUB_LIMITS.chunkBytes, meta.text.bytes);
      const text = bytes.toString("utf8");
      hubAssert(Buffer.from(text).equals(bytes) && sha256(bytes) === meta.text.sha256 && textPreview(text) === meta.text.preview, "store_unavailable");
      return text;
    });
  }
  /** One authorized attachment, streamed in <=64 KiB chunks. A durable lease protects in-flight reads.
   * Caller verifies stream completion before saving/previewing; quarantine is not lifted by this API. */
  async *readAttachment(connectionId: string, messageId: string, attachmentId: string): AsyncGenerator<Buffer> {
    const lease = this.transaction(() => {
      const attachment = this.selected(connectionId, messageId).value.attachments.find(row => row.attachmentId === attachmentId);
      hubAssert(attachment && attachment.state === "available", "invalid_request");
      const handle = startHubRead(this.disk, attachment.fileId, this.options.now?.() ?? new Date(), () => this.assertCurrent());
      return { ...handle, attachment };
    });
    const hash = createHash("sha256");
    try {
      for (let offset = 0; offset < lease.attachment.bytes; offset += HUB_LIMITS.chunkBytes) {
        const bytes = this.transaction(() => {
          renewHubRead(this.disk, lease, this.options.now?.() ?? new Date(), () => this.assertCurrent());
          const current = this.selected(connectionId, messageId).value.attachments.find(row => row.attachmentId === attachmentId);
          hubAssert(current?.state === "available" && current.fileId === lease.attachment.fileId, "invalid_request");
          return this.disk.readChunk(current.fileId, offset, HUB_LIMITS.chunkBytes, current.bytes);
        });
        hash.update(bytes); yield bytes;
      }
      hubAssert(hash.digest("hex") === lease.attachment.sha256, "store_unavailable");
    } finally {
      // Releasing this exact private lease does not grant authority or require restoring a revoked scope.
      this.disk.transaction(() => releaseHubRead(this.disk, lease));
    }
  }
  reapExpiredReadLeases(): void {
    this.transaction(() => { activeHubReadFiles(this.disk, this.options.now?.() ?? new Date()); });
  }
  private cleanupAccess() {
    return { disk: this.disk, scopeKey: this.options.scopeKey, generation: this.options.generation,
      now: () => this.options.now?.() ?? new Date(), assertCurrent: () => this.assertCurrent(), authority: this.options.cleanupAuthority,
      catalog: () => { const { value, text } = this.catalog(); return { text, entries: value.entries }; },
      metadata: (key: string) => this.metadata(key) };
  }
  planAttachmentCleanup(targetBytes: number) { return this.transaction(() => planHubCleanup(this.cleanupAccess(), targetBytes)); }
  cleanupAttachments(plan: HubCleanupPlan, proof: unknown) { return this.transaction(() => applyHubCleanup(this.cleanupAccess(), plan, proof)); }
  storageUsage() { return this.transaction(() => ({ scopeBytes: this.disk.usage().bytes, scopeLimitBytes: this.quota,
    globalBytes: this.options.globalQuota.usageBytes(), globalLimitBytes: this.options.globalQuota.limitBytes })); }
  markRead(connectionId: string, throughSeq: number): void {
    this.transaction(() => {
      const { value, text } = this.catalog();
      hubAssert(value.grants.some(row => row.connectionId === connectionId) && Number.isSafeInteger(throughSeq) && throughSeq >= 0);
      const last = value.entries.filter(row => row.connectionId === connectionId).at(-1)?.seq ?? 0;
      hubAssert(throughSeq <= last); value.read[connectionId] = Math.max(value.read[connectionId] ?? 0, throughSeq); this.write(value, text);
    });
  }
  unread(connectionId: string): number {
    return this.transaction(() => { const { value } = this.catalog(); return value.entries.filter(row => row.connectionId === connectionId && row.seq > (value.read[connectionId] ?? 0)).length; });
  }
}
