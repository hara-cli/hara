// New Workspace provenance is deliberately separate from legacy Space Runtime bindings. It is not
// a HostGrant, membership proof, tool permission, native-session handle or execution capability.
import { isAgentRuntimeId, type AgentRuntimeId } from "../agent-runtime/bindings.js";
import {
  isWorkspaceResourceBinding, type WorkspaceResourceBinding,
} from "./resource-context.js";
import { isWorkspaceId } from "./registry.js";

const AGENT_ID = /^ag_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
export const WORKSPACE_AGENT_EXECUTION_PENDING = "Workspace Agent execution is not enabled; resume through a fully scoped host. No legacy Runtime fallback was started.";

export interface WorkspaceAgentTaskBinding {
  schemaVersion: 1;
  resourceBinding: WorkspaceResourceBinding;
  workspaceId: string;
  agentId: string;
  /** Archive/restore advances this independently of configuration edits. */
  agentEpoch: number;
  configRevision: number;
  configHash: string;
  runtimeId: AgentRuntimeId;
  taskId: string;
}

export function isWorkspaceAgentId(value: unknown): value is string {
  return typeof value === "string" && AGENT_ID.test(value);
}

export function isWorkspaceAgentTaskBinding(value: unknown): value is WorkspaceAgentTaskBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const fields = ["schemaVersion", "resourceBinding", "workspaceId", "agentId", "agentEpoch",
    "configRevision", "configHash", "runtimeId", "taskId"];
  return Object.keys(row).length === fields.length && fields.every(key => Object.hasOwn(row, key))
    && row.schemaVersion === 1 && isWorkspaceResourceBinding(row.resourceBinding)
    && isWorkspaceId(row.workspaceId) && isWorkspaceAgentId(row.agentId)
    && Number.isSafeInteger(row.agentEpoch) && Number(row.agentEpoch) > 0
    && Number.isSafeInteger(row.configRevision) && Number(row.configRevision) > 0
    && typeof row.configHash === "string" && HASH.test(row.configHash) && isAgentRuntimeId(row.runtimeId)
    && typeof row.taskId === "string" && row.taskId.length > 0 && row.taskId.length <= 220
    && !/[\\/\u0000-\u001f\u007f-\u009f]/.test(row.taskId);
}

export function freezeWorkspaceAgentTaskBinding(value: WorkspaceAgentTaskBinding): Readonly<WorkspaceAgentTaskBinding> {
  if (!isWorkspaceAgentTaskBinding(value)) throw new Error("invalid Workspace Agent task binding");
  return Object.freeze({ ...value, resourceBinding: Object.freeze({ ...value.resourceBinding }) });
}
