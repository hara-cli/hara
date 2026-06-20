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

export interface TurnResult {
  text: string;
  toolUses: ToolUse[];
  stop: "end" | "tool_use" | "error";
  errorMsg?: string;
  usage?: { input: number; output: number };
}

export interface TurnArgs {
  system: string;
  history: NeutralMsg[];
  tools: ToolSpec[];
  onText: (delta: string) => void;
  /** stream reasoning/thinking deltas (shown dimmed); optional, provider-dependent */
  onReasoning?: (delta: string) => void;
  /** abort the in-flight request (user interrupt) */
  signal?: AbortSignal;
}

export interface Provider {
  id: string;
  model: string;
  turn(args: TurnArgs): Promise<TurnResult>;
}
