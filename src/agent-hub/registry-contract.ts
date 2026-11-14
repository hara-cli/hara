import { AgentHubError } from "./errors.js";
import type { RegisteredHubAgent } from "./contracts.js";
import type { HubResourceBindingV1 } from "../workspace/agent-boundaries-contract.js";

export const AGENT_REGISTRY_CONTRACT = "hara.agent-registry.v1" as const;
export const AGENT_REGISTRY_LIMITS = Object.freeze({ agents: 128, bytes: 256 * 1024, displayName: 160 });
export const MANAGED_SESSION_SOURCES = ["codex", "claude", "opencode", "runtime"] as const;
export type ManagedSessionSource = typeof MANAGED_SESSION_SOURCES[number];
export type ManagedAgentEngine = "codex" | "claude" | "opencode";
export interface ManagedAgentMetadataV1 extends RegisteredHubAgent {
  engine: ManagedAgentEngine;
  sessionSource: ManagedSessionSource;
  createdAt: string;
  registeredAt: string;
  lifecycle: "registered" | "ended" | "unknown";
  /** No proactive status protocol exists in 1.3.0. Lifecycle is not activity. */
  state: "unknown";
}
export interface ManagedAgentRegistrySnapshotV1 {
  contract: typeof AGENT_REGISTRY_CONTRACT;
  schemaVersion: 1;
  binding: HubResourceBindingV1;
  source: "core-managed";
  availability: "available" | "unavailable";
  revision: number | null;
  capturedAt: string;
  agents: ManagedAgentMetadataV1[];
  error: "registry_unavailable" | null;
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HEX = /^[a-f0-9]{64}$/;
const SESSION = /^ext_(codex|claude|opencode|runtime)_[a-f0-9]{24}$/;
const LABEL = /^[^\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]+$/u;
const reject = (): never => { throw new AgentHubError("invalid_request"); };

/** Reject accessors/prototypes before reading values, including for in-process callers. */
export function registryRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return reject();
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(key => typeof key !== "string" || !keys.includes(key))) return reject();
  for (const key of keys) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field || !field.enumerable || !("value" in field)) return reject();
  }
  return value as Record<string, unknown>;
}
export function registryTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 24) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}
export function registryInstance(value: unknown): value is string { return typeof value === "string" && UUID.test(value); }
export function registryLabel(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= AGENT_REGISTRY_LIMITS.displayName && LABEL.test(value);
}
export function parseRegistryBinding(value: unknown): HubResourceBindingV1 {
  const row = registryRecord(value, ["schemaVersion", "scopeKey", "generation"]);
  if (row.schemaVersion !== 1 || typeof row.scopeKey !== "string" || !HEX.test(row.scopeKey) || !registryInstance(row.generation)) return reject();
  return { schemaVersion: 1, scopeKey: row.scopeKey, generation: row.generation };
}
export function registrySession(value: unknown, source: unknown, engine: unknown): value is string {
  return typeof value === "string" && SESSION.test(value) && MANAGED_SESSION_SOURCES.includes(source as ManagedSessionSource)
    && value.startsWith("ext_" + source + "_") && ["codex", "claude", "opencode"].includes(engine as string)
    && (source === "runtime" ? engine === "codex" || engine === "claude" : source === engine);
}
export function parseManagedAgentMetadata(value: unknown): ManagedAgentMetadataV1 {
  const row = registryRecord(value, ["agentId", "instanceId", "alias", "displayName", "engine", "sessionSource",
    "createdAt", "registeredAt", "lifecycle", "state"]);
  if (!registrySession(row.agentId, row.sessionSource, row.engine) || !registryInstance(row.instanceId)
    || row.alias !== "agent-" + row.agentId || !registryLabel(row.displayName)
    || !registryTimestamp(row.createdAt) || !registryTimestamp(row.registeredAt)
    || !["registered", "ended", "unknown"].includes(row.lifecycle as string) || row.state !== "unknown") return reject();
  return { agentId: row.agentId, instanceId: row.instanceId, alias: row.alias as string, displayName: row.displayName,
    engine: row.engine as ManagedAgentEngine, sessionSource: row.sessionSource as ManagedSessionSource,
    createdAt: row.createdAt, registeredAt: row.registeredAt, lifecycle: row.lifecycle as ManagedAgentMetadataV1["lifecycle"], state: "unknown" };
}
/** Syntax only. A parsed snapshot, even lifecycle=registered, is never authority. */
export function parseManagedAgentRegistrySnapshot(value: unknown): ManagedAgentRegistrySnapshotV1 {
  const row = registryRecord(value, ["contract", "schemaVersion", "binding", "source", "availability", "revision",
    "capturedAt", "agents", "error"]);
  if (row.contract !== AGENT_REGISTRY_CONTRACT || row.schemaVersion !== 1 || row.source !== "core-managed"
    || !registryTimestamp(row.capturedAt) || !Array.isArray(row.agents) || row.agents.length > AGENT_REGISTRY_LIMITS.agents) return reject();
  const binding = parseRegistryBinding(row.binding);
  if (row.availability === "available") {
    if (!Number.isSafeInteger(row.revision) || Number(row.revision) < 0 || row.error !== null) return reject();
  } else if (row.availability !== "unavailable" || row.revision !== null || row.error !== "registry_unavailable" || row.agents.length) return reject();
  const agents = row.agents.map(parseManagedAgentMetadata), ids = new Set(agents.map(agent => agent.agentId));
  if (ids.size !== agents.length) return reject();
  const result = { contract: AGENT_REGISTRY_CONTRACT, schemaVersion: 1 as const, binding, source: "core-managed" as const,
    availability: row.availability as ManagedAgentRegistrySnapshotV1["availability"], revision: row.revision as number | null,
    capturedAt: row.capturedAt, agents, error: row.error as ManagedAgentRegistrySnapshotV1["error"] };
  if (Buffer.byteLength(JSON.stringify(result)) > AGENT_REGISTRY_LIMITS.bytes) return reject();
  return result;
}
