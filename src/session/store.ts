// Session persistence — conversations saved as JSON under ~/.hara/sessions, resumable.
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  type Stats,
  writeFileSync,
} from "node:fs";
import { opendir as openDirAsync } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import {
  MAX_ASSISTANT_CONTINUATION_CHARS,
  MAX_ASSISTANT_CONTINUATION_ITEMS,
  type NeutralMsg,
} from "../providers/types.js";
import { redactSensitiveText, redactSensitiveValue } from "../security/secrets.js";
import { readVerifiedRegularFileSnapshotSync } from "../fs-read.js";
import { sameOpenedFileIdentity } from "../fs-identity.js";
import { optionalPosixOpenFlag } from "../fs-open-flags.js";
import { isValidProfileId, isValidSpaceId } from "../profile/profile.js";
import { sleepSync } from "../sync-sleep.js";
import { isTaskExecution, type TaskExecution } from "./task.js";
import type { ApprovalMode } from "../config.js";
import { isValidHaraVersion } from "../version.js";

/** Durable transcripts are local input on resume. Bound both allocation and post-parse traversal so a
 * corrupt/hostile session cannot turn startup or `hara sessions` into an unbounded resource operation. */
export const MAX_SESSION_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_SESSION_JSON_DEPTH = 64;
export const MAX_SESSION_JSON_NODES = 250_000;
export const MAX_SESSION_ARRAY_ITEMS = 50_000;
export const MAX_SESSION_STRING_CHARS = 8 * 1024 * 1024;
export const MAX_SESSION_METADATA_FILE_BYTES = 4 * 1024 * 1024;

/** Who created a session. Absent = legacy/interactive. Drives UI segregation (desktop: automated
 *  sessions render as a status timeline, never mixed into the manual list) and the title strategy
 *  (automated sessions get "name · time", NEVER the raw prompt). */
export type SessionSource = "interactive" | "gateway" | "cron";

const AUTOMATION_JOB_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Derive the session source from the spawn environment — the gateway subprocess runs with
 *  HARA_GATEWAY=<platform>, the cron runner with HARA_CRON=1 plus its name and stable job id. */
export function sessionSourceFromEnv(): { source: SessionSource; sourceName?: string; jobId?: string } {
  if (process.env.HARA_CRON) {
    const jobId = process.env.HARA_CRON_ID;
    return {
      source: "cron",
      sourceName: process.env.HARA_CRON_NAME || undefined,
      ...(jobId && AUTOMATION_JOB_ID.test(jobId) ? { jobId } : {}),
    };
  }
  if (process.env.HARA_GATEWAY) return { source: "gateway", sourceName: process.env.HARA_GATEWAY };
  return { source: "interactive" };
}

