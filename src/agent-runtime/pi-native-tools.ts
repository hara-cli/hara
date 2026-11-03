import { createCodingTools } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import type { ToolSpec } from "../providers/types.js";

// Exact pinned built-ins. New SDK tools, global MCP, hooks and persistent schedulers are not admitted.
export const PI_NATIVE_TOOL_NAMES = Object.freeze(["read", "bash", "edit", "write"] as const);
export function piWorkspaceToolName(name: string): string {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(name)) throw new Error("Invalid Pi Workspace tool");
  const full = "mcp__hara__" + name;
  return full.length <= 64 ? full : full.slice(0, 47) + "_" + createHash("sha256").update(full).digest("hex").slice(0, 16);
}
export function piNativeModelTools(cwd: string, workspace: readonly ToolSpec[]): ToolSpec[] {
  const native = createCodingTools(cwd).filter(tool => (PI_NATIVE_TOOL_NAMES as readonly string[]).includes(tool.name));
  if (native.length !== PI_NATIVE_TOOL_NAMES.length || new Set(native.map(tool => tool.name)).size !== native.length) throw new Error("Pi native tool inventory changed");
  const result: ToolSpec[] = native.map(tool => ({ name: tool.name, description: tool.description,
    input_schema: JSON.parse(JSON.stringify(tool.parameters)) as Record<string, unknown> }));
  result.push(...workspace.map(tool => ({ ...tool, name: piWorkspaceToolName(tool.name) })));
  if (new Set(result.map(tool => tool.name)).size !== result.length) throw new Error("Pi native tool inventory collided");
  return result;
}
