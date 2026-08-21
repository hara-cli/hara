// Reviewable execution-time learning. Runtime observations are captured as bounded, redacted candidates;
// only explicitly approved personal/project records or Control-approved organization records are injected
// into future prompts. The store is private, atomic, cross-process safe, and keeps a tamper-evident audit
// chain. Conversation text is never persisted here.
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { sleepSync } from "../sync-sleep.js";
import { redactSensitiveText } from "../security/secrets.js";
import { scanMemory, scrubLocal } from "../memory/guard.js";
import { HARA_RUNTIME_VERSION } from "../version.js";

export const LEARNING_STORE_VERSION = 1;
export const LEARNING_PROMOTION_OCCURRENCES = 3;
export const LEARNING_PROMOTION_DISTINCT_TASKS = 2;
export const LEARNING_PROMOTION_WINDOW_DAYS = 30;
export const MAX_LEARNING_SUMMARY_CHARS = 1_200;
export const MAX_LEARNING_EVIDENCE_CHARS = 1_000;
export const MAX_LEARNING_RATIONALE_CHARS = 1_000;
export const MAX_LEARNING_EVIDENCE = 16;
export const MAX_LEARNING_RECORDS = 5_000;
export const MAX_LEARNING_AUDIT = 20_000;

export type LearningKind =
  | "business_rule"
  | "user_preference"
  | "workflow"
  | "correction"
  | "failure_pattern"
  | "action_ownership";
export type LearningScope = "personal" | "project" | "organization";
export type LearningStatus = "pending" | "approved" | "rejected" | "revoked" | "submitted";
export type LearningStability = "tentative" | "stable";
export type LearningSource =
  | "explicit_user"
  | "verified_task"
  | "user_correction"
  | "tool_failure"
  | "workflow_result"
  | "runtime_guard"
  | "organization";

const LEARNING_KINDS = new Set<LearningKind>([
  "business_rule",
  "user_preference",
  "workflow",
  "correction",
  "failure_pattern",
  "action_ownership",
]);
const LEARNING_SCOPES = new Set<LearningScope>(["personal", "project", "organization"]);
const LEARNING_STATUSES = new Set<LearningStatus>(["pending", "approved", "rejected", "revoked", "submitted"]);
const LEARNING_SOURCES = new Set<LearningSource>([
  "explicit_user",
  "verified_task",
  "user_correction",
  "tool_failure",
  "workflow_result",
  "runtime_guard",
  "organization",
]);
const PATTERN_KEY = /^[a-z][a-z0-9_.-]{2,119}$/;
const LOCK_ATTEMPTS = 500;
const LOCK_WAIT_MS = 10;

export interface LearningEvidence {
  id: string;
  taskHash: string;
  fingerprint: string;
  summary: string;
  source: LearningSource;
  sourceVersion: string;
  observedAt: string;
}

export interface LearningCandidate {
  version: 1;
  id: string;
  clientId: string;
  remoteId?: string;
  patternKey: string;
  kind: LearningKind;
  scope: LearningScope;
  summary: string;
  rationale?: string;
  status: LearningStatus;
  stability: LearningStability;
  occurrenceCount: number;
  distinctTaskCount: number;
  evidence: LearningEvidence[];
  revision: number;
  createdAt: string;
  updatedAt: string;
  reviewedAt?: string;
  reviewedBy?: "user" | "organization";
  reviewNote?: string;
  submittedAt?: string;
  sourceVersion: string;
}

export interface LearningAuditEvent {
  id: string;
  seq: number;
  action: "capture" | "observe" | "approve" | "reject" | "revoke" | "submit" | "sync";
  candidateId: string;
  actor: "agent" | "engine" | "user" | "organization";
  at: string;
  payload: Record<string, string | number | boolean>;
  prevHash: string;
  rowHash: string;
}

interface LearningStoreFile {
  version: typeof LEARNING_STORE_VERSION;
  storeKey: string;
  remoteVersion?: number;
  candidates: LearningCandidate[];
  audit: LearningAuditEvent[];
}

export interface CaptureLearningInput {
  patternKey: string;
  kind: LearningKind;
  scope: LearningScope;
  summary: string;
  evidence: string;
  source: LearningSource;
  rationale?: string;
}

export interface LearningStoreContext {
  cwd: string;
  stateHome?: string;
  profileId?: string;
  taskId?: string;
  sessionId?: string;
  now?: Date;
}

