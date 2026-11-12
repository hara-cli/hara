import { channelSessionId } from "./channel-session.js";
import type { AgentRoutingDirectoryEntry } from "./agent-routing-owner.js";
import { emptyAgentRoutingState, parseAgentRoutingState, assertAgentRoutingJson, assertAgentRoutingCapacity, assertAgentRoutingTransition, type AgentRoutingState, type AgentRoutingRecord, type AgentRoutingClassification, type AgentRoutingClassificationPayload, type AgentRoutingClassificationOutcome } from "./agent-routing-state.js";
import { WorkspaceAgentLifecycleHistory } from "./agent-lifecycle-history.js";
import { assertAgentLifecycleCapacity, assertAgentLifecycleTransition, migrateAgentLifecycleState, parseAgentLifecycleState, type AgentLifecycleState, type AgentLifecycleRun, type AgentLifecycleRecoveryV1 } from "./agent-lifecycle-state.js";
import { WorkspaceFeatures } from "./features.js";
import { assertNoWorkspaceLegacyEffects } from "./agent-command-protection.js";
import { assertNoWorkspaceSessionLeases, withWorkspaceSessionAdmission } from "./session-lease.js";
import type { WorkspaceRunBinding } from "./run-binding.js";
import { agentCommandMessageDigest, assertAgentCommandTransition, agentCommandTargetEpoch, agentPolicyProposalDigest, commandDigest, nextCommandEpoch, emptyAgentCommandState, parseAgentCommandState, type AgentCommandState, type AgentCommandRun, type AgentCommandRetirement } from "./agent-command-state.js";
import { createHash, randomUUID } from "node:crypto";
import {
  AgentBoundaryContractError, agentBoundaryCommandSigningText, assertAgentBoundaryContext, parseAgentBoundaryDocument,
  type AgentBoundaryAction, type AgentBoundaryCommand, type AgentBoundaryContext, type AgentBoundaryErrorCode,
  type AgentDutyProfile, type AgentExecutionBoundary,
} from "./agent-boundaries-contract.js";
import { AgentBoundaryTransports, type AgentBoundaryTransport } from "./agent-boundary-transport.js";
import type { LocalWorkspaceCatalog } from "./local-catalog.js";
import type { WorkspaceResources } from "./resources.js";
import { currentWorkspaceResourceBinding, sameWorkspaceResourceBinding, type WorkspaceResourceBinding,
  type WorkspaceResourceStorage } from "./resource-context.js";
import { canonical, deepFreeze, plain, positive, WorkspaceJsonState } from "./local-state.js";
import type { WorkspaceAgentView } from "./agents.js";
import type { AgentHubDirectory } from "../agent-hub/contracts.js";

export interface AgentBoundaryRights { manage: boolean; invoke: boolean; privateRead: boolean; nodeUse: boolean }
/** Host-owned resource attestations, not caller paths or serialized grants. */
export interface AgentBoundaryResource {
  resourceId: string; agentId: string; revision: number; binding: WorkspaceResourceBinding;
  access: readonly ("read" | "write" | "execute")[]; assertCurrent(): void;
  /** Optional physical root from the SAME trusted registry entry; absence cannot grant file IO. */
  project?: Readonly<{ root: string; dev: string | number; ino: string | number }>;
}
export interface AgentBoundaryTool {
  toolId: string; connectorId: string | null; catalogRevision: number; assertCurrent(): void;
}
interface Policy {
  agentId: string; revision: number; agentEpoch: number; configRevision: number;
  rights: AgentBoundaryRights; duty: AgentDutyProfile; boundary: AgentExecutionBoundary;
  resources: { resourceId: string; revision: number }[];
}
interface Executor {
  executorRef: string; externalAgentId: string; instanceId: string; agentId: string | null;
  resourceId: string | null; controlled: false;
}
interface State { schemaVersion: 1 | 2 | 3 | 4; revision: number; resourceBinding: WorkspaceResourceBinding; policies: Policy[]; executors: Executor[]; control?: AgentCommandState; lifecycle?: AgentLifecycleState; routing?: AgentRoutingState }
export interface AgentCommandMutation {
  command: AgentBoundaryCommand; control: AgentCommandState; authorizationError: AgentBoundaryErrorCode | null;
  policyRevision: number; proposedPolicyRevision: number | null;
  agentKind: WorkspaceAgentView["kind"] | null; agentResource: { agentEpoch: number; configRevision: number } | null; rights: AgentBoundaryRights | null; lifecycle?: AgentLifecycleState; routing?: AgentRoutingState;
}
export interface AgentCommandMutationResult { control: AgentCommandState; applyPolicy?: boolean; lifecycle?: AgentLifecycleState; routing?: AgentRoutingState }
declare const grantBrand: unique symbol;
/** C1 intent authority only. It is neither a runtime ExecutionPermit nor a C3 receipt. */
export interface AgentCommandGrant { readonly [grantBrand]: true }
declare const executionPolicyBrand: unique symbol;
/** Current C1 policy only, after authenticated command admission. Still NOT a C2/C3 execution permit. */
export interface AgentExecutionPolicy { readonly [executionPolicyBrand]: true }
interface ExecutionPolicyState { command: AgentBoundaryCommand; policyRevision: number; live: boolean }
interface GrantState { transport: AgentBoundaryTransport; command: AgentBoundaryCommand; policyRevision: number; live: boolean }
declare const routingClaimBrand: unique symbol;
export interface AgentRoutingClaim { readonly [routingClaimBrand]: true }
interface RoutingClaimState { workKey: string; revision: number; channelId: string; conversationId: string; messageDigest: string; assertSelection(): void; assertAudience(): void }
declare const routingPermitBrand: unique symbol;
export interface RoutingPermit { readonly [routingPermitBrand]: true }
interface RoutingPermitState { transport: AgentBoundaryTransport; workKey: string; entry: AgentRoutingClassification; payload: AgentRoutingClassificationPayload; assertCurrent(): void; used: boolean; submitted: boolean }


const fail = (code: AgentBoundaryErrorCode, field = "authority"): never => { throw new AgentBoundaryContractError(code, field); };
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const id = (value: unknown): value is string => typeof value === "string" && ID.test(value);
/** Inspect descriptors before reading fields, including direct Host-library callers. */
function fields(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!plain(value)) return fail("INVALID_DOCUMENT");
  const descriptors = Object.getOwnPropertyDescriptors(value), own = Reflect.ownKeys(descriptors);
  if (own.length !== keys.length || own.some(key => typeof key !== "string" || !keys.includes(key)
    || !descriptors[key]!.enumerable || !Object.hasOwn(descriptors[key]!, "value"))) return fail("INVALID_DOCUMENT");
}
function rights(value: unknown): AgentBoundaryRights {
  fields(value, ["manage", "invoke", "privateRead", "nodeUse"]);
  if (Object.values(value).some(item => typeof item !== "boolean")) return fail("INVALID_DOCUMENT", "authority.rights");
  return { manage: value.manage as boolean, invoke: value.invoke as boolean, privateRead: value.privateRead as boolean, nodeUse: value.nodeUse as boolean };
}
function nextRevision(previous: AgentDutyProfile | AgentExecutionBoundary | undefined, next: AgentDutyProfile | AgentExecutionBoundary): void {
  const key = next.kind === "duty-profile" ? "dutyRevision" : "boundaryRevision";
  const revision = key === "dutyRevision" ? (next as AgentDutyProfile).dutyRevision : (next as AgentExecutionBoundary).boundaryRevision;
  if (!previous) { if (revision !== 1) fail("STALE_REVISION"); return; }
  const oldRevision = previous.kind === "duty-profile" ? previous.dutyRevision : previous.boundaryRevision;
  if (revision === oldRevision && canonical(previous) === canonical(next)) return;
  if (oldRevision >= Number.MAX_SAFE_INTEGER) return fail("COUNTER_EXHAUSTED");
  if (revision !== oldRevision + 1) fail("STALE_REVISION");
}

/** Reuses the existing catalog owner/grant, resource generation and Agent registry as parents.
 * The only new persistent authority is the explicit per-Agent C0 policy; no persona/owns import.
 * Current permissions are re-read, never cached as an allow decision. */
