// Unforgeable Host tool/approval identities. Serialized DTOs never carry authority.
import { redactSensitiveText } from "../security/secrets.js";
import { canonical } from "./local-state.js";
import { extensionDigest } from "./extension-catalog.js";
import { WorkspaceMcpError } from "./extension-review.js";
import type { Tool } from "../tools/registry.js";
export interface WorkspaceExtensionApproval {
  readonly sourceName: string; readonly toolName: string; readonly target: string; readonly action: "read" | "exec";
}
interface Binding {
  attemptId: string; sourceName: string; toolName: string; effect: "read" | "exec";
  assertCurrent(): void; approve(callId: string, inputDigest: string): void;
}
const tools = new WeakMap<object, Binding>();
const approvals = new WeakMap<object, { binding: Binding; callId: string; inputDigest: string; consumed: boolean }>();
export function bindWorkspaceExtensionTool(tool: Tool, binding: Binding): Tool {
  const frozen = Object.freeze(tool); tools.set(frozen, binding); return frozen;
}
export function isWorkspaceExtensionTool(tool: Tool): boolean { return tools.has(tool); }
/** Used only by Host-owned receipt/freeze decorators; a clone from renderer JSON is never admitted. */
export function decorateWorkspaceExtensionTool(original: Tool, decorated: Tool): Tool {
  const binding = tools.get(original);
  if (binding) {
    if (decorated.name !== original.name || decorated.kind !== original.kind || decorated.trustBoundary !== "external" || decorated.input_schema !== original.input_schema) throw new WorkspaceMcpError("mcp_source_unreviewed");
    return bindWorkspaceExtensionTool(decorated, binding);
  }
  return decorated;
}
export function createWorkspaceExtensionApproval(tool: Tool, callId: string, input: unknown): WorkspaceExtensionApproval {
  const binding = tools.get(tool); if (!binding || !callId) throw new WorkspaceMcpError("mcp_source_unreviewed");
  binding.assertCurrent();
  const serialized = canonical(input);
  if (Buffer.byteLength(serialized) > 32 * 1024) throw new WorkspaceMcpError("mcp_input_invalid");
  const approval = Object.freeze({ sourceName: binding.sourceName, toolName: binding.toolName, target: redactSensitiveText(serialized).text, action: binding.effect });
  approvals.set(approval, { binding, callId, inputDigest: extensionDigest(input), consumed: false }); return approval;
}
export function approveWorkspaceExtension(approval: WorkspaceExtensionApproval, attemptId: string): void {
  const state = approvals.get(approval);
  if (!state || state.consumed || state.binding.attemptId !== attemptId) throw new WorkspaceMcpError("mcp_approval_required");
  state.consumed = true; state.binding.assertCurrent(); state.binding.approve(state.callId, state.inputDigest);
}
