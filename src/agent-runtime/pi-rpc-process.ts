import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

/** Supplied only by the common execution policy. Pi never implements or bypasses process-tree drain. */
export interface PiProtectedProcessBoundary {
  spawn(input: { command: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string }): { child: ChildProcessWithoutNullStreams; ready: Promise<void> };
  drain(): Promise<void>;
}
type Frame = Record<string, any>;
interface Pending { command?: string; resolve(value: any): void; reject(error: Error): void; timer?: ReturnType<typeof setTimeout> }
export class PiRpcProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, Pending>();
  private readonly exited: Promise<void>;
  private readonly ready: Promise<void>;
  private readonly decoder = new StringDecoder("utf8");
  private settled?: Pending;
  private lastAssistant?: Frame;
  private line = "";
  private sequence = 0;
  private stopped = false;
  private closing?: Promise<void>;
  private protocolFailed = false;
  private stderr = "";
  constructor(private readonly input: { command: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string;
    boundary: PiProtectedProcessBoundary; configuration?: unknown; timeoutMs: number; governedPrompt?: boolean; signal: AbortSignal; onFrame(frame: Frame): void; onAccepted(): void }) {
    if (input.signal.aborted) throw new Error("interrupted");
    const owned = input.boundary.spawn(input);
    this.child = owned.child; this.ready = owned.ready;
    void this.ready.catch(() => this.protocolError());
    this.exited = new Promise(resolve => this.child.once("close", () => {
      this.stopped = true; this.reject(new Error("Pi RPC process ended before completion")); resolve();
    }));
    this.child.once("error", () => this.reject(new Error("Pi RPC spawn failed")));
    this.child.stderr.on("data", (data: Buffer) => { if (this.stderr.length < 65_536) this.stderr += data.toString("utf8").slice(0, 65_536 - this.stderr.length); });
    this.child.stdout.on("data", (data: Buffer) => this.read(this.decoder.write(data)));
    this.child.stdout.once("end", () => { const tail = this.decoder.end(); if (tail) this.read(tail); if (this.line) this.protocolError(); });
    const privatePipe = this.child.stdio[3] as import("node:stream").Writable | undefined;
    if (!privatePipe || typeof privatePipe.end !== "function") { this.protocolError(); throw new Error("Pi RPC private startup pipe unavailable"); }
    const configuration = Buffer.from(JSON.stringify(input.configuration ?? {}));
    if (configuration.length > 512 * 1024) { this.protocolError(); throw new Error("Pi RPC startup configuration exceeded limit"); }
    privatePipe.on("error", () => this.protocolError());
    privatePipe.end(configuration, () => configuration.fill(0));
    input.signal.addEventListener("abort", this.abort, { once: true });
  }
  private abort = (): void => { void this.close().catch(() => {}); };
  private reject(error: Error): void {
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
    if (this.settled) { clearTimeout(this.settled.timer); this.settled.reject(error); this.settled = undefined; }
  }
  private protocolError(): void {
    this.protocolFailed = true; this.reject(new Error("Pi RPC protocol refused")); void this.close().catch(() => {});
  }
  private read(chunk: string): void {
    if (this.protocolFailed) return;
    this.line += chunk;
    if (Buffer.byteLength(this.line) > 4 * 1024 * 1024) return this.protocolError();
    for (;;) {
      const end = this.line.indexOf("\n"); if (end < 0) break;
      const line = this.line.slice(0, end).replace(/\r$/, ""); this.line = this.line.slice(end + 1);
      if (!line) continue;
      let frame: Frame; try { frame = JSON.parse(line); } catch { return this.protocolError(); }
      if (!frame || typeof frame !== "object" || Array.isArray(frame)) return this.protocolError();
      try {
      if (frame.type === "response") {
        const item = this.pending.get(frame.id);
        if (!item) continue;
        if (frame.command !== item.command) return this.protocolError();
        this.pending.delete(frame.id); clearTimeout(item.timer);
        if (frame.success === true) {
          if (frame.command === "prompt" && frame.data?.disposition !== "handled") this.input.onAccepted();
          item.resolve(frame.data);
        } else item.reject(new Error("Pi RPC command refused"));
      } else {
        if (frame.type === "message_end" && frame.message?.role === "assistant") this.lastAssistant = frame.message;
        this.input.onFrame(frame);
        if (frame.type === "agent_settled" && this.settled) {
          const pending = this.settled; this.settled = undefined; clearTimeout(pending.timer); pending.resolve(frame);
        }
      }
      } catch { return this.protocolError(); }
    }
  }
  private async command(type: "get_state" | "get_session_stats" | "compact" | "prompt" | "abort", fields: Record<string, unknown> = {}): Promise<any> {
    await this.ready;
    if (this.stopped || this.protocolFailed) return Promise.reject(new Error("Pi RPC unavailable"));
    const id = "hara-pi-" + ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("Pi RPC timeout")); void this.close().catch(() => {}); }, this.input.timeoutMs);
      this.pending.set(id, { command: type, resolve, reject, timer });
      // At most one prompt and two small control records are outstanding; honor writable backpressure.
      this.child.stdin.write(JSON.stringify({ id, type, ...fields }) + "\n", error => { if (error) this.reject(new Error("Pi RPC input failed")); });
    });
  }
  async state(): Promise<Frame> {
    const state = await this.command("get_state");
    if (state?.model?.provider !== "hara" || state.model.id !== "coding" || state.autoCompactionEnabled !== false) throw new Error("Pi RPC model authority changed");
    return state;
  }
  async contextTokens(): Promise<number | null> {
    const stats = await this.command("get_session_stats");
    const tokens = stats?.contextUsage?.tokens;
    if (tokens === null || tokens === undefined) return null;
    if (!Number.isSafeInteger(tokens) || tokens < 0) throw new Error("Pi context telemetry refused");
    return tokens;
  }
  /** SDK manual compact aborts first: never issue it while a stream, queue or another compact is active. */
  async compact(customInstructions: string): Promise<{ tokensBefore: number; estimatedTokensAfter: number | null }> {
    const state = await this.state();
    if (this.settled || state.isStreaming !== false || state.isCompacting !== false || state.pendingMessageCount !== 0
      || this.input.signal.aborted || Buffer.byteLength(customInstructions) > 16_000) throw new Error("Pi compaction requires idle");
    const result = await this.command("compact", { customInstructions });
    if (typeof result?.summary !== "string" || Buffer.byteLength(result.summary) > 256 * 1024 || !result.summary.trim()
      || typeof result.firstKeptEntryId !== "string" || !result.firstKeptEntryId.length || result.firstKeptEntryId.length > 200
      || !Number.isSafeInteger(result.tokensBefore) || result.tokensBefore < 0
      || result.estimatedTokensAfter !== undefined && (!Number.isSafeInteger(result.estimatedTokensAfter) || result.estimatedTokensAfter < 0))
      throw new Error("Pi compaction receipt refused");
    const after = await this.state();
    if (after.isStreaming !== false || after.isCompacting !== false || after.pendingMessageCount !== 0) throw new Error("Pi compaction did not settle");
    // The opaque SDK summary remains in its append-only native session, never in Hara view/log data.
    return { tokensBefore: result.tokensBefore, estimatedTokensAfter: result.estimatedTokensAfter ?? null };
  }
  async prompt(message: string): Promise<{ text: string; state: Frame }> {
    if (this.settled || this.input.signal.aborted || Buffer.byteLength(message) > 256 * 1024) throw new Error("Pi RPC prompt refused");
    this.lastAssistant = undefined;
    const done = new Promise((resolve, reject) => {
      const timer = this.input.governedPrompt ? undefined : setTimeout(() => { this.reject(new Error("Pi RPC turn timeout")); void this.close().catch(() => {}); }, this.input.timeoutMs);
      this.settled = { resolve, reject, timer };
    });
    void done.catch(() => {});
    try {
      const ack = await this.command("prompt", { message });
      if (ack?.disposition === "handled") throw new Error("Pi RPC prompt did not start a turn");
      const result: any = await done;
      const assistant = this.lastAssistant as Frame | undefined;
      if (result.aborted || this.input.signal.aborted || !assistant || ["error", "aborted"].includes(assistant.stopReason)) throw new Error("Pi RPC model failed");
      const text = Array.isArray(assistant.content) ? assistant.content.filter((part: any) => part.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("") : "";
      if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error("Pi RPC output exceeded limit");
      return { text, state: await this.state() };
    } catch (error) { this.reject(error instanceof Error ? error : new Error("Pi RPC failed")); throw error; }
  }
  /** Stderr may be inspected for allowlisted classification only, never returned to UI/logs. */
  classify<T>(project: (stderr: string) => T): T { return project(this.stderr); }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.input.signal.removeEventListener("abort", this.abort);
      this.reject(new Error("interrupted"));
      if (!this.stopped) this.child.stdin.end();
      // Registration owns the STOP/CONT guard. Even failure is joined before common-layer drain.
      await this.ready.catch(() => {});
      try { await this.input.boundary.drain(); } finally { await this.exited; this.stderr = ""; this.line = ""; }
    })();
  }
}
