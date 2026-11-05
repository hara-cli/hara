import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const unavailable = (reason: string) => new Error("runtime_protection_unavailable: " + reason);
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
/** Host-only metadata check. Root-admin settings outrank project settings; do not bypass them. */
export function assertGeminiProjectSettingsSupported(systemSettingsPath = "/Library/Application Support/GeminiCli/settings.json"): void {
  try { lstatSync(systemSettingsPath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw unavailable("Gemini admin settings could not be checked"); }
  throw unavailable("Gemini admin settings prevent isolated project settings");
}
/** Gemini 0.66 ignores non-root system-settings overrides. Install only our own temporary project
 * file; never read, replace or copy pre-existing project settings. The policy makes it read-only to
 * native code. Call before the evidence baseline and close only after the complete native drain. */
export function overlayGeminiProjectSettings(cwd: string, contents: string): { path: string; close(): void } {
  if (process.platform !== "darwin") throw unavailable("Gemini protected project settings require macOS");
  assertGeminiProjectSettingsSupported();
  const directory = join(realpathSync(cwd), ".gemini"), path = join(directory, "settings.json"), lock = join(directory, ".hara-settings.lock");
  let createdDirectory = false;
  try { mkdirSync(directory, { mode: 0o700 }); createdDirectory = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw unavailable("Gemini project settings directory is unavailable"); }
  const directoryInfo = lstatSync(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || directoryInfo.mode & 0o022 || process.getuid && directoryInfo.uid !== process.getuid())
    throw unavailable("Gemini project settings directory is unsafe");
  const checkDirectory = () => {
    const current = lstatSync(directory);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== directoryInfo.dev || current.ino !== directoryInfo.ino || current.mode & 0o022)
      throw unavailable("Gemini settings directory changed; cleanup held");
  };
  try { lstatSync(path); throw unavailable("Gemini project settings already exist and were preserved"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  let lockFd: number;
  try { checkDirectory(); lockFd = openSync(lock, "wx", 0o600); } catch { throw unavailable("Gemini project settings are in use"); }
  const lockInfo = fstatSync(lockFd); closeSync(lockFd);
  let installed: ReturnType<typeof fstatSync> | undefined;
  const releaseLock = () => {
    checkDirectory(); const current = lstatSync(lock);
    if (current.dev !== lockInfo.dev || current.ino !== lockInfo.ino || !current.isFile() || current.nlink !== 1) throw unavailable("Gemini settings lock changed; cleanup held");
    unlinkSync(lock);
    if (createdDirectory) try { rmdirSync(directory); } catch { /* retain unrelated project files */ }
  };
  try {
    checkDirectory();
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      installed = fstatSync(fd); checkDirectory(); const current = lstatSync(path);
      if (!installed.isFile() || installed.nlink !== 1 || installed.dev !== current.dev || installed.ino !== current.ino) throw unavailable("Gemini settings file changed");
      writeFileSync(fd, contents);
    } finally { closeSync(fd); }
  } catch {
    checkDirectory();
    if (installed) { const current = lstatSync(path); if (current.dev === installed.dev && current.ino === installed.ino && current.nlink === 1) unlinkSync(path); }
    releaseLock(); throw unavailable("Gemini temporary project settings could not be installed");
  }
  let closed = false, held = false;
  return { path, close() {
    if (held) throw unavailable("Gemini project settings changed; cleanup held");
    if (closed) return;
    try {
      checkDirectory(); const current = lstatSync(path);
      if (current.dev !== installed!.dev || current.ino !== installed!.ino || !current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.size !== Buffer.byteLength(contents)) throw unavailable("Gemini project settings changed; cleanup held");
      const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      try { const opened = fstatSync(fd); if (opened.dev !== current.dev || opened.ino !== current.ino || hash(readFileSync(fd)) !== hash(contents)) throw unavailable("Gemini project settings changed; cleanup held"); }
      finally { closeSync(fd); }
      checkDirectory(); const after = lstatSync(path); if (after.dev !== current.dev || after.ino !== current.ino) throw unavailable("Gemini settings file changed");
      unlinkSync(path); releaseLock(); closed = true;
    } catch { held = true; throw unavailable("Gemini project settings changed; cleanup held"); }
  } };
}
