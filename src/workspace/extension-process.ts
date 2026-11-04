// A bounded MCP stdio transport, using the common guarded process owner/drain implementation.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join, sep } from "node:path";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { JSONRPCMessageSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { RuntimeProcessBoundary, RUNTIME_GUARD_SCRIPT, type RuntimeDrainReport } from "../agent-runtime/process-boundary.js";
import { normalizeRuntimeProxyUrl, runtimeProxyEnv } from "../security/runtime-proxy.js";
import { WorkspaceMcpError, workspaceMcpReviewPlan, assertWorkspaceMcpReviewCurrent, type ReviewedMcpSource } from "./extension-review.js";

const quote = (value: string): string => { if (/[\x00-\x1f\x7f]/u.test(value)) throw new WorkspaceMcpError("mcp_source_unreviewed"); return JSON.stringify(value); };
export function managedMcpProxy(raw: string | null): string {
  const value = normalizeRuntimeProxyUrl(raw ?? "http://127.0.0.1:18888");
  if (!value) throw new WorkspaceMcpError("mcp_proxy_unavailable");
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port) throw new WorkspaceMcpError("mcp_proxy_unavailable");
  return value;
}
/** No user login/config/env is inherited. Upstream credentials are never placed in argv or env. */
export function managedMcpEnvironment(root: string, command: string, proxy: string): NodeJS.ProcessEnv {
  return runtimeProxyEnv({ PATH: [dirname(command), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"), HOME: join(root, "home"), USERPROFILE: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "config"), XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"),
    TMPDIR: join(root, "tmp") + sep, TMP: join(root, "tmp"), TEMP: join(root, "tmp"), LANG: "C.UTF-8" }, managedMcpProxy(proxy));
}
/** Trusted packages run with isolated state and only the Workspace proxy as an outbound destination.
 * A proxy outage cannot silently become a direct connection, even for code ignoring proxy env. */
export function managedMcpProfile(input: { source: ReviewedMcpSource; root: string; accountHome: string; stateHome: string; proxy: string }): string {
  const plan = workspaceMcpReviewPlan(input.source), proxy = new URL(managedMcpProxy(input.proxy));
  // Allow only reviewed code, system support files and this child's disposable state. In particular,
  // another Workspace on an external disk must not become readable merely because it is outside HOME.
  const readable = [input.root, plan.record.packageRoot, "/System/Library", "/System/DriverKit",
    "/System/Volumes/Preboot/Cryptexes/OS/System/Library", "/System/Volumes/Preboot/Cryptexes/OS/usr/lib", "/usr/lib", "/usr/share", "/Library/Apple", "/private/var/db/timezone"]
    .map(path => `(subpath ${quote(path)})`).join(" ");
  const secrets = "(^|/)([.]env([.][^/]*)?|[.]npmrc|auth[.]json|credentials?([.][^/]*)?|secrets?([.][^/]*)?|id_rsa|id_ed25519|[.]aws|[.]ssh|Keychains)(/|$)";
  // dyld opens the root directory itself; this literal grants no descendant file data.
  return `(version 1)\n(allow default)\n(deny file-link)\n(deny file-write*)\n(allow file-write* (subpath ${quote(input.root)}))\n`
    + `(deny file-read-data)\n(allow file-read-data (literal "/") ${readable} (literal ${quote(plan.record.command)}) (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom"))\n`
    + `(deny file-read-data (regex #${quote(secrets)}) (subpath "/Library/Keychains"))\n`
    + `(deny mach-lookup (global-name "com.apple.securityd") (global-name "com.apple.secd") (global-name "com.apple.securityd.xpc"))\n`
    + `(deny network-outbound)\n(allow network-outbound (remote ip ${quote("localhost:" + proxy.port)}))\n`;
}
export class ManagedMcpStdioTransport implements Transport {
  onclose?: Transport["onclose"]; onerror?: Transport["onerror"]; onmessage?: Transport["onmessage"];
  private child?: ChildProcessWithoutNullStreams;
  private readonly boundary = new RuntimeProcessBoundary();
  private closing?: Promise<void>;
  private buffer = Buffer.alloc(0);
  private started = false; private notified = false; private failed = false;
  drainReport?: RuntimeDrainReport;
  constructor(private readonly input: { source: ReviewedMcpSource; root: string; accountHome: string; stateHome: string; proxy: string; signal: AbortSignal }) {}
  private readonly aborted = () => { void this.close().catch(() => {}); };
  async start(): Promise<void> {
    if (this.started || this.closing || this.input.signal.aborted || process.platform !== "darwin") throw new WorkspaceMcpError("mcp_call_unavailable");
    this.started = true; assertWorkspaceMcpReviewCurrent(this.input.source);
    const plan = workspaceMcpReviewPlan(this.input.source);
    this.boundary.markWrapped(); await this.boundary.prepareAttempt();
    try {
      const child = spawn("/bin/sh", ["-c", RUNTIME_GUARD_SCRIPT, "hara-native-guard", "/usr/bin/sandbox-exec", "-p", managedMcpProfile(this.input), plan.record.command, ...plan.record.args], {
        cwd: this.input.root, env: managedMcpEnvironment(this.input.root, plan.record.command, this.input.proxy), detached: true, stdio: ["pipe", "pipe", "pipe"],
      });
      this.child = child;
      child.on("error", () => this.fail());
      child.stdout.on("data", (chunk: Buffer) => this.data(chunk));
      // Never retain raw stderr: it may be attacker-controlled or contain an upstream credential.
      let stderrBytes = 0; child.stderr.on("data", (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > 64 * 1024) this.fail(); });
      child.once("close", () => { this.notifyClose(); });
      this.input.signal.addEventListener("abort", this.aborted, { once: true });
      await this.boundary.own(child, true);
      if (this.input.signal.aborted || this.failed) throw new WorkspaceMcpError("mcp_call_cancelled");
    } catch { await this.close(); throw new WorkspaceMcpError("mcp_call_unavailable"); }
  }
  private data(chunk: Buffer): void {
    if (this.closing || this.failed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > 1024 * 1024) { this.fail(); return; }
    for (;;) {
      const end = this.buffer.indexOf(10); if (end < 0) return;
      const line = this.buffer.subarray(0, end); this.buffer = this.buffer.subarray(end + 1);
      if (!line.length) continue;
      try { this.onmessage?.(JSONRPCMessageSchema.parse(JSON.parse(line.toString("utf8")))); }
      catch { this.fail(); return; }
    }
  }
  private fail(): void {
    if (this.failed) return; this.failed = true;
    this.onerror?.(new WorkspaceMcpError("mcp_call_unavailable")); void this.close().catch(() => {});
  }
  private notifyClose(): void { if (!this.notified) { this.notified = true; this.onclose?.(); } }
  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closing || !this.child || this.failed || this.input.signal.aborted) throw new WorkspaceMcpError("mcp_call_unavailable");
    const text = JSON.stringify(message) + "\n";
    if (Buffer.byteLength(text) > 64 * 1024) throw new WorkspaceMcpError("mcp_input_invalid");
    await new Promise<void>((resolve, reject) => this.child!.stdin.write(text, error => error ? reject(new WorkspaceMcpError("mcp_call_unavailable")) : resolve()));
  }
  close(): Promise<void> { return this.closing ??= (async () => {
    this.input.signal.removeEventListener("abort", this.aborted); this.child?.stdin.end();
    try { this.drainReport = await this.boundary.drain(false); await this.boundary.close(); }
    catch { throw new WorkspaceMcpError("mcp_drain_unknown"); }
    finally { this.buffer = Buffer.alloc(0); this.notifyClose(); }
  })(); }
}
