import type { Tool } from "../tools/registry.js";
import { redactSensitiveText } from "../security/secrets.js";

export interface AgentRestorationTarget {
  ref: string;
  name: string;
  revision: string;
  dismissedAt: string;
}

function restorationRequest(input: unknown): Pick<AgentRestorationTarget, "ref" | "revision" | "dismissedAt"> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Choose an exact archived Agent first.");
  const record = input as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["ref", "expectedRevision", "dismissedAt"].includes(key))
    || typeof record.ref !== "string" || !/^(?:global|[a-z0-9][a-z0-9._-]{0,63}):[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(record.ref)
    || typeof record.expectedRevision !== "string" || !/^[a-f0-9]{32}$/u.test(record.expectedRevision)
    || typeof record.dismissedAt !== "string" || record.dismissedAt.length > 40 || !Number.isFinite(Date.parse(record.dismissedAt))) {
    throw new Error("Use the exact ref, expectedRevision and dismissedAt returned by agent_contact(action=list, includeDismissed=true). No replacement profile or permissions are accepted.");
  }
  return { ref: record.ref, revision: record.expectedRevision, dismissedAt: record.dismissedAt };
}

/** Restoring discovery is separate from creating/replacing a persona. The ordinary one-action human
 * card is mandatory even in full-auto, and both source revision and dismissal identity are rechecked. */
export function createAgentRestorationTool(deps: {
  assertPersonalRoot(): void;
  inspect(ref: string): AgentRestorationTarget | undefined;
  restore(target: AgentRestorationTarget): { ref: string; restored: boolean };
}): Tool {
  // A refused classification must never turn into a write if the archived directory changes before
  // run(). Keep the exact classified proposal; the loop still owns the live human decision.
  const proposals = new WeakMap<object, AgentRestorationTarget>();
  const checked = (input: unknown): AgentRestorationTarget => {
    deps.assertPersonalRoot();
    const request = restorationRequest(input);
    const target = deps.inspect(request.ref);
    if (!target || target.ref !== request.ref || target.revision !== request.revision || target.dismissedAt !== request.dismissedAt) {
      throw new Error("Archived Agent changed or is unavailable; refresh the archived contact list before proposing restoration.");
    }
    return target;
  };
  return {
    name: "agent_restore",
    description: "Restore one exact archived personal/project Agent after live human confirmation. First call agent_contact(action=list, includeDismissed=true). Pass its exact ref, revision and dismissal time; never rename the colleague, replace its instructions or recreate its history. Restoration does not grant tools, credentials or execution permissions.",
    kind: "edit",
    input_schema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Exact qualified ref from the archived directory." },
        expectedRevision: { type: "string", description: "Current archived source revision." },
        dismissedAt: { type: "string", description: "Exact dismissal timestamp from the directory." },
      },
      required: ["ref", "expectedRevision", "dismissedAt"],
    },
    classify(input) {
      try {
        const target = checked(input);
        proposals.set(input as object, { ...target });
        return {
          effect: "edit", concurrencySafe: false, requiresExplicitApproval: true,
          approvalTarget: `Restore ${redactSensitiveText(target.name).text.slice(0, 64)} (${target.ref}), archived ${target.dismissedAt}; preserve existing instructions and history.`,
        };
      } catch {
        if (input && typeof input === "object") proposals.delete(input);
        return { effect: "state", concurrencySafe: false };
      }
    },
    async run(input, ctx) {
      try {
        if (ctx.signal?.aborted) return "Agent restoration cancelled; nothing changed.";
        const proposal = input && typeof input === "object" ? proposals.get(input) : undefined;
        if (!proposal) throw new Error("No classified restoration proposal is available; refresh the archived directory and request live confirmation again.");
        const target = checked(input);
        if (proposal.ref !== target.ref || proposal.revision !== target.revision || proposal.dismissedAt !== target.dismissedAt) {
          throw new Error("Archived Agent changed; refresh and confirm again.");
        }
        return JSON.stringify({ ...deps.restore(target), instructionsPreserved: true, historyPreserved: true, permissionsGranted: false });
      } catch (error) {
        return "Error: " + redactSensitiveText(error instanceof Error ? error.message : String(error)).text.slice(0, 1_000);
      }
    },
  };
}
