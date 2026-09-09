import { createHash, randomUUID } from "node:crypto";
import {
  bindPrivateHaraStateFile,
  readPrivateStateFileSnapshotSync,
  removePrivateStateFile,
  withPrivateStateLockSync,
  writePrivateStateFileSync,
} from "../security/private-state.js";
import { redactSensitiveText } from "../security/secrets.js";
import { validSessionId } from "../session/store.js";
import type {
  AgentWorktreeBinding,
  AgentWorktreeDiff,
  AgentWorktreeManager,
} from "./worktree.js";

const TEAM_VERSION = 1 as const;
const MAX_TEAM_FILE_BYTES = 2 * 1024 * 1024;
const MAX_AGENTS = 64;
const MAX_AGENT_DEPTH = 4;
const MAX_INSTRUCTIONS = 64;
const MAX_MAILBOX_MESSAGES = 64;
const MAX_ASSIGNMENT_CHARS = 32_000;
const MAX_MESSAGE_CHARS = 16_000;
const MAX_RESULT_CHARS = 64_000;
const MAX_ROLE_CHARS = 128;
const MAX_TOTAL_INSTRUCTION_CHARS = 256_000;
const MAX_WAIT_MS = 5 * 60_000;
const TASK_NAME = /^[a-z][a-z0-9_-]{0,47}$/;
const AGENT_PATH = /^\/root(?:\/[a-z][a-z0-9_-]{0,47}){1,4}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMIT = /^[0-9a-f]{40,64}$/u;
const WORKSPACE_ID = /^aw_[a-f0-9]{40}$/u;
const PATCH_HASH = /^[a-f0-9]{64}$/u;
const MAX_DIFF_PATHS = 256;

export type AgentWorkspaceMode = "read-only" | "isolated-write";
export type AgentWorkspaceState = "pending" | "ready" | "changes" | "applying" | "applied" | "rejected" | "error";

interface AgentTeamWorkspaceRecord {
  mode: "isolated-write";
  state: AgentWorkspaceState;
  workspaceId?: string;
  baseCommit?: string;
  changedPaths?: string[];
  patchBytes?: number;
  patchSha256?: string;
  capturedAt?: string;
  reviewedAt?: string;
  appliedAt?: string;
  rejectedAt?: string;
  error?: string;
}

export interface AgentTeamWorkspaceView {
  mode: "isolated-write";
  state: AgentWorkspaceState;
  workspaceId?: string;
  baseCommit?: string;
  changedPaths?: string[];
  patchBytes?: number;
  patchSha256?: string;
  capturedAt?: string;
  reviewedAt?: string;
  appliedAt?: string;
  rejectedAt?: string;
}

export interface AgentTeamDiffView extends AgentTeamWorkspaceView {
  agentId: string;
  agentPath: string;
  patch: string;
}

export type AgentTeamStatus =
  | "queued"
  | "working"
  | "stopping"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface AgentTeamUsage {
  input: number;
  output: number;
  lastInput?: number;
}

export interface AgentTeamExecutionMetrics {
  providerRounds: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface AgentTeamLimits {
  maxGenerations: number;
  maxProviderRounds: number;
  maxToolCalls: number;
  maxTokens: number;
  maxActiveMs: number;
  maxRoundsPerAgent: number;
  maxToolsPerAgent: number;
  maxTokensPerAgent: number;
}

export const DEFAULT_AGENT_TEAM_LIMITS: AgentTeamLimits = {
  maxGenerations: 128,
  maxProviderRounds: 192,
  maxToolCalls: 768,
  maxTokens: 800_000,
  maxActiveMs: 30 * 60_000,
  maxRoundsPerAgent: 24,
  maxToolsPerAgent: 96,
  maxTokensPerAgent: 200_000,
};

interface AgentTeamExecutionBudget extends AgentTeamExecutionMetrics {
  generation: number;
  maxProviderRounds: number;
  maxToolCalls: number;
  maxTokens: number;
  timeoutMs: number;
}

export interface AgentTeamBudgetView extends AgentTeamExecutionMetrics {
  rootTurnId?: string;
  startedAt: string;
  deadlineAt: string;
  generationsStarted: number;
  limits: AgentTeamLimits;
  activeReservations: {
    providerRounds: number;
    toolCalls: number;
    tokens: number;
  };
  exhausted: boolean;
}

interface AgentTeamBudget extends AgentTeamExecutionMetrics {
  rootTurnId?: string;
  startedAt: string;
  deadlineAt: string;
  generationsStarted: number;
  limits: AgentTeamLimits;
}

export interface AgentMailboxDelivery {
  id: string;
  sourcePath: string;
  content: string;
  kind: "message" | "followup";
}

export interface AgentMailboxLifecycleEvent {
  id: string;
  targetId: string;
  generation: number;
  kind: "message" | "followup";
  state: "queued" | "started" | "completed";
  at: string;
  rootTurnId?: string;
}

interface AgentMailboxMessage extends AgentMailboxDelivery {
  /** Engine-owned tool call identity plus payload hash make retried mailbox mutations exactly-once. */
  commandId?: string;
  requestHash?: string;
  parentTurnId?: string;
  rootTurnId?: string;
  createdAt: string;
  state: "pending" | "delivered";
  acceptedGeneration: number;
  deliveredGeneration?: number;
}

interface AgentTeamRecord {
  id: string;
  path: string;
  name: string;
  parentPath: string;
  parentTurnId?: string;
  rootTurnId?: string;
  role?: string;
  status: AgentTeamStatus;
  generation: number;
  assignment: string;
  instructions: string[];
  mailbox: AgentMailboxMessage[];
  createdAt: string;
  updatedAt: string;
  queuedAt: string;
  startedAt?: string;
  endedAt?: string;
  model?: string;
  result?: string;
  error?: string;
  usage?: AgentTeamUsage;
  executionBudget?: AgentTeamExecutionBudget;
  workspace?: AgentTeamWorkspaceRecord;
}

interface AgentTeamSnapshot {
  version: typeof TEAM_VERSION;
  sessionId: string;
  revision: number;
  updatedAt: string;
  agents: AgentTeamRecord[];
  budget?: AgentTeamBudget;
}

export interface AgentTeamAgentView {
  id: string;
  path: string;
  name: string;
  parentPath: string;
  parentTurnId?: string;
  rootTurnId?: string;
  role?: string;
  status: AgentTeamStatus;
  generation: number;
  createdAt: string;
  updatedAt: string;
  queuedAt: string;
  startedAt?: string;
  endedAt?: string;
  model?: string;
  usage?: AgentTeamUsage;
  pendingMessages: number;
  hasResult: boolean;
  workspace?: AgentTeamWorkspaceView;
}

export interface AgentTeamWaitResult {
  agent: AgentTeamAgentView;
  settled: boolean;
  result?: string;
  error?: string;
}

export interface AgentTeamExecutionResult {
  status: "completed" | "error" | "empty" | "halted" | "cancelled";
  text: string;
  model?: string;
  error?: string;
  usage?: AgentTeamUsage;
  metrics?: AgentTeamExecutionMetrics;
}

export interface AgentTeamExecutionRequest {
  id: string;
  path: string;
  parentPath: string;
  role?: string;
  generation: number;
  task: string;
  signal: AbortSignal;
  controller: AgentTeamController;
  pendingInput: () => Promise<AgentMailboxDelivery[]>;
  budget: Pick<AgentTeamExecutionBudget, "maxProviderRounds" | "maxToolCalls" | "maxTokens" | "timeoutMs">;
  /** Absolute generation counters. False means the shared tree ceiling was reached; no new work may start. */
  reportProgress: (metrics: AgentTeamExecutionMetrics) => boolean;
  workspace?: Readonly<{
    mode: "isolated-write";
    cwd: string;
    sourceCwd: string;
    writeBoundary: string;
  }>;
}

export interface AgentTeamController {
  readonly path: string;
  spawn(input: { taskName: string; message: string; role?: string; workspace?: AgentWorkspaceMode }): Promise<AgentTeamAgentView>;
  sendMessage(target: string, message: string, commandId?: string): Promise<AgentTeamAgentView>;
  followup(target: string, message: string, commandId?: string): Promise<AgentTeamAgentView>;
  interrupt(target: string): Promise<AgentTeamAgentView>;
  resume(target: string): Promise<AgentTeamAgentView>;
  list(): AgentTeamAgentView[];
  wait(target: string, timeoutMs?: number): Promise<AgentTeamWaitResult>;
  inspectDiff(target: string): Promise<AgentTeamDiffView>;
  applyDiff(target: string): Promise<AgentTeamWorkspaceView>;
  rejectDiff(target: string): Promise<AgentTeamWorkspaceView>;
}

export interface DurableAgentTeamOptions {
  sessionId: string;
  store: AgentTeamStore;
  executor: (request: AgentTeamExecutionRequest) => Promise<AgentTeamExecutionResult>;
  onChange?: (agent: AgentTeamAgentView) => void;
  onRun?: (run: Promise<void>, agent: AgentTeamAgentView) => void;
  onMailbox?: (event: AgentMailboxLifecycleEvent) => void;
  /** Authoritative root turn. A controller captured by an earlier parent turn cannot mutate the new tree. */
  currentRootTurnId?: () => string | undefined;
  /** Resolved only when a new parent turn adopts the tree, so model/connection changes affect new work. */
  limits?: Partial<AgentTeamLimits> | (() => Partial<AgentTeamLimits>);
  /** Lazily constructed because ordinary/read-only sessions need not be Git repositories. */
  worktreeManager?: AgentWorktreeManager | (() => AgentWorktreeManager);
}

function iso(): string {
  return new Date().toISOString();
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validIso(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
}

function safeStoredString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max && !value.includes("\0");
}

function validProvenanceId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 220 && !/[\0\r\n]/u.test(value);
}

