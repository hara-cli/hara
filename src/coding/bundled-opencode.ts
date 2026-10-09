import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sameOpenedFileIdentity } from "../fs-identity.js";
import { optionalPosixOpenFlag } from "../fs-open-flags.js";
import { tightenPrivateDescriptorMode } from "../fs-permissions.js";
import { bindPrivateHaraStateFile, withPrivateStateLockSync, writePrivateStateBytesOnceSync, type PrivateStateFileBinding } from "../security/private-state.js";

export interface BundledOpenCodeRuntimeMetadata {
  version: "1.18.32";
  platform: "darwin" | "linux" | "win32";
  arch: "arm64" | "x64";
  libc?: "glibc" | "musl";
  sha256: string;
  size: number;
  /** A build-generated Bun type:file virtual asset, never a disk path or configuration value. */
  assetPath: string;
}

// Build plugin replaces precisely this compiled assignment, preserving the materializer below.
export const bundledOpenCodeRuntime: BundledOpenCodeRuntimeMetadata | undefined = undefined;

/** Trusted programmatic test seam only. No project, environment or model payload supplies metadata. */
export interface BundledOpenCodeMaterializeOptions {
  home?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  libc?: "glibc" | "musl" | "unknown";
  readAsset?(path: string): Uint8Array;
}

export class BundledOpenCodeRuntimeError extends Error {
  readonly code = "bundled_opencode_runtime_unavailable";
  constructor(readonly reason: "invalid_manifest" | "target_mismatch" | "invalid_asset" | "invalid_cache") {
    super("Hara's embedded coding runtime is unavailable. Reinstall the official Hara distribution.");
    this.name = "BundledOpenCodeRuntimeError";
  }
}

/** Validate native format and CPU without executing the executable. Checks are not code signing. */
export function validOpenCodeNativeHeader(header: Buffer, platform: NodeJS.Platform, arch: string): boolean {
  if (header.length < 64 || (arch !== "arm64" && arch !== "x64")) return false;
  if (platform === "linux") {
    return header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) &&
      header[4] === 2 && header[5] === 1 && header.readUInt16LE(18) === (arch === "arm64" ? 183 : 62);
  }
  if (platform === "win32") {
    if (header[0] !== 0x4d || header[1] !== 0x5a) return false;
    const offset = header.readUInt32LE(60);
    return offset >= 64 && offset + 6 <= header.length && header.readUInt32LE(offset) === 0x00004550 &&
      header.readUInt16LE(offset + 4) === (arch === "arm64" ? 0xaa64 : 0x8664);
  }
  if (platform === "darwin") {
    const cpu = arch === "arm64" ? 0x0100000c : 0x01000007;
    const magic = header.readUInt32BE(0);
    if (magic === 0xcffaedfe) return header.readUInt32LE(4) === cpu;
    if (magic === 0xfeedfacf) return header.readUInt32BE(4) === cpu;
    if (magic === 0xcafebabe || magic === 0xcafebabf) {
      const count = header.readUInt32BE(4); const width = magic === 0xcafebabf ? 32 : 20;
      return count > 0 && count <= 64 && 8 + width * count <= header.length &&
        Array.from({ length: count }, (_, index) => header.readUInt32BE(8 + width * index)).includes(cpu);
    }
  }
  return false;
}

function virtualAsset(path: unknown, platform: string): path is string {
  if (typeof path !== "string" || !path || /[\u0000-\u0020\u007f]/u.test(path)) return false;
  if (platform !== "win32" && path.includes("\\")) return false;
  const normalized = path.replaceAll("\\", "/");
  const prefix = platform === "win32" ? /^B:\/~BUN\//iu : /^\/\$bunfs\//u;
  return prefix.test(normalized) && normalized.split("/").every((part, index) =>
    (index === 0 && part === "") || (part !== "" && part !== "." && part !== ".."));
}

function manifest(value: BundledOpenCodeRuntimeMetadata, options: BundledOpenCodeMaterializeOptions): BundledOpenCodeRuntimeMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).some((key) => !["version", "platform", "arch", "libc", "sha256", "size", "assetPath"].includes(key)) ||
    value.version !== "1.18.32" || !["darwin", "linux", "win32"].includes(value.platform) ||
    !["arm64", "x64"].includes(value.arch) || !/^[a-f0-9]{64}$/u.test(value.sha256) ||
    !Number.isSafeInteger(value.size) || value.size < 64 || value.size > 512 * 1024 * 1024 ||
    (value.platform === "linux" ? !["glibc", "musl"].includes(value.libc ?? "") : value.libc !== undefined)) {
    throw new BundledOpenCodeRuntimeError("invalid_manifest");
  }
  if (!virtualAsset(value.assetPath, value.platform)) throw new BundledOpenCodeRuntimeError("invalid_asset");
  if (value.platform !== (options.platform ?? process.platform) || value.arch !== (options.arch ?? process.arch) ||
    (value.platform === "linux" && value.libc !== options.libc)) throw new BundledOpenCodeRuntimeError("target_mismatch");
  return { ...value };
}

function privateDirectory(path: string): void {
  const info = lstatSync(path); const uid = process.getuid?.();
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync.native(path) !== path ||
    (uid !== undefined && info.uid !== uid) || (process.platform !== "win32" && (info.mode & 0o077) !== 0)) {
    throw new BundledOpenCodeRuntimeError("invalid_cache");
  }
}

