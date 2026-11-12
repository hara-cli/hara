import { migrateDefaultLabels, DEFAULT_ORCHESTRATOR_TITLES } from "../i18n/default-labels.js";
// Host-private Agent catalog. No ambient role discovery, constructor IO, cloud actor provisioning,
// execution activation or automatic migration. Imported prompts never become configuration authority.
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { scanMemory } from "../memory/guard.js";
import { redactSensitiveText } from "../security/secrets.js";
import { validateWorkspaceLegacyToolPolicy, type WorkspaceLegacyToolPolicy } from "./legacy-role-policy.js";
import { AgentRuntimeRegistry, type AgentRuntimeOption } from "../agent-runtime/registry.js";
import type { WorkspaceRuntimeInstaller } from "./runtime-install.js";
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

import { availableRuntimePermissionTiers, defaultRuntimePermissionTier, isRuntimePermissionTier, RuntimeTierUnavailableError, type RuntimePermissionTier } from "../agent-runtime/execution-policy.js";

const FILE = "workspace-agents.json";
const OWNER = "workspace-agents-owner.json";
const MAX_BYTES = 2 * 1024 * 1024;
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
  permissionTier?: RuntimePermissionTier;
}
export interface WorkspaceAgentBatchRow extends WorkspaceAgentCreateInput { draftKey: string }
export interface WorkspaceAgentBatchInput { runId: string; rows: WorkspaceAgentBatchRow[] }
/** Trusted Host preflight only, never part of the RPC envelope. Null means no available engine. */
export type WorkspaceAgentBatchDefault = Readonly<{ kind: "resolved"; runtimeId: AgentRuntimeId | null }
  | { kind: "preference_unavailable" }>;
export type WorkspaceAgentBatchFailure = "invalid_request" | "runtime_unconfirmed" | "runtime_unavailable"
  | "permission_tier_unavailable" | "username_taken" | "catalog_changed" | "batch_limit";
export type WorkspaceAgentBatchResult = { index: number; draftKey: string; status: "created" | "exists"; agent: WorkspaceAgentView }
  | { index: number; draftKey: string; status: "failed"; reason: WorkspaceAgentBatchFailure };
const BATCH_RUN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const DRAFT_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** Private immutable configuration, never a renderer/catalog DTO. */
export interface WorkspaceAgentConfiguration {
  revision: number;
  identity: AgentPublicIdentity;
  description: string;
  instructions: string;
  runtimeId: AgentRuntimeId;
  permissionTier?: RuntimePermissionTier;
  hash: string;
  toolPolicy?: WorkspaceLegacyToolPolicy;
}
export interface WorkspaceLegacyAgentInput extends WorkspaceAgentPersonaInput {
  username: string; state: "active" | "archived"; importId: string; sourceHash: string; toolPolicy: WorkspaceLegacyToolPolicy;
}
interface AgentRecord {
  /** Successful onboarding admission, committed atomically with this retained Agent. Never an execution grant. */
  creation?: { runId: string; draftKey: string };
  titleSource?: "default";
  titleKey?: "core.name.orchestrator";
  agentId: string;
  username: string;
  kind: "main" | "colleague";
  state: "active" | "archived";
  epoch: number;
  currentConfigRevision: number;
  configurations: WorkspaceAgentConfiguration[];
  legacy?: { importId: string; sourceHash: string };
  archivedAt?: string;
  pausedScheduleCount?: number;
}
interface Owner {
  schemaVersion: 1;
  resourceBinding: WorkspaceResourceBinding;
  workspaceId: string;
  mainAgentId: string;
}
interface Manifest extends Owner { revision: number; agents: AgentRecord[] }

