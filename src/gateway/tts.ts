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
import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

export interface TtsConfig {
  provider: string;
  voice: string;
  model: string;
  baseURL: string;
  apiKey: string;
  cmd: string;
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

function run(cmd: string, args: string[], stdin?: string): Promise<boolean> {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { stdio: [stdin != null ? "pipe" : "ignore", "ignore", "ignore"] });
    c.on("error", () => resolve(false));
    c.on("close", (code) => resolve(code === 0));
    if (stdin != null) c.stdin?.end(stdin);
  });
}

// local: macOS `say` → m4a (AAC). Zero config; HARA_TTS_VOICE picks the voice (default Tingting / zh).
async function sayTts(text: string, out: string, cfg: TtsConfig): Promise<boolean> {
  return run("say", ["-v", cfg.voice || "Tingting", "-o", out, "--file-format", "m4af", "--data-format", "aac", text]);
}

// API: OpenAI-compatible /audio/speech. Works against OpenAI, Aliyun DashScope (compatible-mode), or a local
// server exposing the same shape — set HARA_TTS_BASE_URL + HARA_TTS_API_KEY + HARA_TTS_MODEL + HARA_TTS_VOICE.
async function openaiTts(text: string, out: string, cfg: TtsConfig): Promise<boolean> {
  if (!cfg.apiKey && !cfg.baseURL) return false; // not configured → unavailable
  const { default: OpenAI } = (await import("openai")) as any;
  const client = new OpenAI({ baseURL: cfg.baseURL || undefined, apiKey: cfg.apiKey || "x" });
  const res = await client.audio.speech.create({ model: cfg.model || "tts-1", voice: cfg.voice || "alloy", input: text });
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) return false;
  writeFileSync(out, buf);
  return true;
}

// local: a configurable command (e.g. VoxCPM). `{out}` → output path; the text is piped on stdin.
async function cmdTts(text: string, out: string, cfg: TtsConfig): Promise<boolean> {
  if (!cfg.cmd) return false;
  return run("sh", ["-c", cfg.cmd.replace(/\{out\}/g, out)], text);
}

const PROVIDERS: Record<string, (text: string, out: string, cfg: TtsConfig) => Promise<boolean>> = {
  say: sayTts,
  openai: openaiTts,
  cmd: cmdTts,
};
const EXT: Record<string, string> = { say: "m4a", openai: "mp3", cmd: "wav" };

/** Synthesize `text` to a temp audio file; returns its path, or null on failure. Falls back to local `say`
 *  if a configured provider fails (so a misconfigured API never silently kills voice replies). */
export async function synthesize(text: string, cfg: TtsConfig = ttsConfigFromEnv()): Promise<string | null> {
  const clean = ttsCleanText(text);
  if (!clean) return null;
  const provider = PROVIDERS[cfg.provider] ? cfg.provider : "say";
  const out = join(tmpdir(), `hara-tts-${randomUUID().slice(0, 8)}.${EXT[provider] || "wav"}`);
  try {
    if (await PROVIDERS[provider](clean, out, cfg)) return out;
  } catch (e) {
    console.error(`tts(${provider}): ${(e as Error)?.message ?? e}`);
  }
  if (provider !== "say") {
    try {
      const o2 = join(tmpdir(), `hara-tts-${randomUUID().slice(0, 8)}.m4a`);
      if (await sayTts(clean, o2, cfg)) return o2; // graceful fallback to local
    } catch {
      /* give up */
    }
  }
  return null;
}
