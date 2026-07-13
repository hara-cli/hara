import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";

/** A single inbound attachment must never consume unbounded memory or disk. */
export const INBOUND_MEDIA_MAX_BYTES = 20 * 1024 * 1024;
export const INBOUND_MEDIA_MAX_FILES = 4;
export const INBOUND_MEDIA_TIMEOUT_MS = 60_000;
export const INBOUND_MEDIA_MAX_ACTIVE = 8;
export const INBOUND_MEDIA_MAX_ACTIVE_PER_PLATFORM = 2;
export const INBOUND_MEDIA_MAX_RETAINED_BYTES = 160 * 1024 * 1024;
export const INBOUND_MEDIA_MAX_RETAINED_FILES = 32;
export const INBOUND_MEDIA_MAX_RETAINED_BYTES_PER_PLATFORM = 40 * 1024 * 1024;
export const INBOUND_MEDIA_MAX_RETAINED_FILES_PER_PLATFORM = 8;

export class MediaSizeLimitError extends Error {
  constructor(readonly limit: number) {
    super(`inbound media exceeds ${limit} byte limit`);
    this.name = "MediaSizeLimitError";
  }
}

type WebReader = {
  read(): Promise<{ done: boolean; value?: unknown }>;
  cancel(reason?: unknown): Promise<unknown>;
};

type MediaSource =
  | { getReader(): WebReader }
  | (AsyncIterable<unknown> & { destroy?(error?: Error): void });

export interface PrivateMediaOptions {
  platform: string;
  filenameHint?: string;
  contentType?: string | null;
  maxBytes?: number;
  /** Cancels both a pending stream read and partial-file publication. */
  signal?: AbortSignal;
  /** Test/embedding override. The default is the user's ~/.hara directory. */
  baseDir?: string;
}

const OWNED_MEDIA_NAME = /^(?:\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.part|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[a-z0-9]{1,10})$/i;
export const INBOUND_MEDIA_TTL_MS = 24 * 60 * 60 * 1000;

const LEGACY_MEDIA_NAME: Readonly<Record<string, RegExp>> = {
  telegram: /^tg_\d{10,17}_[^/]{1,255}$/,
  discord: /^dc_\d{10,17}_[^/]{1,255}$/,
  feishu: /^fs_\d{10,17}_[a-z0-9_-]{1,32}\.(?:jpg|bin)$/i,
  slack: /^sl_\d{10,17}_[^/]{1,255}$/,
  mattermost: /^mm_\d{10,17}_[^/]{1,255}$/,
  matrix: /^mx_\d{10,17}_[^/]{1,64}$/,
  signal: /^sig_\d{10,17}_[^/]{1,64}\.(?:png|jpe?g|gif|webp|bin)$/i,
  wecom: /^wc_\d{10,17}_[^/]{1,255}$/,
  weixin: /^(?:img_[0-9a-f]{8}\.jpg|audio_[0-9a-f]{8}\.silk|[0-9a-f]{8}_[^/]{1,80})$/i,
};

const activeByPlatform = new Map<string, number>();
let activeDownloads = 0;
type RetentionUsage = { bytes: number; files: number };
type RetentionClaim = { platform: string; bytes: number; active: boolean };
const retainedPaths = new Map<string, { platform: string; bytes: number }>();
const retainedByPlatform = new Map<string, RetentionUsage>();
const reservedByPlatform = new Map<string, RetentionUsage>();
let retainedBytes = 0;
let retainedFiles = 0;
let reservedBytes = 0;
let reservedFiles = 0;

function checkedLimit(value: number | undefined): number {
  const limit = value ?? INBOUND_MEDIA_MAX_BYTES;
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("maxBytes must be a positive safe integer");
  return limit;
}

function checkedPlatform(value: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(value)) throw new TypeError("invalid media platform name");
  return value.toLowerCase();
}

function extensionFromContentType(contentType: string | null | undefined): string {
  const mime = String(contentType ?? "").split(";", 1)[0].trim().toLowerCase();
  const known: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "audio/mpeg": ".mp3",
    "audio/ogg": ".ogg",
    "audio/wav": ".wav",
    "video/mp4": ".mp4",
    "application/pdf": ".pdf",
    "text/plain": ".txt",
  };
  return known[mime] ?? ".bin";
}

