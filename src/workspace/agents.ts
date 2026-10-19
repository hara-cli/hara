// Host-private Agent catalog. No ambient role discovery, constructor IO, cloud actor provisioning,
// execution activation or automatic migration. Imported prompts never become configuration authority.
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { scanMemory } from "../memory/guard.js";
import { redactSensitiveText } from "../security/secrets.js";
import { validateWorkspaceLegacyToolPolicy, type WorkspaceLegacyToolPolicy } from "./legacy-role-policy.js";
import { AgentRuntimeRegistry, type AgentRuntimeOption } from "../agent-runtime/registry.js";
import { isAgentRuntimeId, type AgentRuntimeId } from "../agent-runtime/bindings.js";
import {
  normalizeAgentPublicIdentityInput, type AgentPublicIdentity, type AgentPublicIdentityInput,
} from "../org/agent-identity.js";
import { withPrivateStateLockSync, writePrivateStateFileSync } from "../security/private-state.js";
import {
  currentWorkspaceResourceBinding, inspectWorkspaceResourceFile, sameWorkspaceResourceBinding,
  workspaceResourceCommitGuard, workspaceResourceScopeKey, workspaceStateHome,
  parseWorkspaceResourceScope,
  type WorkspaceResourceBinding, type WorkspaceResourceScope,
} from "./resource-context.js";
import {
  freezeWorkspaceAgentTaskBinding, isWorkspaceAgentId, isWorkspaceAgentTaskBinding,
  type WorkspaceAgentTaskBinding,
} from "./agent-binding.js";

const FILE = "workspace-agents.json";
const OWNER = "workspace-agents-owner.json";
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_AGENTS = 256;
const MAX_CONFIGS = 64;
const USERNAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const PROFILE_FIELDS = ["displayName", "title", "bio", "traits", "emoji", "avatar", "theme", "accent", "character"];

export interface WorkspaceAgentPersonaInput {
  profile: AgentPublicIdentityInput;
  description?: string;
  instructions?: string;
}
export interface WorkspaceAgentCreateInput extends WorkspaceAgentPersonaInput {
  username: string;
  runtimeId?: AgentRuntimeId;
}
/** Private immutable configuration, never a renderer/catalog DTO. */
export interface WorkspaceAgentConfiguration {
  revision: number;
  identity: AgentPublicIdentity;
  description: string;
  instructions: string;
  runtimeId: AgentRuntimeId;
  hash: string;
  toolPolicy?: WorkspaceLegacyToolPolicy;
}
export interface WorkspaceLegacyAgentInput extends WorkspaceAgentPersonaInput {
  username: string; state: "active" | "archived"; importId: string; sourceHash: string; toolPolicy: WorkspaceLegacyToolPolicy;
}
interface AgentRecord {
  agentId: string;
  username: string;
  kind: "main" | "colleague";
  state: "active" | "archived";
  epoch: number;
  currentConfigRevision: number;
  configurations: WorkspaceAgentConfiguration[];
  legacy?: { importId: string; sourceHash: string };
}
interface Owner {
  schemaVersion: 1;
  resourceBinding: WorkspaceResourceBinding;
  workspaceId: string;
  mainAgentId: string;
}
interface Manifest extends Owner { revision: number; agents: AgentRecord[] }

