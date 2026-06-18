/** Provider-neutral conversation + provider interface (multi-provider core). */

export type ToolUse = { id: string; name: string; input: any };
export type ToolResult = { id: string; name: string; content: string; isError?: boolean };

export type NeutralMsg =
  | { role: "user"; content: string }
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
}

export interface Provider {
  id: string;
  model: string;
  turn(args: TurnArgs): Promise<TurnResult>;
}