/** Keep only a short conventional extension; the remote filename never becomes part of the local basename. */
export function safeMediaExtension(filenameHint?: string, contentType?: string | null): string {
  const candidate = extname(basename(String(filenameHint ?? ""))).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(candidate) ? candidate : extensionFromContentType(contentType);
}

async function checkedDirectory(path: string, label: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`unsafe ${label} directory: ${path}`);
}

async function assertContainedDirectory(root: string, platformDir: string, mediaDir: string): Promise<void> {
  const [rootReal, platformReal, mediaReal] = await Promise.all([realpath(root), realpath(platformDir), realpath(mediaDir)]);
  if (platformReal !== join(rootReal, basename(platformDir)) || mediaReal !== join(platformReal, "media")) {
    throw new Error(`media directory escapes its private root: ${mediaDir}`);
  }
}

export async function ensurePrivateMediaDir(platform: string, baseDir = join(homedir(), ".hara")): Promise<string> {
  const root = resolve(baseDir);
  const platformDir = join(root, checkedPlatform(platform));
  const dir = join(platformDir, "media");
  await mkdir(root, { recursive: true, mode: 0o700 });
  await checkedDirectory(root, "media root");
  await mkdir(platformDir, { mode: 0o700 }).catch((error: any) => {
    if (error?.code !== "EEXIST") throw error;
  });
  await checkedDirectory(platformDir, "platform media");
  await mkdir(dir, { mode: 0o700 }).catch((error: any) => {
    if (error?.code !== "EEXIST") throw error;
  });
  await checkedDirectory(dir, "media");
  await assertContainedDirectory(root, platformDir, dir);
  // Existing directories may predate private media storage. Tighten every component before writing secrets.
  await Promise.all([chmod(root, 0o700), chmod(platformDir, 0o700), chmod(dir, 0o700)]);
  return dir;
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("inbound media download aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

async function readWithSignal(reader: { read: WebReader["read"] }, signal?: AbortSignal): ReturnType<WebReader["read"]> {
  throwIfAborted(signal);
  if (!signal) return reader.read();
  return await new Promise((resolveRead, rejectRead) => {
    const onAbort = (): void => rejectRead(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    void reader.read().then(resolveRead, rejectRead).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function cancelWithoutBlocking(reader: { cancel(reason?: unknown): Promise<void> }, reason?: unknown): void {
  void reader.cancel(reason).catch(() => undefined);
}

async function settleWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  return await new Promise<T>((resolveValue, rejectValue) => {
    const onAbort = (): void => rejectValue(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(resolveValue, rejectValue).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function deadlineSignal(parent?: AbortSignal, timeoutMs = INBOUND_MEDIA_TIMEOUT_MS): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`inbound media download timed out after ${timeoutMs}ms`)), timeoutMs);
  timer.unref?.();
  const onAbort = (): void => controller.abort(parent ? abortReason(parent) : undefined);
  if (parent?.aborted) onAbort();
  else parent?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    },
  };
}

function usage(map: Map<string, RetentionUsage>, platform: string): RetentionUsage {
  return map.get(platform) ?? { bytes: 0, files: 0 };
}

function adjustUsage(map: Map<string, RetentionUsage>, platform: string, bytes: number, files: number): void {
  const current = usage(map, platform);
  const next = { bytes: current.bytes + bytes, files: current.files + files };
  if (next.bytes > 0 || next.files > 0) map.set(platform, next);
  else map.delete(platform);
}

function claimRetention(platform: string, requestedBytes: number): RetentionClaim | undefined {
  const retainedPlatform = usage(retainedByPlatform, platform);
  const reservedPlatform = usage(reservedByPlatform, platform);
  if (
    retainedFiles + reservedFiles >= INBOUND_MEDIA_MAX_RETAINED_FILES
    || retainedPlatform.files + reservedPlatform.files >= INBOUND_MEDIA_MAX_RETAINED_FILES_PER_PLATFORM
  ) return undefined;
  const available = Math.min(
    requestedBytes,
    INBOUND_MEDIA_MAX_RETAINED_BYTES - retainedBytes - reservedBytes,
    INBOUND_MEDIA_MAX_RETAINED_BYTES_PER_PLATFORM - retainedPlatform.bytes - reservedPlatform.bytes,
  );
  if (available <= 0) return undefined;
  reservedBytes += available;
  reservedFiles++;
  adjustUsage(reservedByPlatform, platform, available, 1);
  return { platform, bytes: available, active: true };
}

function releaseClaim(claim: RetentionClaim): void {
  if (!claim.active) return;
  claim.active = false;
  reservedBytes -= claim.bytes;
  reservedFiles--;
  adjustUsage(reservedByPlatform, claim.platform, -claim.bytes, -1);
}

function retainClaimedPath(claim: RetentionClaim, path: string, bytes: number): boolean {
  if (!claim.active || bytes <= 0 || bytes > claim.bytes || retainedPaths.has(path)) return false;
  releaseClaim(claim);
  retainedPaths.set(path, { platform: claim.platform, bytes });
  retainedBytes += bytes;
  retainedFiles++;
  adjustUsage(retainedByPlatform, claim.platform, bytes, 1);
  return true;
}

function releaseRetainedPath(path: string): void {
  const retained = retainedPaths.get(path);
  if (!retained) return;
  retainedPaths.delete(path);
  retainedBytes -= retained.bytes;
  retainedFiles--;
  adjustUsage(retainedByPlatform, retained.platform, -retained.bytes, -1);
}

/** Diagnostic visibility for tests and operators; paths themselves are deliberately not exposed. */
export function inboundMediaQuotaUsage(): {
  retainedBytes: number;
  retainedFiles: number;
  reservedBytes: number;
  reservedFiles: number;
} {
  return { retainedBytes, retainedFiles, reservedBytes, reservedFiles };
}

/** Per-message budget plus process-wide admission control. Claims count attempts, not successes, so invalid
 * attachment lists cannot generate unlimited network requests. Saturated slots fail closed instead of queueing. */
export class InboundMediaBudget {
  private attempts = 0;
  private bytes = 0;
  readonly platform: string;

  constructor(
    platform: string,
    private readonly parentSignal?: AbortSignal,
    private readonly baseDir?: string,
    private readonly timeoutMs = INBOUND_MEDIA_TIMEOUT_MS,
  ) {
    this.platform = checkedPlatform(platform);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError("timeoutMs must be a positive safe integer");
  }

  get remainingBytes(): number {
    return Math.max(0, INBOUND_MEDIA_MAX_BYTES - this.bytes);
  }

  get attemptedFiles(): number {
    return this.attempts;
  }

  async download(save: (options: { maxBytes: number; signal: AbortSignal }) => Promise<string | null>): Promise<string | null> {
    if (this.attempts >= INBOUND_MEDIA_MAX_FILES || this.remainingBytes <= 0 || this.parentSignal?.aborted) return null;
    this.attempts++;
    const platformActive = activeByPlatform.get(this.platform) ?? 0;
    if (activeDownloads >= INBOUND_MEDIA_MAX_ACTIVE || platformActive >= INBOUND_MEDIA_MAX_ACTIVE_PER_PLATFORM) return null;
    const claim = claimRetention(this.platform, this.remainingBytes);
    if (!claim) return null;
    activeDownloads++;
    activeByPlatform.set(this.platform, platformActive + 1);
    const deadline = deadlineSignal(this.parentSignal, this.timeoutMs);
    let path: string | null = null;
    let operationSettled = false;
    let deferredRelease = false;
    const releaseSlot = (): void => {
      activeDownloads--;
      const next = (activeByPlatform.get(this.platform) ?? 1) - 1;
      if (next > 0) activeByPlatform.set(this.platform, next);
      else activeByPlatform.delete(this.platform);
    };
    const operation = Promise.resolve()
      .then(() => save({ maxBytes: claim.bytes, signal: deadline.signal }))
      .finally(() => {
        operationSettled = true;
      });
    try {
      path = await settleWithSignal(operation, deadline.signal);
      if (!path) return null;
      throwIfAborted(deadline.signal);
      const owned = await ownedMediaPath(this.platform, path, this.baseDir);
      if (!owned) {
        await cleanupTransientMedia(this.platform, [path], this.baseDir);
        return null;
      }
      const info = await lstat(owned);
      if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > claim.bytes) {
        await cleanupTransientMedia(this.platform, [path], this.baseDir);
        return null;
      }
      if (!retainClaimedPath(claim, owned, info.size)) {
        await cleanupTransientMedia(this.platform, [owned], this.baseDir);
        return null;
      }
      this.bytes += info.size;
      return owned;
    } catch {
      if (!operationSettled) {
        // Fetch/stream implementations that honor AbortSignal normally settle immediately; give them a short
        // grace window so callers observe an already-removed partial file. SDKs that ignore abort keep both their
        // active and retained reservation until they really settle, bounding abandoned work.
        const grace = await Promise.race([
          operation.then(
            (latePath) => ({ settled: true as const, latePath }),
            () => ({ settled: true as const, latePath: null }),
          ),
          new Promise<{ settled: false }>((resolveGrace) => setTimeout(() => resolveGrace({ settled: false }), 250)),
        ]);
        if (grace.settled) {
          if (grace.latePath) await cleanupTransientMedia(this.platform, [grace.latePath], this.baseDir);
        } else {
          deferredRelease = true;
          void operation
            .then((latePath) => latePath ? cleanupTransientMedia(this.platform, [latePath], this.baseDir) : undefined)
            .catch(() => undefined)
            .finally(() => {
              releaseClaim(claim);
              releaseSlot();
            });
        }
      }
      if (path) await cleanupTransientMedia(this.platform, [path], this.baseDir);
      return null;
    } finally {
      deadline.dispose();
      if (!deferredRelease) {
        releaseClaim(claim);
        releaseSlot();
      }
    }
  }
}

function sourceReader(source: MediaSource): { read: WebReader["read"]; cancel(reason?: unknown): Promise<void> } {
  if (source && typeof (source as { getReader?: unknown }).getReader === "function") {
    const reader = (source as { getReader(): WebReader }).getReader();
    return {
      read: () => reader.read(),
      cancel: async (reason) => {
        await reader.cancel(reason).catch(() => undefined);
      },
    };
  }
  if (source && typeof (source as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function") {
    const iterable = source as AsyncIterable<unknown> & { destroy?(error?: Error): void };
    const iterator = iterable[Symbol.asyncIterator]();
    return {
      read: async () => {
        const result = await iterator.next();
        return { done: result.done === true, value: result.value };
      },
      cancel: async (reason) => {
        const error = reason instanceof Error ? reason : undefined;
        try {
          iterable.destroy?.(error);
        } catch {
          /* cleanup must continue even if a custom stream throws from destroy */
        }
        await iterator.return?.().catch(() => undefined);
      },
    };
  }
  throw new TypeError("media response has no readable stream");
}

function asBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string") return Buffer.from(value);
  throw new TypeError("media stream emitted a non-byte chunk");
}

async function writeFully(handle: Awaited<ReturnType<typeof open>>, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset);
    if (bytesWritten <= 0) throw new Error("failed to write inbound media");
    offset += bytesWritten;
  }
}

