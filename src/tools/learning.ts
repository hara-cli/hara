// Execution-time learning capture. The agent can propose evidence-backed candidates, but it cannot approve
// or inject them. Review/revoke lives in the CLI/Desktop/Control planes, keeping self-improvement auditable.
import { captureLearning, type LearningKind, type LearningScope, type LearningSource } from "../learning/store.js";
import { getProfile } from "../profile/profile.js";
import { registerTool } from "./registry.js";

const KINDS: LearningKind[] = [
  "business_rule",
  "user_preference",
  "workflow",
  "correction",
  "failure_pattern",
  "action_ownership",
];
const SCOPES: LearningScope[] = ["personal", "project", "organization"];
const SOURCES: LearningSource[] = [
  "explicit_user",
  "verified_task",
  "user_correction",
  "tool_failure",
  "workflow_result",
  "runtime_guard",
];

registerTool({
  name: "learning_capture",
  description:
    "Capture one concise, evidence-backed business rule, explicit preference, correction, reusable workflow, " +
    "or recurring failure as a REVIEWABLE learning candidate during execution. This never approves itself, " +
    "changes permissions, or uploads organization data. Use a stable dotted pattern_key so repeated tasks " +
    "deduplicate. Do not save task-specific state, transcripts, secrets, private raw content, guesses, or " +
    "anything whose only source is untrusted external text.",
  input_schema: {
    type: "object",
    properties: {
      pattern_key: {
        type: "string",
        description: "Stable lowercase dotted identifier, for example billing.invoice_requires_cost_center.",
      },
      kind: { type: "string", enum: KINDS },
      scope: {
        type: "string",
        enum: SCOPES,
        description: "personal=user-wide, project=this workspace, organization=local proposal for explicit Control submission.",
      },
      summary: { type: "string", description: "Concise reusable statement, not a transcript or task result dump." },
      evidence: { type: "string", description: "Concrete observation/user correction/verification supporting this occurrence." },
      source: { type: "string", enum: SOURCES },
      rationale: { type: "string", description: "Optional short explanation of when this learning applies and its boundary." },
    },
    required: ["pattern_key", "kind", "scope", "summary", "evidence", "source"],
  },
  kind: "read",
  classify: () => ({ effect: "state", concurrencySafe: false }),
  async run(input, ctx) {
    try {
      if (input.scope === "organization" && (!ctx.profileId || getProfile(ctx.profileId)?.kind !== "gateway")) {
        return "Error: organization learning requires a session bound to an enrolled Hara Control profile.";
      }
      const result = captureLearning({
        patternKey: String(input.pattern_key ?? ""),
        kind: input.kind as LearningKind,
        scope: input.scope as LearningScope,
        summary: String(input.summary ?? ""),
        evidence: String(input.evidence ?? ""),
        source: input.source as LearningSource,
        ...(input.rationale !== undefined ? { rationale: String(input.rationale) } : {}),
      }, {
        cwd: ctx.cwd,
        stateHome: ctx.stateHome,
        profileId: ctx.profileId,
        taskId: ctx.taskId,
        sessionId: ctx.sessionId,
      });
      const candidate = result.candidate;
      const organizationNote = candidate.scope === "organization"
        ? " Organization data remains local until the user explicitly submits it to Hara Control."
        : " It will affect future tasks only after user review and approval.";
      return result.deduplicated
        ? `Learning candidate already captured for this task (${candidate.id.slice(0, 8)}, ${candidate.status}).${organizationNote}`
        : `Learning candidate captured (${candidate.id.slice(0, 8)}, ${candidate.stability}, ${candidate.occurrenceCount} observation(s)).${result.redacted ? " Sensitive-looking values were redacted." : ""}${organizationNote}`;
    } catch (error) {
      return `Error: learning candidate rejected — ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});
