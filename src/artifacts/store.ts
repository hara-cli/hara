import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  type Stats,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import {
  openVerifiedRegularFileNoFollow,
  verifyOpenedRegularFileSync,
} from "../fs-read.js";
import { sameOpenedFileIdentity } from "../fs-identity.js";
import { optionalPosixOpenFlag } from "../fs-open-flags.js";
import {
  bindPrivateHaraStateFile,
  ensurePrivateStateSubdirectory,
  PrivateStateConflictError,
  readPrivateStateFileSnapshotSync,
  writePrivateStateBytesOnceSync,
  writePrivateStateFileSync,
  type PrivateStateDirectoryIdentity,
} from "../security/private-state.js";

export const ARTIFACT_PROTOCOL_VERSION = "artifact/1" as const;
export const MAX_ARTIFACT_IMPORT_BYTES = 64 * 1024 * 1024;
const MAX_ARTIFACTS = 10_000;
const MAX_REVISIONS = 10_000;
const JSON_LIMIT = 512 * 1024;
const ARTIFACT_ID = /^art_[a-f0-9]{32}$/;
const REVISION_ID = /^rev_[a-f0-9]{32}$/;
const VALIDATION_ID = /^val_[a-f0-9]{32}$/;
const SAFE_CONTENT_REF = /^content\.[a-z0-9]{1,12}$/;
const STAGING_NAME = /^\.staging-(?:art|rev)_[a-f0-9]{32}-[a-f0-9]{32}$/;
const ARTIFACT_STAGING_MAX_AGE_MS = 6 * 60 * 60 * 1_000;
const INTEGRITY_VALIDATOR_ID = "hara.office.integrity";
const INTEGRITY_VALIDATOR_VERSION = "1.0.0";

export type ArtifactKind = "presentation" | "spreadsheet" | "document";

export interface ArtifactLockRef {
  id: string;
  version: string;
  sha256: string;
}

export interface ArtifactRecord {
  protocol: typeof ARTIFACT_PROTOCOL_VERSION;
  artifactId: string;
  kind: ArtifactKind;
  title: string;
  currentRevisionId: string;
  origin?: string;
  dataResidency?: "local" | "cn" | "global";
  capabilityLock?: ArtifactLockRef;
  templateLock?: ArtifactLockRef;
}

export interface ArtifactRevision {
  revisionId: string;
  artifactId: string;
  parentRevisionId?: string;
  baseRevisionId: string;
  actor: "user" | "agent" | "migration";
  taskRunId?: string;
  contentRef: string;
  assetRefs: string[];
  contentDigest: string;
  changedPaths: string[];
  createdAt: string;
}

export interface ArtifactContentInfo {
  contentRef: string;
  extension: string;
  mediaType: string;
  byteSize: number;
  sha256: string;
}

export interface ArtifactDetails {
  artifact: ArtifactRecord;
  currentRevision: ArtifactRevision;
  content: ArtifactContentInfo;
}

export interface ArtifactSummary {
  artifactId: string;
  kind: ArtifactKind;
  title: string;
  currentRevisionId: string;
  updatedAt: string;
  extension: string;
  mediaType: string;
  byteSize: number;
}

export interface ArtifactListResult {
  artifacts: ArtifactSummary[];
  invalid: number;
  truncated: boolean;
}

export interface ArtifactFinding {
  code: string;
  severity: "error" | "warning" | "info";
  message: string;
  path?: string;
  suggestion?: string;
}

export interface ArtifactValidationReport {
  reportId: string;
  revisionId: string;
  validatorId: string;
  validatorVersion: string;
  createdAt: string;
  snapshotDigest?: string;
  status: "pass" | "revise" | "blocked";
  findings: ArtifactFinding[];
}

export interface ArtifactExportWarning {
  code: string;
  severity: "warning";
  message: string;
  path?: string;
  suggestion?: string;
}

export interface ArtifactExportReceipt {
  receiptId: string;
  artifactId: string;
  revisionId: string;
  createdAt: string;
  format: string;
  fidelity: "visual-fidelity" | "template-editable" | "semantic-editable" | "roundtrip";
  validationReportId: string;
  output: {
    mediaType: string;
    byteSize: number;
    sha256: string;
  };
  warnings: ArtifactExportWarning[];
}

export interface ArtifactExportInput {
  artifactId: string;
  revisionId: string;
  validationReportId: string;
  destinationPath: string;
}

export interface ArtifactPreparedImportInput {
  kind: ArtifactKind;
  title: string;
  extension: string;
  mediaType: string;
  bytes: Uint8Array;
  origin?: string;
  actor?: "user" | "agent" | "migration";
  taskRunId?: string;
}

export interface ArtifactRevisionContent {
  artifact: ArtifactRecord;
  revision: ArtifactRevision;
  content: ArtifactContentInfo;
  bytes: Buffer;
}

export interface ArtifactConvertedExportInput extends ArtifactExportInput {
  format: string;
  mediaType: string;
  fidelity: ArtifactExportReceipt["fidelity"];
  bytes: Uint8Array;
  warnings?: ArtifactExportWarning[];
  validatorId: string;
  validatorVersion: string;
}

export interface ArtifactPreparedValidationInput {
  artifactId: string;
  revisionId: string;
  snapshotDigest: string;
  validatorId: string;
  validatorVersion: string;
  findings: ArtifactFinding[];
}

export interface ArtifactStagingCleanupResult {
  removed: number;
  retained: number;
}

export interface ArtifactCommitInput {
  artifactId: string;
  baseRevisionId: string;
  sourcePath: string;
  actor?: "user" | "agent" | "migration";
  taskRunId?: string;
  changedPaths?: string[];
}

export interface ArtifactPreparedCommitInput {
  artifactId: string;
  baseRevisionId: string;
  extension: string;
  mediaType: string;
  bytes: Uint8Array;
  title?: string;
  actor?: "user" | "agent" | "migration";
  taskRunId?: string;
  changedPaths?: string[];
}

export interface ArtifactRevertInput {
  artifactId: string;
  baseRevisionId: string;
  targetRevisionId: string;
  actor?: "user" | "agent" | "migration";
  taskRunId?: string;
}

export type ArtifactStoreErrorCode =
  | "ARTIFACT_INVALID_INPUT"
  | "ARTIFACT_NOT_FOUND"
  | "ARTIFACT_SOURCE_REJECTED"
  | "ARTIFACT_TOO_LARGE"
  | "ARTIFACT_CONFLICT"
  | "ARTIFACT_CORRUPT"
  | "ARTIFACT_EXPORT_FAILED";

export class ArtifactStoreError extends Error {
  constructor(
    readonly code: ArtifactStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ArtifactStoreError";
  }
}

interface ArtifactFormat {
  kind: ArtifactKind;
  mediaType: string;
}

