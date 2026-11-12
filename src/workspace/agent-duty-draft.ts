// Unconfirmed public duty data shared by onboarding G3 and C5. No IO, identity or permission is issued.
import { AgentBoundaryContractError, parseAgentBoundaryDocument, type AgentBoundaryContext, type AgentDutyProfile } from "./agent-boundaries-contract.js";
import { deepFreeze } from "./local-state.js";

export type AgentDutyPublicProfile = AgentDutyProfile["publicProfile"];
export interface AgentDutyDraft {
  readonly schemaVersion: 1; readonly kind: "duty-draft"; readonly status: "unconfirmed";
  readonly publicProfile: AgentDutyPublicProfile;
}
// Parser-only placeholders never leave this module. C0 parsing verifies syntax, not authority.
const syntaxContext: AgentBoundaryContext = {
  scope: { schemaVersion: 1, workspaceId: "ws_00000000-0000-4000-8000-000000000002", authority: { kind: "local", localAuthorityId: "00000000-0000-4000-8000-000000000001" } },
  resourceBinding: { schemaVersion: 1, scopeKey: "0".repeat(64), generation: "00000000-0000-4000-8000-000000000003" },
  humanSubjectId: "syntax-only", nodeId: "syntax-only", deviceId: null,
  localGrant: { grantId: "syntax-only", grantRevision: 1, humanSubjectId: "syntax-only", nodeId: "syntax-only" },
  collaboration: { organizationId: null, membershipId: null, membershipVersion: null, role: null, delegation: null },
};
/** Exactly C0 title/description/owns/rejects; never derives duties from persona or assigns a grant. */
export function parseAgentDutyPublicProfile(raw: unknown): AgentDutyPublicProfile {
  const parsed = parseAgentBoundaryDocument({ schemaVersion: 1, mode: "personal", kind: "duty-profile", context: syntaxContext,
    agentId: "syntax-only", dutyRevision: 1, publicProfile: raw });
  if (parsed.kind !== "duty-profile") throw new AgentBoundaryContractError("INVALID_DOCUMENT", "dutyDraft");
  return parsed.publicProfile;
}
export function createAgentDutyDraft(publicProfile: unknown): AgentDutyDraft {
  return deepFreeze({ schemaVersion: 1, kind: "duty-draft", status: "unconfirmed", publicProfile: parseAgentDutyPublicProfile(publicProfile) });
}
export function parseAgentDutyDraft(raw: unknown): AgentDutyDraft {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) throw new AgentBoundaryContractError("INVALID_DOCUMENT", "dutyDraft");
  const descriptors = Object.getOwnPropertyDescriptors(raw), keys = Reflect.ownKeys(descriptors);
  if (keys.length !== 4 || keys.some(key => typeof key !== "string" || !["schemaVersion", "kind", "status", "publicProfile"].includes(key)
    || !descriptors[key]!.enumerable || !Object.hasOwn(descriptors[key]!, "value"))) throw new AgentBoundaryContractError("INVALID_DOCUMENT", "dutyDraft");
  const value = raw as Record<string, unknown>;
  if (value.schemaVersion !== 1 || value.kind !== "duty-draft" || value.status !== "unconfirmed") throw new AgentBoundaryContractError("INVALID_DOCUMENT", "dutyDraft");
  return createAgentDutyDraft(value.publicProfile);
}
/** A syntactic C0 proposal only. Activation still requires the real C1/C3 duty.update path. */
export function agentDutyDraftProposal(raw: unknown, context: AgentBoundaryContext, agentId: string, dutyRevision: number): AgentDutyProfile {
  const draft = parseAgentDutyDraft(raw), result = parseAgentBoundaryDocument({ schemaVersion: 1, mode: "personal", kind: "duty-profile", context,
    agentId, dutyRevision, publicProfile: draft.publicProfile });
  if (result.kind !== "duty-profile") throw new AgentBoundaryContractError("INVALID_DOCUMENT", "dutyDraft"); return result;
}
