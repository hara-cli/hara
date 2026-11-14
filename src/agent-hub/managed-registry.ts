import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { AgentHubError } from "./errors.js";
import type { AgentHubDirectory, RegisteredHubAgent } from "./contracts.js";
import type { HubResourceBindingV1 } from "../workspace/agent-boundaries-contract.js";
import type { HaraStorageQuota } from "../storage/quota.js";
import { assertPrivateStateDirectory, bindPrivateHaraStateFile, readPrivateStateFileSnapshotSync,
  withPrivateStateLockSync, writePrivateStateFileSync, type PrivateStateFileBinding } from "../security/private-state.js";
import { AGENT_REGISTRY_CONTRACT, AGENT_REGISTRY_LIMITS, parseRegistryBinding, parseManagedAgentMetadata,
  parseManagedAgentRegistrySnapshot, registryRecord, registryInstance, registryLabel,
  type ManagedAgentEngine, type ManagedSessionSource, type ManagedAgentMetadataV1, type ManagedAgentRegistrySnapshotV1 } from "./registry-contract.js";

interface Entry extends Omit<ManagedAgentMetadataV1, "lifecycle" | "state"> { controllerId: string; ended: boolean }
interface Catalog { schemaVersion: 1; binding: HubResourceBindingV1; revision: number; entries: Entry[] }
export interface ManagedAgentRegistryOptions {
  /** Trusted Host context; none of these values come from Agent messages or renderer claims. */
  home: string; scopeKey: string; generation: string; globalQuota: HaraStorageQuota;
  assertCurrent(): void;
  now?: () => Date;
}
export interface ManagedAgentCreated {
  sessionId: string; sessionSource: ManagedSessionSource; engine: ManagedAgentEngine;
  /** Explicit launch input only. Never provider title, transcript, cwd or first message. */
  displayName?: string;
}
const FILE = "agents.json";
const LABELS = { codex: "Codex", claude: "Claude Code", opencode: "OpenCode" };
const fail = (): never => { throw new AgentHubError("registry_unavailable"); };

/**
 * Source A only. The Host owns this object and passes it to its external-session registry and W0.
 * No native adapter, process scanner, history reader, terminal input or dispatch port is accepted.
 */
export class ManagedAgentRegistry implements AgentHubDirectory {
  private readonly binding: HubResourceBindingV1;
  private readonly namespace: readonly string[];
  private readonly controllerId = randomUUID();
  private readonly active = new Map<string, string>();
  private file?: PrivateStateFileBinding;
  private seenFile = false;
  private unavailable = false;
  private closed = false;
  constructor(private readonly options: ManagedAgentRegistryOptions) {
    this.binding = parseRegistryBinding({ schemaVersion: 1, scopeKey: options.scopeKey, generation: options.generation });
    options.globalQuota.assertHome(options.home);
    this.namespace = ["agent-registry", options.scopeKey, options.generation];
  }
  async prepare(): Promise<void> {
    this.current(); await this.options.globalQuota.prepare(); this.current();
  }
  private current(): void {
    if (this.closed || this.unavailable || this.options.assertCurrent() !== undefined) return fail();
  }
  private bound(): PrivateStateFileBinding {
    this.file ??= bindPrivateHaraStateFile(this.options.home, this.namespace, FILE);
    assertPrivateStateDirectory(this.file.directory);
    return this.file;
  }
  private timestamp(): string { return (this.options.now?.() ?? new Date()).toISOString(); }
  private read(): { value: Catalog; text: string | null } {
    this.current();
    const file = this.bound(), text = readPrivateStateFileSnapshotSync(file.path, AGENT_REGISTRY_LIMITS.bytes)?.text ?? null;
    assertPrivateStateDirectory(file.directory);
    if (text === null) {
      if (this.seenFile || this.active.size) return fail();
      return { text, value: { schemaVersion: 1, binding: this.binding, revision: 0, entries: [] } };
    }
    this.seenFile = true;
    const row = registryRecord(JSON.parse(text), ["schemaVersion", "binding", "revision", "entries"]);
    const binding = parseRegistryBinding(row.binding);
    if (row.schemaVersion !== 1 || binding.scopeKey !== this.binding.scopeKey || binding.generation !== this.binding.generation
      || !Number.isSafeInteger(row.revision) || Number(row.revision) < 1
      || !Array.isArray(row.entries) || row.entries.length > AGENT_REGISTRY_LIMITS.agents) return fail();
    const entries: Entry[] = [], ids = new Set<string>();
    for (const raw of row.entries) {
      const entry = registryRecord(raw, ["agentId", "instanceId", "alias", "displayName", "engine", "sessionSource",
        "createdAt", "registeredAt", "controllerId", "ended"]);
      if (!registryInstance(entry.controllerId) || typeof entry.ended !== "boolean") return fail();
      const { controllerId, ended, ...metadata } = entry;
      const parsed = parseManagedAgentMetadata({ ...metadata, lifecycle: "unknown", state: "unknown" });
      if (ids.has(parsed.agentId)) return fail();
      ids.add(parsed.agentId);
      const { lifecycle: _lifecycle, state: _state, ...stored } = parsed;
      entries.push({ ...stored, controllerId, ended });
    }
    return { text, value: { schemaVersion: 1, binding, revision: Number(row.revision), entries } };
  }
  private write(value: Catalog, previous: string | null): void {
    this.current();
    const text = JSON.stringify(value), bytes = Buffer.byteLength(text);
    if (bytes > AGENT_REGISTRY_LIMITS.bytes) return fail();
    const file = this.bound();
    const size = () => {
      try {
        const info = lstatSync(file.path);
        if (!info.isFile() || info.isSymbolicLink()) return fail();
        return info.size;
      } catch (error: any) { if (error?.code === "ENOENT") return 0; throw error; }
    };
    this.options.globalQuota.admitGrowth(bytes);
    const before = size();
    try {
      writePrivateStateFileSync(file, text, {
        ...(previous === null ? { expectedMissing: true } : { expectedText: previous }),
        assertCurrent: () => { this.current(); this.options.globalQuota.admitGrowth(0); },
      });
      this.seenFile = true;
    } finally {
      try { this.options.globalQuota.recordChange(size() - before); }
      catch (error) { this.options.globalQuota.uncertainMutation(); throw error; }
    }
  }
  private transaction(action: () => void): void {
    this.current();
    this.options.globalQuota.run(() => withPrivateStateLockSync(this.options.home, this.namespace, "registry",
      () => { this.current(); action(); }, { attempts: 10, waitMs: 5 }));
  }
  private fence(): void { this.unavailable = true; this.active.clear(); }
  /** An observation failure is visible as unavailable; never retry native creation. */
  invalidate(): void { this.fence(); }

