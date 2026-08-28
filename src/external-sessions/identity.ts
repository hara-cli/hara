import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import {
  bindPrivateHaraStateFile,
  readPrivateStateFileSnapshotSync,
  withPrivateStateLockSync,
  writePrivateStateFileSync,
} from "../security/private-state.js";

const IDENTITY_BYTES = 32;
const MAX_IDENTITY_FILE_BYTES = 4 * 1024;

interface StoredExternalSessionIdentity {
  version: 1;
  key: string;
}

interface StoredExternalSessionOwnership {
  version: 1;
  sessions: Array<{
    id: string;
    sourceId: "codex" | "claude";
    createdAt: string;
  }>;
}

const MAX_OWNED_SESSIONS = 5_000;
const MAX_OWNERSHIP_FILE_BYTES = 2 * 1024 * 1024;
const OPAQUE_ID = /^ext_(codex|claude)_[a-f0-9]{24}$/;

const decodeIdentity = (text: string): Buffer => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("external session identity is invalid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("external session identity has an invalid shape");
  }
  const value = parsed as Partial<StoredExternalSessionIdentity>;
  if (value.version !== 1 || typeof value.key !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.key)) {
    throw new Error("external session identity is invalid");
  }
  const key = Buffer.from(value.key, "base64url");
  if (key.length !== IDENTITY_BYTES) throw new Error("external session identity has an invalid key length");
  return key;
};

/**
 * Device-stable secret used only to derive renderer-safe opaque external session/workspace identifiers.
 * It is owner-only private state, never returned by Serve and never synchronized as account data.
 */
export function externalSessionIdentityKey(home = homedir()): Buffer {
  return withPrivateStateLockSync(home, ["external-sessions"], "identity", () => {
    const binding = bindPrivateHaraStateFile(home, ["external-sessions"], "identity.json");
    const existing = readPrivateStateFileSnapshotSync(binding.path, MAX_IDENTITY_FILE_BYTES);
    if (existing) return decodeIdentity(existing.text);
    const key = randomBytes(IDENTITY_BYTES);
    const stored: StoredExternalSessionIdentity = { version: 1, key: key.toString("base64url") };
    writePrivateStateFileSync(binding, `${JSON.stringify(stored, null, 2)}\n`, { expectedMissing: true });
    return key;
  }, { busyMessage: "external session identity is busy; retry the operation" });
}

const parseOwnership = (text: string): StoredExternalSessionOwnership => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("external session ownership registry is invalid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("external session ownership registry has an invalid shape");
  }
  const value = parsed as Partial<StoredExternalSessionOwnership>;
  if (value.version !== 1 || !Array.isArray(value.sessions) || value.sessions.length > MAX_OWNED_SESSIONS) {
    throw new Error("external session ownership registry is invalid");
  }
  const sessions: StoredExternalSessionOwnership["sessions"] = [];
  const seen = new Set<string>();
  for (const entry of value.sessions) {
    if (
      !entry
      || typeof entry !== "object"
      || !OPAQUE_ID.test(entry.id)
      || (entry.sourceId !== "codex" && entry.sourceId !== "claude")
      || !entry.id.startsWith(`ext_${entry.sourceId}_`)
      || typeof entry.createdAt !== "string"
      || Number.isNaN(Date.parse(entry.createdAt))
      || seen.has(entry.id)
    ) throw new Error("external session ownership registry contains an invalid entry");
    seen.add(entry.id);
    sessions.push({ id: entry.id, sourceId: entry.sourceId, createdAt: entry.createdAt });
  }
  return { version: 1, sessions };
};

/** Keeps only Hara opaque ids, never provider-native session IDs or local paths. */
export class ExternalSessionOwnershipStore {
  private readonly owned = new Set<string>();

  constructor(private readonly home = homedir()) {
    const binding = bindPrivateHaraStateFile(home, ["external-sessions"], "ownership.json");
    const snapshot = readPrivateStateFileSnapshotSync(binding.path, MAX_OWNERSHIP_FILE_BYTES);
    if (snapshot) {
      for (const entry of parseOwnership(snapshot.text).sessions) this.owned.add(entry.id);
    }
  }

  has(sessionId: string): boolean {
    return this.owned.has(sessionId);
  }

  add(sourceId: "codex" | "claude", sessionId: string): void {
    if (!OPAQUE_ID.test(sessionId) || !sessionId.startsWith(`ext_${sourceId}_`)) {
      throw new Error("cannot persist an invalid external session ownership id");
    }
    withPrivateStateLockSync(this.home, ["external-sessions"], "ownership", () => {
      const binding = bindPrivateHaraStateFile(this.home, ["external-sessions"], "ownership.json");
      const snapshot = readPrivateStateFileSnapshotSync(binding.path, MAX_OWNERSHIP_FILE_BYTES);
      const value = snapshot ? parseOwnership(snapshot.text) : { version: 1 as const, sessions: [] };
      const now = new Date().toISOString();
      const sessions = value.sessions.filter((entry) => entry.id !== sessionId);
      sessions.push({ id: sessionId, sourceId, createdAt: now });
      const next: StoredExternalSessionOwnership = {
        version: 1,
        sessions: sessions.slice(-MAX_OWNED_SESSIONS),
      };
      writePrivateStateFileSync(binding, `${JSON.stringify(next, null, 2)}\n`, snapshot
        ? { expectedText: snapshot.text }
        : { expectedMissing: true });
      this.owned.clear();
      for (const entry of next.sessions) this.owned.add(entry.id);
    }, { busyMessage: "external session ownership registry is busy; retry the operation" });
  }
}