export interface LearningListOptions {
  cwd: string;
  stateHome?: string;
  profileId?: string;
  scope?: LearningScope;
  status?: LearningStatus;
  limit?: number;
}

export interface OrganizationLearningWire {
  id: string;
  client_id?: string;
  pattern_key: string;
  kind: LearningKind;
  summary: string;
  rationale?: string;
  occurrence_count: number;
  distinct_task_count: number;
  revision: number;
  updated_at: string;
}

interface LockRecord {
  pid: number;
  token: string;
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalCwd(cwd: string): string {
  const absolute = resolve(cwd);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function stateHome(input?: string): string {
  return typeof input === "string" && isAbsolute(input) ? input : homedir();
}

function learningRoot(home?: string): string {
  const hara = join(stateHome(home), ".hara");
  const root = join(hara, "learnings", `v${LEARNING_STORE_VERSION}`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    chmodSync(hara, 0o700);
    chmodSync(join(hara, "learnings"), 0o700);
    chmodSync(root, 0o700);
  } catch {
    // Best effort on filesystems without POSIX modes. O_EXCL + atomic rename remain authoritative.
  }
  return root;
}

function projectStoreKey(cwd: string): string {
  const canonical = canonicalCwd(cwd);
  const label = (basename(canonical) || "root")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "root";
  return `project-${label}-${sha(`project\0${canonical}`).slice(0, 24)}`;
}

function organizationStoreKey(profileId: string): string {
  return `organization-${sha(`organization\0${profileId}`).slice(0, 24)}`;
}

function storeKey(scope: LearningScope, cwd: string, profileId?: string): string {
  if (scope === "personal") return "personal";
  if (scope === "project") return projectStoreKey(cwd);
  if (!profileId || profileId.length > 160) throw new Error("organization learning requires an active organization profile");
  return organizationStoreKey(profileId);
}

function storeFile(root: string, key: string): string {
  if (!/^[a-z0-9._-]{1,100}$/.test(key)) throw new Error("invalid learning store key");
  return join(root, `${key}.json`);
}

function readLock(file: string): LockRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return Number.isInteger(parsed?.pid) && parsed.pid > 0 && typeof parsed?.token === "string" && parsed.token
      ? { pid: parsed.pid, token: parsed.token }
      : null;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === "EPERM";
  }
}

function writeExclusive(file: string, record: LockRecord): void {
  let fd: number | undefined;
  try {
    fd = openSync(file, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(record), "utf8");
    fsyncSync(fd);
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
        fd = undefined;
      } finally {
        rmSync(file, { force: true });
      }
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function withStoreLock<T>(file: string, action: () => T): T {
  const lock = `${file}.lock`;
  const reclaim = `${lock}.reclaim`;
  let claim: LockRecord | undefined;
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    if (existsSync(reclaim)) {
      const stale = readLock(reclaim);
      if (stale && !pidAlive(stale.pid)) {
        const current = readLock(reclaim);
        if (current?.pid === stale.pid && current.token === stale.token && !pidAlive(current.pid)) {
          rmSync(reclaim, { force: true });
          continue;
        }
      }
      sleepSync(LOCK_WAIT_MS);
      continue;
    }
    const candidate = { pid: process.pid, token: randomUUID() };
    try {
      writeExclusive(lock, candidate);
      claim = candidate;
      break;
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
    }
    const held = readLock(lock);
    if (held && !pidAlive(held.pid)) {
      const guard = { pid: process.pid, token: randomUUID() };
      try {
        writeExclusive(reclaim, guard);
        const current = readLock(lock);
        if (current?.pid === held.pid && current.token === held.token && !pidAlive(current.pid)) rmSync(lock, { force: true });
      } catch {
        // Another process won reclamation, or the lock is malformed. Retry without failing open.
      } finally {
        const currentGuard = readLock(reclaim);
        if (currentGuard?.pid === process.pid && currentGuard.token === guard.token) rmSync(reclaim, { force: true });
      }
    }
    sleepSync(LOCK_WAIT_MS);
  }
  if (!claim) throw new Error("learning store is busy; retry the operation");
  try {
    return action();
  } finally {
    const current = readLock(lock);
    if (current?.pid === process.pid && current.token === claim.token) rmSync(lock, { force: true });
  }
}

