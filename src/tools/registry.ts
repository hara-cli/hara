import type { ToolSpec } from "../providers/types.js";
import type { SandboxMode } from "../sandbox.js";

/** Where agent-side output goes. In the TUI it drives ink state; in plain mode it's absent and
 *  the loop/tools fall back to writing the terminal directly. */
export interface UiSink {
  text(delta: string): void;
  reasoning(delta: string): void;
  tool(name: string, preview: string): void;
  diff(text: string): void;
  notice(text: string): void;
}

export interface ToolContext {
  cwd: string;
  sandbox?: SandboxMode;
  /** spawn a sub-agent for a sub-task (set by the REPL/-p; absent inside sub-agents) */
  spawn?: (task: string, role?: string) => Promise<string>;
  /** UI sink (set in TUI mode) — tools route diffs/output here instead of stdout */
  ui?: UiSink;
  /** describe an image file via the vision sidecar (lets the computer tool return a screenshot as text) */
  describeImage?: (path: string) => Promise<string>;
}

export interface Tool {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  /** read | edit | exec | computer — drives the approval gate (read never prompts; computer always asks
   *  once per session for a grant, even in full-auto) */
  kind?: "read" | "edit" | "exec" | "computer";
  run(input: any, ctx: ToolContext): Promise<string>;
}

const registry = new Map<string, Tool>();

export function registerTool(t: Tool): void {
  registry.set(t.name, t);
}

export function getTool(name: string): Tool | undefined {
  return registry.get(name);
}

export function getTools(): Tool[] {
  return [...registry.values()];
}

/** Provider-neutral tool specs derived from the registry. */
export function toolSpecs(): ToolSpec[] {
  return getTools().map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
}