/** Title for a NON-interactive session: "name · MM-DD HH:mm" — the raw prompt never becomes a title. */
export function automatedTitle(source: SessionSource, sourceName: string | undefined, at = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const stamp = `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
  return `${sourceName || source} · ${stamp}`;
}

export interface SessionMeta {
  id: string;
  cwd: string;
  /** Hara runtime that last opened/wrote this session. Optional only for legacy transcripts. */
  haraVersion?: string;
  /** Identity route that owns this conversation. New sessions always persist it; legacy sessions may
   * omit it and bind to the active profile once on their next successful resume/save. */
  profileId?: string;
  /** Immutable data/audience boundary. A profile is a route; this is Personal or one authoritative
   * organization Space. Legacy sessions acquire it once when safely resumed. */
  spaceId?: string;
  provider: string;
  /** Per-session pinned model. Set at session creation from cfg.model, **updated by `/model X`**,
   *  and restored into cfg.model on resume so a session keeps the model the user picked.
   *  Resume precedence (see index.ts session init): `--model` flag > meta.model > profile defaults. */
  model: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** short-term working memory — a few durable one-liners that survive /compact + resume */
  workingSet?: string[];
  /** the agent's todo checklist snapshot — kept live by single-session runners (TUI / -p resume) so a
   *  resumed session picks its task state back up instead of starting amnesiac */
  todos?: import("../tools/todo.js").Todo[];
  /** creator of this session (absent = legacy/interactive) — see SessionSource */
  source?: SessionSource;
  /** human tag for automated sessions: cron job name / gateway platform */
  sourceName?: string;
  /** Stable cron job identity for automation history association; absent for gateways and legacy runs. */
  jobId?: string;
  /** A cron parent may persist an empty occurrence before its child can resolve credentials. Only the
   * matching generated cron child may replace this marker with an authoritative profile/Space route,
   * and only while the occurrence still has no history or task data. */
  pendingRouteBinding?: "cron";
  /** Per-session reasoning effort pin used by persistent Serve clients. `null` is an explicit
   * provider/model automatic setting; `undefined` is reserved for legacy sessions that still inherit
   * the connection default when they are next resumed. */
  effort?: string | null;
  /** Per-session approval policy. New persistent clients write this explicitly so reconnecting never
   * silently falls back from full-auto (or another user choice) to the Serve process default. */
  approval?: ApprovalMode;
  /** archived sessions are hidden from pickers/lists but kept on disk (codex thread/archive) */
  archived?: boolean;
  /** Gateway thread ownership marker; absent for interactive/cron and legacy sessions. */
  gatewayOwner?: string;
  /** Persistent conversational identity. Absence means the built-in main Hara agent; qualified refs bind
   * one transcript to one explicit project/global role so clients never silently reuse history as another
   * persona. */
  agentRef?: string;
}
export interface SessionData {
  meta: SessionMeta;
  history: NeutralMsg[];
  /** Active/most-recent task execution, deliberately separate from the conversational transcript. */
  task?: TaskExecution;
  /** Internal storage generation. Callers must treat it as opaque; it binds acceleration data to the
   * atomically replaced transcript so an interrupted sidecar/index update can never expose stale metadata. */
  storageGeneration?: string;
}

export interface SessionMetadataPageOptions {
  cwd?: string;
  excludeCwd?: string;
  sources?: readonly SessionSource[];
  sourceName?: string;
  jobId?: string | null;
  gatewayOwner?: string;
  idPrefix?: string;
  /** Match an exact id, prefix, or displayed suffix inside an already audience-partitioned route. */
  idFragment?: string;
  includeArchived?: boolean;
  cursor?: string;
  limit?: number;
}

export interface SessionMetadataPage {
  sessions: SessionMeta[];
  hasMore: boolean;
  nextCursor?: string;
  limit: number;
}

export const DEFAULT_SESSION_METADATA_PAGE_SIZE = 50;
export const MAX_SESSION_METADATA_PAGE_SIZE = 100;
const MAX_SESSION_INDEX_RECORDS_PER_PAGE = 1_000;
const MAX_SESSION_INDEX_BYTES_PER_PAGE = 1024 * 1024;
const MAX_SESSION_INDEX_LINE_BYTES = 2_048;
const MAX_SESSION_INDEX_SHARDS_PER_PAGE = 256;
const MAX_SESSION_INDEX_BUCKET_BYTES = 16 * 1024 * 1024;
const SESSION_INDEX_BUCKET_LOCK_WAIT_MS = 5_000;
const SESSION_INDEX_COMPATIBILITY_AUDIT_MS = 24 * 60 * 60_000;
const MAX_RECENT_SESSION_METADATA_SIZE = 500;
const MAX_RECENT_SESSION_INDEX_PAGES = 4;
const MAX_SESSION_PREFIX_LOOKUP_PAGES = 8;
const SESSION_INDEX_VERSION = 1;
// v3 performs one complete compatibility pass so transcripts/sidecars written before session-title
// sanitization are atomically rewritten under their ordinary session lock.
const SESSION_INDEX_ROUTE_SCHEMA = 3;
const SESSION_GENERATION_PREFIX_BYTES = 512;
const MAX_SESSION_AUTHORITY_CACHE_ENTRIES = 2_048;
const SESSION_STORAGE_GENERATION = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SESSION_INDEX_BUCKET = /^\d{10}$/u;
const SESSION_INDEX_ROUTE = /^(?:all|source-(?:interactive|gateway|cron)|cwd-[0-9a-f]{32}|source-cwd-(?:interactive|gateway|cron)-[0-9a-f]{32}|id-short-[0-9a-f]{32}|gateway-prefix-[0-9a-f]{32}|gateway-prefix-cwd-[0-9a-f]{32}|cron-job-[0-9a-f]{32}|gateway-owner-[0-9a-f]{32})$/u;

interface SessionIndexRecord {
  v: 1;
  id: string;
  generation: string | "legacy";
  at: number;
}

interface SessionIndexCursor {
  v: 1;
  bucket: string;
  offset: number;
  route?: string;
}

interface SessionMetadataSidecar {
  v: 1;
  generation: string;
  /** Schema 2 introduced every route partition; schema 3 additionally certifies the transcript/title
   * redaction rewrite. Readers accept both shapes but only the current schema skips compatibility work. */
  routes?: 2 | 3;
  meta: SessionMeta;
}

function encodeSessionIndexCursor(cursor: SessionIndexCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeSessionIndexCursor(value: string): SessionIndexCursor | null {
  try {
    if (!value || value.length > 1_024) return null;
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<SessionIndexCursor>;
    return parsed.v === SESSION_INDEX_VERSION
      && typeof parsed.bucket === "string"
      && SESSION_INDEX_BUCKET.test(parsed.bucket)
      && Number.isSafeInteger(parsed.offset)
      && parsed.offset! >= 0
      && (parsed.route === undefined || (typeof parsed.route === "string" && SESSION_INDEX_ROUTE.test(parsed.route)))
      ? {
          v: 1,
          bucket: parsed.bucket,
          offset: parsed.offset!,
          ...(parsed.route ? { route: parsed.route } : {}),
        }
      : null;
  } catch {
    return null;
  }
}

function canonicalSessionCwd(value: string): string {
  const absolute = resolve(value);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function sessionsDir(): string {
  const d = join(homedir(), ".hara", "sessions");
  mkdirSync(d, { recursive: true, mode: 0o700 });
  // `mode` is ignored when the directory already exists. Tighten legacy installs too: a session holds
  // private conversation history, so inheriting a permissive umask (typically 0755) is not acceptable.
  chmodSync(d, 0o700);
  return d;
}

function sessionIndexDir(): string {
  const d = join(homedir(), ".hara", "session-index", `v${SESSION_INDEX_VERSION}`);
  mkdirSync(d, { recursive: true, mode: 0o700 });
  chmodSync(d, 0o700);
  return d;
}

function sessionIndexBucket(at: number): string {
  const date = new Date(at);
  const yearNumber = date.getUTCFullYear();
  if (
    !Number.isFinite(date.getTime())
    || yearNumber < 0
    || yearNumber > 9_999
  ) throw new Error("invalid session index timestamp");
  const year = String(yearNumber).padStart(4, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hour = String(date.getUTCHours()).padStart(2, "0");
  return `${year}${month}${day}${hour}`;
}

function sessionIndexRouteRoot(route = "all", create = false): string {
  if (!SESSION_INDEX_ROUTE.test(route)) throw new Error("invalid session index route");
  const root = sessionIndexDir();
  if (route === "all") return root;
  const routes = join(root, "routes");
  const selected = join(routes, route);
  if (create) {
    mkdirSync(selected, { recursive: true, mode: 0o700 });
    for (const path of [routes, selected]) {
      try {
        chmodSync(path, 0o700);
      } catch {
        // The subsequent private index write remains authoritative.
      }
    }
  }
  return selected;
}

function sessionIndexBucketFile(bucket: string, create = false, route = "all"): string {
  if (!SESSION_INDEX_BUCKET.test(bucket)) throw new Error("invalid session index bucket");
  const root = sessionIndexRouteRoot(route, create);
  const year = bucket.slice(0, 4);
  const month = bucket.slice(4, 6);
  const day = bucket.slice(6, 8);
  const hour = bucket.slice(8, 10);
  const dayDir = join(root, year, month, day);
  if (create) {
    mkdirSync(dayDir, { recursive: true, mode: 0o700 });
    for (const path of [join(root, year), join(root, year, month), dayDir]) {
      try {
        chmodSync(path, 0o700);
      } catch {
        // The subsequent private append is authoritative; a permission failure there fails the save.
      }
    }
  }
  return join(dayDir, `${hour}.ndjson`);
}

function sessionIndexRouteHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function gatewaySessionPrefix(id: string): string | null {
  const match = /^(.*-)[a-f0-9]{6}(?:-[1-9]\d*)?$/u.exec(id);
  return match?.[1] ?? null;
}

/** Stable, opaque audience marker for one gateway actor. The derived session id already carries the
 * platform/chat namespace; hashing it prevents duplicating that raw namespace in session metadata. */
export function gatewayOwnerFromSessionId(id: string, sourceName = ""): string | undefined {
  const prefix = gatewaySessionPrefix(id);
  return prefix
    ? createHash("sha256").update(`${sourceName}\0${prefix}`).digest("hex")
    : undefined;
}

/** Write each generation to a global timeline plus bounded audience/project routes. Query selection uses
 * the narrowest complete route available, so high-volume cron traffic cannot starve interactive resume. */
function sessionIndexRoutesForMeta(meta: SessionMeta): string[] {
  const source = meta.source ?? "interactive";
  const cwdHash = sessionIndexRouteHash(canonicalSessionCwd(meta.cwd));
  const routes = new Set<string>([
    "all",
    `source-${source}`,
    `cwd-${cwdHash}`,
    `source-cwd-${source}-${cwdHash}`,
    `id-short-${sessionIndexRouteHash(meta.id.slice(0, 8))}`,
  ]);
  if (source === "gateway") {
    const prefix = gatewaySessionPrefix(meta.id);
    if (prefix) {
      const prefixHash = sessionIndexRouteHash(prefix);
      routes.add(`gateway-prefix-${prefixHash}`);
      routes.add(`gateway-prefix-cwd-${sessionIndexRouteHash(`${prefix}\0${canonicalSessionCwd(meta.cwd)}`)}`);
    }
    if (meta.gatewayOwner) {
      routes.add(`gateway-owner-${sessionIndexRouteHash(`${meta.sourceName ?? ""}\0${meta.gatewayOwner}`)}`);
    }
  }
  if (source === "cron" && meta.jobId) {
    routes.add(`cron-job-${sessionIndexRouteHash(meta.jobId)}`);
  }
  return [...routes].sort();
}

function preferredSessionIndexRoute(options: SessionMetadataPageOptions): string {
  const sources = options.sources?.length === 1 ? options.sources[0] : undefined;
  if (sources === "gateway" && options.idPrefix) {
    return options.cwd
      ? `gateway-prefix-cwd-${sessionIndexRouteHash(`${options.idPrefix}\0${canonicalSessionCwd(options.cwd)}`)}`
      : `gateway-prefix-${sessionIndexRouteHash(options.idPrefix)}`;
  }
  if (sources === "cron" && options.jobId) {
    return `cron-job-${sessionIndexRouteHash(options.jobId)}`;
  }
  if (sources === "gateway" && options.gatewayOwner) {
    return `gateway-owner-${sessionIndexRouteHash(`${options.sourceName ?? ""}\0${options.gatewayOwner}`)}`;
  }
  if (options.idPrefix && options.idPrefix.length >= 8) {
    return `id-short-${sessionIndexRouteHash(options.idPrefix.slice(0, 8))}`;
  }
  if (sources && options.cwd) {
    return `source-cwd-${sources}-${sessionIndexRouteHash(canonicalSessionCwd(options.cwd))}`;
  }
  if (options.cwd) return `cwd-${sessionIndexRouteHash(canonicalSessionCwd(options.cwd))}`;
  return sources ? `source-${sources}` : "all";
}

function validSessionIndexRecord(value: unknown): value is SessionIndexRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<SessionIndexRecord>;
  return record.v === SESSION_INDEX_VERSION
    && validSessionId(record.id)
    && (record.generation === "legacy"
      || (typeof record.generation === "string" && SESSION_STORAGE_GENERATION.test(record.generation)))
    && typeof record.at === "number"
    && Number.isFinite(record.at);
}

function acquireSessionIndexBucketLock(path: string): { claim: LockRecord & { token: string }; lock: string } {
  const lock = `${path}.lock`;
  const reclaim = `${lock}.reclaim`;
  const deadline = Date.now() + SESSION_INDEX_BUCKET_LOCK_WAIT_MS;
  for (;;) {
    const claim = newLockRecord();
    try {
      writeExclusive(lock, claim);
      return { claim, lock };
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
    }

    const observed = readLockRecord(lock);
    if (observed?.token && !pidAlive(observed.pid)) {
      const guard = newLockRecord();
      try {
        writeExclusive(reclaim, guard);
        const current = readLockRecord(lock);
        if (
          current?.token
          && current.pid === observed.pid
          && current.startedAt === observed.startedAt
          && current.token === observed.token
          && !pidAlive(current.pid)
        ) {
          rmSync(lock);
        }
      } catch (error: any) {
        if (error?.code !== "EEXIST") throw error;
      } finally {
        const currentGuard = readLockRecord(reclaim);
        if (
          currentGuard?.pid === guard.pid
          && currentGuard.startedAt === guard.startedAt
          && currentGuard.token === guard.token
        ) {
          try {
            rmSync(reclaim);
          } catch {
            // A surviving guard makes all contenders fail closed until it can be inspected.
          }
        }
      }
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for a session metadata index shard");
    }
    sleepSync(10);
  }
}

function releaseSessionIndexBucketLock(held: { claim: LockRecord & { token: string }; lock: string }): void {
  const current = readLockRecord(held.lock);
  if (
    current?.pid === held.claim.pid
    && current.startedAt === held.claim.startedAt
    && current.token === held.claim.token
  ) {
    rmSync(held.lock);
  }
}

function writeSessionIndexBytes(path: string, encoded: string, append: boolean): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, append ? "a" : "w", 0o600);
    writeFileSync(fd, encoded, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    chmodSync(path, 0o600);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Insert one or more intents into a route shard while preserving chronological physical order. Current
 * writes normally take the append fast path; an old migration record performs one bounded atomic merge.
 * The per-shard lock covers separate Hara processes as well as a mixed-version import. */
function insertSessionIndexRecords(
  path: string,
  records: readonly SessionIndexRecord[],
  forceMerge = false,
): void {
  if (!records.length) return;
  const additions = records.map((record) => {
    const encoded = JSON.stringify(record);
    if (Buffer.byteLength(`${encoded}\n`, "utf8") > MAX_SESSION_INDEX_LINE_BYTES) {
      throw new Error("session metadata index record is too large");
    }
    return { record, encoded };
  }).sort((left, right) =>
    left.record.at - right.record.at
    || left.record.id.localeCompare(right.record.id)
    || left.record.generation.localeCompare(right.record.generation));
  const held = acquireSessionIndexBucketLock(path);
  try {
    let size = 0;
    try {
      size = lstatSync(path).size;
    } catch {
      // The route directory exists, but this is its first record in the hour.
    }
    if (size <= 0) {
      writeSessionIndexBytes(path, `${additions.map((item) => item.encoded).join("\n")}\n`, false);
      return;
    }

    const tail = previousSessionIndexLines(path, size).lines[0]?.text;
    let last: SessionIndexRecord | null = null;
    try {
      const parsed: unknown = tail ? JSON.parse(tail) : null;
      last = validSessionIndexRecord(parsed) ? parsed : null;
    } catch {
      last = null;
    }
    if (
      !forceMerge
      && last
      && additions[0]!.record.at >= last.at
    ) {
      writeSessionIndexBytes(path, `${additions.map((item) => item.encoded).join("\n")}\n`, true);
      return;
    }
    if (size > MAX_SESSION_INDEX_BUCKET_BYTES) {
      throw new Error(
        "session metadata index shard is too large to reorder safely; finish the older Hara migration first",
      );
    }

    const existingText = readFileSync(path, "utf8");
    const valid: Array<{ record: SessionIndexRecord; encoded: string }> = [];
    const invalid: string[] = [];
    for (const line of existingText.split("\n")) {
      if (!line) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (validSessionIndexRecord(parsed)) valid.push({ record: parsed, encoded: line });
        else invalid.push(line);
      } catch {
        invalid.push(line);
      }
    }
    valid.push(...additions);
    valid.sort((left, right) =>
      left.record.at - right.record.at
      || left.record.id.localeCompare(right.record.id)
      || left.record.generation.localeCompare(right.record.generation));
    const deduplicated = valid.filter((item, index, all) => {
      const prior = all[index - 1];
      return !prior
        || prior.record.at !== item.record.at
        || prior.record.id !== item.record.id
        || prior.record.generation !== item.record.generation;
    });
    const merged = [...invalid, ...deduplicated.map((item) => item.encoded)];
    const encoded = `${merged.join("\n")}\n`;
    if (Buffer.byteLength(encoded, "utf8") > MAX_SESSION_INDEX_BUCKET_BYTES + MAX_SESSION_INDEX_LINE_BYTES) {
      throw new Error("session metadata index shard exceeded its bounded reorder size");
    }
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeSessionIndexBytes(tmp, encoded, false);
      renameSync(tmp, path);
      chmodSync(path, 0o600);
    } finally {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // A unique unpublished temp file is inert.
      }
    }
  } finally {
    releaseSessionIndexBucketLock(held);
  }
}

/** The records are intents written and fsynced before the transcript rename. A failed transcript write
 * leaves inert generation-mismatched entries; a crash after rename leaves every complete query route able
 * to find the authoritative generation without walking unrelated audiences. */
function appendSessionIndexRecord(record: SessionIndexRecord, meta: SessionMeta, forceMerge = false): void {
  for (const route of sessionIndexRoutesForMeta(meta)) {
    const path = sessionIndexBucketFile(sessionIndexBucket(record.at), true, route);
    insertSessionIndexRecords(path, [record], forceMerge);
  }
}

function numericEntries(path: string, expression: RegExp): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && expression.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/** Collect at most `limit` hourly shards newest-first and strictly before `before` when supplied.
 * One metadata page builds this iterator once, rather than restarting at the index root for every empty
 * or exhausted shard. The hierarchy still stops as soon as the page plus one continuation shard is known. */
function sessionIndexBucketsBefore(
  before?: string,
  limit = MAX_SESSION_INDEX_SHARDS_PER_PAGE + 1,
  route = "all",
): string[] {
  const root = sessionIndexRouteRoot(route);
  const buckets: string[] = [];
  const beforeYear = before?.slice(0, 4);
  const beforeMonth = before?.slice(4, 6);
  const beforeDay = before?.slice(6, 8);
  const beforeHour = before?.slice(8, 10);
  const years = numericEntries(root, /^\d{4}$/u);
  for (const year of years) {
    if (beforeYear && year > beforeYear) continue;
    const months = numericEntries(join(root, year), /^(?:0[1-9]|1[0-2])$/u);
    for (const month of months) {
      const sameYear = beforeYear === year;
      if (sameYear && beforeMonth && month > beforeMonth) continue;
      const days = numericEntries(join(root, year, month), /^(?:0[1-9]|[12]\d|3[01])$/u);
      for (const day of days) {
        const sameMonth = sameYear && beforeMonth === month;
        if (sameMonth && beforeDay && day > beforeDay) continue;
        let hours: string[];
        try {
          hours = readdirSync(join(root, year, month, day), { withFileTypes: true })
            .filter((entry) => entry.isFile() && /^(?:[01]\d|2[0-3])\.ndjson$/u.test(entry.name))
            .map((entry) => entry.name.slice(0, 2))
            .sort()
            .reverse();
        } catch {
          hours = [];
        }
        for (const hour of hours) {
          const sameDay = sameMonth && beforeDay === day;
          if (sameDay && beforeHour && hour >= beforeHour) continue;
          buckets.push(`${year}${month}${day}${hour}`);
          if (buckets.length >= limit) return buckets;
        }
      }
    }
  }
  return buckets;
}

interface SessionIndexLine {
  text: string;
  start: number;
}

/** Read a bounded tail window and return complete lines newest-first. The extra line allowance aligns the
 * first record without making one corrupt, unbounded line consume memory or stall cursor progress. */
function previousSessionIndexLines(path: string, endOffset: number): {
  lines: SessionIndexLine[];
  nextOffset: number;
  bytesRead: number;
} {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const info = fstatSync(fd);
    if (!info.isFile() || info.size <= 0) return { lines: [], nextOffset: 0, bytesRead: 0 };
    const end = Math.min(Math.max(0, endOffset), info.size);
    if (end === 0) return { lines: [], nextOffset: 0, bytesRead: 0 };
    const window = Math.min(end, MAX_SESSION_INDEX_BYTES_PER_PAGE + MAX_SESSION_INDEX_LINE_BYTES);
    const start = end - window;
    const buffer = Buffer.allocUnsafe(window);
    const read = readSync(fd, buffer, 0, window, start);
    const bytes = buffer.subarray(0, read);
    const lines: SessionIndexLine[] = [];
    let lineEndExclusive = bytes.length;
    if (lineEndExclusive > 0 && bytes[lineEndExclusive - 1] === 0x0a) lineEndExclusive -= 1;
    let oldestStart = end;
    while (lineEndExclusive > 0 && lines.length < MAX_SESSION_INDEX_RECORDS_PER_PAGE) {
      const previousNewline = bytes.lastIndexOf(0x0a, lineEndExclusive - 1);
      if (previousNewline < 0 && start > 0) break; // leading partial record; the next cursor begins after it
      const lineStart = previousNewline + 1;
      const absoluteStart = start + lineStart;
      const text = bytes.subarray(lineStart, lineEndExclusive).toString("utf8");
      lines.push({ text, start: absoluteStart });
      oldestStart = absoluteStart;
      if (previousNewline < 0) break;
      lineEndExclusive = previousNewline;
    }
    return {
      lines,
      nextOffset: lines.length ? oldestStart : start,
      bytesRead: read,
    };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function isSessionTranscriptFileName(name: string): boolean {
  return name.endsWith(".json");
}

function sessionMetadataFile(id: string): string {
  // Session ids may legally end in ".meta", so `<id>.meta.json` collides with the authoritative
  // transcript for that id. Keep acceleration files outside the transcript `.json` namespace.
  return join(sessionsDir(), `${checkedSessionId(id)}.metadata`);
}

/** Session ids become filenames. Gateway/platform ids are not always UUIDs, so allow printable filename
 * characters broadly while rejecting separators, traversal sentinels, NULs, and unbounded names. */
export function validSessionId(id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && id.length <= 220 && id !== "." && id !== ".." && !/[\\/\0]/.test(id);
}

function checkedSessionId(id: unknown): string {
  if (!validSessionId(id)) throw new Error("invalid session id");
  return id;
}

const sessionFile = (id: string) => join(sessionsDir(), `${checkedSessionId(id)}.json`);
const lockFile = (id: string) => join(sessionsDir(), `${checkedSessionId(id)}.lock`);
const reclaimFile = (id: string) => join(sessionsDir(), `${checkedSessionId(id)}.lock.reclaim`);

/** Distinguish a missing session from an existing but unreadable/corrupt one without exposing its path. */
export function sessionFileExists(id: unknown): boolean {
  if (!validSessionId(id)) return false;
  return existsSync(sessionFile(id));
}

interface LockRecord {
  pid: number;
  startedAt: number;
  /** Added by the atomic-lock format. Legacy pid-only locks remain readable for safe live/stale handling,
   *  but can never be mistaken for a lock owned by this module instance. */
  token?: string;
}

// A pid alone is not ownership: pids are reused, and another writer could replace a lock between read and
// release. Keep the random token for every lock this module actually created and require both on release.
const ownedLocks = new Map<string, string>();
// A lock file itself changes the sessions-directory mtime. Remember whether the directory was already
// entirely explained by current writers before acquisition, then advance the current-writer watermark only
// after our lock and all protected mutations have left the directory.
const ownedLockKnownDirectoryState = new Map<string, boolean>();

function readLockRecord(path: string): LockRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LockRecord>;
    if (
      !Number.isInteger(parsed.pid) ||
      Number(parsed.pid) <= 0 ||
      typeof parsed.startedAt !== "number" ||
      (parsed.token !== undefined && (typeof parsed.token !== "string" || !parsed.token))
    ) {
      return null;
    }
    return { pid: Number(parsed.pid), startedAt: parsed.startedAt, ...(parsed.token ? { token: parsed.token } : {}) };
  } catch {
    return null;
  }
}

/** Create one private file without ever replacing an existing path. On a partial write, remove only the
 *  inode we just created. Callers use this for both the primary lock and the stale-lock reclaimer. */
function writeExclusive(path: string, record: LockRecord): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(record), "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
        fd = undefined;
      } catch {
        /* continue with best-effort removal */
      }
      try {
        rmSync(path, { force: true });
      } catch {
        /* the original error is more useful */
      }
    }
    throw error;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* the acquisition will fail closed */
      }
    }
  }
}

function newLockRecord(): LockRecord & { token: string } {
  return { pid: process.pid, startedAt: Date.now(), token: randomUUID() };
}

/** Is a process with this pid alive? `process.kill(pid, 0)` sends no signal — it just probes: throws
 *  ESRCH if dead, EPERM if alive-but-not-ours (still alive). Best-effort across platforms. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}

/** Take an O_EXCL lock on a session so two hara processes cannot both pass a check-then-write race.
 *  Filesystem/malformed-lock errors fail CLOSED. A well-formed dead holder can be reclaimed under a second
 *  O_EXCL guard; a corrupt lock is deliberately left for explicit operator inspection/removal. */
export function acquireSessionLock(id: string): { ok: boolean; pid?: number } {
  let f: string;
  let reclaim: string;
  try {
    f = lockFile(id);
    reclaim = reclaimFile(id);
  } catch {
    return { ok: false };
  }
  const knownDirectoryState = sessionDirectoryMatchesCurrentState();

  // A stale-lock recovery is changing the primary lock. New contenders wait/fail instead of creating a
  // primary lock in the short remove→create window.
  if (existsSync(reclaim)) {
    const stale = readLockRecord(reclaim);
    if (!stale?.token || !Number.isFinite(stale.startedAt) || stale.startedAt <= 0 || pidAlive(stale.pid)) {
      return { ok: false, pid: readLockRecord(f)?.pid };
    }
    const current = readLockRecord(reclaim);
    if (
      !current?.token ||
      current.pid !== stale.pid ||
      current.token !== stale.token ||
      current.startedAt !== stale.startedAt ||
      pidAlive(current.pid)
    ) {
      return { ok: false, pid: readLockRecord(f)?.pid };
    }
    try {
      rmSync(reclaim);
    } catch {
      return { ok: false, pid: readLockRecord(f)?.pid };
    }
  }

  const claim = newLockRecord();
  try {
    writeExclusive(f, claim);
    ownedLocks.set(id, claim.token);
    ownedLockKnownDirectoryState.set(id, knownDirectoryState);
    return { ok: true };
  } catch (error: any) {
    if (error?.code !== "EEXIST") return { ok: false };
  }

  const held = readLockRecord(f);
  if (!held) return { ok: false }; // malformed/unreadable is not proof that the owner is dead
  if (held.pid === process.pid && !!held.token && ownedLocks.get(id) === held.token) return { ok: true }; // re-entrant
  if (pidAlive(held.pid)) return { ok: false, pid: held.pid };

  // Serialize stale takeover. All participants check this guard before attempting the primary O_EXCL create,
  // so no second contender can steal the freshly-created primary lock during reclamation.
  const reclaimClaim = newLockRecord();
  try {
    writeExclusive(reclaim, reclaimClaim);
  } catch {
    return { ok: false, pid: held.pid };
  }
  try {
    const current = readLockRecord(f);
    if (!current) return { ok: false }; // disappeared/corrupted unexpectedly: fail closed
    if (current.pid === process.pid && !!current.token && ownedLocks.get(id) === current.token) return { ok: true };
    if (pidAlive(current.pid)) return { ok: false, pid: current.pid };

    rmSync(f); // known-dead, well-formed owner; protected by the reclaim guard
    const replacement = newLockRecord();
    writeExclusive(f, replacement);
    ownedLocks.set(id, replacement.token);
    ownedLockKnownDirectoryState.set(id, knownDirectoryState);
    return { ok: true };
  } catch {
    return { ok: false };
  } finally {
    // Only remove our own reclaimer. A replacement would indicate outside interference and must survive.
    const currentReclaim = readLockRecord(reclaim);
    if (currentReclaim?.pid === process.pid && currentReclaim.token === reclaimClaim.token) {
      try {
        rmSync(reclaim);
      } catch {
        /* fail closed on the next acquisition until this guard can be inspected/removed */
      }
    }
  }
}

export interface SessionLockRecoveryReport {
  scanned: number;
  reclaimed: number;
  live: number;
  malformed: number;
  deferred: number;
}

/**
 * Recover abandoned session locks before a persistent Serve process accepts work.
 *
 * Age is deliberately irrelevant: a paused but live owner keeps its lock forever. Only a complete lock
 * whose PID is proven dead is eligible, and the normal O_EXCL takeover path performs the mutation so a
 * concurrently starting Hara process can win safely. Malformed files remain untouched for inspection.
 */
export function reclaimOrphanedSessionLocks(): SessionLockRecoveryReport {
  const report: SessionLockRecoveryReport = {
    scanned: 0,
    reclaimed: 0,
    live: 0,
    malformed: 0,
    deferred: 0,
  };
  let directory: string;
  let names: string[];
  try {
    directory = sessionsDir();
    names = readdirSync(directory);
  } catch {
    report.deferred += 1;
    return report;
  }

  for (const name of names) {
    if (!name.endsWith(".lock")) continue;
    report.scanned += 1;
    const id = name.slice(0, -".lock".length);
    const target = join(directory, name);
    try {
      if (!validSessionId(id) || !lstatSync(target).isFile()) {
        report.malformed += 1;
        continue;
      }
    } catch {
      report.deferred += 1;
      continue;
    }

    const held = readLockRecord(target);
    if (!held || !Number.isFinite(held.startedAt) || held.startedAt <= 0) {
      report.malformed += 1;
      continue;
    }
    if (pidAlive(held.pid)) {
      report.live += 1;
      continue;
    }

    const recovered = acquireSessionLock(id);
    if (!recovered.ok) {
      report.deferred += 1;
      continue;
    }
    releaseSessionLock(id);
    report.reclaimed += 1;
  }
  return report;
}

/** Release a session lock we hold (only removes it if the pid matches ours — never steals another's). */
export function releaseSessionLock(id: string): void {
  const token = ownedLocks.get(id);
  if (!token) return;
  try {
    const f = lockFile(id);
    const held = readLockRecord(f);
    const removedOwnLock = held?.pid === process.pid && held.token === token;
    if (removedOwnLock) rmSync(f);
    ownedLocks.delete(id);
    if (removedOwnLock && ownedLockKnownDirectoryState.get(id)) writeCurrentWriterDirectoryMarker();
    ownedLockKnownDirectoryState.delete(id);
  } catch {
    // Keep the ownership token so a later cleanup attempt can still prove ownership. Never unlink blindly.
  }
}

/** Permanently delete a session from disk (codex thread/delete — unlike archive, irreversible).
 *  Refuses when a LIVE other process holds the lock; removes the session file and any lock we may hold.
 *  Returns false when the session doesn't exist or is held elsewhere. */
export function deleteSession(id: string): boolean {
  let f: string;
  try {
    f = sessionFile(id);
  } catch {
    return false;
  }
  if (!existsSync(f)) return false;
  const ownedBefore = ownedLocks.has(id);
  const lock = acquireSessionLock(id);
  if (!lock.ok) return false;
  let deleted = false;
  try {
    rmSync(f);
    try {
      rmSync(sessionMetadataFile(id), { force: true });
    } catch {
      // The transcript is authoritative. A stale sidecar cannot resume a deleted session and paged
      // listing requires the transcript filename, so cleanup failure is safe and can be retried later.
    }
    deleted = true;
    return true;
  } catch {
    return false;
  } finally {
    // A successful delete ends the session. On failure, release only a lock acquired by this call; a live
    // SessionHub that already owned the lock must retain it and remain protected.
    if (deleted || !ownedBefore) releaseSessionLock(id);
  }
}

/** A full UUID per session (the stable identity). */
export const newSessionId = (): string => randomUUID();
const GENERATED_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isGeneratedSessionId(id: unknown): id is string {
  return typeof id === "string" && GENERATED_SESSION_ID.test(id);
}
/** First segment of the UUID — a compact label for the status bar / `/sessions`. */
export const shortId = (id: string): string => id.slice(0, 8);

/** Resolve a full id OR a unique prefix (e.g. the short id) to a session id, for `--resume`.
 * Internal callers that already own a generated exact UUID can disable the O(n) prefix scan. */
export function resolveSessionId(
  idOrPrefix: string,
  options: { allowPrefix?: boolean } = {},
): string | null {
  if (!validSessionId(idOrPrefix)) return null;
  if (existsSync(sessionFile(idOrPrefix))) return idOrPrefix;
  if (options.allowPrefix === false) return null;
  const result = findSessionMetadataByPrefix(idOrPrefix);
  return result.exhaustive && result.sessions.length === 1 ? result.sessions[0]!.id : null;
}

const STOP = new Set(
  "the a an to of for and or with in on at my our your this that it is please can could you help me we add fix make do run create update change implement".split(" "),
);
const WORDS = "amber basalt cedar delta ember flint grove harbor indigo jade kelp larch maple onyx quartz river slate terra umber vale willow zephyr".split(" ");

/** A short, ASCII, few-word session name from the first message — no CJK or garbled chars. For
 *  all-CJK / empty input, a stable word derived from the text. Keeps the status bar tidy. */
export function cleanSessionName(raw: string): string {
  const words = raw
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
  const slug = words.slice(0, 3).join("-").slice(0, 24).replace(/^-+|-+$/g, "");
  if (slug) return slug;
  let h = 0;
  for (const ch of raw) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return WORDS[h % WORDS.length] ?? "session";
}

/** A concise, human session name auto-summarized from the first message. Language-agnostic — keeps CJK
 *  (unlike the ASCII-slug `cleanSessionName`), trims code/whitespace, caps length. Empty for blank input
 *  (callers fall back to the short id, never "new session"). */
export function deriveTitle(text: string): string {
  if (typeof text !== "string") return ""; // a malformed/hand-edited session may have a non-string content
  const t = sanitizeSessionTitle(text, 40)
    .replace(/^\/\S+\s*/, "") // drop a leading slash-command
    .replace(/```[\s\S]*?```/g, " ") // drop fenced code blocks
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return "";
  return t;
}

/** One boundary for every user/model/legacy title. Credentials are replaced before a title can be
 * returned to a renderer, retained in live state, or written to either transcript or metadata sidecar. */
export function sanitizeSessionTitle(raw: string, max = 120): string {
  if (typeof raw !== "string" || max <= 0) return "";
  const redacted = redactSensitiveText(raw);
  let safe = redacted.text
    .replace(/\b(?:[A-Za-z][A-Za-z0-9_.-]*(?:api[_-]?key|apikey|secret|token|password|passwd)[A-Za-z0-9_.-]*|(?:api[_-]?key|apikey|secret|token|password|passwd)[A-Za-z0-9_.-]*)\b\s*[:=]\s*(?:["']?\*{3}["']?)/giu, "credential")
    .replace(/<REDACTED:[^>]+>|\b(?:sk-\*{3}|gh\*_\*{3}|glpat-\*{3}|xox\*-\*{3}|npm_\*{3}|AIza\*{3}|stripe-live-\*{3}|AWS-KEY-\*{3}|JWT-\*{3})|\bBearer\s+\*{3}/giu, "credential")
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (redacted.redactions.length && (!safe || /^\*{3}$/u.test(safe))) safe = "Sensitive input";
  if (!safe) return "";
  if (safe.length <= max) return safe;
  const clipped = safe.slice(0, max).replace(/\s+\S*$/u, "").trim();
  return `${clipped || safe.slice(0, max)}…`;
}

export function titleFrom(history: NeutralMsg[]): string {
  const firstUser = history.find((h) => h.role === "user");
  return deriveTitle(firstUser && firstUser.role === "user" ? firstUser.content : "");
}

/** Normalize a phrase to an ASCII kebab-case slug (lowercase, a–z0–9 + single hyphens, capped). Non-ASCII
 *  is dropped — used to clean a model-generated English session name. Returns "" if nothing ASCII remains. */
export function slugify(text: string, max = 40): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .slice(0, max)
    .replace(/-+$/, "");
}

/** Redact a deep in-memory copy while retaining fields that define session identity/routing. */
function redactedSessionCopy(data: SessionData): SessionData {
  // Redact a deep COPY: the live turn may still need a credential the user supplied, but the durable
  // transcript never should. Tool inputs/results are included, not just user message content.
  const safe = redactSensitiveValue(data).value;
  safe.meta.title = sanitizeSessionTitle(safe.meta.title);
  // Structural routing/identity fields must remain byte-for-byte stable even if a path happens to contain
  // credential-looking text. Free-form meta (title, workingSet, todos, sourceName) and ALL history remain
  // deeply redacted. The live objects are not modified by the redaction walk.
  safe.meta.id = data.meta.id;
  safe.meta.cwd = data.meta.cwd;
  if (data.meta.profileId !== undefined) safe.meta.profileId = data.meta.profileId;
  if (data.meta.spaceId !== undefined) safe.meta.spaceId = data.meta.spaceId;
  safe.meta.provider = data.meta.provider;
  safe.meta.model = data.meta.model;
  safe.meta.createdAt = data.meta.createdAt;
  safe.meta.updatedAt = data.meta.updatedAt;
  if (data.meta.source !== undefined) safe.meta.source = data.meta.source;
  if (data.meta.jobId !== undefined) safe.meta.jobId = data.meta.jobId;
  if (data.meta.pendingRouteBinding !== undefined) safe.meta.pendingRouteBinding = data.meta.pendingRouteBinding;
  if (data.meta.effort !== undefined) safe.meta.effort = data.meta.effort;
  if (data.meta.approval !== undefined) safe.meta.approval = data.meta.approval;
  if (data.meta.archived !== undefined) safe.meta.archived = data.meta.archived;
  if (data.meta.gatewayOwner !== undefined) safe.meta.gatewayOwner = data.meta.gatewayOwner;
  if (data.meta.agentRef !== undefined) safe.meta.agentRef = data.meta.agentRef;
  if (data.task && safe.task) {
    // Task objective/steering are free-form and stay redacted. Execution identity and transition metadata
    // are structural: preserve them exactly so resume/expectedTurnId validation cannot be corrupted by a
    // credential-looking identifier.
    safe.task.schemaVersion = data.task.schemaVersion;
    safe.task.id = data.task.id;
    safe.task.status = data.task.status;
    safe.task.turnId = data.task.turnId;
    safe.task.createdAt = data.task.createdAt;
    safe.task.updatedAt = data.task.updatedAt;
    safe.task.startedAt = data.task.startedAt;
    if (data.task.endedAt !== undefined) safe.task.endedAt = data.task.endedAt;
    if (data.task.lastOutcome !== undefined) safe.task.lastOutcome = data.task.lastOutcome;
    if (data.task.steering && safe.task.steering) {
      for (let index = 0; index < data.task.steering.length; index++) {
        const source = data.task.steering[index];
        const target = safe.task.steering[index];
        if (!source || !target) continue;
        target.id = source.id;
        target.turnId = source.turnId;
        target.createdAt = source.createdAt;
        if (source.deliveryState !== undefined) target.deliveryState = source.deliveryState;
        if (source.consumedAt !== undefined) target.consumedAt = source.consumedAt;
      }
    }
  }
  return safe;
}

function writeSessionMetadataSidecar(meta: SessionMeta, generation: string): void {
  const sidecar: SessionMetadataSidecar = {
    v: 1,
    generation,
    routes: SESSION_INDEX_ROUTE_SCHEMA,
    meta,
  };
  const encoded = JSON.stringify(sidecar);
  if (Buffer.byteLength(encoded, "utf8") > MAX_SESSION_METADATA_FILE_BYTES) return;
  const target = sessionMetadataFile(meta.id);
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "wx", 0o600);
    writeFileSync(fd, encoded, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, target);
    chmodSync(target, 0o600);
  } catch {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* metadata acceleration is best effort; the transcript remains authoritative */
      }
    }
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* stale uniquely named temp files are inert */
    }
  }
}

function persistSessionSnapshot(
  meta: SessionMeta,
  history: NeutralMsg[],
  task: TaskExecution | undefined,
  updatedAt: string,
): void {
  checkedSessionId(meta.id);
  // Also clean the live object. Deep-copy redaction alone protected disk, but could leave a credential in
  // the current renderer until the next reload and allowed the RPC rename response to echo it.
  meta.title = sanitizeSessionTitle(meta.title);
  const owned = ownedLocks.has(meta.id);
  const knownDirectoryState = !owned && sessionDirectoryMatchesCurrentState();
  if (!isTimestamp(updatedAt)) throw new Error("invalid session update timestamp");
  meta.updatedAt = updatedAt;
  const generation = randomUUID();
  const data: SessionData = { meta, history, ...(task ? { task } : {}), storageGeneration: generation };
  if (!sessionValueWithinLimits(data)) {
    throw new Error("session exceeds Hara's safe persistence complexity limit; compact or start a new session");
  }
  const safe = redactedSessionCopy(data);
  safe.storageGeneration = generation;
  // Keep the generation first so metadata readers can verify a sidecar against a tiny, descriptor-checked
  // prefix instead of parsing a transcript that may be tens of MiB. Existing tail-generation transcripts
  // remain readable and take the bounded full-read fallback until their next save.
  const encoded = JSON.stringify({
    storageGeneration: generation,
    meta: safe.meta,
    history: safe.history,
    ...(safe.task ? { task: safe.task } : {}),
  } satisfies SessionData, null, 2);
  if (Buffer.byteLength(encoded, "utf8") > MAX_SESSION_FILE_BYTES) {
    throw new Error("session exceeds Hara's 64 MiB persistence limit; compact or start a new session");
  }

  const target = sessionFile(meta.id);
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    // Persist the new generation's ordered intent first. If anything below fails, readers reject this entry
    // because the authoritative transcript still carries another generation.
    appendSessionIndexRecord({
      v: 1,
      id: meta.id,
      generation,
      at: Date.parse(meta.updatedAt),
    }, meta);
    fd = openSync(tmp, "wx", 0o600);
    writeFileSync(fd, encoded, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    // Same directory/filesystem: readers observe the complete old JSON or complete new JSON, never a prefix.
    renameSync(tmp, target);
    chmodSync(target, 0o600);
    // A small redacted sidecar lets paged timelines avoid reopening full transcripts. The transcript is
    // already durable and remains authoritative if this best-effort acceleration write is unavailable.
    writeSessionMetadataSidecar(safe.meta, generation);
    if (knownDirectoryState) writeCurrentWriterDirectoryMarker();
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* preserve the original error */
      }
    }
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* preserve the original error */
    }
    throw error;
  }
}

export function saveSession(meta: SessionMeta, history: NeutralMsg[], task?: TaskExecution): void {
  persistSessionSnapshot(meta, history, task, new Date().toISOString());
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  const year = new Date(timestamp).getUTCFullYear();
  return year >= 0 && year <= 9_999;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isPersistedTodo(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const todo = value as { text?: unknown; status?: unknown; activeForm?: unknown; blockedBy?: unknown; owner?: unknown };
  return (
    typeof todo.text === "string" &&
    (todo.status === "pending" || todo.status === "in_progress" || todo.status === "done") &&
    (todo.activeForm === undefined || typeof todo.activeForm === "string") &&
    (todo.blockedBy === undefined || isStringArray(todo.blockedBy)) &&
    (todo.owner === undefined || typeof todo.owner === "string")
  );
}

function isAssistantContinuation(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const continuation = value as Record<string, unknown>;
  if (continuation.type === "chat_reasoning") {
    return typeof continuation.text === "string"
      && continuation.text.length <= MAX_ASSISTANT_CONTINUATION_CHARS;
  }
  if (
    continuation.type !== "responses_reasoning"
    || !Array.isArray(continuation.items)
    || continuation.items.length > MAX_ASSISTANT_CONTINUATION_ITEMS
  ) return false;
  let textChars = 0;
  return continuation.items.every((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const item = raw as Record<string, unknown>;
    const validParts = (parts: unknown, type: string): boolean => Array.isArray(parts)
      && parts.length <= MAX_ASSISTANT_CONTINUATION_ITEMS
      && parts.every((rawPart) => {
        if (!rawPart || typeof rawPart !== "object" || Array.isArray(rawPart)) return false;
        const part = rawPart as Record<string, unknown>;
        if (part.type !== type || typeof part.text !== "string") return false;
        textChars += part.text.length;
        return textChars <= MAX_ASSISTANT_CONTINUATION_CHARS;
      });
    if (typeof item.encrypted_content === "string") textChars += item.encrypted_content.length;
    return item.type === "reasoning"
      && typeof item.id === "string"
      && validParts(item.summary, "summary_text")
      && (item.content === undefined || validParts(item.content, "reasoning_text"))
      && (item.encrypted_content === undefined || item.encrypted_content === null || typeof item.encrypted_content === "string")
      && textChars <= MAX_ASSISTANT_CONTINUATION_CHARS
      && (item.status === undefined || item.status === "in_progress" || item.status === "completed" || item.status === "incomplete");
  });
}

function isNeutralMessage(value: unknown): value is NeutralMsg {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  if (message.role === "user") {
    const validImages = message.images === undefined || (
        Array.isArray(message.images) && message.images.every((image) => {
          if (!image || typeof image !== "object" || Array.isArray(image)) return false;
          const attachment = image as Record<string, unknown>;
          return typeof attachment.path === "string" && typeof attachment.mediaType === "string";
        })
      );
    const validAttachments = message.attachments === undefined || (
      Array.isArray(message.attachments) && message.attachments.every((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return false;
        const attachment = item as Record<string, unknown>;
        return (
          (attachment.kind === "image" || attachment.kind === "file" || attachment.kind === "directory")
          && typeof attachment.name === "string"
          && (
            attachment.strategy === "native-image"
            || attachment.strategy === "vision-sidecar"
            || attachment.strategy === "inline-or-agent-tool"
            || attachment.strategy === "directory-inventory"
          )
          && (attachment.mediaType === undefined || typeof attachment.mediaType === "string")
          && (
            attachment.byteSize === undefined
            || (
              typeof attachment.byteSize === "number"
              && Number.isSafeInteger(attachment.byteSize)
              && attachment.byteSize >= 0
            )
          )
        );
      })
    );
    return (
      typeof message.content === "string"
      && (message.displayContent === undefined || typeof message.displayContent === "string")
      && validImages
      && validAttachments
      && (message.imageDescription === undefined || typeof message.imageDescription === "string")
    );
  }
  if (message.role === "assistant") {
    return typeof message.text === "string"
      && (message.continuation === undefined || isAssistantContinuation(message.continuation))
      && Array.isArray(message.toolUses) && message.toolUses.every((use) => {
      if (!use || typeof use !== "object" || Array.isArray(use)) return false;
      const tool = use as Record<string, unknown>;
      return typeof tool.id === "string" && typeof tool.name === "string" && Object.hasOwn(tool, "input");
    });
  }
  if (message.role === "tool") {
    return Array.isArray(message.results) && message.results.every((result) => {
      if (!result || typeof result !== "object" || Array.isArray(result)) return false;
      const tool = result as Record<string, unknown>;
      return typeof tool.id === "string" && typeof tool.name === "string" && typeof tool.content === "string" &&
        (tool.isError === undefined || typeof tool.isError === "boolean");
    });
  }
  return false;
}

function isSessionMeta(value: unknown): value is SessionMeta {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const meta = value as Partial<Record<keyof SessionMeta, unknown>>;
  return (
    validSessionId(meta.id) &&
    typeof meta.cwd === "string" &&
    (meta.haraVersion === undefined || isValidHaraVersion(meta.haraVersion)) &&
    (meta.profileId === undefined || isValidProfileId(meta.profileId)) &&
    (meta.spaceId === undefined || isValidSpaceId(meta.spaceId)) &&
    typeof meta.provider === "string" &&
    typeof meta.model === "string" &&
    typeof meta.title === "string" &&
    isTimestamp(meta.createdAt) &&
    isTimestamp(meta.updatedAt) &&
    (meta.workingSet === undefined || isStringArray(meta.workingSet)) &&
    (meta.todos === undefined || (Array.isArray(meta.todos) && meta.todos.every(isPersistedTodo))) &&
    (meta.source === undefined || meta.source === "interactive" || meta.source === "gateway" || meta.source === "cron") &&
    (meta.sourceName === undefined || typeof meta.sourceName === "string") &&
    (meta.jobId === undefined || (typeof meta.jobId === "string" && AUTOMATION_JOB_ID.test(meta.jobId))) &&
    (meta.pendingRouteBinding === undefined || meta.pendingRouteBinding === "cron") &&
    (meta.effort === undefined || meta.effort === null || typeof meta.effort === "string") &&
    (meta.approval === undefined
      || meta.approval === "suggest"
      || meta.approval === "auto-edit"
      || meta.approval === "full-auto") &&
    (meta.archived === undefined || typeof meta.archived === "boolean") &&
    (meta.gatewayOwner === undefined || typeof meta.gatewayOwner === "string") &&
    (meta.agentRef === undefined || (
      typeof meta.agentRef === "string"
      && meta.agentRef.length >= 3
      && meta.agentRef.length <= 160
      && /^(?:global|[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?):[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(meta.agentRef)
    ))
  );
}

/** Iterative on purpose: reject excessive nesting before recursive redaction/validation can exhaust stack. */
function sessionValueWithinLimits(value: unknown): boolean {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > MAX_SESSION_JSON_NODES || current.depth > MAX_SESSION_JSON_DEPTH) return false;
    if (typeof current.value === "string") {
      if (current.value.length > MAX_SESSION_STRING_CHARS) return false;
      continue;
    }
    if (!current.value || typeof current.value !== "object") continue;
    const values = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value as Record<string, unknown>);
    if (values.length > MAX_SESSION_ARRAY_ITEMS) return false;
    for (const child of values) pending.push({ value: child, depth: current.depth + 1 });
  }
  return true;
}

/** True if a parsed object has the SessionData shape we can safely use. */
function isSessionData(d: unknown): d is SessionData {
  const o = d as { meta?: unknown; history?: unknown; task?: unknown; storageGeneration?: unknown } | null;
  return !!o && typeof o === "object" && !Array.isArray(o) && isSessionMeta(o.meta) &&
    Array.isArray(o.history) && o.history.every(isNeutralMessage) &&
    (o.task === undefined || isTaskExecution(o.task)) &&
    (o.storageGeneration === undefined
      || (typeof o.storageGeneration === "string" && SESSION_STORAGE_GENERATION.test(o.storageGeneration)));
}

/** Read only. Legacy plaintext is redacted in the returned in-memory copy but intentionally not migrated
 *  here: listing/resuming must not perform an unlocked write. The next explicit save atomically migrates it. */
function readSessionFile(p: string): SessionData | null {
  try {
    const raw = readVerifiedRegularFileSnapshotSync(p, MAX_SESSION_FILE_BYTES, {
      action: "read Hara session",
      protectSensitive: false,
      rejectHardLinks: true,
    }).text;
    const d: unknown = JSON.parse(raw);
    return sessionValueWithinLimits(d) && isSessionData(d) ? redactedSessionCopy(d) : null;
  } catch {
    return null;
  }
}

function readSessionMetadataSidecar(
  id: string,
  transcriptMtimeMs: number,
): { meta: SessionMeta; generation?: string; routed?: boolean } | null {
  try {
    const path = sessionMetadataFile(id);
    const info = lstatSync(path);
    if (
      !info.isFile()
      || info.isSymbolicLink()
      || info.size > MAX_SESSION_METADATA_FILE_BYTES
    ) return null;
    const raw = readVerifiedRegularFileSnapshotSync(path, MAX_SESSION_METADATA_FILE_BYTES, {
      action: "read Hara session metadata",
      protectSensitive: false,
      rejectHardLinks: true,
    }).text;
    const parsed: unknown = JSON.parse(raw);
    if (!sessionValueWithinLimits(parsed) || !parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const wrapped = parsed as Partial<SessionMetadataSidecar>;
    if (
      wrapped.v === SESSION_INDEX_VERSION
      && typeof wrapped.generation === "string"
      && SESSION_STORAGE_GENERATION.test(wrapped.generation)
      && isSessionMeta(wrapped.meta)
      && wrapped.meta.id === id
    ) {
      const safeMeta = redactedSessionCopy({ meta: wrapped.meta, history: [] }).meta;
      return {
        meta: safeMeta,
        generation: wrapped.generation,
        ...(wrapped.routes === SESSION_INDEX_ROUTE_SCHEMA ? { routed: true } : {}),
      };
    }
    // Candidate builds wrote raw metadata sidecars before the generation wrapper existed. They remain a
    // safe best-effort cache only under the old strict-newer rule; wrapped sidecars are instead verified
    // against the authoritative transcript generation below and therefore do not trust wall-clock mtimes.
    return info.mtimeMs > transcriptMtimeMs && isSessionMeta(parsed) && parsed.id === id
      ? { meta: redactedSessionCopy({ meta: parsed, history: [] }).meta }
      : null;
  } catch {
    return null;
  }
}

interface SessionAuthority {
  meta: SessionMeta;
  generation?: string;
}

interface CachedSessionAuthority {
  signature: string;
  authority: SessionAuthority | null;
}

const sessionAuthorityCache = new Map<string, CachedSessionAuthority>();

function sessionTranscriptSignature(info: Stats): string {
  return `${String(info.dev)}:${String(info.ino)}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
}

