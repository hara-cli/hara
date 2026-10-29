import { isAbsolute } from "node:path";
import { isValidSpaceId } from "../profile/profile.js";
import {
  bindPrivateHaraStateFile,
  readPrivateStateFileSnapshotSync,
  withPrivateStateLockSync,
  writePrivateStateFileSync,
} from "../security/private-state.js";

export const AGENT_RUNTIME_IDS = ["hara", "pi", "opencode", "codex", "claude", "agy"] as const;
export type AgentRuntimeId = typeof AGENT_RUNTIME_IDS[number];
const REF = /^(?:main|(?:global|[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?):[A-Za-z0-9][A-Za-z0-9._-]{0,79})$/;
const FILE = "agent-runtime-bindings.json";
const MAX_BYTES = 512 * 1024;
const MAX_BINDINGS = 2048;

/** Legacy Space is explicit: this store does NOT turn on the new Workspace data plane. Runtime
 * selection contains no model credential, tool grant, cwd, command, or private persona instructions. */
export interface AgentRuntimeBinding {
  version: 1;
  spaceId: string;
  agentRef: string;
  runtimeId: AgentRuntimeId;
  revision: number;
}

/** One task keeps its original engine across steering, restart and profile edits. This is provenance,
 * not authority: the host must still authorize the audience and tools at each execution boundary. */
export interface TaskRuntimeBinding extends AgentRuntimeBinding {
  taskId: string;
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

export function isAgentRuntimeId(value: unknown): value is AgentRuntimeId {
  return typeof value === "string" && AGENT_RUNTIME_IDS.includes(value as AgentRuntimeId);
}

export function assertAgentRuntimeOwner(spaceId: unknown, agentRef: unknown): asserts spaceId is string {
  if (!isValidSpaceId(spaceId) || typeof agentRef !== "string" || !REF.test(agentRef)) {
    throw new Error("invalid Agent Runtime audience or qualified Agent ref");
  }
}

export function isAgentRuntimeBinding(value: unknown): value is AgentRuntimeBinding {
  if (!object(value) || !keys(value, ["version", "spaceId", "agentRef", "runtimeId", "revision"])) return false;
  try { assertAgentRuntimeOwner(value.spaceId, value.agentRef); } catch { return false; }
  return value.version === 1 && isAgentRuntimeId(value.runtimeId) && Number.isSafeInteger(value.revision)
    && Number(value.revision) >= 0 && (value.revision !== 0 || value.runtimeId === "hara");
}

export function isTaskRuntimeBinding(value: unknown): value is TaskRuntimeBinding {
  if (!object(value) || !keys(value, ["version", "spaceId", "agentRef", "runtimeId", "revision", "taskId"])) return false;
  const { taskId, ...binding } = value;
  return isAgentRuntimeBinding(binding) && typeof taskId === "string" && taskId.length > 0
    && taskId.length <= 220 && !/[\\/\0]/.test(taskId);
}

export function freezeTaskRuntimeBinding(binding: AgentRuntimeBinding, taskId: string): Readonly<TaskRuntimeBinding> {
  const result = { ...binding, taskId };
  if (!isTaskRuntimeBinding(result)) throw new Error("invalid task Runtime binding");
  return Object.freeze(result);
}

interface RuntimeBindingsFile { version: 1; bindings: AgentRuntimeBinding[] }

/** Trusted local host configuration, deliberately separate from imported Agent Markdown. No automatic
 * migration, constructor IO, ambient Runtime detection, or writes to old sessions/memory. */
export class AgentRuntimeBindingStore {
  constructor(private readonly home: string) {
    if (typeof home !== "string" || !isAbsolute(home)) throw new Error("Agent Runtime store requires an explicit absolute home");
  }

  private load(): { value: RuntimeBindingsFile; text?: string } {
    const file = bindPrivateHaraStateFile(this.home, [], FILE);
    const snapshot = readPrivateStateFileSnapshotSync(file.path, MAX_BYTES);
    if (!snapshot) return { value: { version: 1, bindings: [] } };
    let raw: unknown;
    try { raw = JSON.parse(snapshot.text); } catch { throw new Error("invalid Agent Runtime store; state was not replaced"); }
    if (!object(raw) || !keys(raw, ["version", "bindings"]) || raw.version !== 1 || !Array.isArray(raw.bindings)
      || raw.bindings.length > MAX_BINDINGS) throw new Error("unsupported Agent Runtime store; state was not replaced");
    const seen = new Set<string>();
    for (const row of raw.bindings) {
      if (!isAgentRuntimeBinding(row) || row.revision < 1) throw new Error("invalid Agent Runtime record; state was not replaced");
      const key = JSON.stringify([row.spaceId, row.agentRef]);
      if (seen.has(key)) throw new Error("duplicate Agent Runtime owner; state was not replaced");
      seen.add(key);
    }
    return { value: raw as unknown as RuntimeBindingsFile, text: snapshot.text };
  }

  read(spaceId: string, agentRef: string): AgentRuntimeBinding {
    return this.readMany(spaceId, [agentRef])[0]!;
  }

  /** One private-state read for an entire directory, not one JSON parse/stat sequence per Agent. */
  readMany(spaceId: string, refs: readonly string[]): AgentRuntimeBinding[] {
    if (refs.length > MAX_BINDINGS) throw new Error("too many Agent Runtime owners");
    for (const ref of refs) assertAgentRuntimeOwner(spaceId, ref);
    const rows = new Map(this.load().value.bindings.filter((entry) => entry.spaceId === spaceId)
      .map((entry) => [entry.agentRef, entry]));
    // Absence is existing Hara compatibility, NOT evidence that Pi already runs general Agents.
    return refs.map((agentRef) => ({ ...(rows.get(agentRef) ?? { version: 1, spaceId, agentRef, runtimeId: "hara", revision: 0 }) }));
  }

  /** The caller authorizes the human/Agent owner and adapter availability BEFORE this local CAS. */
  set(spaceId: string, agentRef: string, runtimeId: AgentRuntimeId, expectedRevision: number): AgentRuntimeBinding {
    assertAgentRuntimeOwner(spaceId, agentRef);
    if (!isAgentRuntimeId(runtimeId) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new Error("invalid Agent Runtime update");
    }
    return withPrivateStateLockSync(this.home, [], "agent-runtime-bindings", () => {
      const current = this.load();
      const index = current.value.bindings.findIndex((entry) => entry.spaceId === spaceId && entry.agentRef === agentRef);
      const prior = current.value.bindings[index];
      if ((prior?.revision ?? 0) !== expectedRevision) throw new Error("Agent Runtime changed; refresh before editing");
      if (expectedRevision >= Number.MAX_SAFE_INTEGER) throw new Error("Agent Runtime revision exhausted");
      const next: AgentRuntimeBinding = { version: 1, spaceId, agentRef, runtimeId, revision: expectedRevision + 1 };
      if (index < 0) current.value.bindings.push(next); else current.value.bindings[index] = next;
      const text = JSON.stringify(current.value) + "\n";
      if (current.value.bindings.length > MAX_BINDINGS || Buffer.byteLength(text, "utf8") > MAX_BYTES) {
        throw new Error("Agent Runtime store is full; state was not replaced");
      }
      writePrivateStateFileSync(bindPrivateHaraStateFile(this.home, [], FILE), text,
        current.text === undefined ? { expectedMissing: true } : { expectedText: current.text });
      return { ...next };
    });
  }
}