function mailboxRequestHash(input: {
  sourcePath: string;
  targetId: string;
  message: string;
  kind: "message" | "followup";
  parentTurnId?: string;
  rootTurnId?: string;
}): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function safeText(value: unknown, max: number, field: string): string {
  if (typeof value !== "string") throw new Error(field + " must be a string");
  const normalized = value.replace(/\0/g, "").trim();
  if (!normalized) throw new Error(field + " cannot be blank");
  return redactSensitiveText(normalized).text.slice(0, max);
}

function safeResultText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = redactSensitiveText(value.replace(/\0/g, "")).text.trim().slice(0, max);
  return normalized || undefined;
}

function safeRole(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return safeText(value, MAX_ROLE_CHARS, "role");
}

function validUsage(value: unknown): value is AgentTeamUsage {
  if (!plainObject(value)) return false;
  if (!Number.isFinite(value.input) || Number(value.input) < 0) return false;
  if (!Number.isFinite(value.output) || Number(value.output) < 0) return false;
  return value.lastInput === undefined || (Number.isFinite(value.lastInput) && Number(value.lastInput) >= 0);
}

function finiteCount(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum;
}

function validMetrics(value: unknown): value is AgentTeamExecutionMetrics {
  return plainObject(value)
    && finiteCount(value.providerRounds, 1_000_000)
    && finiteCount(value.toolCalls, 10_000_000)
    && finiteCount(value.inputTokens, 1_000_000_000_000)
    && finiteCount(value.outputTokens, 1_000_000_000_000);
}

function normalizeTeamLimits(input: Partial<AgentTeamLimits> = {}): AgentTeamLimits {
  const bounded = (value: unknown, fallback: number, minimum: number, maximum: number): number =>
    Number.isSafeInteger(value) ? Math.min(maximum, Math.max(minimum, Number(value))) : fallback;
  const limits: AgentTeamLimits = {
    maxGenerations: bounded(input.maxGenerations, DEFAULT_AGENT_TEAM_LIMITS.maxGenerations, 1, 4_096),
    maxProviderRounds: bounded(input.maxProviderRounds, DEFAULT_AGENT_TEAM_LIMITS.maxProviderRounds, 1, 1_000_000),
    maxToolCalls: bounded(input.maxToolCalls, DEFAULT_AGENT_TEAM_LIMITS.maxToolCalls, 1, 10_000_000),
    maxTokens: bounded(input.maxTokens, DEFAULT_AGENT_TEAM_LIMITS.maxTokens, 1_000, 1_000_000_000_000),
    maxActiveMs: bounded(input.maxActiveMs, DEFAULT_AGENT_TEAM_LIMITS.maxActiveMs, 1_000, 24 * 60 * 60_000),
    maxRoundsPerAgent: bounded(input.maxRoundsPerAgent, DEFAULT_AGENT_TEAM_LIMITS.maxRoundsPerAgent, 1, 1_000),
    maxToolsPerAgent: bounded(input.maxToolsPerAgent, DEFAULT_AGENT_TEAM_LIMITS.maxToolsPerAgent, 1, 100_000),
    maxTokensPerAgent: bounded(input.maxTokensPerAgent, DEFAULT_AGENT_TEAM_LIMITS.maxTokensPerAgent, 1_000, 1_000_000_000),
  };
  limits.maxRoundsPerAgent = Math.min(limits.maxRoundsPerAgent, limits.maxProviderRounds);
  limits.maxToolsPerAgent = Math.min(limits.maxToolsPerAgent, limits.maxToolCalls);
  limits.maxTokensPerAgent = Math.min(limits.maxTokensPerAgent, limits.maxTokens);
  return limits;
}

function parseExecutionBudget(value: unknown, generation: number): AgentTeamExecutionBudget | undefined {
  if (value === undefined) return undefined;
  if (!plainObject(value) || !validMetrics(value) || value.generation !== generation) {
    throw new Error("agent execution budget is invalid");
  }
  for (const field of ["maxProviderRounds", "maxToolCalls", "maxTokens", "timeoutMs"] as const) {
    if (!finiteCount(value[field]) || Number(value[field]) < 1) {
      throw new Error("agent execution budget limit is invalid");
    }
  }
  return {
    generation,
    maxProviderRounds: Number(value.maxProviderRounds),
    maxToolCalls: Number(value.maxToolCalls),
    maxTokens: Number(value.maxTokens),
    timeoutMs: Number(value.timeoutMs),
    providerRounds: Number(value.providerRounds),
    toolCalls: Number(value.toolCalls),
    inputTokens: Number(value.inputTokens),
    outputTokens: Number(value.outputTokens),
  };
}

function parseWorkspace(value: unknown): AgentTeamWorkspaceRecord | undefined {
  if (value === undefined) return undefined;
  if (!plainObject(value) || value.mode !== "isolated-write") {
    throw new Error("agent workspace is invalid");
  }
  if (!["pending", "ready", "changes", "applying", "applied", "rejected", "error"].includes(String(value.state))) {
    throw new Error("agent workspace state is invalid");
  }
  if (value.workspaceId !== undefined && !WORKSPACE_ID.test(String(value.workspaceId))) {
    throw new Error("agent workspace id is invalid");
  }
  if (value.baseCommit !== undefined && !COMMIT.test(String(value.baseCommit))) {
    throw new Error("agent workspace base commit is invalid");
  }
  if ((value.workspaceId === undefined) !== (value.baseCommit === undefined)) {
    throw new Error("agent workspace ownership is incomplete");
  }
  if (
    value.changedPaths !== undefined
    && (!Array.isArray(value.changedPaths)
      || value.changedPaths.length > MAX_DIFF_PATHS
      || value.changedPaths.some((path) => !safeStoredString(path, 4_096) || !path))
  ) throw new Error("agent workspace changed paths are invalid");
  if (value.patchBytes !== undefined && !finiteCount(value.patchBytes, 2 * 1024 * 1024)) {
    throw new Error("agent workspace patch size is invalid");
  }
  if (value.patchSha256 !== undefined && !PATCH_HASH.test(String(value.patchSha256))) {
    throw new Error("agent workspace patch hash is invalid");
  }
  for (const field of ["capturedAt", "reviewedAt", "appliedAt", "rejectedAt"] as const) {
    if (value[field] !== undefined && !validIso(value[field])) {
      throw new Error("agent workspace timestamp is invalid");
    }
  }
  if (value.error !== undefined && !safeStoredString(value.error, 1_000)) {
    throw new Error("agent workspace error is invalid");
  }
  if (
    (value.patchBytes === undefined) !== (value.patchSha256 === undefined)
    || (value.patchBytes === undefined) !== (value.changedPaths === undefined)
    || (value.patchBytes === undefined) !== (value.capturedAt === undefined)
  ) throw new Error("agent workspace Diff receipt is incomplete");
  return {
    mode: "isolated-write",
    state: value.state as AgentWorkspaceState,
    ...(value.workspaceId !== undefined ? { workspaceId: String(value.workspaceId) } : {}),
    ...(value.baseCommit !== undefined ? { baseCommit: String(value.baseCommit) } : {}),
    ...(value.changedPaths !== undefined ? { changedPaths: [...value.changedPaths] as string[] } : {}),
    ...(value.patchBytes !== undefined ? { patchBytes: Number(value.patchBytes) } : {}),
    ...(value.patchSha256 !== undefined ? { patchSha256: String(value.patchSha256) } : {}),
    ...(value.capturedAt !== undefined ? { capturedAt: String(value.capturedAt) } : {}),
    ...(value.reviewedAt !== undefined ? { reviewedAt: String(value.reviewedAt) } : {}),
    ...(value.appliedAt !== undefined ? { appliedAt: String(value.appliedAt) } : {}),
    ...(value.rejectedAt !== undefined ? { rejectedAt: String(value.rejectedAt) } : {}),
    ...(value.error !== undefined ? { error: String(value.error) } : {}),
  };
}

function parseBudget(value: unknown): AgentTeamBudget | undefined {
  if (value === undefined) return undefined;
  if (!plainObject(value) || !validMetrics(value)) throw new Error("agent team budget is invalid");
  if (value.rootTurnId !== undefined && !validProvenanceId(value.rootTurnId)) {
    throw new Error("agent team budget root turn is invalid");
  }
  if (!validIso(value.startedAt) || !validIso(value.deadlineAt)) {
    throw new Error("agent team budget time boundary is invalid");
  }
  if (!finiteCount(value.generationsStarted, 4_096) || !plainObject(value.limits)) {
    throw new Error("agent team budget generation count is invalid");
  }
  const limits = normalizeTeamLimits(value.limits as Partial<AgentTeamLimits>);
  return {
    ...(value.rootTurnId !== undefined ? { rootTurnId: String(value.rootTurnId) } : {}),
    startedAt: String(value.startedAt),
    deadlineAt: String(value.deadlineAt),
    generationsStarted: Number(value.generationsStarted),
    providerRounds: Number(value.providerRounds),
    toolCalls: Number(value.toolCalls),
    inputTokens: Number(value.inputTokens),
    outputTokens: Number(value.outputTokens),
    limits,
  };
}

