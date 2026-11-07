import { RUNTIME_STAGE_ERROR_KINDS, type RuntimeStageErrorKind, type RuntimeStageRecorder } from "../workspace/runtime-stage-events.js";

// Same closed vocabulary as the independent failure-diagnostics slice. No raw message
// or payload field enters an event; integration may replace this adapter with its parser.
const KINDS: ReadonlySet<string> = new Set(RUNTIME_STAGE_ERROR_KINDS);
const FAILURE_MARKER = "hara_runtime_failure_v1=";
export function runtimeStageErrorKind(value: unknown): RuntimeStageErrorKind {
  const message = value instanceof Error ? value.message : typeof value === "string" ? value : "";
  if (KINDS.has(message)) return message as RuntimeStageErrorKind;
  // This Host control status changes recovery UX, not the underlying observed error category.
  if (message === "native_resume_timeout") return "timeout";
  const marker = message.indexOf(FAILURE_MARKER);
  if (marker >= 0 && message.length < 4096) {
    // The governor may append a human hint after the envelope. Scan the single flat object,
    // respecting quoted braces, rather than parsing that hint or guessing from arbitrary prose.
    const source = message.slice(marker + FAILURE_MARKER.length);
    let quoted = false, escaped = false, start = 0;
    const keys = new Set<string>();
    if (source[0] !== "{" || message.indexOf(FAILURE_MARKER, marker + FAILURE_MARKER.length) >= 0) return "runtime_failed";
    for (let i = 1; i < source.length; i++) {
      const c = source[i];
      if (c === "\n" || c === "\r") break;
      if (quoted) {
        if (escaped) { escaped = false; continue; }
        if (c === "\\") { escaped = true; continue; }
        if (c === '"') {
          quoted = false;
          if (/^\s*:/.test(source.slice(i + 1))) {
            try { const key: string = JSON.parse(source.slice(start, i + 1)); if (keys.has(key)) return "runtime_failed"; keys.add(key); }
            catch { return "runtime_failed"; }
          }
        }
      } else if (c === '"') { quoted = true; start = i; }
      else if (c === "{" || c === "[") break;
      else if (c === "}") {
        try { const data = JSON.parse(source.slice(0, i + 1)); if (KINDS.has(data?.kind)) return data.kind; } catch { /* Unknown stays unknown. */ }
        break;
      }
    }
  }
  const code = /registered Runtime failed \(([a-z_]{1,64})\)/.exec(message)?.[1];
  if (code && KINDS.has(code)) return code as RuntimeStageErrorKind;
  if (code === "command_not_found") return "not_installed";
  return "runtime_failed";
}

const observe = <T>(fn: () => T): T | undefined => { try { return fn(); } catch { return undefined; } };
/** Observe only protocol discriminators and content presence in a bounded temporary line
 * buffer. A lifecycle frame is never a token, and content is never retained in the report. */
export function createRuntimeStageProcessObserver(recorder: RuntimeStageRecorder | undefined,
  runtime: "codex" | "claude" | "opencode" | "gemini" | "kimi" | "copilot" | "cursor" | "grok", signal: AbortSignal) {
  let closed = false, spawned = false, ready = false, sawOutput = false, sawToken = false;
  let line = "", dropping = false;
  const endSpawn = observe(() => recorder?.beginEvent("spawn"));
  const endCold = runtime === "codex" ? observe(() => recorder?.beginEvent("cold_start", { source: "native_event" })) : undefined;
  const mark = (kind: "first_token" | "first_output", source: "host" | "native_event") => {
    if (closed || signal.aborted || (kind === "first_token" ? sawToken : sawOutput)) return;
    if (kind === "first_token") sawToken = true; else sawOutput = true;
    observe(() => recorder?.mark(kind, source));
  };
  const frame = (text: string) => {
    if (closed || signal.aborted || !recorder) return;
    let value: any; try { value = JSON.parse(text); } catch { return; }
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    if (runtime === "codex") {
      if (value.type === "thread.started" && typeof value.thread_id === "string" && !ready) {
        ready = true; observe(() => endCold?.("completed"));
      }
      if (value.type === "response.output_text.delta" && typeof value.delta === "string" && value.delta.length) mark("first_token", "native_event");
      if ((value.type === "item.completed" || value.type === "item.updated") && value.item?.type === "agent_message"
        && typeof value.item.text === "string" && value.item.text.length) mark("first_output", "native_event");
    }
    if (runtime === "gemini" && value.type === "message" && value.role === "assistant" && typeof value.content === "string" && value.content.length) mark("first_output", "native_event");
    if (runtime === "kimi" && value.role === "assistant" && (typeof value.content === "string" ? value.content.length : Array.isArray(value.content) && value.content.some((part: any) => part?.type === "text" && typeof part.text === "string" && part.text.length))) mark("first_output", "native_event");
    if (runtime === "copilot" && value.type === "assistant.message_delta" && typeof value.data?.deltaContent === "string" && value.data.deltaContent)
      mark("first_token", "native_event");
    if (runtime === "copilot" && value.type === "assistant.message" && typeof value.data?.content === "string" && value.data.content)
      mark("first_output", "native_event");
    if (runtime === "cursor" && value.type === "assistant" && Array.isArray(value.message?.content)
      && value.message.content.some((part: any) => part?.type === "text" && typeof part.text === "string" && part.text)) mark("first_output", "native_event");
    if (runtime === "grok" && value.method === "session/update" && value.params?.update?.sessionUpdate === "agent_message_chunk"
      && value.params.update.content?.type === "text" && typeof value.params.update.content.text === "string" && value.params.update.content.text) {
      mark("first_token", "native_event"); mark("first_output", "native_event");
    }
    if (runtime === "opencode" && value.type === "text" && value.part?.type === "text" && typeof value.part.text === "string" && value.part.text.length)
      mark("first_output", "native_event");
  };
  return {
    onSpawn() { if (closed || signal.aborted || spawned) return; spawned = true; observe(() => endSpawn?.("completed")); },
    onStdout(chunk: string) {
      if (closed || signal.aborted || runtime === "claude" || !recorder) return;
      for (const part of chunk.split(/(?<=\n)/u)) {
        const ends = part.endsWith("\n");
        if (!dropping && line.length + part.length <= 65_536) line += part;
        else { line = ""; dropping = true; }
        if (ends) { if (!dropping) frame(line); line = ""; dropping = false; }
      }
    },
    finish(ok: boolean, errorCode?: string, hasBufferedOutput = false) {
      if (closed) return;
      if (!signal.aborted && !dropping && line) frame(line);
      if (runtime === "claude" && ok && hasBufferedOutput) mark("first_output", "host");
      const outcome = signal.aborted ? "cancelled" : "error";
      if (!ok || signal.aborted) {
        const kind = outcome === "error" ? runtimeStageErrorKind(errorCode) : undefined;
        if (!spawned) observe(() => endSpawn?.(outcome, kind));
        if (!ready) observe(() => endCold?.(outcome, kind));
      }
      closed = true; line = "";
    },
  };
}