function atomicWrite(file: string, content: string): void {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, file);
    try {
      chmodSync(file, 0o600);
    } catch {
      /* best effort */
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temp, { force: true });
  }
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

function validEvidence(value: unknown): value is LearningEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<LearningEvidence>;
  return typeof item.id === "string" && item.id.length <= 80
    && typeof item.taskHash === "string" && /^[a-f0-9]{32}$/.test(item.taskHash)
    && typeof item.fingerprint === "string" && /^[a-f0-9]{32}$/.test(item.fingerprint)
    && typeof item.summary === "string" && item.summary.length > 0 && item.summary.length <= MAX_LEARNING_EVIDENCE_CHARS
    && typeof item.source === "string" && LEARNING_SOURCES.has(item.source as LearningSource)
    && typeof item.sourceVersion === "string" && item.sourceVersion.length <= 64
    && validTimestamp(item.observedAt);
}

function validCandidate(value: unknown): value is LearningCandidate {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<LearningCandidate>;
  return item.version === 1
    && typeof item.id === "string" && item.id.length <= 80
    && typeof item.clientId === "string" && item.clientId.length <= 80
    && (item.remoteId === undefined || (typeof item.remoteId === "string" && item.remoteId.length <= 100))
    && typeof item.patternKey === "string" && PATTERN_KEY.test(item.patternKey)
    && typeof item.kind === "string" && LEARNING_KINDS.has(item.kind as LearningKind)
    && typeof item.scope === "string" && LEARNING_SCOPES.has(item.scope as LearningScope)
    && typeof item.summary === "string" && item.summary.length > 0 && item.summary.length <= MAX_LEARNING_SUMMARY_CHARS
    && (item.rationale === undefined || (typeof item.rationale === "string" && item.rationale.length <= MAX_LEARNING_RATIONALE_CHARS))
    && typeof item.status === "string" && LEARNING_STATUSES.has(item.status as LearningStatus)
    && (item.stability === "tentative" || item.stability === "stable")
    && Number.isInteger(item.occurrenceCount) && (item.occurrenceCount ?? 0) > 0
    && Number.isInteger(item.distinctTaskCount) && (item.distinctTaskCount ?? 0) > 0
    && Array.isArray(item.evidence) && item.evidence.length > 0 && item.evidence.length <= MAX_LEARNING_EVIDENCE
    && item.evidence.every(validEvidence)
    && Number.isInteger(item.revision) && (item.revision ?? 0) > 0
    && validTimestamp(item.createdAt) && validTimestamp(item.updatedAt)
    && (item.reviewedAt === undefined || validTimestamp(item.reviewedAt))
    && (item.reviewedBy === undefined || item.reviewedBy === "user" || item.reviewedBy === "organization")
    && (item.reviewNote === undefined || (typeof item.reviewNote === "string" && item.reviewNote.length <= 500))
    && (item.submittedAt === undefined || validTimestamp(item.submittedAt))
    && typeof item.sourceVersion === "string" && item.sourceVersion.length <= 64;
}

function auditHash(event: Omit<LearningAuditEvent, "rowHash">): string {
  return sha(JSON.stringify({
    id: event.id,
    seq: event.seq,
    action: event.action,
    candidateId: event.candidateId,
    actor: event.actor,
    at: event.at,
    payload: event.payload,
    prevHash: event.prevHash,
  }));
}

function validAudit(value: unknown, expectedSeq: number, expectedPrev: string): value is LearningAuditEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as LearningAuditEvent;
  if (event.seq !== expectedSeq || event.prevHash !== expectedPrev || !validTimestamp(event.at)) return false;
  if (!event.id || !event.candidateId || !["capture", "observe", "approve", "reject", "revoke", "submit", "sync"].includes(event.action)) return false;
  if (!["agent", "engine", "user", "organization"].includes(event.actor)) return false;
  if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return false;
  return event.rowHash === auditHash({ ...event, rowHash: undefined } as unknown as Omit<LearningAuditEvent, "rowHash">);
}

function emptyStore(key: string): LearningStoreFile {
  return { version: LEARNING_STORE_VERSION, storeKey: key, candidates: [], audit: [] };
}

