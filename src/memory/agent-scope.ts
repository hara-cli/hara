// Host composition chooses a colleague, never a model-supplied path or memory scope.
import { isWorkspaceAgentId } from "../workspace/agent-binding.js";
import { currentWorkspaceMemoryAgentScope, withWorkspaceMemoryAgentScope, withWorkspaceSharedMemoryScope,
  type WorkspaceResourceStorage } from "../workspace/resource-context.js";
export function withWorkspaceAgentMemory<T>(storage: WorkspaceResourceStorage, agentId: string, legacyCwd: string, operation: () => T): T {
  if (!isWorkspaceAgentId(agentId)) throw new Error("Invalid colleague memory identity");
  return storage.run(() => withWorkspaceMemoryAgentScope(agentId, legacyCwd, operation));
}
export function currentWorkspaceAgentMemory() { return currentWorkspaceMemoryAgentScope(); }
/** Only a consumed Host approval may enter this callback. Ordinary global/project writes stay private. */
export function withWorkspaceSharedMemory<T>(operation: () => T): T { return withWorkspaceSharedMemoryScope(operation); }
