/** Hard lifecycle bounds for one agent run. These are deliberately independent of the provider's
 * stream-idle watchdog and each tool's own timeout: activity must not be able to renew a run forever. */
export const DEFAULT_AGENT_RUN_TIMEOUT_MS = 30 * 60_000;
export const MAX_AGENT_RUN_TIMEOUT_MS = 2 * 60 * 60_000;
export const MIN_AGENT_RUN_TIMEOUT_MS = 1_000;
export const DEFAULT_AGENT_MAX_ROUNDS = 64;
export const MAX_AGENT_MAX_ROUNDS = 256;

export function parseAgentRunTimeoutMs(value: number | string | undefined): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$/i.exec(value);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = (match[2] ?? "ms").toLowerCase();
  const multiplier = unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : unit === "s" ? 1_000 : 1;
  const parsed = amount * multiplier;
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Parse a total run deadline. Invalid/zero values cannot disable the safety boundary. Human values such
 * as `30m`, `90s`, and `1h` are accepted in config; HARA_RUN_TIMEOUT_MS also accepts plain milliseconds. */
export function agentRunTimeoutMs(
  value: number | string | undefined = process.env.HARA_RUN_TIMEOUT_MS,
): number {
  const parsed = parseAgentRunTimeoutMs(value);
  if (parsed === undefined || parsed <= 0) return DEFAULT_AGENT_RUN_TIMEOUT_MS;
  return Math.max(MIN_AGENT_RUN_TIMEOUT_MS, Math.min(MAX_AGENT_RUN_TIMEOUT_MS, Math.trunc(parsed)));
}

/** Maximum provider/tool rounds in one run. This catches active loops that never go silent. */
export function agentMaxRounds(
  value: number | string | undefined = process.env.HARA_MAX_AGENT_ROUNDS,
): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_AGENT_MAX_ROUNDS;
  return Math.max(1, Math.min(MAX_AGENT_MAX_ROUNDS, Math.trunc(parsed)));
}

export function formatAgentDuration(ms: number): string {
  if (ms >= 3_600_000 && ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms >= 3_600_000) return `${Math.round(ms / 360_000) / 10}h`;
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms >= 60_000) return `${Math.round(ms / 6_000) / 10}m`;
  if (ms >= 1_000 && ms % 1_000 === 0) return `${ms / 1_000}s`;
  if (ms >= 1_000) return `${Math.round(ms / 1_000)}s`;
  return `${ms}ms`;
}
