// Personal Agent employment state. Hara discovers compatible roles in place from Hara, Claude Code,
// OpenClaw, Hermes, plugins, and registered projects; dismissing one must therefore hide it only inside
// Hara instead of deleting or rewriting another tool's source file. The qualified ref is the durable
// employment identity, while the source prompt and conversation history remain available for recovery.
import { homedir } from "node:os";
import {
  bindPrivateHaraStateFile,
  readPrivateStateFileSnapshotSync,
  withPrivateStateLockSync,
  writePrivateStateFileSync,
} from "../security/private-state.js";

const STORE_VERSION = 1;
const STORE_FILE = "agent-roster.json";
const STORE_RESOURCE = "agent-roster";
const MAX_STORE_BYTES = 512 * 1024;
const MAX_DISMISSED_AGENTS = 2_048;
const AGENT_REF = /^(?:global|[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?):[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

interface DismissedAgentRecord {
  ref: string;
  dismissedAt: string;
}

interface AgentRosterFile {
  version: 1;
  dismissed: DismissedAgentRecord[];
}

function emptyRoster(): AgentRosterFile {
  return { version: STORE_VERSION, dismissed: [] };
}

function checkedRef(value: unknown): string {
  if (typeof value !== "string") throw new Error("Agent ref must be a qualified global:name or project:name address");
  const ref = value.trim();
  if (ref === "main" || !AGENT_REF.test(ref)) {
    throw new Error("Agent ref must be a qualified global:name or project:name address; the main Agent cannot be dismissed");
  }
  return ref;
}

function parseRoster(text: string): AgentRosterFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("personal Agent roster is not valid JSON; refusing to replace it");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("personal Agent roster has an invalid shape; refusing to replace it");
  }
  const input = parsed as Partial<AgentRosterFile>;
  if (input.version !== STORE_VERSION || !Array.isArray(input.dismissed) || input.dismissed.length > MAX_DISMISSED_AGENTS) {
    throw new Error("personal Agent roster has an unsupported version or size; refusing to replace it");
  }
  const seen = new Set<string>();
  const dismissed: DismissedAgentRecord[] = [];
  for (const candidate of input.dismissed) {
    if (!candidate || typeof candidate !== "object") throw new Error("personal Agent roster contains an invalid record");
    const ref = checkedRef((candidate as DismissedAgentRecord).ref);
    const dismissedAt = (candidate as DismissedAgentRecord).dismissedAt;
    if (typeof dismissedAt !== "string" || !Number.isFinite(Date.parse(dismissedAt))) {
      throw new Error(`personal Agent roster contains an invalid dismissal time for '${ref}'`);
    }
    if (seen.has(ref)) throw new Error(`personal Agent roster contains duplicate Agent '${ref}'`);
    seen.add(ref);
    dismissed.push({ ref, dismissedAt });
  }
  return { version: STORE_VERSION, dismissed };
}

function loadRoster(home: string): { roster: AgentRosterFile; text?: string } {
  const binding = bindPrivateHaraStateFile(home, [], STORE_FILE);
  const snapshot = readPrivateStateFileSnapshotSync(binding.path, MAX_STORE_BYTES);
  return snapshot
    ? { roster: parseRoster(snapshot.text), text: snapshot.text }
    : { roster: emptyRoster() };
}

function saveRoster(
  home: string,
  update: (current: AgentRosterFile) => AgentRosterFile,
): AgentRosterFile {
  return withPrivateStateLockSync(home, [], STORE_RESOURCE, () => {
    const current = loadRoster(home);
    const next = update(current.roster);
    if (next.dismissed.length > MAX_DISMISSED_AGENTS) throw new Error("personal Agent roster is full");
    const serialized = `${JSON.stringify(next, null, 2)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_STORE_BYTES) throw new Error("personal Agent roster is too large");
    const binding = bindPrivateHaraStateFile(home, [], STORE_FILE);
    writePrivateStateFileSync(binding, serialized, current.text === undefined
      ? { expectedMissing: true }
      : { expectedText: current.text });
    return next;
  }, { busyMessage: "personal Agent roster is busy; retry the operation" });
}

export function dismissedAgentRefs(home = homedir()): Set<string> {
  return new Set(loadRoster(home).roster.dismissed.map((entry) => entry.ref));
}

export function isAgentRefDismissed(ref: string, home = homedir()): boolean {
  if (!AGENT_REF.test(ref)) return false;
  return dismissedAgentRefs(home).has(ref);
}

/** Recoverably remove one or more discovered Agents from Hara's active staff directory. */
export function dismissAgentRefs(refs: readonly string[], home = homedir()): AgentRosterFile {
  const normalized = [...new Set(refs.map(checkedRef))];
  if (!normalized.length) return loadRoster(home).roster;
  return saveRoster(home, (current) => {
    const now = new Date().toISOString();
    const byRef = new Map(current.dismissed.map((entry) => [entry.ref, entry]));
    for (const ref of normalized) if (!byRef.has(ref)) byRef.set(ref, { ref, dismissedAt: now });
    return {
      version: STORE_VERSION,
      dismissed: [...byRef.values()].sort((left, right) => left.ref.localeCompare(right.ref)),
    };
  });
}

export function dismissAgentRef(ref: string, home = homedir()): AgentRosterFile {
  return dismissAgentRefs([ref], home);
}

/** Re-hiring restores discovery without touching the source prompt or any old conversation. */
export function restoreAgentRef(refInput: string, home = homedir()): boolean {
  const ref = checkedRef(refInput);
  if (!dismissedAgentRefs(home).has(ref)) return false;
  saveRoster(home, (current) => ({
    version: STORE_VERSION,
    dismissed: current.dismissed.filter((entry) => entry.ref !== ref),
  }));
  return true;
}
