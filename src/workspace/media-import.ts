import { IMPORT_IMAGE_TOO_LARGE, IMPORT_IMAGE_TYPES, MAX_IMPORT_IMAGE_BYTES } from "./media.js";

/** One chunk (base64 ≈ 87 KiB plus JSON framing) stays well under the Workspace RPC frame of 128 KiB. */
export const MAX_IMPORT_CHUNK_BYTES = 64 * 1024;
export const MEDIA_IMPORT_IDLE_MS = 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u;

export interface MediaImportChunk { workspaceId: string; generation: string; importId: string; mime: string; index: number; total: number; bytes: number; chunk: Buffer }
interface Pending { workspaceId: string; generation: string; importId: string; mime: string; total: number; bytes: number; next: number; received: number; parts: Buffer[]; timer: ReturnType<typeof setTimeout> }

export class MediaImportError extends Error {}
const aborted = (why: string) => new MediaImportError(`import_aborted: ${why}`);

/** Strict request parsing; the chunk itself is canonical base64 of at most one chunk's bytes. */
export function parseMediaImportChunk(params: Record<string, unknown>): MediaImportChunk {
  const { workspaceId, expectedGeneration, importId, mime, index, total, bytes, chunkBase64 } = params;
  if (typeof workspaceId !== "string" || typeof expectedGeneration !== "string" || typeof importId !== "string" || !UUID.test(importId)
    || typeof mime !== "string" || !Object.hasOwn(IMPORT_IMAGE_TYPES, mime)
    || !Number.isSafeInteger(index) || !Number.isSafeInteger(total) || !Number.isSafeInteger(bytes)
    || (index as number) < 0 || (total as number) < 1 || (index as number) >= (total as number) || (bytes as number) < 1) throw new Error("Invalid Workspace media import");
  // The declared size alone is enough to refuse; nothing further is accepted for this import.
  if ((bytes as number) > MAX_IMPORT_IMAGE_BYTES) throw new MediaImportError(IMPORT_IMAGE_TOO_LARGE);
  if ((total as number) !== Math.ceil((bytes as number) / MAX_IMPORT_CHUNK_BYTES)) throw new Error("Invalid Workspace media import");
  if (typeof chunkBase64 !== "string" || !chunkBase64 || chunkBase64.length > Math.ceil(MAX_IMPORT_CHUNK_BYTES / 3) * 4 || chunkBase64.length % 4 !== 0 || !BASE64.test(chunkBase64)) throw new Error("Invalid Workspace media import");
  const chunk = Buffer.from(chunkBase64, "base64");
  if (chunk.toString("base64") !== chunkBase64) throw new Error("Invalid Workspace media import");
  return { workspaceId, generation: expectedGeneration, importId, mime, index: index as number, total: total as number, bytes: bytes as number, chunk };
}

/**
 * Per-connection staging for chunked pasted-image imports. Memory only, never on disk; one import per
 * connection (a new import's first chunk replaces an abandoned one); chunks must arrive in order exactly
 * once. Anything unexpected discards the whole import.
 */
export class MediaImportSessions {
  private readonly pending = new Map<string, Pending>();
  constructor(private readonly idleMs = MEDIA_IMPORT_IDLE_MS) {}

  /** Returns the complete image once the last chunk arrives, otherwise null. Throws (and discards) on any violation. */
  accept(clientId: string, chunk: MediaImportChunk): { mime: string; bytes: Buffer } | null {
    let row = this.pending.get(clientId);
    if (row && row.importId !== chunk.importId) {
      // One connection is one client that imports one image at a time, so a new import's first chunk
      // means the staged one was abandoned (the user switched workspace, say): it replaces it.
      this.discard(clientId); row = undefined;
      if (chunk.index !== 0) throw aborted("unknown import");
    }
    if (!row) {
      if (chunk.index !== 0) throw aborted("chunk out of order");
      row = { workspaceId: chunk.workspaceId, generation: chunk.generation, importId: chunk.importId, mime: chunk.mime, total: chunk.total, bytes: chunk.bytes, next: 0, received: 0, parts: [],
        timer: setTimeout(() => this.discard(clientId), this.idleMs) };
      row.timer.unref?.();
      this.pending.set(clientId, row);
    }
    if (row.workspaceId !== chunk.workspaceId || row.generation !== chunk.generation) { this.discard(clientId); throw aborted("workspace generation changed"); }
    if (row.mime !== chunk.mime || row.total !== chunk.total || row.bytes !== chunk.bytes) { this.discard(clientId); throw aborted("chunk does not match the import"); }
    if (chunk.index !== row.next) { this.discard(clientId); throw aborted(chunk.index < row.next ? "duplicate chunk" : "chunk out of order"); }
    const last = chunk.index === row.total - 1;
    if (row.received + chunk.chunk.length > row.bytes || (!last && chunk.chunk.length !== MAX_IMPORT_CHUNK_BYTES)) { this.discard(clientId); throw aborted("chunk size does not match the declared size"); }
    row.parts.push(chunk.chunk); row.received += chunk.chunk.length; row.next++;
    clearTimeout(row.timer); row.timer = setTimeout(() => this.discard(clientId), this.idleMs); row.timer.unref?.();
    if (!last) return null;
    if (row.received !== row.bytes) { this.discard(clientId); throw aborted("final size does not match the declared size"); }
    const image = { mime: row.mime, bytes: Buffer.concat(row.parts, row.received) };
    this.discard(clientId); // wipes the staged parts; the joined copy is the only one left
    return image;
  }
  /** Drops staged bytes (timeout, disconnect, generation change, any violation). */
  discard(clientId: string): void {
    const row = this.pending.get(clientId); if (!row) return;
    clearTimeout(row.timer); for (const part of row.parts) part.fill(0); row.parts.length = 0; this.pending.delete(clientId);
  }
  has(clientId: string): boolean { return this.pending.has(clientId); }
  close(): void { for (const id of [...this.pending.keys()]) this.discard(id); }
}