function parseStore(raw: string, expectedKey: string): LearningStoreFile {
  const parsed = JSON.parse(raw) as Partial<LearningStoreFile>;
  if (parsed.version !== LEARNING_STORE_VERSION || parsed.storeKey !== expectedKey) throw new Error("learning store identity mismatch");
  if (!Array.isArray(parsed.candidates) || parsed.candidates.length > MAX_LEARNING_RECORDS || !parsed.candidates.every(validCandidate)) {
    throw new Error("learning store contains invalid candidates");
  }
  if (new Set(parsed.candidates.map((item) => item.id)).size !== parsed.candidates.length) throw new Error("learning store contains duplicate candidate IDs");
  if (!Array.isArray(parsed.audit) || parsed.audit.length > MAX_LEARNING_AUDIT) throw new Error("learning store contains invalid audit data");
  let previous = "";
  for (let index = 0; index < parsed.audit.length; index++) {
    if (!validAudit(parsed.audit[index], index + 1, previous)) throw new Error("learning audit chain verification failed");
    previous = parsed.audit[index].rowHash;
  }
  if (parsed.remoteVersion !== undefined && (!Number.isSafeInteger(parsed.remoteVersion) || parsed.remoteVersion < 0)) {
    throw new Error("learning store contains an invalid remote version");
  }
  return parsed as LearningStoreFile;
}

function loadStore(file: string, key: string, strict: boolean): LearningStoreFile {
  if (!existsSync(file)) return emptyStore(key);
  try {
    return parseStore(readFileSync(file, "utf8"), key);
  } catch (error) {
    if (strict) throw error;
    return emptyStore(key);
  }
}

function saveStore(file: string, store: LearningStoreFile): void {
  if (store.candidates.length > MAX_LEARNING_RECORDS || store.audit.length > MAX_LEARNING_AUDIT) {
    throw new Error("learning store capacity exceeded");
  }
  // Parse our own serialization before commit so malformed in-memory state never replaces a valid store.
  const encoded = JSON.stringify(store, null, 2) + "\n";
  parseStore(encoded, store.storeKey);
  atomicWrite(file, encoded);
}

function addAudit(
  store: LearningStoreFile,
  input: Omit<LearningAuditEvent, "id" | "seq" | "prevHash" | "rowHash">,
): void {
  if (store.audit.length >= MAX_LEARNING_AUDIT) throw new Error("learning audit capacity exceeded");
  const previous = store.audit.at(-1);
  const base: Omit<LearningAuditEvent, "rowHash"> = {
    id: randomUUID(),
    seq: (previous?.seq ?? 0) + 1,
    ...input,
    prevHash: previous?.rowHash ?? "",
  };
  store.audit.push({ ...base, rowHash: auditHash(base) });
}

function cleanText(raw: string, cwd: string, max: number, label: string): string {
  const normalized = raw.replace(/\r\n?/g, "\n").trim();
  if (!normalized) throw new Error(`${label} is required`);
  let safe = scrubLocal(normalized, cwd);
  safe = redactSensitiveText(safe).text;
  const scan = scanMemory(safe);
  if (!scan.ok) throw new Error(`${label} contains unsafe instruction or exfiltration text (${scan.hits.join(", ")})`);
  return safe.slice(0, max);
}

function cleanOptionalText(raw: string | undefined, cwd: string, max: number, label: string): string | undefined {
  if (raw === undefined || !raw.trim()) return undefined;
  return cleanText(raw, cwd, max, label);
}

function normalizedPatternKey(raw: string): string {
  const key = raw.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "_").replace(/^[^a-z]+/, "").slice(0, 120);
  if (!PATTERN_KEY.test(key)) throw new Error("pattern_key must be a stable lowercase dotted key (3-120 characters)");
  return key;
}

function recompute(candidate: LearningCandidate, now: Date): void {
  candidate.occurrenceCount = candidate.evidence.length;
  candidate.distinctTaskCount = new Set(candidate.evidence.map((item) => item.taskHash)).size;
  const cutoff = now.getTime() - LEARNING_PROMOTION_WINDOW_DAYS * 86_400_000;
  const recent = candidate.evidence.filter((item) => Date.parse(item.observedAt) >= cutoff);
  const recentTasks = new Set(recent.map((item) => item.taskHash));
  candidate.stability = (
    (candidate.kind === "user_preference" && candidate.evidence.some((item) => item.source === "explicit_user"))
    || (recent.length >= LEARNING_PROMOTION_OCCURRENCES && recentTasks.size >= LEARNING_PROMOTION_DISTINCT_TASKS)
  ) ? "stable" : "tentative";
}

