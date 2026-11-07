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
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm" };
interface Entry { id: string; path: string; root: string; rootInfo: Stats; info: Stats; mime: string }
export interface WorkspaceMediaRegistration { id: string; mime: string; bytes: number }
const inside = (root: string, path: string) => { const rel = relative(root, path); return !!rel && !isAbsolute(rel) && rel.split(sep).every(part => part !== ".." && part !== ""); };
const sameFile = (a: Stats, b: Stats) => sameOpenedFileIdentity(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const denied = () => new Error("Workspace media unavailable");
function matchesMime(bytes: Buffer, mime: string): boolean {
  if (mime === "image/png") return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === "image/jpeg") return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (mime === "image/gif") return ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"));
  if (mime === "image/webp") return bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  if (mime === "video/webm") return bytes.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]));
  const box = bytes.subarray(4, 8).toString("ascii");
  return mime === "video/quicktime" ? ["ftyp", "moov", "mdat", "wide"].includes(box) : mime === "video/mp4" && box === "ftyp";
}
/** Ephemeral artifact registrations. Roots come only from the Host's current Workspace/project catalog,
 * never from renderer input. Every read repeats the current grant, directory, inode and MIME checks. */
export class WorkspaceMediaRegistry {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly project: string, private readonly roots: () => readonly string[], private readonly assertCurrent: () => void) {}
  private checkedPath(input: string): { path: string; root: string; rootInfo: Stats } {
    if (!input || input.length > 4096 || /[\x00-\x1f\x7f]/u.test(input)) throw denied();
    let path = input;
    if (path.startsWith("file:")) { try { path = fileURLToPath(path); } catch { throw denied(); } }
    if (path.split(/[\\/]/u).some(part => part === "..") || /[?*<>|]/u.test(path)) throw denied();
    path = resolve(this.project, path);
    if (sensitiveFileError(path, "read") || path.split(sep).some(part => [".codex", ".claude", ".ssh", "Keychains"].includes(part))) throw denied();
    const roots = this.roots().filter(root => isAbsolute(root) && root !== resolve(sep));
    for (const candidate of roots.sort((a, b) => b.length - a.length)) {
      try {
        const root = realpathSync.native(candidate), rootInfo = lstatSync(candidate);
        if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || !inside(root, path)) continue;
        let cursor = root;
        for (const part of relative(root, path).split(sep)) {
          if (!part || part.startsWith(".") || part.includes(":")) throw denied();
          cursor = resolve(cursor, part); const info = lstatSync(cursor);
          if (info.isSymbolicLink()) throw denied();
        }
        if (realpathSync.native(path) !== path) throw denied();
        return { path, root, rootInfo };
      } catch { /* A missing/replaced/root-escaping path is never an implicit grant. */ }
    }
    throw denied();
  }
  private open(path: string, expected?: Entry) {
    this.assertCurrent(); const checked = this.checkedPath(path);
    if (expected && (checked.root !== expected.root || !sameOpenedFileIdentity(checked.rootInfo, expected.rootInfo))) throw denied();
    const fd = openSync(checked.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const info = fstatSync(fd), mime = MIME[extname(checked.path).toLowerCase()];
      verifyOpenedRegularFileSync(checked.path, info, { rejectHardLinks: true, protectSensitive: true });
      if (!mime || !info.size || info.size > (mime.startsWith("video/") ? MAX_VIDEO_BYTES : MAX_MEDIA_RESPONSE_BYTES) || expected && !sameFile(info, expected.info)) throw denied();
      const prefix = Buffer.alloc(Math.min(32, info.size)); readSync(fd, prefix, 0, prefix.length, 0);
      if (!matchesMime(prefix, mime)) throw denied();
      this.assertCurrent();
      return { fd, ...checked, info, mime };
    } catch { closeSync(fd); throw denied(); }
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
      const latest = fstatSync(file.fd); verifyOpenedRegularFileSync(file.path, latest, { rejectHardLinks: true, protectSensitive: true });
      const checked = this.checkedPath(file.path);
      if (!sameFile(file.info, latest) || checked.root !== entry.root || !sameOpenedFileIdentity(checked.rootInfo, entry.rootInfo)) throw denied();
      this.assertCurrent();
      return { path: file.path, bytes, status: partial ? 206 : 200, headers: { "Content-Type": file.mime, "Content-Length": String(end - start + 1), "Accept-Ranges": "bytes",
        ...(partial ? { "Content-Range": `bytes ${start}-${end}/${file.info.size}` } : {}) } };
    } finally { closeSync(file.fd); }
  }
}