function pathDepth(path: string): number {
  return path.split("/").filter(Boolean).length - 1;
}

function parentPathFor(path: string): string {
  const index = path.lastIndexOf("/");
  return path.slice(0, index) || "/root";
}

function validSourcePath(value: unknown): value is string {
  return value === "/root" || (typeof value === "string" && AGENT_PATH.test(value));
}

const TEAM_STATUSES = new Set<AgentTeamStatus>([
  "queued",
  "working",
  "stopping",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

function parseMailbox(value: unknown): AgentMailboxMessage[] {
  if (!Array.isArray(value) || value.length > MAX_MAILBOX_MESSAGES) {
    throw new Error("agent team mailbox is invalid or too large");
  }
  return value.map((entry): AgentMailboxMessage => {
    if (!plainObject(entry)) throw new Error("agent team mailbox entry is invalid");
    if (!UUID.test(String(entry.id ?? ""))) throw new Error("agent team mailbox id is invalid");
    if (!validSourcePath(entry.sourcePath)) throw new Error("agent team mailbox source is invalid");
    if (!safeStoredString(entry.content, MAX_MESSAGE_CHARS)) throw new Error("agent team mailbox content is invalid");
    if (entry.kind !== "message" && entry.kind !== "followup") throw new Error("agent team mailbox kind is invalid");
    if ((entry.commandId === undefined) !== (entry.requestHash === undefined)) {
      throw new Error("agent team mailbox idempotency receipt is incomplete");
    }
    if (entry.commandId !== undefined && !validProvenanceId(entry.commandId)) {
      throw new Error("agent team mailbox command id is invalid");
    }
    if (entry.requestHash !== undefined && !/^[0-9a-f]{64}$/u.test(String(entry.requestHash))) {
      throw new Error("agent team mailbox request hash is invalid");
    }
    for (const field of ["parentTurnId", "rootTurnId"] as const) {
      if (entry[field] !== undefined && !validProvenanceId(entry[field])) {
        throw new Error("agent team mailbox " + field + " is invalid");
      }
    }
    if (!validIso(entry.createdAt)) throw new Error("agent team mailbox timestamp is invalid");
    if (entry.state !== "pending" && entry.state !== "delivered") throw new Error("agent team mailbox state is invalid");
    if (!Number.isSafeInteger(entry.acceptedGeneration) || Number(entry.acceptedGeneration) < 1) {
      throw new Error("agent team mailbox generation is invalid");
    }
    if (
      entry.deliveredGeneration !== undefined
      && (!Number.isSafeInteger(entry.deliveredGeneration) || Number(entry.deliveredGeneration) < 1)
    ) throw new Error("agent team mailbox delivery generation is invalid");
    return {
      id: String(entry.id),
      sourcePath: entry.sourcePath,
      content: entry.content,
      kind: entry.kind,
      ...(entry.commandId !== undefined ? { commandId: String(entry.commandId) } : {}),
      ...(entry.requestHash !== undefined ? { requestHash: String(entry.requestHash) } : {}),
      ...(entry.parentTurnId !== undefined ? { parentTurnId: String(entry.parentTurnId) } : {}),
      ...(entry.rootTurnId !== undefined ? { rootTurnId: String(entry.rootTurnId) } : {}),
      createdAt: entry.createdAt,
      state: entry.state,
      acceptedGeneration: Number(entry.acceptedGeneration),
      ...(entry.deliveredGeneration !== undefined
        ? { deliveredGeneration: Number(entry.deliveredGeneration) }
        : {}),
    };
  });
}

function parseRecord(value: unknown): AgentTeamRecord {
  if (!plainObject(value)) throw new Error("agent team record is invalid");
  if (!UUID.test(String(value.id ?? ""))) throw new Error("agent team id is invalid");
  if (typeof value.path !== "string" || !AGENT_PATH.test(value.path) || pathDepth(value.path) > MAX_AGENT_DEPTH) {
    throw new Error("agent team path is invalid");
  }
  if (typeof value.name !== "string" || !TASK_NAME.test(value.name) || !value.path.endsWith("/" + value.name)) {
    throw new Error("agent team task name is invalid");
  }
  if (!validSourcePath(value.parentPath) || value.parentPath !== parentPathFor(value.path)) {
    throw new Error("agent team parent path is invalid");
  }
  for (const field of ["parentTurnId", "rootTurnId"] as const) {
    if (value[field] !== undefined && !validProvenanceId(value[field])) {
      throw new Error("agent team " + field + " is invalid");
    }
  }
  if (value.role !== undefined && !safeStoredString(value.role, MAX_ROLE_CHARS)) {
    throw new Error("agent team role is invalid");
  }
  if (typeof value.status !== "string" || !TEAM_STATUSES.has(value.status as AgentTeamStatus)) {
    throw new Error("agent team status is invalid");
  }
  if (!Number.isSafeInteger(value.generation) || Number(value.generation) < 1) {
    throw new Error("agent team generation is invalid");
  }
  if (!safeStoredString(value.assignment, MAX_ASSIGNMENT_CHARS) || !value.assignment.trim()) {
    throw new Error("agent team assignment is invalid");
  }
  if (!Array.isArray(value.instructions) || value.instructions.length < 1 || value.instructions.length > MAX_INSTRUCTIONS) {
    throw new Error("agent team instructions are invalid or too large");
  }
  const instructions = value.instructions.map((instruction, index) => {
    const max = index === 0 ? MAX_ASSIGNMENT_CHARS : MAX_MESSAGE_CHARS;
    if (!safeStoredString(instruction, max) || !instruction.trim()) {
      throw new Error("agent team instruction is invalid");
    }
    return instruction;
  });
  if (instructions[0] !== value.assignment) {
    throw new Error("agent team assignment does not match its first instruction");
  }
  if (instructions.reduce((total, instruction) => total + instruction.length, 0) > MAX_TOTAL_INSTRUCTION_CHARS) {
    throw new Error("agent team instructions exceed the durable limit");
  }
  for (const field of ["createdAt", "updatedAt", "queuedAt"] as const) {
    if (!validIso(value[field])) throw new Error("agent team " + field + " is invalid");
  }
  for (const field of ["startedAt", "endedAt"] as const) {
    if (value[field] !== undefined && !validIso(value[field])) throw new Error("agent team " + field + " is invalid");
  }
  for (const [field, max] of [["model", 512], ["result", MAX_RESULT_CHARS], ["error", MAX_RESULT_CHARS]] as const) {
    if (value[field] !== undefined && !safeStoredString(value[field], max)) {
      throw new Error("agent team " + field + " is invalid");
    }
  }
  if (value.usage !== undefined && !validUsage(value.usage)) throw new Error("agent team usage is invalid");
  const executionBudget = parseExecutionBudget(value.executionBudget, Number(value.generation));
  const workspace = parseWorkspace(value.workspace);
  return {
    id: String(value.id),
    path: value.path,
    name: value.name,
    parentPath: value.parentPath,
    ...(value.parentTurnId !== undefined ? { parentTurnId: String(value.parentTurnId) } : {}),
    ...(value.rootTurnId !== undefined ? { rootTurnId: String(value.rootTurnId) } : {}),
    ...(value.role !== undefined ? { role: String(value.role) } : {}),
    status: value.status as AgentTeamStatus,
    generation: Number(value.generation),
    assignment: value.assignment,
    instructions,
    mailbox: parseMailbox(value.mailbox),
    createdAt: String(value.createdAt),
    updatedAt: String(value.updatedAt),
    queuedAt: String(value.queuedAt),
    ...(value.startedAt !== undefined ? { startedAt: String(value.startedAt) } : {}),
    ...(value.endedAt !== undefined ? { endedAt: String(value.endedAt) } : {}),
    ...(value.model !== undefined ? { model: String(value.model) } : {}),
    ...(value.result !== undefined ? { result: String(value.result) } : {}),
    ...(value.error !== undefined ? { error: String(value.error) } : {}),
    ...(value.usage !== undefined ? {
      usage: {
        input: Number(value.usage.input),
        output: Number(value.usage.output),
        ...(value.usage.lastInput !== undefined ? { lastInput: Number(value.usage.lastInput) } : {}),
      },
    } : {}),
    ...(executionBudget ? { executionBudget } : {}),
    ...(workspace ? { workspace } : {}),
  };
}

function emptySnapshot(sessionId: string): AgentTeamSnapshot {
  return { version: TEAM_VERSION, sessionId, revision: 0, updatedAt: iso(), agents: [] };
}

function parseSnapshot(text: string, sessionId: string): AgentTeamSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("agent team state is malformed JSON");
  }
  if (!plainObject(value) || value.version !== TEAM_VERSION || value.sessionId !== sessionId) {
    throw new Error("agent team state has an invalid identity or version");
  }
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 0 || !validIso(value.updatedAt)) {
    throw new Error("agent team state revision is invalid");
  }
  if (!Array.isArray(value.agents) || value.agents.length > MAX_AGENTS) {
    throw new Error("agent team state exceeds the agent limit");
  }
  const agents = value.agents.map(parseRecord);
  if (new Set(agents.map((agent) => agent.id)).size !== agents.length) {
    throw new Error("agent team contains duplicate ids");
  }
  if (new Set(agents.map((agent) => agent.path)).size !== agents.length) {
    throw new Error("agent team contains duplicate paths");
  }
  return {
    version: TEAM_VERSION,
    sessionId,
    revision: Number(value.revision),
    updatedAt: value.updatedAt,
    agents,
    ...(value.budget !== undefined ? { budget: parseBudget(value.budget)! } : {}),
  };
}