function scopeFile(context: Pick<LearningStoreContext, "cwd" | "stateHome" | "profileId">, scope: LearningScope): { key: string; file: string } {
  const key = storeKey(scope, context.cwd, context.profileId);
  return { key, file: storeFile(learningRoot(context.stateHome), key) };
}

export function captureLearning(
  input: CaptureLearningInput,
  context: LearningStoreContext,
  actor: "agent" | "engine" = "agent",
): { candidate: LearningCandidate; deduplicated: boolean; redacted: boolean } {
  if (!LEARNING_KINDS.has(input.kind)) throw new Error("unsupported learning kind");
  if (!LEARNING_SCOPES.has(input.scope)) throw new Error("unsupported learning scope");
  if (!LEARNING_SOURCES.has(input.source)) throw new Error("unsupported learning source");
  const patternKey = normalizedPatternKey(input.patternKey);
  const summaryResult = redactSensitiveText(scrubLocal(input.summary.replace(/\r\n?/g, "\n").trim(), context.cwd));
  const evidenceResult = redactSensitiveText(scrubLocal(input.evidence.replace(/\r\n?/g, "\n").trim(), context.cwd));
  const rationaleResult = input.rationale === undefined
    ? { text: "", redactions: [] as string[] }
    : redactSensitiveText(scrubLocal(input.rationale.replace(/\r\n?/g, "\n").trim(), context.cwd));
  const summary = cleanText(summaryResult.text, context.cwd, MAX_LEARNING_SUMMARY_CHARS, "summary");
  const evidenceSummary = cleanText(evidenceResult.text, context.cwd, MAX_LEARNING_EVIDENCE_CHARS, "evidence");
  const rationale = cleanOptionalText(rationaleResult.text, context.cwd, MAX_LEARNING_RATIONALE_CHARS, "rationale");
  const now = context.now ?? new Date();
  const at = now.toISOString();
  const taskIdentity = context.taskId || context.sessionId || `manual:${at.slice(0, 10)}`;
  const taskHash = sha(`hara-learning-task-v1\0${taskIdentity}`).slice(0, 32);
  const fingerprint = sha(`hara-learning-evidence-v1\0${patternKey}\0${evidenceSummary}`).slice(0, 32);
  const { key, file } = scopeFile(context, input.scope);
  return withStoreLock(file, () => {
    const store = loadStore(file, key, true);
    let candidate = store.candidates.find((item) => item.patternKey === patternKey && item.kind === input.kind);
    const duplicate = candidate?.evidence.some((item) => item.taskHash === taskHash && item.fingerprint === fingerprint) ?? false;
    if (candidate && duplicate) return {
      candidate: { ...candidate, evidence: candidate.evidence.map((item) => ({ ...item })) },
      deduplicated: true,
      redacted: summaryResult.redactions.length + evidenceResult.redactions.length + rationaleResult.redactions.length > 0,
    };

    const evidence: LearningEvidence = {
      id: randomUUID(),
      taskHash,
      fingerprint,
      summary: evidenceSummary,
      source: input.source,
      sourceVersion: HARA_RUNTIME_VERSION,
      observedAt: at,
    };
    if (!candidate) {
      if (store.candidates.length >= MAX_LEARNING_RECORDS) throw new Error("learning store capacity exceeded");
      const id = randomUUID();
      candidate = {
        version: 1,
        id,
        clientId: id,
        patternKey,
        kind: input.kind,
        scope: input.scope,
        summary,
        ...(rationale ? { rationale } : {}),
        status: "pending",
        stability: "tentative",
        occurrenceCount: 1,
        distinctTaskCount: 1,
        evidence: [evidence],
        revision: 1,
        createdAt: at,
        updatedAt: at,
        sourceVersion: HARA_RUNTIME_VERSION,
      };
      recompute(candidate, now);
      store.candidates.push(candidate);
      addAudit(store, {
        action: "capture",
        candidateId: candidate.id,
        actor,
        at,
        payload: { patternKey, kind: input.kind, scope: input.scope, redacted: summaryResult.redactions.length + evidenceResult.redactions.length + rationaleResult.redactions.length > 0 },
      });
    } else {
      // A changed statement remains reviewable. Never silently rewrite an approved rule in prompt context.
      if (candidate.summary !== summary || candidate.rationale !== rationale) {
        candidate.summary = summary;
        if (rationale) candidate.rationale = rationale;
        else delete candidate.rationale;
        if (candidate.status === "approved" || candidate.status === "rejected" || candidate.status === "revoked") {
          candidate.status = "pending";
          delete candidate.reviewedAt;
          delete candidate.reviewedBy;
          delete candidate.reviewNote;
        }
        candidate.revision += 1;
      }
      candidate.evidence.push(evidence);
      // A submitted organization proposal is an outbox checkpoint, not a terminal state. Any new
      // observation makes it reviewable for an explicit re-submit so Control receives fresh evidence.
      if (candidate.scope === "organization" && candidate.status === "submitted") {
        candidate.status = "pending";
      }
      if (candidate.evidence.length > MAX_LEARNING_EVIDENCE) candidate.evidence.splice(0, candidate.evidence.length - MAX_LEARNING_EVIDENCE);
      candidate.updatedAt = at;
      candidate.sourceVersion = HARA_RUNTIME_VERSION;
      recompute(candidate, now);
      addAudit(store, {
        action: "observe",
        candidateId: candidate.id,
        actor,
        at,
        payload: { occurrenceCount: candidate.occurrenceCount, distinctTaskCount: candidate.distinctTaskCount, stability: candidate.stability },
      });
    }
    saveStore(file, store);
    return {
      candidate: { ...candidate, evidence: candidate.evidence.map((item) => ({ ...item })) },
      deduplicated: false,
      redacted: summaryResult.redactions.length + evidenceResult.redactions.length + rationaleResult.redactions.length > 0,
    };
  });
}

