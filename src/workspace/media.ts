import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from "node:fs";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyOpenedRegularFileSync } from "../fs-read.js";
import { sameOpenedFileIdentity } from "../fs-identity.js";
import { sensitiveFileError } from "../security/sensitive-files.js";

export const MAX_MEDIA_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_VIDEO_BYTES = 256 * 1024 * 1024, MAX_REGISTRATIONS = 512;
const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".pdf": "application/pdf", ".zip": "application/zip", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".md": "text/markdown", ".txt": "text/plain",
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm" };
interface Entry { id: string; path: string; root: string; rootInfo: Stats; info: Stats; mime: string }
export interface WorkspaceMediaRegistration { id: string; mime: string; bytes: number }
const inside = (root: string, path: string) => { const rel = relative(root, path); return !!rel && !isAbsolute(rel) && rel.split(sep).every(part => part !== ".." && part !== ""); };
const sameFile = (a: Stats, b: Stats) => sameOpenedFileIdentity(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
export type WorkspaceMediaFailure = "outside" | "missing" | "failed";
class WorkspaceMediaError extends Error { constructor(readonly kind: WorkspaceMediaFailure) { super("Workspace media unavailable"); } }
const denied = (kind: WorkspaceMediaFailure = "outside") => new WorkspaceMediaError(kind);
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
/** Ephemeral artifact registrations. Roots come only from the Host's current Workspace/project catalog,
 * never from renderer input. Every read repeats the current grant, directory, inode and MIME checks. */
export class WorkspaceMediaRegistry {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly project: string, private readonly roots: () => readonly string[], private readonly assertCurrent: () => void) {}
  private checkedPath(input: string): { path: string; root: string; rootInfo: Stats } {
    if (!input || input.length > 4096 || /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(input)) throw denied();
    let path = input;
    if (path.startsWith("file:")) { try { path = fileURLToPath(path); } catch { throw denied(); } }
    if (/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(path)) throw denied();
    if (path.split(/[\\/]/u).some(part => part === "..") || /[?*<>|]/u.test(path)) throw denied();
    path = resolve(this.project, path);
    if (sensitiveFileError(path, "read") || path.split(sep).some(part => [".codex", ".claude", ".ssh", "Keychains"].includes(part))) throw denied();
    const roots = this.roots().filter(root => isAbsolute(root) && root !== resolve(sep));
    let matched = false, missing = false;
    for (const candidate of roots.sort((a, b) => b.length - a.length)) {
      const logicalRoot = resolve(candidate); let rootMatched = false;
      try {
        // A registered root (or its ancestors) may be an alias. Only links below that root are denied.
        const root = realpathSync.native(logicalRoot), rootInfo = lstatSync(root);
        const prefix = inside(logicalRoot, path) ? logicalRoot : inside(root, path) ? root : null;
        if (!prefix) continue;
        matched = true; rootMatched = true;
        if (!rootInfo.isDirectory()) continue;
        let cursor = root;
        for (const part of relative(prefix, path).split(sep)) {
          if (!part || part.startsWith(".") || part.includes(":")) throw denied();
          cursor = resolve(cursor, part); const info = lstatSync(cursor);
          if (info.isSymbolicLink()) throw denied();
        }
        const canonical = realpathSync.native(cursor);
        if (!inside(root, canonical) || canonical !== cursor || sensitiveFileError(canonical, "read")
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
      const canonical = verifyOpenedRegularFileSync(checked.path, info, { rejectHardLinks: true, protectSensitive: true });
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
  describe(input: string): { state: "ready"; media: WorkspaceMediaRegistration } | { state: WorkspaceMediaFailure } {
    this.assertCurrent();
    try { return { state: "ready", media: this.register(input) }; }
    catch (error) { this.assertCurrent(); return { state: error instanceof WorkspaceMediaError ? error.kind : "failed" }; }
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
