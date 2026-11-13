import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readdirSync, readSync, realpathSync, renameSync, unlinkSync, writeSync, type Stats } from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyOpenedRegularFileSync } from "../fs-read.js";
import { sameOpenedFileIdentity } from "../fs-identity.js";
import { sensitiveFileError, lexicalSensitiveFileReason } from "../security/sensitive-files.js";
import { MAX_NATIVE_IMAGE_BYTES } from "../vision.js";

export const MAX_MEDIA_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_VIDEO_BYTES = 256 * 1024 * 1024, MAX_REGISTRATIONS = 512;
const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".pdf": "application/pdf", ".zip": "application/zip", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".md": "text/markdown", ".txt": "text/plain",
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm" };
/** Pasted images follow the existing image attachment rules: these four types, at most the native image limit. */
export const IMPORT_IMAGE_TYPES: Readonly<Record<string, string>> = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp" };
export const MAX_IMPORT_IMAGE_BYTES = MAX_NATIVE_IMAGE_BYTES;
/** Stable message clients match on (`image_too_large`) to say «the image is over 3.6 MB». */
export const IMPORT_IMAGE_TOO_LARGE = `image_too_large: images are limited to ${(MAX_IMPORT_IMAGE_BYTES / 1_000_000).toFixed(1)} MB (${MAX_IMPORT_IMAGE_BYTES} bytes)`;
interface Entry { id: string; path: string; root: string; rootInfo: Stats; info: Stats; mime: string }
export interface WorkspaceMediaRegistration { id: string; mime: string; bytes: number }
const inside = (root: string, path: string) => { const rel = relative(root, path); return !!rel && !isAbsolute(rel) && rel.split(sep).every(part => part !== ".." && part !== ""); };
const sameFile = (a: Stats, b: Stats) => sameOpenedFileIdentity(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
export type WorkspaceMediaFailure = "outside" | "missing" | "failed";
export type WorkspaceMediaFailureReason = "symlink" | "path_spelling";
class WorkspaceMediaError extends Error { constructor(readonly kind: WorkspaceMediaFailure, readonly reason?: WorkspaceMediaFailureReason) { super("Workspace media unavailable"); } }
const denied = (kind: WorkspaceMediaFailure = "outside", reason?: WorkspaceMediaFailureReason) => new WorkspaceMediaError(kind, reason);
function matchesMime(bytes: Buffer, mime: string): boolean {
  if (mime === "image/png") return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === "image/jpeg") return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (mime === "image/gif") return ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"));
  if (mime === "image/webp") return bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  if (mime === "video/webm") return bytes.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]));
  if (mime === "application/pdf") return bytes.subarray(0, 5).toString("ascii") === "%PDF-";
  if (mime === "application/zip" || mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") return bytes[0] === 80 && bytes[1] === 75 && [[3, 4], [5, 6], [7, 8]].some(([a, b]) => bytes[2] === a && bytes[3] === b);
  if (mime === "text/markdown" || mime === "text/plain") return !bytes.includes(0) && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(bytes.toString("utf8"));
  const box = bytes.subarray(4, 8).toString("ascii");
  if (box === "ftyp" && ["heic", "heix", "hevc", "hevx", "mif1", "msf1", "avif", "avis"].includes(bytes.subarray(8, 12).toString("ascii"))) return false;
  return mime === "video/quicktime" ? ["ftyp", "moov", "mdat", "wide"].includes(box) : mime === "video/mp4" && box === "ftyp";
}
const IMPORT_TEMP = /^\.import-[a-f0-9]{32}$/u;
/** A live import writes, fsyncs and renames its temp file inside one synchronous call (milliseconds). */
export const IMPORT_LEFTOVER_AGE_MS = 10 * 60_000;
/** Removes temp files an import interrupted by a crash left in `directory` (the attachments folder).
 * Only exact temp names; regular files or links (the link itself, never its target); never directories;
 * `directory` itself must be a real directory, not a link.
 *
 * Two Hosts on one root: the serve discovery receipt (`serve-v2.json`) refuses a second live Host, but that
 * check runs after initialization and is not an atomic lock. So only temp files older than
 * IMPORT_LEFTOVER_AGE_MS go: another Host's in-flight temp file is never that old. */
