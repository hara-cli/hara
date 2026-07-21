import { canonicalProjectPath } from "../org/projects.js";
import { forkTaskExecution } from "./task.js";
import {
  acquireSessionLock,
  latestForCwd,
  newSessionId,
  releaseSessionLock,
  saveSession,
  type SessionData,
  type SessionMeta,
} from "./store.js";

export const RECENT_WORKSPACE_TRANSFER_MS = 30 * 60 * 1000;

/** Find the recent interactive thread a direct `hara --cwd …` launch would otherwise leave behind.
 * This is deliberately narrow: automated/archived/empty/old sessions never trigger an interactive prompt. */
export function recentWorkspaceTransferCandidate(
  launchCwd: string,
  targetCwd: string,
  at: Date | string = new Date(),
): SessionData | null {
  const source = canonicalProjectPath(launchCwd, true);
  const target = canonicalProjectPath(targetCwd, true);
  if (!source || !target || source === target) return null;
  const session = latestForCwd(source);
  if (!session || session.meta.archived || (session.meta.source && session.meta.source !== "interactive")) return null;
  if (session.history.length === 0) return null;
  const now = typeof at === "string" ? Date.parse(at) : at.getTime();
  const updated = Date.parse(session.meta.updatedAt);
  const age = now - updated;
  if (!Number.isFinite(now) || !Number.isFinite(updated) || age < 0 || age > RECENT_WORKSPACE_TRANSFER_MS) return null;
  return session;
}

/** Copy a conversation into another workspace without mutating or re-routing its source session.
 * A new identity is required because one session id is permanently bound to one canonical project root. */
export function workspaceSessionFork(
  source: SessionData,
  targetCwd: string,
  at: Date | string = new Date(),
): SessionData {
  const target = canonicalProjectPath(targetCwd, true);
  if (!target) throw new Error(`target workspace is unavailable: ${targetCwd}`);
  const now = typeof at === "string" ? at : at.toISOString();
  if (!Number.isFinite(Date.parse(now))) throw new Error("workspace transfer timestamp is invalid");

  const meta: SessionMeta = structuredClone(source.meta);
  meta.id = newSessionId();
  meta.cwd = target;
  meta.createdAt = now;
  meta.updatedAt = "";
  meta.source = "interactive";
  delete meta.sourceName;
  delete meta.archived;
  delete meta.gatewayOwner;

  const task = forkTaskExecution(source.task, now);
  return {
    meta,
    history: structuredClone(source.history),
    ...(task ? { task } : {}),
  };
}

/** Persist a workspace fork under its own short-lived lock so the relaunched child can safely resume it. */
export function persistWorkspaceSessionFork(
  source: SessionData,
  targetCwd: string,
  at: Date | string = new Date(),
): SessionData {
  const fork = workspaceSessionFork(source, targetCwd, at);
  const lock = acquireSessionLock(fork.meta.id);
  if (!lock.ok) throw new Error("could not reserve the transferred session id");
  try {
    saveSession(fork.meta, fork.history, fork.task);
    return fork;
  } finally {
    releaseSessionLock(fork.meta.id);
  }
}
