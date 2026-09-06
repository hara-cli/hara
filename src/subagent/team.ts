import { randomUUID } from "node:crypto";
import {
  bindPrivateHaraStateFile,
  readPrivateStateFileSnapshotSync,
  removePrivateStateFile,
  withPrivateStateLockSync,
  writePrivateStateFileSync,
} from "../security/private-state.js";
import { redactSensitiveText } from "../security/secrets.js";
import { validSessionId } from "../session/store.js";

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

export interface AgentMailboxDelivery {
  id: string;
  sourcePath: string;
  content: string;
  kind: "message" | "followup";
}

interface AgentMailboxMessage extends AgentMailboxDelivery {
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
}

interface AgentTeamSnapshot {
  version: typeof TEAM_VERSION;
  sessionId: string;
  revision: number;
  updatedAt: string;
  agents: AgentTeamRecord[];
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
}

export interface AgentTeamController {
  readonly path: string;
  spawn(input: { taskName: string; message: string; role?: string }): Promise<AgentTeamAgentView>;
  sendMessage(target: string, message: string): Promise<AgentTeamAgentView>;
  followup(target: string, message: string): Promise<AgentTeamAgentView>;
  interrupt(target: string): Promise<AgentTeamAgentView>;
  resume(target: string): Promise<AgentTeamAgentView>;
  list(): AgentTeamAgentView[];
  wait(target: string, timeoutMs?: number): Promise<AgentTeamWaitResult>;
}

export interface DurableAgentTeamOptions {
  sessionId: string;
  store: AgentTeamStore;
  executor: (request: AgentTeamExecutionRequest) => Promise<AgentTeamExecutionResult>;
  onChange?: (agent: AgentTeamAgentView) => void;
  onRun?: (run: Promise<void>, agent: AgentTeamAgentView) => void;
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

/** Durable Codex-style Agent tree. Children are still read-only; stable identities, mailbox state and
 * terminal results survive host restarts without pretending an abandoned process is still live. */
export class DurableAgentTeam {
  private snapshot?: AgentTeamSnapshot;
  private readonly active = new Map<string, ActiveAgentRun>();
  private closed = false;

  constructor(private readonly options: DurableAgentTeamOptions) {
    if (!validSessionId(options.sessionId)) throw new Error("invalid Agent team session id");
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
    return {
      path,
      spawn: (input) => this.spawn(path, input, provenance),
      sendMessage: (target, message) => this.message(path, target, message, "message"),
      followup: (target, message) => this.message(path, target, message, "followup"),
      interrupt: (target) => this.interrupt(target),
      resume: (target) => this.resume(target),
      list: () => this.list(),
      wait: (target, timeoutMs) => this.wait(target, timeoutMs),
    };
  }

  list(): AgentTeamAgentView[] {
    this.ensureLoaded();
    return this.snapshot!.agents.map(viewOf).sort((left, right) => left.path.localeCompare(right.path));
  }

  private async spawn(
    parentPath: string,
    input: { taskName: string; message: string; role?: string },
    provenance: { parentTurnId?: string; rootTurnId?: string },
  ): Promise<AgentTeamAgentView> {
    if (this.closed) throw new Error("Agent team is closed");
    const taskName = typeof input.taskName === "string" ? input.taskName.trim() : "";
    if (!TASK_NAME.test(taskName)) {
      throw new Error(
        "task_name must start with a lowercase letter and contain only lowercase letters, digits, _ or - (max 48)",
      );
    }
    const message = safeText(input.message, MAX_ASSIGNMENT_CHARS, "message");
    const role = safeRole(input.role);
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
      draft.agents.push({
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
        createdAt: now,
        updatedAt: now,
        queuedAt: now,
      });
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
  ): Promise<AgentTeamAgentView> {
    if (this.closed) throw new Error("Agent team is closed");
    const content = safeText(message, MAX_MESSAGE_CHARS, "message");
    const selected = this.resolve(target);
    let startAfterCommit = false;
    const updated = this.change(selected.id, (record) => {
      // The child can finish between target resolution and this locked update. Decide from the committed
      // record, not the earlier cache snapshot, or a follow-up arriving on that boundary can remain queued
      // forever after the generation's final pending-mailbox check has already run.
      startAfterCommit = kind === "followup" && terminal(record.status);
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
        createdAt: iso(),
        state: "pending",
        acceptedGeneration: record.generation,
      });
    });
    if (startAfterCommit) {
      return viewOf(this.startNextGeneration(updated.id));
    }
    return viewOf(updated);
  }

  private startNextGeneration(id: string): AgentTeamRecord {
    const queued = this.change(id, (record) => {
      if (!terminal(record.status)) throw new Error("Agent '" + record.path + "' is already " + record.status);
      record.generation += 1;
      record.status = "queued";
      record.queuedAt = iso();
      delete record.startedAt;
      delete record.endedAt;
    });
    this.launch(id, true);
    return this.current(queued.id);
  }

  private launch(id: string, consumePendingAtStart: boolean): void {
    if (this.closed || this.active.has(id)) return;
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
        if (!this.closed) {
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
        }
      }
    });
    let result: AgentTeamExecutionResult;
    try {
      result = await this.options.executor({
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
      });
    } catch (error) {
      result = {
        status: controller.signal.aborted ? "cancelled" : "error",
        text: "",
        error: redactSensitiveText(error instanceof Error ? error.message : String(error)).text
          .slice(0, MAX_RESULT_CHARS),
      };
    }
    this.change(id, (record) => {
      if (record.generation !== generation) return;
      const cancelled =
        controller.signal.aborted
        || record.status === "stopping"
        || result.status === "cancelled";
      record.status = cancelled ? "cancelled" : result.status === "completed" ? "completed" : "failed";
      record.endedAt = iso();
      const model = safeResultText(result.model, 512);
      if (model) record.model = model;
      if (result.usage && validUsage(result.usage)) record.usage = { ...result.usage };
      const output = safeResultText(result.text, MAX_RESULT_CHARS);
      const error = safeResultText(result.error, MAX_RESULT_CHARS);
      if (output) record.result = output;
      else delete record.result;
      if (cancelled) record.error = "Agent was interrupted before completion.";
      else if (error) record.error = error;
      else if (result.status !== "completed") record.error = "Agent ended with status " + result.status + ".";
      else delete record.error;
    });
  }

  private async drainMailbox(id: string, generation: number): Promise<AgentMailboxDelivery[]> {
    const deliveries: AgentMailboxDelivery[] = [];
    this.change(id, (record) => {
      if (record.generation !== generation || record.status !== "working") return;
      for (const message of record.mailbox) {
        if (message.state !== "pending") continue;
        message.state = "delivered";
        message.deliveredGeneration = generation;
        deliveries.push({
          id: message.id,
          sourcePath: message.sourcePath,
          content: message.content,
          kind: message.kind,
        });
      }
    });
    return deliveries;
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

  private async interrupt(target: string): Promise<AgentTeamAgentView> {
    const selected = this.resolve(target);
    if (terminal(selected.status)) return viewOf(selected);
    const updated = this.change(selected.id, (record) => {
      if (record.status === "queued" || record.status === "working") record.status = "stopping";
    });
    this.active.get(selected.id)?.controller.abort(new Error("Agent interrupted by its parent"));
    return viewOf(updated);
  }

  private async resume(target: string): Promise<AgentTeamAgentView> {
    if (this.closed) throw new Error("Agent team is closed");
    const selected = this.resolve(target);
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

  close(): void {
    if (this.closed) return;
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
    this.snapshot = undefined;
    return this.options.store.remove(this.options.sessionId);
  }
}