function cacheSessionAuthority(
  id: string,
  signature: string,
  authority: SessionAuthority | null,
): SessionAuthority | null {
  sessionAuthorityCache.delete(id);
  sessionAuthorityCache.set(id, { signature, authority });
  if (sessionAuthorityCache.size > MAX_SESSION_AUTHORITY_CACHE_ENTRIES) {
    const oldest = sessionAuthorityCache.keys().next().value;
    if (typeof oldest === "string") sessionAuthorityCache.delete(oldest);
  }
  return authority;
}

/** Read only the generation prefix from a verified descriptor. New session files deliberately serialize
 * this field first. The before/open/after identity fence keeps a rename race from pairing a sidecar with a
 * different transcript; old tail-generation files return null and use one cached full parse. */
function readSessionGenerationPrefix(path: string, expected: Stats): string | null {
  let fd: number | undefined;
  try {
    if (
      !expected.isFile()
      || expected.isSymbolicLink()
      || expected.nlink > 1
      || expected.size > MAX_SESSION_FILE_BYTES
    ) return null;
    fd = openSync(
      path,
      constants.O_RDONLY
        | optionalPosixOpenFlag("O_NONBLOCK")
        | optionalPosixOpenFlag("O_NOFOLLOW"),
    );
    const opened = fstatSync(fd);
    if (
      !opened.isFile()
      || opened.nlink > 1
      || !sameOpenedFileIdentity(expected, opened)
      || opened.size !== expected.size
      || opened.mtimeMs !== expected.mtimeMs
      || opened.ctimeMs !== expected.ctimeMs
    ) return null;
    const bytes = Buffer.allocUnsafe(Math.min(SESSION_GENERATION_PREFIX_BYTES, opened.size));
    const count = bytes.length ? readSync(fd, bytes, 0, bytes.length, 0) : 0;
    const latest = fstatSync(fd);
    const current = lstatSync(path);
    if (
      current.isSymbolicLink()
      || !sameOpenedFileIdentity(opened, latest)
      || !sameOpenedFileIdentity(latest, current)
      || latest.size !== opened.size
      || latest.mtimeMs !== opened.mtimeMs
      || latest.ctimeMs !== opened.ctimeMs
    ) return null;
    const match = /^\s*\{\s*"storageGeneration"\s*:\s*"([^"]+)"/u.exec(
      bytes.subarray(0, count).toString("utf8"),
    );
    return match && SESSION_STORAGE_GENERATION.test(match[1]) ? match[1] : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Resolve one transcript's authoritative generation and metadata once per immutable file identity. A
 * generation-matching sidecar keeps timeline reads small; obsolete index entries compare against the cached
 * current generation instead of reparsing the same potentially large transcript on every line/page. */