function verifiedCache(binding: PrivateStateFileBinding, metadata: BundledOpenCodeRuntimeMetadata): void {
  privateDirectory(binding.directory.path);
  const before = lstatSync(binding.path); const uid = process.getuid?.();
  const mode = before.mode & 0o777;
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size !== metadata.size ||
    (uid !== undefined && before.uid !== uid) || (process.platform !== "win32" && mode !== 0o500 && mode !== 0o600)) {
    throw new BundledOpenCodeRuntimeError("invalid_cache");
  }
  const fd = openSync(binding.path, constants.O_RDONLY | optionalPosixOpenFlag("O_NOFOLLOW") | optionalPosixOpenFlag("O_NONBLOCK"));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || !sameOpenedFileIdentity(opened, before) ||
      opened.size !== before.size || opened.mtimeMs !== before.mtimeMs || opened.ctimeMs !== before.ctimeMs) {
      throw new BundledOpenCodeRuntimeError("invalid_cache");
    }
    const hash = createHash("sha256"); const buffer = Buffer.alloc(1024 * 1024); let total = 0; let header: Buffer | undefined;
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null); if (!count) break;
      if (!header) header = Buffer.from(buffer.subarray(0, Math.min(count, 4096)));
      hash.update(buffer.subarray(0, count)); total += count;
      if (total > metadata.size) throw new BundledOpenCodeRuntimeError("invalid_cache");
    }
    const afterRead = fstatSync(fd); const current = lstatSync(binding.path);
    if (total !== metadata.size || hash.digest("hex") !== metadata.sha256 ||
      !header || !validOpenCodeNativeHeader(header, metadata.platform, metadata.arch) ||
      !sameOpenedFileIdentity(afterRead, opened) || afterRead.nlink !== 1 || afterRead.size !== opened.size ||
      afterRead.mtimeMs !== opened.mtimeMs || afterRead.ctimeMs !== opened.ctimeMs ||
      !sameOpenedFileIdentity(current, opened) || current.nlink !== 1 || current.isSymbolicLink()) {
      throw new BundledOpenCodeRuntimeError("invalid_cache");
    }
    // A crash after immutable publication can leave a verified 0600 file; finalize only this checked fd.
    if (process.platform !== "win32" && mode !== 0o500) {
      tightenPrivateDescriptorMode(fd, 0o500); fsyncSync(fd);
    }
    const after = lstatSync(binding.path);
    if (!sameOpenedFileIdentity(after, opened) || after.nlink !== 1 || after.isSymbolicLink() ||
      (process.platform !== "win32" && (after.mode & 0o777) !== 0o500)) throw new BundledOpenCodeRuntimeError("invalid_cache");
    privateDirectory(binding.directory.path);
  } finally { closeSync(fd); }
}

/** No downloads or user config. Existing corrupt/linked entries are refused, never overwritten. */
export function materializeBundledOpenCodeRuntime(
  input: BundledOpenCodeRuntimeMetadata,
  options: BundledOpenCodeMaterializeOptions = {},
): string {
  const metadata = manifest(input, options);
  try {
    const home = realpathSync.native(options.home ?? homedir()); const homeInfo = lstatSync(home); const uid = process.getuid?.();
    if (!homeInfo.isDirectory() || (uid !== undefined && homeInfo.uid !== uid)) throw new BundledOpenCodeRuntimeError("invalid_cache");
    const target = `${metadata.platform}-${metadata.arch}${metadata.libc ? `-${metadata.libc}` : ""}`;
    const subdirs = ["runtime", "coding", metadata.version, target, metadata.sha256];
    // Check ownership before the existing private-state helper tightens any preseeded component.
    let directory = home;
    for (const component of [".hara", ...subdirs]) {
      directory = join(directory, component);
      try {
        const info = lstatSync(directory);
        if (!info.isDirectory() || info.isSymbolicLink() || (uid !== undefined && info.uid !== uid)) {
          throw new BundledOpenCodeRuntimeError("invalid_cache");
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") break; throw error; }
    }
    const binding = bindPrivateHaraStateFile(home, subdirs, metadata.platform === "win32" ? "opencode.exe" : "opencode");
    // Serialize publication/final-mode transition; a peer must not observe or chmod a staged 0600 file
    // before the immutable writer has finished its own commit identity checks.
    return withPrivateStateLockSync(home, subdirs, "materialize", () => {
      try { verifiedCache(binding, metadata); return binding.path; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      let bytes: Uint8Array;
      try { bytes = (options.readAsset ?? readFileSync)(metadata.assetPath); }
      catch { throw new BundledOpenCodeRuntimeError("invalid_asset"); }
      if (!(bytes instanceof Uint8Array) || bytes.byteLength !== metadata.size ||
        createHash("sha256").update(bytes).digest("hex") !== metadata.sha256 ||
        !validOpenCodeNativeHeader(Buffer.from(bytes.subarray(0, 4096)), metadata.platform, metadata.arch)) {
        throw new BundledOpenCodeRuntimeError("invalid_asset");
      }
      writePrivateStateBytesOnceSync(binding, bytes);
      verifiedCache(binding, metadata);
      return binding.path;
    });
  } catch (error) {
    if (error instanceof BundledOpenCodeRuntimeError) throw error;
    throw new BundledOpenCodeRuntimeError("invalid_cache");
  }
}
