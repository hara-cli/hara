// Session persistence — conversations saved as JSON under ~/.hara/sessions, resumable.
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { NeutralMsg } from "../providers/types.js";

export interface SessionMeta {
  id: string;
  cwd: string;
  provider: string;
  model: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}
export interface SessionData {
  meta: SessionMeta;
  history: NeutralMsg[];
}

function sessionsDir(): string {
  const d = join(homedir(), ".hara", "sessions");
  mkdirSync(d, { recursive: true });
  return d;
}
const sessionFile = (id: string) => join(sessionsDir(), `${id}.json`);

export const newSessionId = (): string => randomUUID().slice(0, 8);

export function titleFrom(history: NeutralMsg[]): string {
  const firstUser = history.find((h) => h.role === "user");
  const t = firstUser && firstUser.role === "user" ? firstUser.content : "session";
  return t.replace(/\s+/g, " ").trim().slice(0, 60) || "session";
}

export function saveSession(meta: SessionMeta, history: NeutralMsg[]): void {
  meta.updatedAt = new Date().toISOString();
  const data: SessionData = { meta, history };
  writeFileSync(sessionFile(meta.id), JSON.stringify(data, null, 2), "utf8");
}

export function loadSession(id: string): SessionData | null {
  const p = sessionFile(id);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as SessionData;
  } catch {
    return null;
  }
}

/** Session metas, newest first; optionally filtered to a cwd. */
export function listSessions(cwd?: string): SessionMeta[] {
  let metas: SessionMeta[] = [];
  for (const f of readdirSync(sessionsDir())) {
    if (!f.endsWith(".json")) continue;
    try {
      metas.push((JSON.parse(readFileSync(join(sessionsDir(), f), "utf8")) as SessionData).meta);
    } catch {
      /* skip corrupt */
    }
  }
  if (cwd) metas = metas.filter((m) => m.cwd === cwd);
  return metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function latestForCwd(cwd: string): SessionData | null {
  const [m] = listSessions(cwd);
  return m ? loadSession(m.id) : null;
}
