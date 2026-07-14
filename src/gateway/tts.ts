// Pluggable text-to-speech for the chat gateway's voice replies. Mirrors the video project's provider design:
// a config-driven registry, nothing vendor-hardcoded, both API and local. Selected by env:
//   HARA_TTS_PROVIDER = say | openai | cmd   (default: say)
//   HARA_TTS_VOICE / HARA_TTS_MODEL / HARA_TTS_BASE_URL / HARA_TTS_API_KEY / HARA_TTS_CMD
// Providers:
//   say    — local macOS `say` (zero-config default; fast, ~0.5s; Chinese voices e.g. Tingting) → m4a
//   openai — any OpenAI-compatible /audio/speech endpoint (point BASE_URL at Aliyun DashScope or a local
//            TTS server); reuses the existing `openai` dep, no new dependency
//   cmd    — a configurable local command (point it at VoxCPM or any local TTS); the text is piped on stdin,
//            `{out}` in the command is replaced with the output path
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chmodSync, lstatSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { terminateSubprocessTree } from "../security/subprocess-env.js";

const DEFAULT_TTS_TIMEOUT_MS = 60_000;
const MAX_TTS_TIMEOUT_MS = 120_000;

export interface TtsConfig {
  provider: string;
  voice: string;
  model: string;
  baseURL: string;
  apiKey: string;
  cmd: string;
  timeoutMs?: number;
}

/** TTS cannot opt out of a deadline. Small values remain available for deterministic health checks/tests. */
export function ttsTimeoutMs(value: number | string | undefined = process.env.HARA_TTS_TIMEOUT_MS): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.max(50, Math.min(Math.floor(parsed), MAX_TTS_TIMEOUT_MS))
    : DEFAULT_TTS_TIMEOUT_MS;
}

/** Read TTS settings from the environment (fully configurable — nothing hardcoded). */
export function ttsConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TtsConfig {
  return {
    provider: (env.HARA_TTS_PROVIDER || "say").trim(),
    voice: (env.HARA_TTS_VOICE || "").trim(),
    model: (env.HARA_TTS_MODEL || "").trim(),
    baseURL: (env.HARA_TTS_BASE_URL || "").trim(),
    apiKey: (env.HARA_TTS_API_KEY || "").trim(),
    cmd: (env.HARA_TTS_CMD || "").trim(),
    // Passing an explicit fixture env must not accidentally fall back to the live process environment.
    timeoutMs: ttsTimeoutMs(env.HARA_TTS_TIMEOUT_MS ?? Number.NaN),
  };
}

/** Normalize a reply for speech: collapse whitespace, drop code fences, cap length (long audio is unwanted). */
export function ttsCleanText(text: string, max = 1200): string {
  return text
    .replace(/```[\s\S]*?```/g, " (code omitted) ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("TTS cancelled");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

/** Race even an API implementation that ignores AbortSignal, while still passing the signal to its fetch. */
function withAbort<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = (): void => finish(() => reject(abortReason(signal)));
    signal.addEventListener("abort", onAbort, { once: true });
    task.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

/** Run local TTS in its own process group. Cancellation escalates TERM→KILL for the whole descendant tree. */
function run(cmd: string, args: string[], signal: AbortSignal, stdin?: string): Promise<boolean> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const processGroup = process.platform !== "win32";
    let child;
    try {
      child = spawn(cmd, args, {
        stdio: [stdin != null ? "pipe" : "ignore", "ignore", "ignore"],
        detached: processGroup,
        windowsHide: true,
      });
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    let stopping = false;
    let cancelTermination: ((cancelForce?: boolean) => void) | undefined;
    const settle = (ok: boolean, error?: Error): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", stop);
      // Cancel only the API fallback. If TERM closed the direct child while a descendant survived, the helper's
      // referenced force timer still kills the owned process group after the grace period.
      cancelTermination?.();
      child.stdin?.destroy();
      if (error) reject(error);
      else resolve(ok);
    };
    const stop = (): void => {
      if (settled || stopping) return;
      stopping = true;
      cancelTermination = terminateSubprocessTree(child, {
        processGroup,
        graceMs: 250,
        fallbackMs: 250,
        onFallback: () => settle(false, abortReason(signal)),
      });
    };
    child.once("error", () => settle(false, stopping ? abortReason(signal) : undefined));
    child.once("close", (code) => settle(code === 0, stopping ? abortReason(signal) : undefined));
    child.stdin?.on("error", () => { /* close races are reported by the child itself */ });
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    if (stdin != null && !stopping) child.stdin?.end(stdin);
  });
}

// local: macOS `say` → m4a (AAC). Zero config; HARA_TTS_VOICE picks the voice (default Tingting / zh).
async function sayTts(text: string, out: string, cfg: TtsConfig, signal: AbortSignal): Promise<boolean> {
  return run("say", ["-v", cfg.voice || "Tingting", "-o", out, "--file-format", "m4af", "--data-format", "aac", text], signal);
}

