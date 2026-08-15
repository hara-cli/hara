import type { SubagentLifecycleEvent } from "../subagent/runtime.js";
import type { TaskLifecycleEvent } from "./task-events.js";

export const WORKFORCE_STATE_EVENT_VERSION = 1;
export const WORKFORCE_ACTOR_LIMIT = 24;

export type WorkforceActorKind = "root" | "subagent" | "external";
export type WorkforceCapability =
  | "orchestration"
  | "files"
  | "code"
  | "browser"
  | "research"
  | "design"
  | "office"
  | "communication"
  | "other";
export type WorkforceActorState =
  | "queued"
  | "working"
  | "waiting"
  | "paused"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";
export type WorkforceActivity =
  | "planning"
  | "reading"
  | "writing"
  | "running"
  | "reviewing"
  | "awaiting_approval"
  | "delivering"
  | "idle";

export interface WorkforceActor {
  actorId: string;
  parentActorId?: string;
  kind: WorkforceActorKind;
  role?: string;
  capability: WorkforceCapability;
  state: WorkforceActorState;
  activity: WorkforceActivity;
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
}

export interface WorkforceStateEventV1 {
  version: typeof WORKFORCE_STATE_EVENT_VERSION;
  streamId: string;
  sequence: number;
  sessionId: string;
  taskId: string;
  turnId: string;
  mode: "snapshot";
  actors: WorkforceActor[];
}

interface SessionWorkforce {
  taskId: string;
  turnId: string;
  rootId: string;
  actors: Map<string, WorkforceActor>;
}

const capabilityPatterns: readonly [WorkforceCapability, RegExp][] = [
  ["code", /(?:^|[._-])(code|coding|developer|dev|engineer|implement|review)(?:$|[._-])/i],
  ["browser", /(?:^|[._-])(browser|web|computer|chrome)(?:$|[._-])/i],
  ["research", /(?:^|[._-])(research|explore|search|scout|analyst)(?:$|[._-])/i],
  ["design", /(?:^|[._-])(design|ux|ui|visual|creative)(?:$|[._-])/i],
  ["office", /(?:^|[._-])(office|presentation|slides|ppt|document|sheet|excel)(?:$|[._-])/i],
  ["communication", /(?:^|[._-])(communicate|message|feishu|lark|email|support)(?:$|[._-])/i],
  ["files", /(?:^|[._-])(file|filesystem|reader|writer)(?:$|[._-])/i],
];

function safeRole(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized || normalized.length > 80 || !/^[A-Za-z0-9._-]+$/.test(normalized)) return undefined;
  return normalized;
}

export function capabilityForRole(role: string | undefined): WorkforceCapability {
  const safe = safeRole(role);
  if (!safe) return "other";
  return capabilityPatterns.find(([, pattern]) => pattern.test(safe))?.[0] ?? "other";
}

function rootState(state: TaskLifecycleEvent["state"]): WorkforceActorState {
  return state === "running" ? "working" : state;
}

function rootActivity(event: TaskLifecycleEvent): WorkforceActivity {
  if (event.state === "waiting" || event.phase === "approval") return "awaiting_approval";
  if (event.state === "paused" || event.state === "blocked") return "idle";
  if (event.state === "completed" || event.phase === "responding" || event.phase === "finished") return "delivering";
  if (event.phase === "tool") return "running";
  if (event.phase === "checkpoint") return "reviewing";
  return "planning";
}

function childState(state: SubagentLifecycleEvent["state"]): WorkforceActorState {
  return state === "failed" ? "failed" : state;
}

function childActivity(state: SubagentLifecycleEvent["state"]): WorkforceActivity {
  if (state === "queued") return "idle";
  if (state === "working") return "running";
  if (state === "completed") return "delivering";
  return "idle";
}

/** In-memory, process-scoped projection for Desktop status surfaces. It never receives sub-agent task
 * text or tool payloads, and rejects late events from a superseded turn. */
export class WorkforceStateLedger {
  private readonly sessions = new Map<string, SessionWorkforce>();
  private sequence = 0;

  constructor(private readonly streamId: string) {
    if (!streamId.trim() || streamId.length > 128) {
      throw new Error("workforce streamId must contain 1-128 characters");
    }
  }

  recordTask(event: TaskLifecycleEvent): WorkforceStateEventV1 {
    const previous = this.sessions.get(event.sessionId);
    const rootId = `root:${event.sessionId}`;
    const current: SessionWorkforce = previous?.turnId === event.turnId
      ? previous
      : { taskId: event.taskId, turnId: event.turnId, rootId, actors: new Map() };
    const priorRoot = current.actors.get(rootId);
    current.taskId = event.taskId;
    current.turnId = event.turnId;
    current.actors.set(rootId, {
      actorId: rootId,
      kind: "root",
      role: "orchestrator",
      capability: "orchestration",
      state: rootState(event.state),
      activity: rootActivity(event),
      startedAt: priorRoot?.startedAt ?? event.at,
      updatedAt: event.at,
      ...(event.state === "completed" || event.state === "blocked" ? { endedAt: event.at } : {}),
    });
    this.sessions.set(event.sessionId, current);
    return this.snapshot(event.sessionId, current);
  }

  recordSubagent(
    sessionId: string,
    taskId: string,
    turnId: string,
    event: SubagentLifecycleEvent,
  ): WorkforceStateEventV1 | null {
    const current = this.sessions.get(sessionId);
    if (!current || current.taskId !== taskId || current.turnId !== turnId) return null;
    const role = safeRole(event.role);
    const prior = current.actors.get(event.id);
    if (!prior && current.actors.size >= WORKFORCE_ACTOR_LIMIT) {
      const retired = [...current.actors.values()]
        .filter((actor) => actor.kind !== "root" && actor.endedAt)
        .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))[0];
      if (!retired) return null;
      current.actors.delete(retired.actorId);
    }
    const updatedAt = event.endedAt ?? event.startedAt ?? event.queuedAt;
    current.actors.set(event.id, {
      actorId: event.id,
      parentActorId: current.rootId,
      kind: "subagent",
      ...(role ? { role } : {}),
      capability: capabilityForRole(role),
      state: childState(event.state),
      activity: childActivity(event.state),
      startedAt: prior?.startedAt ?? event.startedAt ?? event.queuedAt,
      updatedAt,
      ...(event.endedAt ? { endedAt: event.endedAt } : {}),
    });
    return this.snapshot(sessionId, current);
  }

  forget(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  private snapshot(sessionId: string, current: SessionWorkforce): WorkforceStateEventV1 {
    this.sequence += 1;
    if (!Number.isSafeInteger(this.sequence)) throw new Error("workforce event sequence exhausted");
    const actors = [...current.actors.values()]
      .sort((left, right) => {
        if (left.kind === "root") return -1;
        if (right.kind === "root") return 1;
        return left.startedAt.localeCompare(right.startedAt) || left.actorId.localeCompare(right.actorId);
      })
      .slice(0, WORKFORCE_ACTOR_LIMIT)
      .map((actor) => ({ ...actor }));
    return {
      version: WORKFORCE_STATE_EVENT_VERSION,
      streamId: this.streamId,
      sequence: this.sequence,
      sessionId,
      taskId: current.taskId,
      turnId: current.turnId,
      mode: "snapshot",
      actors,
    };
  }
}