export interface WorkspaceAgentView {
  titleSource?: "default";
  titleKey?: "core.name.orchestrator";
  workspaceId: string;
  agentId: string;
  username: string;
  kind: "main" | "colleague";
  state: "active" | "archived";
  agentEpoch: number;
  archivedAt?: string;
  pausedScheduleCount?: number;
  configRevision: number;
  identity: AgentPublicIdentity;
  description: string;
  runtime: AgentRuntimeOption;
  permissionTier: RuntimePermissionTier;
  /** Present only when the stored tier is unavailable on this Host platform (decision B); never silently downgraded. */
  permissionTierUnavailable?: true;
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
/** A configuration that never stored a tier (pre-1.2.0) is controlled, matching frozen task bindings. Only new
 * colleagues receive the platform default; an old configuration is never silently upgraded to full-protected. */
const storedPermissionTier = (config: { permissionTier?: RuntimePermissionTier }): RuntimePermissionTier => config.permissionTier ?? "controlled";
function configuration(input: ReturnType<typeof persona>, revision: number, runtimeId: AgentRuntimeId, toolPolicy?: WorkspaceLegacyToolPolicy, permissionTier: RuntimePermissionTier | null = defaultRuntimePermissionTier()): WorkspaceAgentConfiguration {
  const value = { revision, ...input, runtimeId, ...(permissionTier ? { permissionTier } : {}), ...(toolPolicy ? { toolPolicy: validateWorkspaceLegacyToolPolicy(toolPolicy) } : {}) };
  return { ...value, hash: hashConfiguration(value) };
}
function parseConfiguration(value: unknown, username: string): WorkspaceAgentConfiguration {
  if (!object(value) || !keys(value, ["revision", "identity", "description", "instructions", "runtimeId", "hash"], ["toolPolicy", "permissionTier"])
    || value.permissionTier !== undefined && !isRuntimePermissionTier(value.permissionTier)
    || !positive(value.revision) || !isAgentRuntimeId(value.runtimeId) || !object(value.identity)
    || !keys(value.identity, ["version", "displayName", "source"], PROFILE_FIELDS.slice(1))
    || value.identity.version !== 1 || value.identity.source !== "hara") return invalid();
  const { version: _version, source: _source, ...profile } = value.identity;
  const next = configuration(persona({ profile, description: value.description, instructions: value.instructions }, username), value.revision, value.runtimeId,
    value.toolPolicy === undefined ? undefined : validateWorkspaceLegacyToolPolicy(value.toolPolicy), value.permissionTier as RuntimePermissionTier ?? null);
  if (canonical(next.identity) !== canonical(value.identity) || next.hash !== value.hash) return invalid();
  return next;
}

/** Construct inside WorkspaceResources only. Every operation requires its original explicit context;
 * none falls through to ~/.hara/roles, project/Claude/external/plugin roles or legacy Runtime stores. */
export class WorkspaceAgentStore {
  private readonly scopeKey: string;
  private readonly scope: WorkspaceResourceScope;
  private readonly runtimes: AgentRuntimeRegistry;
  constructor(scope: WorkspaceResourceScope, installer?: WorkspaceRuntimeInstaller) {
    this.scope = parseWorkspaceResourceScope(scope);
    this.scopeKey = workspaceResourceScopeKey(this.scope);
    this.runtimes = new AgentRuntimeRegistry(undefined, installer);
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
    const value = this.parseManifest(raw, owner);
    file.assertCurrent(); ownerFile.assertCurrent();
    return { file, ownerFile, value };
  }
  private parseManifest(raw: unknown, owner: Owner): Manifest {
    if (!object(raw) || !keys(raw, ["schemaVersion", "resourceBinding", "workspaceId", "mainAgentId", "revision", "agents"])
      || !positive(raw.revision) || !Array.isArray(raw.agents) || raw.agents.length < 1) return invalid();
    const { revision, agents, ...rawManifestOwner } = raw;
    if (canonical(this.parseOwner(rawManifestOwner)) !== canonical(owner)) return invalid();
    const ids = new Set<string>(), usernames = new Set<string>(), creations = new Set<string>(), creationCounts = new Map<string, number>();
    const rows: AgentRecord[] = agents.map(value => {
      if (!object(value) || !keys(value, ["agentId", "username", "kind", "state", "epoch", "currentConfigRevision", "configurations"], ["legacy", "archivedAt", "pausedScheduleCount", "titleSource", "titleKey", "creation"])
        || !isWorkspaceAgentId(value.agentId) || ids.has(value.agentId)
        || typeof value.username !== "string" || !USERNAME.test(value.username) || usernames.has(value.username)
        || (value.kind !== "main" && value.kind !== "colleague") || (value.state !== "active" && value.state !== "archived")
        || !positive(value.epoch) || !positive(value.currentConfigRevision) || !Array.isArray(value.configurations)
        || value.configurations.length < 1 || value.configurations.length > MAX_CONFIGS) return invalid();
      if (value.kind === "main" ? (value.agentId !== owner.mainAgentId || value.username !== "hara" || value.state !== "active")
        : (value.agentId === owner.mainAgentId || value.username === "hara" || value.username === "main")) return invalid();
      if (value.creation !== undefined) {
        const mark = value.creation;
        if (value.kind !== "colleague" || !object(mark) || !keys(mark, ["runId", "draftKey"])
          || typeof mark.runId !== "string" || !BATCH_RUN.test(mark.runId) || typeof mark.draftKey !== "string" || !DRAFT_KEY.test(mark.draftKey)) return invalid();
        const key = canonical([mark.runId, mark.draftKey]), count = (creationCounts.get(mark.runId) ?? 0) + 1;
        if (creations.has(key) || count > 8) return invalid(); creations.add(key); creationCounts.set(mark.runId, count);
      }
      if (value.legacy !== undefined && (!object(value.legacy) || !keys(value.legacy, ["importId", "sourceHash"])
        || !/^[a-f0-9]{64}$/.test(String(value.legacy.importId)) || !/^[a-f0-9]{64}$/.test(String(value.legacy.sourceHash)) || value.kind !== "colleague")) return invalid();
      if ((value.archivedAt !== undefined || value.pausedScheduleCount !== undefined) && (value.state !== "archived"
        || typeof value.archivedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.archivedAt)
        || !Number.isFinite(Date.parse(value.archivedAt)) || !Number.isSafeInteger(value.pausedScheduleCount)
        || Number(value.pausedScheduleCount) < 0 || Number(value.pausedScheduleCount) > 4096)) return invalid();
      const configurations = value.configurations.map(entry => parseConfiguration(entry, value.username as string));
      if (configurations.some((entry, index) => entry.revision !== index + 1)
        || value.currentConfigRevision !== configurations.length) return invalid();
      if ((value.titleSource !== undefined || value.titleKey !== undefined) && (value.kind !== "main"
        || value.titleSource !== "default" || value.titleKey !== "core.name.orchestrator"
        || !DEFAULT_ORCHESTRATOR_TITLES.includes(configurations.at(-1)!.identity.title ?? ""))) return invalid();
      ids.add(value.agentId); usernames.add(value.username);
      return { ...value, configurations } as unknown as AgentRecord;
    });
    if (rows.filter(row => row.kind === "main").length !== 1) return invalid();
    return { ...owner, revision, agents: rows } as Manifest;
  }
  private persist(loaded: ReturnType<WorkspaceAgentStore["load"]>, value: Manifest): void {
    const text = JSON.stringify(value) + "\n";
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("Workspace Agent catalog is full; existing data was preserved");
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
  /** Presentation metadata only. Config hashes, epochs and frozen task bindings do not change. */
  migrateDefaultLabels(rollback = false): boolean {
    this.binding();
    return withPrivateStateLockSync(workspaceStateHome(), [], "workspace-agents", () => {
      const loaded = this.load(); if (!loaded.value) return false;
      const owner = this.parseOwner(JSON.parse(loaded.ownerFile.snapshot!.text));
      return migrateDefaultLabels({ file: loaded.file, backup: this.file("workspace-agents-default-labels-v1.json", MAX_BYTES * 3), maxBytes: MAX_BYTES,
        parse: raw => this.parseManifest(raw, owner), rollback,
        assertCurrent: () => { workspaceResourceCommitGuard()?.(); loaded.file.assertCurrent(); loaded.ownerFile.assertCurrent();
          if (this.file(OWNER, 4096).snapshot?.text !== loaded.ownerFile.snapshot!.text) throw new Error("Workspace Agent owner marker changed; state preserved"); },
        mark: value => {
          const row = value.agents.find(row => row.kind === "main");
          if (!row || row.titleSource || !DEFAULT_ORCHESTRATOR_TITLES.includes(row.configurations.at(-1)!.identity.title ?? "")) return false;
          row.titleSource = "default"; row.titleKey = "core.name.orchestrator";
          if (value.revision >= Number.MAX_SAFE_INTEGER) throw new Error("Workspace Agent catalog revision exhausted"); value.revision++; return true;
        },
      });
    });
  }
  private view(row: AgentRecord, runtimes: readonly AgentRuntimeOption[] = this.runtimes.options()): WorkspaceAgentView {
    const config = row.configurations[row.currentConfigRevision - 1]!;
    return { workspaceId: this.scope.workspaceId, agentId: row.agentId, username: row.username, kind: row.kind,
      state: row.state, agentEpoch: row.epoch, configRevision: config.revision, identity: structuredClone(config.identity),
      ...(row.archivedAt ? { archivedAt: row.archivedAt, pausedScheduleCount: row.pausedScheduleCount ?? 0 } : {}),
      description: config.description, permissionTier: storedPermissionTier(config), runtime: { ...runtimes.find(option => option.id === config.runtimeId)! },
      ...(availableRuntimePermissionTiers().includes(storedPermissionTier(config)) ? {} : { permissionTierUnavailable: true as const }),
      ...(row.kind === "main" ? { brand: "hara" as const, ...(row.titleSource ? { titleSource: row.titleSource, titleKey: row.titleKey } : {}) } : {}) };
  }
  currentPersona(agentId: string): WorkspaceAgentPersonaInput {
    this.binding();
    const row = this.load().value?.agents.find(entry => entry.agentId === agentId);
    if (!row) throw new Error("Workspace Agent unavailable");
    const config = row.configurations[row.currentConfigRevision - 1]!;
    const { version: _version, source: _source, ...profile } = config.identity;
    return { profile: structuredClone(profile), description: config.description, instructions: config.instructions };
  }
  list() {
    const value = this.load().value;
    // One read-only roster reply uses one fresh inventory. Task binding/resolution and execution
    // still read availability independently; this snapshot never grants permission to run.
    const runtimes = value?.agents.length ? this.runtimes.options() : [];
    return { revision: value?.revision ?? 0, mainAgentId: value?.mainAgentId ?? null,
      agents: value?.agents.map(row => this.view(row, runtimes)) ?? [] };
  }
  references() {
    return (this.load().value?.agents ?? []).map(row => ({ agentId: row.agentId,
      name: row.configurations[row.currentConfigRevision - 1]!.identity.displayName, state: row.state,
      ...(row.configurations[row.currentConfigRevision - 1]!.identity.title ? { title: row.configurations[row.currentConfigRevision - 1]!.identity.title } : {}),
      aliases: [...new Set([row.username, ...row.configurations.map(config => config.identity.displayName)])] }));
  }
  /** Host-only L0 input. One manifest read, no runtime inventory or model call; never expose instructions in a DTO. */
  channelPrefilterProfiles() {
    return (this.load().value?.agents ?? []).filter(row => row.kind === "colleague" && row.state === "active").map(row => {
      const config = row.configurations[row.currentConfigRevision - 1]!;
      return { agentId: row.agentId, title: config.identity.title ?? "", description: config.description, instructions: config.instructions,
        aliases: [...new Set([row.username, ...row.configurations.map(item => item.identity.displayName)])] };
    });
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
        currentConfigRevision: 1, ...(DEFAULT_ORCHESTRATOR_TITLES.includes(normalized.identity.title ?? "") ? { titleSource: "default" as const, titleKey: "core.name.orchestrator" as const } : {}), configurations: [configuration(normalized, 1, "pi")] };
      writePrivateStateFileSync(loaded.ownerFile, JSON.stringify(owner) + "\n", { expectedMissing: true, assertCurrent: workspaceResourceCommitGuard() });
      this.persist(loaded, { ...owner, revision: 1, agents: [main] });
      return this.view(main);
    });
  }
  create(input: WorkspaceAgentCreateInput, expectedCatalogRevision: number): WorkspaceAgentView {
    this.binding();
    if (!object(input) || !keys(input, ["username", "profile"], ["description", "instructions", "runtimeId", "permissionTier"])
      || typeof input.username !== "string" || !USERNAME.test(input.username) || ["main", "hara"].includes(input.username)
      || !positive(expectedCatalogRevision)) throw new Error("invalid Workspace Agent creation");
    if (input.permissionTier !== undefined && !isRuntimePermissionTier(input.permissionTier)) throw new Error("invalid Workspace Agent permission tier");
    // Decision B: the full tier exists only where the Host has Seatbelt; never accept it elsewhere.
    if (input.permissionTier !== undefined && !availableRuntimePermissionTiers().includes(input.permissionTier)) throw new RuntimeTierUnavailableError();
    const { username, runtimeId = "pi", permissionTier = defaultRuntimePermissionTier(), ...fields } = input;
    const normalized = persona(fields, username);
    if (!isAgentRuntimeId(runtimeId)) throw new Error("invalid Workspace Agent Runtime");
    this.runtimes.assertAvailable(runtimeId);
    return withPrivateStateLockSync(workspaceStateHome(), [], "workspace-agents", () => {
      const loaded = this.load(), value = loaded.value;
      if (!value || value.revision !== expectedCatalogRevision) throw new Error("Workspace Agent catalog changed; reload before creating");
      if (value.agents.some(row => row.username === username)) throw new Error("Workspace Agent username is retained; restore the exact archived colleague or choose another");
      const row: AgentRecord = { agentId: `ag_${randomUUID()}`, username, kind: "colleague", state: "active", epoch: 1,
        currentConfigRevision: 1, configurations: [configuration(normalized, 1, runtimeId, undefined, permissionTier)] };
      value.agents.push(row); this.advance(value); this.persist(loaded, value);
      return this.view(row);
    });
  }
  /** Explicit human UI admission only. Success markers and Agents share one CAS publication, so
   * ACK loss/restart/archive cannot create a second colleague for the same runId + draftKey.
   * Successful keys always return their original Agent; changed retry text never edits it. */
  createBatch(input: WorkspaceAgentBatchInput, expectedCatalogRevision: number, defaultRuntime?: WorkspaceAgentBatchDefault) {
    this.binding();
    if (!object(input) || !keys(input, ["runId", "rows"]) || typeof input.runId !== "string" || !BATCH_RUN.test(input.runId)
      || !Array.isArray(input.rows) || input.rows.length < 1 || input.rows.length > 8 || !positive(expectedCatalogRevision)) throw new Error("Invalid Workspace Agent batch");
    const seen = new Set<string>();
    for (const row of input.rows) {
      if (!object(row) || typeof row.draftKey !== "string" || !DRAFT_KEY.test(row.draftKey) || seen.has(row.draftKey)) throw new Error("Invalid or repeated batch draft key");
      seen.add(row.draftKey);
    }
    if (defaultRuntime !== undefined && (!object(defaultRuntime) || (defaultRuntime.kind === "resolved"
      ? !keys(defaultRuntime, ["kind", "runtimeId"]) || defaultRuntime.runtimeId !== null && (!isAgentRuntimeId(defaultRuntime.runtimeId) || defaultRuntime.runtimeId === "hara")
      : defaultRuntime.kind !== "preference_unavailable" || !keys(defaultRuntime, ["kind"])))) throw new Error("Invalid Workspace Agent batch default");
    const request = structuredClone(input);
    return withPrivateStateLockSync(workspaceStateHome(), [], "workspace-agents", () => {
      const loaded = this.load(), value = loaded.value; if (!value) throw new Error("Workspace Agent catalog unavailable");
      const stale = value.revision !== expectedCatalogRevision, options = this.runtimes.options();
      const results: WorkspaceAgentBatchResult[] = []; let created = 0;
      for (const [index, row] of request.rows.entries()) {
        const failed = (reason: WorkspaceAgentBatchFailure) => results.push({ index, draftKey: row.draftKey, status: "failed", reason });
        const existing = value.agents.find(agent => agent.creation?.runId === request.runId && agent.creation.draftKey === row.draftKey);
        if (existing) { results.push({ index, draftKey: row.draftKey, status: "exists", agent: this.view(existing, options) }); continue; }
        if (stale) { failed("catalog_changed"); continue; }
        if (value.agents.filter(agent => agent.creation?.runId === request.runId).length >= 8) { failed("batch_limit"); continue; }
        if (!keys(row as unknown as Record<string, unknown>, ["draftKey", "username", "profile"], ["description", "instructions", "runtimeId", "permissionTier"])
          || typeof row.username !== "string" || !USERNAME.test(row.username) || ["main", "hara"].includes(row.username)
          || Object.hasOwn(row, "runtimeId") && (!isAgentRuntimeId(row.runtimeId) || row.runtimeId === "hara")
          || row.permissionTier !== undefined && !isRuntimePermissionTier(row.permissionTier)) { failed("invalid_request"); continue; }
        if (row.permissionTier !== undefined && !availableRuntimePermissionTiers().includes(row.permissionTier)) { failed("permission_tier_unavailable"); continue; }
        // Existing/stale/overflow slots were settled above. A pending implicit slot cannot
        // silently choose Pi when its Workspace preference could not be read. Nothing in
        // this in-memory batch has been published yet, including earlier explicit rows.
        if (!Object.hasOwn(row, "runtimeId") && defaultRuntime?.kind === "preference_unavailable") throw new Error("Workspace default engine settings unavailable; refresh before creating colleagues");
        const runtimeId = Object.hasOwn(row, "runtimeId") ? row.runtimeId : defaultRuntime?.kind === "resolved" ? defaultRuntime.runtimeId : undefined;
        if (!isAgentRuntimeId(runtimeId) || runtimeId === "hara") { failed("runtime_unavailable"); continue; }
        const runtime = options.find(option => option.id === runtimeId);
        if (!runtime?.available) { failed(runtime?.confirmation !== undefined && runtime.confirmation !== "none" ? "runtime_unconfirmed" : "runtime_unavailable"); continue; }
        if (value.agents.some(agent => agent.username === row.username)) { failed("username_taken"); continue; }
        const { draftKey, username, runtimeId: _requestedRuntime, permissionTier = defaultRuntimePermissionTier(), ...fields } = row;
        let normalized: ReturnType<typeof persona>;
        try { normalized = persona(fields, username); } catch { failed("invalid_request"); continue; }
        // Recheck live runtime registration before admission, without launching or probing models.
        try { this.runtimes.assertAvailable(runtimeId); } catch { failed("runtime_unavailable"); continue; }
        const agent: AgentRecord = { agentId: `ag_${randomUUID()}`, username, kind: "colleague", state: "active", epoch: 1,
          currentConfigRevision: 1, configurations: [configuration(normalized, 1, runtimeId, undefined, permissionTier)], creation: { runId: request.runId, draftKey } };
        value.agents.push(agent); created++;
        results.push({ index, draftKey, status: "created", agent: this.view(agent, options) });
      }
      if (created) { this.advance(value); this.persist(loaded, value); }
      return { runId: request.runId, revision: value.revision, results };
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
  private appendConfiguration(row: AgentRecord, input: ReturnType<typeof persona>, runtimeId: AgentRuntimeId, permissionTier = storedPermissionTier(row.configurations.at(-1)!)): void {
    if (row.state !== "active") throw new Error("restore the exact archived Workspace Agent before editing");
    if (row.configurations.length >= MAX_CONFIGS) throw new Error("Workspace Agent configuration history is full; no snapshot was removed");
    row.currentConfigRevision++;
    row.configurations.push(configuration(input, row.currentConfigRevision, runtimeId, row.configurations.at(-1)!.toolPolicy, permissionTier));
  }
  updatePersona(agentId: string, input: WorkspaceAgentPersonaInput, configRevision: number, agentEpoch: number): WorkspaceAgentView {
    const normalized = persona(input, "agent");
    return this.update(agentId, configRevision, agentEpoch, row => {
      this.appendConfiguration(row, normalized, row.configurations[row.currentConfigRevision - 1]!.runtimeId);
      if (!DEFAULT_ORCHESTRATOR_TITLES.includes(normalized.identity.title ?? "")) { delete row.titleSource; delete row.titleKey; }
    });
  }
  /** A display-name change only: a new configuration snapshot keeps every other persona field, so the
   * former name stays in configuration history and therefore remains a resolvable alias. */
  rename(agentId: string, displayName: string, configRevision: number, agentEpoch: number): WorkspaceAgentView {
    if (typeof displayName !== "string" || !displayName.trim()) throw new Error("invalid Workspace Agent display name");
    return this.update(agentId, configRevision, agentEpoch, row => {
      if (row.kind !== "colleague") throw new Error("only a Workspace colleague can be renamed");
      const current = row.configurations[row.currentConfigRevision - 1]!;
      const { version: _version, source: _source, ...profile } = current.identity;
      const normalized = persona({ profile: { ...profile, displayName }, description: current.description, instructions: current.instructions }, row.username);
      if (normalized.identity.displayName === current.identity.displayName) throw new Error("the colleague already has this display name");
      this.appendConfiguration(row, normalized, current.runtimeId);
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
  setPermissionTier(agentId: string, permissionTier: RuntimePermissionTier, configRevision: number, agentEpoch: number): WorkspaceAgentView {
    if (!isRuntimePermissionTier(permissionTier)) throw new Error("Invalid runtime permission tier");
    if (!availableRuntimePermissionTiers().includes(permissionTier)) throw new RuntimeTierUnavailableError();
    return this.update(agentId, configRevision, agentEpoch, row => {
      const current = row.configurations[row.currentConfigRevision - 1]!;
      const { identity, description, instructions } = current;
      this.appendConfiguration(row, { identity, description, instructions }, current.runtimeId, permissionTier);
    });
  }
  setArchived(agentId: string, archived: boolean, configRevision: number, agentEpoch: number, pausedScheduleCount = 0): WorkspaceAgentView {
    if (typeof archived !== "boolean" || !Number.isSafeInteger(pausedScheduleCount) || pausedScheduleCount < 0 || pausedScheduleCount > 4096)
      throw new Error("invalid Workspace Agent lifecycle update");
    return this.update(agentId, configRevision, agentEpoch, (row, value) => {
      if (row.kind === "main") throw new Error("the Workspace main Hara cannot be archived or replaced");
      if ((row.state === "archived") === archived) throw new Error("Workspace Agent lifecycle already changed; refresh before editing");
      if (row.epoch >= Number.MAX_SAFE_INTEGER) throw new Error("Workspace Agent lifecycle epoch exhausted");
      row.state = archived ? "archived" : "active"; row.epoch++;
      if (archived) { row.archivedAt = new Date().toISOString(); row.pausedScheduleCount = pausedScheduleCount; }
      else { delete row.archivedAt; delete row.pausedScheduleCount; }
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
      // Imported 1.0.x colleagues predate permission tiers: they stay controlled and are never silently upgraded.
      const config = configuration(persona(fields, username), 1, "pi", validateWorkspaceLegacyToolPolicy(toolPolicy), "controlled");
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
      agentId: row.agentId, agentEpoch: row.epoch, configRevision: config.revision, configHash: config.hash, runtimeId: config.runtimeId, permissionTier: storedPermissionTier(config), taskId });
  }
  /** Private snapshot resolution, NOT execution admission. Callers still need live membership, policy,
   * Host/resource grants and fully scoped dependencies. Old runners explicitly refuse this provenance. */
  resolveTask(binding: Readonly<WorkspaceAgentTaskBinding>): Readonly<WorkspaceAgentConfiguration> {
    if (!isWorkspaceAgentTaskBinding(binding) || binding.workspaceId !== this.scope.workspaceId
      || !sameWorkspaceResourceBinding(binding.resourceBinding, this.binding())) throw new Error("task does not belong to this Workspace Agent resource scope");
    const row = this.load().value?.agents.find(entry => entry.agentId === binding.agentId);
    if (!row || row.state !== "active" || row.epoch !== binding.agentEpoch) throw new Error("Workspace Agent task lifecycle is no longer active");
    const config = row.configurations[binding.configRevision - 1];
    if (binding.permissionTier !== undefined && binding.permissionTier !== (config ? storedPermissionTier(config) : "controlled")) throw new Error("Frozen runtime permission tier does not match its configuration");
    if (!config || config.hash !== binding.configHash || config.runtimeId !== binding.runtimeId) throw new Error("Workspace Agent task configuration snapshot is unavailable; no fallback was selected");
    this.runtimes.assertAvailable(config.runtimeId);
    const result = structuredClone(config);
    if (result.identity.traits) Object.freeze(result.identity.traits);
    Object.freeze(result.identity);
    return Object.freeze(result);
  }
}