/**
 * Stream an attachment to a same-directory private temporary file, enforce the hard cap while reading, then
 * atomically publish it. Callers only ever observe complete files; failures leave neither partial nor final data.
 */
export async function savePrivateMedia(source: MediaSource, options: PrivateMediaOptions): Promise<string> {
  const limit = checkedLimit(options.maxBytes);
  throwIfAborted(options.signal);
  const dir = await ensurePrivateMediaDir(options.platform, options.baseDir);
  const extension = safeMediaExtension(options.filenameHint, options.contentType);
  const id = randomUUID();
  const temporaryPath = join(dir, `.${id}.part`);
  const finalPath = join(dir, `${id}${extension}`);
  const reader = sourceReader(source);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let published = false;
  let total = 0;
  const onAbort = (): void => cancelWithoutBlocking(reader, options.signal ? abortReason(options.signal) : undefined);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    while (true) {
      const chunk = await readWithSignal(reader, options.signal);
      if (chunk.done) break;
      const bytes = asBytes(chunk.value);
      if (bytes.byteLength > limit - total) {
        const error = new MediaSizeLimitError(limit);
        cancelWithoutBlocking(reader, error);
        throw error;
      }
      await writeFully(handle, bytes);
      total += bytes.byteLength;
    }
    throwIfAborted(options.signal);
    if (total === 0) throw new Error("inbound media is empty");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, finalPath);
    published = true;
    await chmod(finalPath, 0o600);
    // Best-effort directory fsync makes the atomic rename durable without making unsupported filesystems fail.
    try {
      const directory = await open(dir, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch {
      /* durability enhancement only */
    }
    return finalPath;
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(published ? finalPath : temporaryPath).catch(() => undefined);
    cancelWithoutBlocking(reader, error);
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
  }
}