const FORMATS = new Map<string, ArtifactFormat>([
  [".hpres", { kind: "presentation", mediaType: "application/vnd.nanhara.presentation+json" }],
  [".pptx", { kind: "presentation", mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" }],
  [".ppt", { kind: "presentation", mediaType: "application/vnd.ms-powerpoint" }],
  [".odp", { kind: "presentation", mediaType: "application/vnd.oasis.opendocument.presentation" }],
  [".xlsx", { kind: "spreadsheet", mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }],
  [".xls", { kind: "spreadsheet", mediaType: "application/vnd.ms-excel" }],
  [".csv", { kind: "spreadsheet", mediaType: "text/csv" }],
  [".ods", { kind: "spreadsheet", mediaType: "application/vnd.oasis.opendocument.spreadsheet" }],
  [".docx", { kind: "document", mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }],
  [".doc", { kind: "document", mediaType: "application/msword" }],
  [".md", { kind: "document", mediaType: "text/markdown" }],
  [".txt", { kind: "document", mediaType: "text/plain" }],
  [".rtf", { kind: "document", mediaType: "application/rtf" }],
  [".odt", { kind: "document", mediaType: "application/vnd.oasis.opendocument.text" }],
]);
const MACRO_FORMATS = new Set([".pptm", ".ppsm", ".xlsm", ".xltm", ".docm", ".dotm"]);
const ZIP_FORMATS = new Set([".pptx", ".odp", ".xlsx", ".ods", ".docx", ".odt"]);
const COMPOUND_FORMATS = new Set([".ppt", ".xls", ".doc"]);

const newOpaqueId = (prefix: "art" | "rev"): string =>
  `${prefix}_${randomUUID().replaceAll("-", "")}`;

const storeError = (
  code: ArtifactStoreErrorCode,
  message: string,
  cause?: unknown,
): ArtifactStoreError =>
  new ArtifactStoreError(code, message, cause === undefined ? undefined : { cause });

function verifyDirectory(identity: PrivateStateDirectoryIdentity): void {
  const info = lstatSync(identity.path);
  if (
    !info.isDirectory()
    || info.isSymbolicLink()
    || info.dev !== identity.dev
    || info.ino !== identity.ino
    || realpathSync.native(identity.path) !== identity.path
  ) throw storeError("ARTIFACT_CORRUPT", "private artifact directory identity changed");
}

function artifactRoot(home: string): PrivateStateDirectoryIdentity {
  return ensurePrivateStateSubdirectory(home, [".hara", "artifacts"]);
}

function discardOwnedStaging(
  parent: PrivateStateDirectoryIdentity,
  staging: PrivateStateDirectoryIdentity,
): void {
  verifyDirectory(parent);
  verifyDirectory(staging);
  if (dirname(staging.path) !== parent.path || !STAGING_NAME.test(basename(staging.path))) {
    throw storeError("ARTIFACT_CORRUPT", "refusing to remove an unrecognized Artifact staging directory");
  }
  rmSync(staging.path, { recursive: true, force: false });
  verifyDirectory(parent);
}

function discardOwnedStagingBestEffort(
  parent: PrivateStateDirectoryIdentity,
  staging: PrivateStateDirectoryIdentity,
): void {
  try {
    discardOwnedStaging(parent, staging);
  } catch {
    // Preserve the operation's original failure. A strictly named old directory is retried by stale cleanup.
  }
}

function cleanupStagingChildren(
  parent: PrivateStateDirectoryIdentity,
  cutoffMs: number,
): ArtifactStagingCleanupResult {
  verifyDirectory(parent);
  let removed = 0;
  let retained = 0;
  for (const entry of readdirSync(parent.path, { withFileTypes: true })) {
    if (!entry.name.startsWith(".staging-")) continue;
    if (!entry.isDirectory() || !STAGING_NAME.test(entry.name)) {
      retained += 1;
      continue;
    }
    const path = join(parent.path, entry.name);
    const info = lstatSync(path);
    if (
      !info.isDirectory()
      || info.isSymbolicLink()
      || realpathSync.native(path) !== path
      || Math.max(info.mtimeMs, info.ctimeMs) > cutoffMs
    ) {
      retained += 1;
      continue;
    }
    const staging = { path, dev: info.dev, ino: info.ino } satisfies PrivateStateDirectoryIdentity;
    discardOwnedStaging(parent, staging);
    removed += 1;
  }
  verifyDirectory(parent);
  return { removed, retained };
}

/** Remove only old, strictly named private staging directories left by a crashed Artifact operation. */
export function cleanupArtifactStaging(
  home: string,
  nowMs = Date.now(),
): ArtifactStagingCleanupResult {
  if (!Number.isFinite(nowMs) || nowMs < ARTIFACT_STAGING_MAX_AGE_MS) {
    throw storeError("ARTIFACT_INVALID_INPUT", "cleanup clock is invalid");
  }
  const root = artifactRoot(home);
  const cutoffMs = nowMs - ARTIFACT_STAGING_MAX_AGE_MS;
  const result = cleanupStagingChildren(root, cutoffMs);
  for (const entry of readdirSync(root.path, { withFileTypes: true })) {
    if (!entry.isDirectory() || !ARTIFACT_ID.test(entry.name)) continue;
    const artifact = childDirectory(root, entry.name, `no artifact ${entry.name}`);
    const nested = cleanupStagingChildren(artifact, cutoffMs);
    result.removed += nested.removed;
    result.retained += nested.retained;
  }
  verifyDirectory(root);
  return result;
}

function parseJsonFile(path: string): unknown {
  const snapshot = readPrivateStateFileSnapshotSync(path, JSON_LIMIT);
  if (!snapshot) throw storeError("ARTIFACT_CORRUPT", "artifact metadata is missing");
  try {
    return JSON.parse(snapshot.text);
  } catch (error) {
    throw storeError("ARTIFACT_CORRUPT", "artifact metadata is not valid JSON", error);
  }
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[]): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function isArtifactLockRef(value: unknown): value is ArtifactLockRef {
  if (!plainRecord(value) || !exactKeys(value, ["id", "version", "sha256"], [])) return false;
  return typeof value.id === "string"
    && value.id.length >= 1
    && value.id.length <= 256
    && typeof value.version === "string"
    && value.version.length >= 1
    && value.version.length <= 128
    && typeof value.sha256 === "string"
    && /^[a-f0-9]{64}$/.test(value.sha256);
}

function isArtifactRecord(value: unknown): value is ArtifactRecord {
  if (!plainRecord(value) || !exactKeys(
    value,
    ["protocol", "artifactId", "kind", "title", "currentRevisionId"],
    ["origin", "dataResidency", "capabilityLock", "templateLock"],
  )) return false;
  return value.protocol === ARTIFACT_PROTOCOL_VERSION
    && typeof value.artifactId === "string"
    && ARTIFACT_ID.test(value.artifactId)
    && (value.kind === "presentation" || value.kind === "spreadsheet" || value.kind === "document")
    && typeof value.title === "string"
    && value.title.length >= 1
    && value.title.length <= 1_024
    && typeof value.currentRevisionId === "string"
    && REVISION_ID.test(value.currentRevisionId)
    && (value.origin === undefined || (typeof value.origin === "string" && value.origin.length <= 256))
    && (
      value.dataResidency === undefined
      || value.dataResidency === "local"
      || value.dataResidency === "cn"
      || value.dataResidency === "global"
    )
    && (value.capabilityLock === undefined || isArtifactLockRef(value.capabilityLock))
    && (value.templateLock === undefined || isArtifactLockRef(value.templateLock));
}

function isRevision(value: unknown): value is ArtifactRevision {
  if (!plainRecord(value) || !exactKeys(
    value,
    [
      "revisionId",
      "artifactId",
      "baseRevisionId",
      "actor",
      "contentRef",
      "assetRefs",
      "contentDigest",
      "changedPaths",
      "createdAt",
    ],
    ["parentRevisionId", "taskRunId"],
  )) return false;
  return typeof value.revisionId === "string"
    && REVISION_ID.test(value.revisionId)
    && typeof value.artifactId === "string"
    && ARTIFACT_ID.test(value.artifactId)
    && typeof value.baseRevisionId === "string"
    && REVISION_ID.test(value.baseRevisionId)
    && (
      value.parentRevisionId === undefined
      || (typeof value.parentRevisionId === "string" && REVISION_ID.test(value.parentRevisionId))
    )
    && (value.actor === "user" || value.actor === "agent" || value.actor === "migration")
    && (value.taskRunId === undefined || (typeof value.taskRunId === "string" && value.taskRunId.length > 0))
    && typeof value.contentRef === "string"
    && SAFE_CONTENT_REF.test(value.contentRef)
    && Array.isArray(value.assetRefs)
    && value.assetRefs.length <= 10_000
    && value.assetRefs.every((entry) => typeof entry === "string" && entry.length > 0)
    && typeof value.contentDigest === "string"
    && /^[a-f0-9]{64}$/.test(value.contentDigest)
    && Array.isArray(value.changedPaths)
    && value.changedPaths.length <= 10_000
    && value.changedPaths.every((entry) => typeof entry === "string" && entry.length > 0)
    && typeof value.createdAt === "string"
    && Number.isFinite(Date.parse(value.createdAt));
}

function isContentInfo(value: unknown): value is ArtifactContentInfo {
  if (!plainRecord(value) || !exactKeys(
    value,
    ["contentRef", "extension", "mediaType", "byteSize", "sha256"],
    [],
  )) return false;
  return typeof value.contentRef === "string"
    && SAFE_CONTENT_REF.test(value.contentRef)
    && typeof value.extension === "string"
    && /^\.[a-z0-9]{1,12}$/.test(value.extension)
    && value.contentRef === `content${value.extension}`
    && typeof value.mediaType === "string"
    && value.mediaType.length > 0
    && typeof value.byteSize === "number"
    && Number.isSafeInteger(value.byteSize)
    && value.byteSize >= 0
    && value.byteSize <= MAX_ARTIFACT_IMPORT_BYTES
    && typeof value.sha256 === "string"
    && /^[a-f0-9]{64}$/.test(value.sha256);
}

function isArtifactFinding(value: unknown): value is ArtifactFinding {
  if (!plainRecord(value) || !exactKeys(value, ["code", "severity", "message"], ["path", "suggestion"])) {
    return false;
  }
  return typeof value.code === "string"
    && /^[A-Z][A-Z0-9_]{2,63}$/.test(value.code)
    && (value.severity === "error" || value.severity === "warning" || value.severity === "info")
    && typeof value.message === "string"
    && value.message.length >= 1
    && value.message.length <= 4_096
    && (value.path === undefined || (
      typeof value.path === "string"
      && value.path.length >= 1
      && value.path.length <= 1_024
      && isSafeArtifactPath(value.path)
    ))
    && (value.suggestion === undefined || (
      typeof value.suggestion === "string"
      && value.suggestion.length >= 1
      && value.suggestion.length <= 4_096
    ));
}

function isSafeArtifactPath(value: string): boolean {
  try {
    return normalizeArtifactPath(value) === value;
  } catch {
    return false;
  }
}

function isValidationReport(value: unknown): value is ArtifactValidationReport {
  if (!plainRecord(value) || !exactKeys(
    value,
    ["reportId", "revisionId", "validatorId", "validatorVersion", "createdAt", "status", "findings"],
    ["snapshotDigest"],
  )) return false;
  return typeof value.reportId === "string"
    && VALIDATION_ID.test(value.reportId)
    && typeof value.revisionId === "string"
    && REVISION_ID.test(value.revisionId)
    && typeof value.validatorId === "string"
    && value.validatorId.length >= 1
    && value.validatorId.length <= 256
    && typeof value.validatorVersion === "string"
    && value.validatorVersion.length >= 1
    && value.validatorVersion.length <= 128
    && typeof value.createdAt === "string"
    && Number.isFinite(Date.parse(value.createdAt))
    && (value.snapshotDigest === undefined || (
      typeof value.snapshotDigest === "string" && /^[a-f0-9]{64}$/.test(value.snapshotDigest)
    ))
    && (value.status === "pass" || value.status === "revise" || value.status === "blocked")
    && Array.isArray(value.findings)
    && value.findings.length <= 10_000
    && value.findings.every(isArtifactFinding);
}

function checkedArtifactId(value: string): string {
  if (!ARTIFACT_ID.test(value)) {
    throw storeError("ARTIFACT_INVALID_INPUT", "artifactId is not a valid opaque Artifact id");
  }
  return value;
}

function checkedRevisionId(value: string): string {
  if (!REVISION_ID.test(value)) {
    throw storeError("ARTIFACT_CORRUPT", "revision id is invalid");
  }
  return value;
}

function checkedInputRevisionId(value: unknown, field: string): string {
  if (typeof value !== "string" || !REVISION_ID.test(value)) {
    throw storeError("ARTIFACT_INVALID_INPUT", `${field} is not a valid opaque Revision id`);
  }
  return value;
}

function checkedValidationId(value: unknown): string {
  if (typeof value !== "string" || !VALIDATION_ID.test(value)) {
    throw storeError("ARTIFACT_INVALID_INPUT", "validationReportId is not a valid opaque ValidationReport id");
  }
  return value;
}

function checkedActor(value: unknown): ArtifactRevision["actor"] {
  if (value === undefined) return "user";
  if (value !== "user" && value !== "agent" && value !== "migration") {
    throw storeError("ARTIFACT_INVALID_INPUT", "actor must be user, agent, or migration");
  }
  return value;
}

function checkedTaskRunId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 256
    || /[\u0000-\u001f\u007f]/.test(value)
  ) throw storeError("ARTIFACT_INVALID_INPUT", "taskRunId must be a safe string of at most 256 characters");
  return value;
}