function copySnapshot(snapshot: AgentTeamSnapshot): AgentTeamSnapshot {
  return structuredClone(snapshot);
}

function serializedSnapshot(snapshot: AgentTeamSnapshot): string {
  const text = JSON.stringify(snapshot, null, 2) + "\n";
  if (Buffer.byteLength(text, "utf8") > MAX_TEAM_FILE_BYTES) {
    throw new Error("agent team state exceeds the 2 MiB durable limit");
  }
  parseSnapshot(text, snapshot.sessionId);
  return text;
}

export class AgentTeamStore {
  constructor(private readonly home: string) {}

  private binding(sessionId: string) {
    if (!validSessionId(sessionId)) throw new Error("invalid Agent team session id");
    return bindPrivateHaraStateFile(this.home, ["agent-teams"], sessionId + ".json");
  }

  private readUnlocked(sessionId: string): { snapshot: AgentTeamSnapshot; text?: string } {
    const binding = this.binding(sessionId);
    const current = readPrivateStateFileSnapshotSync(binding.path, MAX_TEAM_FILE_BYTES);
    return current
      ? { snapshot: parseSnapshot(current.text, sessionId), text: current.text }
      : { snapshot: emptySnapshot(sessionId) };
  }

  load(sessionId: string): AgentTeamSnapshot {
    return withPrivateStateLockSync(this.home, ["agent-teams"], sessionId + ".team", () => {
      return copySnapshot(this.readUnlocked(sessionId).snapshot);
    });
  }

  update(sessionId: string, mutate: (snapshot: AgentTeamSnapshot) => void): AgentTeamSnapshot {
    return withPrivateStateLockSync(this.home, ["agent-teams"], sessionId + ".team", () => {
      const current = this.readUnlocked(sessionId);
      const next = copySnapshot(current.snapshot);
      mutate(next);
      next.version = TEAM_VERSION;
      next.sessionId = sessionId;
      next.revision = current.snapshot.revision + 1;
      next.updatedAt = iso();
      const text = serializedSnapshot(next);
      writePrivateStateFileSync(
        this.binding(sessionId),
        text,
        current.text === undefined ? { expectedMissing: true } : { expectedText: current.text },
      );
      return copySnapshot(next);
    });
  }

  remove(sessionId: string): boolean {
    return withPrivateStateLockSync(this.home, ["agent-teams"], sessionId + ".team", () => {
      const binding = this.binding(sessionId);
      const current = readPrivateStateFileSnapshotSync(binding.path, MAX_TEAM_FILE_BYTES);
      if (!current) return false;
      parseSnapshot(current.text, sessionId);
      removePrivateStateFile(binding.path, current, binding.directory);
      return true;
    });
  }
}

function workspaceViewOf(workspace: AgentTeamWorkspaceRecord): AgentTeamWorkspaceView {
  return {
    mode: workspace.mode,
    state: workspace.state,
    ...(workspace.workspaceId ? { workspaceId: workspace.workspaceId } : {}),
    ...(workspace.baseCommit ? { baseCommit: workspace.baseCommit } : {}),
    ...(workspace.changedPaths ? { changedPaths: [...workspace.changedPaths] } : {}),
    ...(workspace.patchBytes !== undefined ? { patchBytes: workspace.patchBytes } : {}),
    ...(workspace.patchSha256 ? { patchSha256: workspace.patchSha256 } : {}),
    ...(workspace.capturedAt ? { capturedAt: workspace.capturedAt } : {}),
    ...(workspace.reviewedAt ? { reviewedAt: workspace.reviewedAt } : {}),
    ...(workspace.appliedAt ? { appliedAt: workspace.appliedAt } : {}),
    ...(workspace.rejectedAt ? { rejectedAt: workspace.rejectedAt } : {}),
  };
}

function viewOf(record: AgentTeamRecord): AgentTeamAgentView {
  return {
    id: record.id,
    path: record.path,
    name: record.name,
    parentPath: record.parentPath,
    ...(record.parentTurnId ? { parentTurnId: record.parentTurnId } : {}),
    ...(record.rootTurnId ? { rootTurnId: record.rootTurnId } : {}),
    ...(record.role ? { role: record.role } : {}),
    status: record.status,
    generation: record.generation,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    queuedAt: record.queuedAt,
    ...(record.startedAt ? { startedAt: record.startedAt } : {}),
    ...(record.endedAt ? { endedAt: record.endedAt } : {}),
    ...(record.model ? { model: record.model } : {}),
    ...(record.usage ? { usage: { ...record.usage } } : {}),
    pendingMessages: record.mailbox.filter((message) => message.state === "pending").length,
    hasResult: Boolean(record.result),
    ...(record.workspace ? { workspace: workspaceViewOf(record.workspace) } : {}),
  };
}

function terminal(status: AgentTeamStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "interrupted";
}

function executionPrompt(record: AgentTeamRecord): string {
  const sections = ["Initial assignment:\n" + record.assignment];
  if (record.instructions.length > 1) {
    sections.push(
      "Accepted follow-up context:\n"
      + record.instructions.slice(1).map((item, index) => String(index + 1) + ". " + item).join("\n"),
    );
  }
  if (record.generation > 1 && record.result?.trim()) {
    sections.push("Previous generation result (reference only):\n" + record.result);
  }
  return sections.join("\n\n");
}

interface ActiveAgentRun {
  generation: number;
  controller: AbortController;
  promise: Promise<void>;
}

/** Durable Codex-style Agent tree. Children are read-only unless an explicit isolated-write workspace is
 * requested; stable identities, mailbox state, owned Diffs, and terminal results survive host restarts. */
export class DurableAgentTeam {
  private snapshot?: AgentTeamSnapshot;
  private readonly active = new Map<string, ActiveAgentRun>();
  /** A Serve pause/migration drains the existing tree without permitting a queued follow-up generation
   * to start on the old owner. The host discards this team after the drain and reconstructs it on resume. */
  private draining = false;
  private closed = false;
  private resolvedWorktreeManager?: AgentWorktreeManager;

  constructor(private readonly options: DurableAgentTeamOptions) {
    if (!validSessionId(options.sessionId)) throw new Error("invalid Agent team session id");
  }

  private worktreeManager(): AgentWorktreeManager {
    if (this.resolvedWorktreeManager) return this.resolvedWorktreeManager;
    const configured = this.options.worktreeManager;
    if (!configured) throw new Error("isolated writable Agent worktrees are unavailable in this session");
    this.resolvedWorktreeManager = typeof configured === "function" ? configured() : configured;
    return this.resolvedWorktreeManager;
  }

  private configuredLimits(): AgentTeamLimits {
    const configured = typeof this.options.limits === "function"
      ? this.options.limits()
      : this.options.limits;
    return normalizeTeamLimits(configured);
  }

  private newBudget(rootTurnId?: string): AgentTeamBudget {
    const limits = this.configuredLimits();
    const started = Date.now();
    return {
      ...(rootTurnId ? { rootTurnId } : {}),
      startedAt: new Date(started).toISOString(),
      deadlineAt: new Date(started + limits.maxActiveMs).toISOString(),
      generationsStarted: 0,
      providerRounds: 0,
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      limits,
    };
  }

  private adoptRootTurn(rootTurnId: string): void {
    this.ensureLoaded();
    if (this.snapshot!.budget?.rootTurnId === rootTurnId) return;
    const interrupted: string[] = [];
    this.snapshot = this.options.store.update(this.options.sessionId, (draft) => {
      const now = iso();
      for (const record of draft.agents) {
        if (
          record.rootTurnId !== rootTurnId
          && (record.status === "queued" || record.status === "working" || record.status === "stopping")
        ) {
          record.status = "stopping";
          record.updatedAt = now;
          interrupted.push(record.id);
        }
      }
      draft.budget = this.newBudget(rootTurnId);
    });
    for (const id of interrupted) {
      const record = this.snapshot.agents.find((candidate) => candidate.id === id);
      if (record) this.publish(record);
      this.active.get(id)?.controller.abort(new Error("Agent parent turn changed"));
    }
  }

  private activeReservations(
    snapshot: AgentTeamSnapshot,
    rootTurnId = snapshot.budget?.rootTurnId,
    excludeId?: string,
  ): { providerRounds: number; toolCalls: number; tokens: number } {
    const reserved = { providerRounds: 0, toolCalls: 0, tokens: 0 };
    for (const record of snapshot.agents) {
      if (record.id === excludeId || record.rootTurnId !== rootTurnId) continue;
      if (record.status !== "queued" && record.status !== "working" && record.status !== "stopping") continue;
      const execution = record.executionBudget;
      if (!execution || execution.generation !== record.generation) continue;
      reserved.providerRounds += Math.max(0, execution.maxProviderRounds - execution.providerRounds);
      reserved.toolCalls += Math.max(0, execution.maxToolCalls - execution.toolCalls);
      reserved.tokens += Math.max(
        0,
        execution.maxTokens - execution.inputTokens - execution.outputTokens,
      );
    }
    return reserved;
  }

