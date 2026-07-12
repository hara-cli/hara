// Crash-safe UTF-8 writes for coding tools. Content is staged beside the destination, fsynced, then
// renamed into place so a killed process never leaves a half-written source file.
import { dirname, join } from "node:path";
import { link, lstat, mkdir, open, readFile, realpath, rename, stat, unlink } from "node:fs/promises";

export class FileChangedError extends Error {
  readonly code = "HARA_FILE_CHANGED";

  constructor(path: string) {
    super(`File changed while the edit was being prepared: ${path}. Re-read it and retry the edit.`);
    this.name = "FileChangedError";
  }
}

export interface AtomicWriteOptions {
  /** undefined = unconditional; string = current content must match; null = path must not exist. */
  expected?: string | null;
}

let tempSequence = 0;

async function writeTarget(path: string): Promise<string> {
  try {
    const info = await lstat(path);
    // Replacing a symlink would silently break it. Stage beside the real target instead so edits retain
    // the link (common in dotfile repos and generated workspace layouts).
    if (info.isSymbolicLink()) return await realpath(path);
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  return path;
}

async function syncDirectory(path: string): Promise<void> {
  // Directory fsync makes the rename durable across a power loss on POSIX. Some filesystems/platforms
  // reject opening directories, so durability degrades gracefully after the file itself was synced.
  try {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    /* best effort */
  }
}

/** Atomically replace/create a UTF-8 file, optionally refusing to overwrite a newer disk version. */
export async function atomicWriteText(path: string, content: string, options: AtomicWriteOptions = {}): Promise<void> {
  const target = await writeTarget(path);
  const dir = dirname(target);
  await mkdir(dir, { recursive: true });

  let mode = 0o666;
  try {
    mode = (await stat(target)).mode & 0o777;
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }

  // Keep the staging basename fixed-size: prefixing the destination's full basename would make a
  // perfectly valid near-NAME_MAX file impossible to edit because the temporary name becomes longer.
  const temp = join(dir, `.hara-${process.pid}-${Date.now().toString(36)}-${tempSequence++}.tmp`);
  let staged = false;
  try {
    const handle = await open(temp, "wx", mode);
    staged = true;
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }

    if (options.expected === null) {
      // link(2) is an atomic create-if-absent operation. A plain rename would overwrite a file that
      // appeared after validation, defeating create's no-clobber contract.
      try {
        await link(temp, target);
      } catch (error: any) {
        if (error?.code === "EEXIST") throw new FileChangedError(path);
        throw error;
      }
      await unlink(temp);
      staged = false;
    } else {
      if (typeof options.expected === "string") {
        let current: string;
        try {
          current = await readFile(target, "utf8");
        } catch {
          throw new FileChangedError(path);
        }
        if (current !== options.expected) throw new FileChangedError(path);
      }
      await rename(temp, target);
      staged = false;
    }
    await syncDirectory(dir);
  } finally {
    if (staged) await unlink(temp).catch(() => {});
  }
}
