// `hara desk` client — how a hara agent connects to the hara-desk coordination server (the closed-
// source identity registry + task board). This is the OPEN-SOURCE side of the wire: a thin HTTP
// client + local credential storage. The desk itself (auth, board, L2 ack) lives in hara-desk.
//
// Credentials live in ~/.hara/desk.json (0600): the desk URL + this agent's token, written once at
// `hara desk register`. Every later call reads them back. The token is a bearer secret — never logged.
import { homedir } from "node:os";
import {
  bindPrivateHaraStateFile,
  readPrivateStateFileSnapshotSync,
  writePrivateStateFileSync,
} from "./security/private-state.js";

export interface DeskCreds {
  url: string; // e.g. http://127.0.0.1:4200 (local) or https://desk.nanhara.tech (server)
  agentId: string;
  owner: string;
  token: string;
}

export function loadCreds(): DeskCreds | null {
  try {
    const binding = bindPrivateHaraStateFile(homedir(), [], "desk.json");
    const snapshot = readPrivateStateFileSnapshotSync(binding.path, 1024 * 1024);
    if (!snapshot) return null;
    const c = JSON.parse(snapshot.text) as DeskCreds;
    return c.url && c.token ? c : null;
  } catch {
    return null;
  }
}

export function saveCreds(c: DeskCreds): void {
  const binding = bindPrivateHaraStateFile(homedir(), [], "desk.json");
  writePrivateStateFileSync(binding, JSON.stringify(c, null, 2) + "\n");
}

/** One HTTP call to the desk. Auth via bearer token when creds are present. Throws on non-2xx with
 *  the server's error message (so the CLI can surface a real reason, not "request failed"). */
export async function deskCall(
  url: string,
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<any> {
  const r = await fetch(url.replace(/\/$/, "") + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 10000),
  });
  const text = await r.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!r.ok) throw new Error(data?.error || `desk ${r.status}: ${text.slice(0, 200)}`);
  return data;
}

/** Register this machine's agent with a desk and persist the returned credentials. `client`
 *  identifies the kind of client (defaults "hara-cli"); the desk is client-agnostic, so any agent
 *  may pass its own label. */
export async function registerAgent(url: string, enrollKey: string, name: string, owner: string, client = "hara-cli"): Promise<DeskCreds> {
  const r = await deskCall(url, "POST", "/register", { body: { enrollKey, name, owner, client } });
  const creds: DeskCreds = { url, agentId: r.agentId, owner: r.owner, token: r.token };
  saveCreds(creds);
  return creds;
}
