import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { projectApprovalScope } from "./project-approvals.js";

export const DEFAULT_TASK_APPROVAL_TTL_MS = 15 * 60_000;
export const MAX_TASK_APPROVAL_TTL_MS = 30 * 60_000;
const MAX_GRANTS = 256;

export type TaskApprovalFamily = "bash" | "python" | "file-change";

/** All identities come from the live host, never tool input, transcript, or restored grant data. */
export interface TaskApprovalBinding {
  readonly taskId: string;
  readonly sessionId: string;
  readonly agentId: string;
}

/** A structural view of the engine's already classified operation, not a second classifier. */
export interface TaskApprovalOperation {
  readonly effect: string;
  readonly approvalKind?: string;
  readonly requiresExplicitApproval?: boolean;
  readonly destructive?: boolean;
}

export interface TaskApprovalGuards {
  /** True only for the actual registered built-in, not an extra/plugin tool with the same name. */
  readonly builtin: boolean;
  readonly denied: boolean;
  readonly commandDecision: "allow" | "ask" | "deny" | null;
  readonly organizationApprovalRequired: boolean;
  readonly guardianReviewRequired: boolean;
  readonly guardianBlocked: boolean;
  readonly trustBoundary?: string;
}

export interface TaskApprovalScope {
  /** Opaque identity; no commands, arguments, source, paths, or human answers. */
  readonly key: string;
  readonly toolFamily: TaskApprovalFamily;
  readonly summary: string;
}

interface ScopeData {
  readonly binding: TaskApprovalBinding;
  readonly taskKey: string;
  readonly cwd: string;
  readonly toolName: string;
  readonly projectScopeKey: string;
}

