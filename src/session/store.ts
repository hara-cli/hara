// Session persistence — conversations saved as JSON under ~/.hara/sessions, resumable.
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { NeutralMsg } from "../providers/types.js";

/** Who created a session. Absent = legacy/interactive. Drives UI segregation (desktop: automated
 *  sessions render as a status timeline, never mixed into the manual list) and the title strategy
 *  (automated sessions get "name · time", NEVER the raw prompt). */
export type SessionSource = "interactive" | "gateway" | "cron";

/** Derive the session source from the spawn environment — the gateway subprocess runs with
 *  HARA_GATEWAY=<platform>, the cron runner with HARA_CRON=1 (+ HARA_CRON_NAME=<job name>). */
export function sessionSourceFromEnv(): { source: SessionSource; sourceName?: string } {
  if (process.env.HARA_CRON) return { source: "cron", sourceName: process.env.HARA_CRON_NAME || undefined };
  if (process.env.HARA_GATEWAY) return { source: "gateway", sourceName: process.env.HARA_GATEWAY };
  return { source: "interactive" };
}

/** Title for a NON-interactive session: "name · MM-DD HH:mm" — the raw prompt never becomes a title. */
export function automatedTitle(source: SessionSource, sourceName: string | undefined, at = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const stamp = `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
  return `${sourceName || source} · ${stamp}`;
}

export interface SessionMeta {
  id: string;
  cwd: string;
  provider: string;
  /** Per-session pinned model. Set at session creation from cfg.model, **updated by `/model X`**,
   *  and restored into cfg.model on resume so a session keeps the model the user picked.
   *  Resume precedence (see index.ts session init): `--model` flag > meta.model > profile defaults. */
  model: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** short-term working memory — a few durable one-liners that survive /compact + resume */
  workingSet?: string[];
  /** creator of this session (absent = legacy/interactive) — see SessionSource */
  source?: SessionSource;
  /** human tag for automated sessions: cron job name / gateway platform */
  sourceName?: string;
  /** archived sessions are hidden from pickers/lists but kept on disk (codex thread/archive) */
  archived?: boolean;
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
const lockFile = (id: string) => join(sessionsDir(), `${id}.lock`);

/** Is a process with this pid alive? `process.kill(pid, 0)` sends no signal — it just probes: throws
 *  ESRCH if dead, EPERM if alive-but-not-ours (still alive). Best-effort across platforms. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}

/** Take an exclusive lock on a session so two hara processes can't resume the SAME session and corrupt
 *  its append-only history by racing writes. Returns `{ ok: true }` if acquired (or the previous holder
 *  is dead → we take over), or `{ ok: false, pid }` if a LIVE process already holds it. Best-effort: any
 *  filesystem hiccup resolves to `ok:true` so a lock problem never blocks the user. Pair with
 *  `releaseSessionLock` on exit. */
export function acquireSessionLock(id: string): { ok: boolean; pid?: number } {
  const f = lockFile(id);
  try {
    if (existsSync(f)) {
      const held = JSON.parse(readFileSync(f, "utf8")) as { pid?: number };
      if (typeof held.pid === "number" && held.pid !== process.pid && pidAlive(held.pid)) {
        return { ok: false, pid: held.pid };
      }
      // stale (dead pid) or already ours → fall through and (re)claim it
    }
    writeFileSync(f, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
    return { ok: true };
  } catch {
    return { ok: true };
  }
}

/** Release a session lock we hold (only removes it if the pid matches ours — never steals another's). */
export function releaseSessionLock(id: string): void {
  try {
    const f = lockFile(id);
    if (!existsSync(f)) return;
    const held = JSON.parse(readFileSync(f, "utf8")) as { pid?: number };
    if (held?.pid === process.pid) rmSync(f);
  } catch {
    /* best-effort */
  }
}

/** A full UUID per session (the stable identity). */
export const newSessionId = (): string => randomUUID();
/** First segment of the UUID — a compact label for the status bar / `/sessions`. */
export const shortId = (id: string): string => id.slice(0, 8);

/** Resolve a full id OR a unique prefix (e.g. the short id) to a session id, for `--resume`. */
export function resolveSessionId(idOrPrefix: string): string | null {
  if (existsSync(sessionFile(idOrPrefix))) return idOrPrefix;
  const hit = listSessions().find((m) => m.id.startsWith(idOrPrefix));
  return hit ? hit.id : null;
}

const STOP = new Set(
  "the a an to of for and or with in on at my our your this that it is please can could you help me we add fix make do run create update change implement".split(" "),
);
const WORDS = "amber basalt cedar delta ember flint grove harbor indigo jade kelp larch maple onyx quartz river slate terra umber vale willow zephyr".split(" ");

/** A short, ASCII, few-word session name from the first message — no CJK or garbled chars. For
 *  all-CJK / empty input, a stable word derived from the text. Keeps the status bar tidy. */
export function cleanSessionName(raw: string): string {
  const words = raw
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
  const slug = words.slice(0, 3).join("-").slice(0, 24).replace(/^-+|-+$/g, "");
  if (slug) return slug;
  let h = 0;
  for (const ch of raw) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return WORDS[h % WORDS.length] ?? "session";
}

/** A concise, human session name auto-summarized from the first message. Language-agnostic — keeps CJK
 *  (unlike the ASCII-slug `cleanSessionName`), trims code/whitespace, caps length. Empty for blank input
 *  (callers fall back to the short id, never "new session"). */
export function deriveTitle(text: string): string {
  if (typeof text !== "string") return ""; // a malformed/hand-edited session may have a non-string content
  const t = text
    .replace(/^\/\S+\s*/, "") // drop a leading slash-command
    .replace(/```[\s\S]*?```/g, " ") // drop fenced code blocks
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return "";
  const max = 40;
  return t.length <= max ? t : t.slice(0, max).replace(/\s+\S*$/, "").trim() + "…";
}

export function titleFrom(history: NeutralMsg[]): string {
  const firstUser = history.find((h) => h.role === "user");
  return deriveTitle(firstUser && firstUser.role === "user" ? firstUser.content : "");
}

/** Normalize a phrase to an ASCII kebab-case slug (lowercase, a–z0–9 + single hyphens, capped). Non-ASCII
 *  is dropped — used to clean a model-generated English session name. Returns "" if nothing ASCII remains. */
export function slugify(text: string, max = 40): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .slice(0, max)
    .replace(/-+$/, "");
}

export function saveSession(meta: SessionMeta, history: NeutralMsg[]): void {
  meta.updatedAt = new Date().toISOString();
  const data: SessionData = { meta, history };
  writeFileSync(sessionFile(meta.id), JSON.stringify(data, null, 2), "utf8");
}

/** True if a parsed object has the SessionData shape we can safely use (meta object + history array). */
function isSessionData(d: unknown): d is SessionData {
  const o = d as { meta?: unknown; history?: unknown } | null;
  return !!o && typeof o === "object" && !!o.meta && typeof o.meta === "object" && Array.isArray(o.history);
}

export function loadSession(id: string): SessionData | null {
  const p = sessionFile(id);
  if (!existsSync(p)) return null;
  try {
    const d = JSON.parse(readFileSync(p, "utf8"));
    return isSessionData(d) ? d : null; // a corrupt / hand-edited file resumes as "no session" instead of crashing
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
      const d = JSON.parse(readFileSync(join(sessionsDir(), f), "utf8")) as { meta?: SessionMeta };
      if (d?.meta && typeof d.meta === "object" && d.meta.id && d.meta.updatedAt) metas.push(d.meta); // skip metaless/corrupt
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