export class WorkspaceAgentBoundaryAuthority {
  private readonly state: WorkspaceJsonState<State>;
  private readonly grants = new WeakMap<object, GrantState>();
  private readonly executionPolicies = new WeakMap<object, ExecutionPolicyState>();
  private readonly routingClaims = new WeakMap<object, RoutingClaimState>();
  private readonly routingPermits = new WeakMap<object, RoutingPermitState>();
  private readonly routingRuns = new Map<string, { workKey: string; assertAudience(): void }>();
  private readonly parent: { hostId: string; hostEpoch: number; row: string; context: AgentBoundaryContext };
  private closed = false;
  private controlStorageFailed = false;
  private controlledStateSeen = false;
  private lifecycleStateSeen = false;
  private routingStateSeen = false;
  private readonly now: () => number;
  private readonly lifetime: number;
  constructor(private readonly options: {
    catalog: LocalWorkspaceCatalog; resources: WorkspaceResources; storage: WorkspaceResourceStorage;
    transports: AgentBoundaryTransports; assertHostLive?(): void;
    resourcesForAgent?(agentId: string): readonly AgentBoundaryResource[];
    toolsForAgent?(agentId: string): readonly AgentBoundaryTool[];
    externalDirectory?: AgentHubDirectory; commandControl?: boolean; lifecycleControl?: boolean; routingControl?: boolean; now?: () => number; maxCommandLifetimeMs?: number;
  }) {
    if (options.routingControl && !options.lifecycleControl) fail("AUTHORITY_UNVERIFIED", "routing.bootstrap");
    if (options.lifecycleControl && !options.commandControl) fail("AUTHORITY_UNVERIFIED", "lifecycle.bootstrap");
    const catalog = options.catalog.read(), row = options.catalog.resolve(options.storage.scope.workspaceId);
    if (canonical(row.scope) !== canonical(options.storage.scope) || canonical(row.scope) !== canonical(options.resources.scope)) fail("CONTEXT_MISMATCH");
    const binding = options.storage.run(() => currentWorkspaceResourceBinding()!);
    const context: AgentBoundaryContext = deepFreeze({ scope: row.scope, resourceBinding: binding,
      humanSubjectId: row.actorId, nodeId: catalog.hostId, deviceId: null,
      localGrant: { grantId: row.grantId, grantRevision: row.grantRevision, humanSubjectId: row.actorId, nodeId: catalog.hostId },
      collaboration: { organizationId: null, membershipId: null, membershipVersion: null, role: null, delegation: null } });
    this.parent = { hostId: catalog.hostId, hostEpoch: catalog.hostEpoch,
      row: canonical([row.scope, row.actorId, row.policyRevision, row.grantId, row.grantRevision]), context };
    this.now = options.now ?? Date.now; this.lifetime = options.maxCommandLifetimeMs ?? 300_000;
    if (!Number.isSafeInteger(this.lifetime) || this.lifetime < 1 || this.lifetime > 300_000) fail("INVALID_DOCUMENT");
    this.state = new WorkspaceJsonState<State>(options.storage, "workspace-agent-authority-v1.json", raw => this.parse(raw),
      () => ({ schemaVersion: 1, revision: 0, resourceBinding: this.state.binding(), policies: [], executors: [] }));
    this.assertHostCurrent();
  }
  /** Also usable by a trusted passive Hub writer; it does not authenticate that writer as human. */
  assertHostCurrent(): void {
    if (this.closed) return fail("GRANT_REVOKED");
    try {
      if (this.options.assertHostLive && this.options.assertHostLive() !== undefined) fail("AUTHORITY_UNVERIFIED");
      const catalog = this.options.catalog.read(), row = this.options.catalog.resolve(this.options.storage.scope.workspaceId);
      if (catalog.hostId !== this.parent.hostId || catalog.hostEpoch !== this.parent.hostEpoch
        || canonical([row.scope, row.actorId, row.policyRevision, row.grantId, row.grantRevision]) !== this.parent.row) fail("GRANT_REVOKED");
      this.options.storage.run(() => {
        if (!sameWorkspaceResourceBinding(currentWorkspaceResourceBinding()!, this.parent.context.resourceBinding)) fail("CONTEXT_MISMATCH");
      });
    } catch (error) {
      if (error instanceof AgentBoundaryContractError) throw error;
      fail("AUTHORITY_UNVERIFIED", "authority.parent");
    }
  }
  private source(transport: AgentBoundaryTransport) {
    const source = this.options.transports.provenance(transport); this.assertHostCurrent(); return source;
  }
  private agent(agentId: string): WorkspaceAgentView {
    if (!id(agentId)) return fail("INVALID_DOCUMENT");
    let agent: WorkspaceAgentView | null;
    try { agent = this.options.resources.agents.get(agentId); }
    catch { return fail("AUTHORITY_UNVERIFIED", "authority.agent"); }
    if (!agent || agent.state !== "active" || agent.workspaceId !== this.options.storage.scope.workspaceId) return fail("AUTHORIZATION_DENIED", "authority.agent");
    return agent;
  }
  private parse(raw: unknown): State {
    const version = plain(raw) ? Object.getOwnPropertyDescriptor(raw, "schemaVersion")?.value : undefined;
    const controlled = version === 2 || version === 3 || version === 4;
    fields(raw, ["schemaVersion", "revision", "resourceBinding", "policies", "executors", ...(controlled ? ["control"] : []), ...([3, 4].includes(version) ? ["lifecycle"] : []), ...(version === 4 ? ["routing"] : [])]);
    if (raw.schemaVersion !== 1 && raw.schemaVersion !== 2 && raw.schemaVersion !== 3 && raw.schemaVersion !== 4 || !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 0
      || !sameWorkspaceResourceBinding(raw.resourceBinding as WorkspaceResourceBinding, this.state.binding())
      || !Array.isArray(raw.policies) || raw.policies.length > 4096 || !Array.isArray(raw.executors) || raw.executors.length > 4096) fail("INVALID_DOCUMENT", "authority.policy");
    const seen = new Set<string>();
    for (const value of raw.policies as unknown[]) {
      fields(value, ["agentId", "revision", "agentEpoch", "configRevision", "rights", "duty", "boundary", "resources"]);
      if (!id(value.agentId) || seen.has(value.agentId) || !positive(value.revision) || !positive(value.agentEpoch)
        || !positive(value.configRevision) || !Array.isArray(value.resources)) fail("INVALID_DOCUMENT", "authority.policy");
      seen.add(value.agentId as string); rights(value.rights);
      const duty = parseAgentBoundaryDocument(value.duty), boundary = parseAgentBoundaryDocument(value.boundary);
      if (duty.kind !== "duty-profile" || boundary.kind !== "execution-boundary" || duty.agentId !== value.agentId
        || boundary.agentId !== value.agentId || canonical(duty.context) !== canonical(boundary.context)
        || canonical(duty.context.scope) !== canonical(this.options.storage.scope)
        || !sameWorkspaceResourceBinding(duty.context.resourceBinding, this.state.binding())) return fail("CONTEXT_MISMATCH", "authority.policy");
      const refs = new Set<string>();
      for (const ref of value.resources as unknown[]) {
        fields(ref, ["resourceId", "revision"]);
        if (!id(ref.resourceId) || !positive(ref.revision) || refs.has(ref.resourceId)) fail("INVALID_DOCUMENT"); refs.add(ref.resourceId as string);
      }
      if (refs.size !== boundary.resources.length || boundary.resources.some(ref => !refs.has(ref.resourceId))) fail("INVALID_DOCUMENT");
    }
    const executors = new Set<string>();
    for (const value of raw.executors as unknown[]) {
      fields(value, ["executorRef", "externalAgentId", "instanceId", "agentId", "resourceId", "controlled"]);
      if (!id(value.executorRef) || executors.has(value.executorRef) || !id(value.externalAgentId) || !id(value.instanceId)
        || !(value.agentId === null || id(value.agentId)) || !(value.resourceId === null || id(value.resourceId))
        || value.controlled !== false || value.agentId === null && value.resourceId !== null) fail("INVALID_DOCUMENT");
      executors.add(value.executorRef as string);
    }
    if (controlled) {
      const control = parseAgentCommandState(raw.control, this.parent.context);
      if (version === 3 || version === 4) {
        const lifecycle = parseAgentLifecycleState(raw.lifecycle, control);
        if (version === 4) parseAgentRoutingState(raw.routing, control, this.parent.context.resourceBinding, lifecycle.retiredRuns);
      }
    }
    return structuredClone(raw) as unknown as State;
  }
  private read(): State {
    this.assertHostCurrent();
    try {
      const state = this.state.read();
      if (state.schemaVersion === 4 && !this.options.routingControl) return fail("AUTHORITY_UNVERIFIED", "routing.bootstrap");
      if (state.schemaVersion === 4) this.routingStateSeen = true;
      else if (this.routingStateSeen) this.controlStorageFailed = true;
      if (state.schemaVersion !== 1) this.controlledStateSeen = true;
      else if (this.controlledStateSeen) this.controlStorageFailed = true;
      if (state.schemaVersion >= 3) this.lifecycleStateSeen = true;
      else if (this.lifecycleStateSeen) this.controlStorageFailed = true;
      return state;
    } catch (error) {
      if (this.options.commandControl || this.controlledStateSeen) this.controlStorageFailed = true;
      if (error instanceof AgentBoundaryContractError) throw error; return fail("AUTHORITY_UNVERIFIED", "authority.policy");
    }
  }
  private update(expectedRevision: unknown, change: (state: State) => State, action?: AgentBoundaryAction, reserveLifecycle = false): State {
    if (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 0) return fail("INVALID_DOCUMENT", "authority.revision");
    let rejectedChange: { error: unknown } | undefined;
    try { return this.state.update(expectedRevision as number, state => {
      if (state.schemaVersion !== 1) this.controlledStateSeen = true;
      else if (this.controlledStateSeen) { this.controlStorageFailed = true; return fail("AUTHORITY_UNVERIFIED", "control.migrationRecovery"); }
      if (state.schemaVersion >= 3) this.lifecycleStateSeen = true;
      else if (this.lifecycleStateSeen) { this.controlStorageFailed = true; return fail("AUTHORITY_UNVERIFIED", "lifecycle.migrationRecovery"); }
      if (state.schemaVersion === 4) this.routingStateSeen = true;
      else if (this.routingStateSeen) { this.controlStorageFailed = true; return fail("AUTHORITY_UNVERIFIED", "routing.migrationRecovery"); }
      let next: State, retirement: AgentCommandRetirement | undefined;
      try {
        if (state.schemaVersion >= 3 && !this.options.lifecycleControl) return fail("AUTHORITY_UNVERIFIED", "lifecycle.bootstrap");
        if (state.schemaVersion === 4 && !this.options.routingControl) return fail("AUTHORITY_UNVERIFIED", "routing.bootstrap");
        next = change(state);
        if (next.routing) assertAgentRoutingCapacity(next.routing);
        if (next.lifecycle) {
          assertAgentLifecycleCapacity(next.lifecycle, next.control, reserveLifecycle || action !== undefined && !["task.stop", "agent.pause", "agent.dismiss"].includes(action));
          if (state.lifecycle && state.control && next.control) retirement = this.history().retirement(state.control, state.lifecycle, next.control, next.lifecycle);
          if (Buffer.byteLength(canonical(next)) > 3.75 * 1024 * 1024) fail("AUTHORITY_UNVERIFIED", "lifecycle.capacity");
        }
      }
      catch (error) { rejectedChange = { error }; throw error; }
      if (state.routing) { if (!next.routing) return fail("AUTHORITY_UNVERIFIED", "routing.transition"); assertAgentRoutingTransition(state.routing, next.routing); }
      if (state.lifecycle) { if (!next.lifecycle) return fail("AUTHORITY_UNVERIFIED", "lifecycle.transition"); assertAgentLifecycleTransition(state.lifecycle, next.lifecycle); }
      if (state.control) { if (!next.control) return fail("AUTHORITY_UNVERIFIED", "control.transition"); assertAgentCommandTransition(state.control, next.control, action, retirement); }
      return next;
    }); }
    catch (error) {
      // A rejected command callback never reached validation/publication. Its own lease or
      // deadline must not poison unrelated runs. Compare identity: lock-release IO can replace
      // the callback error and still must take the shared storage-failure path below.
      if (rejectedChange && Object.is(error, rejectedChange.error)) {
        if (error instanceof AgentBoundaryContractError) throw error;
        return fail("AUTHORITY_UNVERIFIED", "authority.command");
      }
      if (error instanceof Error && error.message === "Workspace state changed; refresh before writing") return fail("STALE_REVISION");
      if (error instanceof Error && error.message === "Workspace revision exhausted") return fail("COUNTER_EXHAUSTED");
      // Read/parse, transition, validation and actual publication failures remain permanently fenced.
      if (this.options.commandControl || this.controlledStateSeen) this.controlStorageFailed = true;
      if (error instanceof AgentBoundaryContractError) throw error;
      return fail("AUTHORITY_UNVERIFIED", "authority.policy");
    }
  }
  private resourceVersions(agentId: string, boundary: AgentExecutionBoundary) {
    const available = this.options.resourcesForAgent?.(agentId) ?? [], seen = new Set<string>();
    for (const item of available) {
      if (!id(item.resourceId) || seen.has(item.resourceId) || !positive(item.revision)
        || item.agentId !== agentId || !sameWorkspaceResourceBinding(item.binding, this.parent.context.resourceBinding)
        || item.assertCurrent() !== undefined) fail("AUTHORITY_UNVERIFIED", "authority.resource"); seen.add(item.resourceId);
    }
    return boundary.resources.map(ref => {
      const item = available.find(item => item.resourceId === ref.resourceId);
      if (!item || ref.access.some(access => !item.access.includes(access))) return fail("AUTHORIZATION_DENIED", "authority.resource");
      return { resourceId: item.resourceId, revision: item.revision };
    });
  }
  private checkTools(agentId: string, boundary: AgentExecutionBoundary): void {
    const available = this.options.toolsForAgent?.(agentId) ?? [];
    for (const ref of boundary.tools.allow) {
      const tool = available.find(item => item.toolId === ref.toolId && item.connectorId === ref.connectorId && item.catalogRevision === ref.catalogRevision);
      if (!tool || tool.assertCurrent() !== undefined || boundary.tools.deny.some(deny => deny.toolId === ref.toolId && deny.connectorId === ref.connectorId)) fail("AUTHORIZATION_DENIED", "authority.tool");
    }
  }
  private currentPolicy(agentId: string, policy: Policy | undefined): Policy {
    if (!policy) return fail("BOUNDARY_CONFIRMATION_REQUIRED", "authority.policy");
    const agent = this.agent(agentId);
    if (agent.agentEpoch !== policy.agentEpoch || agent.configRevision !== policy.configRevision) fail("STALE_REVISION", "authority.agent");
    assertAgentBoundaryContext(policy.duty, this.parent.context); assertAgentBoundaryContext(policy.boundary, this.parent.context);
    if (canonical(this.resourceVersions(agentId, policy.boundary)) !== canonical(policy.resources)) fail("STALE_REVISION", "authority.resource");
    this.checkTools(agentId, policy.boundary); return policy;
  }
  private executorView(executor: Executor) {
    let currentRegistration = false;
    try {
      const registered = this.options.externalDirectory?.registeredAgent(executor.externalAgentId);
      currentRegistration = registered?.agentId === executor.externalAgentId && registered.instanceId === executor.instanceId;
      if (currentRegistration && executor.agentId !== null) {
        this.agent(executor.agentId);
        if (executor.resourceId !== null) currentRegistration = Boolean(this.options.resourcesForAgent?.(executor.agentId)
          .some(resource => resource.resourceId === executor.resourceId && resource.assertCurrent() === undefined));
      }
    } catch { currentRegistration = false; }
    return { ...executor, currentRegistration };
  }
  view(transport: AgentBoundaryTransport, agentId: string) {
    const provenance = this.source(transport), agent = this.agent(agentId), state = this.read();
    const policy = state.policies.find(row => row.agentId === agentId); let current = false;
    if (policy) { try { this.currentPolicy(agentId, policy); current = true; } catch { /* Display retained state, never an allow. */ } }
    this.source(transport);
    return deepFreeze({ context: this.parent.context, provenance, revision: state.revision,
      agent: { agentId, agentEpoch: agent.agentEpoch, configRevision: agent.configRevision },
      configured: Boolean(policy), current, policy: policy ?? null,
      executors: state.executors.filter(row => row.agentId === agentId || row.agentId === null).map(row => this.executorView(row)),
      identityReservations: { account: null, device: null, membership: null, remoteExecution: false }, runtimeEnforced: false });
  }
  private proposedPolicy(state: State, agentId: string, input: unknown): Policy {
    const agent = this.agent(agentId); fields(input, ["duty", "boundary", "rights"]);
    const duty = parseAgentBoundaryDocument(input.duty), boundary = parseAgentBoundaryDocument(input.boundary);
    if (duty.kind !== "duty-profile" || boundary.kind !== "execution-boundary" || duty.agentId !== agentId || boundary.agentId !== agentId) return fail("INVALID_DOCUMENT");
    assertAgentBoundaryContext(duty, this.parent.context); assertAgentBoundaryContext(boundary, this.parent.context);
    const access = rights(input.rights), old = state.policies.find(row => row.agentId === agentId);
    nextRevision(old?.duty, duty); nextRevision(old?.boundary, boundary);
    if (old && old.revision >= Number.MAX_SAFE_INTEGER) fail("COUNTER_EXHAUSTED");
    const resources = this.resourceVersions(agentId, boundary); this.checkTools(agentId, boundary);
    return { agentId, revision: (old?.revision ?? 0) + 1, agentEpoch: agent.agentEpoch,
      configRevision: agent.configRevision, rights: access, duty, boundary, resources };
  }
  configure(transport: AgentBoundaryTransport, agentId: string, input: unknown) {
    this.source(transport); fields(input, ["expectedRevision", "duty", "boundary", "rights"]);
    const state = this.read(); if (state.schemaVersion !== 1) return fail("AUTHORITY_UNVERIFIED", "control.commandRequired");
    const value = this.proposedPolicy(state, agentId, { duty: input.duty, boundary: input.boundary, rights: input.rights });
    this.update(input.expectedRevision, current => {
      this.source(transport); this.agent(agentId);
      if (current.schemaVersion !== 1) return fail("AUTHORITY_UNVERIFIED", "control.commandRequired");
      return { ...current, policies: [...current.policies.filter(row => row.agentId !== agentId), value] };
    });
    return this.view(transport, agentId);
  }
  linkExternal(transport: AgentBoundaryTransport, input: unknown) {
    this.source(transport); fields(input, ["expectedRevision", "externalAgentId", "instanceId", "agentId", "resourceId"]);
    if (!id(input.externalAgentId) || !id(input.instanceId) || !(input.agentId === null || id(input.agentId))
      || !(input.resourceId === null || id(input.resourceId)) || input.agentId === null && input.resourceId !== null) fail("INVALID_DOCUMENT");
    const registered = this.options.externalDirectory?.registeredAgent(input.externalAgentId as string);
    if (!registered || registered.agentId !== input.externalAgentId || registered.instanceId !== input.instanceId) fail("AUTHORITY_UNVERIFIED", "authority.executor");
    if (input.agentId !== null) {
      this.agent(input.agentId as string);
      if (input.resourceId !== null && !(this.options.resourcesForAgent?.(input.agentId as string) ?? []).some(row => row.resourceId === input.resourceId && row.assertCurrent() === undefined)) fail("AUTHORIZATION_DENIED");
    }
    const executor: Executor = { executorRef: `executor_${randomUUID()}`, externalAgentId: input.externalAgentId as string,
      instanceId: input.instanceId as string, agentId: input.agentId as string | null, resourceId: input.resourceId as string | null, controlled: false };
    this.update(input.expectedRevision, state => { this.source(transport); return { ...state, executors: [...state.executors, executor] }; });
    return deepFreeze(executor);
  }
  private permission(policy: Policy, action: AgentBoundaryAction): void {
    const allowed = action === "task.dispatch" ? policy.rights.invoke && policy.rights.nodeUse : policy.rights.manage;
    if (!allowed) fail("AUTHORIZATION_DENIED", "authority.rights");
  }
  draft(transport: AgentBoundaryTransport, agentId: string, input: unknown): AgentBoundaryCommand {
    const provenance = this.source(transport); fields(input, ["commandId", "rootRequestId", "operation", "lifetimeMs"]);
    if (!id(input.commandId) || !id(input.rootRequestId) || !positive(input.lifetimeMs) || Number(input.lifetimeMs) > this.lifetime) fail("INVALID_DOCUMENT");
    const state = this.read(), policy = this.currentPolicy(agentId, state.policies.find(row => row.agentId === agentId));
    const issued = this.now(); if (!Number.isSafeInteger(issued)) fail("AUTHORITY_UNVERIFIED");
    const parsed = parseAgentBoundaryDocument({ schemaVersion: 1, mode: "personal", kind: "command", context: this.parent.context,
      commandId: input.commandId, rootRequestId: input.rootRequestId, agentId,
      actorChain: { requestedBy: this.parent.context.humanSubjectId, actingAgent: agentId, approvedBy: null, executingNode: this.parent.context.nodeId },
      provenance, expected: { dutyRevision: policy.duty.dutyRevision, boundaryRevision: policy.boundary.boundaryRevision, controlEpoch: 0 },
      issuedAt: new Date(issued).toISOString(), notAfter: new Date(issued + Number(input.lifetimeMs)).toISOString(), operation: input.operation, intentDigest: "0".repeat(64) });
    if (parsed.kind !== "command") return fail("INVALID_DOCUMENT"); this.permission(policy, parsed.operation.action);
    if (this.options.commandControl && state.schemaVersion === 1 || state.schemaVersion !== 1 && !this.options.commandControl
      || state.schemaVersion >= 3 && !this.options.lifecycleControl) return fail("AUTHORITY_UNVERIFIED", "control.source");
    const current = state.control ? parseAgentBoundaryDocument({ ...parsed, expected: { ...parsed.expected,
      controlEpoch: agentCommandTargetEpoch(state.control, parsed) } }) : parsed;
    if (current.kind !== "command") return fail("INVALID_DOCUMENT");
    const intentDigest = createHash("sha256").update(agentBoundaryCommandSigningText(current)).digest("hex");
    const command = parseAgentBoundaryDocument({ ...current, intentDigest });
    if (command.kind !== "command") return fail("INVALID_DOCUMENT"); this.source(transport); return command;
  }
  /** Authenticated original intent only. Returning a parsed document does not issue permission. */
  authenticateCommandIntent(transport: AgentBoundaryTransport, raw: unknown): AgentBoundaryCommand {
    const provenance = this.source(transport), command = parseAgentBoundaryDocument(raw);
    if (command.kind !== "command") return fail("INVALID_DOCUMENT");
    if (canonical(command.provenance) !== canonical(provenance)) return fail("AUTHORITY_UNVERIFIED", "authority.provenance");
    assertAgentBoundaryContext(command, this.parent.context);
    const now = this.now(), issued = Date.parse(command.issuedAt), expires = Date.parse(command.notAfter);
    if (!Number.isSafeInteger(now) || issued > now + 30_000 || expires <= now || expires - issued > this.lifetime) fail("AUTHORITY_UNVERIFIED", "authority.deadline");
    if (createHash("sha256").update(agentBoundaryCommandSigningText(command)).digest("hex") !== command.intentDigest) fail("AUTHORITY_UNVERIFIED", "authority.digest");
    this.source(transport); return command;
  }
  private verify(transport: AgentBoundaryTransport, raw: unknown) {
    const command = this.authenticateCommandIntent(transport, raw), state = this.read();
    if (this.options.commandControl && state.schemaVersion === 1 || state.schemaVersion !== 1 && !this.options.commandControl
      || state.schemaVersion >= 3 && !this.options.lifecycleControl) return fail("AUTHORITY_UNVERIFIED", "control.source");
    const policy = this.currentPolicy(command.agentId, state.policies.find(row => row.agentId === command.agentId));
    if (command.expected.dutyRevision !== policy.duty.dutyRevision || command.expected.boundaryRevision !== policy.boundary.boundaryRevision) fail("STALE_REVISION");
    this.permission(policy, command.operation.action); this.assertLifecycleCapabilityCurrent(state, command);
    this.source(transport); return { command, policy };
  }
  /** Explicit owner setup; no absent/corrupt store is adopted as an execution history. */
  initializeCommandControl(transport: AgentBoundaryTransport) {
    this.source(transport); if (!this.options.commandControl) return fail("AUTHORITY_UNVERIFIED", "control.source");
    return withWorkspaceSessionAdmission(this.options.storage, () => {
      const state = this.read(); if (state.schemaVersion !== 1) return this.commandControlState();
      if (this.controlStorageFailed || this.controlledStateSeen) return fail("AUTHORITY_UNVERIFIED", "control.migrationRecovery");
      try { assertNoWorkspaceSessionLeases(this.options.storage); assertNoWorkspaceLegacyEffects(this.options.storage); } catch { return fail("CONTROL_HELD", "control.migrationDrain"); }
      if (!state.policies.length) return fail("BOUNDARY_CONFIRMATION_REQUIRED");
      const policies = state.policies.map(policy => {
        if (policy.revision >= Number.MAX_SAFE_INTEGER) return fail("COUNTER_EXHAUSTED"); return { ...policy, revision: policy.revision + 1 };
    });
    const control = emptyAgentCommandState(policies.map(policy => policy.agentId), { sourceRevision: state.revision,
      sourceDigest: commandDigest(state), initializedAt: new Date(this.now()).toISOString(), humanSubjectId: this.parent.context.humanSubjectId, nodeId: this.parent.context.nodeId });
    this.update(state.revision, current => { this.source(transport); return { ...current, schemaVersion: 2, policies, control }; });
    return this.commandControlState();
    });
  }
  /** Presence is checked even with bootstrap disabled: a protected scope cannot fall back to legacy. */
  commandControlSourceHealthy(): boolean { return !this.closed && !this.controlStorageFailed; }
  commandControlInitialized(): boolean { return this.read().schemaVersion !== 1; }
  commandLifecycleConfigured(): boolean { return this.options.lifecycleControl === true; }
  commandLifecycleInitialized(): boolean { return this.read().schemaVersion >= 3; }
  /** Explicit private migration, serialized with physical admissions. No old acceptance is reissued. */
  initializeAgentLifecycle(transport: AgentBoundaryTransport) {
    this.source(transport);
    if (!this.options.commandControl || !this.options.lifecycleControl) return fail("AUTHORITY_UNVERIFIED", "lifecycle.bootstrap");
    return withWorkspaceSessionAdmission(this.options.storage, () => {
      const state = this.read(); if (state.schemaVersion >= 3) return this.commandControlState();
      if (state.schemaVersion !== 2 || !state.control || this.controlStorageFailed || this.lifecycleStateSeen) return fail("AUTHORITY_UNVERIFIED", "lifecycle.migrationRecovery");
      try { assertNoWorkspaceSessionLeases(this.options.storage); assertNoWorkspaceLegacyEffects(this.options.storage); }
      catch { return fail("CONTROL_HELD", "lifecycle.migrationDrain"); }
      const lifecycle = migrateAgentLifecycleState(state.control, commandDigest(state), new Date(this.now()).toISOString());
      const policies = state.policies.map(policy => { if (policy.revision >= Number.MAX_SAFE_INTEGER) return fail("COUNTER_EXHAUSTED"); return { ...policy, revision: policy.revision + 1 }; });
      this.update(state.revision, current => {
        this.source(transport);
        if (current.schemaVersion !== 2) return fail("STALE_REVISION");
        return { ...current, schemaVersion: 3, policies, lifecycle };
      });
      return this.commandControlState();
    });
  }
  /** Explicit schema3->4 attachment. No acceptance, effect, claim or positive proof is synthesized. */
  initializeAgentRouting(transport: AgentBoundaryTransport, agentId: string) {
    this.source(transport); this.assertLifecycleManager(transport, agentId);
    if (!this.options.routingControl) return fail("AUTHORITY_UNVERIFIED", "routing.bootstrap");
    return withWorkspaceSessionAdmission(this.options.storage, () => {
      const state = this.read(); if (state.schemaVersion === 4) return this.commandControlState();
      if (state.schemaVersion !== 3 || !state.control || !state.lifecycle || this.controlStorageFailed || this.routingStateSeen) return fail("AUTHORITY_UNVERIFIED", "routing.migrationRecovery");
      try { assertNoWorkspaceSessionLeases(this.options.storage); assertNoWorkspaceLegacyEffects(this.options.storage); }
      catch { return fail("CONTROL_HELD", "routing.migrationDrain"); }
      const routing = emptyAgentRoutingState(commandDigest(state), new Date(this.now()).toISOString());
      this.update(state.revision, current => {
        this.source(transport); if (current.schemaVersion !== 3) return fail("STALE_REVISION");
        return { ...current, schemaVersion: 4, routing };
      });
      return this.commandControlState();
    });
  }
  commandRoutingInitialized(): boolean { return this.read().schemaVersion === 4; }
  assertRoutingTransport(transport: AgentBoundaryTransport) {
    if (!this.options.routingControl) return fail("AUTHORITY_UNVERIFIED", "routing.bootstrap");
    const provenance = this.source(transport);
    if (!["local_human", "signed_device"].includes(provenance.channel)) return fail("AUTHORITY_UNVERIFIED", "routing.source");
    return provenance;
  }
  routingSnapshot(transport: AgentBoundaryTransport) {
    this.assertRoutingTransport(transport); const state = this.commandControlState();
    if (!state.routing) return fail("AUTHORITY_UNVERIFIED", "routing.bootstrap"); return state as typeof state & { routing: AgentRoutingState };
  }
  /** Trusted library mutation only; no RPC ever receives a callback or persisted allow flag. */
  mutateRouting(transport: AgentBoundaryTransport, expectedRevision: number, change: (routing: AgentRoutingState) => AgentRoutingState) {
    this.assertRoutingTransport(transport);
    this.update(expectedRevision, state => {
      this.assertRoutingTransport(transport); if (!state.routing || state.schemaVersion !== 4) return fail("AUTHORITY_UNVERIFIED", "routing.bootstrap");
      const routing = change(structuredClone(state.routing)); assertAgentRoutingCapacity(routing);
      return { ...state, routing };
    }, undefined, true);
    return this.routingSnapshot(transport);
  }
  /** Only the successful null->submission_started CAS mints a RoutingPermit. Cold JSON cannot. */
  beginRoutingClassification(transport: AgentBoundaryTransport, expectedRevision: number, workKey: string, expectedWorkRevision: number,
    entry: AgentRoutingClassification, payload: AgentRoutingClassificationPayload, assertCurrent: () => void): RoutingPermit {
    this.assertRoutingTransport(transport); assertAgentRoutingJson(entry); assertAgentRoutingJson(payload);
    this.mutateRouting(transport, expectedRevision, routing => {
      const row = routing.records.find(row => row.workKey === workKey);
      if (!row || row.revision !== expectedWorkRevision || row.state !== "needs_owner" || row.classification || row.reason !== "no_match") return fail("CONTROL_HELD", "routing.classification");
      if (entry.phase !== "submission_started" || entry.candidateId !== null || entry.responseDigest !== null || entry.providerRequestRef !== null
        || entry.inputDigest !== commandDigest(payload) || entry.catalogDigest !== row.catalogDigest || !payload.candidates.length
        || payload.candidates.some(candidate => !row.candidates.some(row => row.agentId === candidate.agentId))) return fail("AUTHORITY_UNVERIFIED", "routing.classification");
      if (assertCurrent() !== undefined) return fail("AUTHORITY_UNVERIFIED", "routing.checks"); row.classification = structuredClone(entry); row.revision = nextCommandEpoch(row.revision); routing.sequence = nextCommandEpoch(routing.sequence); return routing;
    });
    const permit = Object.freeze({}) as RoutingPermit;
    this.routingPermits.set(permit, { transport, workKey, entry: structuredClone(entry), payload: structuredClone(payload), assertCurrent, used: false, submitted: false }); return permit;
  }
  private routingPermitState(handle: unknown): RoutingPermitState {
    const captured = handle && typeof handle === "object" ? this.routingPermits.get(handle) : undefined;
    if (!captured) return fail("AUTHORITY_UNVERIFIED", "routing.permit"); return captured;
  }
  consumeRoutingPermit(handle: unknown) {
    const captured = this.routingPermitState(handle); if (captured.used) return fail("AUTHORITY_UNVERIFIED", "routing.permit"); captured.used = true;
    return deepFreeze({ entry: structuredClone(captured.entry), payload: structuredClone(captured.payload) });
  }
  /** Called immediately at the ONE provider boundary, after cancellation checks. */
  submitRoutingPermit(handle: unknown): void {
    const captured = this.routingPermitState(handle); if (!captured.used || captured.submitted) return fail("AUTHORITY_UNVERIFIED", "routing.permit"); captured.submitted = true;
    this.assertRoutingTransport(captured.transport); if (captured.assertCurrent() !== undefined) return fail("AUTHORITY_UNVERIFIED", "routing.checks");
    const row = this.routingSnapshot(captured.transport).routing.records.find(row => row.workKey === captured.workKey);
    if (!row || row.state !== "needs_owner" || row.classification?.requestId !== captured.entry.requestId || row.classification.phase !== "submission_started") return fail("CONTROL_HELD", "routing.classification");
  }
  /** An original one-shot observation may be retained after a UI disconnect. It never changes an existing owner. */
  observeRoutingClassification(handle: unknown, outcome: AgentRoutingClassificationOutcome): void {
    const captured = this.routingPermitState(handle); if (!captured.used) return fail("AUTHORITY_UNVERIFIED", "routing.permit");
    this.assertHostCurrent(); assertAgentRoutingJson(outcome); const before = this.commandControlState();
    const original = before.routing?.records.find(row => row.workKey === captured.workKey);
    if (original?.classification?.requestId === captured.entry.requestId && original.classification.phase !== "submission_started") return;
    this.update(before.revision, state => {
      this.assertHostCurrent(); if (!state.routing) return fail("AUTHORITY_UNVERIFIED", "routing.bootstrap");
      const routing = structuredClone(state.routing), row = routing.records.find(row => row.workKey === captured.workKey);
      if (!row || row.classification?.requestId !== captured.entry.requestId) return fail("AUTHORITY_UNVERIFIED", "routing.classification");
      if (row.classification.phase !== "submission_started") return state; // UNKNOWN/final original observations are immutable.
      fields(outcome, ["phase", "candidateId", "responseDigest", "providerRequestRef"]);
      if (!["completed", "unknown", "failed"].includes(outcome.phase) || !(outcome.candidateId === null || captured.payload.candidates.some(c => c.agentId === outcome.candidateId))
        || outcome.phase !== "completed" && outcome.candidateId !== null || !(outcome.responseDigest === null || typeof outcome.responseDigest === "string" && /^[a-f0-9]{64}$/.test(outcome.responseDigest))
        || !(outcome.providerRequestRef === null || id(outcome.providerRequestRef))) return fail("AUTHORITY_UNVERIFIED", "routing.classification");
      let current = false;
      try { this.assertRoutingTransport(captured.transport); current = captured.assertCurrent() === undefined; } catch { /* Retain observation; do not claim stale context. */ }
      row.classification = { ...row.classification, ...outcome };
      if (row.state === "needs_owner") {
        row.reason = !current ? "stale" : outcome.phase === "completed" ? "no_match" : "classification_unavailable";
        if (current && outcome.phase === "completed" && outcome.candidateId !== null) {
          row.ownerAgentId = outcome.candidateId; row.state = "selected"; row.method = "classification"; row.reason = "selected";
        }
      }
      row.revision = nextCommandEpoch(row.revision); routing.sequence = nextCommandEpoch(routing.sequence); assertAgentRoutingCapacity(routing); return { ...state, routing };
    }, undefined, true);
  }
  /** An unclaimed nomination is NOT this opaque bridge into the original C3 admission. */
  prepareRoutingClaim(transport: AgentBoundaryTransport, workKey: string, revision: number, message: string, checks: { assertSelection(): void; assertAudience(): void }): AgentRoutingClaim {
    const snapshot = this.routingSnapshot(transport), row = snapshot.routing.records.find(row => row.workKey === workKey);
    if (!row || row.state !== "selected" || row.claim || row.revision !== revision || row.ownerAgentId === null || row.inputDigest !== agentCommandMessageDigest(row.channelId, message)) return fail("CONTROL_HELD", "routing.owner");
    if (checks.assertSelection() !== undefined || checks.assertAudience() !== undefined) return fail("AUTHORITY_UNVERIFIED", "routing.checks");
    const handle = Object.freeze({}) as AgentRoutingClaim;
    const conversationId = channelSessionId(row.channelId, row.ownerAgentId);
    this.routingClaims.set(handle, { workKey, revision, channelId: row.channelId, conversationId, messageDigest: agentCommandMessageDigest(conversationId, message), assertSelection: checks.assertSelection, assertAudience: checks.assertAudience }); return handle;
  }
  routingClaimChannel(handle: AgentRoutingClaim): string {
    const captured = this.routingClaims.get(handle); if (!captured) return fail("AUTHORITY_UNVERIFIED", "routing.claim"); return captured.channelId;
  }
  private routingClaimRecord(handle: unknown, state: State, command: AgentBoundaryCommand): AgentRoutingRecord {
    const captured = handle && typeof handle === "object" ? this.routingClaims.get(handle) : undefined;
    if (!captured || !state.routing || command.operation.action !== "task.dispatch") return fail("AUTHORITY_UNVERIFIED", "routing.claim");
    const row = state.routing.records.find(row => row.workKey === captured.workKey), op = command.operation;
    if (!row || row.state !== "selected" || row.claim || row.revision !== captured.revision || row.ownerAgentId !== command.agentId
      || row.commandId !== command.commandId || row.taskId !== op.taskId || row.rootRequestId !== command.rootRequestId
      || row.channelId !== captured.channelId || captured.conversationId !== op.conversationId || captured.messageDigest !== op.messageDigest) return fail("CONTROL_HELD", "routing.claim");
    if (captured.assertSelection() !== undefined || captured.assertAudience() !== undefined) return fail("AUTHORITY_UNVERIFIED", "routing.checks"); return row;
  }
  assertRoutingClaim(transport: AgentBoundaryTransport, handle: unknown, command: AgentBoundaryCommand): void {
    this.source(transport); const state = this.read();
    if (state.routing && command.operation.action === "task.dispatch") this.routingClaimRecord(handle, state, command);
    else if (handle !== undefined) return fail("AUTHORITY_UNVERIFIED", "routing.claim");
  }
  private assertRoutingExecutionCurrent(state: State, command: AgentBoundaryCommand): void {
    if (!state.routing || command.operation.action !== "task.dispatch") return;
    const captured = this.routingRuns.get(command.commandId), row = captured && state.routing.records.find(row => row.workKey === captured.workKey);
    if (!captured || !row || row.state !== "claimed" || row.ownerAgentId !== command.agentId || row.claim?.commandId !== command.commandId) return fail("AUTHORITY_UNVERIFIED", "routing.execution");
    if (captured.assertAudience() !== undefined) return fail("AUTHORITY_UNVERIFIED", "routing.checks"); // Current scope, independent of UI lifetime.
  }