// A parsed/serialized/forged object is not an authority-bearing scope.
const scopes = new WeakMap<TaskApprovalScope, ScopeData>();

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256
    && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validBinding(binding: TaskApprovalBinding): boolean {
  return Boolean(binding && validId(binding.taskId) && validId(binding.sessionId) && validId(binding.agentId));
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function bindingKey(binding: TaskApprovalBinding): string {
  return digest([binding.taskId, binding.sessionId, binding.agentId]);
}

function familyFor(toolName: string): TaskApprovalFamily | undefined {
  if (toolName === "bash" || toolName === "python") return toolName;
  if (toolName === "write_file" || toolName === "edit_file" || toolName === "apply_patch") return "file-change";
  return undefined;
}

/** Refuse unknown, incomplete, or stricter gates. This never decides whether an action may execute. */
export function taskApprovalEligible(
  toolName: string,
  operation: TaskApprovalOperation,
  guards: TaskApprovalGuards,
): boolean {
  const family = familyFor(toolName);
  if (!family || !operation || !guards) return false;
  if (guards.builtin !== true || guards.denied !== false
    || guards.organizationApprovalRequired !== false || guards.guardianReviewRequired !== false
    || guards.guardianBlocked !== false || guards.trustBoundary !== undefined) return false;
  if (guards.commandDecision !== null && guards.commandDecision !== "allow" && guards.commandDecision !== "ask") return false;
  if (operation.requiresExplicitApproval !== undefined && operation.requiresExplicitApproval !== false) return false;
  if (operation.destructive !== undefined && operation.destructive !== false) return false;
  const expected = family === "file-change" ? "edit" : "exec";
  return operation.effect === expected
    && (operation.approvalKind === undefined || operation.approvalKind === expected);
}

export function taskApprovalScope(
  binding: TaskApprovalBinding,
  toolName: string,
  operation: TaskApprovalOperation,
  cwd: string,
  guards: TaskApprovalGuards,
): TaskApprovalScope | undefined {
  if (!validBinding(binding) || !validId(cwd) || !taskApprovalEligible(toolName, operation, guards)) return undefined;
  try {
    const projectScopeKey = projectApprovalScope(toolName, {}, cwd).key;
    const toolFamily = familyFor(toolName)!;
    const taskKey = bindingKey(binding);
    const scope = Object.freeze({
      key: `ta1:${digest([taskKey, projectScopeKey, toolFamily])}`,
      toolFamily,
      summary: `Allow ${toolFamily === "file-change" ? "file changes" : toolFamily === "bash" ? "Bash commands" : "Python execution"} for this task in this project only; independent safety gates still apply.`,
    });
    scopes.set(scope, {
      binding: { taskId: binding.taskId, sessionId: binding.sessionId, agentId: binding.agentId },
      taskKey, cwd, toolName, projectScopeKey,
    });
    return scope;
  } catch {
    return undefined;
  }
}

function currentProject(scope: TaskApprovalScope): ScopeData | undefined {
  const data = scopes.get(scope);
  if (!data) return undefined;
  try {
    return projectApprovalScope(data.toolName, {}, data.cwd).key === data.projectScopeKey ? data : undefined;
  } catch {
    return undefined;
  }
}

export interface TaskApprovalReader {
  has(scope: TaskApprovalScope): boolean;
}

export interface HumanTaskApprovalGate {
  readonly approvalChannel: boolean;
  readonly signal: AbortSignal;
  /** Check the exact live task/session/Agent, request epoch, and all independent gates. */
  readonly isCurrent: () => boolean;
  readonly ttlMs?: number;
}

export interface TaskApprovalStore {
  readonly reader: TaskApprovalReader;
  /** Host-only callback. The human approval transport calls it only for an explicit task choice.
   * Never expose this method/callback through ToolContext, tools, MCP, models, or persisted state. */
  prepareHumanGrant(scope: TaskApprovalScope, gate: HumanTaskApprovalGate): () => boolean;
  revokeScope(scope: TaskApprovalScope): void;
  revokeTask(binding: TaskApprovalBinding): void;
  revokeSession(sessionId: string): void;
  clear(): void;
}

interface Grant {
  readonly data: ScopeData;
  readonly expiresAt: number;
  readonly signal: AbortSignal;
}

function makeStore(now: () => number): TaskApprovalStore {
  const grants = new Map<string, Grant>();
  let generation = 0;
  let lastNow = -Infinity;
  let clockFault = false;
  const time = (): number | undefined => {
    if (clockFault) return undefined;
    let at: number;
    try { at = now(); } catch { at = NaN; }
    if (!Number.isFinite(at) || at < 0 || at < lastNow) {
      clockFault = true;
      grants.clear();
      generation += 1;
      return undefined;
    }
    lastNow = at;
    for (const [key, grant] of grants) if (at >= grant.expiresAt || grant.signal.aborted) grants.delete(key);
    return at;
  };
  const has = (scope: TaskApprovalScope): boolean => {
    if (time() === undefined || !currentProject(scope)) return false;
    return grants.has(scope.key);
  };
  const invalidate = (): void => { generation += 1; };
  return Object.freeze({
    reader: Object.freeze({ has }),
    prepareHumanGrant(scope: TaskApprovalScope, gate: HumanTaskApprovalGate) {
      const preparedAt = time();
      const preparedGeneration = generation;
      // Capture primitives/functions, not a mutable options object.
      const approvalChannel = gate?.approvalChannel;
      const signal = gate?.signal;
      const isCurrent = gate?.isCurrent;
      const ttlMs = gate?.ttlMs === undefined ? DEFAULT_TASK_APPROVAL_TTL_MS : gate.ttlMs;
      let used = false;
      return (): boolean => {
        if (used) return false;
        used = true;
        if (preparedAt === undefined || generation !== preparedGeneration || approvalChannel !== true
          || !(signal instanceof AbortSignal) || signal.aborted || typeof isCurrent !== "function"
          || !Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_TASK_APPROVAL_TTL_MS) return false;
        let fresh: boolean;
        try { fresh = isCurrent() === true; } catch { return false; }
        const at = time();
        const data = currentProject(scope);
        if (!fresh || signal.aborted || generation !== preparedGeneration || at === undefined || !data
          || at - preparedAt >= ttlMs) return false;
        // Another fresh human callback never slides an existing grant's deadline.
        if (grants.has(scope.key)) return true;
        if (grants.size >= MAX_GRANTS) return false;
        grants.set(scope.key, { data, expiresAt: at + ttlMs, signal });
        return true;
      };
    },
    revokeScope(scope: TaskApprovalScope) {
      invalidate(); // A pending human reply must not undo a revocation.
      if (scopes.has(scope)) grants.delete(scope.key);
    },
    revokeTask(binding: TaskApprovalBinding) {
      invalidate();
      if (!validBinding(binding)) return;
      const taskKey = bindingKey(binding);
      for (const [key, grant] of grants) if (grant.data.taskKey === taskKey) grants.delete(key);
    },
    revokeSession(sessionId: string) {
      invalidate();
      if (!validId(sessionId)) return;
      for (const [key, grant] of grants) if (grant.data.binding.sessionId === sessionId) grants.delete(key);
    },
    clear() {
      invalidate();
      grants.clear();
    },
  });
}

/** Empty on every process start; no environment, file, transcript, or durable approval import. */
export function createTaskApprovalStore(): TaskApprovalStore {
  return makeStore(() => performance.now());
}

/** Hermetic monotonic-clock seam; production never accepts a model/environment clock override. */
export function createTaskApprovalStoreForTests(now: () => number): TaskApprovalStore {
  if (typeof now !== "function") throw new TypeError("invalid task approval test clock");
  return makeStore(now);
}