function declaredLength(response: Response): number | undefined {
  const raw = response.headers.get("content-length")?.trim();
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const length = Number(raw);
  return Number.isSafeInteger(length) ? length : undefined;
}

/** Save a fetch response without ever materializing the whole response in memory. */
export async function savePrivateResponse(response: Response, options: PrivateMediaOptions): Promise<string> {
  if (!response.ok) throw new Error(`media download HTTP ${response.status}`);
  if (!response.body) throw new Error("media response has no body");
  const limit = checkedLimit(options.maxBytes);
  const length = declaredLength(response);
  if (length !== undefined && length > limit) {
    void response.body.cancel(new MediaSizeLimitError(limit)).catch(() => undefined);
    throw new MediaSizeLimitError(limit);
  }
  return savePrivateMedia(response.body, {
    ...options,
    maxBytes: limit,
    contentType: options.contentType ?? response.headers.get("content-type"),
  });
}

/** Read a response into a bounded buffer for protocols that must decrypt the complete ciphertext. */
export async function readResponseBytesLimited(response: Response, maxBytes = INBOUND_MEDIA_MAX_BYTES, signal?: AbortSignal): Promise<Buffer> {
  if (!response.ok) throw new Error(`media download HTTP ${response.status}`);
  if (!response.body) throw new Error("media response has no body");
  const limit = checkedLimit(maxBytes);
  const length = declaredLength(response);
  if (length !== undefined && length > limit) {
    void response.body.cancel(new MediaSizeLimitError(limit)).catch(() => undefined);
    throw new MediaSizeLimitError(limit);
  }
  const reader = sourceReader(response.body);
  const chunks: Buffer[] = [];
  let total = 0;
  const onAbort = (): void => cancelWithoutBlocking(reader, signal ? abortReason(signal) : undefined);
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      const chunk = await readWithSignal(reader, signal);
      if (chunk.done) break;
      const bytes = asBytes(chunk.value);
      if (bytes.byteLength > limit - total) {
        const error = new MediaSizeLimitError(limit);
        cancelWithoutBlocking(reader, error);
        throw error;
      }
      chunks.push(Buffer.from(bytes));
      total += bytes.byteLength;
    }
    if (total === 0) throw new Error("inbound media is empty");
    return Buffer.concat(chunks, total);
  } catch (error) {
    cancelWithoutBlocking(reader, error);
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Decode protocol-mandated base64 only after bounding its encoded and decoded size. */
export function decodeBase64Media(value: string, maxBytes = INBOUND_MEDIA_MAX_BYTES): Buffer {
  const limit = checkedLimit(maxBytes);
  const raw = String(value ?? "").trim().replace(/^data:[^,]*,/, "");
  // Check before whitespace compaction so a whitespace bomb cannot create a second huge allocation.
  if (raw.length > Math.ceil(limit / 3) * 4 + 4096) throw new MediaSizeLimitError(limit);
  const compact = raw.replace(/\s+/g, "");
  if (!compact || compact.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw new Error("invalid base64 media");
  }
  const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
  const estimated = Math.floor((compact.length * 3) / 4) - padding;
  if (estimated > limit) throw new MediaSizeLimitError(limit);
  const decoded = Buffer.from(compact, "base64");
  if (!decoded.length) throw new Error("inbound media is empty");
  if (decoded.length > limit) throw new MediaSizeLimitError(limit);
  return decoded;
}

export async function savePrivateMediaBytes(bytes: Uint8Array, options: PrivateMediaOptions): Promise<string> {
  const limit = checkedLimit(options.maxBytes);
  if (bytes.byteLength > limit) throw new MediaSizeLimitError(limit);
  async function* oneChunk(): AsyncGenerator<Uint8Array> {
    yield bytes;
  }
  return savePrivateMedia(oneChunk(), { ...options, maxBytes: limit });
}

function mediaDirectory(platform: string, baseDir = join(homedir(), ".hara")): string {
  return join(resolve(baseDir), checkedPlatform(platform), "media");
}

async function existingPrivateMediaDir(platform: string, baseDir?: string): Promise<string | undefined> {
  const root = resolve(baseDir ?? join(homedir(), ".hara"));
  const platformDir = join(root, checkedPlatform(platform));
  const dir = join(platformDir, "media");
  try {
    await checkedDirectory(root, "media root");
    await checkedDirectory(platformDir, "platform media");
    await checkedDirectory(dir, "media");
    await assertContainedDirectory(root, platformDir, dir);
    return dir;
  } catch (error: any) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function ownedMediaPath(platform: string, candidate: string, baseDir?: string): Promise<string | undefined> {
  if (typeof candidate !== "string" || !candidate) return undefined;
  const dir = await existingPrivateMediaDir(platform, baseDir);
  if (!dir) return undefined;
  const path = resolve(candidate);
  if (dirname(path) !== dir || !OWNED_MEDIA_NAME.test(basename(path))) return undefined;
  // Re-check the candidate's parent rather than trusting lexical containment through an ancestor symlink.
  if ((await realpath(dirname(path))) !== (await realpath(dir))) return undefined;
  return path;
}

function isLegacyMediaName(platform: string, name: string): boolean {
  return LEGACY_MEDIA_NAME[checkedPlatform(platform)]?.test(name) ?? false;
}

/**
 * Remove only files created by this module for the current inbound event. `transientFiles` is part of the
 * adapter boundary and may be supplied by a third-party adapter, so arbitrary paths and symlinks fail closed.
 */
export async function cleanupTransientMedia(platform: string, paths: readonly string[] | undefined, baseDir?: string): Promise<number> {
  let removed = 0;
  for (const candidate of new Set(paths ?? [])) {
    let path: string | undefined;
    try {
      path = await ownedMediaPath(platform, candidate, baseDir);
      if (!path) {
        const trackedPath = resolve(String(candidate));
        if (retainedPaths.get(trackedPath)?.platform === checkedPlatform(platform)) {
          try {
            await lstat(trackedPath);
          } catch (error: any) {
            if (error?.code === "ENOENT") releaseRetainedPath(trackedPath);
          }
        }
        continue;
      }
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) {
        releaseRetainedPath(path);
        continue;
      }
      await unlink(path);
      releaseRetainedPath(path);
      removed++;
    } catch (error: any) {
      if (path && error?.code === "ENOENT") releaseRetainedPath(path);
      // Cleanup is deliberately per-file best effort: one hostile/broken entry must not strand the rest.
    }
  }
  return removed;
}

/** Best-effort startup janitor for media left behind by a crash or hard kill. */
export async function pruneStaleMedia(
  platform: string,
  options: { baseDir?: string; maxAgeMs?: number; now?: number } = {},
): Promise<number> {
  const dir = mediaDirectory(platform, options.baseDir);
  const maxAgeMs = options.maxAgeMs ?? INBOUND_MEDIA_TTL_MS;
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0) throw new TypeError("maxAgeMs must be a non-negative safe integer");
  let names: string[];
  try {
    const checked = await existingPrivateMediaDir(platform, options.baseDir);
    if (!checked) return 0;
    await chmod(checked, 0o700);
    names = await readdir(dir);
  } catch (error: any) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
  const cutoff = (options.now ?? Date.now()) - maxAgeMs;
  let removed = 0;
  for (const name of names) {
    try {
      let path: string | undefined;
      if (OWNED_MEDIA_NAME.test(name)) path = await ownedMediaPath(platform, join(dir, name), options.baseDir);
      else if (isLegacyMediaName(platform, name)) path = join(dir, name);
      if (!path) continue;
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.mtimeMs > cutoff) continue;
      await unlink(path);
      releaseRetainedPath(path);
      removed++;
    } catch {
      // Continue pruning even if a concurrently replaced or unreadable entry fails.
    }
  }
  return removed;
}
