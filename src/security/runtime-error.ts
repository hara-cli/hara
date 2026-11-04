import { redactToolSubprocessOutput } from "./subprocess-env.js";

/** Native error-message/stderr boundary only. Redact before truncation; never accept whole RPC data. */
export function runtimeErrorFirstLine(value: unknown, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (typeof value !== "string") return undefined;
  const first = value.slice(0, 65_536).split(/\r?\n/u).find(line => line.trim());
  if (!first) return undefined;
  const safe = redactToolSubprocessOutput(first, env)
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, "")
    .replace(/(["']?(?:prompt|input|output|messages?|account|email|user_id|session_id|thread_id|turn_id)["']?\s*[:=]\s*)(?:"(?:[^"\\]|\\.)*"|'[^']*'|\S+)/giu, "$1[redacted]")
    .replace(/(?:https?|socks[45]?):\/\/[^\s<>"']+/giu, "[url]")
    .replace(/(?:[A-Za-z]:[\\/]|\/)[^\s<>"',;)}\]]+/gu, "[path]")
    .replace(/[A-Za-z0-9_.+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu, "[account]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu, "[id]")
    // Opaque native account/session identifiers need not use a credential-shaped prefix.
    .replace(/\b[A-Za-z0-9_-]{20,}\b/gu, "[id]")
    .trim();
  return safe ? [...safe].slice(0, 320).join("") : undefined;
}