function authoritativeSessionMetadata(
  id: string,
  transcript: string,
  info: Stats,
): SessionAuthority | null {
  const signature = sessionTranscriptSignature(info);
  const cached = sessionAuthorityCache.get(id);
  if (cached?.signature === signature) {
    sessionAuthorityCache.delete(id);
    sessionAuthorityCache.set(id, cached);
    return cached.authority;
  }

  const sidecar = readSessionMetadataSidecar(id, info.mtimeMs);
  const generation = readSessionGenerationPrefix(transcript, info);
  if (
    generation
    && sidecar?.generation === generation
  ) {
    return cacheSessionAuthority(id, signature, {
      meta: sidecar.meta,
      generation,
    });
  }

  const data = readSessionFile(transcript);
  const authority = data?.meta.id === id
    ? {
        meta: data.meta,
        ...(data.storageGeneration ? { generation: data.storageGeneration } : {}),
      }
    : null;
  return cacheSessionAuthority(id, signature, authority);
}

export function loadSession(id: string): SessionData | null {
  if (!validSessionId(id)) return null;
  const p = sessionFile(id);
  if (!existsSync(p)) return null;
  const data = readSessionFile(p);
  return data?.meta.id === id ? data : null; // a corrupt, spoofed, or hand-edited file resumes as "no session"
}

