import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { CredentialVaultError, assertCredentialCall, validCredentialKey, type CredentialVault, type CredentialVaultErrorCode,
  type AsyncCredentialVault, type CredentialCall, type CredentialEntry } from "./credential-vault.js";

export { CredentialVaultError, type CredentialVaultErrorCode } from "./credential-vault.js";

declare const __HARA_WINDOWS_VAULT_SHA256__: string | undefined;
const MAX_FRAME = 8_500_000;
const MAX_REPLY = 65_600;
const DEADLINE_MS = 15_000;
const HELPER = "hara-credential-worker.exe";
export interface WindowsCredentialWorkerBundle { readonly path: string; readonly sha256: string; readonly protocolVersion?: 1 | 2 }
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
    return { path: path.join(path.dirname(process.execPath), HELPER), sha256: __HARA_WINDOWS_VAULT_SHA256__, protocolVersion: 2 };
  }
  const root = fileURLToPath(new URL("../native/win32-x64/", import.meta.url));
  try {
    const raw = readBoundedFile(path.join(root, "manifest.json"), 4096);
    if (raw.length > 4096) throw new Error();
    const data: unknown = JSON.parse(raw.toString("utf8"));
    if (!data || typeof data !== "object" || !("protocolVersion" in data) || (data.protocolVersion !== 1 && data.protocolVersion !== 2)
      || !("target" in data) || data.target !== "x86_64-pc-windows-msvc"
      || !("sha256" in data) || typeof data.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(data.sha256)) throw new Error();
    return { path: path.join(root, HELPER), sha256: data.sha256, protocolVersion: data.protocolVersion };
  } catch (error) {
    throw new CredentialVaultError("unavailable", (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "helper_missing" : "helper_invalid");
  }
}
function validRef(ref: string) { return typeof ref === "string" && /^[a-zA-Z0-9_.:-]{1,240}$/.test(ref); }
const writeOp = (op: number) => op === 2 || op === 3;
const uncertain = (op: number) => new CredentialVaultError(writeOp(op) ? "write_unconfirmed" : op === 4 ? "cleanup_unconfirmed" : "unavailable");

