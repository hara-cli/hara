import type { ToolSpec } from "../providers/types.js";
import type { SandboxMode } from "../sandbox.js";

export interface ToolContext {
  cwd: string;
  sandbox?: SandboxMode;
  /** spawn a sub-agent for a sub-task (set by the REPL/-p; absent inside sub-agents) */
  spawn?: (task: string, role?: string) => Promise<string>;
}

export interface Tool {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  /** read | edit | exec — drives the approval gate (read never prompts) */
  kind?: "read" | "edit" | "exec";
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
