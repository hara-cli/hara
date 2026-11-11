// Host-only adapter identity. Names, kind fields and JSON copies do not register scoped tools.
import type { Tool } from "../tools/registry.js";
import { AgentBoundaryContractError } from "./agent-boundaries-contract.js";
const fileTools = Object.freeze({ workspace_read: "read", workspace_write: "edit", workspace_verify: "read" } as const);
const scoped = new WeakSet<object>();
/** Called only by the reviewed Host-scoped file factory, never by a transport or model. */
export function bindWorkspaceScopedFileTool(tool: Tool): Tool {
  if (!Object.hasOwn(fileTools, tool.name) || fileTools[tool.name as keyof typeof fileTools] !== tool.kind
    || tool.trustBoundary === "external" || typeof tool.run !== "function") throw new AgentBoundaryContractError("RUNTIME_UNSUPPORTED", "execution.adapter");
  const frozen = Object.freeze(tool); scoped.add(frozen); return frozen;
}
export function isWorkspaceScopedFileTool(tool: Tool): boolean { return scoped.has(tool); }
/** Only existing trusted freeze/receipt decorators preserve the original adapter identity. */
export function decorateWorkspaceScopedTool(original: Tool, decorated: Tool): Tool {
  if (!scoped.has(original)) return decorated;
  if (decorated.name !== original.name || decorated.kind !== original.kind || decorated.trustBoundary !== original.trustBoundary
    || decorated.input_schema !== original.input_schema || decorated.classify !== original.classify || typeof decorated.run !== "function") {
    throw new AgentBoundaryContractError("RUNTIME_UNSUPPORTED", "execution.adapter");
  }
  scoped.add(decorated); return decorated;
}
