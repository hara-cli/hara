import { createHmac, randomBytes } from "node:crypto";
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

interface StoredExternalRuntimeLinks {
  version: 1;
  links: Array<{
    runtimeSessionId: string;
    providerSessionId: string;
    createdAt: string;
  }>;
}

const MAX_OWNED_SESSIONS = 5_000;
const MAX_OWNERSHIP_FILE_BYTES = 2 * 1024 * 1024;
const OPAQUE_ID = /^ext_(codex|claude)_[a-f0-9]{24}$/;
const RUNTIME_OPAQUE_ID = /^ext_runtime_[a-f0-9]{24}$/;
const MAX_RUNTIME_LINKS = 5_000;
const MAX_RUNTIME_LINKS_FILE_BYTES = 2 * 1024 * 1024;

/** Derive the renderer-safe id used by the matching provider adapter. */
export function opaqueProviderSessionId(
  sourceId: "codex" | "claude",
  nativeSessionId: string,
  identityKey: Buffer,
): string {
  const digest = createHmac("sha256", identityKey)
    .update(`hara.external.${sourceId}.session\0${nativeSessionId}`, "utf8")
    .digest("hex")
    .slice(0, 24);
  return `ext_${sourceId}_${digest}`;
}

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

const parseRuntimeLinks = (text: string): StoredExternalRuntimeLinks => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("external runtime link registry is invalid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("external runtime link registry has an invalid shape");
  }
  const value = parsed as Partial<StoredExternalRuntimeLinks>;
  if (value.version !== 1 || !Array.isArray(value.links) || value.links.length > MAX_RUNTIME_LINKS) {
    throw new Error("external runtime link registry is invalid");
  }
  const links: StoredExternalRuntimeLinks["links"] = [];
  const seen = new Set<string>();
  for (const entry of value.links) {
    if (
      !entry
      || typeof entry !== "object"
      || !RUNTIME_OPAQUE_ID.test(entry.runtimeSessionId)
      || !OPAQUE_ID.test(entry.providerSessionId)
      || typeof entry.createdAt !== "string"
      || Number.isNaN(Date.parse(entry.createdAt))
      || seen.has(entry.runtimeSessionId)
    ) throw new Error("external runtime link registry contains an invalid entry");
    seen.add(entry.runtimeSessionId);
    links.push({ ...entry });
  }
  return { version: 1, links };
};

/**
 * Durable bridge from a live Hara terminal to provider history. Both sides are keyed opaque ids;
 * provider-native ids and paths are deliberately never written to this file.
 */
export class ExternalRuntimeLinkStore {
  private readonly links = new Map<string, string>();

  constructor(private readonly home = homedir()) {
    const binding = bindPrivateHaraStateFile(home, ["external-sessions"], "runtime-links.json");
    const snapshot = readPrivateStateFileSnapshotSync(binding.path, MAX_RUNTIME_LINKS_FILE_BYTES);
    if (snapshot) {
      for (const entry of parseRuntimeLinks(snapshot.text).links) {
        this.links.set(entry.runtimeSessionId, entry.providerSessionId);
      }
    }
  }

  get(runtimeSessionId: string): string | undefined {
    return this.links.get(runtimeSessionId);
  }

  set(runtimeSessionId: string, providerSessionId: string): void {
    if (!RUNTIME_OPAQUE_ID.test(runtimeSessionId) || !OPAQUE_ID.test(providerSessionId)) {
      throw new Error("cannot persist an invalid external runtime link");
    }
    withPrivateStateLockSync(this.home, ["external-sessions"], "runtime-links", () => {
      const binding = bindPrivateHaraStateFile(this.home, ["external-sessions"], "runtime-links.json");
      const snapshot = readPrivateStateFileSnapshotSync(binding.path, MAX_RUNTIME_LINKS_FILE_BYTES);
      const value = snapshot ? parseRuntimeLinks(snapshot.text) : { version: 1 as const, links: [] };
      const links = value.links.filter((entry) => entry.runtimeSessionId !== runtimeSessionId);
      links.push({ runtimeSessionId, providerSessionId, createdAt: new Date().toISOString() });
      const next: StoredExternalRuntimeLinks = { version: 1, links: links.slice(-MAX_RUNTIME_LINKS) };
      writePrivateStateFileSync(binding, `${JSON.stringify(next, null, 2)}\n`, snapshot
        ? { expectedText: snapshot.text }
        : { expectedMissing: true });
      this.links.clear();
      for (const entry of next.links) this.links.set(entry.runtimeSessionId, entry.providerSessionId);
    }, { busyMessage: "external runtime link registry is busy; retry the operation" });
  }
}