export function sweepImportLeftovers(directory: string, now = Date.now()): number {
  let names: string[];
  try { const info = lstatSync(directory); if (!info.isDirectory() || info.isSymbolicLink()) return 0; names = readdirSync(directory); } catch { return 0; }
  let removed = 0;
  for (const name of names) {
    if (!IMPORT_TEMP.test(name)) continue;
    const path = join(directory, name);
    try { const info = lstatSync(path); if ((!info.isFile() && !info.isSymbolicLink()) || now - info.mtimeMs < IMPORT_LEFTOVER_AGE_MS) continue; unlinkSync(path); removed++; } catch { /* already gone */ }
  }
  return removed;
}
/** Ephemeral artifact registrations. Roots come only from the Host's current Workspace/project catalog,
 * never from renderer input. Every read repeats the current grant, directory, inode and MIME checks. */
export class WorkspaceMediaRegistry {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly project: string, private readonly roots: () => readonly string[], private readonly assertCurrent: () => void, private readonly managedProject = false) {}
  /** Only the Host's fixed managed project may lift the enclosing Hara-state mask. No other root gains it. */
  private managedContent(path: string): boolean {
    return this.managedProject && inside(this.project, path) && !relative(this.project, path).split(sep).some(part => part.startsWith("."))
      && lexicalSensitiveFileReason(path) === "private Hara state";
  }
  private isProtected(path: string) { return Boolean(sensitiveFileError(path, "read") && !this.managedContent(path)); }
  private checkedPath(input: string): { path: string; root: string; rootInfo: Stats } {
    if (!input || input.length > 4096 || /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(input)) throw denied();
    let path = input;
    if (path.startsWith("file:")) { try { path = fileURLToPath(path); } catch { throw denied(); } }
    if (/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(path)) throw denied();
    if (path.split(/[\\/]/u).some(part => part === "..") || /[?*<>|]/u.test(path)) throw denied();
    path = resolve(this.project, path);
    if (this.isProtected(path) || path.split(sep).some(part => [".codex", ".claude", ".ssh", "Keychains"].includes(part))) throw denied();
    const roots = this.roots().filter(root => isAbsolute(root) && root !== resolve(sep));
    let matched = false, missing = false;
    for (const candidate of roots.sort((a, b) => b.length - a.length)) {
      const logicalRoot = resolve(candidate); let rootMatched = false;
      try {
        // A registered root (or its ancestors) may be an alias. Only links below that root are denied.
        const root = realpathSync.native(logicalRoot), rootInfo = lstatSync(root);
        if (root === resolve(sep)) continue;
        const prefix = inside(logicalRoot, path) ? logicalRoot : inside(root, path) ? root : null;
        if (!prefix) continue;
        matched = true; rootMatched = true;
        if (!rootInfo.isDirectory()) continue;
        let cursor = root;
        for (const part of relative(prefix, path).split(sep)) {
          if (!part || part.startsWith(".") || part.includes(":")) throw denied();
          cursor = resolve(cursor, part); const info = lstatSync(cursor);
          if (info.isSymbolicLink()) throw denied("failed", "symlink");
        }
        const canonical = realpathSync.native(cursor);
        if (inside(root, canonical) && canonical !== cursor) throw denied("failed", "path_spelling");
        if (!inside(root, canonical) || this.isProtected(canonical)
          || canonical.split(sep).some(part => [".codex", ".claude", ".ssh", "Keychains"].includes(part))) throw denied();
        return { path: canonical, root, rootInfo };
      } catch (error) {
        if (error instanceof WorkspaceMediaError) throw error;
        // A missing registered root is an unavailable root, not an observable missing outside file.
        if (rootMatched && error && typeof error === "object" && "code" in error && error.code === "ENOENT") missing = true;
        else if (inside(logicalRoot, path)) matched = true;
      }
    }
    throw denied(missing ? "missing" : matched ? "failed" : "outside");
  }
  private open(path: string, expected?: Entry) {
    this.assertCurrent(); const checked = this.checkedPath(path);
    if (expected && (checked.root !== expected.root || !sameOpenedFileIdentity(checked.rootInfo, expected.rootInfo))) throw denied();
    let fd: number;
    try { fd = openSync(checked.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); } catch { throw denied("failed"); }
    try {
      const info = fstatSync(fd), mime = MIME[extname(checked.path).toLowerCase()];
      const canonical = verifyOpenedRegularFileSync(checked.path, info, { rejectHardLinks: true, protectSensitive: !this.managedContent(checked.path), expectedCanonicalPath: checked.path });
      if (canonical !== checked.path) throw denied("failed");
      if (!mime || !info.size || info.size > (mime.startsWith("video/") ? MAX_VIDEO_BYTES : MAX_MEDIA_RESPONSE_BYTES) || expected && !sameFile(info, expected.info)) throw denied("failed");
      const prefix = Buffer.alloc(Math.min(32, info.size)); readSync(fd, prefix, 0, prefix.length, 0);
      if (!matchesMime(prefix, mime)) throw denied("failed");
      this.assertCurrent();
      return { fd, ...checked, info, mime };
    } catch (error) { closeSync(fd); throw error instanceof WorkspaceMediaError ? error : denied("failed"); }
  }
  register(input: string): WorkspaceMediaRegistration {
    const file = this.open(input);
    try {
      let entry = [...this.entries.values()].find(row => row.path === file.path && sameFile(row.info, file.info) && sameOpenedFileIdentity(row.rootInfo, file.rootInfo));
      if (!entry) {
        if (this.entries.size >= MAX_REGISTRATIONS) this.entries.delete(this.entries.keys().next().value!);
        entry = { id: randomBytes(32).toString("hex"), path: file.path, root: file.root, rootInfo: file.rootInfo, info: file.info, mime: file.mime };
        this.entries.set(entry.id, entry);
      } else { this.entries.delete(entry.id); this.entries.set(entry.id, entry); }
      return { id: entry.id, mime: entry.mime, bytes: entry.info.size };
    } finally { closeSync(file.fd); }
  }
  describe(input: string): { state: "ready"; media: WorkspaceMediaRegistration } | { state: WorkspaceMediaFailure; reason?: WorkspaceMediaFailureReason } {
    this.assertCurrent();
    try { return { state: "ready", media: this.register(input) }; }
    catch (error) { this.assertCurrent(); return { state: error instanceof WorkspaceMediaError ? error.kind : "failed", ...(error instanceof WorkspaceMediaError && error.reason ? { reason: error.reason } : {}) }; }
  }
  /** Writes a complete pasted image into `directory` (the Host's private attachments folder) and registers it.
   * The name is the content hash, never caller text. Bytes go to a private temp file (O_EXCL, no link following)
   * and are renamed into place, so a reader never sees a partial image; the same image twice reuses one file. */
  importImage(directory: string, bytes: Buffer, mime: string): { path: string; media: WorkspaceMediaRegistration } {
    this.assertCurrent();
    if (bytes.length > MAX_IMPORT_IMAGE_BYTES) throw new Error(IMPORT_IMAGE_TOO_LARGE);
    const extension = Object.hasOwn(IMPORT_IMAGE_TYPES, mime) ? IMPORT_IMAGE_TYPES[mime] : undefined;
    if (!extension || !bytes.length || !matchesMime(bytes.subarray(0, 32), mime)) throw denied("failed");
    const path = join(directory, `${createHash("sha256").update(bytes).digest("hex")}${extension}`);
    const existing = this.existing(path, bytes);
    if (existing === "same") return { path, media: this.register(path) };
    const temp = join(directory, `.import-${randomBytes(16).toString("hex")}`);
    let fd: number, open = true;
    try { fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600); } catch { throw denied("failed"); }
    try {
      for (let offset = 0; offset < bytes.length;) offset += writeSync(fd, bytes, offset, bytes.length - offset);
      fsyncSync(fd); closeSync(fd); open = false;
      this.assertCurrent();
      // rename never follows a link at the destination; re-check right before it so a planted link is refused, not replaced.
      if (this.existing(path, bytes) === "same") { unlinkSync(temp); return { path, media: this.register(path) }; }
      renameSync(temp, path);
    } catch (error) {
      if (open) try { closeSync(fd); } catch { /* best effort */ }
      try { unlinkSync(temp); } catch { /* already gone */ }
      throw error instanceof WorkspaceMediaError ? error : error instanceof Error && error.message.startsWith("Workspace") ? error : denied("failed");
    }
    return { path, media: this.register(path) };
  }
  /** "same" when an identical regular file is already there; "none"/"replaceable" otherwise. Links and hard links are refused. */
  private existing(path: string, bytes: Buffer): "same" | "none" | "replaceable" {
    let info: Stats; try { info = lstatSync(path); } catch { return "none"; }
    if (info.isSymbolicLink()) throw denied("failed", "symlink");
    if (!info.isFile() || info.nlink !== 1) throw denied("failed");
    if (info.size !== bytes.length) return "replaceable";
    let fd: number; try { fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); } catch { throw denied("failed"); }
    try {
      const current = Buffer.alloc(bytes.length);
      for (let offset = 0; offset < current.length;) { const count = readSync(fd, current, offset, current.length - offset, offset); if (!count) return "replaceable"; offset += count; }
      return current.equals(bytes) ? "same" : "replaceable";
    } finally { closeSync(fd); }
  }
  has(id: string) { return /^[a-f0-9]{64}$/u.test(id) && this.entries.has(id); }
  read(id: string, range?: string, head = false, pathOnly = false) {
    const entry = this.entries.get(id); if (!entry) throw denied();
    const file = this.open(entry.path, entry);
    try {
      let start = 0, end = file.info.size - 1;
      if (range !== undefined) {
        const match = /^bytes=(\d*)-(\d*)$/u.exec(range);
        if (!match || !match[1] && !match[2]) throw new RangeError("Invalid media range");
        if (!match[1]) {
          const suffix = Number(match[2]); if (!Number.isSafeInteger(suffix) || suffix < 1) throw new RangeError("Invalid media range");
          start = Math.max(0, file.info.size - suffix);
        } else { start = Number(match[1]); if (match[2]) end = Number(match[2]); }
        if (![start, end].every(Number.isSafeInteger) || start > end || start >= file.info.size) throw new RangeError("Invalid media range");
        end = Math.min(end, file.info.size - 1);
      }
      end = Math.min(end, start + MAX_MEDIA_RESPONSE_BYTES - 1);
      const partial = range !== undefined || end < file.info.size - 1;
      const bytes = head || pathOnly ? Buffer.alloc(0) : Buffer.alloc(end - start + 1);
      for (let offset = 0; offset < bytes.length;) { const count = readSync(file.fd, bytes, offset, bytes.length - offset, start + offset); if (!count) throw denied(); offset += count; }
      const latest = fstatSync(file.fd);
      if (verifyOpenedRegularFileSync(file.path, latest, { rejectHardLinks: true, protectSensitive: true }) !== file.path) throw denied("failed");
      const checked = this.checkedPath(file.path);
      if (!sameFile(file.info, latest) || checked.root !== entry.root || !sameOpenedFileIdentity(checked.rootInfo, entry.rootInfo)) throw denied();
      this.assertCurrent();
      return { path: file.path, bytes, status: partial ? 206 : 200, headers: { "Content-Type": file.mime, "Content-Length": String(end - start + 1), "Accept-Ranges": "bytes",
        ...(partial ? { "Content-Range": `bytes ${start}-${end}/${file.info.size}` } : {}) } };
    } finally { closeSync(file.fd); }
  }
}
