// Chat → working-dir + session mapping, so each chat is a continuous, resumable thread that can ROAM across
// projects. Persisted at ~/.hara/gateway/chats.json. A chat has a current cwd (switchable via /cd) and a
// session id scoped to that (chat, cwd) pair — so switching projects switches threads, and switching back
// resumes the right one. /sessions then lists the current dir's threads (codex-style), while the chat itself
// stays a single conversation front-end (hermes-style). The same model backs a future desktop app.
// Sessions are stored by id in ~/.hara/sessions, so these are real sessions resumable via `hara -p … --resume`.
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";

interface ChatEntry {
  cwd: string;
  sessionId: string;
  fork: number;
}
interface ChatMap {
  [key: string]: ChatEntry;
}

const dir = (): string => join(homedir(), ".hara", "gateway");
const file = (): string => join(dir(), "chats.json");
const mapKey = (platform: string, chatId: number | string): string => `${platform}:${chatId}`;

function load(): ChatMap {
  try {
    return existsSync(file()) ? (JSON.parse(readFileSync(file(), "utf8")) as ChatMap) : {};
  } catch {
    return {};
  }
}
function save(m: ChatMap): void {
  mkdirSync(dir(), { recursive: true });
  writeFileSync(file(), JSON.stringify(m, null, 2));
}

/** A stable, short, dir-specific suffix so each (chat, cwd) pair gets its own session thread. */
export function cwdTag(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 6);
}
/** Derived session id for a (chat, cwd, fork): `<platform>-<chatId>-<cwdTag>[-fork]`. */
function deriveId(platform: string, chatId: number | string, cwd: string, fork: number): string {
  return `${platform}-${chatId}-${cwdTag(cwd)}${fork ? `-${fork}` : ""}`;
}

/** Get (or initialize) the chat's context: current working dir + the session id it drives. `defaultCwd` (the
 *  gateway's launch dir) is used only on first contact; a pre-cwd entry is migrated in place (keeps its id). */
export function chatContext(platform: string, chatId: number | string, defaultCwd: string): { cwd: string; sessionId: string } {
  const m = load();
  const k = mapKey(platform, chatId);
  const e = m[k];
  if (!e) {
    const fresh: ChatEntry = { cwd: defaultCwd, sessionId: deriveId(platform, chatId, defaultCwd, 0), fork: 0 };
    m[k] = fresh;
    save(m);
    return { cwd: fresh.cwd, sessionId: fresh.sessionId };
  }
  if (!e.cwd) {
    e.cwd = defaultCwd; // migrate an old (pre-cwd) entry, preserving its existing sessionId
    save(m);
  }
  return { cwd: e.cwd, sessionId: e.sessionId };
}

/** `/cd <dir>` — switch the chat to a working dir; the session follows (its own per-project thread). */
export function chatCd(platform: string, chatId: number | string, cwd: string): string {
  const m = load();
  const sessionId = deriveId(platform, chatId, cwd, 0);
  m[mapKey(platform, chatId)] = { cwd, sessionId, fork: 0 };
  save(m);
  return sessionId;
}

/** `/new` — fork a fresh thread for the chat's CURRENT dir (the old one is preserved). */
export function newChatSession(platform: string, chatId: number | string, defaultCwd: string): string {
  const m = load();
  const k = mapKey(platform, chatId);
  const cur = m[k] ?? { cwd: defaultCwd, sessionId: "", fork: 0 };
  const cwd = cur.cwd || defaultCwd;
  const fork = (cur.fork ?? 0) + 1;
  const sessionId = deriveId(platform, chatId, cwd, fork);
  m[k] = { cwd, sessionId, fork };
  save(m);
  return sessionId;
}

/** `/resume <id>` — point the chat at a specific existing session, following its cwd so it runs in the right place. */
export function setChatSession(platform: string, chatId: number | string, sessionId: string, cwd: string): void {
  const m = load();
  const k = mapKey(platform, chatId);
  m[k] = { cwd, sessionId, fork: m[k]?.fork ?? 0 };
  save(m);
}