function normalizeArtifactPath(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 1_024 || value.includes("\0")) {
    throw storeError("ARTIFACT_INVALID_INPUT", "changedPaths entries must be non-empty relative paths");
  }
  if (value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:/.test(value) || value.includes("\\")) {
    throw storeError("ARTIFACT_INVALID_INPUT", "changedPaths entries must use relative forward-slash paths");
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw storeError("ARTIFACT_INVALID_INPUT", "changedPaths contains an unsafe path segment");
  }
  return segments.join("/");
}

function checkedChangedPaths(value: unknown): string[] {
  if (value === undefined) return ["content"];
  if (!Array.isArray(value) || value.length < 1 || value.length > 10_000) {
    throw storeError("ARTIFACT_INVALID_INPUT", "changedPaths must contain 1 to 10000 relative paths");
  }
  return [...new Set(value.map(normalizeArtifactPath))];
}

function childDirectory(
  parent: PrivateStateDirectoryIdentity,
  name: string,
  notFoundMessage: string,
): PrivateStateDirectoryIdentity {
  verifyDirectory(parent);
  const path = join(parent.path, name);
  let info: Stats;
  try {
    info = lstatSync(path);
  } catch (error: any) {
    if (error?.code === "ENOENT") throw storeError("ARTIFACT_NOT_FOUND", notFoundMessage);
    throw error;
  }
  if (
    !info.isDirectory()
    || info.isSymbolicLink()
    || realpathSync.native(path) !== path
  ) throw storeError("ARTIFACT_CORRUPT", "artifact directory is not a canonical private directory");
  verifyDirectory(parent);
  return { path, dev: info.dev, ino: info.ino };
}

function artifactDirectory(home: string, artifactId: string): PrivateStateDirectoryIdentity {
  return childDirectory(artifactRoot(home), checkedArtifactId(artifactId), `no artifact ${artifactId}`);
}

function readArtifactMetadata(
  directory: PrivateStateDirectoryIdentity,
): { artifact: ArtifactRecord; text: string } {
  verifyDirectory(directory);
  const snapshot = readPrivateStateFileSnapshotSync(join(directory.path, "metadata.json"), JSON_LIMIT);
  if (!snapshot) throw storeError("ARTIFACT_CORRUPT", "artifact metadata is missing");
  let value: unknown;
  try {
    value = JSON.parse(snapshot.text);
  } catch (error) {
    throw storeError("ARTIFACT_CORRUPT", "artifact metadata is not valid JSON", error);
  }
  if (!isArtifactRecord(value) || value.artifactId !== basename(directory.path)) {
    throw storeError("ARTIFACT_CORRUPT", "artifact metadata does not match its directory");
  }
  verifyDirectory(directory);
  return { artifact: value, text: snapshot.text };
}

function revisionDirectory(
  artifact: PrivateStateDirectoryIdentity,
  revisionId: string,
): PrivateStateDirectoryIdentity {
  const revisions = childDirectory(artifact, "revisions", "artifact revisions are missing");
  return childDirectory(revisions, checkedRevisionId(revisionId), `no revision ${revisionId}`);
}

function inspectContent(
  revision: PrivateStateDirectoryIdentity,
  content: ArtifactContentInfo,
  verifyDigest: boolean,
): void {
  verifyDirectory(revision);
  const path = join(revision.path, content.contentRef);
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw storeError("ARTIFACT_CORRUPT", "artifact content is not an immutable regular file");
  }
  const fd = openSync(
    path,
    constants.O_RDONLY | optionalPosixOpenFlag("O_NONBLOCK") | optionalPosixOpenFlag("O_NOFOLLOW"),
  );
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isFile()
      || opened.nlink !== 1
      || !sameOpenedFileIdentity(before, opened)
      || opened.size !== content.byteSize
      || (process.platform !== "win32" && (opened.mode & 0o777) !== 0o600)
    ) throw storeError("ARTIFACT_CORRUPT", "artifact content identity or size does not match its receipt");
    if (verifyDigest) {
      const hash = createHash("sha256");
      const chunk = Buffer.allocUnsafe(64 * 1024);
      let position = 0;
      for (;;) {
        const read = readSync(fd, chunk, 0, chunk.length, position);
        if (!read) break;
        hash.update(chunk.subarray(0, read));
        position += read;
      }
      if (hash.digest("hex") !== content.sha256) {
        throw storeError("ARTIFACT_CORRUPT", "artifact content digest does not match its receipt");
      }
    }
    const after = fstatSync(fd);
    const linked = lstatSync(path);
    if (
      !sameOpenedFileIdentity(opened, after)
      || opened.size !== after.size
      || opened.mtimeMs !== after.mtimeMs
      || opened.ctimeMs !== after.ctimeMs
      || !sameOpenedFileIdentity(after, linked)
    ) throw storeError("ARTIFACT_CORRUPT", "artifact content changed while it was inspected");
  } finally {
    closeSync(fd);
  }
  verifyDirectory(revision);
}

function readContentBytes(
  revision: PrivateStateDirectoryIdentity,
  content: ArtifactContentInfo,
): Buffer {
  verifyDirectory(revision);
  const path = join(revision.path, content.contentRef);
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw storeError("ARTIFACT_CORRUPT", "artifact content is not an immutable regular file");
  }
  const fd = openSync(
    path,
    constants.O_RDONLY | optionalPosixOpenFlag("O_NONBLOCK") | optionalPosixOpenFlag("O_NOFOLLOW"),
  );
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isFile()
      || opened.nlink !== 1
      || !sameOpenedFileIdentity(before, opened)
      || opened.size !== content.byteSize
      || (process.platform !== "win32" && (opened.mode & 0o777) !== 0o600)
    ) throw storeError("ARTIFACT_CORRUPT", "artifact content identity or size does not match its receipt");
    const bytes = Buffer.allocUnsafe(content.byteSize);
    let position = 0;
    while (position < bytes.length) {
      const read = readSync(fd, bytes, position, bytes.length - position, position);
      if (!read) throw storeError("ARTIFACT_CORRUPT", "artifact content ended before its recorded size");
      position += read;
    }
    if (createHash("sha256").update(bytes).digest("hex") !== content.sha256) {
      throw storeError("ARTIFACT_CORRUPT", "artifact content digest does not match its receipt");
    }
    const after = fstatSync(fd);
    const linked = lstatSync(path);
    if (
      !sameOpenedFileIdentity(opened, after)
      || opened.size !== after.size
      || opened.mtimeMs !== after.mtimeMs
      || opened.ctimeMs !== after.ctimeMs
      || !sameOpenedFileIdentity(after, linked)
    ) throw storeError("ARTIFACT_CORRUPT", "artifact content changed while it was read");
    verifyDirectory(revision);
    return bytes;
  } finally {
    closeSync(fd);
  }
}

function readRevisionDetails(
  artifact: PrivateStateDirectoryIdentity,
  revisionId: string,
  verifyDigest: boolean,
): { revision: ArtifactRevision; content: ArtifactContentInfo } {
  const revisionDir = revisionDirectory(artifact, revisionId);
  const revisionValue = parseJsonFile(join(revisionDir.path, "revision.json"));
  const contentValue = parseJsonFile(join(revisionDir.path, "content.json"));
  if (
    !isRevision(revisionValue)
    || revisionValue.revisionId !== revisionId
    || revisionValue.artifactId !== basename(artifact.path)
  ) throw storeError("ARTIFACT_CORRUPT", "revision metadata does not match its Artifact");
  if (
    !isContentInfo(contentValue)
    || contentValue.contentRef !== revisionValue.contentRef
    || contentValue.sha256 !== revisionValue.contentDigest
  ) throw storeError("ARTIFACT_CORRUPT", "revision content receipt is inconsistent");
  inspectContent(revisionDir, contentValue, verifyDigest);
  return { revision: revisionValue, content: contentValue };
}

function readArtifactDetailsFromDirectory(
  directory: PrivateStateDirectoryIdentity,
  verifyDigest: boolean,
): ArtifactDetails {
  const { artifact: artifactValue } = readArtifactMetadata(directory);
  const currentRevisionId = checkedRevisionId(artifactValue.currentRevisionId);
  const { revision: revisionValue, content: contentValue } = readRevisionDetails(
    directory,
    currentRevisionId,
    verifyDigest,
  );
  verifyDirectory(directory);
  return { artifact: artifactValue, currentRevision: revisionValue, content: contentValue };
}

function titleFor(sourcePath: string, extension: string, requested: string | undefined, kind: ArtifactKind): string {
  const raw = requested ?? basename(sourcePath, extension);
  const cleaned = raw
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const title = cleaned || `Untitled ${kind}`;
  if (title.length > 1_024) {
    throw storeError("ARTIFACT_INVALID_INPUT", "artifact title must be at most 1024 characters");
  }
  return title;
}

