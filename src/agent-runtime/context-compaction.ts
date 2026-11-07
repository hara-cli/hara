import type { TurnArgs } from "../providers/types.js";
import { contextSummaryPrompt, type ContextSummary } from "../workspace/context-compaction.js";
import { CLI_TOOL_GUIDANCE } from "./tool-guidance.js";
import { plain } from "../workspace/local-state.js";
import { nativeCodexId } from "../workspace/codex-thread.js";
import { ExternalJsonlRpcRequestError, ExternalJsonlRpcTransportError, type JsonlRpcClient } from "../external-sessions/process.js";

export class NativeCompactionError extends Error {
  constructor(readonly outcome: "refused" | "unsupported" | "unknown", readonly cause?: unknown) {
    super("Native context compaction " + outcome + "; original history retained");
  }
}
/** One idle maintenance operation. Its ACK is not completion, and none of its output is user prose. */
export class CodexContextCompaction {
  private turnId?: string;
  private itemId?: string;
  private compacted = false;
  private ended = false;
  private failure?: NativeCompactionError;
  private resolve!: () => void;
  private reject!: (error: NativeCompactionError) => void;
  private readonly done = new Promise<void>((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
  constructor(private readonly input: { threadId: string; signal: AbortSignal; assertCurrent(): void; activity(): void;
    usage(params: Record<string, unknown>): void; timeoutMs?: number }) { void this.done.catch(() => {}); }
  observe(method: string, params: Record<string, unknown>): void {
    if (this.ended || params.threadId !== this.input.threadId) return;
    this.input.assertCurrent(); this.input.activity();
    const turn = plain(params.turn) ? params.turn : {};
    if (method === "turn/started" && !this.turnId && nativeCodexId(turn.id)) { this.turnId = turn.id; return; }
    const id = method === "turn/completed" ? turn.id : params.turnId;
    if (!this.turnId || id !== this.turnId) return;
    if (method === "thread/tokenUsage/updated") this.input.usage(params);
    if (method === "item/started" || method === "item/completed") {
      const item = plain(params.item) ? params.item : {};
      if (["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall"].includes(String(item.type))) {
        this.fail(new NativeCompactionError("unknown")); return;
      }
      if (item.type === "contextCompaction" && nativeCodexId(item.id)) {
        if (method === "item/started") this.itemId = item.id;
        else if (this.itemId === item.id) this.compacted = true;
      }
    }
    if (method === "thread/compacted") this.compacted = true; // 0.163's deprecated, turn-scoped notification.
    if (method === "turn/completed") {
      if (turn.status === "completed" && this.compacted) { this.ended = true; this.resolve(); }
      else this.fail(new NativeCompactionError(!this.compacted && (turn.status === "failed" || turn.status === "interrupted") ? "refused" : "unknown"));
    }
  }
  fail(error: NativeCompactionError): void { if (!this.ended) { this.ended = true; this.failure = error; this.reject(error); } }
  async run(client: JsonlRpcClient): Promise<void> {
    const abort = () => this.fail(new NativeCompactionError("unknown"));
    this.input.signal.addEventListener("abort", abort, { once: true });
    const timeoutMs = this.input.timeoutMs ?? 60_000;
    const timer = setTimeout(() => this.fail(new NativeCompactionError("unknown", new ExternalJsonlRpcTransportError(
      "Native compaction result timed out", "timeout", undefined, { rpcMethod: "thread/compact/start", rpcTimeoutMs: timeoutMs }))), timeoutMs);
    try {
      this.input.assertCurrent(); if (this.input.signal.aborted) throw new NativeCompactionError("unknown");
      try { await client.call("thread/compact/start", { threadId: this.input.threadId }); }
      catch (error) {
        if (this.failure) throw this.failure;
        const known = !this.turnId && !this.compacted && error instanceof ExternalJsonlRpcRequestError;
        throw new NativeCompactionError(known && error.code === -32601 ? "unsupported" : known ? "refused" : "unknown", error);
      }
      await this.done;
      this.input.assertCurrent(); if (this.input.signal.aborted) throw new NativeCompactionError("unknown");
    } finally { clearTimeout(timer); this.input.signal.removeEventListener("abort", abort); }
  }
}

/** A fresh one-shot process gets bounded references plus the exact current user request; original history is untouched. */
export function oneShotCompactionPrompt(args: TurnArgs, summary?: ContextSummary): string {
  const current = [...args.history].reverse().find(row => row.role === "user");
  const messages = summary ? [contextSummaryPrompt(summary), current?.role === "user" ? "Current user: " + current.content : ""]
    : args.history.map(message => message.role === "user" ? "User: " + message.content : message.role === "assistant" ? "Assistant: " + message.text : "");
  return [args.system, CLI_TOOL_GUIDANCE, ...messages].filter(Boolean).join("\n\n");
}
