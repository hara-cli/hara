import { classifyError } from "../agent/failover.js";
import { providerErrorMetadata } from "../providers/retry.js";
import type { Provider, ProviderErrorMetadata } from "../providers/types.js";
import { isWorkspaceAgentId } from "./agent-binding.js";
import { sameWorkspaceResourceBinding, type WorkspaceResourceBinding, type WorkspaceResourceStorage } from "./resource-context.js";
import { exact, plain, positive, UUID, WorkspaceJsonState } from "./local-state.js";

export const WORKSPACE_PROVIDER_FAILURES = ["connection_model_unavailable", "connection_auth_required", "connection_quota_exhausted", "connection_region_unavailable"] as const;
export type WorkspaceProviderFailure = typeof WORKSPACE_PROVIDER_FAILURES[number];
export function workspaceProviderFailure(message: string, metadata?: ProviderErrorMetadata): WorkspaceProviderFailure | null {
  if (metadata?.status === 404) return "connection_model_unavailable";
  const kind = classifyError(message, metadata?.status, metadata?.code);
  if (kind === "quota_exhausted") return "connection_quota_exhausted";
  if (kind === "region_unavailable") return "connection_region_unavailable";
  if (kind === "auth") return "connection_auth_required";
  if (/^(?:MODEL_NOT_FOUND|UNSUPPORTED_MODEL|MODEL_NOT_SUPPORTED)$/i.test(metadata?.code ?? "")
    || /(?:model.{0,60}(?:does not support|not supported|not found|unsupported)|not support.{0,30}(?:agent|coding) plan)/i.test(message)) return "connection_model_unavailable";
  return null;
}
/** Older conversations retain only the engine's provider-error prefix. Do not classify arbitrary chat/tool prose. */
export function legacyWorkspaceProviderFailure(reason: string | undefined): WorkspaceProviderFailure | null {
  const match = /^\[[^\]\r\n]{1,40} error\]\s+(.*)$/s.exec(reason ?? "");
  if (!match) return null;
  // Older checkpoints append Hara recovery hints; only the provider's part is evidence.
  const message = match[1]!.split(" — ", 1)[0]!;
  const status = /^(\d{3})\b/.exec(message);
  return workspaceProviderFailure(message, status ? { status: Number(status[1]) } : undefined);
}
export class WorkspaceProviderAdmissionError extends Error {
  constructor(readonly reason: WorkspaceProviderFailure | "connection_recovery_unavailable") {
    super(`Workspace continuation refused (${reason}); repair the connection and explicitly start a new task. The original task is retained; no new model call`);
  }
}
interface FailureState {
  schemaVersion: 1; revision: number; resourceBinding: WorkspaceResourceBinding; agentId: string;
  runId: string | null; reason: WorkspaceProviderFailure | null;
}
/** Separate, scoped recovery evidence leaves the existing conversation/RunBinding schema unchanged. */
export class WorkspaceProviderRecovery {
  private readonly state: WorkspaceJsonState<FailureState>;
  constructor(storage: WorkspaceResourceStorage, agentId: string) {
    if (!isWorkspaceAgentId(agentId)) throw new Error("Invalid provider recovery owner");
    this.state = new WorkspaceJsonState(storage, `provider-recovery-${agentId.slice(3)}.json`, value => {
      if (!plain(value) || !exact(value, ["schemaVersion", "revision", "resourceBinding", "agentId", "runId", "reason"])
        || value.schemaVersion !== 1 || !positive(value.revision) || value.agentId !== agentId
        || !sameWorkspaceResourceBinding(value.resourceBinding as WorkspaceResourceBinding, this.state.binding())
        || typeof value.runId !== "string" || !UUID.test(value.runId) || !WORKSPACE_PROVIDER_FAILURES.includes(value.reason as WorkspaceProviderFailure)) {
        throw new WorkspaceProviderAdmissionError("connection_recovery_unavailable");
      }
      return structuredClone(value) as unknown as FailureState;
    }, () => ({ schemaVersion: 1, revision: 0, resourceBinding: this.state.binding(), agentId, runId: null, reason: null }));
  }
  reason(runId: string): WorkspaceProviderFailure | null {
    const value = this.state.read(); return value.runId === runId ? value.reason : null;
  }
  observe(provider: Provider, runId: string): Provider {
    const record = (message: string, metadata?: ProviderErrorMetadata) => {
      const reason = workspaceProviderFailure(message, metadata); if (!reason) return;
      const before = this.state.read();
      this.state.update(before.revision, value => ({ ...value, runId, reason }));
    };
    return {
      id: provider.id, model: provider.model, supportsToolImages: provider.supportsToolImages, trailingTurnContext: provider.trailingTurnContext,
      connection: provider.connection,
      ...(provider.prepareTurn ? { prepareTurn: provider.prepareTurn.bind(provider) } : {}),
      ...(provider.connectionHealth ? { connectionHealth: provider.connectionHealth.bind(provider) } : {}),
      async turn(args) {
        try {
          const result = await provider.turn(args);
          if (result.stop === "error" && !args.signal?.aborted) record(result.errorMsg ?? "", result.errorMetadata);
          return result;
        } catch (error) {
          if (!args.signal?.aborted) record(error instanceof Error ? error.message : "", providerErrorMetadata(error));
          throw error;
        }
      },
    };
  }
}
