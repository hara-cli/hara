import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  type Stats,
} from "node:fs";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
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
const SAFE_CONTENT_REF = /^content\.[a-z0-9]{1,12}$/;

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

export interface ArtifactCommitInput {
  artifactId: string;
  baseRevisionId: string;
  sourcePath: string;
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
  | "ARTIFACT_CORRUPT";

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
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const artifactId = newOpaqueId("art");
  const revisionId = newOpaqueId("rev");
  const now = new Date().toISOString();
  const contentRef = `content${extension}`;
  const artifact: ArtifactRecord = {
    protocol: ARTIFACT_PROTOCOL_VERSION,
    artifactId,
    kind: format.kind,
    title: titleFor(sourcePath, extension, input.title, format.kind),
    currentRevisionId: revisionId,
    origin: "local-import",
    dataResidency: "local",
  };
  const revision: ArtifactRevision = {
    revisionId,
    artifactId,
    baseRevisionId: revisionId,
    actor: "user",
    contentRef,
    assetRefs: [],
    contentDigest: sha256,
    changedPaths: ["content"],
    createdAt: now,
  };
  const content: ArtifactContentInfo = {
    contentRef,
    extension,
    mediaType: format.mediaType,
    byteSize: bytes.byteLength,
    sha256,
  };

  const root = artifactRoot(home);
  const stagingName = `.staging-${artifactId}-${randomUUID().replaceAll("-", "")}`;
  const staging = ensurePrivateStateSubdirectory(home, [".hara", "artifacts", stagingName]);
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
  return getArtifact(home, artifactId, false);
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

  const updated: ArtifactRecord = {
    ...metadata.artifact,
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

export async function commitArtifact(
  home: string,
  input: ArtifactCommitInput,
): Promise<ArtifactDetails> {
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

export function getArtifact(
  home: string,
  artifactId: string,
  verifyDigest = true,
): ArtifactDetails {
  return readArtifactDetailsFromDirectory(artifactDirectory(home, artifactId), verifyDigest);
}

export function listArtifacts(home: string): ArtifactListResult {
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
