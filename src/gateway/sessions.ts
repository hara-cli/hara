// Chat → hara-session mapping so each chat is a continuous, resumable thread. Persisted at
// ~/.hara/gateway/chats.json. The session id is `<platform>-<chatId>[-N]` — filename-safe, and the session
// store keys files by id, so these are real sessions resumable via `hara -p … --resume <id>`.
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

interface ChatMap {
  [key: string]: { sessionId: string; fork: number };
}

const dir = (): string => join(homedir(), ".hara", "gateway");
const file = (): string => join(dir(), "chats.json");

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

/** The session id a chat currently drives (stable per chat; created on first use; survives restarts). */
export function chatSessionId(platform: string, chatId: number | string): string {
  const key = `${platform}:${chatId}`;
  const m = load();
  if (!m[key]) {
    m[key] = { sessionId: `${platform}-${chatId}`, fork: 0 };
    save(m);
  }
  return m[key].sessionId;
}

/** Start a fresh thread for a chat (/new) — forks the session id so the prior thread is preserved. */
export function newChatSession(platform: string, chatId: number | string): string {
  const key = `${platform}:${chatId}`;
  const m = load();
  const fork = (m[key]?.fork ?? 0) + 1;
  m[key] = { sessionId: `${platform}-${chatId}-${fork}`, fork };
  save(m);
  return m[key].sessionId;
}

/** Point a chat at a specific existing session (/resume <id>). */
export function setChatSession(platform: string, chatId: number | string, sessionId: string): void {
  const key = `${platform}:${chatId}`;
  const m = load();
  m[key] = { sessionId, fork: m[key]?.fork ?? 0 };
  save(m);
}
