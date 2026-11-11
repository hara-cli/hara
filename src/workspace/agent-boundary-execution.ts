// C2 trusted composition only. DTOs and C1 grants cannot construct a runtime permit or C3 decision.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { isAbsolute, relative, sep } from "node:path";
import type { CompletionEvidenceLedger } from "../agent/completion-evidence.js";
import { toolOperationTraits, type Tool } from "../tools/registry.js";
import { isWorkspaceExtensionTool } from "./extension-binding.js";
import { AgentBoundaryContractError, type AgentBoundaryCommand, type AgentBoundaryErrorCode } from "./agent-boundaries-contract.js";
import type { AgentCommandGrant, AgentExecutionPolicy, AgentBoundaryResource, AgentBoundaryTool, WorkspaceAgentBoundaryAuthority } from "./agent-boundary-authority.js";
import { canonical, deepFreeze } from "./local-state.js";
import { captureWorkspaceProjectIdentity, freezeWorkspaceRunBinding, workspaceRunBindingsEqual, type WorkspaceRunBinding } from "./run-binding.js";

/** C3 implements this in trusted Host composition after durable command acceptance. No default issuer.
 * bind MUST reconcile commandId/digest and the exact run without replaying accepted/unknown work.
 * assertCurrent MUST synchronously read its live authority/hold/epoch; no cached allow or async check. */
export interface AgentBoundaryControlSource {
  bind(command: AgentBoundaryCommand, binding: Readonly<WorkspaceRunBinding>): {
    readonly commandId: string; readonly runId: string; readonly controlEpoch: number;
    assertCurrent(): void;
  };
}
export interface AgentBoundaryEffectResource { resourceId: string; access: "read" | "write" | "execute" }
/** This is reviewed Host code, not an input schema or renderer-defined classifier. Its exact tool
 * function/schema/classifier are pinned at admission. Unmediated MCP, shell and delegation are denied. */
export interface AgentBoundaryEffectTool {
  tool: Tool; reference: Pick<AgentBoundaryTool, "toolId" | "connectorId" | "catalogRevision">;
  resources(input: unknown): readonly AgentBoundaryEffectResource[];
}
declare const gateBrand: unique symbol;
export interface AgentBoundaryExecutionGate { readonly [gateBrand]: true }
interface GateState {
  binding: Readonly<WorkspaceRunBinding>; authority: WorkspaceAgentBoundaryAuthority; policy: AgentExecutionPolicy;
  control: ReturnType<AgentBoundaryControlSource["bind"]>; tools: readonly AgentBoundaryEffectTool[];
  roots: ReadonlyMap<string, Readonly<NonNullable<AgentBoundaryResource["project"]>>>;
  attached: boolean;
}
const gates = new WeakMap<object, GateState>();
const effects = new AsyncLocalStorage<{ assertCurrent(): void; assertFile(path: string, access: "read" | "write"): void }>();
const bookkeeping = new Set(["task_intake", "task_checkpoint", "todo_write", "ask_user"]);
const fail = (code: AgentBoundaryErrorCode, field = "execution.authority"): never => { throw new AgentBoundaryContractError(code, field); };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const sync = (check: () => void) => {
  const result: unknown = check();
  if (result !== undefined) {
    if (result && typeof (result as { then?: unknown }).then === "function") void Promise.resolve(result).catch(() => {});
    fail("AUTHORITY_UNVERIFIED");
  }
};
/** Re-entered by scoped IO immediately before namespace commits and before returning private bytes. */
export function assertAgentBoundaryEffectCurrent(): void { effects.getStore()?.assertCurrent(); }
/** The actual scoped IO target, not a path inferred by a tool classifier, must be in the grant. */
export function assertAgentBoundaryFileAccess(path: string, access: "read" | "write"): void { effects.getStore()?.assertFile(path, access); }
function stateOf(gate: unknown): GateState {
  const state = gate && typeof gate === "object" ? gates.get(gate) : undefined;
  if (!state) return fail("AUTHORITY_UNVERIFIED"); return state;
}
function current(state: GateState) {
  const facts = state.authority.executionPolicyFacts(state.policy), command = facts.command, binding = state.binding;
  if (command.operation.action !== "task.dispatch" || command.agentId !== binding.agent.agentId
    || command.operation.taskId !== binding.agent.taskId || command.operation.conversationId !== binding.sessionId
    || canonical(command.context.scope) !== canonical(binding.scope)
    || canonical(command.context.resourceBinding) !== canonical(binding.agent.resourceBinding)
    || command.context.humanSubjectId !== binding.host.actorId || command.context.nodeId !== binding.host.hostId
    || command.context.localGrant.grantId !== binding.host.grantId || command.context.localGrant.grantRevision !== binding.host.grantRevision) return fail("CONTEXT_MISMATCH");
  if (!facts.rights.invoke || !facts.rights.nodeUse) return fail("AUTHORIZATION_DENIED");
  if (state.control.commandId !== command.commandId || state.control.runId !== binding.runId
    || state.control.controlEpoch !== command.expected.controlEpoch) return fail("STALE_REVISION", "execution.control");
  sync(() => state.control.assertCurrent());
  return facts;
}
function resource(state: GateState, demand: AgentBoundaryEffectResource): void {
  const facts = current(state), approved = facts.boundary.resources.find(ref => ref.resourceId === demand.resourceId);
  if (!["read", "write", "execute"].includes(demand.access) || !approved?.access.includes(demand.access)) return fail("AUTHORIZATION_DENIED", "execution.resource");
  const item = state.authority.executionResources(state.policy).find(ref => ref.resourceId === demand.resourceId), root = state.roots.get(demand.resourceId);
  if (!item?.project || !root || canonical(item.project) !== canonical(root)
    || canonical(captureWorkspaceProjectIdentity(root.root)) !== canonical(root)) return fail("STALE_REVISION", "execution.resource");
  sync(() => item.assertCurrent());
}
/** Only controlled in-process Pi has complete effect mediation in C2. Native/full-protected engines
 * and delegated children need separate adapters that can enforce the same live per-effect fences. */
