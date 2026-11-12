// Deterministic nomination only. Audience, source, authoritative claim and execution are separate gates.
import { AgentBoundaryContractError } from "./agent-boundaries-contract.js";
import type { AgentDutyPublicProfile } from "./agent-duty-draft.js";
import { commandEpoch, commandId } from "./agent-command-state.js";
import { deepFreeze, messageBody, UUID } from "./local-state.js";
import { assertAgentRoutingJson, routingFields, routingFail, AGENT_ROUTING_CANDIDATE_LIMIT, type AgentRoutingCandidateVersion, type AgentRoutingMethod, type AgentRoutingReason } from "./agent-routing-state.js";
export interface AgentRoutingInput {
  channelId: string; workItemId: string; requestId: string; message: string; explicitAgentIds: string[];
  leadAgentId: string | null; businessBindingRef: string | null; expectedWorkRevision: number;
}
export interface AgentRoutingDirectoryEntry extends AgentRoutingCandidateVersion {
  publicProfile: AgentDutyPublicProfile; available: boolean; automatic: boolean;
}
export interface AgentOwnerNomination { ownerAgentId: string | null; method: AgentRoutingMethod | null; reason: AgentRoutingReason; classificationCandidateIds: string[] }
export function parseAgentRoutingInput(raw: unknown): Readonly<AgentRoutingInput> {
  try { assertAgentRoutingJson(raw); routingFields(raw, ["channelId", "workItemId", "requestId", "message", "explicitAgentIds", "leadAgentId", "businessBindingRef", "expectedWorkRevision"]); }
  catch { throw new AgentBoundaryContractError("INVALID_DOCUMENT", "routing.input"); }
  const input = raw as Record<string, unknown>;
  if (typeof input.channelId !== "string" || !UUID.test(input.channelId) || !commandId(input.workItemId) || !commandId(input.requestId) || !messageBody(input.message)
    || !Array.isArray(input.explicitAgentIds) || input.explicitAgentIds.length > AGENT_ROUTING_CANDIDATE_LIMIT || !input.explicitAgentIds.every(commandId)
    || new Set(input.explicitAgentIds).size !== input.explicitAgentIds.length || !(input.leadAgentId === null || commandId(input.leadAgentId))
    || !(input.businessBindingRef === null || commandId(input.businessBindingRef)) || !commandEpoch(input.expectedWorkRevision)) throw new AgentBoundaryContractError("INVALID_DOCUMENT", "routing.input");
  return deepFreeze(structuredClone(raw)) as unknown as Readonly<AgentRoutingInput>;
}
const fold = (s: string): string => s.normalize("NFKC").trim().toLowerCase();
function matches(message: string, term: string): boolean {
  const needle = fold(term); if (!needle) return false; let at = message.indexOf(needle);
  while (at >= 0) {
    if ((!/^[a-z0-9_]/.test(needle) || !/[a-z0-9_]/.test(message[at - 1] ?? ""))
      && (!/[a-z0-9_]$/.test(needle) || !/[a-z0-9_]/.test(message[at + needle.length] ?? ""))) return true;
    at = message.indexOf(needle, at + 1);
  }
  return false;
}
export function agentDutyRejects(message: string, profile: AgentDutyPublicProfile): boolean {
  const body = fold(message); return profile.rejects.some(term => matches(body, term));
}
/** Call only AFTER Host has validated audience and constructed the public directory. */
export function nominateAgentOwner(input: Readonly<AgentRoutingInput>, directory: readonly AgentRoutingDirectoryEntry[], businessOwners: readonly string[] = []): AgentOwnerNomination {
  const none = (reason: AgentRoutingReason, classificationCandidateIds: string[] = []): AgentOwnerNomination => ({ ownerAgentId: null, method: null, reason, classificationCandidateIds });
  const selected = (id: string, method: AgentRoutingMethod): AgentOwnerNomination => ({ ownerAgentId: id, method, reason: "selected", classificationCandidateIds: [] });
  const named = input.leadAgentId ?? (input.explicitAgentIds.length === 1 ? input.explicitAgentIds[0]! : null);
  if (input.leadAgentId !== null && !input.explicitAgentIds.includes(input.leadAgentId)) return none("scope_denied");
  if (input.explicitAgentIds.length > 1 && named === null) return none("ambiguous");
  if (named !== null) {
    const candidate = directory.find(row => row.agentId === named);
    if (!candidate?.available) return none("scope_denied");
    return agentDutyRejects(input.message, candidate.publicProfile) ? none("responsibility_rejected") : selected(named, "explicit_human");
  }
  const owners = [...new Set(businessOwners)];
  if (owners.length > 1) return none("ambiguous");
  if (owners.length === 1) {
    const candidate = directory.find(row => row.agentId === owners[0]);
    if (!candidate?.available || !candidate.automatic) return none("scope_denied");
    return agentDutyRejects(input.message, candidate.publicProfile) ? none("responsibility_rejected") : selected(candidate.agentId, "business_mapping");
  }
  const candidates = directory.filter(row => row.available && row.automatic && !agentDutyRejects(input.message, row.publicProfile));
  let best = 0; const winners: string[] = [], body = fold(input.message);
  for (const row of candidates) {
    const score = [...new Set(row.publicProfile.owns.map(fold))].filter(term => matches(body, term)).length;
    if (score > best) { best = score; winners.splice(0, winners.length, row.agentId); }
    else if (score > 0 && score === best) winners.push(row.agentId);
  }
  if (winners.length > 1) return none("ambiguous"); // Never resolve ties by iteration order or classification.
  if (winners.length === 1) return selected(winners[0]!, "duty_match");
  return none("no_match", candidates.map(row => row.agentId).sort());
}