  private reserveExecutionBudget(
    record: AgentTeamRecord,
    snapshot: AgentTeamSnapshot,
    rootTurnId?: string,
  ): void {
    if (!snapshot.budget || snapshot.budget.rootTurnId !== rootTurnId) {
      snapshot.budget = this.newBudget(rootTurnId);
    }
    const budget = snapshot.budget;
    const now = Date.now();
    if (now >= Date.parse(budget.deadlineAt)) throw new Error("Agent tree active-execution deadline was reached");
    if (budget.generationsStarted >= budget.limits.maxGenerations) {
      throw new Error("Agent tree generation limit reached (" + String(budget.limits.maxGenerations) + ")");
    }
    const reserved = this.activeReservations(snapshot, rootTurnId, record.id);
    const availableRounds = budget.limits.maxProviderRounds - budget.providerRounds - reserved.providerRounds;
    const availableTools = budget.limits.maxToolCalls - budget.toolCalls - reserved.toolCalls;
    const usedTokens = budget.inputTokens + budget.outputTokens;
    const availableTokens = budget.limits.maxTokens - usedTokens - reserved.tokens;
    if (availableRounds < 1) throw new Error("Agent tree provider-round limit reached");
    if (availableTools < 1) throw new Error("Agent tree tool-call limit reached");
    if (availableTokens < 1) throw new Error("Agent tree token limit reached");
    record.executionBudget = {
      generation: record.generation,
      maxProviderRounds: Math.min(budget.limits.maxRoundsPerAgent, availableRounds),
      maxToolCalls: Math.min(budget.limits.maxToolsPerAgent, availableTools),
      maxTokens: Math.min(budget.limits.maxTokensPerAgent, availableTokens),
      timeoutMs: Math.max(1, Math.min(budget.limits.maxActiveMs, Date.parse(budget.deadlineAt) - now)),
      providerRounds: 0,
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    budget.generationsStarted += 1;
  }

  private reportGenerationProgress(
    id: string,
    generation: number,
    metrics: AgentTeamExecutionMetrics,
  ): boolean {
    if (!validMetrics(metrics)) return false;
    this.ensureLoaded();
    let withinLimit = false;
    this.snapshot = this.options.store.update(this.options.sessionId, (draft) => {
      const record = draft.agents.find((candidate) => candidate.id === id);
      const execution = record?.executionBudget;
      const budget = draft.budget;
      if (!record || record.generation !== generation || !execution || execution.generation !== generation || !budget) {
        return;
      }
      if (record.rootTurnId !== budget.rootTurnId) return;
      if (
        metrics.providerRounds < execution.providerRounds
        || metrics.toolCalls < execution.toolCalls
        || metrics.inputTokens < execution.inputTokens
        || metrics.outputTokens < execution.outputTokens
      ) return;
      budget.providerRounds += metrics.providerRounds - execution.providerRounds;
      budget.toolCalls += metrics.toolCalls - execution.toolCalls;
      budget.inputTokens += metrics.inputTokens - execution.inputTokens;
      budget.outputTokens += metrics.outputTokens - execution.outputTokens;
      execution.providerRounds = metrics.providerRounds;
      execution.toolCalls = metrics.toolCalls;
      execution.inputTokens = metrics.inputTokens;
      execution.outputTokens = metrics.outputTokens;
      record.updatedAt = iso();
      withinLimit = metrics.providerRounds <= execution.maxProviderRounds
        && metrics.toolCalls <= execution.maxToolCalls
        && metrics.inputTokens + metrics.outputTokens <= execution.maxTokens
        && budget.providerRounds <= budget.limits.maxProviderRounds
        && budget.toolCalls <= budget.limits.maxToolCalls
        && budget.inputTokens + budget.outputTokens <= budget.limits.maxTokens
        && Date.now() < Date.parse(budget.deadlineAt);
    });
    const record = this.snapshot.agents.find((candidate) => candidate.id === id);
    if (record) this.publish(record);
    return withinLimit;
  }

  budget(): AgentTeamBudgetView | undefined {
    this.ensureLoaded();
    const budget = this.snapshot!.budget;
    if (!budget) return undefined;
    const reservations = this.activeReservations(this.snapshot!);
    return {
      ...(budget.rootTurnId ? { rootTurnId: budget.rootTurnId } : {}),
      startedAt: budget.startedAt,
      deadlineAt: budget.deadlineAt,
      generationsStarted: budget.generationsStarted,
      providerRounds: budget.providerRounds,
      toolCalls: budget.toolCalls,
      inputTokens: budget.inputTokens,
      outputTokens: budget.outputTokens,
      limits: { ...budget.limits },
      activeReservations: reservations,
      exhausted: Date.now() >= Date.parse(budget.deadlineAt)
        || budget.generationsStarted >= budget.limits.maxGenerations
        || budget.providerRounds >= budget.limits.maxProviderRounds
        || budget.toolCalls >= budget.limits.maxToolCalls
        || budget.inputTokens + budget.outputTokens >= budget.limits.maxTokens,
    };
  }

  private ensureLoaded(): void {
    if (this.snapshot) return;
    const loaded = this.options.store.load(this.options.sessionId);
    const interrupted = new Set(
      loaded.agents
        .filter((agent) => agent.status === "queued" || agent.status === "working" || agent.status === "stopping")
        .map((agent) => agent.id),
    );
    this.snapshot = interrupted.size
      ? this.options.store.update(this.options.sessionId, (draft) => {
          const now = iso();
          for (const record of draft.agents) {
            if (!interrupted.has(record.id)) continue;
            record.status = "interrupted";
            record.endedAt = now;
            record.updatedAt = now;
            record.error = "Previous Hara runtime stopped before this Agent completed; resume it explicitly.";
          }
        })
      : loaded;
    for (const id of interrupted) {
      const record = this.snapshot.agents.find((agent) => agent.id === id);
      if (record) this.publish(record);
    }
  }

  private publish(record: AgentTeamRecord): void {
    try {
      this.options.onChange?.(viewOf(record));
    } catch {
      // Observability can never change Agent admission or persistence.
    }
  }

  private publishMailbox(
    record: AgentTeamRecord,
    message: AgentMailboxMessage,
    state: AgentMailboxLifecycleEvent["state"],
  ): void {
    try {
      this.options.onMailbox?.({
        id: message.id,
        targetId: record.id,
        generation: message.deliveredGeneration ?? message.acceptedGeneration,
        kind: message.kind,
        state,
        at: state === "queued" ? message.createdAt : iso(),
        ...(message.rootTurnId ? { rootTurnId: message.rootTurnId } : {}),
      });
    } catch {
      // Mailbox observability cannot change a committed delivery.
    }
  }

  private change(
    id: string,
    mutate: (record: AgentTeamRecord, snapshot: AgentTeamSnapshot) => void,
  ): AgentTeamRecord {
    this.ensureLoaded();
    this.snapshot = this.options.store.update(this.options.sessionId, (draft) => {
      const record = draft.agents.find((candidate) => candidate.id === id);
      if (!record) throw new Error("no Agent '" + id + "' exists in this session");
      mutate(record, draft);
      record.updatedAt = iso();
    });
    const committed = this.snapshot.agents.find((record) => record.id === id);
    if (!committed) throw new Error("no Agent '" + id + "' exists in this session");
    this.publish(committed);
    return committed;
  }

  private resolve(target: string): AgentTeamRecord {
    this.ensureLoaded();
    const ref = target.trim();
    if (!ref || ref.length > 220) throw new Error("Agent target must be a bounded id, path, or task name");
    const exact = this.snapshot!.agents.find((agent) => agent.id === ref || agent.path === ref);
    if (exact) return exact;
    const named = this.snapshot!.agents.filter((agent) => agent.name === ref);
    if (named.length === 1) return named[0];
    if (named.length > 1) {
      throw new Error("Agent target '" + ref + "' is ambiguous; use its stable id or full path");
    }
    throw new Error("no Agent '" + ref + "' exists in this session");
  }

  private current(id: string): AgentTeamRecord {
    this.ensureLoaded();
    const record = this.snapshot!.agents.find((candidate) => candidate.id === id);
    if (!record) throw new Error("no Agent '" + id + "' exists in this session");
    return record;
  }

  controller(
    path = "/root",
    provenance: { parentTurnId?: string; rootTurnId?: string } = {},
  ): AgentTeamController {
    if (!validSourcePath(path)) throw new Error("invalid Agent controller path");
    if (provenance.parentTurnId !== undefined && !validProvenanceId(provenance.parentTurnId)) {
      throw new Error("invalid parent Agent turn provenance");
    }
    if (provenance.rootTurnId !== undefined && !validProvenanceId(provenance.rootTurnId)) {
      throw new Error("invalid root Agent turn provenance");
    }
    if (path === "/root" && provenance.rootTurnId !== undefined) {
      this.adoptRootTurn(provenance.rootTurnId);
    }
    return {
      path,
      spawn: (input) => {
        this.assertControllerFence(path, provenance);
        return this.spawn(path, input, provenance);
      },
      sendMessage: (target, message, commandId) => {
        this.assertControllerFence(path, provenance);
        return this.message(path, target, message, "message", provenance, commandId);
      },
      followup: (target, message, commandId) => {
        this.assertControllerFence(path, provenance);
        return this.message(path, target, message, "followup", provenance, commandId);
      },
      interrupt: (target) => {
        this.assertControllerFence(path, provenance);
        return this.interrupt(target, provenance);
      },
      resume: (target) => {
        this.assertControllerFence(path, provenance);
        return this.resume(target, provenance);
      },
      list: () => this.list(),
      wait: (target, timeoutMs) => this.wait(target, timeoutMs),
      inspectDiff: (target) => {
        this.assertControllerFence(path, provenance);
        return this.inspectDiff(target, provenance);
      },
      applyDiff: (target) => {
        this.assertControllerFence(path, provenance);
        return this.applyDiff(target, provenance);
      },
      rejectDiff: (target) => {
        this.assertControllerFence(path, provenance);
        return this.rejectDiff(target, provenance);
      },
    };
  }

  private assertControllerFence(
    sourcePath: string,
    provenance: { parentTurnId?: string; rootTurnId?: string },
  ): void {
    const authoritativeRootTurnId = this.options.currentRootTurnId?.();
    if (
      provenance.rootTurnId !== undefined
      && authoritativeRootTurnId !== undefined
      && provenance.rootTurnId !== authoritativeRootTurnId
    ) {
      throw new Error("Agent controller belongs to a previous parent turn; refresh the Agent tree before mutating it");
    }
    if (sourcePath === "/root" || provenance.parentTurnId === undefined) return;
    const source = this.resolve(sourcePath);
    const currentParentTurnId = `${source.id}:${source.generation}`;
    if (provenance.parentTurnId !== currentParentTurnId) {
      throw new Error("Agent controller generation is stale; its mailbox authority has ended");
    }
    if (
      provenance.rootTurnId !== undefined
      && source.rootTurnId !== undefined
      && provenance.rootTurnId !== source.rootTurnId
    ) {
      throw new Error("Agent controller cannot cross a parent-turn boundary");
    }
  }

  private assertTargetTurn(
    record: AgentTeamRecord,
    provenance: { rootTurnId?: string },
  ): void {
    if (
      provenance.rootTurnId !== undefined
      && record.rootTurnId !== undefined
      && provenance.rootTurnId !== record.rootTurnId
    ) {
      throw new Error("Agent belongs to a different parent turn and cannot receive this command");
    }
  }

  list(): AgentTeamAgentView[] {
    this.ensureLoaded();
    return this.snapshot!.agents.map(viewOf).sort((left, right) => left.path.localeCompare(right.path));
  }

  private async spawn(
    parentPath: string,
    input: { taskName: string; message: string; role?: string; workspace?: AgentWorkspaceMode },
    provenance: { parentTurnId?: string; rootTurnId?: string },
  ): Promise<AgentTeamAgentView> {
    if (this.closed) throw new Error("Agent team is closed");
    if (this.draining) throw new Error("Agent team is paused for a Serve handoff");
    const taskName = typeof input.taskName === "string" ? input.taskName.trim() : "";
    if (!TASK_NAME.test(taskName)) {
      throw new Error(
        "task_name must start with a lowercase letter and contain only lowercase letters, digits, _ or - (max 48)",
      );
    }
    const message = safeText(input.message, MAX_ASSIGNMENT_CHARS, "message");
    const role = safeRole(input.role);
    const workspace = input.workspace ?? "read-only";
    if (workspace !== "read-only" && workspace !== "isolated-write") {
      throw new Error("Agent workspace must be 'read-only' or 'isolated-write'");
    }
    if (workspace === "isolated-write") this.worktreeManager();
    const path = parentPath + "/" + taskName;
    if (!AGENT_PATH.test(path) || pathDepth(path) > MAX_AGENT_DEPTH) {
      throw new Error("Agent tree depth exceeds the maximum of " + String(MAX_AGENT_DEPTH));
    }
    this.ensureLoaded();
    let createdId = "";
    this.snapshot = this.options.store.update(this.options.sessionId, (draft) => {
      if (draft.agents.length >= MAX_AGENTS) throw new Error("Agent team limit reached (" + String(MAX_AGENTS) + ")");
      if (draft.agents.some((agent) => agent.path === path)) {
        throw new Error("Agent '" + path + "' already exists; use followup_task or resume_agent");
      }
      const now = iso();
      createdId = randomUUID();
      const record: AgentTeamRecord = {
        id: createdId,
        path,
        name: taskName,
        parentPath,
        ...(provenance.parentTurnId ? { parentTurnId: provenance.parentTurnId } : {}),
        ...(provenance.rootTurnId ? { rootTurnId: provenance.rootTurnId } : {}),
        ...(role ? { role } : {}),
        status: "queued",
        generation: 1,
        assignment: message,
        instructions: [message],
        mailbox: [],
        ...(workspace === "isolated-write"
          ? { workspace: { mode: "isolated-write", state: "pending" } as AgentTeamWorkspaceRecord }
          : {}),
        createdAt: now,
        updatedAt: now,
        queuedAt: now,
      };
      draft.agents.push(record);
      this.reserveExecutionBudget(record, draft, provenance.rootTurnId);
    });
    const committed = this.current(createdId);
    this.publish(committed);
    this.launch(committed.id, false);
    return viewOf(this.current(committed.id));
  }

  private async message(
    sourcePath: string,
    target: string,
    message: string,
    kind: "message" | "followup",
    provenance: { parentTurnId?: string; rootTurnId?: string },
    commandId?: string,
  ): Promise<AgentTeamAgentView> {
    if (this.closed) throw new Error("Agent team is closed");
    if (this.draining) throw new Error("Agent team is paused for a Serve handoff");
    const content = safeText(message, MAX_MESSAGE_CHARS, "message");
    const selected = this.resolve(target);
    this.assertTargetTurn(selected, provenance);
    const stableCommandId = commandId?.trim() || randomUUID();
    if (!validProvenanceId(stableCommandId)) throw new Error("Agent mailbox command id is invalid");
    const requestHash = mailboxRequestHash({
      sourcePath,
      targetId: selected.id,
      message: content,
      kind,
      ...(provenance.parentTurnId ? { parentTurnId: provenance.parentTurnId } : {}),
      ...(provenance.rootTurnId ? { rootTurnId: provenance.rootTurnId } : {}),
    });
    let startAfterCommit = false;
    let duplicate = false;
    const updated = this.change(selected.id, (record, draft) => {
      const prior = draft.agents.flatMap((agent) => agent.mailbox)
        .find((entry) => entry.commandId === stableCommandId);
      if (prior) {
        if (prior.requestHash !== requestHash) {
          throw new Error("Agent mailbox command id was already used with a different request");
        }
        duplicate = true;
        return;
      }
      // The child can finish between target resolution and this locked update. Decide from the committed
      // record, not the earlier cache snapshot, or a follow-up arriving on that boundary can remain queued
      // forever after the generation's final pending-mailbox check has already run.
      startAfterCommit = kind === "followup" && terminal(record.status);
      if (
        startAfterCommit
        && record.workspace
        && (record.workspace.state === "applied" || record.workspace.state === "rejected")
      ) {
        throw new Error("Agent Diff is already resolved; spawn a new Agent for additional isolated changes");
      }
      if (record.instructions.length >= MAX_INSTRUCTIONS) throw new Error("Agent instruction history is full");
      if (record.mailbox.length >= MAX_MAILBOX_MESSAGES) throw new Error("Agent mailbox is full");
      const total = record.instructions.reduce((sum, item) => sum + item.length, 0) + content.length;
      if (total > MAX_TOTAL_INSTRUCTION_CHARS) {
        throw new Error("Agent instruction history exceeds the durable limit");
      }
      record.instructions.push(content);
      record.mailbox.push({
        id: randomUUID(),
        sourcePath,
        content,
        kind,
        commandId: stableCommandId,
        requestHash,
        ...(provenance.parentTurnId ? { parentTurnId: provenance.parentTurnId } : {}),
        ...(provenance.rootTurnId ? { rootTurnId: provenance.rootTurnId } : {}),
        createdAt: iso(),
        state: "pending",
        acceptedGeneration: record.generation,
      });
    });
    if (duplicate) return viewOf(updated);
    const accepted = updated.mailbox.find((entry) => entry.commandId === stableCommandId);
    if (accepted) this.publishMailbox(updated, accepted, "queued");
    if (startAfterCommit) {
      return viewOf(this.startNextGeneration(updated.id));
    }
    return viewOf(updated);
  }

  private startNextGeneration(id: string): AgentTeamRecord {
    const queued = this.change(id, (record, draft) => {
      if (!terminal(record.status)) throw new Error("Agent '" + record.path + "' is already " + record.status);
      record.generation += 1;
      record.status = "queued";
      record.queuedAt = iso();
      delete record.startedAt;
      delete record.endedAt;
      if (record.workspace) {
        record.workspace.state = "ready";
        delete record.workspace.changedPaths;
        delete record.workspace.patchBytes;
        delete record.workspace.patchSha256;
        delete record.workspace.capturedAt;
        delete record.workspace.reviewedAt;
        delete record.workspace.appliedAt;
        delete record.workspace.rejectedAt;
        delete record.workspace.error;
      }
      this.reserveExecutionBudget(record, draft, record.rootTurnId);
    });
    this.launch(id, true);
    return this.current(queued.id);
  }

  private launch(id: string, consumePendingAtStart: boolean): void {
    if (this.closed || this.draining || this.active.has(id)) return;
    const before = this.current(id);
    const generation = before.generation;
    const task = executionPrompt(before);
    const controller = new AbortController();
    const active: ActiveAgentRun = { generation, controller, promise: Promise.resolve() };
    this.active.set(id, active);
    const run = this.executeGeneration(id, generation, task, controller, consumePendingAtStart)
      .finally(() => {
        const owned = this.active.get(id);
        if (owned?.generation === generation) this.active.delete(id);
        if (!this.closed && !this.draining) {
          // A follow-up can commit the next queued generation after executeGeneration publishes the old
          // terminal state but before this finally block releases the active slot. launch() deliberately
          // refuses overlapping generations, so pick that queued generation up here once ownership clears.
          const next = this.current(id);
          if (next.status === "queued") this.launch(id, next.generation > 1);
          else this.launchPendingFollowup(id);
        }
      });
    active.promise = run;
    try {
      this.options.onRun?.(run, viewOf(this.current(id)));
    } catch {
      // Host accounting observers cannot control the child lifecycle.
    }
  }

  private async executeGeneration(
    id: string,
    generation: number,
    task: string,
    controller: AbortController,
    consumePendingAtStart: boolean,
  ): Promise<void> {
    const deliveredAtStart: string[] = [];
    const working = this.change(id, (record) => {
      if (record.generation !== generation || record.status !== "queued") {
        throw new Error("Agent '" + record.path + "' generation changed before launch");
      }
      record.status = "working";
      record.startedAt = iso();
      delete record.endedAt;
      delete record.result;
      delete record.error;
      delete record.model;
      delete record.usage;
      if (consumePendingAtStart) {
        for (const message of record.mailbox) {
          if (message.state !== "pending") continue;
          message.state = "delivered";
          message.deliveredGeneration = generation;
          deliveredAtStart.push(message.id);
        }
      }
    });
    for (const messageId of deliveredAtStart) {
      const message = working.mailbox.find((entry) => entry.id === messageId);
      if (!message) continue;
      this.publishMailbox(working, message, "started");
      this.publishMailbox(working, message, "completed");
    }
    let result: AgentTeamExecutionResult | undefined;
    let treeLimitReached = false;
    let workspaceBinding: AgentWorktreeBinding | undefined;
    const executionBudget = working.executionBudget;
    if (!executionBudget) throw new Error("Agent generation has no reserved execution budget");
    if (working.workspace) {
      try {
        const manager = this.worktreeManager();
        if (working.workspace.workspaceId) manager.assertWorkspaceId(id, working.workspace.workspaceId);
        workspaceBinding = manager.prepare(id, working.workspace.baseCommit);
        this.change(id, (record) => {
          if (record.generation !== generation || !record.workspace) return;
          record.workspace.workspaceId = workspaceBinding!.workspaceId;
          record.workspace.baseCommit = workspaceBinding!.baseCommit;
          if (record.workspace.state === "pending" || record.workspace.state === "error") {
            record.workspace.state = "ready";
          }
          delete record.workspace.error;
        });
      } catch (error) {
        const safe = redactSensitiveText(error instanceof Error ? error.message : String(error)).text.slice(0, 1_000);
        this.change(id, (record) => {
          if (!record.workspace) return;
          record.workspace.state = "error";
          record.workspace.error = safe || "Agent worktree preparation failed";
        });
        result = { status: "error", text: "", error: safe || "Agent worktree preparation failed" };
      }
    }
    if (!result) try {
      const observed = Promise.resolve(this.options.executor({
        id,
        path: working.path,
        parentPath: working.parentPath,
        ...(working.role ? { role: working.role } : {}),
        generation,
        task,
        signal: controller.signal,
        controller: this.controller(working.path, {
          parentTurnId: working.id + ":" + String(generation),
          ...(working.rootTurnId ? { rootTurnId: working.rootTurnId } : {}),
        }),
        pendingInput: () => this.drainMailbox(id, generation),
        budget: {
          maxProviderRounds: executionBudget.maxProviderRounds,
          maxToolCalls: executionBudget.maxToolCalls,
          maxTokens: executionBudget.maxTokens,
          timeoutMs: executionBudget.timeoutMs,
        },
        reportProgress: (metrics) => {
          const withinLimit = this.reportGenerationProgress(id, generation, metrics);
          if (!withinLimit) {
            treeLimitReached = true;
            controller.abort(new Error("Agent tree execution budget reached"));
          }
          return withinLimit;
        },
        ...(workspaceBinding ? {
          workspace: {
            mode: "isolated-write",
            cwd: workspaceBinding.cwd,
            sourceCwd: this.worktreeManager().sourceCwd,
            writeBoundary: workspaceBinding.path,
          },
        } : {}),
      }));
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<AgentTeamExecutionResult>((resolve) => {
        deadlineTimer = setTimeout(() => {
          treeLimitReached = true;
          controller.abort(new Error("Agent tree active-execution deadline reached"));
          resolve({
            status: "halted",
            text: "",
            error: "Agent tree active-execution deadline reached.",
          });
        }, executionBudget.timeoutMs);
        deadlineTimer.unref?.();
      });
      try {
        result = await Promise.race([observed, deadline]);
      } finally {
        if (deadlineTimer) clearTimeout(deadlineTimer);
        void observed.catch(() => {});
      }
    } catch (error) {
      result = {
        status: controller.signal.aborted ? "cancelled" : "error",
        text: "",
        error: redactSensitiveText(error instanceof Error ? error.message : String(error)).text
          .slice(0, MAX_RESULT_CHARS),
      };
    }
    if (workspaceBinding) {
      try {
        const diff = this.worktreeManager().capture(id, workspaceBinding.baseCommit);
        this.recordWorkspaceDiff(id, generation, diff);
      } catch (error) {
        const safe = redactSensitiveText(error instanceof Error ? error.message : String(error)).text.slice(0, 1_000);
        this.change(id, (record) => {
          if (record.generation !== generation || !record.workspace) return;
          record.workspace.state = "error";
          record.workspace.error = safe || "Agent Diff capture failed";
        });
        if (result.status === "completed") {
          result = { ...result, status: "error", text: "", error: safe || "Agent Diff capture failed" };
        }
      }
    }
    if (!result) throw new Error("Agent generation ended without a result");
    if (result.metrics) {
      treeLimitReached = !this.reportGenerationProgress(id, generation, result.metrics) || treeLimitReached;
    } else if (result.usage) {
      const current = this.current(id).executionBudget;
      if (current) {
        treeLimitReached = !this.reportGenerationProgress(id, generation, {
          providerRounds: current.providerRounds,
          toolCalls: current.toolCalls,
          inputTokens: Math.max(current.inputTokens, Math.floor(result.usage.input)),
          outputTokens: Math.max(current.outputTokens, Math.floor(result.usage.output)),
        }) || treeLimitReached;
      }
    }
    this.change(id, (record) => {
      if (record.generation !== generation) return;
      const cancelled =
        controller.signal.aborted
        || record.status === "stopping"
        || result.status === "cancelled";
      record.status = cancelled ? "cancelled" : result.status === "completed" && !treeLimitReached ? "completed" : "failed";
      record.endedAt = iso();
      const model = safeResultText(result.model, 512);
      if (model) record.model = model;
      if (result.usage && validUsage(result.usage)) record.usage = { ...result.usage };
      const output = safeResultText(result.text, MAX_RESULT_CHARS);
      const error = safeResultText(result.error, MAX_RESULT_CHARS);
      if (output) record.result = output;
      else delete record.result;
      if (cancelled) record.error = treeLimitReached
        ? "Agent tree execution budget was reached before completion."
        : "Agent was interrupted before completion.";
      else if (treeLimitReached) record.error = "Agent tree execution budget was reached before completion.";
      else if (error) record.error = error;
      else if (result.status !== "completed") record.error = "Agent ended with status " + result.status + ".";
      else delete record.error;
    });
  }

  private async drainMailbox(id: string, generation: number): Promise<AgentMailboxDelivery[]> {
    const deliveries: AgentMailboxDelivery[] = [];
    const deliveredIds: string[] = [];
    const updated = this.change(id, (record) => {
      if (record.generation !== generation || record.status !== "working") return;
      for (const message of record.mailbox) {
        if (message.state !== "pending") continue;
        message.state = "delivered";
        message.deliveredGeneration = generation;
        deliveredIds.push(message.id);
        deliveries.push({
          id: message.id,
          sourcePath: message.sourcePath,
          content: message.content,
          kind: message.kind,
        });
      }
    });
    for (const messageId of deliveredIds) {
      const message = updated.mailbox.find((entry) => entry.id === messageId);
      if (!message) continue;
      this.publishMailbox(updated, message, "started");
      this.publishMailbox(updated, message, "completed");
    }
    return deliveries;
  }

  private recordWorkspaceDiff(
    id: string,
    generation: number,
    diff: AgentWorktreeDiff,
    reviewed = false,
  ): AgentTeamRecord {
    return this.change(id, (record) => {
      if (record.generation !== generation || !record.workspace) return;
      if (diff.ownerAgentId !== record.id) throw new Error("Agent Diff owner changed during capture");
      this.worktreeManager().assertWorkspaceId(record.id, diff.workspaceId);
      record.workspace = {
        mode: "isolated-write",
        state: diff.patchBytes > 0 ? "changes" : "ready",
        workspaceId: diff.workspaceId,
        baseCommit: diff.baseCommit,
        changedPaths: [...diff.changedPaths],
        patchBytes: diff.patchBytes,
        patchSha256: diff.patchSha256,
        capturedAt: iso(),
        ...(reviewed ? { reviewedAt: iso() } : {}),
      };
    });
  }

  private async inspectDiff(
    target: string,
    provenance: { rootTurnId?: string } = {},
  ): Promise<AgentTeamDiffView> {
    const selected = this.resolve(target);
    this.assertTargetTurn(selected, provenance);
    if (!terminal(selected.status)) throw new Error("Agent Diff can be inspected only after its generation settles");
    if (!selected.workspace?.workspaceId || !selected.workspace.baseCommit) {
      throw new Error("Agent has no isolated writable workspace");
    }
    this.worktreeManager().assertWorkspaceId(selected.id, selected.workspace.workspaceId);
    const diff = this.worktreeManager().capture(selected.id, selected.workspace.baseCommit);
    const resolved = selected.workspace.state === "applied" || selected.workspace.state === "rejected";
    if (
      resolved
      && selected.workspace.patchSha256
      && selected.workspace.patchSha256 !== diff.patchSha256
    ) {
      throw new Error("resolved Agent worktree changed afterward; its old Diff will not be silently replaced");
    }
    const updated = resolved
      ? selected
      : this.recordWorkspaceDiff(selected.id, selected.generation, diff, true);
    if (!updated.workspace) throw new Error("Agent workspace disappeared during Diff inspection");
    return {
      ...workspaceViewOf(updated.workspace),
      agentId: selected.id,
      agentPath: selected.path,
      patch: diff.patch,
    };
  }

  private async applyDiff(
    target: string,
    provenance: { rootTurnId?: string } = {},
  ): Promise<AgentTeamWorkspaceView> {
    const selected = this.resolve(target);
    this.assertTargetTurn(selected, provenance);
    if (!terminal(selected.status)) throw new Error("Agent Diff cannot be applied while its Agent is active");
    const workspace = selected.workspace;
    if (
      !workspace
      || (workspace.state !== "changes" && workspace.state !== "applying")
      || !workspace.workspaceId
      || !workspace.baseCommit
      || !workspace.patchSha256
    ) throw new Error("Agent has no reviewed, unresolved Diff to apply");
    if (!workspace.reviewedAt) {
      throw new Error("Inspect the current Agent Diff before requesting its application");
    }
    this.worktreeManager().assertWorkspaceId(selected.id, workspace.workspaceId);
    if (workspace.state === "changes") {
      this.change(selected.id, (record) => {
        if (!record.workspace || record.workspace.patchSha256 !== workspace.patchSha256) {
          throw new Error("Agent Diff changed before apply intent was saved");
        }
        record.workspace.state = "applying";
        delete record.workspace.error;
      });
    }
    try {
      this.worktreeManager().apply(selected.id, workspace.baseCommit, workspace.patchSha256);
    } catch (error) {
      const safe = redactSensitiveText(error instanceof Error ? error.message : String(error)).text.slice(0, 1_000);
      this.change(selected.id, (record) => {
        if (!record.workspace || record.workspace.patchSha256 !== workspace.patchSha256) return;
        record.workspace.state = "changes";
        record.workspace.error = safe || "Agent Diff application failed";
        delete record.workspace.reviewedAt;
      });
      throw error;
    }
    const updated = this.change(selected.id, (record) => {
      if (!record.workspace || record.workspace.patchSha256 !== workspace.patchSha256) {
        throw new Error("Agent Diff changed during apply");
      }
      record.workspace.state = "applied";
      record.workspace.appliedAt = iso();
      delete record.workspace.error;
    });
    return workspaceViewOf(updated.workspace!);
  }

  private async rejectDiff(
    target: string,
    provenance: { rootTurnId?: string } = {},
  ): Promise<AgentTeamWorkspaceView> {
    const selected = this.resolve(target);
    this.assertTargetTurn(selected, provenance);
    if (!terminal(selected.status)) throw new Error("Agent Diff cannot be rejected while its Agent is active");
    if (!selected.workspace || selected.workspace.state !== "changes") {
      throw new Error("Agent has no unresolved Diff to reject");
    }
    const updated = this.change(selected.id, (record) => {
      if (!record.workspace || record.workspace.state !== "changes") {
        throw new Error("Agent Diff changed during rejection");
      }
      record.workspace.state = "rejected";
      record.workspace.rejectedAt = iso();
      delete record.workspace.error;
    });
    return workspaceViewOf(updated.workspace!);
  }

  private launchPendingFollowup(id: string): void {
    let record: AgentTeamRecord;
    try {
      record = this.current(id);
    } catch {
      return;
    }
    if (!terminal(record.status)) return;
    if (!record.mailbox.some((message) => message.state === "pending" && message.kind === "followup")) return;
    this.startNextGeneration(id);
  }

  private async interrupt(target: string, provenance: { rootTurnId?: string } = {}): Promise<AgentTeamAgentView> {
    const selected = this.resolve(target);
    this.assertTargetTurn(selected, provenance);
    if (terminal(selected.status)) return viewOf(selected);
    const updated = this.change(selected.id, (record) => {
      if (record.status === "queued" || record.status === "working") record.status = "stopping";
    });
    this.active.get(selected.id)?.controller.abort(new Error("Agent interrupted by its parent"));
    return viewOf(updated);
  }

  private async resume(target: string, provenance: { rootTurnId?: string } = {}): Promise<AgentTeamAgentView> {
    if (this.closed) throw new Error("Agent team is closed");
    if (this.draining) throw new Error("Agent team is paused for a Serve handoff");
    const selected = this.resolve(target);
    this.assertTargetTurn(selected, provenance);
    if (selected.status !== "interrupted") {
      throw new Error(
        "Agent '" + selected.path + "' is " + selected.status
        + "; only an interrupted Agent can be resumed",
      );
    }
    return viewOf(this.startNextGeneration(selected.id));
  }

  private async wait(target: string, timeoutMs = 30_000): Promise<AgentTeamWaitResult> {
    const selected = this.resolve(target);
    const numericTimeout = Number.isFinite(timeoutMs) ? Math.floor(timeoutMs) : 30_000;
    const boundedTimeout = Math.max(0, Math.min(MAX_WAIT_MS, numericTimeout));
    const active = this.active.get(selected.id);
    if (active && boundedTimeout > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        active.promise.catch(() => {}),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, boundedTimeout);
          timer.unref?.();
        }),
      ]);
      if (timer) clearTimeout(timer);
    }
    const current = this.current(selected.id);
    const settled = terminal(current.status);
    return {
      agent: viewOf(current),
      settled,
      ...(settled && current.result ? { result: current.result } : {}),
      ...(settled && current.error ? { error: current.error } : {}),
    };
  }

  isQuiescent(): boolean {
    return this.active.size === 0;
  }

  /** Stop every live descendant and wait for its executor Promise to settle. A timeout is reported as
   * false and the tree remains draining, so the old Serve owner can never launch another generation while
   * a migration is unresolved. */
  async interruptAllAndWait(timeoutMs = 10_000): Promise<boolean> {
    this.draining = true;
    this.ensureLoaded();
    const runs = [...this.active.entries()];
    for (const [id, active] of runs) {
      try {
        this.change(id, (record) => {
          if (
            record.generation === active.generation
            && (record.status === "queued" || record.status === "working")
          ) record.status = "stopping";
        });
      } finally {
        active.controller.abort(new Error("Hara Serve is pausing this Agent tree"));
      }
    }
    if (runs.length === 0) return true;
    const boundedTimeout = Math.max(0, Math.min(MAX_WAIT_MS, Math.floor(timeoutMs)));
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled(runs.map(([, active]) => active.promise)),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, boundedTimeout);
      }),
    ]);
    if (timer) clearTimeout(timer);
    return this.active.size === 0;
  }

  close(): void {
    if (this.closed) return;
    this.draining = true;
    this.closed = true;
    this.ensureLoaded();
    for (const [id, active] of this.active) {
      try {
        this.change(id, (record) => {
          if (
            record.generation === active.generation
            && (record.status === "queued" || record.status === "working")
          ) record.status = "stopping";
        });
      } finally {
        active.controller.abort(new Error("Hara Agent team is shutting down"));
      }
    }
  }

  removeStoredState(): boolean {
    if (this.active.size) throw new Error("cannot remove an Agent team while children are active");
    this.ensureLoaded();
    const isolated = this.snapshot!.agents.filter((record) => record.workspace?.mode === "isolated-write");
    if (isolated.length) {
      const manager = this.worktreeManager();
      for (const record of isolated) manager.remove(record.id, record.workspace?.workspaceId);
    }
    const removed = this.options.store.remove(this.options.sessionId);
    this.snapshot = undefined;
    return removed;
  }
}
