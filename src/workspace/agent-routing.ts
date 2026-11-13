import { readWorkspaceCompletionEffects } from "./completion-evidence-store.js";
import { AgentRoutingClassifier, type AgentRoutingClassifierConfig } from "./agent-routing-classification.js";
import { redactSensitiveText, redactSensitiveValue } from "../security/secrets.js";
// C6 Host-only routing over the ORIGINAL C1/C3/C4 aggregate. No business provider is called here.
import { randomUUID } from "node:crypto";
import { AgentBoundaryContractError, parseAgentBoundaryDocument, type AgentBoundaryCommand, type AgentBoundaryOwnerDecision, type AgentBoundaryWorkClaim, type AgentBoundaryReceipt } from "./agent-boundaries-contract.js";
import { WorkspaceAgentBoundaryAuthority, type AgentRoutingClaim, type RoutingPermit } from "./agent-boundary-authority.js";
import { WorkspaceAgentCommandControl, agentCommandMessageDigest } from "./agent-command-control.js";
import type { AgentBoundaryTransport } from "./agent-boundary-transport.js";
import { commandDigest, commandEpoch, commandId, nextCommandEpoch } from "./agent-command-state.js";
import { channelSessionId } from "./channel-session.js";
import { canonical, deepFreeze, UUID } from "./local-state.js";
import { nominateAgentOwner, parseAgentRoutingInput, agentDutyRejects, type AgentRoutingInput, type AgentRoutingDirectoryEntry } from "./agent-routing-owner.js";
import { AGENT_ROUTING_ALGORITHM, agentRoutingWorkKey, routingFields, type AgentRoutingRecord, type AgentRoutingCandidateVersion, type AgentRoutingClassificationPayload, type AgentRoutingClassificationOutcome } from "./agent-routing-state.js";