export function createAgentBoundaryExecutionGate(input: {
  binding: WorkspaceRunBinding; authority: WorkspaceAgentBoundaryAuthority; grant: AgentCommandGrant;
  control: AgentBoundaryControlSource; tools: readonly AgentBoundaryEffectTool[];
}): AgentBoundaryExecutionGate {
  const binding = freezeWorkspaceRunBinding(input.binding);
  if (binding.agent.runtimeId !== "pi" || binding.agent.permissionTier !== "controlled" || binding.lineage.depth !== 0
    || binding.lineage.parentRunId !== null) return fail("RUNTIME_UNSUPPORTED", "execution.runtime");
  if (!input.control || typeof input.control.bind !== "function") return fail("AUTHORITY_UNVERIFIED", "execution.control");
  const command = input.authority.grantFacts(input.grant).command, control = input.control.bind(command, binding);
  if (!control || typeof control.assertCurrent !== "function") {
    if (control && typeof (control as unknown as { then?: unknown }).then === "function") void Promise.resolve(control).catch(() => {});
    return fail("AUTHORITY_UNVERIFIED", "execution.control");
  }
  const roots = new Map<string, Readonly<NonNullable<AgentBoundaryResource["project"]>>>();
  for (const item of input.authority.executionResources(input.grant)) if (item.project) {
    const root = captureWorkspaceProjectIdentity(item.project.root);
    if (canonical(root) !== canonical(item.project)) return fail("STALE_REVISION", "execution.resource");
    roots.set(item.resourceId, Object.freeze({ ...root }));
  }
  const names = new Set<string>();
  const tools = input.tools.map(item => {
    if (!item || !item.tool || names.has(item.tool.name) || bookkeeping.has(item.tool.name) || typeof item.resources !== "function") return fail("INVALID_DOCUMENT", "execution.tool");
    names.add(item.tool.name);
    return Object.freeze({ tool: Object.freeze({ ...item.tool }), reference: Object.freeze({ ...item.reference }), resources: item.resources });
  });
  const state: GateState = { binding, authority: input.authority, policy: input.authority.captureExecutionPolicy(input.grant),
    control: Object.freeze({ commandId: control.commandId, runId: control.runId, controlEpoch: control.controlEpoch,
      assertCurrent: control.assertCurrent.bind(control) }), tools: Object.freeze(tools), roots, attached: false };
  current(state);
  const gate = Object.freeze({}) as AgentBoundaryExecutionGate; gates.set(gate, state); return gate;
}
function payload(input: unknown): unknown {
  let nodes = 0, chars = 0;
  const copy = (value: unknown, depth = 0): unknown => {
    if (++nodes > 20000 || depth > 20) return fail("INVALID_DOCUMENT", "execution.input");
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") { chars += value.length; if (chars > 1048576) return fail("INVALID_DOCUMENT", "execution.input"); return value; }
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (!value || typeof value !== "object" || (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))) return fail("INVALID_DOCUMENT", "execution.input");
    const output: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
      if (Array.isArray(value) && key === "length") continue;
      if (typeof key !== "string" || ["__proto__", "prototype", "constructor"].includes(key)) return fail("INVALID_DOCUMENT", "execution.input");
      chars += key.length; if (key.length > 256 || chars > 1048576) return fail("INVALID_DOCUMENT", "execution.input");
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) return fail("INVALID_DOCUMENT", "execution.input");
      (output as Record<string, unknown>)[key] = copy(descriptor.value, depth + 1);
    }
    return output;
  };
  return deepFreeze(copy(input));
}
/** Called only by createWorkspaceRunPermit; a genuine gate is single-attachment and exact-run bound. */
export function bindAgentBoundaryExecution(gate: unknown, binding: WorkspaceRunBinding, ledger: CompletionEvidenceLedger) {
  const state = stateOf(gate);
  if (state.attached || !workspaceRunBindingsEqual(state.binding, binding)) return fail("CONTEXT_MISMATCH");
  const facts = current(state);
  ledger.bindAgentBoundary(hash(canonical([state.binding, facts.command, facts.policyRevision])));
  state.attached = true;
  const check = () => { current(state); assertAgentBoundaryEffectCurrent(); };
  return Object.freeze({
    assertCurrent: check,
    close() { state.authority.retireExecutionPolicy(state.policy); },
    beforeModel(calls: number) { const facts = current(state); if (facts.boundary.approvalRequired.includes("paid") || calls >= facts.boundary.budget.maxModelCalls) fail("AUTHORIZATION_DENIED", "execution.budget"); },
    assertNativeUnavailable(): never { return fail("RUNTIME_UNSUPPORTED", "execution.runtime"); },
    assertTools(tools: readonly Tool[]) {
      for (const tool of tools) {
        const expected = state.tools.find(item => item.tool.name === tool.name)?.tool;
        if (!expected || tool.run !== expected.run || tool.input_schema !== expected.input_schema || tool.classify !== expected.classify
          || tool.kind !== expected.kind || tool.trustBoundary !== expected.trustBoundary) fail("AUTHORITY_UNVERIFIED", "execution.tool");
      }
    },
    async runTool<T>(name: string, input: unknown, callId: string | undefined, execute: (input: unknown) => Promise<T>, failed?: (value: T) => boolean): Promise<T> {
      const facts = current(state), item = state.tools.find(item => item.tool.name === name);
      if (!item && !bookkeeping.has(name)) return fail("RUNTIME_UNSUPPORTED", "execution.tool");
      if (item && (item.reference.connectorId !== null || isWorkspaceExtensionTool(item.tool) || item.tool.trustBoundary === "external" || ["exec", "computer"].includes(item.tool.kind ?? "")
        || /(?:delegate|spawn|child_agent)/.test(name))) return fail("RUNTIME_UNSUPPORTED", "execution.tool");
      const reference = item?.reference ?? { toolId: name, connectorId: null, catalogRevision: 1 };
      if (!facts.boundary.tools.allow.some(ref => canonical(ref) === canonical(reference))
        || facts.boundary.tools.deny.some(ref => ref.toolId === reference.toolId && ref.connectorId === reference.connectorId)) return fail("AUTHORIZATION_DENIED", "execution.tool");
      const frozen = payload(input);
      // A classifier failure defaults to exec in this stricter lane, even for a statically read tool.
      const traits = item ? toolOperationTraits(item.tool.classify ? { ...item.tool, kind: "exec" } : item.tool,
        frozen, Object.freeze({ cwd: state.binding.project.root, sessionId: state.binding.sessionId })) : undefined;
      if (traits && (["exec", "probe", "computer"].includes(traits.effect) || ["exec", "computer"].includes(traits.approvalKind ?? ""))) return fail("RUNTIME_UNSUPPORTED", "execution.tool");
      if (traits?.requiresExplicitApproval) return fail("AUTHORIZATION_DENIED", "execution.approval");
      const write = item?.tool.kind === "edit" || traits?.effect === "edit" || traits?.approvalKind === "edit";
      if (write && (facts.boundary.tools.readOnly || facts.boundary.approvalRequired.includes("write"))) return fail("AUTHORIZATION_DENIED", "execution.approval");
      // C9 exact-effect approvals are not implemented here; an approval requirement cannot be waived.
      const demands = item ? item.resources(frozen) : [];
      if (!Array.isArray(demands) || demands.length > 128 || item && !demands.length) return fail("AUTHORIZATION_DENIED", "execution.resource");
      const pinned = deepFreeze(demands.map(ref => ({ resourceId: ref.resourceId, access: ref.access })));
      if (write && !pinned.some(ref => ref.access === "write")) return fail("AUTHORIZATION_DENIED", "execution.resource");
      let live = true;
      const assertEffect = () => {
        if (!live) return fail("AUTHORITY_UNVERIFIED", "execution.effect");
        current(state);
        for (const demand of pinned) resource(state, demand);
      };
      assertEffect();
      if (!callId) return fail("INVALID_DOCUMENT", "execution.effect");
      const claim = ledger.claimEffect(callId, hash(canonical([name, frozen])), facts.boundary.budget.maxToolEffects);
      let settled = false;
      try {
        const result = await effects.run({ assertCurrent: assertEffect, assertFile(path, access) {
          assertEffect();
          if (!isAbsolute(path) || !pinned.some(ref => {
            if (ref.access !== access) return false;
            const root = state.roots.get(ref.resourceId); if (!root) return false;
            const tail = relative(root.root, path);
            return tail !== "" && !isAbsolute(tail) && tail !== ".." && !tail.startsWith(".." + sep);
          })) return fail("AUTHORIZATION_DENIED", "execution.resource");
        } }, () => { assertEffect(); return execute(frozen); });
        const completed = !failed?.(result) && !(typeof result === "string" && /^Error:/i.test(result));
        // A late/revoked result cannot authorize another effect. Preserve physical settlement first.
        settled = true; ledger.settleEffect(claim, completed); check(); return result;
      } catch (error) {
        if (!settled) { settled = true; ledger.settleEffect(claim, false); }
        throw error;
      } finally { live = false; }
    },
  });
}