/** Session metas, newest first; optionally filtered to a cwd. */
export function listSessions(cwd?: string): SessionMeta[] {
  let metas: SessionMeta[] = [];
  for (const f of readdirSync(sessionsDir())) {
    if (!isSessionTranscriptFileName(f)) continue;
    const id = f.slice(0, -".json".length);
    if (!validSessionId(id)) continue;
    let transcriptInfo: Stats;
    try {
      transcriptInfo = lstatSync(join(sessionsDir(), f));
      if (!transcriptInfo.isFile() || transcriptInfo.isSymbolicLink()) continue;
    } catch {
      continue;
    }
    const meta = authoritativeSessionMetadata(
      id,
      join(sessionsDir(), f),
      transcriptInfo,
    )?.meta;
    if (meta?.id && f === `${meta.id}.json` && meta.updatedAt) metas.push(meta); // skip spoofed/metalless/corrupt; never mutate while listing
  }
  if (cwd) {
    const selected = canonicalSessionCwd(cwd);
    metas = metas.filter((m) => canonicalSessionCwd(m.cwd) === selected);
  }
  return metas.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

function sessionMetadataMatchesOptions(
  meta: SessionMeta,
  options: Omit<SessionMetadataPageOptions, "cursor" | "limit">,
): boolean {
  const source = meta.source ?? "interactive";
  if (options.sources?.length && !options.sources.includes(source)) return false;
  if (options.sourceName !== undefined && meta.sourceName !== options.sourceName) return false;
  if (options.jobId !== undefined && (meta.jobId ?? null) !== options.jobId) return false;
  if (options.gatewayOwner !== undefined && meta.gatewayOwner !== options.gatewayOwner) return false;
  if (!options.includeArchived && meta.archived) return false;
  if (options.idPrefix !== undefined && !meta.id.startsWith(options.idPrefix)) return false;
  if (
    options.idFragment !== undefined
    && meta.id !== options.idFragment
    && !meta.id.startsWith(options.idFragment)
    && !meta.id.endsWith(options.idFragment)
  ) return false;
  const cwd = canonicalSessionCwd(meta.cwd);
  if (options.cwd && cwd !== canonicalSessionCwd(options.cwd)) return false;
  if (options.excludeCwd && cwd === canonicalSessionCwd(options.excludeCwd)) return false;
  return true;
}

/** Obsolete generations can consume several append-only pages even when only a handful of current
 * transcripts exist. Once the bounded fast path is exhausted, read each authoritative transcript metadata
 * at most once instead of either walking generations without bound or returning a false negative. */
function authoritativeRecentSessionMetadata(
  options: Omit<SessionMetadataPageOptions, "cursor" | "limit">,
  limit: number,
): SessionMeta[] {
  return listSessions()
    .filter((meta) => sessionMetadataMatchesOptions(meta, options))
    .slice(0, limit);
}

function metadataForSessionIndexRecord(record: SessionIndexRecord): SessionMeta | null {
  const transcript = sessionFile(record.id);
  let info;
  try {
    info = lstatSync(transcript);
    if (
      !info.isFile()
      || info.isSymbolicLink()
      || info.size > MAX_SESSION_FILE_BYTES
      || !Number.isFinite(info.mtimeMs)
    ) return null;
  } catch {
    return null;
  }

  const authority = authoritativeSessionMetadata(record.id, transcript, info);
  if (!authority) return null;
  if (record.generation === "legacy") {
    return authority.generation === undefined ? authority.meta : null;
  }
  return authority.generation === record.generation ? authority.meta : null;
}

/** Bounded metadata page for renderer timelines. The cursor walks small hourly append-only shards in
 * reverse order and validates at most a fixed number of generation-bound records. No request enumerates,
 * stats, parses, or sorts the complete transcript directory. */
export function listSessionMetadataPage(
  options: SessionMetadataPageOptions = {},
): SessionMetadataPage {
  const limit = Math.min(
    MAX_SESSION_METADATA_PAGE_SIZE,
    Math.max(1, Math.trunc(options.limit ?? DEFAULT_SESSION_METADATA_PAGE_SIZE)),
  );
  const cursor = options.cursor === undefined ? undefined : decodeSessionIndexCursor(options.cursor);
  if (options.cursor !== undefined && !cursor) throw new Error("invalid session metadata cursor");

  const selectedCwd = options.cwd ? canonicalSessionCwd(options.cwd) : undefined;
  const excludedCwd = options.excludeCwd ? canonicalSessionCwd(options.excludeCwd) : undefined;
  const sources = options.sources?.length ? new Set(options.sources) : undefined;
  const sessions: SessionMeta[] = [];
  const returnedIds = new Set<string>();
  let inspected = 0;
  let bytesRead = 0;
  let shardsVisited = 0;
  const preferredRoute = preferredSessionIndexRoute(options);
  let route = cursor?.route ?? (cursor ? "all" : preferredRoute);
  // Keep one extra bucket as the next opaque continuation after the per-request shard budget. A cursor's
  // current shard is explicit; all predecessors are collected in one bounded hierarchy traversal.
  let buckets = cursor
    ? [
        cursor.bucket,
        ...sessionIndexBucketsBefore(cursor.bucket, MAX_SESSION_INDEX_SHARDS_PER_PAGE, route),
      ]
    : sessionIndexBucketsBefore(undefined, MAX_SESSION_INDEX_SHARDS_PER_PAGE + 1, route);
  // Candidate builds and hand-authored fixtures may have only the original global route. A completely
  // absent partition falls back without weakening a populated partition's audience boundary.
  if (!cursor && route !== "all" && buckets.length === 0) {
    route = "all";
    buckets = sessionIndexBucketsBefore(undefined, MAX_SESSION_INDEX_SHARDS_PER_PAGE + 1, route);
  }
  let bucketPosition = 0;
  let bucket = buckets[bucketPosition];
  let offset = cursor?.offset;

  // A forged cursor cannot make Hara open an arbitrary path. Missing/rotated shards simply continue with
  // the next older valid bucket.
  const boundedBucketOffset = (candidate: string, requested?: number): number => {
    try {
      const size = lstatSync(sessionIndexBucketFile(candidate, false, route)).size;
      return requested === undefined ? size : Math.min(requested, size);
    } catch {
      return 0;
    }
  };
  if (bucket) offset = boundedBucketOffset(bucket, offset);

  const advanceBucket = (): void => {
    bucketPosition += 1;
    bucket = buckets[bucketPosition];
    offset = bucket ? boundedBucketOffset(bucket) : 0;
  };

  while (
    bucket
    && sessions.length < limit
    && inspected < MAX_SESSION_INDEX_RECORDS_PER_PAGE
    && bytesRead < MAX_SESSION_INDEX_BYTES_PER_PAGE + MAX_SESSION_INDEX_LINE_BYTES
    && shardsVisited < MAX_SESSION_INDEX_SHARDS_PER_PAGE
  ) {
    shardsVisited += 1;
    if (!offset || offset <= 0) {
      advanceBucket();
      continue;
    }
    const page = previousSessionIndexLines(sessionIndexBucketFile(bucket, false, route), offset);
    bytesRead += page.bytesRead;
    offset = page.nextOffset;
    for (const line of page.lines) {
      if (
        sessions.length >= limit
        || inspected >= MAX_SESSION_INDEX_RECORDS_PER_PAGE
      ) {
        offset = line.start + Buffer.byteLength(line.text, "utf8") + 1;
        break;
      }
      inspected += 1;
      let record: unknown;
      try {
        record = JSON.parse(line.text);
      } catch {
        continue;
      }
      if (!validSessionIndexRecord(record) || returnedIds.has(record.id)) continue;
      if (options.idPrefix !== undefined && !record.id.startsWith(options.idPrefix)) continue;
      if (
        options.idFragment !== undefined
        && record.id !== options.idFragment
        && !record.id.startsWith(options.idFragment)
        && !record.id.endsWith(options.idFragment)
      ) continue;
      const meta = metadataForSessionIndexRecord(record);
      if (!meta?.updatedAt) continue;
      if (sources && !sources.has(meta.source ?? "interactive")) continue;
      if (options.sourceName !== undefined && meta.sourceName !== options.sourceName) continue;
      if (options.jobId !== undefined && (meta.jobId ?? null) !== options.jobId) continue;
      if (options.gatewayOwner !== undefined && meta.gatewayOwner !== options.gatewayOwner) continue;
      if (!options.includeArchived && meta.archived) continue;
      if (selectedCwd && canonicalSessionCwd(meta.cwd) !== selectedCwd) continue;
      if (excludedCwd && canonicalSessionCwd(meta.cwd) === excludedCwd) continue;
      returnedIds.add(meta.id);
      sessions.push(meta);
    }
    if (page.lines.length === 0 && page.nextOffset === offset && offset > 0) {
      // A corrupt overlong record cannot pin the cursor forever.
      offset = Math.max(0, offset - MAX_SESSION_INDEX_BYTES_PER_PAGE);
    }
    if ((offset ?? 0) <= 0) advanceBucket();
  }

  const nextBucket = bucket;
  const nextOffset = offset ?? 0;
  // An existing zero-length/corrupt shard is still a continuation point: the next bounded request will
  // walk past it. Treating offset 0 as terminal could hide an older valid shard after a run of empty files.
  const hasMore = nextBucket !== undefined;
  return {
    sessions,
    hasMore,
    ...(hasMore
      ? { nextCursor: encodeSessionIndexCursor({ v: 1, bucket: nextBucket!, offset: nextOffset, route }) }
      : {}),
    limit,
  };
}

/** Small source-aware metadata slice for menus and implicit resume. The route selector partitions ordinary
 * automation noise before paging, so a complete lookup does not mistake an arbitrary page cap for absence. */
export function recentSessionMetadata(
  options: Omit<SessionMetadataPageOptions, "cursor" | "limit"> & { limit?: number } = {},
): SessionMeta[] {
  const limit = Math.min(
    MAX_RECENT_SESSION_METADATA_SIZE,
    Math.max(1, Math.trunc(options.limit ?? DEFAULT_SESSION_METADATA_PAGE_SIZE)),
  );
  const sessions: SessionMeta[] = [];
  const seen = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < MAX_RECENT_SESSION_INDEX_PAGES; pageNumber += 1) {
    const page = listSessionMetadataPage({
      ...options,
      cursor,
      limit: Math.min(MAX_SESSION_METADATA_PAGE_SIZE, Math.max(1, limit - sessions.length)),
    });
    for (const meta of page.sessions) {
      if (seen.has(meta.id)) continue;
      seen.add(meta.id);
      sessions.push(meta);
      if (sessions.length >= limit) return sessions;
    }
    if (!page.hasMore || !page.nextCursor) return sessions;
    if (seenCursors.has(page.nextCursor)) {
      return authoritativeRecentSessionMetadata(options, limit);
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  return authoritativeRecentSessionMetadata(options, limit);
}

/** Exhaustive fragment lookup inside a caller-supplied audience route. Each page is resource-bounded and
 * the search stops as soon as ambiguity is proven; no unrelated source/cwd history is opened. */
export function findSessionMetadataByFragment(
  idFragment: string,
  options: Omit<SessionMetadataPageOptions, "cursor" | "limit" | "idFragment">,
): SessionMeta[] {
  const fragment = idFragment.trim();
  if (!validSessionId(fragment)) return [];
  const sessions = new Map<string, SessionMeta>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page = listSessionMetadataPage({
      ...options,
      idFragment: fragment,
      cursor,
      limit: 2,
    });
    for (const meta of page.sessions) sessions.set(meta.id, meta);
    if (sessions.size > 1 || !page.hasMore || !page.nextCursor) return [...sessions.values()];
    if (seenCursors.has(page.nextCursor)) {
      throw new Error("session metadata fragment lookup stopped making progress");
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}

/** A prefix must be proven unique. Search a fixed number of bounded index pages; if older records remain,
 * fail closed and ask for the full id instead of scanning every transcript or guessing uniqueness. */
export function findSessionMetadataByPrefix(
  idPrefix: string,
): { sessions: SessionMeta[]; exhaustive: boolean } {
  if (!validSessionId(idPrefix)) return { sessions: [], exhaustive: true };
  const sessions = new Map<string, SessionMeta>();
  const seenCursors = new Set<string>();
  // Every current writer and compatibility migration publishes an eight-character short-id partition.
  // Search that small collision domain to completion so every ID printed by Hara remains resolvable even
  // after one long-lived session has accumulated many thousands of obsolete generation records.
  const exhaustiveShortRoute = idPrefix.length >= 8;
  let cursor: string | undefined;
  for (
    let pageNumber = 0;
    exhaustiveShortRoute || pageNumber < MAX_SESSION_PREFIX_LOOKUP_PAGES;
    pageNumber += 1
  ) {
    const page = listSessionMetadataPage({
      idPrefix,
      cursor,
      limit: 2,
      includeArchived: true,
    });
    for (const meta of page.sessions) sessions.set(meta.id, meta);
    if (sessions.size > 1) return { sessions: [...sessions.values()], exhaustive: true };
    if (!page.hasMore) return { sessions: [...sessions.values()], exhaustive: true };
    cursor = page.nextCursor;
    if (!cursor) break;
    if (seenCursors.has(cursor)) {
      throw new Error("session metadata prefix lookup stopped making progress");
    }
    seenCursors.add(cursor);
  }
  return { sessions: [...sessions.values()], exhaustive: false };
}

const activeSessionIndexMigrations = new Map<string, Promise<void>>();
const initializedSessionIndexes = new Set<string>();

function migrationMarker(): string {
  return join(sessionIndexDir(), "legacy-migration.complete");
}

function migrationLock(): string {
  return join(sessionIndexDir(), "legacy-migration.lock");
}

function currentWriterDirectoryMarker(): string {
  return join(sessionIndexDir(), "current-writer-directory.json");
}

interface SessionIndexMigrationMarker {
  version: number;
  routeSchema: number;
  completedAt: string;
  sessionsDirectoryMtimeMs: number;
  sessionsDirectoryCtimeMs: number;
  inspected: number;
  migrated: number;
}

interface CurrentWriterDirectoryMarker {
  version: number;
  routeSchema: number;
  recordedAt: string;
  sessionsDirectoryMtimeMs: number;
}

function readMigrationMarker(): SessionIndexMigrationMarker | null {
  try {
    const raw = readFileSync(migrationMarker(), "utf8");
    if (Buffer.byteLength(raw, "utf8") > 16 * 1024) return null;
    const marker = JSON.parse(raw) as Partial<SessionIndexMigrationMarker>;
    return marker.version === SESSION_INDEX_VERSION
      && marker.routeSchema === SESSION_INDEX_ROUTE_SCHEMA
      && Number.isFinite(Date.parse(marker.completedAt ?? ""))
      && typeof marker.sessionsDirectoryMtimeMs === "number"
      && Number.isFinite(marker.sessionsDirectoryMtimeMs)
      && typeof marker.sessionsDirectoryCtimeMs === "number"
      && Number.isFinite(marker.sessionsDirectoryCtimeMs)
      && Number.isSafeInteger(marker.inspected)
      && marker.inspected! >= 0
      && Number.isSafeInteger(marker.migrated)
      && marker.migrated! >= 0
      ? marker as SessionIndexMigrationMarker
      : null;
  } catch {
    return null;
  }
}

function readCurrentWriterDirectoryMarker(): CurrentWriterDirectoryMarker | null {
  try {
    const raw = readFileSync(currentWriterDirectoryMarker(), "utf8");
    if (Buffer.byteLength(raw, "utf8") > 4 * 1024) return null;
    const marker = JSON.parse(raw) as Partial<CurrentWriterDirectoryMarker>;
    return marker.version === SESSION_INDEX_VERSION
      && marker.routeSchema === SESSION_INDEX_ROUTE_SCHEMA
      && Number.isFinite(Date.parse(marker.recordedAt ?? ""))
      && typeof marker.sessionsDirectoryMtimeMs === "number"
      && Number.isFinite(marker.sessionsDirectoryMtimeMs)
      ? marker as CurrentWriterDirectoryMarker
      : null;
  } catch {
    return null;
  }
}

function sessionDirectoryInfo(): Stats | null {
  try {
    const directory = lstatSync(sessionsDir());
    return directory.isDirectory() && !directory.isSymbolicLink() ? directory : null;
  } catch {
    return null;
  }
}

/** True only when every directory-entry mutation since the last compatibility sweep was acknowledged by a
 * current writer. An old writer that ran before this operation makes the precondition false, so a later
 * current save cannot accidentally bless and hide that transcript. */
function sessionDirectoryMatchesCurrentState(): boolean {
  const marker = readMigrationMarker();
  const directory = sessionDirectoryInfo();
  if (!marker || !directory) return false;
  if (directory.mtimeMs === marker.sessionsDirectoryMtimeMs) return true;
  const current = readCurrentWriterDirectoryMarker();
  return !!current
    && Date.parse(current.recordedAt) >= Date.parse(marker.completedAt)
    && directory.mtimeMs === current.sessionsDirectoryMtimeMs;
}

/** Best-effort acceleration only. A failed write leaves the next compatibility check conservative. */
function writeCurrentWriterDirectoryMarker(): void {
  const directory = sessionDirectoryInfo();
  if (!directory) return;
  const target = currentWriterDirectoryMarker();
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "wx", 0o600);
    writeFileSync(fd, JSON.stringify({
      version: SESSION_INDEX_VERSION,
      routeSchema: SESSION_INDEX_ROUTE_SCHEMA,
      recordedAt: new Date().toISOString(),
      sessionsDirectoryMtimeMs: directory.mtimeMs,
    } satisfies CurrentWriterDirectoryMarker), "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, target);
    chmodSync(target, 0o600);
  } catch {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Keep the compatibility path conservative.
      }
    }
  } finally {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // A unique unpublished temp file is inert.
    }
  }
}