export interface WorkspaceAgentView {
  workspaceId: string;
  agentId: string;
  username: string;
  kind: "main" | "colleague";
  state: "active" | "archived";
  agentEpoch: number;
  configRevision: number;
  identity: AgentPublicIdentity;
  description: string;
  runtime: AgentRuntimeOption;
  /** Main Hara uses the packaged product mark, not a private prompt-supplied path. */
  brand?: "hara";
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function keys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  return required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0; }
function invalid(): never { throw new Error("invalid or unsupported Workspace Agent state; existing data was preserved"); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function hashConfiguration(config: Omit<WorkspaceAgentConfiguration, "hash">): string {
  return createHash("sha256").update("hara-workspace-agent-config-v1\0").update(canonical(config)).digest("hex");
}
function persona(value: unknown, username: string): Omit<WorkspaceAgentConfiguration, "revision" | "runtimeId" | "hash"> {
  if (!object(value) || !keys(value, ["profile"], ["description", "instructions"]) || !object(value.profile)
    || !keys(value.profile, ["displayName"], PROFILE_FIELDS.slice(1))) throw new Error("invalid Workspace Agent persona input");
  const description = value.description ?? "", instructions = value.instructions ?? "";
  if (typeof description !== "string" || description.length > 180 || /[\u0000-\u001f\u007f-\u009f]/.test(description)
    || typeof instructions !== "string" || instructions.length > 32_000 || instructions.includes("\0")) {
    throw new Error("Workspace Agent persona exceeds its safe limits");
  }
  return { identity: normalizeAgentPublicIdentityInput(value.profile, username, "global"), description, instructions };
}
function configuration(input: ReturnType<typeof persona>, revision: number, runtimeId: AgentRuntimeId, toolPolicy?: WorkspaceLegacyToolPolicy): WorkspaceAgentConfiguration {
  const value = { revision, ...input, runtimeId, ...(toolPolicy ? { toolPolicy: validateWorkspaceLegacyToolPolicy(toolPolicy) } : {}) };
  return { ...value, hash: hashConfiguration(value) };
}
function parseConfiguration(value: unknown, username: string): WorkspaceAgentConfiguration {
  if (!object(value) || !keys(value, ["revision", "identity", "description", "instructions", "runtimeId", "hash"], ["toolPolicy"])
    || !positive(value.revision) || !isAgentRuntimeId(value.runtimeId) || !object(value.identity)
    || !keys(value.identity, ["version", "displayName", "source"], PROFILE_FIELDS.slice(1))
    || value.identity.version !== 1 || value.identity.source !== "hara") return invalid();
  const { version: _version, source: _source, ...profile } = value.identity;
  const next = configuration(persona({ profile, description: value.description, instructions: value.instructions }, username), value.revision, value.runtimeId,
    value.toolPolicy === undefined ? undefined : validateWorkspaceLegacyToolPolicy(value.toolPolicy));
  if (canonical(next.identity) !== canonical(value.identity) || next.hash !== value.hash) return invalid();
  return next;
}

/** Construct inside WorkspaceResources only. Every operation requires its original explicit context;
 * none falls through to ~/.hara/roles, project/Claude/external/plugin roles or legacy Runtime stores. */
export class WorkspaceAgentStore {
  private readonly scopeKey: string;
  private readonly scope: WorkspaceResourceScope;
  private readonly runtimes = new AgentRuntimeRegistry();
  constructor(scope: WorkspaceResourceScope) {
    this.scope = parseWorkspaceResourceScope(scope);
    this.scopeKey = workspaceResourceScopeKey(this.scope);
  }

  private binding(): WorkspaceResourceBinding {
    workspaceStateHome();
    const binding = currentWorkspaceResourceBinding();
    if (!binding || binding.scopeKey !== this.scopeKey) throw new Error("Workspace Agent store requires its exact resource context");
    return binding;
  }
  private file(name: string, cap: number) {
    return inspectWorkspaceResourceFile(join(workspaceStateHome(), ".hara", name), cap);
  }
  private parseOwner(value: unknown): Owner {
    if (!object(value) || !keys(value, ["schemaVersion", "resourceBinding", "workspaceId", "mainAgentId"])
      || value.schemaVersion !== 1 || value.workspaceId !== this.scope.workspaceId
      || !isWorkspaceAgentId(value.mainAgentId)
      || !sameWorkspaceResourceBinding(value.resourceBinding as WorkspaceResourceBinding, this.binding())) return invalid();
    return structuredClone(value) as unknown as Owner;
  }
  private load() {
    this.binding();
    const ownerFile = this.file(OWNER, 4096), file = this.file(FILE, MAX_BYTES);
    if (!ownerFile.snapshot && !file.snapshot) return { file, ownerFile, value: null };
    if (!ownerFile.snapshot || !file.snapshot) throw new Error("Workspace Agent catalog or owner marker is missing; existing data was preserved");
    let raw: unknown, rawOwner: unknown;
    try { raw = JSON.parse(file.snapshot.text); rawOwner = JSON.parse(ownerFile.snapshot.text); } catch { return invalid(); }
    const owner = this.parseOwner(rawOwner);
    if (!object(raw) || !keys(raw, ["schemaVersion", "resourceBinding", "workspaceId", "mainAgentId", "revision", "agents"])
      || !positive(raw.revision) || !Array.isArray(raw.agents) || raw.agents.length < 1 || raw.agents.length > MAX_AGENTS) return invalid();
    const { revision, agents, ...rawManifestOwner } = raw;
    if (canonical(this.parseOwner(rawManifestOwner)) !== canonical(owner)) return invalid();
    const ids = new Set<string>(), usernames = new Set<string>();
    const rows: AgentRecord[] = agents.map(value => {
      if (!object(value) || !keys(value, ["agentId", "username", "kind", "state", "epoch", "currentConfigRevision", "configurations"], ["legacy"])
        || !isWorkspaceAgentId(value.agentId) || ids.has(value.agentId)
        || typeof value.username !== "string" || !USERNAME.test(value.username) || usernames.has(value.username)
        || (value.kind !== "main" && value.kind !== "colleague") || (value.state !== "active" && value.state !== "archived")
        || !positive(value.epoch) || !positive(value.currentConfigRevision) || !Array.isArray(value.configurations)
        || value.configurations.length < 1 || value.configurations.length > MAX_CONFIGS) return invalid();
      if (value.kind === "main" ? (value.agentId !== owner.mainAgentId || value.username !== "hara" || value.state !== "active")
        : (value.agentId === owner.mainAgentId || value.username === "hara" || value.username === "main")) return invalid();
      if (value.legacy !== undefined && (!object(value.legacy) || !keys(value.legacy, ["importId", "sourceHash"])
        || !/^[a-f0-9]{64}$/.test(String(value.legacy.importId)) || !/^[a-f0-9]{64}$/.test(String(value.legacy.sourceHash)) || value.kind !== "colleague")) return invalid();
      const configurations = value.configurations.map(entry => parseConfiguration(entry, value.username as string));
      if (configurations.some((entry, index) => entry.revision !== index + 1)
        || value.currentConfigRevision !== configurations.length) return invalid();
      ids.add(value.agentId); usernames.add(value.username);
      return { ...value, configurations } as unknown as AgentRecord;
    });
    if (rows.filter(row => row.kind === "main").length !== 1) return invalid();
    file.assertCurrent(); ownerFile.assertCurrent();
    return { file, ownerFile, value: { ...owner, revision, agents: rows } as Manifest };
  }
  private persist(loaded: ReturnType<WorkspaceAgentStore["load"]>, value: Manifest): void {
    const text = JSON.stringify(value) + "\n";
    if (Buffer.byteLength(text) > MAX_BYTES || value.agents.length > MAX_AGENTS) throw new Error("Workspace Agent catalog is full; existing data was preserved");
    loaded.file.assertCurrent(); loaded.ownerFile.assertCurrent();
    const assertResourceCurrent = workspaceResourceCommitGuard();
    const { revision: _revision, agents: _agents, ...expectedOwner } = value;
    const assertCurrent = (): void => {
      assertResourceCurrent?.(); loaded.file.assertCurrent(); loaded.ownerFile.assertCurrent();
      const owner = this.file(OWNER, 4096).snapshot;
      if (!owner) throw new Error("Workspace Agent owner marker disappeared; existing data was preserved");
      let parsed: unknown;
      try { parsed = JSON.parse(owner.text); } catch { return invalid(); }
      if (canonical(this.parseOwner(parsed)) !== canonical(expectedOwner)) return invalid();
    };
    writePrivateStateFileSync(loaded.file, text, {
      ...(loaded.file.snapshot ? { expectedText: loaded.file.snapshot.text } : { expectedMissing: true }),
      assertCurrent,
    });
  }
  private view(row: AgentRecord): WorkspaceAgentView {
    const config = row.configurations[row.currentConfigRevision - 1]!;
    return { workspaceId: this.scope.workspaceId, agentId: row.agentId, username: row.username, kind: row.kind,
      state: row.state, agentEpoch: row.epoch, configRevision: config.revision, identity: structuredClone(config.identity),
      description: config.description, runtime: this.runtimes.options().find(option => option.id === config.runtimeId)!,
      ...(row.kind === "main" ? { brand: "hara" as const } : {}) };
  }
  list() {
    const value = this.load().value;
    return { revision: value?.revision ?? 0, mainAgentId: value?.mainAgentId ?? null,
      agents: value?.agents.map(row => this.view(row)) ?? [] };
  }
  get(agentId: string): WorkspaceAgentView | null {
    if (!isWorkspaceAgentId(agentId)) throw new Error("invalid Workspace Agent id");
    const row = this.load().value?.agents.find(entry => entry.agentId === agentId);
    return row ? this.view(row) : null;
  }
  runtimeOptions(): AgentRuntimeOption[] { this.binding(); return this.runtimes.options(); }

  /** Explicit first creation only. A partial/missing catalog is never healed or imported from legacy. */
  initializeMain(input: WorkspaceAgentPersonaInput = { profile: { displayName: "Hara", title: "Root Orchestrator" } }): WorkspaceAgentView {
    this.binding();
    const normalized = persona(input, "hara");
    this.runtimes.assertAvailable("pi");
    return withPrivateStateLockSync(workspaceStateHome(), [], "workspace-agents", () => {
      const loaded = this.load();
      if (loaded.value) return this.view(loaded.value.agents.find(row => row.kind === "main")!);
      const owner: Owner = { schemaVersion: 1, resourceBinding: { ...this.binding() }, workspaceId: this.scope.workspaceId, mainAgentId: `ag_${randomUUID()}` };
      const main: AgentRecord = { agentId: owner.mainAgentId, username: "hara", kind: "main", state: "active", epoch: 1,
        currentConfigRevision: 1, configurations: [configuration(normalized, 1, "pi")] };
      writePrivateStateFileSync(loaded.ownerFile, JSON.stringify(owner) + "\n", { expectedMissing: true, assertCurrent: workspaceResourceCommitGuard() });
      this.persist(loaded, { ...owner, revision: 1, agents: [main] });
      return this.view(main);
    });
  }
  create(input: WorkspaceAgentCreateInput, expectedCatalogRevision: number): WorkspaceAgentView {
    this.binding();
    if (!object(input) || !keys(input, ["username", "profile"], ["description", "instructions", "runtimeId"])
      || typeof input.username !== "string" || !USERNAME.test(input.username) || ["main", "hara"].includes(input.username)
      || !positive(expectedCatalogRevision)) throw new Error("invalid Workspace Agent creation");
    const { username, runtimeId = "pi", ...fields } = input;
    const normalized = persona(fields, username);
    if (!isAgentRuntimeId(runtimeId)) throw new Error("invalid Workspace Agent Runtime");
    this.runtimes.assertAvailable(runtimeId);
    return withPrivateStateLockSync(workspaceStateHome(), [], "workspace-agents", () => {
      const loaded = this.load(), value = loaded.value;
      if (!value || value.revision !== expectedCatalogRevision) throw new Error("Workspace Agent catalog changed; reload before creating");
      if (value.agents.some(row => row.username === username)) throw new Error("Workspace Agent username is retained; restore the exact archived colleague or choose another");
      if (value.agents.filter(row => row.kind === "colleague" && row.state === "active").length >= 10) throw new Error("Ten active colleague slots are full; archive one before creating another");
      const row: AgentRecord = { agentId: `ag_${randomUUID()}`, username, kind: "colleague", state: "active", epoch: 1,
        currentConfigRevision: 1, configurations: [configuration(normalized, 1, runtimeId)] };
      value.agents.push(row); this.advance(value); this.persist(loaded, value);
      return this.view(row);
    });
  }
  private advance(value: Manifest): void {
    if (value.revision >= Number.MAX_SAFE_INTEGER) throw new Error("Workspace Agent catalog revision exhausted");
    value.revision++;
  }
  private update(agentId: string, configRevision: number, agentEpoch: number, change: (row: AgentRecord, value: Manifest) => void): WorkspaceAgentView {
    this.binding();
    if (!isWorkspaceAgentId(agentId) || !positive(configRevision) || !positive(agentEpoch)) throw new Error("invalid Workspace Agent update");
    return withPrivateStateLockSync(workspaceStateHome(), [], "workspace-agents", () => {
      const loaded = this.load(), value = loaded.value;
      const row = value?.agents.find(entry => entry.agentId === agentId);
      if (!value || !row || row.currentConfigRevision !== configRevision || row.epoch !== agentEpoch) throw new Error("Workspace Agent changed; refresh the exact colleague before editing");
      change(row, value); this.advance(value); this.persist(loaded, value);
      return this.view(row);
    });
  }
  private appendConfiguration(row: AgentRecord, input: ReturnType<typeof persona>, runtimeId: AgentRuntimeId): void {
    if (row.state !== "active") throw new Error("restore the exact archived Workspace Agent before editing");
    if (row.configurations.length >= MAX_CONFIGS) throw new Error("Workspace Agent configuration history is full; no snapshot was removed");
    row.currentConfigRevision++;
    row.configurations.push(configuration(input, row.currentConfigRevision, runtimeId, row.configurations.at(-1)!.toolPolicy));
  }
  updatePersona(agentId: string, input: WorkspaceAgentPersonaInput, configRevision: number, agentEpoch: number): WorkspaceAgentView {
    const normalized = persona(input, "agent");
    return this.update(agentId, configRevision, agentEpoch, row => {
      this.appendConfiguration(row, normalized, row.configurations[row.currentConfigRevision - 1]!.runtimeId);
    });
  }
  setRuntime(agentId: string, runtimeId: AgentRuntimeId, configRevision: number, agentEpoch: number): WorkspaceAgentView {
    if (!isAgentRuntimeId(runtimeId)) throw new Error("invalid Workspace Agent Runtime");
    this.runtimes.assertAvailable(runtimeId);
    return this.update(agentId, configRevision, agentEpoch, row => {
      const { identity, description, instructions } = row.configurations[row.currentConfigRevision - 1]!;
      this.appendConfiguration(row, { identity, description, instructions }, runtimeId);
    });
  }
  setArchived(agentId: string, archived: boolean, configRevision: number, agentEpoch: number): WorkspaceAgentView {
    if (typeof archived !== "boolean") throw new Error("invalid Workspace Agent lifecycle update");
    return this.update(agentId, configRevision, agentEpoch, (row, value) => {
      if (row.kind === "main") throw new Error("the Workspace main Hara cannot be archived or replaced");
      if ((row.state === "archived") === archived) throw new Error("Workspace Agent lifecycle already changed; refresh before editing");
      if (row.epoch >= Number.MAX_SAFE_INTEGER) throw new Error("Workspace Agent lifecycle epoch exhausted");
      if (!archived && value.agents.filter(row => row.kind === "colleague" && row.state === "active").length >= 10) throw new Error("Ten active colleague slots are full; archive one before restoring another");
      row.state = archived ? "archived" : "active"; row.epoch++;
    });
  }
  /** Explicit owner importer, NOT an Agent/RPC method or ambient roles discovery. All sources are
   * validated before the atomic catalog update; a matching import never overwrites newer edits. */
  importLegacy(rows: readonly WorkspaceLegacyAgentInput[], expected: number) {
    this.binding();
    if (!Array.isArray(rows) || rows.length > 128 || !positive(expected)) throw new Error("Invalid legacy Agent batch");
    const normalized = rows.map(row => {
      if (!object(row) || !keys(row, ["username", "profile", "state", "importId", "sourceHash", "toolPolicy"], ["description", "instructions"])
        || typeof row.username !== "string" || !USERNAME.test(row.username) || ["hara", "main"].includes(row.username)
        || typeof row.state !== "string" || !["active", "archived"].includes(row.state)
        || typeof row.importId !== "string" || typeof row.sourceHash !== "string"
        || !/^[a-f0-9]{64}$/.test(row.importId) || !/^[a-f0-9]{64}$/.test(row.sourceHash)) throw new Error("Invalid legacy Agent identity");
      const { username, state, importId, sourceHash, toolPolicy, ...fields } = row;
      const config = configuration(persona(fields, username), 1, "pi", validateWorkspaceLegacyToolPolicy(toolPolicy));
      if (!scanMemory(config.instructions).ok || redactSensitiveText(JSON.stringify(config)).redactions.length) throw new Error("Legacy Agent source requires quarantine");
      return { username, state: state as "active" | "archived", importId, sourceHash, config };
    });
    if (new Set(normalized.map(row => row.username)).size !== rows.length || new Set(normalized.map(row => row.importId)).size !== rows.length) throw new Error("Duplicate legacy Agent identity");
    this.runtimes.assertAvailable("pi");
    return withPrivateStateLockSync(workspaceStateHome(), [], "workspace-agents", () => {
      const loaded = this.load(), value = loaded.value;
      if (!value || value.revision !== expected) throw new Error("Workspace Agent catalog changed; refresh before inheritance");
      const fresh = normalized.filter(row => {
        const old = value.agents.find(agent => agent.legacy?.importId === row.importId);
        if (old) {
          if (old.username !== row.username || old.legacy!.sourceHash !== row.sourceHash || old.configurations[0]!.hash !== row.config.hash) throw new Error("Legacy Agent source changed; both versions preserved");
          return false;
        }
        if (value.agents.some(agent => agent.username === row.username)) throw new Error("Legacy Agent conflicts with an existing colleague; neither was replaced");
        return true;
      });
      if (value.agents.filter(row => row.kind === "colleague" && row.state === "active").length + fresh.filter(row => row.state === "active").length > 10) throw new Error("Legacy active selection exceeds ten colleague slots");
      if (fresh.length) {
        value.agents.push(...fresh.map(row => ({ agentId: `ag_${randomUUID()}`, username: row.username, kind: "colleague" as const, state: row.state, epoch: 1,
          currentConfigRevision: 1, configurations: [row.config], legacy: { importId: row.importId, sourceHash: row.sourceHash } })));
        this.advance(value); this.persist(loaded, value);
      }
      return { imported: fresh.length, agents: value.agents.filter(row => normalized.some(input => input.importId === row.legacy?.importId)).map(row => this.view(row)) };
    });
  }
  freezeTask(taskId: string, agentId: string, configRevision: number, agentEpoch: number): Readonly<WorkspaceAgentTaskBinding> {
    const value = this.load().value, row = value?.agents.find(entry => entry.agentId === agentId);
    if (!row || row.state !== "active" || row.currentConfigRevision !== configRevision || row.epoch !== agentEpoch) throw new Error("Workspace Agent changed; no task binding was created");
    const config = row.configurations[row.currentConfigRevision - 1]!;
    this.runtimes.assertAvailable(config.runtimeId);
    return freezeWorkspaceAgentTaskBinding({ schemaVersion: 1, workspaceId: this.scope.workspaceId, resourceBinding: this.binding(),
      agentId: row.agentId, agentEpoch: row.epoch, configRevision: config.revision, configHash: config.hash, runtimeId: config.runtimeId, taskId });
  }
  /** Private snapshot resolution, NOT execution admission. Callers still need live membership, policy,
   * Host/resource grants and fully scoped dependencies. Old runners explicitly refuse this provenance. */
  resolveTask(binding: Readonly<WorkspaceAgentTaskBinding>): Readonly<WorkspaceAgentConfiguration> {
    if (!isWorkspaceAgentTaskBinding(binding) || binding.workspaceId !== this.scope.workspaceId
      || !sameWorkspaceResourceBinding(binding.resourceBinding, this.binding())) throw new Error("task does not belong to this Workspace Agent resource scope");
    const row = this.load().value?.agents.find(entry => entry.agentId === binding.agentId);
    if (!row || row.state !== "active" || row.epoch !== binding.agentEpoch) throw new Error("Workspace Agent task lifecycle is no longer active");
    const config = row.configurations[binding.configRevision - 1];
    if (!config || config.hash !== binding.configHash || config.runtimeId !== binding.runtimeId) throw new Error("Workspace Agent task configuration snapshot is unavailable; no fallback was selected");
    this.runtimes.assertAvailable(config.runtimeId);
    const result = structuredClone(config);
    if (result.identity.traits) Object.freeze(result.identity.traits);
    Object.freeze(result.identity);
    return Object.freeze(result);
  }
}