function bindWorker(home: string, bundle?: WindowsCredentialWorkerBundle) {
  if (process.platform !== "win32" || process.arch !== "x64") throw new CredentialVaultError("unsupported");
  let namespace: Buffer;
  try {
    if (!path.isAbsolute(home)) throw new Error();
    const physical = fs.realpathSync.native(home);
    if (!fs.statSync(physical).isDirectory()) throw new Error();
    const canonical = physical.replaceAll("/", "\\");
    namespace = createHash("sha256").update("hara-host-home-v1\0").update(canonical, "utf8").digest();
  } catch { throw new CredentialVaultError("unavailable", "host_binding_unavailable"); }
  bundle ??= bundledWindowsCredentialWorker();
  try {
    if (!path.isAbsolute(bundle.path) || path.basename(bundle.path) !== HELPER || !/^[a-f0-9]{64}$/.test(bundle.sha256)) throw new Error();
    const supplied = fs.lstatSync(bundle.path);
    if (!supplied.isFile() || supplied.isSymbolicLink() || supplied.nlink !== 1) throw new Error();
    return { namespace, bundle: Object.freeze({ ...bundle, path: fs.realpathSync.native(bundle.path) }) };
  } catch (error) {
    throw new CredentialVaultError("unavailable", (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "helper_missing" : "helper_invalid");
  }
}

function requestFrame(op: number, entries: readonly CredentialEntry[], namespace: Buffer, nonce: Buffer, version: 1 | 2) {
  if (entries.length > 256 || entries.some(({ ref, key }) => !validRef(ref) || (writeOp(op) ? !validCredentialKey(key) : key !== ""))
    || new Set(entries.map(e => e.ref)).size !== entries.length
    || (op === 3 && entries.some(e => e.ref.split(":")[0] !== entries[0]?.ref.split(":")[0]))) throw new CredentialVaultError("invalid_request", undefined, true);
  const size = 55 + entries.reduce((sum, e) => sum + 2 + e.ref.length + 4 + e.key.length * 2, 0);
  if (size > MAX_FRAME) throw new CredentialVaultError("invalid_request", undefined, true);
  const request = Buffer.alloc(4 + size);
  request.writeUInt32LE(size, 0); request.write(version === 2 ? "HVQ2" : "HVQ1", 4, "ascii"); request[8] = op;
  nonce.copy(request, 9); namespace.copy(request, 25); request.writeUInt16LE(entries.length, 57);
  let offset = 59;
  for (const entry of entries) {
    request.writeUInt16LE(entry.ref.length, offset); offset += 2;
    offset += request.write(entry.ref, offset, "ascii"); request.writeUInt32LE(entry.key.length, offset); offset += 4;
    offset += request.write(entry.key, offset, "utf16le");
  }
  return request;
}

const LOCK_BUSY = Symbol("before-store-lock");
const codes: readonly CredentialVaultErrorCode[] = ["unavailable", "invalid_request", "unavailable", "access_denied",
  "credential_unreadable", "write_unconfirmed", "cleanup_unconfirmed"];
function replyFrame(op: number, stdout: Buffer, nonce: Buffer, version: 1 | 2): string | undefined | typeof LOCK_BUSY {
  if (stdout.length < 27 || stdout.length > MAX_REPLY || stdout.readUInt32LE(0) !== stdout.length - 4
    || stdout.toString("ascii", 4, 8) !== (version === 2 ? "HVR2" : "HVR1")
    || !timingSafeEqual(stdout.subarray(8, 24), nonce)) throw uncertain(op);
  const code = stdout[24]!, count = stdout.readUInt16LE(25);
  if (code !== 0) {
    if (count !== 0 || stdout.length !== 27 || code > (version === 2 ? 9 : 6)) throw uncertain(op);
    if (code === 7) return LOCK_BUSY;
    if (code === 8) throw new CredentialVaultError("unavailable", "host_binding_unavailable", true);
    if (code === 9) throw new CredentialVaultError("unavailable", "backend_unavailable", true);
    throw new CredentialVaultError(codes[code]!);
  }
  if (op !== 1) { if (count !== 0 || stdout.length !== 27) throw uncertain(op); return; }
  if (count !== 1 || stdout.length < 28) throw uncertain(op);
  if (stdout[27] === 0 && stdout.length === 28) return undefined;
  if (stdout[27] !== 1 || stdout.length < 32) throw uncertain(op);
  const units = stdout.readUInt32LE(28);
  if (units < 1 || units > 16384 || stdout.length !== 32 + units * 2) throw uncertain(op);
  const key = stdout.toString("utf16le", 32);
  if (!validCredentialKey(key)) throw uncertain(op);
  return key;
}
function workerOptions() {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["SystemRoot", "WINDIR"]) if (process.env[name]) env[name] = process.env[name];
  return { shell: false, windowsHide: true, env, stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"] };
}
function validWorkerFile(info: fs.Stats) {
  return info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size >= 1024 && info.size <= 16 * 1024 * 1024;
}

/** Compatibility for S1's standalone probes and synchronous consumers. */
export class WindowsDpapiCredentialVault implements CredentialVault {
  private readonly worker: ReturnType<typeof bindWorker>;
  constructor(home: string, bundle?: WindowsCredentialWorkerBundle) { this.worker = bindWorker(home, bundle); }
  private call(op: number, entries: readonly CredentialEntry[]): string | undefined {
    const { bundle, namespace } = this.worker;
    const nonce = randomBytes(16), request = requestFrame(op, entries, namespace, nonce, 1);
    let stdout: Buffer | undefined, stderr: Buffer | undefined;
    try {
      if (!validWorkerFile(fs.lstatSync(bundle.path)) || fs.realpathSync.native(bundle.path) !== path.resolve(bundle.path)
        || createHash("sha256").update(readBoundedFile(bundle.path, 16 * 1024 * 1024)).digest("hex") !== bundle.sha256)
        throw new CredentialVaultError("unavailable", "helper_invalid");
      const result = spawnSync(bundle.path, [], { ...workerOptions(), input: request, timeout: DEADLINE_MS, maxBuffer: MAX_REPLY });
      stdout = Buffer.isBuffer(result.stdout) ? result.stdout : undefined;
      stderr = Buffer.isBuffer(result.stderr) ? result.stderr : undefined;
      if (result.error || result.status !== 0 || result.signal || !stdout || stderr?.length) throw uncertain(op);
      const value = replyFrame(op, stdout, nonce, 1);
      if (value === LOCK_BUSY) throw uncertain(op);
      return value;
    } catch (error) { if (error instanceof CredentialVaultError) throw error; throw uncertain(op); }
    finally { request.fill(0); stdout?.fill(0); stderr?.fill(0); nonce.fill(0); }
  }
  probe(): void { this.call(0, []); }
  get(ref: string): string | undefined { return this.call(1, [{ ref, key: "" }]); }
  set(ref: string, key: string): void { this.call(2, [{ ref, key }]); }
  setMany(entries: readonly CredentialEntry[]): void { if (entries.length) this.call(3, entries); }
  remove(ref: string): void { this.call(4, [{ ref, key: "" }]); }
}

async function verifyWorker(bundle: WindowsCredentialWorkerBundle) {
  try {
    const { lstat, realpath, open } = fs.promises, info = await lstat(bundle.path);
    if (!validWorkerFile(info) || await realpath(bundle.path) !== path.resolve(bundle.path)) throw new Error();
    const file = await open(bundle.path, "r");
    try {
      const before = await file.stat();
      if (!validWorkerFile(before) || before.dev !== info.dev || before.ino !== info.ino) throw new Error();
      const data = Buffer.alloc(before.size + 1);
      let count = 0;
      while (count < data.length) {
        const { bytesRead } = await file.read(data, count, data.length - count, count);
        if (!bytesRead) break;
        count += bytesRead;
      }
      if (count !== before.size || createHash("sha256").update(data.subarray(0, count)).digest("hex") !== bundle.sha256) throw new Error();
    } finally { await file.close(); }
  } catch (error) {
    throw new CredentialVaultError("unavailable", (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "helper_missing" : "helper_invalid");
  }
}

/** Cancellation before stdin starts is known empty. After that point a write is uncertain. */
function exchange(bundle: WindowsCredentialWorkerBundle, request: Buffer, nonce: Buffer, op: number, signal: AbortSignal,
  call?: CredentialCall): Promise<string | undefined | typeof LOCK_BUSY> {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(bundle.path, [], workerOptions()); }
    catch { request.fill(0); reject(new CredentialVaultError("unavailable", undefined, true)); return; }
    let settleDrain!: () => void;
    const drained = new Promise<void>(resolveDrain => { settleDrain = resolveDrain; });
    call?.retainUntilDrained?.(drained);
    const chunks: Buffer[] = [];
    let size = 0, sent = false, settled = false;
    const stop = (error: unknown) => {
      if (settled) return;
      settled = true;
      child.stdin.destroy();
      try { child.kill("SIGKILL"); } catch { /* A live PID remains in the durable write intent. */ }
      reject(error);
    };
    const interrupted = () => stop(sent ? uncertain(op) : new CredentialVaultError("unavailable", undefined, true));
    signal.addEventListener("abort", interrupted, { once: true });
    child.once("spawn", () => {
      if (settled || signal.aborted) { interrupted(); return; }
      try {
        assertCredentialCall(call);
        if (writeOp(op) && call?.recordWorker) {
          if (!child.pid) throw new CredentialVaultError("unavailable");
          call.recordWorker(child.pid);
        }
        sent = true;
        child.stdin.end(request, () => { request.fill(0); });
      } catch (error) { stop(sent ? uncertain(op) : error); }
    });
    child.stdin.on("error", interrupted);
    child.on("error", interrupted);
    child.stdout.on("data", (buffer: Buffer) => {
      if (!settled && size + buffer.length <= MAX_REPLY) { chunks.push(buffer); size += buffer.length; }
      else { buffer.fill(0); interrupted(); }
    });
    child.stderr.on("data", (buffer: Buffer) => { buffer.fill(0); interrupted(); });
    child.once("close", (code, exitSignal) => {
      const output = Buffer.concat(chunks, size);
      try {
        if (settled) return;
        if (code !== 0 || exitSignal) throw sent ? uncertain(op) : new CredentialVaultError("unavailable", undefined, true);
        resolve(replyFrame(op, output, nonce, 2));
      } catch (error) { reject(error); }
      finally {
        settled = true;
        signal.removeEventListener("abort", interrupted);
        output.fill(0); for (const chunk of chunks) chunk.fill(0);
        request.fill(0);
        settleDrain();
      }
    });
    if (signal.aborted) interrupted();
  });
}
function beforeAbort<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const stop = () => reject(new CredentialVaultError("unavailable", undefined, true));
    signal.addEventListener("abort", stop, { once: true });
    task.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
    if (signal.aborted) stop();
  });
}

