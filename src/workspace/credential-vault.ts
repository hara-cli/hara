import { spawnSync } from "node:child_process";
import { withPrivateStateLockSync } from "../security/private-state.js";
import { coreText } from "../i18n/messages.js";

export const WORKSPACE_CREDENTIAL_SERVICE = "tech.nanhara.hara.workspace.credentials.v1";
export interface CredentialVault { get(ref: string): string | undefined; set(ref: string, value: string): void; remove(ref: string): void;
  setMany?(entries: readonly { ref: string; key: string }[]): void }
export class MemoryCredentialVault implements CredentialVault {
  private readonly values = new Map<string, string>();
  get(ref: string) { return this.values.get(ref); }
  set(ref: string, value: string) { this.values.set(ref, value); }
  setMany(entries: readonly { ref: string; key: string }[]) { for (const entry of entries) this.values.set(entry.ref, entry.key); }
  remove(ref: string) { this.values.delete(ref); }
}
interface CommandResult { status: number | null; stdout?: string | Buffer; stderr?: string | Buffer }
type Execute = (command: string, args: string[], options: { input?: string; env: NodeJS.ProcessEnv; timeout: number; encoding: "utf8"; stdio: ["pipe", "pipe", "pipe"] }) => CommandResult;
/** No secret argv, files, diagnostics or insecure plaintext fallback. All command output stays private. */
export class MacKeychainCredentialVault implements CredentialVault {
  constructor(private readonly home: string, private readonly execute: Execute = spawnSync) {}
  private run(args: string[], input?: string) {
    if (process.platform !== "darwin") throw new Error("OS credential vault unavailable; no plaintext fallback");
    try { return this.execute("/usr/bin/security", args, { input, encoding: "utf8", timeout: 3000,
      stdio: ["pipe", "pipe", "pipe"], env: { HOME: this.home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } }); }
    catch { throw new Error("OS credential operation could not start; original settings preserved"); }
  }
  private ref(ref: string) {
    // A bare vault.* legacy account aliases another scope's grouped item. Never touch either
    // namespace (including its lock) when the item type cannot be distinguished safely.
    if (!/^[a-zA-Z0-9_.:-]{1,240}$/.test(ref) || ref.startsWith("vault.") && !ref.includes(":")) throw new Error("Invalid credential reference");
    return ref;
  }
  private account(ref: string) { return `vault.${this.ref(ref).split(":")[0]}`; }
  private group(ref: string): Record<string, string> {
    const result = this.run(["find-generic-password", "-s", WORKSPACE_CREDENTIAL_SERVICE, "-a", this.account(ref), "-w"]);
    if (result.status === 44) return {};
    if (result.status !== 0) throw new Error("OS credential unavailable; original settings preserved");
    try { const value = JSON.parse(String(result.stdout ?? ""));
      if (!value || value.schemaVersion !== 1 || !value.values || typeof value.values !== "object" || Array.isArray(value.values)
        || Object.entries(value.values).some(([key, secret]) => this.account(key) !== this.account(ref) || typeof secret !== "string" || !secret)) throw new Error();
      return value.values;
    } catch { throw new Error("OS credential record unavailable; original settings preserved"); }
  }
  get(ref: string): string | undefined {
    const grouped = this.group(ref);
    if (Object.hasOwn(grouped, ref)) return grouped[ref];
    // Read-only compatibility with older, individual Keychain entries; never copies them implicitly.
    const result = this.run(["find-generic-password", "-s", WORKSPACE_CREDENTIAL_SERVICE, "-a", this.ref(ref), "-w"]);
    if (result.status === 44) return undefined;
    if (result.status !== 0) throw new Error("OS credential unavailable; original settings preserved");
    return String(result.stdout ?? "").replace(/\r?\n$/, "");
  }
  set(ref: string, value: string): void {
    this.setMany([{ ref, key: value }]);
  }
  setMany(entries: readonly { ref: string; key: string }[]): void {
    if (!entries.length) return;
    const account = this.account(entries[0]!.ref);
    if (entries.length > 256 || entries.some(({ ref, key }) => this.account(ref) !== account || !key || key.length > 16384 || /[\s\u0000-\u001f\u007f]/.test(key))) throw new Error("Invalid credential batch");
    return withPrivateStateLockSync(this.home, ["workspace-credential-locks"], account, () => {
    const values = { ...this.group(entries[0]!.ref) };
    for (const { ref, key } of entries) values[ref] = key;
    const payload = JSON.stringify({ schemaVersion: 1, values });
    // security interactive commands are piped, not TTY-echoed; capture/discard all output. The key is
    // absent from process argv and never written to a script/temp file. Verify without logging it.
    // Exactly one Keychain item/write for the entire scope batch, not one permission prompt per row.
    const line = `add-generic-password -U -s ${WORKSPACE_CREDENTIAL_SERVICE} -a ${account} -w ${JSON.stringify(payload)}\n`;
    const result = this.run(["-i"], line);
    if (result.status !== 0) throw new Error("OS credential save was not confirmed; no configuration was changed");
    const saved = this.group(entries[0]!.ref);
    if (entries.some(({ ref, key }) => saved[ref] !== key)) throw new Error("OS credential save was not confirmed; no configuration was changed");
    });
  }
  remove(ref: string): void {
    return withPrivateStateLockSync(this.home, ["workspace-credential-locks"], this.account(ref), () => {
    const values = this.group(ref);
    if (Object.hasOwn(values, ref)) {
      delete values[ref];
      const result = this.run(["-i"], `add-generic-password -U -s ${WORKSPACE_CREDENTIAL_SERVICE} -a ${this.account(ref)} -w ${JSON.stringify(JSON.stringify({ schemaVersion: 1, values }))}\n`);
      if (result.status !== 0 || Object.hasOwn(this.group(ref), ref)) throw new Error("OS credential removal was not confirmed; refresh before retrying");
    }
    const result = this.run(["delete-generic-password", "-s", WORKSPACE_CREDENTIAL_SERVICE, "-a", this.ref(ref)]);
    if (result.status !== 0 && result.status !== 44) throw new Error("OS credential removal was not confirmed; refresh before retrying");
    });
  }
}

