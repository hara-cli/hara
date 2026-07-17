import { homedir } from "node:os";
import { isAbsolute, relative, sep } from "node:path";
import { canonicalProjectPath } from "../org/projects.js";
import {
  latestForCwd,
  loadSession,
  resolveSessionId,
  sessionFileExists,
  type SessionMeta,
} from "./store.js";

export type SessionResumeResolution =
  | { ok: true; id: string; cwd: string; meta: SessionMeta }
  | {
      ok: false;
      reason: "not-found" | "no-current" | "unreadable" | "cwd-unavailable";
      id?: string;
      cwd?: string;
    };

/**
 * Resolve the execution root before relaunching an interactive session.
 *
 * The low-level `--resume` path still rejects a foreign cwd. This resolver is for the explicit,
 * user-facing `hara resume <id>` transition: it binds the attached child to the session's persisted
 * project root so invoking the command from another directory cannot reinterpret the transcript there.
 */
export function resolveSessionResumeTarget(
  idOrPrefix: string | undefined,
  currentCwd: string,
): SessionResumeResolution {
  let id: string | undefined;
  if (idOrPrefix) {
    id = resolveSessionId(idOrPrefix) ?? undefined;
    if (!id) return { ok: false, reason: "not-found" };
  } else {
    const latest = latestForCwd(currentCwd);
    if (!latest) return { ok: false, reason: "no-current" };
    id = latest.meta.id;
  }

  const session = loadSession(id);
  if (!session) {
    return {
      ok: false,
      reason: sessionFileExists(id) ? "unreadable" : "not-found",
      id,
    };
  }

  const cwd = canonicalProjectPath(session.meta.cwd, true);
  if (!cwd) {
    return {
      ok: false,
      reason: "cwd-unavailable",
      id,
      cwd: session.meta.cwd,
    };
  }
  return { ok: true, id, cwd, meta: session.meta };
}

/** Compact a persisted absolute project path for session lists without losing its identity. */
export function displaySessionCwd(cwd: string, home = homedir()): string {
  const rel = relative(home, cwd);
  if (rel === "") return "~";
  if (rel && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel)) return `~${sep}${rel}`;
  return cwd;
}