  /**
   * Observe a successful, explicit Hara creation. A failed metadata publication fences the directory,
   * but must not turn a successful native creation into a retryable error and create a second Agent.
   */
  recordCreated(input: ManagedAgentCreated): void {
    if (this.closed || this.unavailable) return;
    try {
      const instanceId = randomUUID();
      this.transaction(() => {
        const { value, text } = this.read(), previous = value.entries.find(entry => entry.agentId === input.sessionId);
        const now = this.timestamp();
        const metadata = parseManagedAgentMetadata({
          agentId: input.sessionId, instanceId, alias: "agent-" + input.sessionId,
          displayName: registryLabel(input.displayName) ? input.displayName : LABELS[input.engine] + " " + input.sessionId.slice(-6),
          engine: input.engine, sessionSource: input.sessionSource,
          createdAt: previous?.createdAt ?? now, registeredAt: now, lifecycle: "registered", state: "unknown",
        });
        if (!previous && value.entries.length >= AGENT_REGISTRY_LIMITS.agents) return fail();
        const { lifecycle: _lifecycle, state: _state, ...stored } = metadata;
        value.entries = value.entries.filter(entry => entry.agentId !== stored.agentId);
        value.entries.push({ ...stored, controllerId: this.controllerId, ended: false });
        if (!Number.isSafeInteger(value.revision + 1)) return fail();
        value.revision++;
        this.write(value, text);
      });
      this.active.set(input.sessionId, instanceId);
    } catch { this.fence(); }
  }
  /** Capture before awaiting an explicit removal; a late result cannot retire a newer instance. */
  captureInstance(agentId: string): string | null { return this.active.get(agentId) ?? null; }
  recordRemoved(agentId: string, expectedInstance: string | null): void {
    if (!expectedInstance || this.closed || this.unavailable) return;
    try {
      this.transaction(() => {
        const { value, text } = this.read();
        const entry = value.entries.find(candidate => candidate.agentId === agentId);
        if (!entry || entry.instanceId !== expectedInstance || entry.controllerId !== this.controllerId || entry.ended) return;
        entry.ended = true;
        if (!Number.isSafeInteger(value.revision + 1)) return fail();
        value.revision++; this.write(value, text);
      });
      if (this.active.get(agentId) === expectedInstance) this.active.delete(agentId);
    } catch { this.fence(); }
  }
  registeredAgent(agentId: string): RegisteredHubAgent | null {
    try {
      const { value } = this.read(), entry = value.entries.find(candidate => candidate.agentId === agentId);
      if (!entry || entry.ended || entry.controllerId !== this.controllerId || this.active.get(agentId) !== entry.instanceId) return null;
      const { instanceId, alias, displayName, engine } = entry;
      return { agentId, instanceId, alias, displayName, engine };
    } catch { this.fence(); return fail(); }
  }
  snapshot(): ManagedAgentRegistrySnapshotV1 {
    const base = { contract: AGENT_REGISTRY_CONTRACT, schemaVersion: 1 as const, binding: this.binding,
      source: "core-managed" as const, capturedAt: this.timestamp() };
    try {
      const { value } = this.read();
      const agents = value.entries.map(entry => {
        const { controllerId, ended, ...metadata } = entry;
        const current = controllerId === this.controllerId && this.active.get(entry.agentId) === entry.instanceId;
        return { ...metadata, lifecycle: ended ? "ended" as const : current ? "registered" as const : "unknown" as const, state: "unknown" as const };
      });
      return parseManagedAgentRegistrySnapshot({ ...base, availability: "available", revision: value.revision, agents, error: null });
    } catch {
      this.fence();
      return parseManagedAgentRegistrySnapshot({ ...base, availability: "unavailable", revision: null, agents: [], error: "registry_unavailable" });
    }
  }
  /** Retires this controller's registrations; does not claim every native process exited. */
  close(): void { this.closed = true; this.active.clear(); }
}
