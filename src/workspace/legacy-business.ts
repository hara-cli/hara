// Explicit Host composition only. NOT hooked to scheduler/startup/cutover or any global store.
import type { WorkspaceResourceStorage } from "./resource-context.js";
import type { WorkspaceFeatures } from "./features.js";
import type { WorkspaceLegacyResources } from "./legacy-resources.js";
import { WorkspaceLegacyCommands, type LegacyCommandOptions } from "./legacy-command.js";
import { WorkspaceLegacyOutcomes, type LegacyNotificationPermit, type LegacyNotificationReview } from "./legacy-outcomes.js";

export class WorkspaceLegacyBusiness {
  readonly commands: WorkspaceLegacyCommands;
  readonly outcomes: WorkspaceLegacyOutcomes;
  constructor(storage: WorkspaceResourceStorage, features: WorkspaceFeatures, resources: WorkspaceLegacyResources, options: {
    commands: LegacyCommandOptions;
    notifications: { authorize(review: Readonly<LegacyNotificationReview>): LegacyNotificationPermit | undefined; knownSecrets?: readonly string[]; now?: () => number; deliveryTimeoutMs?: number };
  }) {
    this.outcomes = new WorkspaceLegacyOutcomes(storage, features, options.notifications);
    this.commands = new WorkspaceLegacyCommands(storage, features, resources, { ...options.commands,
      authorize: review => { this.outcomes.preflight(review); return options.commands.authorize(review); },
      prepareNotifications: review => this.outcomes.preflight(review) });
  }
  async execute(id: string, requestId: string, signal?: AbortSignal) {
    const command = await this.commands.execute(id, requestId, signal);
    // Blocked/cancelled/unknown is not a confirmed business failure or a reason to notify externally.
    if (!["completed", "failed", "timed_out"].includes(command.state)) return { command, effects: [] as string[] };
    if (command.hadStdout === undefined) throw new Error("Historical stdout provenance unknown; inspect without rerunning command");
    const effects = this.outcomes.record({ requestId: command.requestId, runId: command.runId, scheduleId: command.scheduleId,
      definitionHash: command.definitionHash, status: command.state === "completed" ? "ok" : command.state === "timed_out" ? "timed_out" : "error",
      output: command.output, hadStdout: command.hadStdout, finishedAt: command.finishedAt ?? command.occurredAt });
    // Sending remains an explicit Host drain of durable effects; no automatic transport is inferred.
    return { command, effects };
  }
}