function relevantScopes(options: Pick<LearningListOptions, "scope" | "profileId">): LearningScope[] {
  if (options.scope) return [options.scope];
  return options.profileId ? ["personal", "project", "organization"] : ["personal", "project"];
}

export function listLearnings(options: LearningListOptions): LearningCandidate[] {
  const records: LearningCandidate[] = [];
  for (const scope of relevantScopes(options)) {
    try {
      const { key, file } = scopeFile(options, scope);
      const store = loadStore(file, key, false);
      records.push(...store.candidates.filter((item) => !options.status || item.status === options.status));
    } catch {
      // An invalid/missing organization identity or unreadable store contributes nothing to prompt/UI reads.
    }
  }
  return records
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || left.id.localeCompare(right.id))
    .slice(0, Math.max(1, Math.min(1_000, options.limit ?? 200)))
    .map((item) => ({ ...item, evidence: item.evidence.map((entry) => ({ ...entry })) }));
}

function findCandidateLocation(
  id: string,
  context: Pick<LearningStoreContext, "cwd" | "stateHome" | "profileId">,
): { key: string; file: string; scope: LearningScope } | null {
  for (const scope of relevantScopes(context)) {
    try {
      const { key, file } = scopeFile(context, scope);
      const store = loadStore(file, key, false);
      if (store.candidates.some((item) => item.id === id || item.clientId === id || item.remoteId === id)) return { key, file, scope };
    } catch {
      /* keep searching other visible scopes */
    }
  }
  return null;
}

export function reviewLearning(
  id: string,
  decision: "approve" | "reject" | "revoke",
  context: Pick<LearningStoreContext, "cwd" | "stateHome" | "profileId"> & { expectedRevision?: number; note?: string; now?: Date },
): LearningCandidate {
  const location = findCandidateLocation(id, context);
  if (!location) throw new Error("learning candidate not found");
  if (location.scope === "organization") throw new Error("organization learning must be submitted to and reviewed by Hara Control");
  const now = context.now ?? new Date();
  const at = now.toISOString();
  const note = cleanOptionalText(context.note, context.cwd, 500, "review note");
  return withStoreLock(location.file, () => {
    const store = loadStore(location.file, location.key, true);
    const candidate = store.candidates.find((item) => item.id === id || item.clientId === id);
    if (!candidate) throw new Error("learning candidate changed; refresh and retry");
    if (context.expectedRevision !== undefined && candidate.revision !== context.expectedRevision) {
      throw new Error(`learning candidate revision changed (expected ${context.expectedRevision}, current ${candidate.revision})`);
    }
    if (decision === "revoke" && candidate.status !== "approved") throw new Error("only an approved learning can be revoked");
    if (decision !== "revoke" && candidate.status === "submitted") throw new Error("submitted organization learning is controlled remotely");
    candidate.status = decision === "approve" ? "approved" : decision === "reject" ? "rejected" : "revoked";
    candidate.reviewedAt = at;
    candidate.reviewedBy = "user";
    if (note) candidate.reviewNote = note;
    else delete candidate.reviewNote;
    candidate.updatedAt = at;
    candidate.revision += 1;
    addAudit(store, {
      action: decision,
      candidateId: candidate.id,
      actor: "user",
      at,
      payload: { revision: candidate.revision },
    });
    saveStore(location.file, store);
    return { ...candidate, evidence: candidate.evidence.map((entry) => ({ ...entry })) };
  });
}