export interface AgentRoutingBusinessBinding { revision: number; ownerAgentIds: readonly string[] }
export interface AgentRoutingAudience { channelId: string; revision: number; memberIds: readonly string[] }
export interface AgentRoutingProjection {
  schemaVersion: 1; kind: "agent-routing-projection"; channelId: string; workItemId: string; workKey: string; rootRequestId: string;
  revision: number; code: "NEEDS_OWNER" | null; state: "needs_owner" | "selected" | "claimed" | "blocked"; reason: string; ownerAgentId: string | null;
  method: AgentRoutingRecord["method"]; decision: AgentBoundaryOwnerDecision | null; claim: AgentBoundaryWorkClaim | null;
  receipt: AgentBoundaryReceipt | null; effectObservation: AgentBoundaryWorkClaim["effect"] | null; classification: { requestId: string; phase: string } | null; executionPermit: false;
}
const fail = (code: "AUTHORITY_UNVERIFIED" | "AUTHORIZATION_DENIED" | "STALE_REVISION" | "COMMAND_ID_CONFLICT" | "CONTROL_HELD", field: string): never => { throw new AgentBoundaryContractError(code, field); };
export class WorkspaceAgentRouting {
  private readonly classifier?: AgentRoutingClassifier;
  constructor(private readonly options: {
    authority: WorkspaceAgentBoundaryAuthority; control: WorkspaceAgentCommandControl;
    /** Current Host-owned channel metadata only, synchronous and independent of a UI socket. */
    audience(channelId: string): AgentRoutingAudience;
    automaticAgentIds(): readonly string[];
    /** Host/operator-confirmed mapping only. Not a request-supplied list. */
    businessOwners?(reference: string): AgentRoutingBusinessBinding | null;
    commandLifetimeMs?: number; classifier?: AgentRoutingClassifierConfig;
  }) { this.classifier = options.classifier ? new AgentRoutingClassifier(options.authority, options.classifier) : undefined; }
  private audience(channelId: string) {
    const row = this.options.audience(channelId);
    routingFields(row, ["channelId", "revision", "memberIds"]);
    if (row.channelId !== channelId || !UUID.test(channelId) || !commandEpoch(row.revision) || !Array.isArray(row.memberIds)
      || row.memberIds.length > 128 || !row.memberIds.every(commandId) || new Set(row.memberIds).size !== row.memberIds.length) return fail("AUTHORIZATION_DENIED", "routing.audience");
    return deepFreeze({ channelId, revision: row.revision, memberIds: [...row.memberIds].sort() });
  }
  private facts(transport: AgentBoundaryTransport, input: Readonly<AgentRoutingInput>) {
    const provenance = this.options.authority.assertRoutingTransport(transport), audience = this.audience(input.channelId);
    if (input.explicitAgentIds.some(id => !audience.memberIds.includes(id)) || input.leadAgentId !== null && !audience.memberIds.includes(input.leadAgentId)) return fail("AUTHORIZATION_DENIED", "routing.audience");
    // No directory/persona/context lookup precedes the actual audience check above.
    const snapshot = this.options.authority.routingSnapshot(transport), automatic = this.options.automaticAgentIds();
    const directory = this.options.authority.routingDirectory(transport, audience.memberIds, automatic);
    const businessBinding = input.businessBindingRef === null || input.explicitAgentIds.length ? null : this.options.businessOwners?.(input.businessBindingRef) ?? null;
    if (businessBinding !== null) {
      routingFields(businessBinding, ["revision", "ownerAgentIds"]);
      if (!commandEpoch(businessBinding.revision) || !Array.isArray(businessBinding.ownerAgentIds) || businessBinding.ownerAgentIds.length > 128
        || !businessBinding.ownerAgentIds.every(commandId) || new Set(businessBinding.ownerAgentIds).size !== businessBinding.ownerAgentIds.length) return fail("AUTHORITY_UNVERIFIED", "routing.businessBinding");
    }
    const businessOwners = [...(businessBinding?.ownerAgentIds ?? [])];
    const nomination = input.businessBindingRef !== null && !input.explicitAgentIds.length && !businessOwners.length
      ? { ownerAgentId: null, method: null, reason: "scope_denied" as const, classificationCandidateIds: [] }
      : nominateAgentOwner(input, directory, businessOwners);
    const audienceDigest = commandDigest([snapshot.context.resourceBinding, audience]);
    const catalogDigest = commandDigest([AGENT_ROUTING_ALGORITHM, [...directory].sort((a, b) => a.agentId.localeCompare(b.agentId)), businessBinding === null ? null : { revision: businessBinding.revision, ownerAgentIds: [...businessOwners].sort() }]);
    return { provenance, audience, snapshot, directory, nomination, audienceDigest, catalogDigest,
      key: agentRoutingWorkKey(snapshot.context.resourceBinding.scopeKey, snapshot.context.resourceBinding.generation, input.channelId, input.workItemId) };
  }
  private requestDigest(input: Readonly<AgentRoutingInput>): string {
    return commandDigest({ channelId: input.channelId, workItemId: input.workItemId, message: input.message,
      explicitAgentIds: input.explicitAgentIds, leadAgentId: input.leadAgentId, businessBindingRef: input.businessBindingRef });
  }
  private versions(directory: readonly AgentRoutingDirectoryEntry[]): AgentRoutingCandidateVersion[] {
    return directory.map(({ agentId, dutyRevision, policyRevision, agentEpoch, configRevision }) => ({ agentId, dutyRevision, policyRevision, agentEpoch, configRevision }));
  }
  /** Current personal audience, confirmed public duties only. Not an execution or private-read grant. */
  directory(transport: AgentBoundaryTransport, channelId: string) {
    this.options.authority.assertRoutingTransport(transport);
    const audience = this.audience(channelId);
    return this.options.authority.routingDirectory(transport, audience.memberIds, this.options.automaticAgentIds());
  }
  /** Syntactic nomination and durable ownership reservation only; no execution is started. */
  select(transport: AgentBoundaryTransport, raw: unknown): Readonly<AgentRoutingRecord> {
    const input = parseAgentRoutingInput(raw), digest = this.requestDigest(input), inputDigest = agentCommandMessageDigest(input.channelId, input.message);
    for (let attempt = 0; ; attempt++) {
      const f = this.facts(transport, input), old = f.snapshot.routing.records.find(row => row.workKey === f.key);
      if (old) {
        if (old.requestId === input.requestId && old.requestDigest !== digest || old.selectionRequestId === input.requestId && old.selectionRequestDigest !== digest) return fail("COMMAND_ID_CONFLICT", "routing.request");
        if (old.inputDigest !== inputDigest) return fail("COMMAND_ID_CONFLICT", "routing.workItem");
        if (old.state !== "needs_owner" || old.requestId === input.requestId || old.selectionRequestId === input.requestId) return old;
        if (old.revision !== input.expectedWorkRevision) return fail("STALE_REVISION", "routing.workItem");
      } else if (input.expectedWorkRevision !== 0) return fail("STALE_REVISION", "routing.workItem");
      const base: AgentRoutingRecord = old ? structuredClone(old) : {
        workKey: f.key, channelId: input.channelId, workItemId: input.workItemId, rootRequestId: input.requestId, requestId: input.requestId,
        requestDigest: digest, selectionRequestId: input.requestId, selectionRequestDigest: digest, sourceRef: commandDigest(f.provenance), inputDigest,
        commandId: randomUUID(), taskId: randomUUID(), audienceDigest: f.audienceDigest, catalogDigest: f.catalogDigest, candidates: [],
        revision: 1, state: "needs_owner", ownerAgentId: null, method: null, reason: "no_match", claim: null, classification: null,
      };
      base.audienceDigest = f.audienceDigest; base.catalogDigest = f.catalogDigest; base.candidates = this.versions(f.directory);
      base.ownerAgentId = f.nomination.ownerAgentId; base.method = f.nomination.method; base.reason = f.nomination.reason;
      base.state = base.ownerAgentId === null ? "needs_owner" : "selected"; base.selectionRequestId = input.requestId; base.selectionRequestDigest = digest;
      if (old) base.revision = nextCommandEpoch(base.revision);
      try {
        const next = this.options.authority.mutateRouting(transport, f.snapshot.revision, state => {
          // Repeat the live audience/catalog check inside the ORIGINAL authority CAS.
          const now = this.facts(transport, input);
          if (now.audienceDigest !== f.audienceDigest || now.catalogDigest !== f.catalogDigest) return fail("STALE_REVISION", "routing.selection");
          const current = state.records.find(row => row.workKey === f.key);
          if (old ? !current || canonical(current) !== canonical(old) : current !== undefined) return fail("STALE_REVISION", "routing.workItem");
          if (current) state.records[state.records.indexOf(current)] = base; else state.records.push(base);
          state.sequence = nextCommandEpoch(state.sequence); return state;
        });
        return next.routing.records.find(row => row.workKey === f.key)!;
      } catch (error) {
        if (!(error instanceof AgentBoundaryContractError && error.code === "STALE_REVISION" && attempt < 2)) throw error;
      }
    }
  }
  /** Optional preclaim classification. The one submitted request is durable before the adapter boundary. */
  async classify(transport: AgentBoundaryTransport, raw: unknown): Promise<AgentRoutingProjection> {
    const input = parseAgentRoutingInput(raw), row = this.select(transport, input), f = this.facts(transport, input);
    const observe = () => this.get(transport, input.channelId, input.workItemId)!;
    if (!this.classifier || row.state !== "needs_owner" || row.classification || !f.nomination.classificationCandidateIds.length) return observe();
    if (f.catalogDigest !== row.catalogDigest || f.audienceDigest !== row.audienceDigest) return deepFreeze({ ...observe(), reason: "stale" });
    const ids = new Set(f.nomination.classificationCandidateIds), payload: AgentRoutingClassificationPayload = {
      schemaVersion: 1, message: redactSensitiveText(input.message).text,
      candidates: f.directory.filter(candidate => ids.has(candidate.agentId)).map(candidate => ({ agentId: candidate.agentId, publicProfile: redactSensitiveValue(candidate.publicProfile).value })),
    };
    const policy = this.classifier.policy;
    if (this.classifier.inputBytes(payload) > policy.maxInputBytes) return deepFreeze({ ...observe(), reason: "classification_unavailable" });
    const entry = { ...policy, requestId: randomUUID(), maxCalls: 1 as const, inputDigest: commandDigest(payload), catalogDigest: row.catalogDigest,
      startedAt: new Date().toISOString(), phase: "submission_started" as const, candidateId: null, responseDigest: null, providerRequestRef: null };
    let permit: RoutingPermit;
    try {
      permit = this.options.authority.beginRoutingClassification(transport, f.snapshot.revision, row.workKey, row.revision, entry, payload, () => {
        const current = this.facts(transport, input);
        if (current.audienceDigest !== row.audienceDigest || current.catalogDigest !== row.catalogDigest || !current.nomination.classificationCandidateIds.length) return fail("STALE_REVISION", "routing.classification");
      });
    } catch (error) {
      if (error instanceof AgentBoundaryContractError && ["STALE_REVISION", "CONTROL_HELD", "AUTHORITY_UNVERIFIED"].includes(error.code)) return deepFreeze({ ...observe(), reason: "classification_unavailable" });
      throw error;
    }
    let outcome: AgentRoutingClassificationOutcome;
    try { outcome = await this.classifier.run(permit); }
    catch { outcome = { phase: "unknown", candidateId: null, responseDigest: null, providerRequestRef: null }; }
    for (let attempt = 0; ; attempt++) {
      try { this.options.authority.observeRoutingClassification(permit, outcome); break; }
      catch (error) {
        if (error instanceof AgentBoundaryContractError && error.code === "STALE_REVISION" && attempt < 2) continue; // Original observation only, never resubmit the provider.
        if (!this.options.authority.commandControlSourceHealthy()) throw error; break; // Original submitted identity stays UNKNOWN/read-only.
      }
    }
    return observe();
  }
  pendingClassificationTurns(): number { return this.classifier?.pendingTurns() ?? 0; }
  close(): void { this.classifier?.close(); }
  /** Only the trusted Host receives this opaque bridge. It is never a wire return value. */
  prepareDispatch(transport: AgentBoundaryTransport, raw: unknown): { command: AgentBoundaryCommand; routing: AgentRoutingClaim } {
    const input = parseAgentRoutingInput(raw), f = this.facts(transport, input), row = f.snapshot.routing.records.find(row => row.workKey === f.key);
    if (!row || row.state !== "selected" || row.ownerAgentId === null || row.inputDigest !== agentCommandMessageDigest(input.channelId, input.message)) return fail("CONTROL_HELD", "routing.owner");
    const assertAudience = () => {
      this.options.authority.assertHostCurrent();
      if (commandDigest([f.snapshot.context.resourceBinding, this.audience(input.channelId)]) !== row.audienceDigest) return fail("STALE_REVISION", "routing.audience");
    };
    const assertSelection = () => {
      const current = this.facts(transport, input);
      if (current.catalogDigest !== row.catalogDigest || current.audienceDigest !== row.audienceDigest) return fail("STALE_REVISION", "routing.selection");
      const owner = current.directory.find(candidate => candidate.agentId === row.ownerAgentId);
      if (!owner?.available || agentDutyRejects(input.message, owner.publicProfile)
        || row.method !== "classification" && (current.nomination.ownerAgentId !== row.ownerAgentId || current.nomination.method !== row.method)) return fail("STALE_REVISION", "routing.selection");
    };
    const routing = this.options.authority.prepareRoutingClaim(transport, row.workKey, row.revision, input.message, { assertSelection, assertAudience });
    const command = this.options.authority.draft(transport, row.ownerAgentId, { commandId: row.commandId, rootRequestId: row.rootRequestId,
      lifetimeMs: this.options.commandLifetimeMs ?? 30000,
      operation: { action: "task.dispatch", taskId: row.taskId, conversationId: channelSessionId(row.channelId, row.ownerAgentId), messageDigest: agentCommandMessageDigest(channelSessionId(row.channelId, row.ownerAgentId), input.message) } });
    return { command, routing };
  }
  get(transport: AgentBoundaryTransport, channelId: string, workItemId: string): AgentRoutingProjection | null {
    this.options.authority.assertRoutingTransport(transport); const audience = this.audience(channelId);
    if (!commandId(workItemId)) return fail("AUTHORIZATION_DENIED", "routing.workItem");
    const snapshot = this.options.authority.routingSnapshot(transport), key = agentRoutingWorkKey(snapshot.context.resourceBinding.scopeKey, snapshot.context.resourceBinding.generation, channelId, workItemId);
    const row = snapshot.routing.records.find(row => row.workKey === key); if (!row) return null;
    let effectObservation: AgentBoundaryWorkClaim["effect"] | null = null;
    let receipt: AgentBoundaryReceipt | null = null, claim: AgentBoundaryWorkClaim | null = null, decision: AgentBoundaryOwnerDecision | null = null;
    if (row.ownerAgentId !== null && (row.claim || snapshot.control.commands.some(record => record.command.commandId === row.commandId))) receipt = this.options.control.readReceipt(transport, row.ownerAgentId, row.commandId);
    if (row.claim) {
      const run = snapshot.control.runs.find(run => run.runId === row.claim!.runId)
        ?? (snapshot.lifecycle ? this.options.authority.lifecycleHistoricalRun(snapshot.lifecycle, row.claim.runId).run : undefined);
      if (!run || run.commandId !== row.commandId || run.agentId !== row.ownerAgentId) return fail("AUTHORITY_UNVERIFIED", "routing.claim");
      effectObservation = run.effect;
      if (!run.drainProofRef) {
        const effects = readWorkspaceCompletionEffects(this.options.authority.lifecycleStorage(), run.binding);
        const execution = snapshot.lifecycle?.executions.find(entry => entry.runId === run.runId);
        if (effects?.some(effect => effect.state === "unknown") || effects === null && execution?.phase === "issued") effectObservation = "unknown";
      }
      const c = parseAgentBoundaryDocument({ schemaVersion: 1, mode: "personal", context: snapshot.context, kind: "work-claim",
        rootRequestId: run.rootRequestId, taskId: run.taskId, agentId: run.agentId, claimRevision: run.claimRevision,
        attemptId: run.leaseAttemptId, effect: run.effect, effectId: run.effectId });
      const d = parseAgentBoundaryDocument({ schemaVersion: 1, mode: "personal", context: snapshot.context, kind: "owner-decision",
        rootRequestId: run.rootRequestId, dutyRevision: row.candidates.find(candidate => candidate.agentId === run.agentId)!.dutyRevision,
        state: "owned", ownerAgentId: run.agentId, reason: "current_owner" });
      if (c.kind !== "work-claim" || d.kind !== "owner-decision") return fail("AUTHORITY_UNVERIFIED", "routing.projection"); claim = c; decision = d;
    }
    const audienceChanged = commandDigest([snapshot.context.resourceBinding, audience]) !== row.audienceDigest;
    const blocked = effectObservation === "unknown" || audienceChanged && row.ownerAgentId !== null || receipt?.status === "unknown" || receipt?.status === "rejected" || receipt?.control.holdId !== null && receipt !== null;
    return deepFreeze({ schemaVersion: 1, kind: "agent-routing-projection", channelId, workItemId, workKey: key, rootRequestId: row.rootRequestId,
      revision: row.revision, code: row.state === "needs_owner" ? "NEEDS_OWNER" : null, state: blocked ? "blocked" : row.state, reason: effectObservation === "unknown" || receipt?.status === "unknown" ? "unknown_effect" : audienceChanged && row.ownerAgentId !== null ? "audience_changed" : blocked ? "control_held" : row.reason,
      ownerAgentId: row.ownerAgentId, method: row.method, decision, claim, receipt, effectObservation,
      classification: row.classification ? { requestId: row.classification.requestId, phase: row.classification.phase === "submission_started" ? "unknown" : row.classification.phase } : null,
      executionPermit: false });
  }
}
