// C6 Host-private facts. Neither these JSON records nor a proposal is an execution permit.
import { AgentBoundaryContractError, type AgentBoundaryContext } from "./agent-boundaries-contract.js";
import { commandDigest, commandEpoch, commandId, type AgentCommandState } from "./agent-command-state.js";
import { canonical, plain, positive, UUID } from "./local-state.js";

export const AGENT_ROUTING_RECORD_LIMIT = 128;
export const AGENT_ROUTING_CANDIDATE_LIMIT = 128;
export const AGENT_ROUTING_STATE_BYTES = 512 * 1024;
export const AGENT_ROUTING_ALGORITHM = "public-duty-v1";
export interface AgentRoutingCandidateVersion { agentId: string; dutyRevision: number; policyRevision: number; agentEpoch: number; configRevision: number }
export type AgentRoutingMethod = "explicit_human" | "business_mapping" | "duty_match" | "classification";
export type AgentRoutingReason = "no_match" | "ambiguous" | "scope_denied" | "classification_unavailable" | "responsibility_rejected" | "stale" | "selected" | "current_owner";
export interface AgentRoutingClassification {
  requestId: string; providerRef: string; inputDigest: string; catalogDigest: string; startedAt: string;
  phase: "submission_started" | "completed" | "unknown" | "failed"; candidateId: string | null; responseDigest: string | null;
}
export interface AgentRoutingRecord {
  workKey: string; channelId: string; workItemId: string; rootRequestId: string; requestId: string; inputDigest: string;
  commandId: string; taskId: string; audienceDigest: string; catalogDigest: string; candidates: AgentRoutingCandidateVersion[];
  revision: number; state: "needs_owner" | "selected" | "claimed"; ownerAgentId: string | null; method: AgentRoutingMethod | null; reason: AgentRoutingReason;
  claim: { commandId: string; taskId: string; runId: string; claimRevision: number } | null;
  classification: AgentRoutingClassification | null;
}
export interface AgentRoutingState {
  schemaVersion: 1; migration: { fromSchema: 3; sourceDigest: string; at: string }; sequence: number; records: AgentRoutingRecord[];
}
export const routingFail = (field = "routing.store"): never => { throw new AgentBoundaryContractError("AUTHORITY_UNVERIFIED", field); };
export function routingFields(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!plain(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return routingFail();
  const descriptors = Object.getOwnPropertyDescriptors(value), own = Reflect.ownKeys(descriptors);
  if (own.length !== keys.length || own.some(key => typeof key !== "string" || !keys.includes(key) || !descriptors[key]!.enumerable || !Object.hasOwn(descriptors[key]!, "value"))) return routingFail();
}
/** Validate descriptors before canonicalizing even direct library inputs. */
function jsonOnly(value: unknown, depth = 0, budget = { nodes: 100000 }): void {
  if (--budget.nodes < 0 || depth > 24) return routingFail();
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return;
  if (!value || typeof value !== "object") return routingFail();
  const array = Array.isArray(value);
  if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return routingFail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (array && key === "length") continue;
    if (typeof key !== "string" || array && !/^(0|[1-9][0-9]*)$/.test(key) || !descriptors[key]!.enumerable || !Object.hasOwn(descriptors[key]!, "value")) return routingFail();
    jsonOnly(descriptors[key]!.value, depth + 1, budget);
  }
  if (array && Object.keys(descriptors).length !== (value as unknown[]).length + 1) return routingFail();
}
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const timestamp = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));
export function agentRoutingWorkKey(scopeKey: string, generation: string, channelId: string, workItemId: string): string {
  if (!hash(scopeKey) || !UUID.test(generation) || !UUID.test(channelId) || !commandId(workItemId)) return routingFail("routing.workKey");
  return commandDigest(["hara-agent-routing-v1", scopeKey, generation, channelId, workItemId]);
}
export function emptyAgentRoutingState(sourceDigest: string, at: string): AgentRoutingState {
  if (!hash(sourceDigest) || !timestamp(at)) return routingFail();
  return { schemaVersion: 1, migration: { fromSchema: 3, sourceDigest, at }, sequence: 0, records: [] };
}
export function assertAgentRoutingCapacity(state: AgentRoutingState): void {
  if (state.records.length > AGENT_ROUTING_RECORD_LIMIT || Buffer.byteLength(canonical(state)) > AGENT_ROUTING_STATE_BYTES) return routingFail("routing.capacity");
}
export function parseAgentRoutingState(raw: unknown, control: AgentCommandState, binding: AgentBoundaryContext["resourceBinding"],
  retired: readonly { runId: string; commandId: string; taskId: string; rootRequestId: string; agentId: string; claimRevision: number }[] = []): AgentRoutingState {
  jsonOnly(raw);
  routingFields(raw, ["schemaVersion", "migration", "sequence", "records"]); routingFields(raw.migration, ["fromSchema", "sourceDigest", "at"]);
  if (raw.schemaVersion !== 1 || raw.migration.fromSchema !== 3 || !hash(raw.migration.sourceDigest) || !timestamp(raw.migration.at)
    || !commandEpoch(raw.sequence) || !Array.isArray(raw.records)) return routingFail();
  const value = raw as unknown as AgentRoutingState; assertAgentRoutingCapacity(value);
  const keys = new Set<string>(), roots = new Set<string>(), commands = new Set<string>(), tasks = new Set<string>();
  for (const r of value.records) {
    routingFields(r, ["workKey", "channelId", "workItemId", "rootRequestId", "requestId", "inputDigest", "commandId", "taskId", "audienceDigest", "catalogDigest", "candidates", "revision", "state", "ownerAgentId", "method", "reason", "claim", "classification"]);
    if (![r.workKey, r.inputDigest, r.audienceDigest, r.catalogDigest].every(hash) || !UUID.test(r.channelId)
      || ![r.workItemId, r.rootRequestId, r.requestId, r.commandId, r.taskId].every(commandId) || !positive(r.revision)
      || keys.has(r.workKey) || roots.has(r.rootRequestId) || commands.has(r.commandId) || tasks.has(r.taskId)
      || !["needs_owner", "selected", "claimed"].includes(r.state) || !["no_match", "ambiguous", "scope_denied", "classification_unavailable", "responsibility_rejected", "stale", "selected", "current_owner"].includes(r.reason)
      || !(r.method === null || ["explicit_human", "business_mapping", "duty_match", "classification"].includes(r.method))
      || !(r.ownerAgentId === null || commandId(r.ownerAgentId)) || !Array.isArray(r.candidates) || r.candidates.length > AGENT_ROUTING_CANDIDATE_LIMIT) return routingFail();
    if (r.workKey !== agentRoutingWorkKey(binding.scopeKey, binding.generation, r.channelId, r.workItemId)) return routingFail("routing.workKey");
    keys.add(r.workKey); roots.add(r.rootRequestId); commands.add(r.commandId); tasks.add(r.taskId);
    const agents = new Set<string>();
    for (const c of r.candidates) {
      routingFields(c, ["agentId", "dutyRevision", "policyRevision", "agentEpoch", "configRevision"]);
      if (!commandId(c.agentId) || agents.has(c.agentId) || ![c.dutyRevision, c.policyRevision, c.agentEpoch, c.configRevision].every(positive)) return routingFail(); agents.add(c.agentId);
    }
    const selected = r.state !== "needs_owner";
    if (selected !== (r.ownerAgentId !== null) || selected !== (r.method !== null) || selected && !agents.has(r.ownerAgentId!)
      || r.state === "selected" && r.reason !== "selected" || r.state === "claimed" && r.reason !== "current_owner"
      || r.state === "needs_owner" && ["selected", "current_owner"].includes(r.reason) || (r.state === "claimed") !== (r.claim !== null)) return routingFail();
    if (r.claim) {
      routingFields(r.claim, ["commandId", "taskId", "runId", "claimRevision"]);
      if (r.claim.commandId !== r.commandId || r.claim.taskId !== r.taskId || !commandId(r.claim.runId) || !positive(r.claim.claimRevision)) return routingFail();
      // Immutable C4 history may retire this run; the authority verifies that history on use.
      const run = control.runs.find(run => run.runId === r.claim!.runId) ?? retired.find(run => run.runId === r.claim!.runId);
      if (!run || (run.commandId !== r.commandId || run.taskId !== r.taskId || run.rootRequestId !== r.rootRequestId || run.agentId !== r.ownerAgentId || run.claimRevision !== r.claim.claimRevision)) return routingFail();
    }
    if (r.classification) {
      const c = r.classification; routingFields(c, ["requestId", "providerRef", "inputDigest", "catalogDigest", "startedAt", "phase", "candidateId", "responseDigest"]);
      if (!commandId(c.requestId) || !commandId(c.providerRef) || !hash(c.inputDigest) || !hash(c.catalogDigest) || !timestamp(c.startedAt)
        || !["submission_started", "completed", "unknown", "failed"].includes(c.phase) || !(c.candidateId === null || agents.has(c.candidateId))
        || !(c.responseDigest === null || hash(c.responseDigest)) || c.phase !== "completed" && c.candidateId !== null
        || r.method === "classification" && (c.phase !== "completed" || c.candidateId !== r.ownerAgentId)) return routingFail();
    } else if (r.method === "classification") return routingFail();
  }
  return structuredClone(value);
}
/** Retains exact identities and completed/unknown classification requests. No eviction or ID reset. */
export function assertAgentRoutingTransition(before: AgentRoutingState, after: AgentRoutingState): void {
  assertAgentRoutingCapacity(after);
  if (canonical(before.migration) !== canonical(after.migration) || after.records.length < before.records.length
    || (canonical(before.records) === canonical(after.records) ? after.sequence !== before.sequence : after.sequence !== before.sequence + 1)) return routingFail("routing.transition");
  for (const old of before.records) {
    const next = after.records.find(row => row.workKey === old.workKey); if (!next) return routingFail("routing.transition");
    if (canonical(old) === canonical(next) ? next.revision !== old.revision : next.revision !== old.revision + 1) return routingFail("routing.revision");
    for (const key of ["channelId", "workItemId", "rootRequestId", "requestId", "inputDigest", "commandId", "taskId"] as const)
      if (old[key] !== next[key]) return routingFail("routing.transition");
    if (old.state === "claimed" && canonical(old) !== canonical(next) || old.state !== "claimed" && next.state === "claimed" && !next.claim) return routingFail("routing.claim");
    if (old.classification) {
      if (!next.classification) return routingFail("routing.classification");
      for (const key of ["requestId", "providerRef", "inputDigest", "catalogDigest", "startedAt"] as const)
        if (old.classification[key] !== next.classification[key]) return routingFail("routing.classification");
      if (old.classification.phase !== "submission_started" && canonical(old.classification) !== canonical(next.classification)) return routingFail("routing.classification");
    }
  }
}