export function markLearningSubmitted(
  id: string,
  remoteId: string,
  context: Pick<LearningStoreContext, "cwd" | "stateHome" | "profileId"> & { now?: Date },
): LearningCandidate {
  const location = findCandidateLocation(id, { ...context, profileId: context.profileId });
  if (!location || location.scope !== "organization") throw new Error("organization learning candidate not found");
  const at = (context.now ?? new Date()).toISOString();
  return withStoreLock(location.file, () => {
    const store = loadStore(location.file, location.key, true);
    const candidate = store.candidates.find((item) => item.id === id || item.clientId === id);
    if (!candidate) throw new Error("organization learning candidate changed; refresh and retry");
    candidate.status = "submitted";
    candidate.remoteId = remoteId.slice(0, 100);
    candidate.submittedAt = at;
    candidate.updatedAt = at;
    candidate.revision += 1;
    addAudit(store, { action: "submit", candidateId: candidate.id, actor: "user", at, payload: { revision: candidate.revision } });
    saveStore(location.file, store);
    return { ...candidate, evidence: candidate.evidence.map((entry) => ({ ...entry })) };
  });
}

/** Replace the active organization distribution with one full Control snapshot. Missing previously remote
 * records are revoked locally, so a Control revocation stops prompt injection on the same sync. */
