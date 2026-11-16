import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { spawnSync } from "node:child_process";
import type { CredentialVault } from "./credential-vault.js";

declare const __HARA_WINDOWS_VAULT_SHA256__: string | undefined;
const MAX_FRAME = 8_500_000;
const MAX_REPLY = 65_600;
const DEADLINE_MS = 15_000;
const HELPER = "hara-credential-worker.exe";
export type CredentialVaultErrorCode = "unsupported" | "unavailable" | "access_denied" | "credential_unreadable" | "write_unconfirmed" | "cleanup_unconfirmed" | "invalid_request";
export class CredentialVaultError extends Error {
  readonly domain = "credential-vault";
  readonly retry: "none" | "explicit_user_only" | "readback_only";
  constructor(readonly code: CredentialVaultErrorCode) {
    super(`Secure credential storage: ${code}`);
    this.name = "CredentialVaultError";
    this.retry = code === "unsupported" || code === "invalid_request" ? "none" : code === "write_unconfirmed" ? "readback_only" : "explicit_user_only";
  }
}
interface Entry { ref: string; key: string }
export interface WindowsCredentialWorkerBundle { readonly path: string; readonly sha256: string }
function readBoundedFile(file: string, limit: number): Buffer {
  const fd = fs.openSync(file, "r");
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.size > limit) throw new Error();
    // One extra byte detects growth without ever allocating an unbounded readFile buffer.
    const result = Buffer.alloc(info.size + 1);
    let count = 0;
    while (count < result.length) { const n = fs.readSync(fd, result, count, result.length - count, null); if (!n) break; count += n; }
    if (count !== info.size) throw new Error();
    return result.subarray(0, count);
  } finally { fs.closeSync(fd); }
}
/** Trusted packaging boundary. Never call with a renderer, discovery or user-configured path. */
export function bundledWindowsCredentialWorker(): WindowsCredentialWorkerBundle {
  if (typeof __HARA_WINDOWS_VAULT_SHA256__ !== "undefined") {
    return { path: path.join(path.dirname(process.execPath), HELPER), sha256: __HARA_WINDOWS_VAULT_SHA256__ };
  }
  const root = fileURLToPath(new URL("../native/win32-x64/", import.meta.url));
  try {
    const raw = readBoundedFile(path.join(root, "manifest.json"), 4096);
    if (raw.length > 4096) throw new Error();
    const data: unknown = JSON.parse(raw.toString("utf8"));
    if (!data || typeof data !== "object" || !("protocolVersion" in data) || data.protocolVersion !== 1
      || !("target" in data) || data.target !== "x86_64-pc-windows-msvc"
      || !("sha256" in data) || typeof data.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(data.sha256)) throw new Error();
    return { path: path.join(root, HELPER), sha256: data.sha256 };
  } catch { throw new CredentialVaultError("unavailable"); }
}
function validRef(ref: string) { return typeof ref === "string" && /^[a-zA-Z0-9_.:-]{1,240}$/.test(ref); }
function validKey(key: string) { return typeof key === "string" && key.length > 0 && key.length <= 16384 && !/[\s\u0000-\u001f\u007f]/.test(key); }
/** S1 adapter only. Production platform factory / Host activation is a separately reviewed S2. */
export class WindowsDpapiCredentialVault implements CredentialVault {
  private readonly namespace: Buffer;
  private readonly bundle: WindowsCredentialWorkerBundle;
  constructor(home: string, bundle?: WindowsCredentialWorkerBundle) {
    try {
      if (process.platform !== "win32" || process.arch !== "x64") throw new CredentialVaultError("unsupported");
      if (!path.isAbsolute(home)) throw new Error();
      // Bind the existing canonical Host home; path aliases must not create new vault namespaces.
      const canonical = fs.realpathSync.native(home).replaceAll("/", "\\");
      if (!fs.statSync(canonical).isDirectory()) throw new Error();
      this.namespace = createHash("sha256").update("hara-host-home-v1\0").update(canonical, "utf8").digest();
      bundle ??= bundledWindowsCredentialWorker();
      if (!path.isAbsolute(bundle.path) || path.basename(bundle.path) !== HELPER || !/^[a-f0-9]{64}$/.test(bundle.sha256)) throw new Error();
      // Resolve a trusted package path once: Windows TEMP/npm paths can legitimately use 8.3 aliases.
      // The executable itself must still be a regular non-link file, and every dispatch verifies it.
      const supplied = fs.lstatSync(bundle.path);
      if (!supplied.isFile() || supplied.isSymbolicLink() || supplied.nlink !== 1) throw new Error();
      this.bundle = Object.freeze({ path: fs.realpathSync.native(bundle.path), sha256: bundle.sha256 });
    } catch (error) { if (error instanceof CredentialVaultError) throw error; throw new CredentialVaultError("unavailable"); }
  }
  private call(op: number, entries: readonly Entry[]): string | undefined {
    if (entries.length > 256 || entries.some(({ ref, key }) => !validRef(ref) || (op === 2 || op === 3 ? !validKey(key) : key !== ""))
      || new Set(entries.map(e => e.ref)).size !== entries.length
      || (op === 3 && entries.some(e => e.ref.split(":")[0] !== entries[0]?.ref.split(":")[0]))) throw new CredentialVaultError("invalid_request");
    const size = 55 + entries.reduce((sum, e) => sum + 2 + e.ref.length + 4 + e.key.length * 2, 0);
    if (size > MAX_FRAME) throw new CredentialVaultError("invalid_request");
    const request = Buffer.alloc(4 + size);
    const nonce = randomBytes(16);
    let stdout: Buffer | undefined;
    let stderr: Buffer | undefined;
    const uncertain = () => new CredentialVaultError(op === 2 || op === 3 ? "write_unconfirmed" : op === 4 ? "cleanup_unconfirmed" : "unavailable");
    try {
      const info = fs.lstatSync(this.bundle.path);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size < 1024 || info.size > 16 * 1024 * 1024
        || fs.realpathSync.native(this.bundle.path) !== path.resolve(this.bundle.path)
        || createHash("sha256").update(readBoundedFile(this.bundle.path, 16 * 1024 * 1024)).digest("hex") !== this.bundle.sha256) throw new CredentialVaultError("unavailable");
      request.writeUInt32LE(size, 0); request.write("HVQ1", 4, "ascii"); request[8] = op;
      nonce.copy(request, 9); this.namespace.copy(request, 25); request.writeUInt16LE(entries.length, 57);
      let offset = 59;
      for (const entry of entries) {
        request.writeUInt16LE(entry.ref.length, offset); offset += 2;
        offset += request.write(entry.ref, offset, "ascii"); request.writeUInt32LE(entry.key.length, offset); offset += 4;
        offset += request.write(entry.key, offset, "utf16le");
      }
      const env: NodeJS.ProcessEnv = {};
      // No provider keys, HOME/config, TMP overrides or proxy settings reach the worker.
      for (const name of ["SystemRoot", "WINDIR"]) { if (process.env[name]) env[name] = process.env[name]; }
      const result = spawnSync(this.bundle.path, [], { input: request, shell: false, windowsHide: true,
        timeout: DEADLINE_MS, maxBuffer: MAX_REPLY, stdio: ["pipe", "pipe", "pipe"], env });
      stdout = Buffer.isBuffer(result.stdout) ? result.stdout : undefined;
      stderr = Buffer.isBuffer(result.stderr) ? result.stderr : undefined;
      if (result.error || result.status !== 0 || result.signal || !stdout || stdout.length < 27 || stderr?.length) throw uncertain();
      const length = stdout.readUInt32LE(0);
      if (length !== stdout.length - 4 || length > MAX_REPLY - 4 || stdout.toString("ascii", 4, 8) !== "HVR1"
        || !timingSafeEqual(stdout.subarray(8, 24), nonce)) throw uncertain();
      const code = stdout[24]!; const count = stdout.readUInt16LE(25);
      const codes: readonly CredentialVaultErrorCode[] = ["unavailable", "invalid_request", "unavailable", "access_denied", "credential_unreadable", "write_unconfirmed", "cleanup_unconfirmed"];
      if (code !== 0) {
        if (code > 6 || count !== 0 || stdout.length !== 27) throw uncertain();
        throw new CredentialVaultError(codes[code]!);
      }
      if (op !== 1) { if (count !== 0 || stdout.length !== 27) throw uncertain(); return; }
      if (count !== 1 || stdout.length < 28) throw uncertain();
      if (stdout[27] === 0 && stdout.length === 28) return undefined;
      if (stdout[27] !== 1 || stdout.length < 32) throw uncertain();
      const units = stdout.readUInt32LE(28);
      if (units < 1 || units > 16384 || stdout.length !== 32 + units * 2) throw uncertain();
      const key = stdout.toString("utf16le", 32);
      if (!validKey(key)) throw uncertain();
      return key;
    } catch (error) { if (error instanceof CredentialVaultError) throw error; throw uncertain(); }
    finally { request.fill(0); stdout?.fill(0); stderr?.fill(0); nonce.fill(0); }
  }
  probe(): void { this.call(0, []); }
  get(ref: string): string | undefined { return this.call(1, [{ ref, key: "" }]); }
  set(ref: string, value: string): void { this.call(2, [{ ref, key: value }]); }
  setMany(entries: readonly Entry[]): void { if (entries.length) this.call(3, entries); }
  remove(ref: string): void { this.call(4, [{ ref, key: "" }]); }
}