function sourceFormat(
  sourcePathInput: unknown,
  claimedKind?: ArtifactKind,
): { sourcePath: string; extension: string; format: ArtifactFormat } {
  if (
    typeof sourcePathInput !== "string"
    || !sourcePathInput
    || sourcePathInput.length > 4_096
  ) {
    throw storeError("ARTIFACT_INVALID_INPUT", "sourcePath must be a non-empty path of at most 4096 characters");
  }
  if (!isAbsolute(sourcePathInput)) {
    throw storeError("ARTIFACT_INVALID_INPUT", "sourcePath must be an absolute path selected by the user");
  }
  const sourcePath = resolve(sourcePathInput);
  const extension = extname(sourcePath).toLowerCase();
  if (MACRO_FORMATS.has(extension)) {
    throw storeError(
      "ARTIFACT_SOURCE_REJECTED",
      "macro-enabled Office files are not supported; save a macro-free copy before using it as an Artifact revision",
    );
  }
  const format = FORMATS.get(extension);
  if (!format) {
    throw storeError(
      "ARTIFACT_INVALID_INPUT",
      "supported files are PPT/PPTX/ODP, XLS/XLSX/CSV/ODS, DOC/DOCX/ODT/RTF, Markdown, and text",
    );
  }
  if (claimedKind !== undefined && claimedKind !== format.kind) {
    throw storeError("ARTIFACT_INVALID_INPUT", `the selected file is ${format.kind}, not ${claimedKind}`);
  }
  return { sourcePath, extension, format };
}

async function readImportSource(sourcePath: string): Promise<Buffer> {
  let verified;
  try {
    verified = await openVerifiedRegularFileNoFollow(sourcePath, {
      action: "import as an Artifact",
      rejectHardLinks: true,
      protectSensitive: true,
    });
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      throw storeError("ARTIFACT_SOURCE_REJECTED", "the selected source file no longer exists", error);
    }
    if (error?.code === "HARA_PROTECTED_CONTEXT_FILE") {
      throw storeError("ARTIFACT_SOURCE_REJECTED", "protected credential/configuration files cannot be imported", error);
    }
    if (error?.code === "HARA_HARD_LINKED_FILE") {
      throw storeError("ARTIFACT_SOURCE_REJECTED", "hard-linked source files cannot be imported safely", error);
    }
    if (error?.code === "HARA_NOT_REGULAR_FILE" || error?.code === "ELOOP") {
      throw storeError("ARTIFACT_SOURCE_REJECTED", "the selected source must be a regular file, not a link or device", error);
    }
    throw error;
  }
  try {
    const { handle, info } = verified;
    if (info.size > MAX_ARTIFACT_IMPORT_BYTES) {
      throw storeError(
        "ARTIFACT_TOO_LARGE",
        `the selected file exceeds the ${MAX_ARTIFACT_IMPORT_BYTES / (1024 * 1024)} MiB import limit`,
      );
    }
    if (info.size === 0) {
      throw storeError("ARTIFACT_INVALID_INPUT", "an empty file cannot be imported as an Artifact");
    }
    const bytes = Buffer.allocUnsafe(info.size);
    let position = 0;
    while (position < bytes.length) {
      const { bytesRead } = await handle.read(bytes, position, bytes.length - position, position);
      if (!bytesRead) {
        throw storeError("ARTIFACT_SOURCE_REJECTED", "the selected file changed while it was being imported");
      }
      position += bytesRead;
    }
    const after = await handle.stat();
    verifyOpenedRegularFileSync(sourcePath, after, {
      action: "import as an Artifact",
      rejectHardLinks: true,
      protectSensitive: true,
    });
    if (
      after.dev !== info.dev
      || after.ino !== info.ino
      || after.size !== info.size
      || after.mtimeMs !== info.mtimeMs
      || after.ctimeMs !== info.ctimeMs
    ) throw storeError("ARTIFACT_SOURCE_REJECTED", "the selected file changed while it was being imported");
    return bytes;
  } finally {
    await verified.handle.close().catch(() => {});
  }
}

export async function readArtifactSourceBytes(
  sourcePathInput: unknown,
  allowedExtensions: readonly string[],
): Promise<{ sourcePath: string; extension: string; bytes: Buffer }> {
  if (
    typeof sourcePathInput !== "string"
    || !sourcePathInput
    || sourcePathInput.length > 4_096
    || !isAbsolute(sourcePathInput)
  ) {
    throw storeError(
      "ARTIFACT_INVALID_INPUT",
      "sourcePath must be an absolute path selected by the user",
    );
  }
  const allowed = new Set(allowedExtensions.map((value) => value.toLowerCase()));
  if (
    allowed.size < 1
    || [...allowed].some((value) => !/^\.[a-z0-9]{1,12}$/.test(value))
  ) throw storeError("ARTIFACT_INVALID_INPUT", "allowed source extensions are invalid");
  const sourcePath = resolve(sourcePathInput);
  const extension = extname(sourcePath).toLowerCase();
  if (!allowed.has(extension)) {
    throw storeError(
      "ARTIFACT_INVALID_INPUT",
      `selected source must use one of: ${[...allowed].join(", ")}`,
    );
  }
  const bytes = await readImportSource(sourcePath);
  return { sourcePath, extension, bytes };
}