  /** Public C0 duties only. The trusted caller must validate the audience BEFORE invoking this. */
  routingDirectory(transport: AgentBoundaryTransport, memberIds: readonly string[], automaticAgentIds: readonly string[]): readonly AgentRoutingDirectoryEntry[] {
    this.source(transport); const state = this.read();
    if (!this.options.routingControl || state.schemaVersion !== 4 || !state.control) return fail("AUTHORITY_UNVERIFIED", "routing.bootstrap");
    if (memberIds.length > 128 || new Set(memberIds).size !== memberIds.length || !memberIds.every(id)) return fail("INVALID_DOCUMENT", "routing.audience");
    const result: AgentRoutingDirectoryEntry[] = [];
    for (const agentId of memberIds) {
      const policy = state.policies.find(row => row.agentId === agentId);
      if (!policy || !policy.rights.manage && !policy.rights.invoke) continue;
      // Public nomination reads metadata and confirmed duties only, never resource roots, homes or private context.
      const agent = this.options.resources.agents.get(agentId);
      if (!agent || agent.state !== "active" || agent.agentEpoch !== policy.agentEpoch || agent.configRevision !== policy.configRevision) continue;
      try { assertAgentBoundaryContext(policy.duty, this.parent.context); } catch (error) { if (error instanceof AgentBoundaryContractError) continue; throw error; }
      const control = state.control.agents.find(row => row.agentId === agentId), available = policy.rights.invoke && policy.rights.nodeUse && !control?.hold && !control?.dismissed;
      result.push({ agentId, dutyRevision: policy.duty.dutyRevision, policyRevision: policy.revision,
        agentEpoch: policy.agentEpoch, configRevision: policy.configRevision, publicProfile: policy.duty.publicProfile,
        available: Boolean(available), automatic: Boolean(available && automaticAgentIds.includes(agentId)) });
    }
    this.source(transport); return deepFreeze(result);
  }

