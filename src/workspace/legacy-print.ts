// Owner-only bridge into the EXISTING Workspace Pi Host, not the old global agent loop.
import { createHash } from "node:crypto";
import { canonical, plain, UUID } from "./local-state.js";
import { WorkspaceConversationStore } from "./conversations.js";
import { redactSensitiveText } from "../security/secrets.js";
import type { LocalWorkspaceHost } from "./local-host.js";
import type { WorkspaceResourceStorage } from "./resource-context.js";
import type { WorkspaceFeatures } from "./features.js";
import type { WorkspaceLegacyOutcomes } from "./legacy-outcomes.js";

export async function executeLegacyPrint(host: LocalWorkspaceHost, storage: WorkspaceResourceStorage, features: WorkspaceFeatures,
  outcomes: WorkspaceLegacyOutcomes, scheduleId: string, requestId: string) {
  if (!UUID.test(requestId)) throw new Error("Explicit print occurrence required");
  const row = features.schedules().find(row => row.id === scheduleId);
  if (!row || row.workspaceId !== storage.scope.workspaceId || row.source !== "legacy-v1" || !row.enabled || row.definition.mode !== "print"
    || !plain(row.definition.legacy) || row.definition.legacy.quarantined !== false || row.definition.legacy.projectAgent !== undefined
    || typeof row.definition.agentId !== "string" || typeof row.definition.task !== "string") throw new Error("Reviewed enabled print unavailable");
  const definitionHash = createHash("sha256").update(canonical(row)).digest("hex"), agentId = row.definition.agentId;
  const binding = outcomes.list().resourceBinding; host.assertGeneration(row.workspaceId, binding.generation);
  const cached = outcomes.completed(requestId, scheduleId, definitionHash); if (cached) return { ...cached, duplicate: true };
  outcomes.preflight({ workspaceId: row.workspaceId, resourceBinding: binding, scheduleId, requestId, definitionHash,
    sourceHash: String(row.definition.legacy.sourceHash), resourceId: String(row.definition.legacy.resourceId), originalPath: String(row.definition.cwd) });
  const accepted = host.start(`legacy-schedule:${row.workspaceId}`, row.workspaceId, agentId, row.definition.task, requestId);
  await host.wait(accepted.runId); host.assertGeneration(row.workspaceId, binding.generation);
  const current = features.schedules().find(item => item.id === scheduleId);
  if (!current || createHash("sha256").update(canonical(current)).digest("hex") !== definitionHash) throw new Error("Print definition changed; inspect confirmed Host run without replay");
  const value = new WorkspaceConversationStore(storage, agentId).read();
  if (value.attempt?.runId !== accepted.runId || !["completed", "blocked"].includes(value.attempt.state) || !value.attempt.endedAt) {
    throw new Error("Print Host outcome unconfirmed or superseded; never replay automatically");
  }
  const status = value.task?.status === "completed" ? "ok" as const : "error" as const;
  const last = [...value.history].reverse().find(message => message.role === "assistant" && message.text.trim());
  const output = redactSensitiveText(last?.role === "assistant" ? last.text : status === "ok" ? "" : "Scoped print task did not complete").text.slice(0, 8000);
  const effects = outcomes.record({ requestId, runId: accepted.runId, scheduleId, definitionHash, status, output, hadStdout: Boolean(output.trim()), finishedAt: Date.parse(value.attempt.endedAt) });
  return { runId: accepted.runId, status, effects, duplicate: accepted.duplicate };
}
