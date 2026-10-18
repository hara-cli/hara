import { spawnSync } from "node:child_process";

export const WORKSPACE_CREDENTIAL_SERVICE = "tech.nanhara.hara.workspace.credentials.v1";
export interface CredentialVault { get(ref: string): string | undefined; set(ref: string, value: string): void; remove(ref: string): void }
export class MemoryCredentialVault implements CredentialVault {
  private readonly values = new Map<string, string>();
  get(ref: string) { return this.values.get(ref); }
  set(ref: string, value: string) { this.values.set(ref, value); }
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
  private ref(ref: string) { if (!/^[a-zA-Z0-9_.:-]{1,240}$/.test(ref)) throw new Error("Invalid credential reference"); return ref; }
  get(ref: string): string | undefined {
    const result = this.run(["find-generic-password", "-s", WORKSPACE_CREDENTIAL_SERVICE, "-a", this.ref(ref), "-w"]);
    if (result.status === 44) return undefined;
    if (result.status !== 0) throw new Error("OS credential unavailable; original settings preserved");
    return String(result.stdout ?? "").replace(/\r?\n$/, "");
  }
  set(ref: string, value: string): void {
    if (!value || value.length > 16384 || /[\s\u0000-\u001f\u007f]/.test(value)) throw new Error("Invalid credential");
    // security interactive commands are piped, not TTY-echoed; capture/discard all output. The key is
    // absent from process argv and never written to a script/temp file. Verify without logging it.
    const line = `add-generic-password -U -s ${WORKSPACE_CREDENTIAL_SERVICE} -a ${this.ref(ref)} -w ${JSON.stringify(value)}\n`;
    const result = this.run(["-i"], line);
    if (result.status !== 0 || this.get(ref) !== value) throw new Error("OS credential save was not confirmed; no configuration was changed");
  }
  remove(ref: string): void {
    const result = this.run(["delete-generic-password", "-s", WORKSPACE_CREDENTIAL_SERVICE, "-a", this.ref(ref)]);
    if (result.status !== 0 && result.status !== 44) throw new Error("OS credential removal was not confirmed; refresh before retrying");
  }
}