/** For the Host's serialized namespace lane only. No sync process launch or sync binary reads. */
export class AsyncWindowsDpapiCredentialVault implements AsyncCredentialVault {
  private readonly worker: ReturnType<typeof bindWorker>;
  constructor(home: string, bundle?: WindowsCredentialWorkerBundle) {
    this.worker = bindWorker(home, bundle);
    if (this.worker.bundle.protocolVersion !== 2) throw new CredentialVaultError("unavailable", "helper_invalid");
  }
  private async call(op: number, entries: readonly CredentialEntry[], call?: CredentialCall): Promise<string | undefined> {
    assertCredentialCall(call);
    const { bundle, namespace } = this.worker;
    const workerDeadline = AbortSignal.timeout(DEADLINE_MS);
    const signal = call?.signal ? AbortSignal.any([call.signal, workerDeadline]) : workerDeadline;
    const backoffUntil = performance.now() + 1000;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (signal.aborted) throw new CredentialVaultError("unavailable", undefined, true);
      const attemptSignal = attempt === 0 ? signal : AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.floor(backoffUntil - performance.now())))]);
      try { await beforeAbort(verifyWorker(bundle), attemptSignal); }
      catch (error) { throw new CredentialVaultError("unavailable", error instanceof CredentialVaultError ? error.reason : undefined, true); }
      assertCredentialCall(call);
      const nonce = randomBytes(16);
      let value: string | undefined | typeof LOCK_BUSY;
      try { value = await exchange(bundle, requestFrame(op, entries, namespace, nonce, 2), nonce, op, attemptSignal, call); }
      finally { nonce.fill(0); }
      if (value !== LOCK_BUSY) return value;
      const wait = 60 * (attempt + 1);
      if (attempt === 2 || performance.now() + wait > backoffUntil) break;
      try { await delay(wait, undefined, { signal }); } catch { break; }
      if (performance.now() >= backoffUntil) break;
    }
    throw new CredentialVaultError("unavailable", undefined, writeOp(op));
  }
  get(ref: string, call?: CredentialCall) { return this.call(1, [{ ref, key: "" }], call); }
  async set(ref: string, key: string, call?: CredentialCall) { await this.call(2, [{ ref, key }], call); }
  async setMany(entries: readonly CredentialEntry[], call?: CredentialCall) { if (entries.length) await this.call(3, entries, call); }
  async remove(ref: string, call?: CredentialCall) { await this.call(4, [{ ref, key: "" }], call); }
}
