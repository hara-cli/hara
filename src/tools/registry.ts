import type { ToolSpec } from "../providers/types.js";

export interface ToolContext {
  cwd: string;
}

export interface Tool {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  /** dangerous tools require user confirmation unless auto-approve is on */
  dangerous?: boolean;
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
