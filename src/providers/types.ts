/** Provider-neutral conversation + provider interface (multi-provider core). */

export type ToolUse = { id: string; name: string; input: any };
export type ToolResult = { id: string; name: string; content: string; isError?: boolean };
/** An image the user attached to a turn. Only the path rides in history (sessions stay small); the
 *  bytes are read + base64-encoded by each provider at request time. */
export type ImageAttachment = { path: string; mediaType: string };

export type NeutralMsg =
  | { role: "user"; content: string; images?: ImageAttachment[] }
  | { role: "assistant"; text: string; toolUses: ToolUse[] }
  | { role: "tool"; results: ToolResult[] };

export type ToolSpec = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

/** Prompt metadata is additive: `system` remains the fully rendered string for provider and custom
 * provider compatibility, while built-in providers may use these deterministic boundaries for caching.
 * Parts must be ordered static → session → turn so a changing task suffix never invalidates the reusable
 * core/project prefix. */
export type SystemPromptStability = "static" | "session" | "turn";
export type SystemPromptSource = "core" | "runtime" | "channel" | "project" | "task" | "memory" | "role" | "skill";
export interface SystemPromptPart {
  id: string;
  stability: SystemPromptStability;
  source: SystemPromptSource;
  content: string;
  /** Short content identity for cache/debug telemetry. It never contains prompt text. */
  digest: string;
}

export interface TurnResult {
  text: string;
  toolUses: ToolUse[];
  stop: "end" | "tool_use" | "error";
  errorMsg?: string;
  usage?: { input: number; output: number };
}

export interface TurnArgs {
  system: string;
  /** Optional structured boundaries for cache-aware providers. `system` is always authoritative; a
   * provider must fall back to it if these parts do not reproduce the same text exactly. */
  systemParts?: SystemPromptPart[];
  history: NeutralMsg[];
  tools: ToolSpec[];
  onText: (delta: string) => void;
  /** stream reasoning/thinking deltas (shown dimmed); optional, provider-dependent */
  onReasoning?: (delta: string) => void;
  /** ANY stream activity (a content/reasoning/tool-call chunk arrived) — resets the stall watchdog even
   *  for chunks we don't render. Critical for reasoning models: they emit reasoning_content (possibly
   *  suppressed) for a long time before the first `content` token, and without this the watchdog would
   *  time out mid-thinking. Providers call it on every chunk; the loop keeps the connection considered
   *  alive. */
  onActivity?: () => void;
  /** abort the in-flight request (user interrupt) */
  signal?: AbortSignal;
}

export interface Provider {
  id: string;
  model: string;
  turn(args: TurnArgs): Promise<TurnResult>;
}