function verifyClaimedFormat(extension: string, bytes: Buffer): void {
  const startsWith = (signature: readonly number[]): boolean =>
    bytes.length >= signature.length
    && signature.every((value, index) => bytes[index] === value);
  if (ZIP_FORMATS.has(extension) && !startsWith([0x50, 0x4b, 0x03, 0x04])) {
    throw storeError(
      "ARTIFACT_SOURCE_REJECTED",
      "the selected Office file does not match its extension; save an unencrypted, macro-free copy and try again",
    );
  }
  if (
    COMPOUND_FORMATS.has(extension)
    && !startsWith([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
  ) {
    throw storeError(
      "ARTIFACT_SOURCE_REJECTED",
      "the selected legacy Office file does not match its extension",
    );
  }
  if (
    extension === ".rtf"
    && !bytes.subarray(0, Math.min(bytes.length, 32)).toString("utf8").replace(/^\uFEFF/, "").startsWith("{\\rtf")
  ) {
    throw storeError("ARTIFACT_SOURCE_REJECTED", "the selected RTF file does not match its extension");
  }
}

function syncDirectory(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY
        | optionalPosixOpenFlag("O_NONBLOCK")
        | optionalPosixOpenFlag("O_NOFOLLOW")
        | optionalPosixOpenFlag("O_DIRECTORY"),
    );
    fsyncSync(fd);
  } catch {
    /* Directory fsync is not portable; every staged file is still fsync'd before activation. */
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function activateStaging(
  root: PrivateStateDirectoryIdentity,
  staging: PrivateStateDirectoryIdentity,
  artifactId: string,
): void {
  verifyDirectory(root);
  verifyDirectory(staging);
  const destination = join(root.path, artifactId);
  try {
    lstatSync(destination);
    throw storeError("ARTIFACT_CORRUPT", "an Artifact id collision occurred; retry the import");
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  renameSync(staging.path, destination);
  const activated = lstatSync(destination);
  if (
    !activated.isDirectory()
    || activated.isSymbolicLink()
    || activated.dev !== staging.dev
    || activated.ino !== staging.ino
    || realpathSync.native(destination) !== destination
  ) throw storeError("ARTIFACT_CORRUPT", "Artifact activation changed the staged directory identity");
  verifyDirectory(root);
  syncDirectory(root.path);
}

export function importArtifactBytes(
  home: string,
  input: ArtifactPreparedImportInput,
): ArtifactDetails {
  if (input.kind !== "presentation" && input.kind !== "spreadsheet" && input.kind !== "document") {
    throw storeError("ARTIFACT_INVALID_INPUT", "kind must be presentation, spreadsheet, or document");
  }
  if (typeof input.title !== "string") {
    throw storeError("ARTIFACT_INVALID_INPUT", "title must be a string");
  }
  if (typeof input.extension !== "string" || !/^\.[a-z0-9]{1,12}$/.test(input.extension)) {
    throw storeError("ARTIFACT_INVALID_INPUT", "prepared Artifact extension is invalid");
  }
  const format = FORMATS.get(input.extension);
  if (!format || format.kind !== input.kind || format.mediaType !== input.mediaType) {
    throw storeError("ARTIFACT_INVALID_INPUT", "prepared Artifact format does not match its kind and media type");
  }
  if (!(input.bytes instanceof Uint8Array)) {
    throw storeError("ARTIFACT_INVALID_INPUT", "prepared Artifact bytes must be a Uint8Array");
  }
  const bytes = Buffer.from(input.bytes);
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_ARTIFACT_IMPORT_BYTES) {
    throw storeError(
      bytes.byteLength > MAX_ARTIFACT_IMPORT_BYTES ? "ARTIFACT_TOO_LARGE" : "ARTIFACT_INVALID_INPUT",
      `prepared Artifact content must contain 1 to ${MAX_ARTIFACT_IMPORT_BYTES / (1024 * 1024)} MiB`,
    );
  }
  const origin = input.origin ?? "generated";
  if (typeof origin !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(origin)) {
    throw storeError("ARTIFACT_INVALID_INPUT", "prepared Artifact origin is invalid");
  }
  const actor = checkedActor(input.actor);
  const taskRunId = checkedTaskRunId(input.taskRunId);
  const title = titleFor(`Untitled${input.extension}`, input.extension, input.title, input.kind);
  cleanupArtifactStaging(home);
  verifyClaimedFormat(input.extension, bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const artifactId = newOpaqueId("art");
  const revisionId = newOpaqueId("rev");
  const now = new Date().toISOString();
  const contentRef = `content${input.extension}`;
  const artifact: ArtifactRecord = {
    protocol: ARTIFACT_PROTOCOL_VERSION,
    artifactId,
    kind: input.kind,
    title,
    currentRevisionId: revisionId,
    origin,
    dataResidency: "local",
  };
  const revision: ArtifactRevision = {
    revisionId,
    artifactId,
    baseRevisionId: revisionId,
    actor,
    ...(taskRunId ? { taskRunId } : {}),
    contentRef,
    assetRefs: [],
    contentDigest: sha256,
    changedPaths: ["content"],
    createdAt: now,
  };
  const content: ArtifactContentInfo = {
    contentRef,
    extension: input.extension,
    mediaType: input.mediaType,
    byteSize: bytes.byteLength,
    sha256,
  };

  const root = artifactRoot(home);
  const stagingName = `.staging-${artifactId}-${randomUUID().replaceAll("-", "")}`;
  const staging = ensurePrivateStateSubdirectory(home, [".hara", "artifacts", stagingName]);
  let activated = false;
  try {
    ensurePrivateStateSubdirectory(home, [".hara", "artifacts", stagingName, "revisions", revisionId]);
    writePrivateStateBytesOnceSync(
      bindPrivateHaraStateFile(home, ["artifacts", stagingName, "revisions", revisionId], contentRef),
      bytes,
    );
    writePrivateStateFileSync(
      bindPrivateHaraStateFile(home, ["artifacts", stagingName, "revisions", revisionId], "content.json"),
      `${JSON.stringify(content, null, 2)}\n`,
    );
    writePrivateStateFileSync(
      bindPrivateHaraStateFile(home, ["artifacts", stagingName, "revisions", revisionId], "revision.json"),
      `${JSON.stringify(revision, null, 2)}\n`,
    );
    writePrivateStateFileSync(
      bindPrivateHaraStateFile(home, ["artifacts", stagingName], "metadata.json"),
      `${JSON.stringify(artifact, null, 2)}\n`,
    );
    activateStaging(root, staging, artifactId);
    activated = true;
  } finally {
    if (!activated) discardOwnedStagingBestEffort(root, staging);
  }
  return getArtifact(home, artifactId, false);
}

export async function importArtifact(
  home: string,
  input: { sourcePath: string; title?: string; kind?: ArtifactKind },
): Promise<ArtifactDetails> {
  if (
    input.kind !== undefined
    && input.kind !== "presentation"
    && input.kind !== "spreadsheet"
    && input.kind !== "document"
  ) throw storeError("ARTIFACT_INVALID_INPUT", "kind must be presentation, spreadsheet, or document");
  if (input.title !== undefined && typeof input.title !== "string") {
    throw storeError("ARTIFACT_INVALID_INPUT", "title must be a string");
  }
  const { sourcePath, extension, format } = sourceFormat(input.sourcePath, input.kind);
  const bytes = await readImportSource(sourcePath);
  verifyClaimedFormat(extension, bytes);
  return importArtifactBytes(home, {
    kind: format.kind,
    title: titleFor(sourcePath, extension, input.title, format.kind),
    extension,
    mediaType: format.mediaType,
    bytes,
    origin: "local-import",
    actor: "user",
  });
}

function activateRevisionStaging(
  artifact: PrivateStateDirectoryIdentity,
  staging: PrivateStateDirectoryIdentity,
  revisionId: string,
): void {
  const revisions = childDirectory(artifact, "revisions", "artifact revisions are missing");
  verifyDirectory(staging);
  const destination = join(revisions.path, revisionId);
  try {
    lstatSync(destination);
    throw storeError("ARTIFACT_CORRUPT", "a Revision id collision occurred; retry the commit");
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  renameSync(staging.path, destination);
  const activated = lstatSync(destination);
  if (
    !activated.isDirectory()
    || activated.isSymbolicLink()
    || activated.dev !== staging.dev
    || activated.ino !== staging.ino
    || realpathSync.native(destination) !== destination
  ) throw storeError("ARTIFACT_CORRUPT", "Revision activation changed the staged directory identity");
  verifyDirectory(revisions);
  syncDirectory(revisions.path);
}

function commitPreparedRevision(
  home: string,
  input: {
    artifactId: string;
    baseRevisionId: string;
    extension: string;
    mediaType: string;
    bytes: Buffer;
    actor: ArtifactRevision["actor"];
    taskRunId?: string;
    changedPaths: string[];
    title?: string;
  },
): ArtifactDetails {
  const artifact = artifactDirectory(home, input.artifactId);
  const metadata = readArtifactMetadata(artifact);
  if (metadata.artifact.currentRevisionId !== input.baseRevisionId) {
    throw storeError(
      "ARTIFACT_CONFLICT",
      "the Artifact changed after this edit started; reopen the latest version and apply the change again",
    );
  }
  readRevisionDetails(artifact, metadata.artifact.currentRevisionId, true);
  const format = FORMATS.get(input.extension);
  if (!format || format.kind !== metadata.artifact.kind || format.mediaType !== input.mediaType) {
    throw storeError("ARTIFACT_INVALID_INPUT", "the committed file kind does not match the Artifact");
  }
  if (input.bytes.byteLength < 1 || input.bytes.byteLength > MAX_ARTIFACT_IMPORT_BYTES) {
    throw storeError("ARTIFACT_INVALID_INPUT", "revision content size is outside the supported range");
  }
  verifyClaimedFormat(input.extension, input.bytes);

  const revisions = childDirectory(artifact, "revisions", "artifact revisions are missing");
  if (readdirSync(revisions.path).length >= MAX_REVISIONS) {
    throw storeError("ARTIFACT_TOO_LARGE", `artifact has reached the ${MAX_REVISIONS} revision limit`);
  }

  const revisionId = newOpaqueId("rev");
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  const contentRef = `content${input.extension}`;
  const revision: ArtifactRevision = {
    revisionId,
    artifactId: metadata.artifact.artifactId,
    parentRevisionId: input.baseRevisionId,
    baseRevisionId: input.baseRevisionId,
    actor: input.actor,
    ...(input.taskRunId ? { taskRunId: input.taskRunId } : {}),
    contentRef,
    assetRefs: [],
    contentDigest: sha256,
    changedPaths: input.changedPaths,
    createdAt: new Date().toISOString(),
  };
  const content: ArtifactContentInfo = {
    contentRef,
    extension: input.extension,
    mediaType: input.mediaType,
    byteSize: input.bytes.byteLength,
    sha256,
  };

  const stagingName = `.staging-${revisionId}-${randomUUID().replaceAll("-", "")}`;
  const staging = ensurePrivateStateSubdirectory(
    home,
    [".hara", "artifacts", metadata.artifact.artifactId, stagingName],
  );
  let activated = false;
  try {
    writePrivateStateBytesOnceSync(
      bindPrivateHaraStateFile(home, ["artifacts", metadata.artifact.artifactId, stagingName], contentRef),
      input.bytes,
    );
    writePrivateStateFileSync(
      bindPrivateHaraStateFile(home, ["artifacts", metadata.artifact.artifactId, stagingName], "content.json"),
      `${JSON.stringify(content, null, 2)}\n`,
    );
    writePrivateStateFileSync(
      bindPrivateHaraStateFile(home, ["artifacts", metadata.artifact.artifactId, stagingName], "revision.json"),
      `${JSON.stringify(revision, null, 2)}\n`,
    );
    activateRevisionStaging(artifact, staging, revisionId);
    activated = true;
  } finally {
    if (!activated) discardOwnedStagingBestEffort(artifact, staging);
  }

  const updated: ArtifactRecord = {
    ...metadata.artifact,
    ...(input.title !== undefined
      ? { title: titleFor(`${input.title}${input.extension}`, input.extension, input.title, metadata.artifact.kind) }
      : {}),
    currentRevisionId: revisionId,
  };
  try {
    writePrivateStateFileSync(
      bindPrivateHaraStateFile(home, ["artifacts", metadata.artifact.artifactId], "metadata.json"),
      `${JSON.stringify(updated, null, 2)}\n`,
      { expectedText: metadata.text },
    );
  } catch (error) {
    if (error instanceof PrivateStateConflictError) {
      throw storeError(
        "ARTIFACT_CONFLICT",
        "the Artifact changed while this revision was committing; reopen the latest version",
        error,
      );
    }
    throw error;
  }
  return getArtifact(home, metadata.artifact.artifactId);
}

/** Commit already-validated capability output without routing it through a user-selected source path.
 * File authority and optimistic concurrency remain in the Artifact store; renderers never write the
 * private revision tree directly. */
export function commitArtifactBytes(
  home: string,
  input: ArtifactPreparedCommitInput,
): ArtifactDetails {
  cleanupArtifactStaging(home);
  const artifactId = checkedArtifactId(input.artifactId);
  const baseRevisionId = checkedInputRevisionId(input.baseRevisionId, "baseRevisionId");
  const actor = checkedActor(input.actor);
  const taskRunId = checkedTaskRunId(input.taskRunId);
  const changedPaths = checkedChangedPaths(input.changedPaths);
  if (typeof input.extension !== "string" || !/^\.[a-z0-9]{1,12}$/.test(input.extension)) {
    throw storeError("ARTIFACT_INVALID_INPUT", "prepared revision extension is invalid");
  }
  if (typeof input.mediaType !== "string" || input.mediaType.length > 200) {
    throw storeError("ARTIFACT_INVALID_INPUT", "prepared revision media type is invalid");
  }
  if (!(input.bytes instanceof Uint8Array)) {
    throw storeError("ARTIFACT_INVALID_INPUT", "prepared revision bytes must be a Uint8Array");
  }
  const bytes = Buffer.from(input.bytes);
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_ARTIFACT_IMPORT_BYTES) {
    throw storeError("ARTIFACT_INVALID_INPUT", "prepared revision content size is outside the supported range");
  }

  const before = getArtifact(home, artifactId);
  if (before.artifact.currentRevisionId !== baseRevisionId) {
    throw storeError(
      "ARTIFACT_CONFLICT",
      "the Artifact changed after this edit started; reopen the latest version and apply the change again",
    );
  }
  const format = FORMATS.get(input.extension);
  if (
    !format
    || format.kind !== before.artifact.kind
    || format.mediaType !== input.mediaType
    || input.extension !== before.content.extension
    || input.mediaType !== before.content.mediaType
  ) {
    throw storeError("ARTIFACT_INVALID_INPUT", "prepared revision format does not match the Artifact");
  }
  verifyClaimedFormat(input.extension, bytes);
  return commitPreparedRevision(home, {
    artifactId,
    baseRevisionId,
    extension: input.extension,
    mediaType: input.mediaType,
    bytes,
    actor,
    ...(taskRunId ? { taskRunId } : {}),
    changedPaths,
    ...(input.title !== undefined ? { title: input.title } : {}),
  });
}

export async function commitArtifact(
  home: string,
  input: ArtifactCommitInput,
): Promise<ArtifactDetails> {
  cleanupArtifactStaging(home);
  const artifactId = checkedArtifactId(input.artifactId);
  const baseRevisionId = checkedInputRevisionId(input.baseRevisionId, "baseRevisionId");
  const actor = checkedActor(input.actor);
  const taskRunId = checkedTaskRunId(input.taskRunId);
  const changedPaths = checkedChangedPaths(input.changedPaths);

  const before = getArtifact(home, artifactId);
  if (before.artifact.currentRevisionId !== baseRevisionId) {
    throw storeError(
      "ARTIFACT_CONFLICT",
      "the Artifact changed after this edit started; reopen the latest version and apply the change again",
    );
  }
  const { sourcePath, extension, format } = sourceFormat(input.sourcePath, before.artifact.kind);
  const bytes = await readImportSource(sourcePath);
  verifyClaimedFormat(extension, bytes);
  return commitPreparedRevision(home, {
    artifactId,
    baseRevisionId,
    extension,
    mediaType: format.mediaType,
    bytes,
    actor,
    ...(taskRunId ? { taskRunId } : {}),
    changedPaths,
  });
}

export function revertArtifact(
  home: string,
  input: ArtifactRevertInput,
): ArtifactDetails {
  const artifactId = checkedArtifactId(input.artifactId);
  const baseRevisionId = checkedInputRevisionId(input.baseRevisionId, "baseRevisionId");
  const targetRevisionId = checkedInputRevisionId(input.targetRevisionId, "targetRevisionId");
  const actor = checkedActor(input.actor);
  const taskRunId = checkedTaskRunId(input.taskRunId);
  if (baseRevisionId === targetRevisionId) {
    throw storeError("ARTIFACT_INVALID_INPUT", "targetRevisionId is already the current revision");
  }

  const artifact = artifactDirectory(home, artifactId);
  const current = readArtifactMetadata(artifact).artifact;
  if (current.currentRevisionId !== baseRevisionId) {
    throw storeError(
      "ARTIFACT_CONFLICT",
      "the Artifact changed after this revert started; reopen the latest version",
    );
  }

  const history = listArtifactRevisions(home, artifactId);
  const byId = new Map(history.map((revision) => [revision.revisionId, revision]));
  let cursor: ArtifactRevision | undefined = byId.get(baseRevisionId);
  let targetIsAncestor = false;
  for (let count = 0; cursor && count <= history.length; count++) {
    if (cursor.revisionId === targetRevisionId) {
      targetIsAncestor = true;
      break;
    }
    cursor = cursor.parentRevisionId ? byId.get(cursor.parentRevisionId) : undefined;
  }
  if (!targetIsAncestor) {
    throw storeError("ARTIFACT_INVALID_INPUT", "targetRevisionId is not an ancestor of the current revision");
  }

  const target = readRevisionDetails(artifact, targetRevisionId, true);
  const bytes = readContentBytes(revisionDirectory(artifact, targetRevisionId), target.content);
  return commitPreparedRevision(home, {
    artifactId,
    baseRevisionId,
    extension: target.content.extension,
    mediaType: target.content.mediaType,
    bytes,
    actor,
    ...(taskRunId ? { taskRunId } : {}),
    changedPaths: ["content"],
  });
}

function readValidationReport(
  artifact: PrivateStateDirectoryIdentity,
  reportId: string,
): ArtifactValidationReport {
  const validations = childDirectory(artifact, "validations", "Artifact validation reports are missing");
  const value = parseJsonFile(join(validations.path, `${reportId}.json`));
  if (!isValidationReport(value) || value.reportId !== reportId) {
    throw storeError("ARTIFACT_CORRUPT", "ValidationReport metadata is invalid");
  }
  verifyDirectory(validations);
  return value;
}

function checkedFindings(value: unknown): ArtifactFinding[] {
  if (!Array.isArray(value) || value.length > 1_000) {
    throw storeError("ARTIFACT_INVALID_INPUT", "validation findings must be a bounded array");
  }
  return value.map((finding) => {
    if (
      !finding
      || typeof finding !== "object"
      || typeof finding.code !== "string"
      || !/^[A-Z0-9_]{1,100}$/.test(finding.code)
      || (finding.severity !== "error" && finding.severity !== "warning" && finding.severity !== "info")
      || typeof finding.message !== "string"
      || finding.message.length < 1
      || finding.message.length > 4_000
      || (finding.suggestion !== undefined && (typeof finding.suggestion !== "string" || finding.suggestion.length < 1 || finding.suggestion.length > 4_000))
    ) throw storeError("ARTIFACT_INVALID_INPUT", "validation finding is invalid");
    return {
      code: finding.code,
      severity: finding.severity,
      message: finding.message,
      ...(finding.path !== undefined ? { path: normalizeArtifactPath(finding.path) } : {}),
      ...(finding.suggestion !== undefined ? { suggestion: finding.suggestion } : {}),
    };
  });
}

export function recordArtifactValidation(
  home: string,
  input: ArtifactPreparedValidationInput,
): ArtifactValidationReport {
  const artifactId = checkedArtifactId(input.artifactId);
  const revisionId = checkedInputRevisionId(input.revisionId, "revisionId");
  if (typeof input.snapshotDigest !== "string" || !/^[a-f0-9]{64}$/.test(input.snapshotDigest)) {
    throw storeError("ARTIFACT_INVALID_INPUT", "validation snapshot digest is invalid");
  }
  if (
    typeof input.validatorId !== "string"
    || !/^[a-z0-9][a-z0-9._-]{0,199}$/.test(input.validatorId)
    || typeof input.validatorVersion !== "string"
    || !/^[0-9A-Za-z][0-9A-Za-z._-]{0,99}$/.test(input.validatorVersion)
  ) throw storeError("ARTIFACT_INVALID_INPUT", "validation identity is invalid");
  const findings = checkedFindings(input.findings);
  const artifact = artifactDirectory(home, artifactId);
  const before = readArtifactMetadata(artifact);
  if (before.artifact.currentRevisionId !== revisionId) {
    throw storeError(
      "ARTIFACT_CONFLICT",
      "the Artifact changed before validation completed; reopen the latest version and validate again",
    );
  }
  const { content } = readRevisionDetails(artifact, revisionId, false);
  const bytes = readContentBytes(revisionDirectory(artifact, revisionId), content);
  verifyClaimedFormat(content.extension, bytes);
  if (content.sha256 !== input.snapshotDigest) {
    throw storeError("ARTIFACT_CONFLICT", "validation findings do not belong to this exact revision");
  }
  const after = readArtifactMetadata(artifact);
  if (after.text !== before.text || after.artifact.currentRevisionId !== revisionId) {
    throw storeError(
      "ARTIFACT_CONFLICT",
      "the Artifact changed while validation was recorded; reopen the latest version and validate again",
    );
  }
  const status: ArtifactValidationReport["status"] = findings.some((finding) => finding.severity === "error")
    ? "blocked"
    : findings.some((finding) => finding.severity === "warning")
      ? "revise"
      : "pass";
  const report: ArtifactValidationReport = {
    reportId: `val_${randomUUID().replaceAll("-", "")}`,
    revisionId,
    validatorId: input.validatorId,
    validatorVersion: input.validatorVersion,
    createdAt: new Date().toISOString(),
    snapshotDigest: content.sha256,
    status,
    findings,
  };
  ensurePrivateStateSubdirectory(home, [".hara", "artifacts", artifactId, "validations"]);
  writePrivateStateBytesOnceSync(
    bindPrivateHaraStateFile(home, ["artifacts", artifactId, "validations"], `${report.reportId}.json`),
    Buffer.from(`${JSON.stringify(report, null, 2)}\n`),
  );
  return readValidationReport(artifact, report.reportId);
}

export function validateArtifact(
  home: string,
  input: { artifactId: string; revisionId: string },
): ArtifactValidationReport {
  const artifactId = checkedArtifactId(input.artifactId);
  const revisionId = checkedInputRevisionId(input.revisionId, "revisionId");
  const artifact = artifactDirectory(home, artifactId);
  const before = readArtifactMetadata(artifact);
  if (before.artifact.currentRevisionId !== revisionId) {
    throw storeError(
      "ARTIFACT_CONFLICT",
      "the Artifact changed before validation started; reopen the latest version and validate again",
    );
  }
  const { content } = readRevisionDetails(artifact, revisionId, false);
  const bytes = readContentBytes(revisionDirectory(artifact, revisionId), content);
  verifyClaimedFormat(content.extension, bytes);
  const after = readArtifactMetadata(artifact);
  if (after.text !== before.text || after.artifact.currentRevisionId !== revisionId) {
    throw storeError(
      "ARTIFACT_CONFLICT",
      "the Artifact changed while validation was running; reopen the latest version and validate again",
    );
  }

  const report: ArtifactValidationReport = {
    reportId: `val_${randomUUID().replaceAll("-", "")}`,
    revisionId,
    validatorId: INTEGRITY_VALIDATOR_ID,
    validatorVersion: INTEGRITY_VALIDATOR_VERSION,
    createdAt: new Date().toISOString(),
    snapshotDigest: content.sha256,
    status: "pass",
    findings: [{
      code: "ARTIFACT_INTEGRITY_VERIFIED",
      severity: "info",
      message: "Immutable bytes, recorded SHA-256, size, and declared file signature match this revision.",
    }],
  };
  ensurePrivateStateSubdirectory(home, [".hara", "artifacts", artifactId, "validations"]);
  writePrivateStateBytesOnceSync(
    bindPrivateHaraStateFile(home, ["artifacts", artifactId, "validations"], `${report.reportId}.json`),
    Buffer.from(`${JSON.stringify(report, null, 2)}\n`),
  );
  return readValidationReport(artifact, report.reportId);
}

interface ExternalFileIdentity {
  dev: number;
  ino: number;
  size: number;
  mode: number;
  nlink: number;
}

interface ExportDestination {
  path: string;
  parent: PrivateStateDirectoryIdentity;
}

interface ExportWriteResult {
  identity: ExternalFileIdentity;
  warnings: ArtifactExportWarning[];
}

function verifyExportDirectory(identity: PrivateStateDirectoryIdentity): void {
  const info = lstatSync(identity.path);
  if (
    !info.isDirectory()
    || info.isSymbolicLink()
    || info.dev !== identity.dev
    || info.ino !== identity.ino
    || realpathSync.native(identity.path) !== identity.path
  ) throw storeError("ARTIFACT_EXPORT_FAILED", "the selected export directory changed; choose it again");
}

function exportDestination(
  destinationPathInput: unknown,
  expectedExtension: string,
): ExportDestination {
  if (
    typeof destinationPathInput !== "string"
    || !destinationPathInput
    || destinationPathInput.length > 4_096
    || !isAbsolute(destinationPathInput)
  ) throw storeError("ARTIFACT_INVALID_INPUT", "destinationPath must be an absolute path selected by the user");
  const selected = resolve(destinationPathInput);
  const name = basename(selected);
  if (
    !name
    || name === "."
    || name === ".."
    || name.length > 255
    || /[\u0000-\u001f\u007f]/.test(name)
  ) throw storeError("ARTIFACT_INVALID_INPUT", "the export filename is not safe");
  if (extname(name).toLowerCase() !== expectedExtension) {
    throw storeError(
      "ARTIFACT_INVALID_INPUT",
      `this safe export preserves ${expectedExtension}; format conversion requires a reviewed Office capability`,
    );
  }
  let parentPath: string;
  try {
    parentPath = realpathSync.native(dirname(selected));
  } catch (error) {
    throw storeError("ARTIFACT_INVALID_INPUT", "the selected export directory does not exist", error);
  }
  const info = lstatSync(parentPath);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw storeError("ARTIFACT_INVALID_INPUT", "the selected export parent must be a real directory");
  }
  const parent = { path: parentPath, dev: info.dev, ino: info.ino } satisfies PrivateStateDirectoryIdentity;
  verifyExportDirectory(parent);
  return { path: join(parent.path, name), parent };
}

function externalFileMatches(path: string, identity: ExternalFileIdentity): boolean {
  try {
    const info = lstatSync(path);
    return info.isFile()
      && !info.isSymbolicLink()
      && sameOpenedFileIdentity(info, identity)
      && info.size === identity.size;
  } catch {
    return false;
  }
}

function externalFileHasIdentity(path: string, identity: ExternalFileIdentity): boolean {
  try {
    const info = lstatSync(path);
    return info.isFile() && !info.isSymbolicLink() && sameOpenedFileIdentity(info, identity);
  } catch {
    return false;
  }
}

function removeExternalFileIfSame(
  destination: ExportDestination,
  identity: ExternalFileIdentity,
): boolean {
  try {
    verifyExportDirectory(destination.parent);
    if (!externalFileMatches(destination.path, identity)) return false;
    unlinkSync(destination.path);
    verifyExportDirectory(destination.parent);
    return true;
  } catch {
    return false;
  }
}

function removeExternalFileByIdentity(
  destination: ExportDestination,
  identity: ExternalFileIdentity,
): boolean {
  try {
    verifyExportDirectory(destination.parent);
    if (!externalFileHasIdentity(destination.path, identity)) return false;
    unlinkSync(destination.path);
    verifyExportDirectory(destination.parent);
    return true;
  } catch {
    return false;
  }
}

function verifyExternalDigest(path: string, expected: ExternalFileIdentity, sha256: string): void {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || !sameOpenedFileIdentity(before, expected)) {
    throw storeError("ARTIFACT_EXPORT_FAILED", "the exported file identity changed before verification");
  }
  const fd = openSync(
    path,
    constants.O_RDONLY | optionalPosixOpenFlag("O_NONBLOCK") | optionalPosixOpenFlag("O_NOFOLLOW"),
  );
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || !sameOpenedFileIdentity(opened, expected) || opened.size !== expected.size) {
      throw storeError("ARTIFACT_EXPORT_FAILED", "the exported file does not match the committed output");
    }
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    for (;;) {
      const count = readSync(fd, chunk, 0, chunk.length, position);
      if (!count) break;
      hash.update(chunk.subarray(0, count));
      position += count;
    }
    if (hash.digest("hex") !== sha256) {
      throw storeError("ARTIFACT_EXPORT_FAILED", "the exported file digest does not match the validated revision");
    }
    const after = fstatSync(fd);
    const linked = lstatSync(path);
    if (
      !sameOpenedFileIdentity(opened, after)
      || opened.size !== after.size
      || opened.mtimeMs !== after.mtimeMs
      || opened.ctimeMs !== after.ctimeMs
      || !sameOpenedFileIdentity(after, linked)
    ) throw storeError("ARTIFACT_EXPORT_FAILED", "the exported file changed during verification");
  } finally {
    closeSync(fd);
  }
}