export function applyOrganizationLearningBundle(
  profileId: string,
  version: number,
  items: OrganizationLearningWire[],
  context: Pick<LearningStoreContext, "cwd" | "stateHome"> & { now?: Date },
): LearningCandidate[] {
  if (!Number.isSafeInteger(version) || version < 0) throw new Error("organization learning bundle version is invalid");
  const scoped = { ...context, profileId };
  const { key, file } = scopeFile(scoped, "organization");
  const at = (context.now ?? new Date()).toISOString();
  return withStoreLock(file, () => {
    const store = loadStore(file, key, true);
    if ((store.remoteVersion ?? -1) > version) throw new Error("organization learning bundle is older than the local snapshot");
    const remoteIds = new Set<string>();
    for (const wire of items.slice(0, MAX_LEARNING_RECORDS)) {
      if (!wire || typeof wire !== "object" || typeof wire.id !== "string" || !wire.id || remoteIds.has(wire.id)) throw new Error("organization learning bundle contains invalid IDs");
      if (!LEARNING_KINDS.has(wire.kind)) throw new Error("organization learning bundle contains an invalid kind");
      const patternKey = normalizedPatternKey(wire.pattern_key);
      const summary = cleanText(wire.summary, context.cwd, MAX_LEARNING_SUMMARY_CHARS, "organization learning summary");
      const rationale = cleanOptionalText(wire.rationale, context.cwd, MAX_LEARNING_RATIONALE_CHARS, "organization learning rationale");
      if (!Number.isSafeInteger(wire.revision) || wire.revision < 1 || !validTimestamp(wire.updated_at)) throw new Error("organization learning bundle contains an invalid revision");
      remoteIds.add(wire.id);
      let candidate = store.candidates.find((item) => item.remoteId === wire.id || (wire.client_id && item.clientId === wire.client_id));
      if (!candidate) {
        const id = randomUUID();
        const syntheticTask = sha(`hara-control-learning-v1\0${wire.id}`).slice(0, 32);
        candidate = {
          version: 1,
          id,
          clientId: wire.client_id || id,
          remoteId: wire.id,
          patternKey,
          kind: wire.kind,
          scope: "organization",
          summary,
          ...(rationale ? { rationale } : {}),
          status: "approved",
          stability: "stable",
          occurrenceCount: Math.max(1, Math.min(MAX_LEARNING_EVIDENCE, wire.occurrence_count || 1)),
          distinctTaskCount: Math.max(1, wire.distinct_task_count || 1),
          evidence: [{
            id: randomUUID(),
            taskHash: syntheticTask,
            fingerprint: sha(`hara-control-learning-evidence-v1\0${wire.id}\0${wire.revision}`).slice(0, 32),
            summary: "Approved by the organization learning review workflow.",
            source: "organization",
            sourceVersion: HARA_RUNTIME_VERSION,
            observedAt: wire.updated_at,
          }],
          revision: wire.revision,
          createdAt: wire.updated_at,
          updatedAt: wire.updated_at,
          reviewedAt: wire.updated_at,
          reviewedBy: "organization",
          sourceVersion: HARA_RUNTIME_VERSION,
        };
        store.candidates.push(candidate);
      } else {
        candidate.remoteId = wire.id;
        candidate.patternKey = patternKey;
        candidate.kind = wire.kind;
        candidate.summary = summary;
        if (rationale) candidate.rationale = rationale;
        else delete candidate.rationale;
        candidate.status = "approved";
        candidate.stability = "stable";
        candidate.occurrenceCount = Math.max(candidate.occurrenceCount, wire.occurrence_count || 1);
        candidate.distinctTaskCount = Math.max(candidate.distinctTaskCount, wire.distinct_task_count || 1);
        candidate.revision = wire.revision;
        candidate.updatedAt = wire.updated_at;
        candidate.reviewedAt = wire.updated_at;
        candidate.reviewedBy = "organization";
      }
    }
    for (const candidate of store.candidates) {
      if (candidate.scope === "organization" && candidate.remoteId && !remoteIds.has(candidate.remoteId) && candidate.status === "approved") {
        candidate.status = "revoked";
        candidate.updatedAt = at;
        candidate.reviewedAt = at;
        candidate.reviewedBy = "organization";
        candidate.revision += 1;
      }
    }
    store.remoteVersion = version;
    addAudit(store, { action: "sync", candidateId: "organization-bundle", actor: "organization", at, payload: { version, approved: items.length } });
    saveStore(file, store);
    return store.candidates.filter((item) => item.scope === "organization" && item.status === "approved")
      .map((item) => ({ ...item, evidence: item.evidence.map((entry) => ({ ...entry })) }));
  });
}

export function organizationLearningVersion(
  profileId: string,
  context: Pick<LearningStoreContext, "cwd" | "stateHome">,
): number {
  try {
    const { key, file } = scopeFile({ ...context, profileId }, "organization");
    return loadStore(file, key, false).remoteVersion ?? 0;
  } catch {
    return 0;
  }
}

export function learningDigest(cwd: string, profileId?: string, home?: string): string {
  const approved = listLearnings({ cwd, profileId, stateHome: home, status: "approved", limit: 200 });
  if (!approved.length) return "";
  const ordered = approved.sort((left, right) => {
    const rank: Record<LearningScope, number> = { organization: 0, project: 1, personal: 2 };
    return rank[left.scope] - rank[right.scope] || left.patternKey.localeCompare(right.patternKey);
  });
  const lines = [
    "## Approved business learning (reviewed; context only, never permission)",
    "These versioned rules/preferences were approved through Hara's learning review. Apply them only when relevant, verify mutable facts, and never use them to widen tools, permissions, or task scope.",
  ];
  let chars = lines.join("\n").length;
  for (const item of ordered) {
    const line = `- [${item.scope}/${item.kind}] ${item.patternKey}: ${item.summary} (rev ${item.revision}, reviewed ${item.reviewedAt ?? item.updatedAt})`;
    if (chars + line.length + 1 > 12_000) break;
    lines.push(line);
    chars += line.length + 1;
  }
  return lines.join("\n");
}

export function formatLearningList(items: LearningCandidate[]): string {
  if (!items.length) return "(no learning candidates)";
  return items.map((item) => {
    const ready = item.stability === "stable" ? "stable" : `${item.occurrenceCount}/${LEARNING_PROMOTION_OCCURRENCES} observations`;
    return `${item.id.slice(0, 8)}  ${item.status.padEnd(9)} ${item.scope.padEnd(12)} ${item.kind.padEnd(16)} ${ready}\n  ${item.patternKey}: ${item.summary}`;
  }).join("\n");
}