/** Current Hara writers publish route intents themselves. A stable directory plus a durable completion
 * marker makes ordinary launches O(1). Directory changes detect mixed-version writers promptly, while
 * the daily interval remains a backstop for filesystems that do not expose a useful directory timestamp. */
function sessionIndexCompatibilitySweepRequired(force = false): boolean {
  if (force) return true;
  const marker = readMigrationMarker();
  if (!marker) return true;
  const age = Date.now() - Date.parse(marker.completedAt);
  if (age < 0 || age >= SESSION_INDEX_COMPATIBILITY_AUDIT_MS) return true;
  return !sessionDirectoryMatchesCurrentState();
}

function sameLockRecord(left: LockRecord, right: LockRecord | null): boolean {
  return !!right
    && left.pid === right.pid
    && left.startedAt === right.startedAt
    && left.token === right.token;
}

/** Acquire the one-time import lock, reclaiming only a complete lock whose owner PID is proven dead.
 * The token check prevents a late cleanup from unlinking a successor's lock. */
function acquireSessionIndexMigrationLock(): (LockRecord & { token: string }) | null {
  const lock = migrationLock();
  const claim = newLockRecord();
  try {
    writeExclusive(lock, claim);
    return claim;
  } catch (error: any) {
    if (error?.code !== "EEXIST") throw error;
  }

  const observed = readLockRecord(lock);
  if (!observed || pidAlive(observed.pid)) return null;
  const reclaim = `${lock}.reclaim`;
  const reclaimClaim = newLockRecord();
  try {
    writeExclusive(reclaim, reclaimClaim);
  } catch {
    return null;
  }
  try {
    const current = readLockRecord(lock);
    if (!sameLockRecord(observed, current) || !current || pidAlive(current.pid)) return null;
    rmSync(lock);
    writeExclusive(lock, claim);
    return claim;
  } finally {
    const currentReclaim = readLockRecord(reclaim);
    if (sameLockRecord(reclaimClaim, currentReclaim)) {
      try {
        rmSync(reclaim);
      } catch {
        // A surviving transition guard fails closed on the next attempt.
      }
    }
  }
}

