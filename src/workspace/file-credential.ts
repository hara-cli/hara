import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { exact, plain, text } from "./local-state.js";

/** Host-private reference. The file is never copied to Workspace state or sent to the renderer. */
export interface WorkspaceFileCredential { path: string; sha256: string }
export function isWorkspaceFileCredential(value: unknown): value is WorkspaceFileCredential {
  return plain(value) && exact(value, ["path", "sha256"]) && text(value.path, 4096) && isAbsolute(value.path)
    && typeof value.sha256 === "string" && /^[a-f0-9]{64}$/.test(value.sha256);
}
function read(path: string): { key: string; sha256: string } {
  let fd: number | undefined;
  try {
    if (!isAbsolute(path) || realpathSync.native(path) !== path) throw new Error();
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 16 || before.size > 16_384
      || (process.platform !== "win32" && (before.uid !== process.getuid?.() || (before.mode & 0o777) !== 0o600))) throw new Error();
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = fstatSync(fd), bytes = Buffer.alloc(16_385), count = readSync(fd, bytes, 0, bytes.length, 0);
    const after = fstatSync(fd), current = lstatSync(path);
    if (count !== before.size || count !== after.size || [opened, after, current].some(info => !info.isFile() || info.isSymbolicLink()
      || info.dev !== before.dev || info.ino !== before.ino || info.nlink !== 1 || info.mode !== before.mode
      || info.uid !== before.uid || info.mtimeMs !== before.mtimeMs || info.ctimeMs !== before.ctimeMs)) throw new Error();
    const raw = bytes.subarray(0, count), key = raw.toString("utf8").trim();
    if (!key || key.length < 16 || /\s/.test(key) || key.includes("\ufffd")) throw new Error();
    return { key, sha256: createHash("sha256").update(raw).digest("hex") };
  } catch { throw new Error("Workspace credential file unavailable or unsafe; no request was sent"); }
  finally { if (fd !== undefined) closeSync(fd); }
}
export function captureWorkspaceFileCredential(path: string): WorkspaceFileCredential {
  const { sha256 } = read(path); return { path, sha256 };
}
export function resolveWorkspaceFileCredential(reference: WorkspaceFileCredential): string {
  if (!isWorkspaceFileCredential(reference)) throw new Error("Invalid Workspace credential reference");
  const current = read(reference.path);
  if (current.sha256 !== reference.sha256) throw new Error("Workspace credential file changed; explicitly configure a new generation before running");
  return current.key;
}