export const CREDENTIAL_STORAGE_CAPABILITY = "workspace.credential-storage.v1";
export type CredentialStorageReason = "platform_unsupported" | "architecture_unsupported" | "host_binding_unavailable"
  | "helper_missing" | "helper_invalid" | "access_denied" | "backend_unavailable" | "windows_desktop_required";
export type CredentialVaultErrorCode = "unsupported" | "unavailable" | "access_denied" | "credential_unreadable"
  | "write_unconfirmed" | "cleanup_unconfirmed" | "invalid_request";

export class CredentialVaultError extends Error {
  readonly domain = "credential-vault";
  readonly retry: "none" | "explicit_user_only" | "readback_only";
  constructor(readonly code: CredentialVaultErrorCode, readonly reason?: CredentialStorageReason, readonly definitelyUnwritten = false) {
    super(code === "unsupported" && reason === "windows_desktop_required"
      ? coreText("core.credentialStorage.windowsDesktopRequired")
      : `Secure credential storage: ${code}`);
    this.name = "CredentialVaultError";
    this.retry = code === "unsupported" || code === "invalid_request" ? "none"
      : code === "write_unconfirmed" ? "readback_only" : "explicit_user_only";
  }
}

export interface CredentialStorageDescriptor {
  schemaVersion: 1;
  hostPlatform: "darwin" | "win32" | "linux" | "other";
  arch: string;
  backend: "macos-keychain" | "windows-dpapi" | "none";
  supported: boolean;
  state: "not_checked" | "ready" | "unavailable" | "unsupported";
  reason: CredentialStorageReason | null;
}
export interface CredentialEntry { readonly ref: string; readonly key: string }
export interface CredentialCall {
  signal?: AbortSignal;
  assertCurrent?: () => void;
  /** Record the worker identity before its private stdin is allowed to carry a write. */
  recordWorker?: (pid: number) => void;
  /** The namespace lane stays occupied until its worker and streams have closed. */
  retainUntilDrained?: (done: Promise<void>) => void;
}
export interface AsyncCredentialVault {
  get(ref: string, call?: CredentialCall): Promise<string | undefined>;
  set(ref: string, key: string, call?: CredentialCall): Promise<void>;
  setMany(entries: readonly CredentialEntry[], call?: CredentialCall): Promise<void>;
  remove(ref: string, call?: CredentialCall): Promise<void>;
}

export const credentialDeadline = () => AbortSignal.timeout(30_000);
export function assertCredentialCall(call?: CredentialCall): void {
  if (call?.signal?.aborted) throw new CredentialVaultError("unavailable", undefined, true);
  call?.assertCurrent?.();
}
export const validCredentialKey = (key: unknown): key is string => typeof key === "string" && key.length > 0
  && key.length <= 16384 && !/[\s\u0000-\u001f\u007f]/u.test(key);