function releaseSessionIndexMigrationLock(claim: LockRecord & { token: string }): void {
  const lock = migrationLock();
  if (sameLockRecord(claim, readLockRecord(lock))) {
    try {
      rmSync(lock);
    } catch {
      // A later retry can reclaim this complete lock after the current process exits.
    }
  }
}

async function waitForMigrationOwner(): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const lock = migrationLock();
    if (!existsSync(lock)) return;
    const owner = readLockRecord(lock);
    // A complete record whose owner exited can be reclaimed by the caller's next acquisition attempt.
    // Requiring the dead process to have removed its lock would turn an ordinary crash into a 30s stall.
    if (owner?.token && !pidAlive(owner.pid)) return;
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error("session metadata index migration is still running; retry shortly");
}

function clearMigrationMarker(): void {
  const marker = migrationMarker();
  rmSync(marker, { force: true });
  if (existsSync(marker)) {
    throw new Error("could not invalidate the incomplete session metadata migration marker");
  }
}

function legacySessionCandidate(id: string): SessionData | null {
  const transcript = sessionFile(id);
  let info: Stats;
  try {
    info = lstatSync(transcript);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_SESSION_FILE_BYTES) return null;
  } catch {
    return null;
  }
  // Route-aware current writers leave a generation-bound sidecar. Verify that generation against the
  // small transcript prefix before parsing the full conversation. This keeps a mixed-writer directory
  // audit proportional to metadata rather than transcript size.
  const sidecar = readSessionMetadataSidecar(id, info.mtimeMs);
  if (
    sidecar?.generation
    && readSessionGenerationPrefix(transcript, info) === sidecar.generation
    && sidecar.routed
  ) return null;
  const data = readSessionFile(transcript);
  if (data?.meta.id !== id) return null;
  return data;
}