// API: OpenAI-compatible /audio/speech. Works against OpenAI, Aliyun DashScope (compatible-mode), or a local
// server exposing the same shape — set HARA_TTS_BASE_URL + HARA_TTS_API_KEY + HARA_TTS_MODEL + HARA_TTS_VOICE.
async function openaiTts(text: string, out: string, cfg: TtsConfig, signal: AbortSignal): Promise<boolean> {
  if (!cfg.apiKey && !cfg.baseURL) return false; // not configured → unavailable
  return withAbort((async () => {
    const { default: OpenAI } = (await import("openai")) as any;
    throwIfAborted(signal);
    const client = new OpenAI({ baseURL: cfg.baseURL || undefined, apiKey: cfg.apiKey || "x" });
    const res = await client.audio.speech.create(
      { model: cfg.model || "tts-1", voice: cfg.voice || "alloy", input: text },
      { signal },
    );
    const buf = Buffer.from(await res.arrayBuffer());
    throwIfAborted(signal);
    if (!buf.length) return false;
    writeFileSync(out, buf, { flag: "wx", mode: 0o600 });
    return true;
  })(), signal);
}

// local: a configurable command (e.g. VoxCPM). `{out}` → output path; the text is piped on stdin.
async function cmdTts(text: string, out: string, cfg: TtsConfig, signal: AbortSignal): Promise<boolean> {
  if (!cfg.cmd) return false;
  return run("sh", ["-c", cfg.cmd.replace(/\{out\}/g, out)], signal, text);
}

const PROVIDERS: Record<string, (text: string, out: string, cfg: TtsConfig, signal: AbortSignal) => Promise<boolean>> = {
  say: sayTts,
  openai: openaiTts,
  cmd: cmdTts,
};
const EXT: Record<string, string> = { say: "m4a", openai: "mp3", cmd: "wav" };

function isAbortSignal(value: AbortSignal | TtsConfig | undefined): value is AbortSignal {
  return Boolean(value && typeof (value as AbortSignal).addEventListener === "function" && typeof (value as AbortSignal).aborted === "boolean");
}

function safeProviderError(error: unknown, cfg: TtsConfig): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const [secret, replacement] of [[cfg.apiKey, "[redacted]"], [cfg.baseURL, "[redacted-url]"]] as const) {
    if (secret) message = message.split(secret).join(replacement);
  }
  return message;
}

function secureCompletedAudio(path: string): boolean {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size <= 0) return false;
    chmodSync(path, 0o600);
    return true;
  } catch {
    return false;
  }
}

/** Synthesize `text` to a temp audio file; returns its path, or null on provider/deadline failure. The legacy
 * `synthesize(text, config)` form remains valid; gateway callers use `synthesize(text, signal, config?)`. */
export async function synthesize(
  text: string,
  signalOrConfig?: AbortSignal | TtsConfig,
  explicitConfig?: TtsConfig,
): Promise<string | null> {
  const parentSignal = isAbortSignal(signalOrConfig) ? signalOrConfig : undefined;
  if (parentSignal?.aborted) throw abortReason(parentSignal);
  const clean = ttsCleanText(text);
  if (!clean) return null;
  const cfg = isAbortSignal(signalOrConfig)
    ? (explicitConfig ?? ttsConfigFromEnv())
    : (explicitConfig ?? signalOrConfig ?? ttsConfigFromEnv());
  const deadline = new AbortController();
  const timeoutMs = ttsTimeoutMs(cfg.timeoutMs);
  const timeoutError = new Error(`TTS timed out after ${timeoutMs}ms`);
  const timeout = setTimeout(() => deadline.abort(timeoutError), timeoutMs);
  const cancel = (): void => deadline.abort(parentSignal?.reason instanceof Error ? parentSignal.reason : new Error("TTS cancelled"));
  parentSignal?.addEventListener("abort", cancel, { once: true });
  const provider = PROVIDERS[cfg.provider] ? cfg.provider : "say";
  const out = join(tmpdir(), `hara-tts-${randomUUID()}.${EXT[provider] || "wav"}`);
  try {
    try {
      if (await PROVIDERS[provider](clean, out, cfg, deadline.signal) && secureCompletedAudio(out)) return out;
    } catch (error) {
      if (parentSignal?.aborted) throw abortReason(parentSignal);
      if (deadline.signal.aborted) {
        console.error(`tts(${provider}): ${timeoutError.message}`);
        return null;
      }
      console.error(`tts(${provider}): ${safeProviderError(error, cfg)}`);
    }
    rmSync(out, { force: true });
    if (provider !== "say" && !deadline.signal.aborted) {
      const fallback = join(tmpdir(), `hara-tts-${randomUUID()}.m4a`);
      try {
        if (await sayTts(clean, fallback, cfg, deadline.signal) && secureCompletedAudio(fallback)) return fallback; // graceful local fallback
      } catch (error) {
        if (parentSignal?.aborted) throw abortReason(parentSignal);
        if (deadline.signal.aborted) console.error(`tts(say): ${timeoutError.message}`);
        else console.error(`tts(say): ${safeProviderError(error, cfg)}`);
      }
      rmSync(fallback, { force: true });
    }
    return null;
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", cancel);
    // Returned paths are owned by the caller. Every other partial/late provider output is removed here.
    if (deadline.signal.aborted) rmSync(out, { force: true });
  }
}