  /** Trusted library read used by the C3 source after the original UI disconnects. */
  commandControlState() {
    const state = this.read();
    if (!this.options.commandControl || state.schemaVersion === 1 || !state.control
      || state.schemaVersion >= 3 && !this.options.lifecycleControl) return fail("AUTHORITY_UNVERIFIED", "control.source");
    return deepFreeze({ revision: state.revision, context: this.parent.context, control: state.control, ...(state.lifecycle ? { lifecycle: state.lifecycle } : {}), ...(state.routing ? { routing: state.routing } : {}) });
  }
  commandControlForReader(transport: AgentBoundaryTransport, agentId: string) {
    this.source(transport); const state = this.read(), policy = state.policies.find(policy => policy.agentId === agentId);
    if (!policy || !policy.rights.manage && !policy.rights.invoke) return fail("AUTHORIZATION_DENIED", "control.read");
    return this.commandControlState();
  }
  /** Trusted Host composition only, never an RPC-returned object. */
  lifecycleStorage(): WorkspaceResourceStorage { this.assertHostCurrent(); return this.options.storage; }
  private history() { return new WorkspaceAgentLifecycleHistory(this.options.storage, this.parent.context); }
  assertLifecycleHistory() { const snapshot = this.commandControlState(); if (snapshot.lifecycle) this.history().verify(snapshot.lifecycle); }
  lifecycleHistoricalRun(lifecycle: AgentLifecycleState, runId: string) { return this.history().historicalRun(lifecycle, runId); }
  lifecycleHistoricalCommand(lifecycle: AgentLifecycleState, commandId: string) { return this.history().historicalCommand(lifecycle, commandId); }
  lifecycleHistoricalRuns(lifecycle: AgentLifecycleState, agentId: string) {
    return this.history().verify(lifecycle).flatMap(body => body.control.runs.filter(row => row.agentId === agentId)
      .map(run => ({ run, execution: body.lifecycle.executions.find(row => row.runId === run.runId)! })));
  }
  lifecycleHistoricalAudit(lifecycle: AgentLifecycleState, agentId: string) {
    return this.history().verify(lifecycle).flatMap(body => body.control.audit.filter(row => row.agentId === agentId));
  }
  private assertLifecycleHistoryManager(transport: AgentBoundaryTransport, agentId: string) {
    this.source(transport); if (!this.commandControlSourceHealthy()) return fail("AUTHORITY_UNVERIFIED", "lifecycle.source");
    const state = this.read(), policy = state.policies.find(row => row.agentId === agentId), agent = this.options.resources.agents.get(agentId);
    if (!policy?.rights.manage || !agent || agent.workspaceId !== this.options.storage.scope.workspaceId) return fail("AUTHORIZATION_DENIED", "lifecycle.history");
    if (agent.state === "active") this.currentPolicy(agentId, policy);
    else {
      const operations = [...(state.lifecycle?.operations ?? []), ...(state.lifecycle ? this.history().verify(state.lifecycle).flatMap(body => body.lifecycle.operations) : [])];
      if (!operations.some(row => row.agentId === agentId && row.archive === "archived"
        && row.archivedResource?.agentEpoch === agent.agentEpoch && row.archivedResource.configRevision === agent.configRevision)) return fail("CONTROL_HELD", "lifecycle.archiveIdentity");
    }
  }
  /** Explicit bounded maintenance. Immutable file first, then exact manifest/prune in the
   * original authority CAS. A failed publication never discards the active identities. */
  archiveClosedLifecycle(transport: AgentBoundaryTransport, agentId: string, maximum = 8) {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 8) return fail("INVALID_DOCUMENT", "lifecycle.archiveLimit");
    this.assertLifecycleHistoryManager(transport, agentId); let published = 0;
    for (; published < maximum; published++) {
      const before = this.commandControlState(); if (!before.lifecycle) return fail("AUTHORITY_UNVERIFIED", "lifecycle.bootstrap");
      const candidate = this.history().prepare(before.control, before.lifecycle, agentId); if (!candidate) break;
      this.history().publish(candidate);
      this.update(before.revision, state => {
        this.assertLifecycleHistoryManager(transport, agentId);
        return { ...state, control: candidate.control, lifecycle: candidate.lifecycle };
      });
    }
    const after = this.commandControlState(); return { published, revision: after.revision, segments: after.lifecycle!.segments.length,
      archivedRuns: after.lifecycle!.retiredRuns.filter(row => row.agentId === agentId).length };
  }
  lifecycleRights(transport: AgentBoundaryTransport, agentId: string): Readonly<AgentBoundaryRights> {
    this.source(transport); const state = this.read(), policy = this.currentPolicy(agentId, state.policies.find(row => row.agentId === agentId));
    return deepFreeze({ ...policy.rights });
  }
  /** Current human management rights; independent of invoke/privateRead/nodeUse. */
  assertLifecycleManager(transport: AgentBoundaryTransport, agentId: string): void {
    this.source(transport); const state = this.read(), policy = this.currentPolicy(agentId, state.policies.find(row => row.agentId === agentId));
    this.permission(policy, "agent.pause");
  }
  /** Positive persisted closure only; the lease reconciler calls this again under its own lock. */
  lifecycleLeaseReleaseFacts(transport: AgentBoundaryTransport, runId: string) {
    if (!this.commandControlSourceHealthy()) return fail("AUTHORITY_UNVERIFIED", "lifecycle.source");
    const snapshot = this.commandControlState(), run = snapshot.control.runs.find(row => row.runId === runId);
    if (!snapshot.lifecycle || !run) return fail("AUTHORITY_UNVERIFIED", "lifecycle.release");
    this.assertLifecycleManager(transport, run.agentId);
    const execution = snapshot.lifecycle.executions.find(row => row.runId === runId);
    const proof = execution?.terminal ?? execution?.quiescence;
    if (!execution?.lease || !proof || canonical(proof.lease) !== canonical(execution.lease)
      || execution.bindingDigest !== run.bindingDigest || execution.claimRevision !== run.claimRevision) return fail("CONTROL_HELD", "lifecycle.release");
    return deepFreeze({ context: this.parent.context, runId, bindingDigest: run.bindingDigest, proofRef: proof.proofRef, lease: execution.lease });
  }
  /** Host preparation liveness only; this method does not issue an execution permit. */
  assertCommandRunBinding(binding: Readonly<WorkspaceRunBinding>): void {
    this.assertHostCurrent(); const context = this.parent.context;
    if (canonical(binding.scope) !== canonical(context.scope) || canonical(binding.agent.resourceBinding) !== canonical(context.resourceBinding)
      || binding.host.actorId !== context.humanSubjectId || binding.host.hostId !== context.nodeId
      || binding.host.grantId !== context.localGrant.grantId || binding.host.grantRevision !== context.localGrant.grantRevision) fail("CONTEXT_MISMATCH");
    this.options.resources.agents.resolveTask(binding.agent);
  }
  /** C1 policy + C3 command/claim/control/audit publish under the original single authority CAS. */
  transactCommand(transport: AgentBoundaryTransport, raw: unknown,
    change: (input: AgentCommandMutation) => AgentCommandMutationResult, proposal?: unknown, routingClaim?: AgentRoutingClaim) {
    const command = this.authenticateCommandIntent(transport, raw), before = this.commandControlState();
    this.update(before.revision, state => {
      this.source(transport); this.authenticateCommandIntent(transport, command);
      if (state.schemaVersion === 1 || !state.control || state.schemaVersion >= 3 && !this.options.lifecycleControl) return fail("AUTHORITY_UNVERIFIED", "control.source");
      if (state.lifecycle && !["task.stop", "agent.pause", "agent.dismiss"].includes(command.operation.action)
        && !state.control.commands.some(row => row.command.commandId === command.commandId)) this.history().verify(state.lifecycle);
      let authorizationError: AgentBoundaryErrorCode | null = null, proposed: Policy | undefined;
      const policy = state.policies.find(row => row.agentId === command.agentId);
      try {
        if (state.routing && command.operation.action === "task.dispatch" && !state.control.commands.some(row => row.command.commandId === command.commandId)) this.routingClaimRecord(routingClaim, state, command);
        const current = this.currentPolicy(command.agentId, policy);
        if (command.expected.dutyRevision !== current.duty.dutyRevision || command.expected.boundaryRevision !== current.boundary.boundaryRevision) fail("STALE_REVISION");
        this.permission(current, command.operation.action);
        const updating = command.operation.action === "duty.update" || command.operation.action === "boundary.update";
        if (updating) {
          proposed = this.proposedPolicy(state, command.agentId, proposal);
          const digest = command.operation.action === "duty.update" ? command.operation.proposedDutyDigest : command.operation.proposedBoundaryDigest;
          if (agentPolicyProposalDigest(proposal) !== digest) fail("AUTHORITY_UNVERIFIED", "control.proposal");
          if (command.operation.action === "duty.update" && (canonical(proposed.boundary) !== canonical(current.boundary) || canonical(proposed.rights) !== canonical(current.rights))
            || command.operation.action === "boundary.update" && canonical(proposed.duty) !== canonical(current.duty)) fail("AUTHORIZATION_DENIED", "control.proposal");
        } else if (proposal !== undefined) fail("INVALID_DOCUMENT", "control.proposal");
      } catch (error) { authorizationError = error instanceof AgentBoundaryContractError ? error.code : "AUTHORITY_UNVERIFIED"; }
      const result = change({ command, control: structuredClone(state.control), authorizationError,
        policyRevision: policy?.revision ?? 0, proposedPolicyRevision: proposed?.revision ?? null,
        agentKind: this.options.resources.agents.get(command.agentId)?.kind ?? null,
        agentResource: (() => { const agent = this.options.resources.agents.get(command.agentId);
          return agent ? { agentEpoch: agent.agentEpoch, configRevision: agent.configRevision } : null; })(), rights: policy ? { ...policy.rights } : null,
        ...(state.lifecycle ? { lifecycle: structuredClone(state.lifecycle) } : {}), ...(state.routing ? { routing: structuredClone(state.routing) } : {}) });
      if (result.applyPolicy && (authorizationError || !proposed)) return fail("AUTHORITY_UNVERIFIED", "control.proposal");
      this.source(transport);
      const routing = state.routing ? structuredClone(state.routing) : undefined;
      const newRun = command.operation.action === "task.dispatch" && !state.control.commands.some(row => row.command.commandId === command.commandId)
        ? result.control.runs.find(row => row.commandId === command.commandId) : undefined;
      if (newRun && routing) {
        if (authorizationError) return fail("AUTHORITY_UNVERIFIED", "routing.claim");
        const row = this.routingClaimRecord(routingClaim, state, command), next = routing.records.find(record => record.workKey === row.workKey)!;
        next.state = "claimed"; next.reason = "current_owner"; next.revision = nextCommandEpoch(next.revision); routing.sequence = nextCommandEpoch(routing.sequence);
        next.claim = { commandId: newRun.commandId, taskId: newRun.taskId, runId: newRun.runId, claimRevision: newRun.claimRevision };
        assertAgentRoutingCapacity(routing);
      }
      return { ...state, control: result.control, ...(result.lifecycle ? { lifecycle: result.lifecycle } : {}), ...(routing ? { routing } : {}),
        ...(result.applyPolicy && proposed ? { policies: [...state.policies.filter(row => row.agentId !== command.agentId), proposed] } : {}) };
    }, command.operation.action);
    const snapshot = this.commandControlState();
    if (routingClaim && command.operation.action === "task.dispatch") {
      const captured = this.routingClaims.get(routingClaim), row = snapshot.routing?.records.find(row => row.workKey === captured?.workKey);
      if (captured && row?.state === "claimed" && row.claim?.commandId === command.commandId) this.routingRuns.set(command.commandId, { workKey: row.workKey, assertAudience: captured.assertAudience });
    }
    return snapshot;
  }
  /** Existing-runtime observations only; never exposed as a body callback or a generic RPC write. */
  observeCommandControl(expectedRevision: number, change: (control: AgentCommandState, lifecycle?: AgentLifecycleState) => AgentCommandState) {
    this.commandControlState();
    this.update(expectedRevision, state => {
      this.assertHostCurrent(); if (state.schemaVersion === 1 || !state.control || state.schemaVersion >= 3 && !this.options.lifecycleControl) return fail("AUTHORITY_UNVERIFIED", "control.source");
      const lifecycle = state.lifecycle ? structuredClone(state.lifecycle) : undefined;
      const next = change(structuredClone(state.control), lifecycle);
      if (canonical(next.agents) !== canonical(state.control.agents)) return fail("AUTHORIZATION_DENIED", "control.observation");
      for (const old of state.control.commands) {
        const row = next.commands.find(row => row.command.commandId === old.command.commandId);
        if (!row || canonical(row.command) !== canonical(old.command)) return fail("COMMAND_ID_CONFLICT", "control.observation");
      }
      return { ...state, control: next, ...(lifecycle ? { lifecycle } : {}) };
    });
    return this.commandControlState();
  }
  /** Durable C4 revocation applies to every Host, including old handles after resume. The
   * local WeakMaps are capabilities, not an inventory whose absence could prove revocation. */
  private assertLifecycleCapabilityCurrent(state: State, command: AgentBoundaryCommand): void {
    if (!state.lifecycle || command.operation.action !== "task.dispatch") return;
    if (state.lifecycle.retiredCommands.some(row => row.commandId === command.commandId)) return fail("GRANT_REVOKED", "lifecycle.retired");
    const run = state.control!.runs.find(row => row.commandId === command.commandId);
    if (!run) return; // C1 intent only; no accepted run or execution permission is produced here.
    const agent = state.control!.agents.find(row => row.agentId === run.agentId), execution = state.lifecycle.executions.find(row => row.runId === run.runId);
    if (!agent || !execution || agent.hold || agent.dismissed || agent.epoch !== run.agentControlEpoch || run.hold
      || ["draining", "drained", "unknown"].includes(run.state) || execution.terminal || execution.quiescence || execution.leaseReleased
      || execution.phase === "legacy_unknown") return fail("GRANT_REVOKED", "lifecycle.control");
  }
  /** Continue only a persisted authenticated restrictive operation. This maintenance port
   * cannot issue work, approve tools, alter a target or restore an Agent. */
  reconcileLifecycleOperation(commandId: string) {
    if (!this.commandControlSourceHealthy()) return fail("AUTHORITY_UNVERIFIED", "lifecycle.source");
    const first = this.commandControlState(), original = first.lifecycle?.operations.find(row => row.commandId === commandId);
    if (!original) return fail("AUTHORIZATION_DENIED", "lifecycle.operation");
    const record = first.control.commands.find(row => row.command.commandId === commandId);
    if (!record || record.receipt.status === "rejected" || record.command.operation.action !== original.action
      || record.command.agentId !== original.agentId) return fail("AUTHORITY_UNVERIFIED", "lifecycle.operation");
    if (original.targetRunIds.some(id => !original.revokedRunIds.includes(id))) {
      this.observeCommandControl(first.revision, (control, lifecycle) => {
        const operation = lifecycle!.operations.find(row => row.commandId === commandId)!;
        for (const id of operation.targetRunIds) {
          const run = control.runs.find(row => row.runId === id), agent = control.agents.find(row => row.agentId === operation.agentId), execution = lifecycle!.executions.find(row => row.runId === id);
          if (!run || run.agentId !== operation.agentId || !agent || !execution
            || !(run.hold || agent.hold || agent.dismissed || agent.epoch !== run.agentControlEpoch || execution.terminal || execution.quiescence || execution.leaseReleased))
            return fail("AUTHORITY_UNVERIFIED", "lifecycle.revocation");
          if (!operation.revokedRunIds.includes(id)) operation.revokedRunIds.push(id);
        }
        return control;
      });
    }
    let snapshot = this.commandControlState(), operation = snapshot.lifecycle!.operations.find(row => row.commandId === commandId)!;
    const features = new WorkspaceFeatures(this.options.storage, "", this.options.storage.scope.workspaceId);
    if (operation.schedules === "pending") {
      const paused = features.pauseAgentSchedulesForLifecycle(operation.agentId);
      this.observeCommandControl(snapshot.revision, (control, lifecycle) => {
        if (features.schedules().some(row => row.enabled && row.definition.agentId === operation.agentId)) return fail("CONTROL_HELD", "lifecycle.schedules");
        lifecycle!.operations.find(row => row.commandId === commandId)!.schedules = paused.length ? "paused" : "none"; return control;
      });
      // Publication is already durable. Failure retains the original recovery receipt; never re-enable.
      features.finishArchivePause(operation.agentId, paused);
    }
    snapshot = this.commandControlState(); operation = snapshot.lifecycle!.operations.find(row => row.commandId === commandId)!;
    const retained = features.archivePauseReceipts().find(row => row.agentId === operation.agentId);
    if (operation.schedules !== "pending" && retained) {
      features.assertLifecycleSchedulesPaused(operation.agentId, retained.schedules);
      features.finishArchivePause(operation.agentId, retained.schedules);
    }
    if (operation.archive === "pending") {
      if (operation.schedules === "pending" || operation.targetRunIds.some(id => !operation.revokedRunIds.includes(id)
        || !snapshot.lifecycle!.executions.find(row => row.runId === id)?.leaseReleased)) return operation;
      const held = snapshot.control.agents.find(row => row.agentId === operation.agentId), expected = operation.archiveExpected!, agent = this.options.resources.agents.get(operation.agentId);
      if (!held?.dismissed || held.hold?.holdId !== operation.holdId || !agent || agent.kind === "main") return fail("AUTHORITY_UNVERIFIED", "lifecycle.archive");
      if (agent.state === "active") {
        this.options.resources.agents.setArchived(operation.agentId, true, expected.configRevision, expected.agentEpoch, 0);
      }
      const archived = this.options.resources.agents.get(operation.agentId);
      if (!archived || archived.state !== "archived" || archived.agentEpoch !== expected.agentEpoch + 1 || archived.configRevision !== expected.configRevision)
        return fail("CONTROL_HELD", "lifecycle.archiveIdentity");
      // Re-read after the cross-file step. A crash here can publish this exact receipt later.
      snapshot = this.commandControlState();
      this.observeCommandControl(snapshot.revision, (control, lifecycle) => {
        const current = this.options.resources.agents.get(operation.agentId);
        if (canonical(current) !== canonical(archived)) return fail("STALE_REVISION", "lifecycle.archiveIdentity");
        const row = lifecycle!.operations.find(row => row.commandId === commandId)!; row.archive = "archived";
        row.archivedResource = { agentEpoch: archived.agentEpoch, configRevision: archived.configRevision }; return control;
      });
    }
    return this.commandControlState().lifecycle!.operations.find(row => row.commandId === commandId)!;
  }
  admit(transport: AgentBoundaryTransport, raw: unknown): AgentCommandGrant {
    const { command, policy } = this.verify(transport, raw), handle = Object.freeze({}) as AgentCommandGrant;
    this.grants.set(handle, { transport, command, policyRevision: policy.revision, live: true }); return handle;
  }
  grantFacts(handle: unknown) {
    const grant = handle && typeof handle === "object" ? this.grants.get(handle) : undefined;
    if (!grant?.live) return fail("AUTHORITY_UNVERIFIED", "authority.commandGrant");
    const { command, policy } = this.verify(grant.transport, grant.command);
    if (policy.revision !== grant.policyRevision) return fail("STALE_REVISION", "authority.commandGrant");
    return deepFreeze({ command, duty: policy.duty, boundary: policy.boundary, rights: policy.rights,
      policyRevision: policy.revision, executionPermit: false, controlVerified: false });
  }
  /** Command expiry/connection liveness governs admission, not the lifetime of accepted work.
   * C2 must ALSO hold the existing RunPermit and a live C3 accepted-command/control lease. This
   * policy handle merely pins current C1 authority; it cannot dispatch or release any effect. */
  captureExecutionPolicy(handle: AgentCommandGrant): AgentExecutionPolicy {
    const facts = this.grantFacts(handle);
    if (facts.command.operation.action !== "task.dispatch") return fail("AUTHORIZATION_DENIED");
    const policy = Object.freeze({}) as AgentExecutionPolicy;
    this.executionPolicies.set(policy, { command: facts.command, policyRevision: facts.policyRevision, live: true });
    return policy;
  }
  executionPolicyFacts(handle: unknown) {
    if (this.controlStorageFailed) return fail("AUTHORITY_UNVERIFIED", "control.storage");
    const captured = handle && typeof handle === "object" ? this.executionPolicies.get(handle) : undefined;
    if (!captured?.live) return fail("AUTHORITY_UNVERIFIED", "authority.executionPolicy");
    this.assertHostCurrent(); assertAgentBoundaryContext(captured.command, this.parent.context);
    const state = this.read(), policy = this.currentPolicy(captured.command.agentId, state.policies.find(row => row.agentId === captured.command.agentId));
    if (captured.policyRevision !== policy.revision) return fail("STALE_REVISION", "authority.executionPolicy");
    this.permission(policy, "task.dispatch"); this.assertLifecycleCapabilityCurrent(state, captured.command); this.assertRoutingExecutionCurrent(state, captured.command);
    return deepFreeze({ command: captured.command, duty: policy.duty, boundary: policy.boundary, rights: policy.rights,
      policyRevision: policy.revision, executionPermit: false, controlVerified: false });
  }
  retireExecutionPolicy(handle: unknown): void {
    const policy = handle && typeof handle === "object" ? this.executionPolicies.get(handle) : undefined;
    if (policy) policy.live = false;
  }
  /** C2 consumes the original registry attestations, never a second caller-provided path map. */
  executionResources(handle: unknown): readonly AgentBoundaryResource[] {
    const facts = handle && typeof handle === "object" && this.executionPolicies.has(handle)
      ? this.executionPolicyFacts(handle) : this.grantFacts(handle);
    if (facts.command.operation.action !== "task.dispatch") return fail("AUTHORIZATION_DENIED");
    const available = this.options.resourcesForAgent?.(facts.command.agentId) ?? [];
    return Object.freeze(facts.boundary.resources.map(ref => {
      const resource = available.find(item => item.resourceId === ref.resourceId);
      if (!resource || resource.assertCurrent() !== undefined) return fail("AUTHORITY_UNVERIFIED", "authority.resource");
      return Object.freeze({ ...resource, access: Object.freeze([...resource.access]),
        ...(resource.project ? { project: Object.freeze({ ...resource.project }) } : {}) });
    }));
  }
  retire(handle: unknown): void { const grant = handle && typeof handle === "object" ? this.grants.get(handle) : undefined; if (grant) grant.live = false; }
  check(transport: AgentBoundaryTransport, raw: unknown) {
    const grant = this.admit(transport, raw);
    try { const facts = this.grantFacts(grant); return deepFreeze({ commandId: facts.command.commandId,
      action: facts.command.operation.action, provenance: facts.command.provenance, context: facts.command.context,
      policyRevision: facts.policyRevision, state: "identity-and-policy-verified" as const, executable: false, effect: "none" as const }); }
    finally { this.retire(grant); }
  }
  close(): void { this.closed = true; this.routingRuns.clear(); }
}