/** Convert a legacy transcript under its ordinary single-writer lock. Reusing the normal
 * intent-before-rename generation protocol makes the conversion crash-idempotent: a pre-rename record is
 * inert, and after the rename every older duplicate `legacy` record stops matching the authoritative file. */
function migrateLegacySession(id: string): boolean {
  if (!legacySessionCandidate(id)) return false;
  const alreadyOwned = ownedLocks.has(id);
  const lock = acquireSessionLock(id);
  if (!lock.ok) return false;
  try {
    const data = legacySessionCandidate(id);
    if (!data) return false;
    const gatewayOwner =
      (data.meta.source === "gateway" || (!data.meta.source && data.meta.sourceName))
        ? gatewayOwnerFromSessionId(data.meta.id, data.meta.sourceName ?? "")
        : undefined;
    const needsGatewayOwner = !!gatewayOwner && data.meta.gatewayOwner !== gatewayOwner;
    if (needsGatewayOwner) data.meta.gatewayOwner = gatewayOwner;
    // Older Desktop builds persisted a transcript as soon as the user clicked “new chat”. Archive only
    // truly empty interactive shells while rewriting them through the v3 compatibility path. Keeping the
    // file preserves reversibility; user-only turns, task checkpoints, gateway and automation sessions are
    // never classified as abandoned drafts.
    if (
      data.history.length === 0
      && !data.task
      && (data.meta.source === undefined || data.meta.source === "interactive")
      && data.meta.archived !== true
    ) {
      data.meta.archived = true;
    }
    if (data.storageGeneration && !needsGatewayOwner && readSessionMetadataSidecar(
      data.meta.id,
      lstatSync(sessionFile(data.meta.id)).mtimeMs,
    )?.routed) {
      // The transcript is already generation-bound (for example, a candidate build that only had the
      // global timeline). Merge the existing intent into every route without rewriting conversation data.
      appendSessionIndexRecord({
        v: 1,
        id: data.meta.id,
        generation: data.storageGeneration,
        at: Date.parse(data.meta.updatedAt),
      }, data.meta, true);
      writeSessionMetadataSidecar(data.meta, data.storageGeneration);
    } else {
      // A generation-bound v1/v2 transcript still needs a v3 rewrite: readSessionFile already produced a
      // redacted copy, and normal persistence removes legacy plaintext from both transcript and sidecar.
      persistSessionSnapshot(data.meta, data.history, data.task, data.meta.updatedAt);
    }
    return true;
  } finally {
    if (!alreadyOwned) releaseSessionLock(id);
  }
}

/** A migration may race a live old writer or skip a transcript whose ordinary session lock is held. Make
 * completion depend on a second authoritative candidate pass, not merely on finishing the first directory
 * enumeration. Current route-aware writers are ignored by legacySessionCandidate and do not keep this open. */
async function hasRemainingLegacySession(): Promise<boolean> {
  const dir = await openDirAsync(sessionsDir());
  let inspected = 0;
  try {
    for await (const entry of dir) {
      if (!entry.isFile() || !isSessionTranscriptFileName(entry.name)) continue;
      const id = entry.name.slice(0, -".json".length);
      if (!validSessionId(id)) continue;
      if (legacySessionCandidate(id)) return true;
      inspected += 1;
      if ((inspected & 15) === 0) {
        await new Promise<void>((resolveYield) => setImmediate(resolveYield));
      }
    }
    return false;
  } finally {
    // Node returns a Promise here, while Bun 1.3.9 closes synchronously and returns undefined.
    // Awaiting either contract is safe; chaining `.catch()` is not.
    try {
      await dir.close();
    } catch {
      // The async iterator may already have closed the handle.
    }
  }
}

function writeMigrationMarker(inspected: number, migrated: number): void {
  const target = migrationMarker();
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    const directory = lstatSync(sessionsDir());
    fd = openSync(tmp, "wx", 0o600);
    writeFileSync(fd, JSON.stringify({
      version: SESSION_INDEX_VERSION,
      routeSchema: SESSION_INDEX_ROUTE_SCHEMA,
      completedAt: new Date().toISOString(),
      sessionsDirectoryMtimeMs: directory.mtimeMs,
      sessionsDirectoryCtimeMs: directory.ctimeMs,
      inspected,
      migrated,
    }), "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, target);
    chmodSync(target, 0o600);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      rmSync(tmp, { force: true });
    } catch {
      // The marker is diagnostic; the generated transcript/index records are authoritative.
    }
  }
}

/** Compatibility import for pre-index and mixed-version writers. A durable marker makes normal launches
 * O(1); persistent Serve calls `audit` frequently, but only the first check after the daily interval sweeps.
 * `force` is reserved for an operator/test requesting an immediate complete compatibility import. */
export function ensureSessionMetadataIndex(options: { force?: boolean; audit?: boolean } = {}): Promise<void> {
  const root = sessionIndexDir();
  const existing = activeSessionIndexMigrations.get(root);
  if (existing) return existing;
  if (
    !options.force
    && !options.audit
    && initializedSessionIndexes.has(root)
    && !sessionIndexCompatibilitySweepRequired()
  ) return Promise.resolve();
  const operation = (async (): Promise<boolean> => {
    if (!sessionIndexCompatibilitySweepRequired(options.force)) return true;
    for (;;) {
      const claim = acquireSessionIndexMigrationLock();
      if (!claim) {
        await waitForMigrationOwner();
        // A successful owner publishes a valid marker. If it exited after an error, do not bless this
        // process as initialized: acquire the now-free lock and complete the migration ourselves.
        if (!sessionIndexCompatibilitySweepRequired(options.force)) return true;
        continue;
      }
      try {
        const dir = await openDirAsync(sessionsDir());
        let inspected = 0;
        let migrated = 0;
        const legacyCandidates: Array<{ id: string; at: number }> = [];
        try {
          for await (const entry of dir) {
            if (!entry.isFile() || !isSessionTranscriptFileName(entry.name)) continue;
            const id = entry.name.slice(0, -".json".length);
            if (!validSessionId(id)) continue;
            const candidate = legacySessionCandidate(id);
            if (candidate) {
              legacyCandidates.push({ id, at: Date.parse(candidate.meta.updatedAt) });
            }
            inspected += 1;
            if ((inspected & 15) === 0) {
              await new Promise<void>((resolveYield) => setImmediate(resolveYield));
            }
          }
        } finally {
          // Keep this compatible with both Node's Promise-returning close and Bun's synchronous close.
          try {
            await dir.close();
          } catch {
            // The async iterator may already have closed the handle.
          }
        }
        // Reverse-tail paging relies on append order within one hourly shard. Directory enumeration has no
        // timestamp guarantee, so publish legacy generations oldest-first; equal timestamps use id as a
        // stable tie-breaker. Each migration rechecks under the session lock in case a current writer won.
        legacyCandidates.sort((left, right) => left.at - right.at || left.id.localeCompare(right.id));
        for (let index = 0; index < legacyCandidates.length; index += 1) {
          if (migrateLegacySession(legacyCandidates[index]!.id)) migrated += 1;
          if ((index & 15) === 15) {
            await new Promise<void>((resolveYield) => setImmediate(resolveYield));
          }
        }
        if (await hasRemainingLegacySession()) {
          // A live old writer or held session lock kept at least one candidate unsafe to rewrite. Remove any
          // prior marker so the next call retries immediately instead of hiding it for the daily audit window.
          clearMigrationMarker();
          return false;
        }
        writeMigrationMarker(inspected, migrated);
        return true;
      } catch (error) {
        try {
          clearMigrationMarker();
        } catch (markerError) {
          throw new AggregateError(
            [error, markerError],
            "session metadata migration failed and its completion marker could not be invalidated",
          );
        }
        throw error;
      } finally {
        releaseSessionIndexMigrationLock(claim);
      }
    }
  })();
  let tracked: Promise<void>;
  tracked = operation.then(
    (complete) => {
      if (complete) initializedSessionIndexes.add(root);
      else initializedSessionIndexes.delete(root);
      if (activeSessionIndexMigrations.get(root) === tracked) activeSessionIndexMigrations.delete(root);
    },
    (error) => {
      if (activeSessionIndexMigrations.get(root) === tracked) activeSessionIndexMigrations.delete(root);
      throw error;
    },
  );
  activeSessionIndexMigrations.set(root, tracked);
  return tracked;
}

export function latestForCwd(cwd: string): SessionData | null {
  const [m] = recentSessionMetadata({ cwd, sources: ["interactive"], limit: 1 });
  return m ? loadSession(m.id) : null;
}

/** Latest session of any source. Use only where the newest activity itself is the signal; implicit human
 * resume must use `latestForCwd`, which deliberately cannot cross into an automation audience. */
export function latestAnyForCwd(cwd: string): SessionData | null {
  const [m] = recentSessionMetadata({ cwd, limit: 1 });
  return m ? loadSession(m.id) : null;
}