function writeExportBytesOnce(
  destination: ExportDestination,
  bytes: Buffer,
  sha256: string,
): ExportWriteResult {
  verifyExportDirectory(destination.parent);
  try {
    lstatSync(destination.path);
    throw storeError("ARTIFACT_CONFLICT", "the selected export file already exists; choose a new filename");
  } catch (error: any) {
    if (error instanceof ArtifactStoreError || error?.code !== "ENOENT") throw error;
  }

  const temp = join(
    destination.parent.path,
    `.hara-export-${process.pid}-${randomUUID().replaceAll("-", "")}.tmp`,
  );
  let fd: number | undefined;
  let staged: ExternalFileIdentity | undefined;
  let committed: ExternalFileIdentity | undefined;
  let createdOutput: ExternalFileIdentity | undefined;
  const warnings: ArtifactExportWarning[] = [];
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    const stagedInfo = fstatSync(fd);
    if (!stagedInfo.isFile() || stagedInfo.nlink !== 1 || stagedInfo.size !== bytes.byteLength) {
      throw storeError("ARTIFACT_EXPORT_FAILED", "the export staging file is unsafe");
    }
    staged = {
      dev: stagedInfo.dev,
      ino: stagedInfo.ino,
      size: stagedInfo.size,
      mode: stagedInfo.mode & 0o777,
      nlink: stagedInfo.nlink,
    };
    closeSync(fd);
    fd = undefined;

    verifyExportDirectory(destination.parent);
    try {
      linkSync(temp, destination.path);
      const linked = lstatSync(destination.path);
      if (
        !linked.isFile()
        || linked.isSymbolicLink()
        || !sameOpenedFileIdentity(linked, staged)
        || linked.size !== staged.size
      ) throw storeError("ARTIFACT_EXPORT_FAILED", "the exported file changed during atomic activation");
      unlinkSync(temp);
      const finalInfo = lstatSync(destination.path);
      committed = {
        dev: finalInfo.dev,
        ino: finalInfo.ino,
        size: finalInfo.size,
        mode: finalInfo.mode & 0o777,
        nlink: finalInfo.nlink,
      };
    } catch (error: any) {
      if (error?.code === "EEXIST") {
        throw storeError("ARTIFACT_CONFLICT", "the selected export file already exists; choose a new filename");
      }
      if (!new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV"]).has(String(error?.code ?? ""))) {
        throw error;
      }
      fd = openSync(destination.path, "wx", 0o600);
      const created = fstatSync(fd);
      createdOutput = {
        dev: created.dev,
        ino: created.ino,
        size: created.size,
        mode: created.mode & 0o777,
        nlink: created.nlink,
      };
      writeFileSync(fd, bytes);
      fsyncSync(fd);
      const output = fstatSync(fd);
      if (!output.isFile() || output.nlink !== 1 || output.size !== bytes.byteLength) {
        throw storeError("ARTIFACT_EXPORT_FAILED", "the exclusive export output is unsafe");
      }
      committed = {
        dev: output.dev,
        ino: output.ino,
        size: output.size,
        mode: output.mode & 0o777,
        nlink: output.nlink,
      };
      createdOutput = committed;
      closeSync(fd);
      fd = undefined;
      warnings.push({
        code: "NON_ATOMIC_EXPORT_FILESYSTEM",
        severity: "warning",
        message: "The destination filesystem does not support atomic link activation; Hara used an exclusive verified write and did not replace an existing file.",
      });
    }
    if (!committed || committed.nlink !== 1 || committed.size !== bytes.byteLength) {
      throw storeError("ARTIFACT_EXPORT_FAILED", "the exported file did not reach a committed state");
    }
    verifyExternalDigest(destination.path, committed, sha256);
    verifyExportDirectory(destination.parent);
    return { identity: committed, warnings };
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* preserve original failure */ }
      fd = undefined;
    }
    if (committed) {
      removeExternalFileIfSame(destination, committed);
    } else if (createdOutput) {
      removeExternalFileByIdentity(destination, createdOutput);
    } else if (staged && externalFileHasIdentity(destination.path, staged)) {
      removeExternalFileIfSame(destination, staged);
    }
    throw error;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* preserve original failure */ }
    if (staged && externalFileMatches(temp, staged)) {
      try { unlinkSync(temp); } catch { /* retain a changed entry instead of deleting it */ }
    }
  }
}

