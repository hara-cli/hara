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
interface State { schemaVersion: 1; revision: number; resourceBinding: WorkspaceResourceBinding; policies: Policy[]; executors: Executor[] }
declare const grantBrand: unique symbol;
/** C1 intent authority only. It is neither a runtime ExecutionPermit nor a C3 receipt. */
export interface AgentCommandGrant { readonly [grantBrand]: true }
declare const executionPolicyBrand: unique symbol;
/** Current C1 policy only, after authenticated command admission. Still NOT a C2/C3 execution permit. */
export interface AgentExecutionPolicy { readonly [executionPolicyBrand]: true }
interface ExecutionPolicyState { command: AgentBoundaryCommand; policyRevision: number; live: boolean }
interface GrantState { transport: AgentBoundaryTransport; command: AgentBoundaryCommand; policyRevision: number; live: boolean }
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
  private readonly parent: { hostId: string; hostEpoch: number; row: string; context: AgentBoundaryContext };
  private closed = false;
  private readonly now: () => number;
  private readonly lifetime: number;
  constructor(private readonly options: {
    catalog: LocalWorkspaceCatalog; resources: WorkspaceResources; storage: WorkspaceResourceStorage;
    transports: AgentBoundaryTransports; assertHostLive?(): void;
    resourcesForAgent?(agentId: string): readonly AgentBoundaryResource[];
    toolsForAgent?(agentId: string): readonly AgentBoundaryTool[];
    externalDirectory?: AgentHubDirectory; now?: () => number; maxCommandLifetimeMs?: number;
  }) {
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
    this.state = new WorkspaceJsonState(options.storage, "workspace-agent-authority-v1.json", raw => this.parse(raw),
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
    fields(raw, ["schemaVersion", "revision", "resourceBinding", "policies", "executors"]);
    if (raw.schemaVersion !== 1 || !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 0
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
    return structuredClone(raw) as unknown as State;
  }
  private read(): State {
    this.assertHostCurrent();
    try { return this.state.read(); }
    catch (error) { if (error instanceof AgentBoundaryContractError) throw error; return fail("AUTHORITY_UNVERIFIED", "authority.policy"); }
  }
  private update(expectedRevision: unknown, change: (state: State) => State): void {
    if (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 0) return fail("INVALID_DOCUMENT", "authority.revision");
    try { this.state.update(expectedRevision as number, change); }
    catch (error) {
      if (error instanceof AgentBoundaryContractError) throw error;
      if (error instanceof Error && error.message === "Workspace state changed; refresh before writing") return fail("STALE_REVISION");
      if (error instanceof Error && error.message === "Workspace revision exhausted") return fail("COUNTER_EXHAUSTED");
      fail("AUTHORITY_UNVERIFIED", "authority.policy");
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
  configure(transport: AgentBoundaryTransport, agentId: string, input: unknown) {
    this.source(transport); const agent = this.agent(agentId); fields(input, ["expectedRevision", "duty", "boundary", "rights"]);
    const duty = parseAgentBoundaryDocument(input.duty), boundary = parseAgentBoundaryDocument(input.boundary);
    if (duty.kind !== "duty-profile" || boundary.kind !== "execution-boundary" || duty.agentId !== agentId || boundary.agentId !== agentId) return fail("INVALID_DOCUMENT");
    assertAgentBoundaryContext(duty, this.parent.context); assertAgentBoundaryContext(boundary, this.parent.context);
    const access = rights(input.rights), state = this.read(), old = state.policies.find(row => row.agentId === agentId);
    nextRevision(old?.duty, duty); nextRevision(old?.boundary, boundary);
    if (old && old.revision >= Number.MAX_SAFE_INTEGER) fail("COUNTER_EXHAUSTED");
    const resources = this.resourceVersions(agentId, boundary); this.checkTools(agentId, boundary);
    const value: Policy = { agentId, revision: (old?.revision ?? 0) + 1, agentEpoch: agent.agentEpoch,
      configRevision: agent.configRevision, rights: access, duty, boundary, resources };
    this.source(transport);
    this.update(input.expectedRevision, current => {
      this.source(transport); this.agent(agentId);
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
    const intentDigest = createHash("sha256").update(agentBoundaryCommandSigningText(parsed)).digest("hex");
    const command = parseAgentBoundaryDocument({ ...parsed, intentDigest });
    if (command.kind !== "command") return fail("INVALID_DOCUMENT"); this.source(transport); return command;
  }
  private verify(transport: AgentBoundaryTransport, raw: unknown) {
    const provenance = this.source(transport); const command = parseAgentBoundaryDocument(raw);
    if (command.kind !== "command") return fail("INVALID_DOCUMENT");
    if (canonical(command.provenance) !== canonical(provenance)) return fail("AUTHORITY_UNVERIFIED", "authority.provenance");
    assertAgentBoundaryContext(command, this.parent.context);
    const state = this.read(), policy = this.currentPolicy(command.agentId, state.policies.find(row => row.agentId === command.agentId));
    if (command.expected.dutyRevision !== policy.duty.dutyRevision || command.expected.boundaryRevision !== policy.boundary.boundaryRevision) fail("STALE_REVISION");
    const now = this.now(), issued = Date.parse(command.issuedAt), expires = Date.parse(command.notAfter);
    if (!Number.isSafeInteger(now) || issued > now + 30_000 || expires <= now || expires - issued > this.lifetime) fail("AUTHORITY_UNVERIFIED", "authority.deadline");
    if (createHash("sha256").update(agentBoundaryCommandSigningText(command)).digest("hex") !== command.intentDigest) fail("AUTHORITY_UNVERIFIED", "authority.digest");
    this.permission(policy, command.operation.action); this.source(transport); return { command, policy };
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
    const captured = handle && typeof handle === "object" ? this.executionPolicies.get(handle) : undefined;
    if (!captured?.live) return fail("AUTHORITY_UNVERIFIED", "authority.executionPolicy");
    this.assertHostCurrent(); assertAgentBoundaryContext(captured.command, this.parent.context);
    const state = this.read(), policy = this.currentPolicy(captured.command.agentId, state.policies.find(row => row.agentId === captured.command.agentId));
    if (captured.policyRevision !== policy.revision) return fail("STALE_REVISION", "authority.executionPolicy");
    this.permission(policy, "task.dispatch");
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
  close(): void { this.closed = true; }
}