export function exportArtifactConverted(
  home: string,
  input: ArtifactConvertedExportInput,
): ArtifactExportReceipt {
  const artifactId = checkedArtifactId(input.artifactId);
  const revisionId = checkedInputRevisionId(input.revisionId, "revisionId");
  const validationReportId = checkedValidationId(input.validationReportId);
  if (typeof input.format !== "string" || !/^[a-z0-9]{1,12}$/.test(input.format)) {
    throw storeError("ARTIFACT_INVALID_INPUT", "export format is invalid");
  }
  if (
    typeof input.mediaType !== "string"
    || input.mediaType.length > 200
    || !/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/.test(input.mediaType)
  ) throw storeError("ARTIFACT_INVALID_INPUT", "export media type is invalid");
  if (!new Set(["visual-fidelity", "template-editable", "semantic-editable", "roundtrip"]).has(input.fidelity)) {
    throw storeError("ARTIFACT_INVALID_INPUT", "export fidelity is invalid");
  }
  if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength < 1 || input.bytes.byteLength > 256 * 1024 * 1024) {
    throw storeError("ARTIFACT_INVALID_INPUT", "export bytes must contain 1 to 256 MiB");
  }
  if (
    typeof input.validatorId !== "string"
    || input.validatorId.length < 1
    || input.validatorId.length > 200
    || typeof input.validatorVersion !== "string"
    || input.validatorVersion.length < 1
    || input.validatorVersion.length > 100
  ) throw storeError("ARTIFACT_INVALID_INPUT", "export validator identity is invalid");
  if (input.warnings !== undefined && (!Array.isArray(input.warnings) || input.warnings.length > 1_000)) {
    throw storeError("ARTIFACT_INVALID_INPUT", "export warnings must be a bounded array");
  }
  const warnings = (input.warnings ?? []).map((warning) => {
    if (
      !warning
      || warning.severity !== "warning"
      || typeof warning.code !== "string"
      || !/^[A-Z0-9_]{1,100}$/.test(warning.code)
      || typeof warning.message !== "string"
      || warning.message.length < 1
      || warning.message.length > 4_000
      || (warning.suggestion !== undefined && (typeof warning.suggestion !== "string" || warning.suggestion.length < 1 || warning.suggestion.length > 4_000))
    ) throw storeError("ARTIFACT_INVALID_INPUT", "export warning is invalid");
    return {
      code: warning.code,
      severity: "warning" as const,
      message: warning.message,
      ...(warning.path !== undefined ? { path: normalizeArtifactPath(warning.path) } : {}),
      ...(warning.suggestion !== undefined ? { suggestion: warning.suggestion } : {}),
    };
  });
  const bytes = Buffer.from(input.bytes);
  const outputSha256 = createHash("sha256").update(bytes).digest("hex");
  const artifact = artifactDirectory(home, artifactId);
  const before = readArtifactMetadata(artifact);
  if (before.artifact.currentRevisionId !== revisionId) {
    throw storeError(
      "ARTIFACT_CONFLICT",
      "the Artifact changed before export started; reopen the latest version, validate, and export again",
    );
  }
  const report = readValidationReport(artifact, validationReportId);
  const { content } = readRevisionDetails(artifact, revisionId, false);
  if (
    report.revisionId !== revisionId
    || report.snapshotDigest !== content.sha256
    || report.status !== "pass"
    || report.validatorId !== input.validatorId
    || report.validatorVersion !== input.validatorVersion
  ) throw storeError("ARTIFACT_INVALID_INPUT", "the ValidationReport does not authorize this exact revision");
  const sourceBytes = readContentBytes(revisionDirectory(artifact, revisionId), content);
  verifyClaimedFormat(content.extension, sourceBytes);
  const after = readArtifactMetadata(artifact);
  if (after.text !== before.text || after.artifact.currentRevisionId !== revisionId) {
    throw storeError(
      "ARTIFACT_CONFLICT",
      "the Artifact changed while export was prepared; reopen the latest version, validate, and export again",
    );
  }
  const destination = exportDestination(input.destinationPath, `.${input.format}`);
  const receiptId = `exp_${randomUUID().replaceAll("-", "")}`;
  ensurePrivateStateSubdirectory(home, [".hara", "artifacts", artifactId, "exports"]);
  const receiptBinding = bindPrivateHaraStateFile(
    home,
    ["artifacts", artifactId, "exports"],
    `${receiptId}.json`,
  );
  const written = writeExportBytesOnce(destination, bytes, outputSha256);
  const receipt: ArtifactExportReceipt = {
    receiptId,
    artifactId,
    revisionId,
    createdAt: new Date().toISOString(),
    format: input.format,
    fidelity: input.fidelity,
    validationReportId,
    output: {
      mediaType: input.mediaType,
      byteSize: bytes.byteLength,
      sha256: outputSha256,
    },
    warnings: [...warnings, ...written.warnings],
  };
  try {
    writePrivateStateBytesOnceSync(
      receiptBinding,
      Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`),
    );
  } catch (error) {
    const removed = removeExternalFileIfSame(destination, written.identity);
    throw storeError(
      "ARTIFACT_EXPORT_FAILED",
      removed
        ? "the ExportReceipt could not be recorded, so the exported copy was removed"
        : "the ExportReceipt could not be recorded; inspect the selected destination before retrying",
      error,
    );
  }
  return receipt;
}

export function exportArtifact(
  home: string,
  input: ArtifactExportInput,
): ArtifactExportReceipt {
  const source = readArtifactRevisionContent(home, {
    artifactId: input.artifactId,
    revisionId: input.revisionId,
    requireCurrent: true,
  });
  return exportArtifactConverted(home, {
    ...input,
    format: source.content.extension.slice(1),
    mediaType: source.content.mediaType,
    fidelity: "roundtrip",
    bytes: source.bytes,
    validatorId: INTEGRITY_VALIDATOR_ID,
    validatorVersion: INTEGRITY_VALIDATOR_VERSION,
  });
}

export function getArtifact(
  home: string,
  artifactId: string,
  verifyDigest = true,
): ArtifactDetails {
  return readArtifactDetailsFromDirectory(artifactDirectory(home, artifactId), verifyDigest);
}

export function readArtifactRevisionContent(
  home: string,
  input: { artifactId: string; revisionId?: string; requireCurrent?: boolean },
): ArtifactRevisionContent {
  const artifactId = checkedArtifactId(input.artifactId);
  const artifactDirectoryIdentity = artifactDirectory(home, artifactId);
  const metadata = readArtifactMetadata(artifactDirectoryIdentity).artifact;
  const revisionId = input.revisionId === undefined
    ? checkedRevisionId(metadata.currentRevisionId)
    : checkedInputRevisionId(input.revisionId, "revisionId");
  if (input.requireCurrent === true && metadata.currentRevisionId !== revisionId) {
    throw storeError(
      "ARTIFACT_CONFLICT",
      "the Artifact changed; reopen the latest revision before continuing",
    );
  }
  const { revision, content } = readRevisionDetails(artifactDirectoryIdentity, revisionId, false);
  const bytes = readContentBytes(revisionDirectory(artifactDirectoryIdentity, revisionId), content);
  verifyDirectory(artifactDirectoryIdentity);
  return { artifact: metadata, revision, content, bytes };
}

export function listArtifacts(home: string): ArtifactListResult {
  cleanupArtifactStaging(home);
  const root = artifactRoot(home);
  verifyDirectory(root);
  const entries = readdirSync(root.path, { withFileTypes: true });
  const candidates = entries.filter((entry) => !entry.name.startsWith("."));
  const artifacts: ArtifactSummary[] = [];
  let invalid = 0;
  for (const entry of candidates.slice(0, MAX_ARTIFACTS)) {
    if (!entry.isDirectory() || !ARTIFACT_ID.test(entry.name)) {
      invalid += 1;
      continue;
    }
    try {
      const directory = childDirectory(root, entry.name, `no artifact ${entry.name}`);
      const details = readArtifactDetailsFromDirectory(directory, false);
      artifacts.push({
        artifactId: details.artifact.artifactId,
        kind: details.artifact.kind,
        title: details.artifact.title,
        currentRevisionId: details.artifact.currentRevisionId,
        updatedAt: details.currentRevision.createdAt,
        extension: details.content.extension,
        mediaType: details.content.mediaType,
        byteSize: details.content.byteSize,
      });
    } catch {
      invalid += 1;
    }
  }
  verifyDirectory(root);
  artifacts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.artifactId.localeCompare(b.artifactId));
  return {
    artifacts,
    invalid,
    truncated: candidates.length > MAX_ARTIFACTS,
  };
}

export function listArtifactRevisions(home: string, artifactId: string): ArtifactRevision[] {
  const artifact = artifactDirectory(home, artifactId);
  const metadata = parseJsonFile(join(artifact.path, "metadata.json"));
  if (!isArtifactRecord(metadata) || metadata.artifactId !== artifactId) {
    throw storeError("ARTIFACT_CORRUPT", "artifact metadata does not match its directory");
  }
  const revisions = childDirectory(artifact, "revisions", "artifact revisions are missing");
  const entries = readdirSync(revisions.path, { withFileTypes: true });
  if (entries.length > MAX_REVISIONS) {
    throw storeError("ARTIFACT_CORRUPT", `artifact has more than ${MAX_REVISIONS} revisions`);
  }
  const out: ArtifactRevision[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !REVISION_ID.test(entry.name)) {
      throw storeError("ARTIFACT_CORRUPT", "artifact contains an invalid revision entry");
    }
    const directory = childDirectory(revisions, entry.name, `no revision ${entry.name}`);
    const value = parseJsonFile(join(directory.path, "revision.json"));
    if (!isRevision(value) || value.revisionId !== entry.name || value.artifactId !== artifactId) {
      throw storeError("ARTIFACT_CORRUPT", "revision metadata does not match its directory");
    }
    out.push(value);
  }
  verifyDirectory(revisions);
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.revisionId.localeCompare(b.revisionId));
}
