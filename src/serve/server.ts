// hara serve — the persistent local server (WebSocket JSON-RPC, protocol.ts) that desktop shells, ACP
// clients, and IDE plugins drive. codex's app-server layering in TypeScript: shell ↔ protocol ↔ agent
// core, with the agent core (runAgent + plugins + skills + memory) running IN-PROCESS — plugins need no
// bridging. Provider building / subagent spawn / guardian stay in index.ts and are injected as ServeDeps
// (no import cycle back into the CLI entry).
import { WebSocketServer, type WebSocket } from "ws";
import { randomBytes, randomUUID, timingSafeEqual, createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import "../tools/all.js"; // register the full built-in toolset — serve must work as a standalone entry
import { pruneStoredToolResults } from "../tools/result-limit.js";
import { createServeRuntimeLogger, serveRuntimeFailureCategory } from "./runtime-log.js";
import { runAgent, type RunOpts } from "../agent/loop.js";
import {
  COMPACT_SYSTEM,
  autoCompactTokenCap,
  buildFileRestore,
  compactedConversationHistory,
  compactedHistoryTokenEstimate,
  compactionSourceHistory,
  normalizeCompactionSummary,
  recentHistoryForCompaction,
  shouldAutoCompact,
  shouldAutoCompactHistoryChars,
  shouldAutoCompactTokens,
  workingSetFromSummary,
} from "../agent/compact.js";
import { historyChars } from "../agent/context-budget.js";
import { rewindTo } from "../agent/rewind.js";
import { analyzeContext } from "../agent/context-report.js";
import { clearTouched, recentTouched } from "../agent/touched.js";
import { resetRepeatGuard } from "../agent/repeat-guard.js";
import { contextWindow, ctxPctFor } from "../statusbar.js";
import { listProjectFilesAsync } from "../fs-walk.js";
import { fuzzyRank } from "../fuzzy.js";
import type {
  ImageAttachment,
  NeutralMsg,
  Provider,
  UserAttachmentView,
} from "../providers/types.js";
import type { GatewayStatus } from "../gateway/serve.js";
import type { GatewayLoginSnapshot } from "../gateway/login.js";
import type { UiSink } from "../tools/registry.js";
import { APPROVAL_MODES, type ApprovalMode } from "../config.js";
import type { SandboxMode } from "../sandbox.js";
import { loadAgentContext } from "../context/agents-md.js";
import {
  expandExplicitAttachmentsAsync,
  expandMentionsAsync,
} from "../context/mentions.js";
import { describeImages, type EffectiveAttachmentCapabilities } from "../vision.js";
import { memoryDigest } from "../memory/store.js";
import {
  listLearnings,
  reviewLearning,
  type LearningCandidate,
  type LearningScope,
  type LearningStatus,
} from "../learning/store.js";
import { listInstalled, enabledPlugins, setPluginEnabled, panelsForProject } from "../plugins/plugins.js";
import { loadSkillIndex, loadSkillBody } from "../skills/skills.js";
import {
  loadJobs,
  addJob,
  findJob,
  recoverJobRunningState,
  removeJob,
  schedulesEqual,
  setEnabled,
  updateJob,
  type CronDeliverMode,
  type CronDeliveryUpdate,
  type CronJob,
} from "../cron/store.js";
import {
  parseSchedule,
  describeSchedule,
  nextRun,
  validDateTimestamp,
  validTz,
  type Schedule,
} from "../cron/schedule.js";
import {
  deliveryConfigurationError,
  deliveryInstructionConflict,
  parseDeliver,
} from "../cron/deliver.js";
import {
  installScheduler,
  isInstalled,
  reconcileInstalledScheduler,
  schedulerEntryState,
} from "../cron/install.js";
import { runJobTracked, selfArgv } from "../cron/runner.js";
import { loadTasks } from "../tools/task.js";
import { listPending, resolvePending } from "../gateway/flows-pending.js";
import { disposeTodoScope, onTodosChange, restoreTodos, serializeTodos } from "../tools/todo.js";
import { INTERJECT_PREFIX, disposeReminderScope } from "../agent/reminders.js";
import { SessionHub, realStore, type SessionStore, type ServeSession } from "./sessions.js";
import { ensureSessionMetadataIndex, sanitizeSessionTitle, type SessionMeta } from "../session/store.js";
import {
  parseFrame,
  rpcResult,
  rpcError,
  rpcNotify,
  ERR,
  PROTOCOL_VERSION,
  type SessionSubmitMode,
  type SessionSubmitResult,
} from "./protocol.js";
import {
  taskLifecycleEvent,
  type TaskLifecycleActivity,
  type TaskLifecycleCursor,
} from "./task-events.js";
import { WorkforceStateLedger } from "./workforce-events.js";
import type { SubagentLifecycleObserver } from "../subagent/runtime.js";
import { readModelContextFileSync } from "../fs-read.js";
import { optionalPosixOpenFlag } from "../fs-open-flags.js";
import { tightenPrivateDescriptorMode } from "../fs-permissions.js";
import { sameOpenedFileIdentity } from "../fs-identity.js";
import { redactSensitiveText, redactSensitiveValue } from "../security/secrets.js";
import { automationSessionForClient } from "./automation-session.js";
import { projectApprovalPolicy } from "../security/project-approvals.js";
import { tokenPlanModelReplacement } from "../providers/alibaba.js";
import {
  buildAgentsIndex,
  canonicalProjectPath,
  loadProjects,
  resolveAgent,
  type AgentIndexEntry,
} from "../org/projects.js";
import {
  loadGlobalRoles,
  agentRoleRevision,
  createNativeGlobalAgent,
  loadMainAgentIdentity,
  loadOrganizationExecutionPolicy,
  loadRoles,
  mainAgentIdentityRevision,
  roleToolFilter,
  updateMainAgentIdentity,
  updateNativeRoleIdentity,
  type AgentBlueprintProvenance,
  type AgentExecutionPreferencesInput,
  type Role,
} from "../org/roles.js";
import { agentIdentityFromMetadata, type AgentPublicIdentity } from "../org/agent-identity.js";
import {
  dismissAgentRef,
  dismissedAgentRefs,
  isAgentRefDismissed,
  restoreAgentRef,
} from "../org/agent-roster.js";
import {
  isOrganizationAuthorizationRejection,
  organizationAuthorizationRecoveryMessage,
} from "../org-fleet/errors.js";
import { effectiveRoleModel } from "../session/session-model.js";
import {
  DeskClientError,
  type DeskConnectionsSnapshot,
  type DeskSnapshot,
  type DeskTaskDetails,
  type DeskTaskState,
} from "../desk.js";
import {
  ArtifactStoreError,
  commitArtifact,
  exportArtifact,
  getArtifact,
  importArtifact,
  listArtifactRevisions,
  listArtifacts,
  revertArtifact,
  validateArtifact,
  type ArtifactKind,
} from "../artifacts/store.js";
import {
  createPresentationArtifact,
  createPresentationPreviewFile,
  exportPresentationArtifact,
  getPresentationArtifact,
  importPresentationArtifact,
  renderPresentationDraft,
  renderPresentationPreview,
  updatePresentationArtifact,
  validatePresentationArtifact,
} from "../presentations/runtime.js";
import {
  consumePendingTaskSteering,
  createTaskExecution,
  continueTaskExecution,
  finishTaskExecution,
  newSteerInteraction,
  newTurnInteraction,
  recordTaskSteering,
  requestsTaskContinuation,
  taskExecutionContext,
  type TaskInteraction,
} from "../session/task.js";
import {
  validateSessionAttachments,
  type SessionAttachmentIntent,
  type ValidatedSessionAttachments,
} from "./attachments.js";
import { createExternalSessionRegistry } from "../external-sessions/registry.js";
import {
  ExternalSessionInputError,
  type ExternalRuntimeLaunchOptions,
  type ExternalSessionService,
  type ExternalSessionSourceId,
  type ExternalTerminalStream,
} from "../external-sessions/types.js";

/** What the CLI entry injects (built in index.ts, where config/providers/guardian already live). */
export interface ServeDeps {
  version: string;
  providerId: string;
  model: string;
  buildSessionProvider: (cwd?: string, profileId?: string, spaceId?: string) => Promise<Provider | null>; // fresh live config/credential route
  /** provider for a specific model/effort — powers per-session model switching (composer picker) */
  /** `null` means provider/model automatic; `undefined` means inherit the current connection default. */
  buildProviderFor?: (model: string, effort?: string | null, cwd?: string, profileId?: string, spaceId?: string) => Promise<Provider | null>;
  /** live model list from the endpoint (may be empty — not every endpoint enumerates) */
  listModels?: (cwd?: string, profileId?: string, spaceId?: string) => Promise<string[]>;
  /** Live per-project context policy. Production re-reads config for every completed turn; embedders that
   * omit it retain manual-only `session.compact` behavior. */
  autoCompact?: (cwd?: string) => { enabled: boolean; tokenCap?: number };
  /** Validate and normalize image input for the session's pinned route: keep native images or explicitly
   * translate them through the configured vision-first model. The callback is identity/Space-aware. */
  prepareImages?: (
    images: ImageAttachment[],
    opts: {
      cwd: string;
      model: string;
      profileId?: string;
      spaceId: string;
      signal: AbortSignal;
      hint?: string;
    },
  ) => Promise<{ images?: ImageAttachment[]; description?: string; viaModel?: string }>;
  /** Redacted provider/local-model control plane for Desktop settings. Credentials are accepted only by
   * save/test and must never be returned by these callbacks. */
  providerSettings?: (cwd?: string) => ProviderSettingsState;
  saveVisionSettings?: (input: VisionSettingsInput, cwd?: string) => Promise<ProviderSettingsState>;
  testVisionSettings?: (input: VisionSettingsTestInput, cwd?: string) => Promise<ProviderSettingsTestResult>;
  saveProviderSettings?: (input: ProviderSettingsInput, cwd?: string) => Promise<ProviderSettingsState>;
  testProviderSettings?: (input: ProviderSettingsInput, cwd?: string) => Promise<ProviderSettingsTestResult>;
  createProviderConnection?: (input: ProviderConnectionCreateInput, cwd?: string) => Promise<ProviderSettingsState>;
  testProviderConnection?: (id: string, cwd?: string) => Promise<ProviderSettingsTestResult>;
  useProviderConnection?: (id: string, cwd?: string) => ProviderSettingsState;
  removeProviderConnection?: (id: string, cwd?: string) => ProviderSettingsState;
  /** Explicitly remove the project profile pin governing cwd. Existing sessions retain their stored
   * profile; the returned snapshots describe only the route used by future sessions. */
  unpinProjectProfile?: (cwd?: string) => ProjectProfileUnpinResult;
  /** Read-only, redacted connector health for Desktop settings. */
  gatewayStatuses?: () => Promise<GatewayStatus[]>;
  /** In-process interactive connector login. Only a short-lived QR payload and lifecycle phase cross the
   * authenticated loopback protocol; confirmed credentials stay inside the gateway private-state writer. */
  startGatewayLogin?: (platform: string) => Promise<GatewayLoginSnapshot>;
  gatewayLoginStatus?: (platform: string, id?: string) => GatewayLoginSnapshot | undefined;
  cancelGatewayLogin?: (platform: string, id: string) => GatewayLoginSnapshot | undefined;
  closeGatewayLogins?: () => Promise<void>;
  /** Redacted organization/profile control plane. One-time codes are accepted only by enroll and are
   * never returned. Device tokens remain inside the CLI's private profile store. */
  organizationConnections?: (cwd?: string) => OrganizationConnectionsState;
  enrollOrganizationConnection?: (input: OrganizationEnrollmentInput, cwd?: string) => Promise<OrganizationConnectionsState>;
  useOrganizationConnection?: (id: string, cwd?: string) => OrganizationConnectionsState;
  removeOrganizationConnection?: (id: string, cwd?: string) => OrganizationConnectionsState;
  checkOrganizationConnection?: (id: string, cwd?: string) => Promise<OrganizationConnectionCheck>;
  /** Unified Personal / Company Space directory. A Space is an authorization and data boundary; a
   * profile is only the concrete provider route used inside that Space. */
  spaces?: (cwd?: string) => SpaceDirectory;
  useSpace?: (spaceId: string, cwd?: string) => SpaceDirectory;
  /** Organization learning is a reviewed outbox: submit is explicit and sync pulls only Control-approved
   * records. Device credentials remain behind these callbacks and never cross the Desktop protocol. */
  organizationLearningSubmit?: (
    profileId: string,
    organizationScopeId: string,
    candidateId: string,
    cwd?: string,
  ) => Promise<{ remoteId: string; status: string; revision: number; candidate: LearningCandidate }>;
  organizationLearningSync?: (
    profileId: string,
    organizationScopeId: string,
    cwd?: string,
  ) => Promise<{ version: number; learnings: LearningCandidate[] }>;
  /** Organization-scoped Desk data. Connections are a private local read; snapshot/detail are explicit,
   * bounded remote reads. Every remote call carries a captured profileId so an in-flight request cannot
   * cross organizations if the global default changes. Desk bearer credentials never enter these DTOs. */
  deskConnections?: () => DeskConnectionsSnapshot;
  deskSnapshot?: (profileId: string, state?: DeskTaskState) => Promise<DeskSnapshot>;
  deskTask?: (profileId: string, taskId: string) => Promise<DeskTaskDetails>;
  /** thinking-dial levels valid for this endpoint's reasoning style (from the provider registry) */
  effortLevels?: string[];
  /** Live defaults advertised to persistent clients after config/profile edits. `model` lets a session
   * pinned to a non-default model ask for that model's valid reasoning controls. */
  runtimeInfo?: (cwd?: string, model?: string, profileId?: string, spaceId?: string) => {
    providerId: string;
    model: string;
    /** Effective identity route. Persisted into each new session and reused on resume. */
    profileId?: string;
    profileKind?: "byok" | "gateway";
    /** Durable audience frozen into every new session. */
    spaceId?: string;
    /** Organization enrollment that supplies company Agents and policy when the inference route is BYOK. */
    organizationProfileId?: string;
    effortLevels?: string[];
    /** Connection/Space default for new work. Missing means provider/model automatic. */
    defaultReasoningEffort?: string;
    /** Finite server-authorized set for a scoped gateway token. Missing means unconstrained discovery. */
    availableModels?: string[];
    /** Effective Hara input capabilities for the selected conversation model. */
    attachmentCapabilities?: EffectiveAttachmentCapabilities;
  };
  /** Per-project lifecycle limits, read at turn start so persistent Desktop sessions pick up config edits. */
  runLimits?: (cwd?: string) => { timeoutMs: number; maxRounds: number };
  spawnSubagent: (
    provider: Provider,
    cwd: string,
    projectContext: string | undefined,
    stats: { input: number; output: number; lastInput?: number },
    task: string,
    role?: string,
    signal?: AbortSignal,
    observers?: Pick<RunOpts, "onProviderTurn" | "onToolRun"> & {
      onSubagentLifecycle?: SubagentLifecycleObserver;
    },
    profileId?: string,
    spaceId?: string,
  ) => Promise<string>;
  guardian?: { provider?: Provider | null; enabled?: boolean };
  buildGuardian?: (cwd?: string, profileId?: string, spaceId?: string) => Promise<{ provider?: Provider | null; enabled?: boolean } | undefined>;
  sandbox: SandboxMode;
  approval: ApprovalMode;
  store?: SessionStore; // tests inject a hermetic store
  quietDiscovery?: boolean; // tests: skip ~/.hara/serve.json
  discoveryHome?: string; // tests: isolate the discovery file from the real home directory
  artifactHome?: string; // tests/embedders: isolate ~/.hara/artifacts from the real home directory
  compactTimeoutMs?: number; // tests/embedders: bound a provider that ignores cancellation
  /** Optional hermetic/session-provider override. Production uses official local adapters and never parses
   * private transcript files in the renderer or protocol layer. */
  externalSessions?: ExternalSessionService;
}

export interface ServeAutoCompactDecision {
  compact: boolean;
  pct: number;
  tokenCap: number;
}

export interface ServeAgentInfo {
  ref: string;
  name: string;
  description: string;
  identity: AgentPublicIdentity;
  home: string;
  scope: "main" | "global" | "project";
  project?: string;
  model?: string;
  /** Agent override; absence follows the selected Space/connection default. */
  reasoningEffort?: string;
  readOnly?: boolean;
  /** Verified install provenance only; private blueprint prompt text is never serialized. */
  blueprint?: AgentBlueprintProvenance;
  /** Space that owns the Agent catalog entry and every conversation created from it. */
  spaceId: string;
  owner: "personal" | "organization" | "external";
  allowedActions: Array<"chat" | "edit_profile" | "archive">;
  /** Optimistic-concurrency token for editable public identity metadata. */
  revision?: string;
}

export interface ServeAgentOffice {
  id: string;
  name: string;
  cwd: string;
  kind: "workspace" | "project" | "lobby";
  project?: string;
  agentRefs: string[];
}

export interface ServeAgentCatalog {
  agents: ServeAgentInfo[];
  offices: ServeAgentOffice[];
  currentOfficeId: string;
  /** Qualified Personal refs hidden from the active directory; source prompts and history remain intact. */
  dismissedAgentRefs: string[];
}

interface ResolvedServeAgent {
  ref: string;
  cwd: string;
  entry: AgentIndexEntry;
  role: Role;
}

const SAFE_AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const SERVE_AGENT_LIMIT = 512;
const SERVE_OFFICE_LIMIT = 128;
const SERVE_OFFICE_AGENT_LIMIT = 24;

function failClosedSpaceId(profileId?: string): string {
  return profileId && profileId !== "personal" ? `org-profile:${profileId}` : "personal";
}

function boundedOfficeAgentRefs(...groups: string[][]): string[] {
  const refs = ["main"];
  const seen = new Set(refs);
  for (const group of groups) {
    for (const ref of group) {
      if (seen.has(ref)) continue;
      seen.add(ref);
      refs.push(ref);
      if (refs.length >= SERVE_OFFICE_AGENT_LIMIT) return refs;
    }
  }
  return refs;
}

function canonicalAgentRef(entry: AgentIndexEntry): string {
  return entry.project ? `${entry.project}:${entry.name}` : `global:${entry.name}`;
}

function safeAgentDescription(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 240);
}

function projectHomeHint(ref: string, fallback: string): string {
  const separator = ref.indexOf(":");
  if (separator <= 0) return fallback;
  const namespace = ref.slice(0, separator).trim().toLowerCase();
  if (namespace === "global") return fallback;
  return loadProjects().find((project) => project.name === namespace)?.path ?? fallback;
}

function resolveServeAgent(
  ref: string,
  cwd: string,
  profileId?: string,
  options: { includeDismissed?: boolean } = {},
): ResolvedServeAgent | { ambiguous: string[] } | null {
  const hit = resolveAgent(ref, cwd, profileId, options);
  if (!hit) return null;
  if ("ambiguous" in hit) {
    return { ambiguous: hit.ambiguous.map(canonicalAgentRef).sort() };
  }
  if (!SAFE_AGENT_NAME.test(hit.name)) return null;
  const role = hit.project
    ? loadRoles(hit.home, profileId).find((candidate) => candidate.id === hit.name)
    : loadGlobalRoles(profileId).find((candidate) => candidate.id === hit.name);
  if (!role) return null;
  return {
    ref: canonicalAgentRef(hit),
    cwd: hit.home || cwd,
    entry: hit,
    role,
  };
}

function serveAgentCatalog(cwd: string, profileId: string | undefined, spaceId: string): ServeAgentCatalog {
  const allProjects = loadProjects();
  const canonicalCwd = canonicalProjectPath(cwd);
  const currentProject = allProjects.find((project) => canonicalProjectPath(project.path) === canonicalCwd);
  const projects = [
    ...(currentProject ? [currentProject] : []),
    ...allProjects.filter((project) => project.name !== currentProject?.name),
  ].slice(0, SERVE_OFFICE_LIMIT);
  const visibleProjectNames = new Set(projects.map((project) => project.name));
  const indexed = buildAgentsIndex(profileId)
    .filter((entry) => SAFE_AGENT_NAME.test(entry.name) && (!entry.project || visibleProjectNames.has(entry.project)))
    .sort((left, right) => Number(right.project === currentProject?.name) - Number(left.project === currentProject?.name)
      || Number(!right.project) - Number(!left.project)
      || canonicalAgentRef(left).localeCompare(canonicalAgentRef(right)))
    .slice(0, SERVE_AGENT_LIMIT - 1);
  const globalRoles = new Map(loadGlobalRoles(profileId).map((role) => [role.id, role]));
  const projectRoles = new Map(projects.map((project) => [
    project.name,
    new Map(loadRoles(project.path, profileId).map((role) => [role.id, role])),
  ]));
  const agents: ServeAgentInfo[] = [{
    ref: "main",
    name: "Hara",
    description: "Hara main agent",
    identity: spaceId === "personal" ? loadMainAgentIdentity() : {
      version: 1,
      displayName: "Hara",
      title: "Company Coordinator",
      bio: "Coordinates work inside this company Space under organization policy.",
      traits: ["governed", "evidence-led", "team-aware"],
      emoji: "✦",
      theme: "company operations studio",
      accent: "#ff695f",
      character: "orchestrator",
      source: "organization",
    },
    home: cwd,
    scope: "main",
    spaceId,
    owner: spaceId === "personal" ? "personal" : "organization",
    allowedActions: spaceId === "personal" ? ["chat", "edit_profile"] : ["chat"],
    ...(spaceId === "personal" ? { revision: mainAgentIdentityRevision() } : {}),
  }];
  for (const entry of indexed) {
    const targetCwd = entry.home || cwd;
    const role = entry.project
      ? projectRoles.get(entry.project)?.get(entry.name)
      : globalRoles.get(entry.name);
    agents.push({
      ref: canonicalAgentRef(entry),
      name: entry.name,
      description: safeAgentDescription(entry.description),
      identity: role?.identity
        ?? agentIdentityFromMetadata({}, entry.name, entry.description, role?.source),
      home: targetCwd,
      scope: entry.project ? "project" : "global",
      ...(entry.project ? { project: entry.project } : {}),
      ...(role?.model ? { model: role.model } : {}),
      ...(role?.reasoningEffort ? { reasoningEffort: role.reasoningEffort } : {}),
      ...(role?.readOnly ? { readOnly: true } : {}),
      ...(role?.blueprint ? { blueprint: role.blueprint } : {}),
      spaceId,
      owner: role?.source === "org"
        ? "organization"
        : role?.source === "global" || role?.source === "project"
          ? "personal"
          : "external",
      allowedActions: spaceId === "personal" && (role?.source === "global" || role?.source === "project")
        ? ["chat", "edit_profile", "archive"]
        : spaceId === "personal"
          ? ["chat", "archive"]
          : ["chat"],
      ...(spaceId === "personal" && role ? { revision: agentRoleRevision(role) } : {}),
    });
  }

  const globalAgentRefs = agents
    .filter((agent) => agent.scope === "global")
    .map((agent) => agent.ref);
  const projectOffices: ServeAgentOffice[] = projects.map((project) => ({
    id: `project:${project.name}`,
    name: project.name,
    cwd: project.path,
    kind: "project",
    project: project.name,
    agentRefs: boundedOfficeAgentRefs(
      agents.filter((agent) => agent.project === project.name).map((agent) => agent.ref),
      globalAgentRefs,
    ),
  }));
  const currentOffice: ServeAgentOffice = currentProject
    ? projectOffices.find((office) => office.project === currentProject.name)!
    : {
        id: "workspace",
        name: basename(cwd) || "Workspace",
        cwd,
        kind: "workspace",
        agentRefs: boundedOfficeAgentRefs(globalAgentRefs),
      };
  const lobby: ServeAgentOffice = {
    id: "global",
    name: "Hara Lobby",
    cwd,
    kind: "lobby",
    agentRefs: boundedOfficeAgentRefs(globalAgentRefs),
  };
  const offices = [
    currentOffice,
    ...(currentOffice.id === lobby.id ? [] : [lobby]),
    ...projectOffices.filter((office) => office.id !== currentOffice.id),
  ];
  return {
    agents,
    offices,
    currentOfficeId: currentOffice.id,
    dismissedAgentRefs: spaceId === "personal" ? [...dismissedAgentRefs()].sort() : [],
  };
}

/** Shared, deterministic trigger for Desktop/Serve auto-compaction. Keep it separate from the provider
 * call so configuration corruption cannot turn every short conversation into a summarization request. */
export function serveAutoCompactDecision(
  model: string,
  lastInput: number,
  historyLength: number,
  policy: { enabled: boolean; tokenCap?: number } | undefined,
  durableHistoryChars = 0,
): ServeAutoCompactDecision {
  const safeLastInput = Number.isFinite(lastInput) ? Math.max(0, Math.floor(lastInput)) : 0;
  const tokenCap = autoCompactTokenCap(policy?.tokenCap);
  const enabled = policy?.enabled === true;
  const pct = ctxPctFor(model, safeLastInput);
  return {
    compact:
      shouldAutoCompact(pct, historyLength, enabled)
      || shouldAutoCompactTokens(safeLastInput, historyLength, enabled, tokenCap)
      || shouldAutoCompactHistoryChars(durableHistoryChars, historyLength, enabled),
    pct,
    tokenCap,
  };
}

export interface ProviderSettingsCatalogEntry {
  id: string;
  label: string;
  location: "cloud" | "local" | "managed";
  auth: "api-key" | "oauth" | "none" | "managed";
  defaultModel: string;
  defaultBaseURL?: string;
  customBaseURL: boolean;
  knownModels?: readonly string[];
  /** Models this engine version has positively classified as accepting image input. */
  knownVisionModels?: readonly string[];
  knownModelEntries?: Array<{ id: string; effortLevels: string[] }>;
  legacy?: boolean;
}

export interface ProviderSettingsState {
  current: {
    provider: string;
    model: string;
    baseURL?: string;
    location: "cloud" | "local" | "managed";
    auth: "api-key" | "oauth" | "none" | "managed";
    keyConfigured: boolean;
    authenticated: boolean;
    profileId: string;
    profileKind: "byok" | "gateway";
    profileSource: "flag" | "env" | "pin" | "default" | "fallback";
    editable: boolean;
    environmentOverride?: boolean;
    reasoningEffort?: string;
    effortLevels?: string[];
    tokenExpiresAt?: string;
    tokenExpired?: boolean;
  };
  providers: ProviderSettingsCatalogEntry[];
  connections?: ProviderConnectionSummary[];
  switchLocked?: boolean;
  vision?: VisionSettingsState;
}

export interface VisionSettingsState {
  enabled: boolean;
  source: "current" | "custom";
  provider: string;
  model?: string;
  baseURL?: string;
  apiKeyConfigured: boolean;
  usesManagedCredential: boolean;
  editable: boolean;
  authorized: boolean;
  /** Image-capable choices only; generation/audio/embedding and text-only models are excluded. */
  availableModels: string[];
  authorizedModels?: string[];
}

export interface VisionSettingsInput {
  enabled: boolean;
  source?: "current" | "custom";
  provider?: string;
  model?: string;
  baseURL?: string;
  apiKey?: string;
  clearApiKey?: boolean;
}

export interface VisionSettingsTestInput {
  source: "current" | "custom";
  provider?: string;
  model?: string;
  baseURL?: string;
  apiKey?: string;
  clearApiKey?: boolean;
}

export interface ProviderConnectionSummary {
  id: string;
  label: string;
  provider: string;
  model: string;
  baseURL?: string;
  location: "cloud" | "local";
  auth: "api-key" | "oauth" | "none";
  keyConfigured: boolean;
  authenticated: boolean;
  active: boolean;
  legacyPersonal: boolean;
  removable: boolean;
  keyHint?: string;
  createdAt?: string;
  reasoningEffort?: string;
  effortLevels?: string[];
}

export interface ProviderSettingsInput {
  provider: string;
  model: string;
  baseURL?: string;
  apiKey?: string;
  clearApiKey?: boolean;
  activatePersonal?: boolean;
  reasoningEffort?: string;
  clearReasoningEffort?: boolean;
}

export interface ProviderConnectionCreateInput extends ProviderSettingsInput {
  id: string;
  label: string;
  activate?: boolean;
}

export interface ProviderSettingsTestResult {
  ok: boolean;
  models: string[];
  entries?: Array<{
    id: string;
    providerId: string;
    effortLevels: string[];
    attachmentCapabilities?: EffectiveAttachmentCapabilities;
  }>;
  error?: string;
}

export type OrganizationAccessState = "valid" | "permanent" | "expiring" | "expired" | "legacy" | "invalid";

export interface OrganizationConnectionSummary {
  id: string;
  /** Immutable company audience; local connection ids can be replaced in place. */
  spaceId: string;
  label: string;
  tenantId?: string;
  tenantName?: string;
  active: boolean;
  gatewayUrl: string;
  gatewayHost: string;
  model: string;
  availableModels?: string[];
  reasoningEffort?: string;
  effortLevels?: string[];
  enrolledAt?: string;
  expiresAt?: string;
  tokenNeverExpires?: boolean;
  accessState: OrganizationAccessState;
  services?: Array<{
    service: "MODEL_CONTROL" | "DESK_TASKS" | "COLLAB" | "EXTENSION_CATALOG";
    mode: "HARA_HOSTED" | "CUSTOMER_HOSTED";
    accountRegion: "CN" | "GLOBAL";
    host: string;
    status: "ACTIVE";
    capabilitiesVersion: number;
    configVersion: number;
  }>;
}

export interface OrganizationConnectionsState {
  activeId: string;
  activeSource: "flag" | "env" | "pin" | "default" | "fallback";
  switchLocked: boolean;
  connections: OrganizationConnectionSummary[];
}

export interface OrganizationEnrollmentInput {
  id: string;
  label?: string;
  gatewayUrl: string;
  code: string;
  activate?: boolean;
}

export interface OrganizationConnectionCheck {
  id: string;
  ok: boolean;
  checkedAt: number;
}

export interface SpaceSummary {
  id: string;
  name: string;
  kind: "personal" | "organization";
  /** Concrete provider connection selected when this Space becomes active. */
  profileId: string;
  /** Every known provider route inside this Space, used only to migrate legacy session ownership. */
  profileIds: string[];
  active: boolean;
  tenantId?: string;
  /** False only for pre-Space Control enrollments that did not return a tenant id. */
  authoritative: boolean;
  agentProfilePermission: "edit" | "view";
  /** Organization credential health. Personal omits it. Expired/invalid Spaces remain visible for
   * recovery but cannot become an execution route until re-enrolled. */
  accessState?: OrganizationAccessState;
  /** Presentation hint only. Inference still refreshes Control and fails closed before every BYOK turn. */
  personalModelConnections?: "allowed" | "blocked";
}

export interface SpaceDirectory {
  activeId: string;
  activeProfileId: string;
  activeSource: "flag" | "env" | "pin" | "default" | "fallback";
  switchLocked: boolean;
  spaces: SpaceSummary[];
}

export interface ProjectProfileUnpinResult {
  removed: boolean;
  providers: ProviderSettingsState;
  organizations: OrganizationConnectionsState;
}

export interface ServeOpts {
  host: string;
  port: number; // 0 = ephemeral (tests)
  token?: string; // omitted → generated
  cwd: string;
}

export interface ServeHandle {
  port: number;
  token: string;
  close: () => Promise<void>;
}

const APPROVAL_TIMEOUT_MS = 300_000; // an unanswered approval denies after 5 min (never hangs a turn)
const COMPACT_TIMEOUT_MS = 60_000;
const SHUTDOWN_GRACE_MS = 2_000;
const SOCKET_CLOSE_GRACE_MS = 250;
const DISCOVERY_LOCK_WAIT_MS = 2_000;
const SERVE_PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SERVE_SPACE_ID_PATTERN = /^(?:personal|org:[A-Za-z0-9][A-Za-z0-9._-]{0,127}|org-enrollment:[a-f0-9]{32}|org-profile:[A-Za-z0-9][A-Za-z0-9._-]{0,63})$/;
const SERVE_DESK_TASK_ID_PATTERN = /^t_[a-f0-9]+$/;
const SERVE_DESK_STATES = new Set<DeskTaskState>(["open", "claimed", "done", "cancelled"]);

const artifactRpcError = (
  id: number | string | null,
  error: unknown,
  action: "import" | "commit" | "revert" | "validate" | "export" | "list" | "open" | "list revisions",
): string => {
  if (error instanceof ArtifactStoreError) {
    const code = error.code === "ARTIFACT_CORRUPT" || error.code === "ARTIFACT_EXPORT_FAILED"
      ? ERR.INTERNAL
      : error.code === "ARTIFACT_CONFLICT"
        ? ERR.CONFLICT
        : ERR.PARAMS;
    return rpcError(id, code, error.message);
  }
  return rpcError(
    id,
    ERR.INTERNAL,
    action === "import" || action === "commit"
      ? `Artifact ${action} failed safely; the source file was not modified`
      : action === "export"
        ? "Artifact export failed safely; no existing destination file was replaced"
      : action === "revert"
        ? "Artifact revert failed safely; no current revision was replaced"
        : `Artifact ${action} failed safely; local Artifact data was not changed`,
  );
};

const deskRpcError = (id: number | string | null, error: unknown): string => {
  if (error instanceof DeskClientError) {
    const code =
      error.code === "UNAUTHORIZED"
      || error.code === "FORBIDDEN"
        ? ERR.UNAUTHORIZED
        : error.code === "INVALID_CONFIGURATION"
          || error.code === "NOT_CONFIGURED"
          || error.code === "NOT_FOUND"
          ? ERR.PARAMS
          : error.code === "CONFLICT"
            ? ERR.CONFLICT
            : ERR.INTERNAL;
    return rpcError(id, code, redactSensitiveText(error.message).text);
  }
  return rpcError(id, ERR.INTERNAL, "Desk request failed safely; no credential or remote response was exposed");
};

interface DiscoveryRecord {
  host: string;
  port: number;
  token: string;
  pid: number;
  version: string;
  instanceId: string;
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const isPidAlive = (pid: number): boolean => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === "EPERM";
  }
};

const ensurePrivateDiscoveryDir = (dir: string): void => {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let fd: number | undefined;
  try {
    fd = openSync(
      dir,
      fsConstants.O_RDONLY | optionalPosixOpenFlag("O_DIRECTORY") | optionalPosixOpenFlag("O_NOFOLLOW"),
    );
    const st = fstatSync(fd);
    if (!st.isDirectory()) throw new Error(`${dir} must be a private directory, not a symlink`);
    // mkdir's mode does not affect a legacy directory. Operate through the verified descriptor so a path
    // replacement cannot redirect chmod to a symlink target between validation and permission tightening.
    tightenPrivateDescriptorMode(fd, 0o700);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
};

/** Serialize discovery replacement/removal across serve instances. The instance-stamped lock owner lets a
 * later process reclaim a crash-stale lock without ever treating a live writer as stale. */
const withDiscoveryLock = async <T>(dir: string, instanceId: string, fn: () => T, waitMs = DISCOVERY_LOCK_WAIT_MS): Promise<T> => {
  const lockDir = join(dir, ".serve.json.lock");
  const ownerPath = join(lockDir, "owner.json");
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      mkdirSync(lockDir, { mode: 0o700 });
      writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, instanceId }), { mode: 0o600, flag: "wx" });
      break;
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      let stale = false;
      try {
        const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as { pid?: unknown };
        stale = typeof owner.pid === "number" && !isPidAlive(owner.pid);
      } catch {
        // A writer may be between mkdir and owner creation. Only reclaim a malformed lock after a full
        // grace interval; a normally running write holds it for just a few synchronous filesystem calls.
        try {
          stale = Date.now() - statSync(lockDir).mtimeMs > DISCOVERY_LOCK_WAIT_MS;
        } catch {
          continue;
        }
      }
      if (stale) {
        try {
          renameSync(lockDir, join(dir, `.serve.json.lock.stale-${process.pid}-${randomUUID()}`));
          continue;
        } catch (renameError: any) {
          if (renameError?.code === "ENOENT") continue;
        }
      }
      if (Date.now() >= deadline) throw new Error("timed out waiting for the serve discovery lock");
      await pause(10);
    }
  }

  try {
    return fn();
  } finally {
    // Only remove the lock directory if its owner record is still ours. This is deliberately conservative:
    // leaving a recoverable stale lock is safer than deleting a replacement owned by another instance.
    try {
      const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as { pid?: unknown; instanceId?: unknown };
      if (owner.pid === process.pid && owner.instanceId === instanceId) {
        unlinkSync(ownerPath);
        rmdirSync(lockDir);
      }
    } catch {
      /* stale-lock recovery handles interrupted cleanup */
    }
  }
};

const syncDirectory = (dir: string): void => {
  let fd: number | undefined;
  try {
    fd = openSync(dir, fsConstants.O_RDONLY);
    fsyncSync(fd);
  } catch {
    // Some filesystems do not support fsync on directories. The atomic rename and private file mode still
    // hold; directory fsync is an extra crash-durability barrier where the platform supports it.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
};

const writeDiscovery = async (dir: string, path: string, record: DiscoveryRecord): Promise<void> => {
  ensurePrivateDiscoveryDir(dir);
  await withDiscoveryLock(dir, record.instanceId, () => {
    const temp = join(dir, `.serve.json.${process.pid}.${record.instanceId}.tmp`);
    let fd: number | undefined;
    try {
      fd = openSync(temp, "wx", 0o600);
      tightenPrivateDescriptorMode(fd, 0o600);
      writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`, "utf8");
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      // rename replaces a legacy file or symlink inode; it never follows serve.json's symlink target.
      renameSync(temp, path);
      syncDirectory(dir);
    } finally {
      if (fd !== undefined) closeSync(fd);
      try {
        unlinkSync(temp);
      } catch {
        /* renamed or never created */
      }
    }
  });
};

const removeOwnedDiscovery = async (dir: string, path: string, record: DiscoveryRecord): Promise<void> => {
  await withDiscoveryLock(dir, record.instanceId, () => {
    let fd: number | undefined;
    try {
      fd = openSync(path, fsConstants.O_RDONLY | optionalPosixOpenFlag("O_NOFOLLOW"));
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.size > 64 * 1024) return;
      const current = JSON.parse(readFileSync(fd, "utf8")) as Partial<DiscoveryRecord>;
      if (
        current.instanceId !== record.instanceId
        || current.pid !== record.pid
        || current.port !== record.port
        || typeof current.token !== "string"
        || !sameToken(current.token, record.token)
      ) return;
      // Re-check the directory entry against the already-open, verified inode. Cooperating writers are
      // serialized by the lock; this check also refuses an uncooperative symlink/replacement race.
      const linked = lstatSync(path);
      if (!linked.isFile() || linked.isSymbolicLink() || !sameOpenedFileIdentity(linked, opened)) return;
      unlinkSync(path);
      syncDirectory(dir);
    } catch (error: any) {
      if (error?.code !== "ENOENT" && error?.code !== "ELOOP") throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }, 250);
};

const sameToken = (a: string, b: string): boolean => {
  // constant-time compare over digests (inputs differ in length)
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
};

/** Last assistant text in a history — the turn's "reply" for request/response clients. */
export function lastAssistantText(history: NeutralMsg[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === "assistant") return m.text ?? "";
  }
  return "";
}

export interface ClientHistoryMessage {
  role: string;
  text: string;
  attachments?: UserAttachmentView[];
}

/** Compact history for session.resume — enough for a client to render the transcript. */
export function historyForClient(history: NeutralMsg[]): ClientHistoryMessage[] {
  const out: ClientHistoryMessage[] = [];
  for (const m of history) {
    if (m.role === "user") {
      const steeringPrefix = `${INTERJECT_PREFIX}\n\n`;
      const attachments = m.attachments ?? m.images?.map((image): UserAttachmentView => ({
        kind: "image",
        name: basename(image.path),
        mediaType: image.mediaType,
        strategy: "native-image",
      }));
      out.push({
        role: "user",
        text: m.displayContent ?? (
          m.content.startsWith(steeringPrefix)
            ? m.content.slice(steeringPrefix.length)
            : m.content
        ),
        ...(attachments?.length ? { attachments } : {}),
      });
    }
    else if (m.role === "assistant" && m.text) out.push({ role: "assistant", text: m.text });
    // tool results are omitted — clients see live tool events; persisted detail stays in the store
  }
  return out;
}

const AUTOMATION_DELIVERY_MODES = ["always", "on-output", "on-error"] as const;

function isApprovalMode(value: unknown): value is ApprovalMode {
  return typeof value === "string" && APPROVAL_MODES.includes(value as ApprovalMode);
}

function isAutomationDeliveryMode(value: unknown): value is CronDeliverMode {
  return typeof value === "string"
    && (AUTOMATION_DELIVERY_MODES as readonly string[]).includes(value);
}

function automationScheduleSpec(schedule: Schedule): string {
  if (schedule.kind === "cron") return schedule.expr;
  if (schedule.kind === "every") return schedule.display;
  return new Date(schedule.runAt).toISOString();
}

function automationDeliverySummary(job: CronJob): {
  kind: "none" | "feishu" | "weixin" | "telegram" | "webhook" | "other";
  label: string;
  mode?: CronDeliverMode;
  state?: "ready" | "pending" | "retrying" | "blocked" | "dead_letter";
  pendingCount?: number;
} {
  if (!job.deliver) return { kind: "none", label: "Saved only in Hara" };
  const parsed = parseDeliver(job.deliver);
  const mode = job.deliverMode ?? "always";
  const pending = job.pendingNotifications ?? [];
  const state = deliveryConfigurationError(job.deliver)
    ? "blocked" as const
    : pending.some((notification) => notification.state === "dead_letter")
    ? "dead_letter" as const
    : pending.some((notification) => notification.state === "blocked")
      ? "blocked" as const
      : pending.some((notification) => notification.state === "retrying")
        ? "retrying" as const
        : pending.length
          ? "pending" as const
          : "ready" as const;
  const queue = pending.length ? { pendingCount: pending.length } : {};
  if ("error" in parsed) return { kind: "other", label: "External delivery · configured", mode, state, ...queue };
  const labels = {
    feishu: "Feishu · configured",
    weixin: "WeChat · configured",
    telegram: "Telegram · configured",
    webhook: "Webhook · configured",
  } as const;
  return { kind: parsed.platform, label: labels[parsed.platform], mode, state, ...queue };
}

let automaticSchedulerRepairAttemptedFor = "";

function automationSchedulerInfo(): {
  installed: boolean;
  supported: boolean;
  platform: string;
  detail: string;
} {
  const currentPlatform = platform();
  const supported = currentPlatform === "darwin" || currentPlatform === "linux";
  if (!supported) {
    return {
      installed: false,
      supported: false,
      platform: currentPlatform,
      detail: `Automatic scheduler installation is not supported on ${currentPlatform}.`,
    };
  }
  try {
    let installed = isInstalled();
    let detail = installed
      ? "The local scheduler is installed."
      : "Install the local scheduler once so enabled tasks can run while Desktop is closed.";
    if (process.env.HARA_DESKTOP_SIDECAR === "1") {
      const command = selfArgv();
      const signature = command.join("\0");
      const state = schedulerEntryState(command);
      if (state === "stale" && automaticSchedulerRepairAttemptedFor !== signature) {
        automaticSchedulerRepairAttemptedFor = signature;
        const reconciled = reconcileInstalledScheduler(command);
        installed = reconciled.current;
        detail = reconciled.detail;
      } else if (state === "current" && installed) {
        detail = "The local scheduler is installed.";
      } else if (state === "current") {
        installed = false;
        detail = "The Hara scheduler file exists but launchd is not registered; install it again.";
      } else if (state === "absent") {
        installed = false;
        detail = "Install the local scheduler once so enabled tasks can run while Desktop is closed.";
      } else {
        installed = false;
        detail = state === "unsafe"
          ? "The existing scheduler entry could not be verified; remove it and install the scheduler again."
          : "The scheduler still points to an older Hara executable; install it again to repair the path.";
      }
    }
    return {
      installed,
      supported: true,
      platform: currentPlatform,
      detail,
    };
  } catch {
    return {
      installed: false,
      supported: true,
      platform: currentPlatform,
      detail: "Hara could not verify the local scheduler state.",
    };
  }
}

function automationJobForClient(
  job: CronJob,
  now: number,
  nextRunDeadline?: number,
): Record<string, unknown> {
  const rawUpcoming = nextRun(job, now, {
    ...(nextRunDeadline === undefined ? {} : { deadlineMs: nextRunDeadline }),
  });
  const upcoming = validDateTimestamp(rawUpcoming) ? rawUpcoming : null;
  const nextRunDeferred =
    job.enabled
    && (
      (rawUpcoming !== null && upcoming === null)
      || (
        job.schedule.kind === "cron"
        && rawUpcoming === null
        && nextRunDeadline !== undefined
        && Date.now() >= nextRunDeadline
      )
    );
  const taskPreview = job.task.replace(/\s+/g, " ").trim().slice(0, 180);
  return {
    id: job.id,
    name: job.name,
    mode: job.mode,
    cwd: job.cwd,
    enabled: job.enabled,
    task: job.task,
    taskPreview,
    scheduleSpec: automationScheduleSpec(job.schedule),
    schedule: describeSchedule(job.schedule),
    ...(job.tz ? { tz: job.tz } : {}),
    ...(upcoming === null ? {} : { nextRunAt: upcoming }),
    ...(nextRunDeferred ? { nextRunDeferred: true } : {}),
    createdAt: job.createdAt,
    ...(job.runningSince === undefined ? {} : { runningSince: job.runningSince }),
    ...(job.lastDurationMs === undefined ? {} : { lastDurationMs: job.lastDurationMs }),
    ...(job.consecutiveErrors === undefined ? {} : { consecutiveErrors: job.consecutiveErrors }),
    delivery: automationDeliverySummary(job),
    ...(job.deliver ? { deliverMode: job.deliverMode ?? "always" } : {}),
    alertAfter: job.alertAfter ?? 3,
    ...(job.lastRunAt === undefined ? {} : { lastRunAt: job.lastRunAt }),
    ...(job.lastStatus === undefined ? {} : { lastStatus: job.lastStatus }),
    ...(job.lastError === undefined
      ? {}
      : { lastError: redactSensitiveText(job.lastError).text }),
  };
}

function automationScheduleValidation(
  schedule: Schedule,
  timezone: string | undefined,
  now: number,
  existing?: CronJob,
): { schedule: string; description: string; nextRuns: number[]; nextRunDeferred?: boolean } {
  const sameTiming =
    existing !== undefined
    && schedulesEqual(schedule, existing.schedule)
    && timezone === existing.tz;
  const timing: {
    schedule: Schedule;
    createdAt: number;
    scheduleUpdatedAt?: number;
    scheduleRevision?: number;
    lastRunScheduleRevision?: number;
    lastRunAt?: number;
    pendingDueAt?: number;
    tz?: string;
  } = {
    schedule,
    createdAt: sameTiming ? existing.createdAt : now,
    ...(sameTiming && existing.scheduleUpdatedAt !== undefined
      ? { scheduleUpdatedAt: existing.scheduleUpdatedAt }
      : {}),
    ...(sameTiming && existing.scheduleRevision !== undefined
      ? { scheduleRevision: existing.scheduleRevision }
      : {}),
    ...(sameTiming && existing.lastRunScheduleRevision !== undefined
      ? { lastRunScheduleRevision: existing.lastRunScheduleRevision }
      : {}),
    ...(sameTiming && existing.lastRunAt !== undefined
      ? { lastRunAt: existing.lastRunAt }
      : {}),
    ...(sameTiming && existing.pendingDueAt !== undefined
      ? { pendingDueAt: existing.pendingDueAt }
      : {}),
    ...(timezone ? { tz: timezone } : {}),
  };
  const nextRuns: number[] = [];
  const deadlineMs = Date.now() + 40;
  let nextRunDeferred = false;
  for (let count = 0; count < 3; count++) {
    const upcoming = nextRun(
      timing,
      count === 0 ? now : nextRuns[nextRuns.length - 1],
      { deadlineMs },
    );
    if (upcoming === null) {
      nextRunDeferred = schedule.kind === "cron" && Date.now() >= deadlineMs;
      break;
    }
    if (!validDateTimestamp(upcoming)) {
      nextRunDeferred = true;
      break;
    }
    nextRuns.push(upcoming);
    timing.lastRunAt = upcoming;
    if (timing.scheduleRevision !== undefined || timing.lastRunScheduleRevision !== undefined) {
      timing.lastRunScheduleRevision = timing.scheduleRevision ?? 0;
    }
  }
  return {
    schedule: automationScheduleSpec(schedule),
    description: describeSchedule(schedule),
    nextRuns,
    ...(nextRunDeferred ? { nextRunDeferred: true } : {}),
  };
}

/** Parse an automation schedule while permitting an existing completed one-shot's exact canonical
 * timestamp to round-trip through validation/update. A different past timestamp remains invalid. */
function automationScheduleForRequest(
  input: string,
  now: number,
  existing?: CronJob,
): ReturnType<typeof parseSchedule> {
  const parsed = parseSchedule(input, now);
  if (!("error" in parsed)) return parsed;
  // 0.134.6 accepted safe-integer intervals longer than the new renderer-facing date horizon. Preserve
  // exact list → validate/update round-trips for those existing jobs without reopening that range to adds
  // or allowing a different oversized interval to be substituted.
  if (
    existing?.schedule.kind === "every"
    && input.trim() === existing.schedule.display
  ) {
    return existing.schedule;
  }
  if (
    existing?.schedule.kind === "once"
    && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(input.trim())
    && Date.parse(input.trim()) === existing.schedule.runAt
  ) {
    return existing.schedule;
  }
  return parsed;
}

export async function startServe(opts: ServeOpts, deps: ServeDeps): Promise<ServeHandle> {
  // Best-effort private-state hygiene; never delays or prevents the local server from starting.
  pruneStoredToolResults();
  const runtimeLog = createServeRuntimeLogger({ enabled: !deps.quietDiscovery });
  const token = opts.token ?? randomBytes(16).toString("hex");
  const instanceId = randomUUID();
  const hub = new SessionHub(deps.store ?? realStore, deps.version);
  const externalSessions = deps.externalSessions ?? createExternalSessionRegistry({ haraVersion: deps.version });
  // Existing pre-index transcripts are imported in yielding batches. The server can accept health/init
  // traffic immediately; only metadata listing waits for the one-time compatibility view to be complete.
  const sessionIndexReady = (): Promise<void> =>
    deps.store && deps.store !== realStore
      ? Promise.resolve()
      : ensureSessionMetadataIndex();
  // Start the yielding legacy import immediately, but keep the accessor retryable if another process
  // crashes or holds the migration lock beyond one request's bounded wait.
  void sessionIndexReady().catch(() => {});
  const sessionIndexRefreshTimer =
    deps.store && deps.store !== realStore
      ? undefined
      : setInterval(() => {
          // Mixed-version installations can still have an older CLI/Desktop writer. Recheck in yielding
          // batches so those sessions become visible without restarting this long-lived Serve process.
          void ensureSessionMetadataIndex({ audit: true }).catch(() => {});
        }, 60_000);
  sessionIndexRefreshTimer?.unref();
  const runtimeInfo = (cwd?: string, model?: string, profileId?: string, spaceId?: string): {
    providerId: string;
    model: string;
    profileId?: string;
    profileKind?: "byok" | "gateway";
    spaceId?: string;
    organizationProfileId?: string;
    effortLevels: string[];
    defaultReasoningEffort?: string;
    availableModels?: string[];
    attachmentCapabilities?: EffectiveAttachmentCapabilities;
  } => {
    const live = deps.runtimeInfo?.(cwd, model, profileId, spaceId);
    return {
      providerId: live?.providerId ?? deps.providerId,
      model: live?.model ?? model ?? deps.model,
      ...(live?.profileId ? { profileId: live.profileId } : profileId ? { profileId } : {}),
      ...(live?.profileKind ? { profileKind: live.profileKind } : {}),
      ...(live?.spaceId ? { spaceId: live.spaceId } : {}),
      ...(live?.organizationProfileId ? { organizationProfileId: live.organizationProfileId } : {}),
      effortLevels: live?.effortLevels ?? deps.effortLevels ?? [],
      ...(live?.defaultReasoningEffort ? { defaultReasoningEffort: live.defaultReasoningEffort } : {}),
      ...(live?.availableModels ? { availableModels: live.availableModels } : {}),
      ...(live?.attachmentCapabilities
        ? { attachmentCapabilities: live.attachmentCapabilities }
        : {}),
    };
  };
  const externalSessionSpaceId = (): string => {
    const runtime = runtimeInfo(opts.cwd);
    return runtime.spaceId ?? failClosedSpaceId(runtime.profileId);
  };
  type SessionSpaceBinding = {
    profileId: string;
    spaceId: string;
    runtime: ReturnType<typeof runtimeInfo>;
    migrateLegacyPersonal: boolean;
  };
  class SessionSpaceBoundaryError extends Error {}
  /** Resolve a persisted session audience against the current authoritative route. A connection id is
   * mutable (re-enrollment can replace its tenant), while SessionMeta.spaceId is immutable. Legacy
   * company transcripts therefore fail closed instead of being silently claimed by whichever tenant
   * currently owns the same local profile id. Only a route explicitly proven to be BYOK Personal may
   * acquire a missing legacy Space binding. */
  const sessionSpaceBinding = (meta: SessionMeta): SessionSpaceBinding => {
    const profileId = meta.profileId ?? runtimeInfo(meta.cwd, meta.model).profileId ?? "personal";
    const runtime = runtimeInfo(meta.cwd, meta.model, profileId, meta.spaceId);
    if (runtime.profileId && runtime.profileId !== profileId) {
      throw new SessionSpaceBoundaryError("this session's provider connection identity changed; start a new conversation");
    }
    const currentSpaceId = runtime.spaceId ?? failClosedSpaceId(runtime.profileId ?? profileId);
    if (!meta.spaceId) {
      const provenPersonal = meta.profileId === "personal"
        && meta.provider !== "hara-gateway"
        && currentSpaceId === "personal"
        && (runtime.profileKind === "byok" || !runtime.profileKind);
      if (!provenPersonal) {
        throw new SessionSpaceBoundaryError(
          "this legacy organization session has no verifiable Space binding; its history remains local and read-only — start a new conversation in the intended company",
        );
      }
      return { profileId, spaceId: "personal", runtime, migrateLegacyPersonal: true };
    }
    if (meta.spaceId !== currentSpaceId) {
      throw new SessionSpaceBoundaryError(
        `this session belongs to Space '${meta.spaceId}', but its provider connection now resolves to '${currentSpaceId}'; old history will not be sent across companies`,
      );
    }
    return { profileId, spaceId: meta.spaceId, runtime, migrateLegacyPersonal: false };
  };
  const bindSafeLegacyPersonalSession = (session: ServeSession, binding: SessionSpaceBinding): void => {
    if (!binding.migrateLegacyPersonal) return;
    session.meta.profileId = binding.profileId;
    session.meta.spaceId = binding.spaceId;
    hub.save(session);
  };
  const refreshSessionProvider = async (session: ServeSession): Promise<boolean> => {
    const binding = sessionSpaceBinding(session.meta);
    bindSafeLegacyPersonalSession(session, binding);
    const fresh = deps.buildProviderFor
      ? await deps.buildProviderFor(session.meta.model, session.effort, session.meta.cwd, session.meta.profileId, session.meta.spaceId)
      : await deps.buildSessionProvider(session.meta.cwd, session.meta.profileId, session.meta.spaceId);
    if (!fresh || fresh.model !== session.meta.model) return false;
    // Re-check after the asynchronous provider build. Re-enrollment can replace a local route while
    // authentication is in flight; never install that provider onto a differently scoped transcript.
    sessionSpaceBinding(session.meta);
    session.provider = fresh;
    session.meta.provider = fresh.id;
    return true;
  };
  const roleForSession = (session: ServeSession): Role | undefined => {
    if (!session.meta.agentRef) return undefined;
    const runtime = runtimeInfo(session.meta.cwd, session.meta.model, session.meta.profileId, session.meta.spaceId);
    const identityProfileId = runtime.organizationProfileId ?? session.meta.profileId;
    const resolved = resolveServeAgent(
      session.meta.agentRef,
      session.meta.cwd,
      identityProfileId,
      { includeDismissed: true },
    );
    if (!resolved) throw new Error(`agent '${session.meta.agentRef}' is no longer available for this session connection`);
    if ("ambiguous" in resolved) {
      throw new Error(`agent '${session.meta.agentRef}' became ambiguous; expected its persisted qualified identity`);
    }
    if (
      resolved.ref !== session.meta.agentRef
      || canonicalProjectPath(resolved.cwd) !== canonicalProjectPath(session.meta.cwd)
    ) {
      throw new Error(`agent '${session.meta.agentRef}' no longer resolves to this session workspace`);
    }
    return resolved.role;
  };
  const wss = new WebSocketServer({ host: opts.host, port: opts.port, maxPayload: 10 * 1024 * 1024 });
  await new Promise<void>((res, rej) => {
    wss.once("listening", res);
    wss.once("error", rej);
  });
  const port = (wss.address() as { port: number }).port;

  const authed = new Set<WebSocket>();
  interface OwnedExternalTerminalStream {
    streamId: string;
    sessionId: string;
    mode: "observe" | "control";
    stream: ExternalTerminalStream;
  }
  const externalTerminalStreams = new Map<WebSocket, Map<string, OwnedExternalTerminalStream>>();
  const externalTerminalControllers = new Map<string, { ws: WebSocket; streamId: string }>();
  const pendingApprovals = new Map<string, {
    finish: (v: boolean | "always") => void;
    allowAlways: boolean;
  }>();
  const inFlightRequests = new Set<Promise<void>>();
  const sessionSubmissionTails = new Map<string, Promise<void>>();
  const automationRuns = new Map<AbortController, ReturnType<typeof runJobTracked>>();
  // Physical provider/tool work can outlive its logical timeout. Keep a process-level ledger independent
  // of SessionHub membership so detach/delete cannot make an updater believe the old engine is quiescent.
  const activeOperations = new Set<Promise<unknown>>();
  let taskEventSequence = 0;
  const workforceLedger = new WorkforceStateLedger(instanceId);
  let closing = false;
  let closePromise: Promise<void> | null = null;

  const trackActiveOperation = <T>(operation: Promise<T>): Promise<T> => {
    activeOperations.add(operation);
    const settled = (): void => {
      activeOperations.delete(operation);
      if (closing) hub.releaseIdle();
    };
    void operation.then(settled, settled);
    return operation;
  };

  /** Serialize only each input's routing decision, not the lifetime of a started turn. Starting marks the
   * session busy synchronously and returns a completion Promise, so the next ordered submission can still
   * steer that live turn while the original request continues streaming. */
  const enqueueSessionSubmission = <T>(
    sessionId: string,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const prior = sessionSubmissionTails.get(sessionId) ?? Promise.resolve();
    const current = prior.catch(() => {}).then(operation);
    const tail = current.then(() => {}, () => {});
    sessionSubmissionTails.set(sessionId, tail);
    void tail.then(() => {
      if (sessionSubmissionTails.get(sessionId) === tail) sessionSubmissionTails.delete(sessionId);
    });
    return current;
  };

  const releaseSessionBusyIfIdle = (session: ServeSession): void => {
    if (
      session.abort === null &&
      session.pendingProviderTurns === 0 &&
      session.pendingToolRuns === 0
    ) {
      session.busy = false;
    }
  };

  const observeProviderTurn = (session: ServeSession, turn: Promise<unknown>): void => {
    const startedAt = Date.now();
    session.pendingProviderTurns += 1;
    trackActiveOperation(turn);
    runtimeLog("provider.started", { sessionId: session.meta.id });
    const settled = (): void => {
      session.pendingProviderTurns = Math.max(0, session.pendingProviderTurns - 1);
      // A logical timeout/interrupt may return before a non-cooperative provider physically settles.
      // Retain the per-session lease so a second turn cannot share that provider instance concurrently.
      releaseSessionBusyIfIdle(session);
      if (closing) hub.releaseIdle();
    };
    void turn.then(() => {
      runtimeLog("provider.completed", {
        sessionId: session.meta.id,
        durationMs: Date.now() - startedAt,
      });
      settled();
    }, (error) => {
      runtimeLog("provider.failed", {
        sessionId: session.meta.id,
        category: serveRuntimeFailureCategory(error),
        durationMs: Date.now() - startedAt,
      });
      settled();
    });
  };

  const observeToolRun = (
    session: ServeSession,
    toolRun: Promise<unknown>,
    tool: { name: string },
  ): void => {
    const startedAt = Date.now();
    session.pendingToolRuns += 1;
    trackActiveOperation(toolRun);
    runtimeLog("tool.started", { sessionId: session.meta.id, tool: tool.name });
    const settled = (): void => {
      session.pendingToolRuns = Math.max(0, session.pendingToolRuns - 1);
      // `abort === null` means the logical turn already returned. Keep the session busy/locked until
      // every late side-effect-capable Promise has physically stopped.
      releaseSessionBusyIfIdle(session);
      if (closing) hub.releaseIdle();
    };
    void toolRun.then(() => {
      runtimeLog("tool.completed", {
        sessionId: session.meta.id,
        tool: tool.name,
        durationMs: Date.now() - startedAt,
      });
      settled();
    }, (error) => {
      runtimeLog("tool.failed", {
        sessionId: session.meta.id,
        tool: tool.name,
        category: serveRuntimeFailureCategory(error),
        durationMs: Date.now() - startedAt,
      });
      settled();
    });
  };

  /** An RPC-requested shutdown is a cooperative handoff (for example, before a Desktop update), not a
   * force-stop. Refuse it while ANY client still owns live work. `inFlightRequests` covers async work that
   * has not attached a session yet (provider factories/settings/filesystem scans); the session fields cover
   * turns, compaction, provider reconfiguration, and physically late provider/tool promises. */
  const hasActiveClientWork = (): boolean =>
    inFlightRequests.size > 0 ||
    automationRuns.size > 0 ||
    activeOperations.size > 0 ||
    pendingApprovals.size > 0 ||
    hub.active().some((session) =>
      session.busy ||
      session.configuring ||
      session.abort !== null ||
      session.pendingProviderTurns > 0 ||
      session.pendingToolRuns > 0
    );

  const broadcast = (method: string, params: Record<string, unknown>): void => {
    const frame = rpcNotify(method, params);
    for (const ws of authed) if (ws.readyState === ws.OPEN) ws.send(frame);
  };
  const notifySocket = (ws: WebSocket, method: string, params: Record<string, unknown>): boolean => {
    if (ws.readyState !== ws.OPEN) return false;
    // A terminal can repaint quickly. Fail closed instead of buffering unbounded private terminal data
    // in memory behind a suspended renderer/mobile client.
    if (ws.bufferedAmount > 4 * 1024 * 1024) return false;
    ws.send(rpcNotify(method, params));
    return true;
  };
  const releaseExternalTerminal = async (
    ws: WebSocket,
    streamId: string,
    reason: "released" | "control_transferred" | "slow_client" = "released",
    notify = true,
  ): Promise<void> => {
    const owned = externalTerminalStreams.get(ws)?.get(streamId);
    if (!owned) return;
    externalTerminalStreams.get(ws)?.delete(streamId);
    if (externalTerminalStreams.get(ws)?.size === 0) externalTerminalStreams.delete(ws);
    const controller = externalTerminalControllers.get(owned.sessionId);
    if (controller?.ws === ws && controller.streamId === streamId) {
      externalTerminalControllers.delete(owned.sessionId);
    }
    await owned.stream.release().catch(() => {});
    if (notify) notifySocket(ws, "external.event.terminal.closed", {
      sessionId: owned.sessionId,
      streamId,
      reason,
    });
  };
  const releaseExternalTerminalsForSocket = async (ws: WebSocket): Promise<void> => {
    const ids = [...(externalTerminalStreams.get(ws)?.keys() ?? [])];
    await Promise.all(ids.map((streamId) => releaseExternalTerminal(ws, streamId, "released", false)));
  };
  // Adapter turn identifiers never cross Serve. Keep the one active wire id per opaque session so a
  // follow-up (`steer`) is correlated with the same stream that Desktop is already rendering.
  const externalWireTurns = new Map<string, string>();
  const confirmExternalSessionAction = (
    sessionId: string,
    question: string,
    signal: AbortSignal,
    allowAlways = false,
  ): Promise<boolean | "always"> => new Promise((resolve) => {
    const approvalId = randomUUID();
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (value: boolean | "always"): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pendingApprovals.delete(approvalId);
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = (): void => finish(false);
    timer = setTimeout(() => finish(false), APPROVAL_TIMEOUT_MS);
    timer.unref();
    pendingApprovals.set(approvalId, { finish, allowAlways });
    if (signal.aborted) finish(false);
    else {
      signal.addEventListener("abort", onAbort, { once: true });
      broadcast("external.approval.request", { sessionId, approvalId, question, allowAlways });
    }
  });
  const nextTaskEventCursor = (): TaskLifecycleCursor => {
    const sequence = taskEventSequence + 1;
    if (!Number.isSafeInteger(sequence)) {
      throw new Error("task lifecycle event sequence exhausted");
    }
    return { streamId: instanceId, sequence };
  };
  const publishTaskState = (event: ReturnType<typeof taskLifecycleEvent>): void => {
    // Commit the cursor immediately before the synchronous broadcast. Dedupe paths never consume one,
    // while every published event has a unique position in this server-wide stream.
    taskEventSequence = event.sequence;
    broadcast("event.task_state", { ...event });
    // Project every published task transition into the visual workforce stream. Task updates originate
    // from both the regular turn sink and a few lifecycle helpers, so keeping this beside the canonical
    // task broadcast prevents Desktop from missing the normal starting/responding/completed path.
    broadcast("event.workforce_state", { ...workforceLedger.recordTask(event) });
  };
  const broadcastTaskState = (session: ServeSession, activity: TaskLifecycleActivity): void => {
    if (!session.task) return;
    const event = taskLifecycleEvent(
      session.meta.id,
      session.task,
      session.meta.todos ?? [],
      activity,
      nextTaskEventCursor(),
    );
    publishTaskState(event);
  };

  // Discovery file — the desktop shell reads this to find the running server (like a pid/port file).
  const discoveryDir = join(deps.discoveryHome ?? homedir(), ".hara");
  const artifactHome = deps.artifactHome ?? homedir();
  const discoveryPath = join(discoveryDir, "serve.json");
  const discovery: DiscoveryRecord = { host: opts.host, port, token, pid: process.pid, version: deps.version, instanceId };
  if (!deps.quietDiscovery) {
    try {
      await writeDiscovery(discoveryDir, discoveryPath, discovery);
    } catch (error) {
      // The socket is already listening so its assigned port can be advertised. If advertising fails,
      // fail atomically as a server too: never leave an unreachable/authentication-less listener behind.
      await removeOwnedDiscovery(discoveryDir, discoveryPath, discovery).catch(() => {});
      for (const client of wss.clients) client.terminate();
      await Promise.race([
        new Promise<void>((resolve) => {
          try {
            wss.close(() => resolve());
          } catch {
            resolve();
          }
        }),
        pause(SOCKET_CLOSE_GRACE_MS),
      ]);
      throw error;
    }
  }
  runtimeLog("serve.started", { version: deps.version, port });

  /** Move accepted steering from the task inbox into a write-ahead transcript snapshot. The caller either
   *  appends the returned messages to live history or returns them to runAgent for that append. A crash can
   *  therefore recover pending inbox state or consumed transcript state, never lose an acknowledged input. */
  const materializePendingSteering = (s: ServeSession): NeutralMsg[] => {
    const consumed = consumePendingTaskSteering(s.task);
    if (!consumed) return [];
    const messages: NeutralMsg[] = consumed.entries.map((entry) => ({
      role: "user",
      content: `${INTERJECT_PREFIX}\n\n${entry.content}`,
    }));
    hub.saveSnapshot(s, [...s.history, ...messages], consumed.task);
    s.task = consumed.task;
    s.history.push(...messages);
    return messages;
  };

  /** Run one turn on a session, streaming events to all authed clients. */
  const runTurn = async (
    s: ServeSession,
    text: string,
    attachments: ValidatedSessionAttachments = { images: [], contexts: [], views: [] },
    forceNewTask = false,
    displayText = text,
  ): Promise<{
    reply: string;
    usage: { input: number; output: number };
    ctx: { lastInput: number; window: number; pct: number };
    taskId: string;
    turnId: string;
    status?: "paused";
    stopReason?: "deadline" | "task_round_budget" | "max_rounds" | "strategy_stall";
  }> => {
    const sessionId = s.meta.id;
    const runtimeStartedAt = Date.now();
    const spaceBinding = sessionSpaceBinding(s.meta);
    bindSafeLegacyPersonalSession(s, spaceBinding);
    // Serve sessions can stay attached to Desktop for days. Refresh project instructions at the
    // boundary of each idle turn so an AGENTS.md edit takes effect without restarting the server or
    // discarding conversation history. Active steering never enters runTurn, so a file change cannot
    // rewrite the system context underneath work that is already running.
    s.projectContext = loadAgentContext(s.meta.cwd) || undefined;
    s.busy = true;
    const turnAbort = new AbortController();
    s.abort = turnAbort;
    let interaction: TaskInteraction;
    let executionContext: string;
    try {
      const recoveredSteering = materializePendingSteering(s);
      interaction = !forceNewTask && s.task && s.task.status !== "completed" &&
        (recoveredSteering.length > 0 || requestsTaskContinuation(text))
        ? newSteerInteraction(s.task.turnId)
        : newTurnInteraction();
      if (interaction.kind === "steer") {
        const continued = continueTaskExecution(s.task, interaction);
        if (!continued.ok) throw new Error(continued.reason);
        s.task = continued.task;
      } else {
        s.task = createTaskExecution(text, interaction.turnId);
        // Checklists belong to executions, not to the surrounding conversation thread. An unrelated task
        // must not inherit old pending todos and be forced back into paused state after a successful turn.
        s.meta.todos = [];
      }
      executionContext = taskExecutionContext(s.task, interaction, s.meta.todos ?? []);
      hub.save(s); // crash-safe running identity before provider/tool side effects
    } catch (error) {
      // Initialization happens before the main turn try/finally. Release the session here as well so a
      // transient snapshot/config error cannot wedge it in a permanently busy, non-interruptible state.
      s.abort = null;
      s.busy = false;
      throw error;
    }
    let lastTaskStateSignature = "";
    const emitTaskState = (
      activity: TaskLifecycleActivity,
      todos = s.meta.todos ?? [],
    ): void => {
      if (!s.task) return;
      const event = taskLifecycleEvent(
        sessionId,
        s.task,
        todos,
        activity,
        nextTaskEventCursor(),
      );
      const {
        at: _at,
        streamId: _streamId,
        sequence: _sequence,
        ...stableEvent
      } = event;
      const signature = JSON.stringify(stableEvent);
      if (signature === lastTaskStateSignature) return;
      lastTaskStateSignature = signature;
      publishTaskState(event);
    };
    broadcast("event.turn_start", { sessionId, taskId: s.task.id, turnId: s.task.turnId });
    runtimeLog("turn.started", { sessionId });
    emitTaskState({ state: "running", phase: "starting" });
    let historyStart = s.history.length;
    const before = { input: s.stats.input, output: s.stats.output };
    const sink: UiSink = {
      text: (d) => {
        emitTaskState({ state: "running", phase: "responding" });
        broadcast("event.text", { sessionId, delta: d });
      },
      reasoning: () => {
        // Provider reasoning is private execution state. Persistent clients receive only the typed phase;
        // never forward the model's reasoning delta into the renderer notification stream.
        emitTaskState({ state: "running", phase: "thinking" });
      },
      status: (phase) => {
        // A task_intake/checkpoint round can be followed by a slow provider request. Publish that boundary
        // immediately so Desktop does not leave the last tool phase looking frozen while the model is alive.
        if (phase === "waiting") {
          emitTaskState({ state: "running", phase: "thinking", detail: "Waiting for model response" });
        }
      },
      tool: (name, preview) => {
        // The task/status plane is safe for ambient surfaces such as an always-on-top companion.
        // Command/path previews remain on the explicit event.tool transcript plane only.
        emitTaskState({ state: "running", phase: "tool", detail: name });
        broadcast("event.tool", { sessionId, name, preview });
      },
      diff: (t) => broadcast("event.diff", { sessionId, text: t }),
      notice: (t) => broadcast("event.notice", { sessionId, text: t }),
      surface: (event) => broadcast("event.surface", { sessionId, ...event }),
    };
    const confirm = (
      q: string,
      signal: AbortSignal = turnAbort.signal,
      options: { allowAlways?: boolean } = {},
    ): Promise<boolean | "always"> =>
      new Promise((resolve) => {
        const approvalId = randomUUID();
        const allowAlways = options.allowAlways === true;
        let settled = false;
        let timer: ReturnType<typeof setTimeout>;
        const finish = (v: boolean | "always"): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          pendingApprovals.delete(approvalId);
          signal.removeEventListener("abort", onAbort);
          if (!signal.aborted && s.task?.status === "running") {
            emitTaskState({
              state: "running",
              phase: "thinking",
              detail: v === false ? "Approval denied; continuing safely" : "Approval granted; continuing",
            });
          }
          resolve(v);
        };
        const onAbort = (): void => finish(false);
        timer = setTimeout(() => finish(false), APPROVAL_TIMEOUT_MS); // unanswered → deny, turn continues
        pendingApprovals.set(approvalId, { finish, allowAlways });
        if (signal.aborted) finish(false);
        else {
          // `signal` composes the owning turn cancellation with runAgent's lifecycle cancellation. Listening
          // only to turnAbort would leave the approval map and Desktop prompt stale after an internal stop.
          signal.addEventListener("abort", onAbort, { once: true });
          emitTaskState({
            state: "waiting",
            phase: "approval",
            detail: q,
            approval: { id: approvalId, question: q },
          });
          broadcast("approval.request", { sessionId, approvalId, question: q, allowAlways });
        }
      });
    let stopTodoEvents = (): void => {};
    try {
      if (!(await refreshSessionProvider(s))) {
        throw new Error(s.meta.spaceId && s.meta.spaceId !== "personal"
          ? "company access expired or was revoked; local conversation history is unchanged; sign in or re-enroll before continuing"
          : `provider not authenticated for pinned model '${s.meta.model}' at ${s.meta.cwd}`);
      }
      // Compact the durable transcript before building the next provider request. Failed tool rounds do
      // not reach the successful-turn compactor below, but they can still append large diagnostics and
      // image metadata. Waiting until after the next model call would make the request-only context guard
      // discard useful history without replacing it with a durable checkpoint.
      const preflightDecision = serveAutoCompactDecision(
        s.meta.model,
        // Percentage/token triggers are handled after every successful turn. Preflight exists for
        // failure-grown durable history only; reusing the last watermark here would immediately
        // summarize an already-compacted checkpoint again when a custom low token cap is configured.
        0,
        s.history.length,
        deps.autoCompact?.(s.meta.cwd),
        historyChars(s.history),
      );
      if (preflightDecision.compact && !turnAbort.signal.aborted) {
        broadcast("event.notice", {
          sessionId,
          text: "✻ Auto-compacting large durable history before this request…",
        });
        const compactAbort = new AbortController();
        const abortCompact = (): void => compactAbort.abort();
        turnAbort.signal.addEventListener("abort", abortCompact, { once: true });
        try {
          const summary = await compactSession(s, compactAbort);
          broadcast("event.notice", {
            sessionId,
            text: summary
              ? `(auto-compacted — context replaced with a summary; ${s.meta.workingSet?.length ?? 0} notes kept)`
              : "(auto-compact failed — conversation was kept and this request will continue)",
          });
        } catch {
          broadcast("event.notice", {
            sessionId,
            text: "(auto-compact failed — conversation was kept and this request will continue)",
          });
        } finally {
          turnAbort.signal.removeEventListener("abort", abortCompact);
        }
        // Compaction replaces the backing array. Reply extraction must start after the new checkpoint,
        // not at the old (usually much larger) transcript index.
        historyStart = s.history.length;
      }
      // Resolve company-managed roles only after the session/provider audience has been revalidated.
      const sessionRole = roleForSession(s);
      const sessionRolePolicyVersion = sessionRole && s.meta.spaceId && s.meta.spaceId !== "personal"
        ? sessionRole.organizationPolicyVersion
        : undefined;
      sessionSpaceBinding(s.meta);
      const sessionRoleToolFilter = roleToolFilter(sessionRole);
      const turnGuardian = deps.buildGuardian
        ? await deps.buildGuardian(s.meta.cwd, s.meta.profileId, s.meta.spaceId)
        : deps.guardian;
      sessionSpaceBinding(s.meta);
      restoreTodos(s.meta.todos, sessionId);
      stopTodoEvents = onTodosChange((todos) => {
        // Keep the session snapshot current while the turn runs. Steering and task-intake checkpoints can
        // then publish/persist the same checklist the model just wrote instead of regressing to turn-start.
        s.meta.todos = serializeTodos(sessionId);
        emitTaskState({ state: "running", phase: "checkpoint" }, s.meta.todos);
      }, sessionId);
      // Slash skills, CLI parity: "/skill-id request…" expands into the skill-entering message, so a
      // desktop composer's "/" popup triggers the exact behavior the terminal gets. Unknown ids fall
      // through as plain text (the model sees what the user typed).
      let content = text;
      let preparedImages = attachments.images;
      let attachmentViews = attachments.views;
      let imageDescription: string | undefined;
      let imageContext = "";
      if (preparedImages.length) {
        sessionSpaceBinding(s.meta);
        const runtime = runtimeInfo(s.meta.cwd, s.meta.model, s.meta.profileId, s.meta.spaceId);
        const imageMode = runtime.attachmentCapabilities?.image.mode;
        if (deps.prepareImages) {
          const prepared = await deps.prepareImages(preparedImages, {
            cwd: s.meta.cwd,
            model: s.meta.model,
            profileId: s.meta.profileId,
            spaceId: s.meta.spaceId!,
            signal: turnAbort.signal,
          });
          sessionSpaceBinding(s.meta);
          preparedImages = Array.isArray(prepared.images) ? prepared.images : [];
          imageDescription = prepared.description?.trim() ? prepared.description : undefined;
          if (imageDescription) {
            const viaModel = prepared.viaModel
              ?? runtime.attachmentCapabilities?.image.viaModel
              ?? "vision model";
            attachmentViews = attachmentViews.map((attachment) =>
              attachment.kind === "image"
                ? { ...attachment, strategy: "vision-sidecar" }
                : attachment,
            );
            imageContext = (
              `\n\n[Attached image description — read first by ${viaModel} for ` +
              `${s.meta.model}]\n${imageDescription}`
            );
          } else if (!preparedImages.length) {
            throw new Error(`model '${s.meta.model}' has no authorized image route for this session`);
          }
        } else if (imageMode !== "native") {
          throw new Error(
            imageMode === "unsupported"
              ? `model '${s.meta.model}' cannot read images; configure a vision-first model or switch to an image-capable model`
              : imageMode === "vision-sidecar"
                ? "the configured vision-first route is unavailable in this engine"
                : `image capability for model '${s.meta.model}' is unknown; choose a model with advertised image support or set an advanced modelVision override`,
          );
        }
      }
      let slashSkillPolicy: { id: string; allowedTools: readonly string[] } | undefined;
      const slash = /^\/([a-z0-9][\w-]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
      if (slash) {
        const sk = loadSkillIndex(s.meta.cwd).find((k) => k.id === slash[1]);
        if (sk) {
          const rest = slash[2]?.trim();
          content = `Skill \`${sk.id}\`:\n${loadSkillBody(sk)}\n\n---\nEntering ${sk.id} mode${rest ? ` — request: ${rest}` : ""}. Follow this skill now. If it has a workspace or live preview, OPEN it FIRST so any existing progress is visible, then proceed — offer to continue existing work or start fresh.`;
          if (sk.allowedTools !== undefined) slashSkillPolicy = { id: sk.id, allowedTools: sk.allowedTools };
        }
      }
      // A recognized slash skill replaces the user's raw command with its instructions. Append translated
      // image context afterwards so the conversation model receives no raw bytes on a vision-first route.
      content += imageContext;
      content += await expandExplicitAttachmentsAsync(
        attachments.contexts,
        s.meta.cwd,
        { signal: turnAbort.signal },
      );
      // @file mentions expand to file contents, same as the CLI (`@src/foo.ts` in the composer works).
      // Native images ride along in NeutralMsg.images. Vision-first turns persist only the description
      // plus attachment metadata, so resume/replay never re-sends the original image to the main model.
      s.history.push({
        role: "user",
        content: await expandMentionsAsync(content, s.meta.cwd, { signal: turnAbort.signal }),
        displayContent: displayText,
        ...(preparedImages.length ? { images: preparedImages } : {}),
        ...(imageDescription ? { imageDescription } : {}),
        ...(attachmentViews.length ? { attachments: attachmentViews } : {}),
      });
      let outcome;
      do {
        outcome = await runAgent(s.history, {
        provider: s.provider,
        organizationPolicyVersion: sessionRolePolicyVersion,
        ctx: {
          cwd: s.meta.cwd,
          sandbox: deps.sandbox,
          profileId: s.meta.profileId,
          spaceId: s.meta.spaceId,
          todoScope: sessionId,
          sessionId,
          spawn: async (t, role, signal) => {
            const taskId = s.task?.id;
            const turnId = s.task?.turnId;
            sessionSpaceBinding(s.meta);
            const result = await deps.spawnSubagent(
              s.provider,
              s.meta.cwd,
              s.projectContext,
              s.stats,
              t,
              role,
              signal,
              {
                onProviderTurn: (turn) => observeProviderTurn(s, turn),
                onToolRun: (toolRun, tool) => observeToolRun(s, toolRun, tool),
                onSubagentLifecycle: (event) => {
                  if (!taskId || !turnId) return;
                  const snapshot = workforceLedger.recordSubagent(s.meta.id, taskId, turnId, event);
                  if (snapshot) broadcast("event.workforce_state", { ...snapshot });
                },
              },
              s.meta.profileId,
              s.meta.spaceId,
            );
            sessionSpaceBinding(s.meta);
            return result;
          },
          ui: sink,
          inspectImage: async (image, hint, signal) => {
            sessionSpaceBinding(s.meta);
            const runtime = runtimeInfo(s.meta.cwd, s.meta.model, s.meta.profileId, s.meta.spaceId);
            let images = [image];
            if (deps.prepareImages) {
              const prepared = await deps.prepareImages(images, {
                cwd: s.meta.cwd,
                model: s.meta.model,
                profileId: s.meta.profileId,
                spaceId: s.meta.spaceId!,
                signal: signal ?? turnAbort.signal,
                hint,
              });
              sessionSpaceBinding(s.meta);
              if (prepared.description?.trim()) {
                return {
                  text: prepared.description,
                  model: prepared.viaModel
                    ?? runtime.attachmentCapabilities?.image.viaModel
                    ?? s.provider.model,
                };
              }
              images = Array.isArray(prepared.images) ? prepared.images : [];
            } else if (runtime.attachmentCapabilities?.image.mode !== "native") {
              throw new Error(
                `model '${s.meta.model}' has no authorized image route for this session`,
              );
            }
            if (!images.length) {
              throw new Error(`model '${s.meta.model}' has no authorized image route for this session`);
            }
            sessionSpaceBinding(s.meta);
            return {
              text: await describeImages(s.provider, images, {
                hint,
                signal: signal ?? turnAbort.signal,
              }),
              model: s.provider.model,
            };
          },
        },
        approval: s.approval,
        approvalChannel: true,
        confirm,
        autoApprove: s.autoApprove,
        projectApprovals: projectApprovalPolicy(s.meta.cwd),
        projectContext: s.projectContext,
        memory: memoryDigest(s.meta.cwd, s.meta.spaceId),
        continuationSession: s.continuationSession,
        executionContext,
        ...(sessionRole ? { systemOverride: sessionRole.system } : {}),
        ...(sessionRoleToolFilter ? { toolFilter: sessionRoleToolFilter } : {}),
        ...(sessionRole?.readOnly ? { hooks: false } : {}),
        ...(slashSkillPolicy ? { skillPolicies: [slashSkillPolicy] } : {}),
        taskIntake: {
          task: s.task,
          current: () => s.task,
          onUpdate: (next): void => {
            s.task = next;
            emitTaskState({ state: "running", phase: "checkpoint" }, serializeTodos(sessionId));
          },
          onCheckpoint: (next): void => {
            s.task = next;
            hub.save(s);
            emitTaskState({ state: "running", phase: "checkpoint" }, serializeTodos(sessionId));
          },
          onRoundUsage: (next): void => {
            s.task = next;
            hub.save(s);
            emitTaskState({ state: "running", phase: "checkpoint" }, serializeTodos(sessionId));
          },
        },
        pendingInput: async () => {
          materializePendingSteering(s); // helper updates the shared live history after its write-ahead save
          return [];
        },
        stats: s.stats,
        signal: turnAbort.signal,
        onProviderTurn: (turn) => observeProviderTurn(s, turn),
        onToolRun: (toolRun, tool) => observeToolRun(s, toolRun, tool),
        guardian: turnGuardian,
        ...(deps.runLimits?.(s.meta.cwd) ?? {}),
        });
        // A steer may land after the agent's final in-loop drain but before the logical turn returns. Keep
        // it in the same task/run instead of making the client retry it as an unrelated session.send.
        const trailing = materializePendingSteering(s);
        if (!trailing.length || turnAbort.signal.aborted || outcome.status !== "completed") break;
      } while (true);
      s.meta.todos = serializeTodos(sessionId);
      s.task = finishTaskExecution(s.task, outcome, s.meta.todos, turnAbort.signal.aborted);
      hub.save(s);
      emitTaskState({ phase: "finished" }, s.meta.todos);
      if (outcome.status !== "completed") {
        const usage = { input: s.stats.input - before.input, output: s.stats.output - before.output };
        // context watermark rides along with every turn end (codex thread/tokenUsage/updated pattern) —
        // clients render a meter without an extra round-trip.
        const ctx = ctxOf(s);
        const failure = outcome.error ?? (outcome.status === "empty"
          ? "the model returned an empty response after retrying"
          : outcome.status === "halted"
            ? "agent turn halted by a safety control"
            : "agent turn failed");
        if (outcome.status === "halted" && (
          outcome.stopReason === "deadline"
          || outcome.stopReason === "task_round_budget"
          || outcome.stopReason === "max_rounds"
          || outcome.stopReason === "strategy_stall"
        )) {
          // A bounded lifecycle pause is a successful, recoverable checkpoint transition. The typed
          // task event already says `paused`; returning a normal RPC result keeps Desktop and other Serve
          // clients from rendering the same state as `error:` while still exposing the focused /continue
          // guidance to request/response-only clients. Other safety halts remain explicit failures.
          broadcast("event.turn_end", {
            sessionId,
            taskId: s.task!.id,
            turnId: s.task!.turnId,
            reply: "",
            status: "paused",
            stopReason: outcome.stopReason,
            usage,
            ctx,
          });
          runtimeLog("turn.paused", {
            sessionId,
            category: outcome.stopReason === "deadline" ? "timeout" : "conflict",
            durationMs: Date.now() - runtimeStartedAt,
          });
          return {
            reply: failure,
            usage,
            ctx,
            taskId: s.task!.id,
            turnId: s.task!.turnId,
            status: "paused",
            stopReason: outcome.stopReason,
          };
        }
        broadcast("event.turn_end", { sessionId, taskId: s.task!.id, turnId: s.task!.turnId, reply: "", error: failure, status: outcome.status, usage, ctx });
        throw new Error(failure);
      }
      // A persistent session may already contain many assistant messages. Only messages appended by THIS
      // request are eligible for its reply; a failed/empty turn must never replay a previous success.
      const reply = lastAssistantText(s.history.slice(historyStart));
      // CLI turns already auto-compact after a successful response. Serve used to expose only the manual
      // RPC, so Desktop conversations kept resending a large transcript until a person noticed the meter.
      // Capture the reply first, then compact under the same session lease. Failure is best-effort and never
      // turns a verified task result into an RPC error; compactSession mutates history only after success.
      try {
        const decision = serveAutoCompactDecision(
          s.meta.model,
          s.stats.lastInput ?? 0,
          s.history.length,
          deps.autoCompact?.(s.meta.cwd),
          historyChars(s.history),
        );
        if (decision.compact && !turnAbort.signal.aborted) {
          broadcast("event.notice", {
            sessionId,
            text: `✻ Auto-compacting conversation (context ${decision.pct}% full, ~${Math.round((s.stats.lastInput ?? 0) / 1000)}k tok)…`,
          });
          const compactAbort = new AbortController();
          const abortCompact = (): void => compactAbort.abort();
          turnAbort.signal.addEventListener("abort", abortCompact, { once: true });
          try {
            const summary = await compactSession(s, compactAbort);
            broadcast("event.notice", {
              sessionId,
              text: summary
                ? `(auto-compacted — context replaced with a summary; ${s.meta.workingSet?.length ?? 0} notes kept)`
                : "(auto-compact failed — conversation was kept; use Compact or start a new conversation)",
            });
          } finally {
            turnAbort.signal.removeEventListener("abort", abortCompact);
          }
        }
      } catch {
        broadcast("event.notice", {
          sessionId,
          text: "(auto-compact failed — conversation was kept; use Compact or start a new conversation)",
        });
      }
      const usage = { input: s.stats.input - before.input, output: s.stats.output - before.output };
      const ctx = ctxOf(s);
      broadcast("event.turn_end", { sessionId, taskId: s.task!.id, turnId: s.task!.turnId, reply, usage, ctx });
      runtimeLog("turn.completed", { sessionId, durationMs: Date.now() - runtimeStartedAt });
      return { reply, usage, ctx, taskId: s.task!.id, turnId: s.task!.turnId };
    } catch (error) {
      if (s.task?.status === "running") {
        s.task = finishTaskExecution(
          s.task,
          { status: "error", error: error instanceof Error ? error.message : String(error) },
          s.meta.todos ?? [],
          turnAbort.signal.aborted,
        );
        hub.save(s);
        emitTaskState({ phase: "finished" }, s.meta.todos ?? []);
      }
      runtimeLog(turnAbort.signal.aborted ? "turn.interrupted" : "turn.failed", {
        sessionId,
        category: turnAbort.signal.aborted ? "cancelled" : serveRuntimeFailureCategory(error),
        durationMs: Date.now() - runtimeStartedAt,
      });
      throw error;
    } finally {
      stopTodoEvents();
      s.abort = null;
      s.busy = s.pendingProviderTurns > 0 || s.pendingToolRuns > 0;
    }
  };

  type RunTurnResult = Awaited<ReturnType<typeof runTurn>>;
  type SubmitResult = SessionSubmitResult<RunTurnResult>;
  type SubmitDecision = SubmitResult | {
    submission: "starting";
    completion: Promise<RunTurnResult>;
  };

  class SessionSubmitParamsError extends Error {}

  /** One server-owned admission point for user input. The busy/turn check and the chosen mutation are
   * contiguous before the first awaited start, so renderer event lag cannot turn a send→steer retry into
   * input for the wrong logical turn. Mention expansion deliberately happens only after routing accepts a
   * steer; a rejected submission has no filesystem/context side effects. */
  const submitSessionInput = async (
    s: ServeSession,
    input: {
      text: string;
      images?: unknown[];
      attachments?: unknown[];
      newTask?: boolean;
      mode: SessionSubmitMode;
      expectedTurnId?: string;
      expectedModel?: string;
      expectedEffort?: string;
    },
    deferStartedResult = false,
  ): Promise<SubmitDecision> => {
    if (
      s.meta.agentRef
      && (s.meta.spaceId ?? failClosedSpaceId(s.meta.profileId)) === "personal"
      && isAgentRefDismissed(s.meta.agentRef)
    ) {
      throw new SessionSubmitParamsError(
        `agent '${s.meta.agentRef}' has left the active staff directory; re-hire it before sending more work`,
      );
    }
    const intents: SessionAttachmentIntent[] = [
      ...((input.attachments ?? []) as SessionAttachmentIntent[]),
      ...((input.images ?? []).map((image: any) => ({
        kind: "image" as const,
        path: image?.path,
        ...(typeof image?.mediaType === "string" ? { mediaType: image.mediaType } : {}),
      }))),
    ];
    const text = input.text;
    const routingState = (): {
      occupied: boolean;
      steerable: boolean;
      activeTurnId?: string;
    } => {
      const steerable = Boolean(
        s.busy
        && s.abort
        && !s.configuring
        && s.task?.status === "running",
      );
      return {
        occupied: s.busy || s.configuring,
        steerable,
        ...(steerable ? { activeTurnId: s.task!.turnId } : {}),
      };
    };
    let state = routingState();

    // A Desktop composer can stage a model/effort change while a turn is still ending. Keep this
    // precondition in Core so an idle transition can never start the input on the old provider.
    if (
      input.expectedModel !== undefined
      && (
        s.meta.model !== input.expectedModel
        || (s.effort ?? "") !== (input.expectedEffort ?? "")
      )
    ) {
      return {
        submission: "not_submitted",
        reason: "configuration_mismatch",
        ...(state.activeTurnId ? { activeTurnId: state.activeTurnId } : {}),
      };
    }

    if (input.newTask && state.occupied) {
      return {
        submission: "not_submitted",
        reason: "not_idle",
        ...(state.activeTurnId ? { activeTurnId: state.activeTurnId } : {}),
      };
    }
    if (input.mode === "start_if_idle" && state.occupied) {
      return { submission: "not_submitted", reason: "not_idle", ...(state.activeTurnId ? { activeTurnId: state.activeTurnId } : {}) };
    }
    if (input.mode === "steer" && !state.steerable) {
      return {
        submission: "not_submitted",
        reason: state.occupied ? "active_turn_not_steerable" : "no_active_turn",
      };
    }

    const shouldSteer = input.mode === "steer" || (input.mode === "start_or_steer" && state.occupied);
    if (shouldSteer) {
      if (!state.steerable) {
        return {
          submission: "not_submitted",
          reason: "active_turn_not_steerable",
        };
      }
      if (intents.length > 0) {
        return { submission: "not_submitted", reason: "attachments_not_steerable", activeTurnId: state.activeTurnId };
      }
      if (!text.trim()) {
        return { submission: "not_submitted", reason: "empty_input", activeTurnId: state.activeTurnId };
      }
      if (input.mode === "steer" && input.expectedTurnId !== state.activeTurnId) {
        return {
          submission: "not_submitted",
          reason: "expected_turn_mismatch",
          expectedTurnId: input.expectedTurnId,
          activeTurnId: state.activeTurnId,
        };
      }
      const expanded = await expandMentionsAsync(text, s.meta.cwd);
      // Expansion can yield while the previous turn finishes. Re-read the execution plane immediately
      // before mutation: start_or_steer follows the then-current state; strict steer keeps its turn guard.
      state = routingState();
      if (input.mode === "start_or_steer" && !state.occupied) {
        const completion = runTurn(s, text);
        if (deferStartedResult) return { submission: "starting", completion };
        const result = await completion;
        return { submission: "started", ...result };
      }
      if (!state.steerable) {
        return {
          submission: "not_submitted",
          reason: state.occupied ? "active_turn_not_steerable" : "no_active_turn",
        };
      }
      if (input.mode === "steer" && input.expectedTurnId !== state.activeTurnId) {
        return {
          submission: "not_submitted",
          reason: "expected_turn_mismatch",
          expectedTurnId: input.expectedTurnId,
          activeTurnId: state.activeTurnId,
        };
      }
      const recorded = recordTaskSteering(s.task, state.activeTurnId!, expanded);
      if (!recorded.ok) {
        return {
          submission: "not_submitted",
          reason: "active_turn_not_steerable",
          activeTurnId: state.activeTurnId,
          detail: recorded.reason,
        };
      }
      s.task = recorded.task;
      hub.save(s); // executable inbox entry is durable before ACK
      broadcastTaskState(s, { state: "running", phase: "steering", detail: "Steering accepted" });
      return { submission: "steered", taskId: s.task.id, turnId: s.task.turnId };
    }

    if (!text.trim() && intents.length === 0) {
      return { submission: "not_submitted", reason: "empty_input" };
    }
    let validated: ValidatedSessionAttachments;
    try {
      validated = validateSessionAttachments(s.meta.cwd, intents);
    } catch (error) {
      throw new SessionSubmitParamsError(error instanceof Error ? error.message : String(error));
    }
    const effectiveText = text.trim()
      ? text
      : "Please inspect the attached context and tell me what you find.";
    const completion = runTurn(s, effectiveText, validated, input.newTask === true, text);
    if (deferStartedResult) return { submission: "starting", completion };
    const result = await completion;
    return { submission: "started", ...result };
  };

  /** Context watermark for a session: how full the model's window was on the last turn. */
  const ctxOf = (s: ServeSession): { lastInput: number; window: number; pct: number } => {
    const lastInput = s.stats.lastInput ?? 0;
    return { lastInput, window: contextWindow(s.meta.model), pct: ctxPctFor(s.meta.model, lastInput) };
  };

  /** Summarize + replace a session's history — the CLI's /compact, serve-side (codex thread/compact).
   *  Mirrors index.ts compactConversation; the file restore is limited to files under the session's own
   *  cwd because serve is multi-session (recentTouched is process-wide and must not leak across projects). */
  const compactSession = async (s: ServeSession, controller: AbortController): Promise<string | null> => {
    const timeoutMs = Math.max(1, Math.min(deps.compactTimeoutMs ?? COMPACT_TIMEOUT_MS, COMPACT_TIMEOUT_MS));
    const recent = recentHistoryForCompaction(s.history);
    const r = await new Promise<Awaited<ReturnType<Provider["turn"]>>>((resolve, reject) => {
      let settled = false;
      let timedOut = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", onAbort);
        fn();
      };
      const onAbort = (): void => finish(() => reject(new Error(timedOut ? "compaction timed out" : "compaction interrupted")));
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort(); // cooperative providers stop their own network/body work too
        onAbort(); // AbortController dispatch is synchronous, but keep this idempotent fallback explicit
      }, timeoutMs);
      timer.unref();
      controller.signal.addEventListener("abort", onAbort, { once: true });
      if (controller.signal.aborted) return onAbort();
      // Promise.resolve protects this boundary even if a non-conforming provider throws synchronously.
      const providerTurn = Promise.resolve().then(() => {
        // The abort can fire after scheduling this microtask but before it runs. Gate the provider call at
        // the actual invocation boundary so an interrupted/expired compact cannot start a late request.
        if (controller.signal.aborted) throw new Error(timedOut ? "compaction timed out" : "compaction interrupted");
        return s.provider.turn({
          system: COMPACT_SYSTEM,
          history: [...compactionSourceHistory(s.history), { role: "user", content: "Create the bounded execution checkpoint now." }],
          tools: [],
          onText: () => {},
          signal: controller.signal,
        });
      });
      observeProviderTurn(s, providerTurn);
      void providerTurn.then(
        (result) => finish(() => resolve(result)),
        (error) => finish(() => reject(error)),
      );
    });
    // Count a physically completed summarizer request even when it returned an error and the original
    // history remains in place. Keep lastInput unchanged until replacement succeeds.
    s.stats.input += r.usage?.input ?? 0;
    s.stats.output += r.usage?.output ?? 0;
    if (controller.signal.aborted || r.stop === "error") return null;
    const rawSummary = r.text.trim();
    if (!rawSummary) return null;
    const summary = normalizeCompactionSummary(rawSummary);
    const workingSet = workingSetFromSummary(summary);
    const touched = recentTouched(20, s.meta.id).filter((file) => {
      const rel = relative(s.meta.cwd, file);
      return !!rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
    }).slice(0, 5);
    const restore = buildFileRestore(touched, (f) => {
      if (controller.signal.aborted) return null;
      try {
        return readModelContextFileSync(f, 32 * 1024);
      } catch {
        return null;
      }
    });
    if (controller.signal.aborted) return null;
    s.meta.workingSet = workingSet;
    const compacted = compactedConversationHistory(summary, recent, restore);
    s.history.length = 0;
    s.history.push(...compacted);
    s.stats.lastInput = compactedHistoryTokenEstimate(compacted);
    hub.save(s);
    return summary;
  };

  wss.on("connection", (ws: WebSocket) => {
    if (closing) {
      ws.close(1012, "server shutting down");
      return;
    }
    ws.on("message", (raw) => {
      const task = (async (): Promise<void> => {
        if (closing) return;
        const parsed = parseFrame(String(raw));
        if ("error" in parsed) {
          if (ws.readyState === ws.OPEN) ws.send(rpcError(null, ERR.PARSE, parsed.error));
          return;
        }
        const { req } = parsed;
        const id = req.id ?? null;
        const reply = (frame: string): void => void (id !== null && ws.readyState === ws.OPEN && ws.send(frame));
        const p = (req.params ?? {}) as Record<string, any>;
        try {
        if (req.method === "initialize") {
          if (typeof p.token !== "string" || !sameToken(p.token, token)) {
            runtimeLog("auth.denied", { method: "initialize", code: ERR.UNAUTHORIZED, category: "authentication" });
            return reply(rpcError(id, ERR.UNAUTHORIZED, "bad token"));
          }
          authed.add(ws);
          runtimeLog("client.authenticated", { method: "initialize" });
          // capability negotiation (codex app-server pattern): the server ADVERTISES its method set so
          // clients feature-detect up front instead of probing for -32601 per call. `p.capabilities`
          // (client-declared) is accepted and currently unused — reserved for opt-outs/experimental gating.
          const methods = [
            "server.shutdown",
            "session.list", "session.create", "session.resume", "session.history", "session.submit", "session.send", "session.steer", "session.interrupt", "session.set-model", "session.set-approval",
            "session.rename", "session.archive", "session.compact", "session.rewind", "session.context", "session.delete", "session.fork",
            "approval.reply", "plugins.list", "plugins.set", "skills.list", "models.list", "agents.list", "agents.create", "agents.update-profile", "agents.archive", "files.search", "project.panels",
            "external.sources.list", "external.sessions.list", "external.sessions.create", "external.sessions.read", "external.sessions.resume", "external.sessions.fork",
            "external.sessions.submit", "external.sessions.steer", "external.sessions.interrupt", "external.sessions.remove",
            "external.sessions.terminal.snapshot", "external.sessions.terminal.input", "external.sessions.terminal.key",
            "external.sessions.terminal.attach", "external.sessions.terminal.raw-input", "external.sessions.terminal.resize",
            "external.sessions.terminal.scroll", "external.sessions.terminal.release", "external.sessions.terminal.open-wezterm",
            "settings.providers.list", "settings.providers.test", "settings.providers.save", "settings.vision.test", "settings.vision.save",
            "settings.providers.connections.create", "settings.providers.connections.test", "settings.providers.connections.use",
            "settings.providers.connections.remove", "settings.gateways.list",
            "settings.gateways.login.start", "settings.gateways.login.status", "settings.gateways.login.cancel",
            "settings.organizations.list", "settings.organizations.enroll", "settings.organizations.use",
            "settings.organizations.remove", "settings.organizations.check",
            "learning.list", "learning.review",
            "automation.list", "automation.validate", "automation.add", "automation.update",
            "automation.run", "automation.toggle", "automation.delete", "automation.scheduler.install",
            "artifact.import", "artifact.commit", "artifact.revert", "artifact.validate", "artifact.export",
            "artifact.list", "artifact.get", "artifact.revisions",
            "presentation.create", "presentation.import", "presentation.update", "presentation.get", "presentation.validate",
            "presentation.export", "presentation.render", "presentation.preview", "presentation.preview-file",
            "tasks.list", "approvals.list", "approvals.resolve",
          ];
          const collaborationRemote =
            !!deps.deskConnections
            && !!deps.deskSnapshot
            && !!deps.deskTask;
          if (collaborationRemote) {
            methods.push("desk.connections.list", "desk.snapshot", "desk.task.get");
          }
          if (deps.unpinProjectProfile) methods.push("settings.profiles.unpin");
          if (deps.spaces && deps.useSpace) methods.push("spaces.list", "spaces.use");
          if (deps.organizationLearningSubmit) methods.push("learning.submit");
          if (deps.organizationLearningSync) methods.push("learning.sync");
          const features = [
            "composer.attachments.v1",
            "models.capabilities.v1",
            "sessions.readonly-history.v1",
            "sessions.cross-profile-fork.v1",
            "sessions.space-route.v1",
            "learning.review.v1",
            "agent.action-ownership.v1",
            "agent.public-profile-edit.v1",
            "agent.blueprint-provenance.v1",
            "external.sessions.metadata.v1",
            "external.sessions.interaction.v1",
            "external.sessions.live-control.v1",
            "external.sessions.runtime.v1",
            "external.sessions.native-resume.v1",
            "external.sessions.launch-options.v1",
            "external.sessions.terminal-mirror.v1",
            "external.sessions.terminal-stream.v2",
            "external.sessions.runtime-remove.v1",
          ];
          if (deps.spaces && deps.useSpace) features.push("spaces.tenant-boundary.v1");
          if (collaborationRemote) features.push("collaboration.remote.v1");
          if (deps.organizationLearningSubmit && deps.organizationLearningSync) {
            features.push("learning.organization-review.v1");
          }
          const runtime = runtimeInfo();
          const setupState = deps.providerSettings
            ? (deps.providerSettings(opts.cwd).current.authenticated ? "ready" : "needs-credentials")
            : "ready";
          return reply(rpcResult(id!, {
            name: "hara",
            version: deps.version,
            protocol: PROTOCOL_VERSION,
            cwd: opts.cwd,
            provider: runtime.providerId,
            model: runtime.model,
            setupState,
            capabilities: {
              methods,
              events: [
                "event.task_state", "event.workforce_state", "event.surface",
                "external.event.turn_start", "external.event.text", "external.event.tool",
                "external.event.notice", "external.event.turn_end", "external.approval.request",
                "external.event.terminal.frame", "external.event.terminal.closed",
              ],
              features,
            },
          }));
        }
        if (!authed.has(ws)) return reply(rpcError(id, ERR.UNAUTHORIZED, "initialize first"));

        switch (req.method) {
          case "server.shutdown": {
            // The updater's stop request must never abort another client's turn or dismiss its approval.
            // The current shutdown request is not inserted into inFlightRequests until this synchronous
            // branch returns, so any entry observed here belongs to another request. Once accepted, close
            // admission atomically before replying/scheduling close: no new work can race into the gap.
            if (hasActiveClientWork()) {
              return reply(rpcError(id, ERR.BUSY, "server has active work — retry shutdown after all sessions and approvals are idle"));
            }
            closing = true;
            reply(rpcResult(id!, { accepted: true }));
            const shutdown = setTimeout(() => void close(), 0);
            shutdown.unref();
            return;
          }
          case "session.list": {
            if (
              p.cursor !== undefined
              && (typeof p.cursor !== "string" || !p.cursor)
            ) return reply(rpcError(id, ERR.PARAMS, "cursor must be a non-empty opaque cursor"));
            if (
              p.limit !== undefined
              && (!Number.isInteger(p.limit) || p.limit < 1 || p.limit > 100)
            ) return reply(rpcError(id, ERR.PARAMS, "limit must be an integer from 1 to 100"));
            await sessionIndexReady();
            const page = hub.listPage({
              sources: ["interactive"],
              ...(typeof p.cwd === "string" && p.cwd ? { cwd: p.cwd } : {}),
              ...(typeof p.cursor === "string" ? { cursor: p.cursor } : {}),
              ...(typeof p.limit === "number" ? { limit: p.limit } : {}),
              ...(p.archived === true ? { includeArchived: true } : {}),
            });
            return reply(rpcResult(id!, {
              sessions: page.sessions.map((m) => ({
                id: m.id,
                title: m.title,
                cwd: m.cwd,
                model: m.model,
                approval: m.approval,
                profileId: m.profileId,
                spaceId: m.spaceId,
                updatedAt: m.updatedAt,
                source: m.source ?? "interactive",
                sourceName: m.sourceName,
                jobId: m.jobId,
                archived: m.archived ?? false,
                agentRef: m.agentRef,
              })),
              page: {
                hasMore: page.hasMore,
                limit: page.limit,
                ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
              },
            }));
          }
          case "external.sources.list": {
            if (externalSessionSpaceId() !== "personal") {
              return reply(rpcError(id, ERR.UNAUTHORIZED, "local external sessions are available only in Personal Space"));
            }
            return reply(rpcResult(id!, await externalSessions.listSources()));
          }
          case "external.sessions.list": {
            if (externalSessionSpaceId() !== "personal") {
              return reply(rpcError(id, ERR.UNAUTHORIZED, "local external sessions are available only in Personal Space"));
            }
            if (p.sourceId !== undefined && p.sourceId !== "codex" && p.sourceId !== "claude" && p.sourceId !== "runtime") {
              return reply(rpcError(id, ERR.PARAMS, "sourceId must be codex, claude, or runtime"));
            }
            if (p.cursor !== undefined && (typeof p.cursor !== "string" || !p.cursor || p.cursor.length > 160)) {
              return reply(rpcError(id, ERR.PARAMS, "cursor must be a bounded non-empty opaque cursor"));
            }
            if (p.limit !== undefined && (!Number.isInteger(p.limit) || p.limit < 1 || p.limit > 100)) {
              return reply(rpcError(id, ERR.PARAMS, "limit must be an integer from 1 to 100"));
            }
            if (p.search !== undefined && (typeof p.search !== "string" || p.search.length > 200)) {
              return reply(rpcError(id, ERR.PARAMS, "search must be a string of at most 200 characters"));
            }
            return reply(rpcResult(id!, await externalSessions.listSessions({
              ...(p.sourceId ? { sourceId: p.sourceId as ExternalSessionSourceId } : {}),
              ...(p.cursor ? { cursor: p.cursor as string } : {}),
              ...(p.limit ? { limit: p.limit as number } : {}),
              ...(typeof p.search === "string" ? { search: p.search } : {}),
            })));
          }
          case "external.sessions.create": {
            if (externalSessionSpaceId() !== "personal") {
              return reply(rpcError(id, ERR.UNAUTHORIZED, "local external sessions are available only in Personal Space"));
            }
            if (p.sourceId !== "runtime") return reply(rpcError(id, ERR.PARAMS, "sourceId must be runtime"));
            if (typeof p.cwd !== "string" || !p.cwd || p.cwd.length > 4_096) {
              return reply(rpcError(id, ERR.PARAMS, "cwd must be a bounded non-empty local path"));
            }
            if (p.agentKind !== "codex" && p.agentKind !== "claude") {
              return reply(rpcError(id, ERR.PARAMS, "agentKind must be codex or claude"));
            }
            if (p.title !== undefined && (typeof p.title !== "string" || p.title.length > 120)) {
              return reply(rpcError(id, ERR.PARAMS, "title must be a string of at most 120 characters"));
            }
            if (p.launch !== undefined && (!p.launch || typeof p.launch !== "object" || Array.isArray(p.launch))) {
              return reply(rpcError(id, ERR.PARAMS, "launch must be an object"));
            }
            const launch = p.launch as Record<string, unknown> | undefined;
            if (launch) {
              const allowed = new Set(["model", "effort", "permissionMode", "sandboxMode", "serviceTier"]);
              if (Object.keys(launch).some((key) => !allowed.has(key))) {
                return reply(rpcError(id, ERR.PARAMS, "launch contains an unsupported option"));
              }
              if (launch.model !== undefined && (typeof launch.model !== "string" || launch.model.length > 160)) {
                return reply(rpcError(id, ERR.PARAMS, "launch.model must be a string of at most 160 characters"));
              }
              if (launch.effort !== undefined && !["minimal", "low", "medium", "high", "xhigh", "max"].includes(String(launch.effort))) {
                return reply(rpcError(id, ERR.PARAMS, "launch.effort is invalid"));
              }
              if (launch.permissionMode !== undefined && !["manual", "acceptEdits", "plan", "auto", "dontAsk"].includes(String(launch.permissionMode))) {
                return reply(rpcError(id, ERR.PARAMS, "launch.permissionMode is invalid"));
              }
              if (launch.sandboxMode !== undefined && !["read-only", "workspace-write"].includes(String(launch.sandboxMode))) {
                return reply(rpcError(id, ERR.PARAMS, "launch.sandboxMode is invalid"));
              }
              if (launch.serviceTier !== undefined && launch.serviceTier !== "fast") {
                return reply(rpcError(id, ERR.PARAMS, "launch.serviceTier is invalid"));
              }
            }
            return reply(rpcResult(id!, await externalSessions.createSession({
              sourceId: "runtime",
              cwd: p.cwd,
              agentKind: p.agentKind,
              ...(typeof p.title === "string" ? { title: p.title } : {}),
              ...(launch ? { launch: launch as ExternalRuntimeLaunchOptions } : {}),
            })));
          }
          case "external.sessions.read": {
            if (externalSessionSpaceId() !== "personal") {
              return reply(rpcError(id, ERR.UNAUTHORIZED, "local external sessions are available only in Personal Space"));
            }
            if (typeof p.sessionId !== "string") return reply(rpcError(id, ERR.PARAMS, "sessionId required"));
            return reply(rpcResult(id!, await externalSessions.readSession(p.sessionId)));
          }
          case "external.sessions.resume": {
            if (externalSessionSpaceId() !== "personal") {
              return reply(rpcError(id, ERR.UNAUTHORIZED, "local external sessions are available only in Personal Space"));
            }
            if (typeof p.sessionId !== "string") return reply(rpcError(id, ERR.PARAMS, "sessionId required"));
            return reply(rpcResult(id!, await externalSessions.resumeSession(p.sessionId)));
          }
          case "external.sessions.fork": {
            if (externalSessionSpaceId() !== "personal") {
              return reply(rpcError(id, ERR.UNAUTHORIZED, "local external sessions are available only in Personal Space"));
            }
            if (typeof p.sessionId !== "string") return reply(rpcError(id, ERR.PARAMS, "sessionId required"));
            return reply(rpcResult(id!, await externalSessions.forkSession(p.sessionId)));
          }
          case "external.sessions.submit": {
            if (externalSessionSpaceId() !== "personal") {
              return reply(rpcError(id, ERR.UNAUTHORIZED, "local external sessions are available only in Personal Space"));
            }
            if (typeof p.sessionId !== "string" || typeof p.text !== "string") {
              return reply(rpcError(id, ERR.PARAMS, "sessionId + text required"));
            }
            const externalSessionId = p.sessionId;
            const externalTurnId = `extturn_${randomUUID()}`;
            if (externalWireTurns.has(externalSessionId)) {
              return reply(rpcError(id, ERR.BUSY, "this external coding-agent session is already running"));
            }
            externalWireTurns.set(externalSessionId, externalTurnId);
            broadcast("external.event.turn_start", { sessionId: externalSessionId, turnId: externalTurnId });
            try {
              const result = await externalSessions.submit(externalSessionId, p.text, {
                text: (delta) => broadcast("external.event.text", { sessionId: externalSessionId, turnId: externalTurnId, delta }),
                tool: (name, preview) => broadcast("external.event.tool", {
                  sessionId: externalSessionId,
                  turnId: externalTurnId,
                  name,
                  preview,
                }),
                notice: (text) => broadcast("external.event.notice", { sessionId: externalSessionId, turnId: externalTurnId, text }),
                confirm: (request, signal) => confirmExternalSessionAction(
                  externalSessionId,
                  request.question,
                  signal,
                  request.allowAlways === true,
                ),
              });
              const wireResult = { ...result, turnId: externalTurnId };
              broadcast("external.event.turn_end", {
                sessionId: wireResult.sessionId,
                requestedSessionId: externalSessionId,
                turnId: wireResult.turnId,
                reply: wireResult.reply,
                status: wireResult.status,
                ...(wireResult.error ? { error: wireResult.error } : {}),
              });
              return reply(rpcResult(id!, wireResult));
            } catch (error) {
              const message = redactSensitiveText(String(error instanceof Error ? error.message : error)).text.slice(0, 2_000);
              runtimeLog("external.turn.failed", {
                sessionId: externalSessionId,
                category: serveRuntimeFailureCategory(error),
              });
              broadcast("external.event.turn_end", {
                sessionId: externalSessionId,
                requestedSessionId: externalSessionId,
                turnId: externalTurnId,
                reply: "",
                status: "failed",
                error: message,
              });
              throw error;
            } finally {
              if (externalWireTurns.get(externalSessionId) === externalTurnId) {
                externalWireTurns.delete(externalSessionId);
              }
            }
          }
          case "external.sessions.steer": {
            if (externalSessionSpaceId() !== "personal") {
              return reply(rpcError(id, ERR.UNAUTHORIZED, "local external sessions are available only in Personal Space"));
            }
            if (typeof p.sessionId !== "string" || typeof p.text !== "string") {
              return reply(rpcError(id, ERR.PARAMS, "sessionId + text required"));
            }
            const externalTurnId = externalWireTurns.get(p.sessionId);
            if (!externalTurnId) {
              return reply(rpcError(id, ERR.BUSY, "this external coding-agent session has no active turn"));
            }
            const result = await externalSessions.steer(p.sessionId, p.text);
            const wireResult = { ...result, turnId: externalTurnId };
            broadcast("external.event.notice", {
              sessionId: wireResult.sessionId,
              turnId: wireResult.turnId,
              text: "Follow-up delivered to the active coding-agent turn.",
            });
            return reply(rpcResult(id!, wireResult));
          }
          case "external.sessions.interrupt": {
            if (externalSessionSpaceId() !== "personal") {
              return reply(rpcError(id, ERR.UNAUTHORIZED, "local external sessions are available only in Personal Space"));
            }
            if (typeof p.sessionId !== "string") return reply(rpcError(id, ERR.PARAMS, "sessionId required"));
            await externalSessions.interrupt(p.sessionId);
            return reply(rpcResult(id!, {}));
          }
          case "external.sessions.remove": {
            if (externalSessionSpaceId() !== "personal") {
              return reply(rpcError(id, ERR.UNAUTHORIZED, "local external sessions are available only in Personal Space"));
            }
            if (typeof p.sessionId !== "string") return reply(rpcError(id, ERR.PARAMS, "sessionId required"));
            if (externalWireTurns.has(p.sessionId)) {
              return reply(rpcError(id, ERR.BUSY, "stop the active external coding-agent turn before removing it"));
            }
            await externalSessions.removeSession(p.sessionId);
            return reply(rpcResult(id!, {}));
          }
          case "external.sessions.terminal.snapshot": {
            if (externalSessionSpaceId() !== "personal") {
              return reply(rpcError(id, ERR.UNAUTHORIZED, "local external sessions are available only in Personal Space"));
            }
            if (typeof p.sessionId !== "string") return reply(rpcError(id, ERR.PARAMS, "sessionId required"));
            return reply(rpcResult(id!, await externalSessions.terminalSnapshot(p.sessionId)));
          }
          case "external.sessions.terminal.input": {
            if (externalSessionSpaceId() !== "personal") {
              return reply(rpcError(id, ERR.UNAUTHORIZED, "local external sessions are available only in Personal Space"));
            }
            if (typeof p.sessionId !== "string" || typeof p.text !== "string") {
              return reply(rpcError(id, ERR.PARAMS, "sessionId + text required"));
            }
            await externalSessions.terminalInput(p.sessionId, p.text);
            return reply(rpcResult(id!, {}));
          }
          case "external.sessions.terminal.key": {
            if (externalSessionSpaceId() !== "personal") {
              return reply(rpcError(id, ERR.UNAUTHORIZED, "local external sessions are available only in Personal Space"));
            }
            if (typeof p.sessionId !== "string" || ![
              "enter", "esc", "up", "down", "left", "right", "tab", "shift+tab", "ctrl+c", "ctrl+d", "ctrl+l",
            ].includes(String(p.key))) {
              return reply(rpcError(id, ERR.PARAMS, "sessionId + allowed terminal key required"));
            }
            await externalSessions.terminalKey(p.sessionId, p.key);
            return reply(rpcResult(id!, {}));
          }
          case "external.sessions.terminal.attach": {
            if (externalSessionSpaceId() !== "personal") {
              return reply(rpcError(id, ERR.UNAUTHORIZED, "local external sessions are available only in Personal Space"));
            }
            if (
              typeof p.sessionId !== "string"
              || (p.mode !== "observe" && p.mode !== "control")
              || !Number.isInteger(p.cols) || p.cols < 2 || p.cols > 1_000
              || !Number.isInteger(p.rows) || p.rows < 2 || p.rows > 1_000
              || (p.takeover !== undefined && typeof p.takeover !== "boolean")
            ) {
              return reply(rpcError(id, ERR.PARAMS, "sessionId, terminal mode, cols, and rows are required"));
            }
            if (p.takeover && p.mode !== "control") {
              return reply(rpcError(id, ERR.PARAMS, "terminal takeover requires control mode"));
            }
            const socketStreams = externalTerminalStreams.get(ws);
            const priorForSession = [...(socketStreams?.values() ?? [])]
              .find((candidate) => candidate.sessionId === p.sessionId);
            if (priorForSession) await releaseExternalTerminal(ws, priorForSession.streamId, "released", false);
            if (p.mode === "control") {
              const priorController = externalTerminalControllers.get(p.sessionId);
              if (priorController && !p.takeover) {
                return reply(rpcError(id, ERR.BUSY, "this terminal is controlled by another client; confirm takeover or observe it read-only"));
              }
              if (priorController) {
                await releaseExternalTerminal(priorController.ws, priorController.streamId, "control_transferred");
              }
            }
            const streamId = `terminal_${randomUUID()}`;
            let ready = false;
            let closedBeforeReady: string | null = null;
            const pendingFrames: Array<Record<string, unknown>> = [];
            let pendingBytes = 0;
            const publishFrame = (frame: Record<string, unknown>): void => {
              const current = externalTerminalStreams.get(ws)?.get(streamId);
              if (!current) return;
              if (!notifySocket(ws, "external.event.terminal.frame", {
                sessionId: p.sessionId,
                streamId,
                ...frame,
              })) {
                void releaseExternalTerminal(ws, streamId, "slow_client");
              }
            };
            const stream = await externalSessions.openTerminalStream(p.sessionId, {
              mode: p.mode,
              cols: p.cols,
              rows: p.rows,
              ...(p.takeover ? { takeover: true } : {}),
            }, {
              frame: (frame) => {
                if (ready) publishFrame(frame as unknown as Record<string, unknown>);
                else {
                  pendingBytes += frame.bytes.length;
                  if (pendingFrames.length >= 32 || pendingBytes > 4 * 1024 * 1024) {
                    closedBeforeReady = "slow_client";
                    return;
                  }
                  pendingFrames.push(frame as unknown as Record<string, unknown>);
                }
              },
              closed: (reason) => {
                if (!ready) {
                  closedBeforeReady = reason;
                  return;
                }
                const current = externalTerminalStreams.get(ws)?.get(streamId);
                if (!current) return;
                externalTerminalStreams.get(ws)?.delete(streamId);
                if (externalTerminalStreams.get(ws)?.size === 0) externalTerminalStreams.delete(ws);
                const controller = externalTerminalControllers.get(p.sessionId);
                if (controller?.ws === ws && controller.streamId === streamId) {
                  externalTerminalControllers.delete(p.sessionId);
                }
                notifySocket(ws, "external.event.terminal.closed", { sessionId: p.sessionId, streamId, reason });
              },
            });
            if (closedBeforeReady) {
              await stream.release().catch(() => {});
              throw new Error("Hara Live terminal stream closed while attaching");
            }
            const owned: OwnedExternalTerminalStream = { streamId, sessionId: p.sessionId, mode: p.mode, stream };
            const ownedBySocket = externalTerminalStreams.get(ws) ?? new Map<string, OwnedExternalTerminalStream>();
            ownedBySocket.set(streamId, owned);
            externalTerminalStreams.set(ws, ownedBySocket);
            if (p.mode === "control") externalTerminalControllers.set(p.sessionId, { ws, streamId });
            reply(rpcResult(id!, { sessionId: p.sessionId, streamId, mode: p.mode, cols: p.cols, rows: p.rows }));
            ready = true;
            for (const frame of pendingFrames) publishFrame(frame);
            return;
          }
          case "external.sessions.terminal.raw-input": {
            if (externalSessionSpaceId() !== "personal") {
              return reply(rpcError(id, ERR.UNAUTHORIZED, "local external sessions are available only in Personal Space"));
            }
            if (typeof p.streamId !== "string" || typeof p.text !== "string" || Buffer.byteLength(p.text, "utf8") > 64 * 1024) {
              return reply(rpcError(id, ERR.PARAMS, "streamId and terminal text up to 64 KiB are required"));
            }
            const owned = externalTerminalStreams.get(ws)?.get(p.streamId);
            if (!owned || owned.mode !== "control") return reply(rpcError(id, ERR.UNAUTHORIZED, "this client does not control that terminal stream"));
            owned.stream.input(p.text);
            return reply(rpcResult(id!, {}));
          }
          case "external.sessions.terminal.resize": {
            if (externalSessionSpaceId() !== "personal") {
              return reply(rpcError(id, ERR.UNAUTHORIZED, "local external sessions are available only in Personal Space"));
            }
            if (
              typeof p.streamId !== "string"
              || !Number.isInteger(p.cols) || p.cols < 2 || p.cols > 1_000
              || !Number.isInteger(p.rows) || p.rows < 2 || p.rows > 1_000
            ) return reply(rpcError(id, ERR.PARAMS, "streamId, cols, and rows are required"));
            const owned = externalTerminalStreams.get(ws)?.get(p.streamId);
            if (!owned || owned.mode !== "control") return reply(rpcError(id, ERR.UNAUTHORIZED, "this client does not control that terminal stream"));
            owned.stream.resize(p.cols, p.rows);
            return reply(rpcResult(id!, {}));
          }
          case "external.sessions.terminal.scroll": {
            if (externalSessionSpaceId() !== "personal") {
              return reply(rpcError(id, ERR.UNAUTHORIZED, "local external sessions are available only in Personal Space"));
            }
            if (
              typeof p.streamId !== "string"
              || (p.direction !== "up" && p.direction !== "down")
              || !Number.isInteger(p.lines) || p.lines < 1 || p.lines > 1_000
            ) return reply(rpcError(id, ERR.PARAMS, "streamId, scroll direction, and lines are required"));
            const owned = externalTerminalStreams.get(ws)?.get(p.streamId);
            if (!owned || owned.mode !== "control") return reply(rpcError(id, ERR.UNAUTHORIZED, "this client does not control that terminal stream"));
            owned.stream.scroll(p.direction, p.lines);
            return reply(rpcResult(id!, {}));
          }
          case "external.sessions.terminal.release": {
            if (externalSessionSpaceId() !== "personal") {
              return reply(rpcError(id, ERR.UNAUTHORIZED, "local external sessions are available only in Personal Space"));
            }
            if (typeof p.streamId !== "string") return reply(rpcError(id, ERR.PARAMS, "streamId required"));
            if (!externalTerminalStreams.get(ws)?.has(p.streamId)) {
              return reply(rpcError(id, ERR.UNAUTHORIZED, "this client does not own that terminal stream"));
            }
            await releaseExternalTerminal(ws, p.streamId, "released", false);
            return reply(rpcResult(id!, {}));
          }
          case "external.sessions.terminal.open-wezterm": {
            if (externalSessionSpaceId() !== "personal") {
              return reply(rpcError(id, ERR.UNAUTHORIZED, "local external sessions are available only in Personal Space"));
            }
            if (
              typeof p.sessionId !== "string"
              || (p.takeover !== undefined && typeof p.takeover !== "boolean")
            ) return reply(rpcError(id, ERR.PARAMS, "sessionId and optional takeover flag required"));
            const priorController = externalTerminalControllers.get(p.sessionId);
            if (priorController && !p.takeover) {
              return reply(rpcError(id, ERR.BUSY, "another client controls this terminal; confirm takeover before opening WezTerm"));
            }
            const result = await externalSessions.openNativeTerminal(p.sessionId, {
              terminal: "wezterm",
              ...(p.takeover ? { takeover: true } : {}),
            });
            // Do not strand the user if WezTerm is missing or cannot start. A successful `--takeover`
            // launch claims the same Herdr terminal first; only then retire Hara's controller lease.
            if (priorController) {
              await releaseExternalTerminal(priorController.ws, priorController.streamId, "control_transferred");
            }
            return reply(rpcResult(id!, result));
          }
          case "spaces.list": {
            if (!deps.spaces) return reply(rpcError(id, ERR.METHOD, "Spaces are not supported by this server"));
            const targetCwd = typeof p.cwd === "string" && p.cwd ? p.cwd : opts.cwd;
            return reply(rpcResult(id!, deps.spaces(targetCwd)));
          }
          case "spaces.use": {
            if (!deps.useSpace) return reply(rpcError(id, ERR.METHOD, "Space switching is not supported by this server"));
            if (typeof p.spaceId !== "string" || !p.spaceId.trim() || p.spaceId.length > 160) {
              return reply(rpcError(id, ERR.PARAMS, "spaceId must be a non-empty bounded string"));
            }
            const targetCwd = typeof p.cwd === "string" && p.cwd ? p.cwd : opts.cwd;
            return reply(rpcResult(id!, deps.useSpace(p.spaceId.trim(), targetCwd)));
          }
          case "agents.list": {
            if (p.sessionId !== undefined && (typeof p.sessionId !== "string" || !p.sessionId)) {
              return reply(rpcError(id, ERR.PARAMS, "sessionId must be a non-empty string"));
            }
            const sessionMeta = typeof p.sessionId === "string" ? hub.peekMeta(p.sessionId) : undefined;
            if (typeof p.sessionId === "string" && !sessionMeta) {
              return reply(rpcError(id, ERR.NO_SESSION, `no session ${p.sessionId}`));
            }
            const cwd = sessionMeta?.cwd ?? (typeof p.cwd === "string" && p.cwd ? p.cwd : opts.cwd);
            const runtime = runtimeInfo(cwd, undefined, sessionMeta?.profileId, sessionMeta?.spaceId);
            let profileId = sessionMeta?.profileId ?? runtime.profileId ?? "personal";
            let spaceId = runtime.spaceId ?? failClosedSpaceId(profileId);
            let agentProfileId = runtime.organizationProfileId ?? profileId;
            if (sessionMeta) {
              try {
                const binding = sessionSpaceBinding(sessionMeta);
                profileId = binding.profileId;
                spaceId = binding.spaceId;
                agentProfileId = binding.runtime.organizationProfileId ?? profileId;
              } catch (error) {
                return reply(rpcError(id, ERR.UNAUTHORIZED, error instanceof Error ? error.message : String(error)));
              }
            }
            return reply(rpcResult(id!, serveAgentCatalog(cwd, agentProfileId, spaceId)));
          }
          case "agents.update-profile": {
            if (typeof p.ref !== "string" || !p.ref.trim() || typeof p.expectedRevision !== "string" || !/^[a-f0-9]{32}$/.test(p.expectedRevision)) {
              return reply(rpcError(id, ERR.PARAMS, "ref and a valid expectedRevision are required"));
            }
            if (!p.profile || typeof p.profile !== "object" || Array.isArray(p.profile)) {
              return reply(rpcError(id, ERR.PARAMS, "profile must be an object"));
            }
            if (p.execution !== undefined && (!p.execution || typeof p.execution !== "object" || Array.isArray(p.execution))) {
              return reply(rpcError(id, ERR.PARAMS, "execution must be an object"));
            }
            const executionInput = p.execution as Record<string, unknown> | undefined;
            if (executionInput) {
              const unknownExecutionFields = Object.keys(executionInput).filter(
                (key) => key !== "model" && key !== "reasoningEffort",
              );
              if (
                unknownExecutionFields.length
                || (executionInput.model !== undefined && executionInput.model !== null && typeof executionInput.model !== "string")
                || (executionInput.reasoningEffort !== undefined && executionInput.reasoningEffort !== null && typeof executionInput.reasoningEffort !== "string")
              ) {
                return reply(rpcError(id, ERR.PARAMS, "execution supports only string model and reasoningEffort fields"));
              }
            }
            if (p.sessionId !== undefined && (typeof p.sessionId !== "string" || !p.sessionId)) {
              return reply(rpcError(id, ERR.PARAMS, "sessionId must be a non-empty string"));
            }
            const sessionMeta = typeof p.sessionId === "string" ? hub.peekMeta(p.sessionId) : undefined;
            if (typeof p.sessionId === "string" && !sessionMeta) {
              return reply(rpcError(id, ERR.NO_SESSION, `no session ${p.sessionId}`));
            }
            const cwd = sessionMeta?.cwd ?? (typeof p.cwd === "string" && p.cwd ? p.cwd : opts.cwd);
            const runtime = runtimeInfo(cwd, undefined, sessionMeta?.profileId, sessionMeta?.spaceId);
            let profileId = sessionMeta?.profileId ?? runtime.profileId ?? "personal";
            let spaceId = runtime.spaceId ?? failClosedSpaceId(profileId);
            if (sessionMeta) {
              try {
                const binding = sessionSpaceBinding(sessionMeta);
                profileId = binding.profileId;
                spaceId = binding.spaceId;
              } catch (error) {
                return reply(rpcError(id, ERR.UNAUTHORIZED, error instanceof Error ? error.message : String(error)));
              }
            }
            if (spaceId !== "personal") {
              return reply(rpcError(id, ERR.UNAUTHORIZED, "company Agent profiles are managed by organization administrators"));
            }
            const ref = p.ref.trim();
            const before = serveAgentCatalog(cwd, profileId, spaceId);
            const target = before.agents.find((agent) => agent.ref === ref);
            if (!target) return reply(rpcError(id, ERR.PARAMS, `no Agent '${ref}' is available in this Space`));
            if (!target.allowedActions.includes("edit_profile") || target.revision !== p.expectedRevision) {
              return reply(rpcError(id, ERR.CONFLICT, "Agent profile changed or is not editable; refresh and retry"));
            }
            try {
              if (ref === "main") {
                if (executionInput && Object.values(executionInput).some((value) => typeof value === "string" && value.trim())) {
                  return reply(rpcError(id, ERR.PARAMS, "the main Hara Agent follows the active Space defaults"));
                }
                await updateMainAgentIdentity(p.profile, p.expectedRevision);
              } else {
                const resolved = resolveServeAgent(ref, cwd, profileId);
                if (!resolved || "ambiguous" in resolved) {
                  return reply(rpcError(id, ERR.PARAMS, `Agent '${ref}' could not be resolved`));
                }
                if (executionInput) {
                  const nextModel = Object.prototype.hasOwnProperty.call(executionInput, "model")
                    ? typeof executionInput.model === "string" && executionInput.model.trim()
                      ? executionInput.model.trim()
                      : undefined
                    : resolved.role.model;
                  const nextEffort = Object.prototype.hasOwnProperty.call(executionInput, "reasoningEffort")
                    ? typeof executionInput.reasoningEffort === "string" && executionInput.reasoningEffort.trim()
                      ? executionInput.reasoningEffort.trim()
                      : undefined
                    : resolved.role.reasoningEffort;
                  const executionModel = nextModel ?? runtime.model;
                  const executionRuntime = runtimeInfo(cwd, executionModel, profileId, spaceId);
                  if (nextModel && executionRuntime.availableModels?.length && !executionRuntime.availableModels.includes(nextModel)) {
                    return reply(rpcError(id, ERR.PARAMS, `model '${nextModel}' is not authorized for the active connection`));
                  }
                  if (nextEffort && !executionRuntime.effortLevels.includes(nextEffort)) {
                    return reply(rpcError(
                      id,
                      ERR.PARAMS,
                      `thinking effort '${nextEffort}' is not supported by model '${executionModel}'`,
                    ));
                  }
                }
                await updateNativeRoleIdentity(
                  resolved.role,
                  p.profile,
                  p.expectedRevision,
                  executionInput as AgentExecutionPreferencesInput | undefined,
                );
              }
              const catalog = serveAgentCatalog(cwd, profileId, spaceId);
              return reply(rpcResult(id!, {
                agent: catalog.agents.find((agent) => agent.ref === ref),
                catalog,
              }));
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              const conflict = /changed|refresh|retry/i.test(message);
              return reply(rpcError(id, conflict ? ERR.CONFLICT : ERR.PARAMS, message));
            }
          }
          case "agents.create": {
            if (
              typeof p.id !== "string"
              || !p.profile
              || typeof p.profile !== "object"
              || Array.isArray(p.profile)
              || (p.description !== undefined && typeof p.description !== "string")
              || (p.instructions !== undefined && typeof p.instructions !== "string")
              || (p.blueprint !== undefined && (!p.blueprint || typeof p.blueprint !== "object" || Array.isArray(p.blueprint)))
            ) {
              return reply(rpcError(id, ERR.PARAMS, "id and profile are required; description and instructions must be strings; blueprint must be an object"));
            }
            const cwd = typeof p.cwd === "string" && p.cwd ? p.cwd : opts.cwd;
            const runtime = runtimeInfo(cwd);
            const profileId = runtime.profileId ?? "personal";
            const spaceId = runtime.spaceId ?? failClosedSpaceId(profileId);
            if (spaceId !== "personal") {
              return reply(rpcError(id, ERR.UNAUTHORIZED, "company Agents must be created by an organization administrator"));
            }
            const username = p.id.trim().toLowerCase();
            if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(username) || username === "main" || username === "readme") {
              return reply(rpcError(id, ERR.PARAMS, "Agent username must use 1-64 lowercase letters, numbers, dots, underscores, or dashes and cannot be reserved"));
            }
            const ref = `global:${username}`;
            const before = serveAgentCatalog(cwd, profileId, spaceId);
            if (before.agents.some((agent) => agent.name.toLowerCase() === username || agent.ref.toLowerCase() === ref)) {
              return reply(rpcError(id, ERR.CONFLICT, "Agent username is already in use"));
            }
            try {
              // Hiring a dismissed username restores that exact employee and its private prompt/history.
              // This is especially important for Claude/OpenClaw roles that Hara reads in place: a market
              // action must never overwrite another tool's source file merely to put it back on the roster.
              const dismissed = before.dismissedAgentRefs.includes(ref);
              const existing = dismissed
                ? resolveServeAgent(ref, cwd, profileId, { includeDismissed: true })
                : null;
              if (existing && !("ambiguous" in existing)) {
                restoreAgentRef(ref);
                const catalog = serveAgentCatalog(cwd, profileId, spaceId);
                return reply(rpcResult(id!, {
                  agent: catalog.agents.find((agent) => agent.ref === ref),
                  catalog,
                  restored: true,
                }));
              }
              await createNativeGlobalAgent({
                id: username,
                description: p.description,
                instructions: p.instructions,
                profile: p.profile,
                blueprint: p.blueprint,
              });
              // A stale roster tombstone may outlive an uninstalled source role. Explicit hiring owns the
              // new prompt creation, so make that new employee visible only after creation succeeds.
              if (dismissed) restoreAgentRef(ref);
              const catalog = serveAgentCatalog(cwd, profileId, spaceId);
              return reply(rpcResult(id!, {
                agent: catalog.agents.find((agent) => agent.ref === ref),
                catalog,
              }));
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              const conflict = /already|exist|changed/i.test(message);
              return reply(rpcError(id, conflict ? ERR.CONFLICT : ERR.PARAMS, message));
            }
          }
          case "agents.archive": {
            if (typeof p.ref !== "string" || !p.ref.trim() || typeof p.expectedRevision !== "string" || !/^[a-f0-9]{32}$/.test(p.expectedRevision)) {
              return reply(rpcError(id, ERR.PARAMS, "ref and a valid expectedRevision are required"));
            }
            if (p.sessionId !== undefined && (typeof p.sessionId !== "string" || !p.sessionId)) {
              return reply(rpcError(id, ERR.PARAMS, "sessionId must be a non-empty string"));
            }
            const sessionMeta = typeof p.sessionId === "string" ? hub.peekMeta(p.sessionId) : undefined;
            if (typeof p.sessionId === "string" && !sessionMeta) return reply(rpcError(id, ERR.NO_SESSION, `no session ${p.sessionId}`));
            const cwd = sessionMeta?.cwd ?? (typeof p.cwd === "string" && p.cwd ? p.cwd : opts.cwd);
            const runtime = runtimeInfo(cwd, undefined, sessionMeta?.profileId, sessionMeta?.spaceId);
            let profileId = sessionMeta?.profileId ?? runtime.profileId ?? "personal";
            let spaceId = runtime.spaceId ?? failClosedSpaceId(profileId);
            if (sessionMeta) {
              try {
                const binding = sessionSpaceBinding(sessionMeta);
                profileId = binding.profileId;
                spaceId = binding.spaceId;
              } catch (error) {
                return reply(rpcError(id, ERR.UNAUTHORIZED, error instanceof Error ? error.message : String(error)));
              }
            }
            if (spaceId !== "personal") {
              return reply(rpcError(id, ERR.UNAUTHORIZED, "company Agents must be managed by an organization administrator"));
            }
            const ref = p.ref.trim();
            if (ref === "main") return reply(rpcError(id, ERR.PARAMS, "the main Hara Agent cannot be dismissed"));
            const before = serveAgentCatalog(cwd, profileId, spaceId);
            const target = before.agents.find((agent) => agent.ref === ref);
            if (!target?.allowedActions.includes("archive") || target.revision !== p.expectedRevision) {
              return reply(rpcError(id, ERR.CONFLICT, "Agent changed or is not dismissible; refresh and retry"));
            }
            const resolved = resolveServeAgent(ref, cwd, profileId);
            if (!resolved || "ambiguous" in resolved) return reply(rpcError(id, ERR.PARAMS, `Agent '${ref}' could not be resolved`));
            if (hub.hasActiveWorkForAgent(ref)) {
              return reply(rpcError(id, ERR.BUSY, "finish or stop every active task for this Agent before dismissing it"));
            }
            try {
              if (agentRoleRevision(resolved.role) !== p.expectedRevision) {
                return reply(rpcError(id, ERR.CONFLICT, "Agent changed before dismissal; refresh and retry"));
              }
              dismissAgentRef(ref);
              const catalog = serveAgentCatalog(cwd, profileId, spaceId);
              return reply(rpcResult(id!, { ref, archived: true, catalog }));
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              return reply(rpcError(id, /changed|retry/i.test(message) ? ERR.CONFLICT : ERR.PARAMS, message));
            }
          }
          case "session.create": {
            let cwd = typeof p.cwd === "string" && p.cwd ? p.cwd : opts.cwd;
            const explicitRouteRequested = p.profileId !== undefined || p.spaceId !== undefined;
            if (explicitRouteRequested && (
              typeof p.profileId !== "string"
              || !SERVE_PROFILE_ID_PATTERN.test(p.profileId)
              || typeof p.spaceId !== "string"
              || !SERVE_SPACE_ID_PATTERN.test(p.spaceId)
            )) {
              return reply(rpcError(id, ERR.PARAMS, "profileId and spaceId are required for an explicit model route"));
            }
            if (p.agentRef !== undefined && (typeof p.agentRef !== "string" || !p.agentRef.trim())) {
              return reply(rpcError(id, ERR.PARAMS, "agentRef must be a non-empty qualified agent reference"));
            }
            const requestedAgentRef = typeof p.agentRef === "string" && p.agentRef.trim() !== "main"
              ? p.agentRef.trim()
              : undefined;
            if (requestedAgentRef) cwd = projectHomeHint(requestedAgentRef, cwd);
            const activeRuntime = runtimeInfo(cwd);
            const activeProfileId = activeRuntime.profileId ?? "personal";
            const activeSpaceId = activeRuntime.spaceId ?? failClosedSpaceId(activeProfileId);
            const profileId = explicitRouteRequested ? p.profileId as string : activeProfileId;
            const spaceId = explicitRouteRequested ? p.spaceId as string : activeSpaceId;
            if (explicitRouteRequested && spaceId !== activeSpaceId) {
              return reply(rpcError(
                id,
                ERR.UNAUTHORIZED,
                "an explicit model route must stay inside the currently selected Space",
              ));
            }
            const routeRuntime = runtimeInfo(cwd, undefined, profileId, spaceId);
            if (routeRuntime.profileId && routeRuntime.profileId !== profileId) {
              return reply(rpcError(id, ERR.UNAUTHORIZED, "the selected model connection could not be resolved"));
            }
            if ((routeRuntime.spaceId ?? failClosedSpaceId(profileId)) !== spaceId) {
              return reply(rpcError(id, ERR.UNAUTHORIZED, "the selected model connection is not authorized in this Space"));
            }
            const agentProfileId = routeRuntime.organizationProfileId ?? profileId;
            // Building the session provider performs the required Control bundle sync for a company
            // connection. Resolve the requested Agent only afterwards so its persona/model/tool policy
            // comes from the same current bundle that authorizes this new conversation.
            let provider = await deps.buildSessionProvider(cwd, profileId, spaceId);
            if (closing) return;
            if (!provider) return reply(rpcError(id, ERR.INTERNAL, "provider not authenticated — check the active profile and ~/.hara/config.json"));
            let resolvedAgent: ResolvedServeAgent | undefined;
            if (requestedAgentRef) {
              const resolved = resolveServeAgent(requestedAgentRef, cwd, agentProfileId);
              if (!resolved) return reply(rpcError(id, ERR.PARAMS, `no agent '${requestedAgentRef}' is available for this connection`));
              if ("ambiguous" in resolved) {
                return reply(rpcError(id, ERR.PARAMS, `agent '${requestedAgentRef}' is ambiguous; choose one of: ${resolved.ambiguous.join(", ")}`));
              }
              resolvedAgent = resolved;
              const resolvedCwd = resolved.cwd;
              if (canonicalProjectPath(resolvedCwd) !== canonicalProjectPath(cwd)) {
                cwd = resolvedCwd;
                provider = await deps.buildSessionProvider(cwd, profileId, spaceId);
                if (closing) return;
                if (!provider) return reply(rpcError(id, ERR.INTERNAL, "provider not authenticated for the Agent workspace"));
                const refreshed = resolveServeAgent(requestedAgentRef, cwd, agentProfileId);
                if (!refreshed || "ambiguous" in refreshed || refreshed.ref !== resolved.ref) {
                  return reply(rpcError(id, ERR.CONFLICT, `agent '${requestedAgentRef}' changed while its company policy was being synchronized`));
                }
                resolvedAgent = refreshed;
              } else {
                cwd = resolvedCwd;
              }
            }
            const roleModel = resolvedAgent ? effectiveRoleModel(resolvedAgent.role.model, provider.model) : undefined;
            const selectedModel = roleModel ?? provider.model;
            const selectedRuntime = runtimeInfo(cwd, selectedModel, profileId, spaceId);
            const roleReasoningEffort = resolvedAgent?.role.reasoningEffort;
            if (
              roleReasoningEffort
              && !selectedRuntime.effortLevels.includes(roleReasoningEffort)
            ) {
              return reply(rpcError(
                id,
                ERR.PARAMS,
                `agent '${resolvedAgent!.ref}' requires unsupported reasoning effort '${roleReasoningEffort}' for model '${selectedModel}'`,
              ));
            }
            // Freeze the inherited connection default into this new conversation. `null` records an
            // intentional provider/model automatic setting; later edits to Space defaults affect only new
            // work, never this session when it resumes.
            const sessionEffort = roleReasoningEffort
              ?? selectedRuntime.defaultReasoningEffort
              ?? null;
            if (roleModel || roleReasoningEffort) {
              const roleProvider = deps.buildProviderFor
                ? await deps.buildProviderFor(selectedModel, sessionEffort, cwd, profileId, spaceId)
                : null;
              if (closing) return;
              if (!roleProvider) {
                return reply(rpcError(id, ERR.INTERNAL, `agent '${resolvedAgent!.ref}' requires unavailable model '${selectedModel}'`));
              }
              provider = roleProvider;
            }
            if (p.approval !== undefined && !isApprovalMode(p.approval)) {
              return reply(rpcError(id, ERR.PARAMS, "approval must be suggest, auto-edit, or full-auto"));
            }
            const approval = isApprovalMode(p.approval) ? p.approval : deps.approval;
            const s = hub.create({
              cwd,
              profileId,
              spaceId,
              provider,
              providerId: provider.id,
              model: provider.model,
              effort: sessionEffort,
              approval,
              projectContext: loadAgentContext(cwd) || undefined,
              ...(resolvedAgent ? { agentRef: resolvedAgent.ref } : {}),
            });
            return reply(rpcResult(id!, {
              sessionId: s.meta.id,
              title: s.meta.title,
              cwd: s.meta.cwd,
              model: s.meta.model,
              profileId: s.meta.profileId,
              spaceId: s.meta.spaceId,
              approval: s.approval,
              updatedAt: s.meta.updatedAt,
              source: s.meta.source ?? "interactive",
              agentRef: s.meta.agentRef,
            }));
          }
          case "session.resume": {
            if (typeof p.sessionId !== "string") return reply(rpcError(id, ERR.PARAMS, "sessionId required"));
            if (p.approval !== undefined && !isApprovalMode(p.approval)) {
              return reply(rpcError(id, ERR.PARAMS, "approval must be suggest, auto-edit, or full-auto"));
            }
            const live = hub.get(p.sessionId);
            if (live?.busy || live?.configuring) return reply(rpcError(id, ERR.BUSY, "session is running or changing configuration — retry resume shortly"));
            const priorMeta = hub.peekMeta(p.sessionId);
            const defaultRoute = priorMeta?.profileId ? undefined : runtimeInfo(priorMeta?.cwd);
            let boundProfileId = priorMeta?.profileId ?? defaultRoute?.profileId ?? "personal";
            let boundSpaceId = defaultRoute?.spaceId ?? failClosedSpaceId(boundProfileId);
            if (priorMeta) {
              try {
                const binding = sessionSpaceBinding(priorMeta);
                boundProfileId = binding.profileId;
                boundSpaceId = binding.spaceId;
              } catch (error) {
                return reply(rpcError(id, ERR.UNAUTHORIZED, error instanceof Error ? error.message : String(error)));
              }
            }
            const resumeModel = priorMeta?.model || runtimeInfo(priorMeta?.cwd, undefined, boundProfileId, boundSpaceId).model;
            const provider = priorMeta && deps.buildProviderFor
              ? await deps.buildProviderFor(resumeModel, priorMeta.effort, priorMeta.cwd, boundProfileId, boundSpaceId)
              : await deps.buildSessionProvider(priorMeta?.cwd, boundProfileId, boundSpaceId);
            if (closing) return;
            if (!provider) return reply(rpcError(id, ERR.INTERNAL, "provider not authenticated — check the active profile and ~/.hara/config.json"));
            const migratedApproval = priorMeta?.approval === undefined;
            const r = hub.resume(p.sessionId, {
              provider,
              approval: deps.approval,
              ...(isApprovalMode(p.approval) ? { legacyApproval: p.approval } : {}),
              projectContext: undefined,
            });
            if ("missing" in r) return reply(rpcError(id, ERR.NO_SESSION, `no session ${p.sessionId}`));
            if ("lockedBy" in r) return reply(rpcError(id, ERR.LOCKED, `session held by live pid ${r.lockedBy}`));
            if ("busy" in r) return reply(rpcError(id, ERR.BUSY, "session is running or changing configuration — retry resume shortly"));
            if (r.session.meta.profileId && r.session.meta.profileId !== boundProfileId) {
              hub.detach(r.session.meta.id);
              return reply(rpcError(id, ERR.BUSY, "session identity changed while resume was starting — retry resume"));
            }
            if (r.session.meta.spaceId && r.session.meta.spaceId !== boundSpaceId) {
              hub.detach(r.session.meta.id);
              return reply(rpcError(id, ERR.BUSY, "session Space changed while resume was starting — retry resume"));
            }
            const migratedProfileBinding = !r.session.meta.profileId;
            const migratedSpaceBinding = !r.session.meta.spaceId;
            const migratedRuntimeDefaults = !r.session.meta.model;
            r.session.meta.profileId = boundProfileId;
            r.session.meta.spaceId = boundSpaceId;
            if (migratedRuntimeDefaults) {
              r.session.meta.model = provider.model;
              r.session.meta.provider = provider.id;
            }
            r.session.configuring = true;
            let refreshed = false;
            try {
              refreshed = await refreshSessionProvider(r.session);
            } catch (error) {
              hub.detach(r.session.meta.id);
              return reply(rpcError(id, ERR.UNAUTHORIZED, error instanceof Error ? error.message : String(error)));
            } finally {
              r.session.configuring = false;
            }
            if (!refreshed) {
              hub.detach(r.session.meta.id);
              return reply(rpcError(id, ERR.INTERNAL, `provider not authenticated for pinned model '${r.session.meta.model}'`));
            }
            if (migratedProfileBinding || migratedSpaceBinding || migratedRuntimeDefaults || migratedApproval) hub.save(r.session);
            r.session.projectContext = loadAgentContext(r.session.meta.cwd) || undefined;
            broadcastTaskState(r.session, { phase: "restored" });
            return reply(rpcResult(id!, {
              sessionId: r.session.meta.id,
              model: r.session.meta.model,
              profileId: r.session.meta.profileId,
              spaceId: r.session.meta.spaceId,
              approval: r.session.approval,
              agentRef: r.session.meta.agentRef,
              history: historyForClient(r.session.history),
              task: r.session.task ? {
                id: r.session.task.id,
                objective: r.session.task.objective,
                status: r.session.task.status,
                turnId: r.session.task.turnId,
                updatedAt: r.session.task.updatedAt,
              } : undefined,
            }));
          }
          case "session.history": {
            // Provider-independent local replay. A revoked organization/model must stop future inference,
            // not prevent the owner from reading history already stored on this machine.
            if (typeof p.sessionId !== "string") return reply(rpcError(id, ERR.PARAMS, "sessionId required"));
            const snapshot = hub.read(p.sessionId);
            if (!snapshot) return reply(rpcError(id, ERR.NO_SESSION, `no session ${p.sessionId}`));
            return reply(rpcResult(id!, {
              sessionId: snapshot.meta.id,
              title: snapshot.meta.title,
              cwd: snapshot.meta.cwd,
              model: snapshot.meta.model,
              profileId: snapshot.meta.profileId,
              spaceId: snapshot.meta.spaceId,
              approval: snapshot.meta.approval,
              agentRef: snapshot.meta.agentRef,
              history: historyForClient(snapshot.history),
              readOnly: true,
            }));
          }
          case "session.submit": {
            if (typeof p.sessionId !== "string" || typeof p.text !== "string") {
              return reply(rpcError(id, ERR.PARAMS, "sessionId + text required"));
            }
            const s = hub.get(p.sessionId);
            if (!s) return reply(rpcError(id, ERR.NO_SESSION, `no live session ${p.sessionId} — session.create/resume first`));
            if (p.images !== undefined && !Array.isArray(p.images)) {
              return reply(rpcError(id, ERR.PARAMS, "images must be an array"));
            }
            if (p.attachments !== undefined && !Array.isArray(p.attachments)) {
              return reply(rpcError(id, ERR.PARAMS, "attachments must be an array"));
            }
            const mode = p.mode ?? "start_or_steer";
            if (mode !== "start_or_steer" && mode !== "start_if_idle" && mode !== "steer") {
              return reply(rpcError(id, ERR.PARAMS, "mode must be start_or_steer, start_if_idle, or steer"));
            }
            if (mode === "steer" && typeof p.expectedTurnId !== "string") {
              return reply(rpcError(id, ERR.PARAMS, "expectedTurnId required for steer mode"));
            }
            if (p.expectedModel !== undefined && (typeof p.expectedModel !== "string" || !p.expectedModel)) {
              return reply(rpcError(id, ERR.PARAMS, "expectedModel must be a non-empty string"));
            }
            if (p.expectedEffort !== undefined && typeof p.expectedEffort !== "string") {
              return reply(rpcError(id, ERR.PARAMS, "expectedEffort must be a string"));
            }
            if (p.expectedEffort !== undefined && p.expectedModel === undefined) {
              return reply(rpcError(id, ERR.PARAMS, "expectedModel required with expectedEffort"));
            }
            try {
              const decision = await enqueueSessionSubmission(p.sessionId, () => submitSessionInput(s, {
                  text: p.text,
                  images: p.images,
                  attachments: p.attachments,
                  newTask: p.newTask === true,
                  mode,
                  expectedTurnId: p.expectedTurnId,
                  expectedModel: p.expectedModel,
                  expectedEffort: p.expectedEffort,
                }, true));
              const result = decision.submission === "starting"
                ? { submission: "started" as const, ...await decision.completion }
                : decision;
              return reply(rpcResult(id!, result));
            } catch (error) {
              if (error instanceof SessionSubmitParamsError) {
                return reply(rpcError(id, ERR.PARAMS, error.message));
              }
              throw error;
            }
          }
          case "session.send": {
            if (typeof p.sessionId !== "string" || typeof p.text !== "string") {
              return reply(rpcError(id, ERR.PARAMS, "sessionId + text required"));
            }
            const s = hub.get(p.sessionId);
            if (!s) return reply(rpcError(id, ERR.NO_SESSION, `no live session ${p.sessionId} — session.create/resume first`));
            if (p.images !== undefined && !Array.isArray(p.images)) {
              return reply(rpcError(id, ERR.PARAMS, "images must be an array"));
            }
            if (p.attachments !== undefined && !Array.isArray(p.attachments)) {
              return reply(rpcError(id, ERR.PARAMS, "attachments must be an array"));
            }
            try {
              const decision = await enqueueSessionSubmission(p.sessionId, () => submitSessionInput(s, {
                  text: p.text,
                  images: p.images,
                  attachments: p.attachments,
                  newTask: p.newTask === true,
                  mode: "start_if_idle",
                }, true));
              const result = decision.submission === "starting"
                ? { submission: "started" as const, ...await decision.completion }
                : decision;
              if (result.submission === "not_submitted") {
                if (result.reason === "empty_input") {
                  return reply(rpcError(id, ERR.PARAMS, "text or at least one attachment is required"));
                }
                return reply(rpcError(id, ERR.BUSY, "this session is busy or changing configuration"));
              }
              if (result.submission !== "started") {
                return reply(rpcError(id, ERR.INTERNAL, "legacy session.send unexpectedly steered"));
              }
              const { submission: _submission, ...legacy } = result;
              return reply(rpcResult(id!, legacy));
            } catch (error) {
              if (error instanceof SessionSubmitParamsError) {
                return reply(rpcError(id, ERR.PARAMS, error.message));
              }
              throw error;
            }
          }
          case "session.steer": {
            if (typeof p.sessionId !== "string" || typeof p.text !== "string" || !p.text || typeof p.expectedTurnId !== "string") {
              return reply(rpcError(id, ERR.PARAMS, "sessionId + text + expectedTurnId required"));
            }
            const s = hub.get(p.sessionId);
            if (!s) return reply(rpcError(id, ERR.NO_SESSION, "no such live session"));
            const result = await enqueueSessionSubmission(p.sessionId, () => submitSessionInput(s, {
                text: p.text,
                mode: "steer",
                expectedTurnId: p.expectedTurnId,
              }));
            if (result.submission !== "steered") {
              const detail = result.submission === "not_submitted"
                ? result.reason === "expected_turn_mismatch"
                  ? `stale steer for turn ${p.expectedTurnId}; active turn is ${result.activeTurnId ?? "none"}`
                  : result.detail ?? result.reason
                : "steer unexpectedly started a turn";
              return reply(rpcError(id, ERR.BUSY, detail));
            }
            return reply(rpcResult(id!, { accepted: true, taskId: result.taskId, turnId: result.turnId }));
          }
          case "session.interrupt": {
            const s = typeof p.sessionId === "string" ? hub.get(p.sessionId) : undefined;
            if (!s) return reply(rpcError(id, ERR.NO_SESSION, "no such live session"));
            if (s.abort && s.task?.status === "running") {
              broadcastTaskState(s, { state: "running", phase: "stopping", detail: "Stopping at a safe boundary" });
            }
            if (s.abort) {
              runtimeLog("turn.interrupted", { sessionId: s.meta.id, category: "cancelled" });
              s.abort.abort();
            }
            return reply(rpcResult(id!, {}));
          }
          case "approval.reply": {
            if (typeof p.approvalId !== "string") return reply(rpcError(id, ERR.PARAMS, "approvalId required"));
            const approval = pendingApprovals.get(p.approvalId);
            if (approval) {
              approval.finish(p.always === true && approval.allowAlways ? "always" : p.allow === true);
            }
            return reply(rpcResult(id!, {})); // idempotent — a late/duplicate reply is a no-op
          }
          case "plugins.list": {
            const on = new Set(enabledPlugins().map((pl) => pl.name));
            return reply(rpcResult(id!, { plugins: listInstalled().map((pl) => ({ name: pl.name, version: pl.version, description: pl.manifest.description ?? "", enabled: on.has(pl.name), skills: (pl.manifest.skills ?? []).length, agents: (pl.manifest.agents ?? []).length, mcpServers: Object.keys(pl.manifest.mcpServers ?? {}).length, panels: pl.manifest.panels ?? [] })) }));
          }
          case "plugins.set": {
            if (typeof p.name !== "string" || typeof p.enabled !== "boolean") return reply(rpcError(id, ERR.PARAMS, "name + enabled required"));
            if (!listInstalled().some((pl) => pl.name === p.name)) return reply(rpcError(id, ERR.PARAMS, `no installed plugin "${p.name}"`));
            setPluginEnabled(p.name, p.enabled);
            return reply(rpcResult(id!, { name: p.name, enabled: p.enabled })); // takes effect on the next session/turn (loaders re-read)
          }
          case "session.rename": {
            if (typeof p.sessionId !== "string" || typeof p.title !== "string") return reply(rpcError(id, ERR.PARAMS, "sessionId + title required"));
            const live = hub.get(p.sessionId);
            if (live?.busy || live?.configuring) return reply(rpcError(id, ERR.BUSY, "a turn/configuration change is running — rename after it finishes"));
            const safeTitle = sanitizeSessionTitle(p.title);
            if (!hub.rename(p.sessionId, safeTitle)) return reply(rpcError(id, ERR.NO_SESSION, `no session ${p.sessionId}`));
            return reply(rpcResult(id!, { sessionId: p.sessionId, title: safeTitle }));
          }
          case "session.archive": {
            if (typeof p.sessionId !== "string" || typeof p.archived !== "boolean") return reply(rpcError(id, ERR.PARAMS, "sessionId + archived required"));
            const live = hub.get(p.sessionId);
            if (live?.busy || live?.configuring) return reply(rpcError(id, ERR.BUSY, "a turn/configuration change is running — archive after it finishes"));
            if (!hub.setArchived(p.sessionId, p.archived)) return reply(rpcError(id, ERR.NO_SESSION, `no session ${p.sessionId}`));
            return reply(rpcResult(id!, { sessionId: p.sessionId, archived: p.archived }));
          }
          case "session.fork": {
            // duplicate the conversation into a new session (codex thread/fork) — rewind's
            // non-destructive sibling: explore a different direction without losing the original.
            // A target route is also the recovery path for an unavailable pinned connection, but only
            // after the client records explicit consent to copy the complete durable context.
            if (typeof p.sessionId !== "string") return reply(rpcError(id, ERR.PARAMS, "sessionId required"));
            const targetRequested =
              p.targetProfileId !== undefined
              || p.targetModel !== undefined
              || p.targetSpaceId !== undefined
              || p.transferHistory !== undefined;
            if (
              p.transferHistory !== undefined && typeof p.transferHistory !== "boolean"
            ) {
              return reply(rpcError(id, ERR.PARAMS, "transferHistory must be a boolean"));
            }
            if (targetRequested && (
              typeof p.targetProfileId !== "string"
              || !SERVE_PROFILE_ID_PATTERN.test(p.targetProfileId)
              || typeof p.targetModel !== "string"
              || !p.targetModel.trim()
              || p.targetModel.length > 256
              || (p.targetSpaceId !== undefined && (
                typeof p.targetSpaceId !== "string"
                || !SERVE_SPACE_ID_PATTERN.test(p.targetSpaceId)
              ))
            )) {
              return reply(rpcError(id, ERR.PARAMS, "targetProfileId and targetModel are required; targetSpaceId must name a valid Space when supplied"));
            }
            if (targetRequested && p.transferHistory !== true) {
              return reply(rpcError(id, ERR.PARAMS, "explicit history-transfer consent required"));
            }
            const source = hub.read(p.sessionId);
            if (!source) return reply(rpcError(id, ERR.NO_SESSION, `no session ${p.sessionId}`));
            // A same-route fork is inference and requires the route to remain authoritative. An explicit
            // recovery transfer is different: its source may intentionally be an unavailable/retired
            // connection. In that case the durable Space label is the source authority, and only a target
            // resolving to that exact Space may receive the history.
            let sourceProfileId: string;
            let sourceSpaceId: string;
            if (targetRequested) {
              if (!source.meta.profileId || !source.meta.spaceId) {
                return reply(rpcError(
                  id,
                  ERR.UNAUTHORIZED,
                  "legacy history without a verifiable Space binding cannot be transferred",
                ));
              }
              sourceProfileId = source.meta.profileId;
              sourceSpaceId = source.meta.spaceId;
            } else {
              try {
                const sourceBinding = sessionSpaceBinding(source.meta);
                sourceProfileId = sourceBinding.profileId;
                sourceSpaceId = sourceBinding.spaceId;
              } catch (error) {
                return reply(rpcError(id, ERR.UNAUTHORIZED, error instanceof Error ? error.message : String(error)));
              }
            }
            const sourceModel = source.meta.model
              || runtimeInfo(source.meta.cwd, undefined, sourceProfileId, sourceSpaceId).model;
            const targetProfileId = targetRequested ? p.targetProfileId as string : sourceProfileId;
            const targetModel = targetRequested ? (p.targetModel as string).trim() : sourceModel;
            const explicitTargetSpaceId = targetRequested && typeof p.targetSpaceId === "string"
              ? p.targetSpaceId
              : undefined;
            const targetRuntime = targetRequested
              ? runtimeInfo(source.meta.cwd, targetModel, targetProfileId, explicitTargetSpaceId)
              : undefined;
            const targetSpaceId = targetRequested
              ? explicitTargetSpaceId ?? targetRuntime?.spaceId ?? failClosedSpaceId(targetProfileId)
              : sourceSpaceId;
            if (targetRequested && targetSpaceId !== sourceSpaceId) {
              return reply(rpcError(
                id,
                ERR.UNAUTHORIZED,
                "cross-Space conversation transfer is blocked; organization export requires a separately approved and audited policy",
              ));
            }
            if (targetRuntime?.profileId && targetRuntime.profileId !== targetProfileId) {
              return reply(rpcError(id, ERR.PARAMS, "target organization connection could not be resolved"));
            }
            if (targetRequested && (targetRuntime?.spaceId ?? failClosedSpaceId(targetProfileId)) !== targetSpaceId) {
              return reply(rpcError(
                id,
                ERR.UNAUTHORIZED,
                "the selected model connection is not authorized in the source Space",
              ));
            }
            if (targetRuntime?.availableModels?.length && !targetRuntime.availableModels.includes(targetModel)) {
              return reply(rpcError(
                id,
                ERR.PARAMS,
                `model '${targetModel}' is not authorized for organization connection '${targetProfileId}'`,
              ));
            }
            const hasRawImageHistory = source.history.some(
              (message) => message.role === "user" && Boolean(message.images?.length),
            );
            if (
              targetRequested
              && hasRawImageHistory
              && targetRuntime?.attachmentCapabilities?.image.mode !== undefined
              && targetRuntime.attachmentCapabilities.image.mode !== "native"
            ) {
              return reply(rpcError(
                id,
                ERR.PARAMS,
                (
                  `model '${targetModel}' cannot continue this copied conversation because its history `
                  + "contains native image attachments; choose an image-native target model"
                ),
              ));
            }
            const provider = targetRequested
              ? deps.buildProviderFor
                ? await deps.buildProviderFor(
                    targetModel,
                    targetRuntime?.defaultReasoningEffort ?? null,
                    source.meta.cwd,
                    targetProfileId,
                    targetSpaceId,
                  )
                : null
              : deps.buildProviderFor
                ? await deps.buildProviderFor(
                    sourceModel,
                    source.meta.effort !== undefined
                      ? source.meta.effort
                      : runtimeInfo(
                          source.meta.cwd,
                          sourceModel,
                          sourceProfileId,
                          sourceSpaceId,
                        ).defaultReasoningEffort ?? null,
                    source.meta.cwd,
                    sourceProfileId,
                    sourceSpaceId,
                  )
                : await deps.buildSessionProvider(source.meta.cwd, sourceProfileId, sourceSpaceId);
            if (closing) return;
            if (!provider) {
              return reply(rpcError(
                id,
                targetRequested && !deps.buildProviderFor ? ERR.METHOD : ERR.INTERNAL,
                targetRequested && !deps.buildProviderFor
                  ? "cross-profile conversation transfer is not supported by this server"
                  : "provider not authenticated — check the selected connection",
              ));
            }
            if (provider.model !== targetModel) {
              return reply(rpcError(id, ERR.INTERNAL, `provider did not honor requested model ${targetModel}`));
            }
            try {
              if (targetRequested) {
                const currentSource = hub.read(p.sessionId);
                if (
                  !currentSource
                  || currentSource.meta.profileId !== sourceProfileId
                  || currentSource.meta.spaceId !== sourceSpaceId
                ) {
                  return reply(rpcError(id, ERR.UNAUTHORIZED, "source session Space changed while the fork was starting; retry"));
                }
              } else {
                const currentSource = sessionSpaceBinding(source.meta);
                if (currentSource.profileId !== sourceProfileId || currentSource.spaceId !== sourceSpaceId) {
                  return reply(rpcError(id, ERR.UNAUTHORIZED, "source session Space changed while the fork was starting; retry"));
                }
              }
              if (targetRequested) {
                const currentTarget = runtimeInfo(source.meta.cwd, targetModel, targetProfileId, targetSpaceId);
                const currentTargetSpace = currentTarget.spaceId ?? failClosedSpaceId(currentTarget.profileId ?? targetProfileId);
                if (currentTarget.profileId && currentTarget.profileId !== targetProfileId) {
                  return reply(rpcError(id, ERR.UNAUTHORIZED, "target connection identity changed while the fork was starting; retry"));
                }
                if (currentTargetSpace !== sourceSpaceId || currentTargetSpace !== targetSpaceId) {
                  return reply(rpcError(id, ERR.UNAUTHORIZED, "target connection Space changed while the fork was starting; retry"));
                }
              }
            } catch (error) {
              return reply(rpcError(id, ERR.UNAUTHORIZED, error instanceof Error ? error.message : String(error)));
            }
            const r = hub.fork(p.sessionId, {
              profileId: targetProfileId,
              spaceId: targetSpaceId,
              model: targetModel,
              effort: targetRequested
                ? targetRuntime?.defaultReasoningEffort ?? null
                : source.meta.effort !== undefined
                  ? source.meta.effort
                  : runtimeInfo(
                      source.meta.cwd,
                      sourceModel,
                      sourceProfileId,
                      sourceSpaceId,
                    ).defaultReasoningEffort ?? null,
              provider,
              providerId: provider.id,
              approval: deps.approval,
              projectContext: undefined,
              sourceSnapshot: source,
            });
            if ("missing" in r) return reply(rpcError(id, ERR.NO_SESSION, `no session ${p.sessionId}`));
            if ("busy" in r) return reply(rpcError(id, ERR.BUSY, "source session is changing configuration — retry fork shortly"));
            r.session.configuring = true;
            let refreshed = false;
            try {
              refreshed = await refreshSessionProvider(r.session);
            } catch (error) {
              hub.delete(r.session.meta.id);
              return reply(rpcError(id, ERR.UNAUTHORIZED, error instanceof Error ? error.message : String(error)));
            } finally {
              r.session.configuring = false;
            }
            if (!refreshed) {
              hub.delete(r.session.meta.id);
              return reply(rpcError(id, ERR.INTERNAL, `provider not authenticated for pinned model '${r.session.meta.model}'`));
            }
            r.session.projectContext = loadAgentContext(r.session.meta.cwd) || undefined;
            return reply(rpcResult(id!, {
              sessionId: r.session.meta.id,
              title: r.session.meta.title,
              model: r.session.meta.model,
              profileId: r.session.meta.profileId,
              spaceId: r.session.meta.spaceId,
              approval: r.session.approval,
              agentRef: r.session.meta.agentRef,
              history: historyForClient(r.session.history),
            }));
          }
          case "session.delete": {
            // permanent removal (codex thread/delete) — archive is the soft path; this one is forever
            if (typeof p.sessionId !== "string") return reply(rpcError(id, ERR.PARAMS, "sessionId required"));
            const r = hub.delete(p.sessionId);
            if (r === "busy") return reply(rpcError(id, ERR.BUSY, "a turn is running — delete after it finishes"));
            if (r === "missing") return reply(rpcError(id, ERR.NO_SESSION, `no session ${p.sessionId} (or held by another process)`));
            disposeTodoScope(p.sessionId);
            disposeReminderScope(p.sessionId);
            resetRepeatGuard(p.sessionId);
            clearTouched(p.sessionId);
            workforceLedger.forget(p.sessionId);
            return reply(rpcResult(id!, { sessionId: p.sessionId, deleted: true }));
          }
          case "models.list": {
            const requestedSessionId = typeof p.sessionId === "string" ? p.sessionId : undefined;
            const session = requestedSessionId ? hub.get(requestedSessionId) : undefined;
            const savedMeta = requestedSessionId ? (session?.meta ?? hub.peekMeta(requestedSessionId)) : undefined;
            if (requestedSessionId && !savedMeta) {
              return reply(rpcError(id, ERR.NO_SESSION, `no session ${requestedSessionId}`));
            }
            const targetCwd = typeof p.cwd === "string" && p.cwd ? p.cwd : (savedMeta?.cwd ?? opts.cwd);
            const profileId = savedMeta?.profileId;
            const spaceId = savedMeta?.spaceId;
            const discoveredModels = deps.listModels ? await deps.listModels(targetCwd, profileId, spaceId).catch(() => []) : [];
            const defaultRuntime = runtimeInfo(targetCwd, undefined, profileId, spaceId);
            const current = savedMeta?.model ?? defaultRuntime.model;
            const currentRuntime = runtimeInfo(targetCwd, current, profileId, spaceId);
            const models = defaultRuntime.availableModels?.length
              ? [...defaultRuntime.availableModels]
              : discoveredModels;
            const currentAvailable = models.length ? models.includes(current) : undefined;
            const recommendedModel = currentAvailable === false
              ? tokenPlanModelReplacement(current, models)
              : undefined;
            const entries = [...new Set([current, ...models])].map((model) => {
              const modelRuntime = runtimeInfo(targetCwd, model, profileId, spaceId);
              return {
                id: model,
                providerId: modelRuntime.providerId,
                ...(models.length ? { available: models.includes(model) } : {}),
                effortLevels: modelRuntime.effortLevels ?? [],
                attachmentCapabilities: modelRuntime.attachmentCapabilities,
              };
            });
            return reply(rpcResult(id!, {
              models,
              entries,
              current,
              ...(currentAvailable !== undefined ? { currentAvailable } : {}),
              ...(recommendedModel ? { recommendedModel } : {}),
              profileId: savedMeta?.profileId ?? defaultRuntime.profileId,
              defaultModel: defaultRuntime.model,
              defaultReasoningEffort: defaultRuntime.defaultReasoningEffort ?? null,
              effort: session?.effort !== undefined
                ? session.effort
                : savedMeta?.effort ?? null,
              effortLevels: currentRuntime.effortLevels,
              attachmentCapabilities: currentRuntime.attachmentCapabilities,
            }));
          }
          case "settings.providers.list": {
            if (!deps.providerSettings) return reply(rpcError(id, ERR.METHOD, "provider settings not supported by this server"));
            const targetCwd = typeof p.cwd === "string" && p.cwd ? p.cwd : opts.cwd;
            return reply(rpcResult(id!, redactSensitiveValue(deps.providerSettings(targetCwd)).value));
          }
          case "settings.vision.test": {
            if (!deps.testVisionSettings) return reply(rpcError(id, ERR.METHOD, "vision settings are not supported by this server"));
            if (
              (p.source !== "current" && p.source !== "custom")
              || (p.provider !== undefined && typeof p.provider !== "string")
              || (p.model !== undefined && typeof p.model !== "string")
              || (p.baseURL !== undefined && typeof p.baseURL !== "string")
              || (p.apiKey !== undefined && typeof p.apiKey !== "string")
              || (p.clearApiKey !== undefined && typeof p.clearApiKey !== "boolean")
            ) {
              return reply(rpcError(id, ERR.PARAMS, "source must be current/custom; optional provider/model/baseURL/apiKey/clearApiKey have invalid types"));
            }
            const targetCwd = typeof p.cwd === "string" && p.cwd ? p.cwd : opts.cwd;
            const input: VisionSettingsTestInput = {
              source: p.source,
              ...(p.provider !== undefined ? { provider: p.provider } : {}),
              ...(p.model !== undefined ? { model: p.model } : {}),
              ...(p.baseURL !== undefined ? { baseURL: p.baseURL } : {}),
              ...(p.apiKey !== undefined ? { apiKey: p.apiKey } : {}),
              ...(p.clearApiKey !== undefined ? { clearApiKey: p.clearApiKey } : {}),
            };
            const result = await deps.testVisionSettings(input, targetCwd);
            return reply(rpcResult(id!, redactSensitiveValue(result).value));
          }
          case "settings.vision.save": {
            if (!deps.saveVisionSettings) return reply(rpcError(id, ERR.METHOD, "vision settings are not supported by this server"));
            if (
              typeof p.enabled !== "boolean"
              || (p.source !== undefined && p.source !== "current" && p.source !== "custom")
              || (p.provider !== undefined && typeof p.provider !== "string")
              || (p.model !== undefined && typeof p.model !== "string")
              || (p.baseURL !== undefined && typeof p.baseURL !== "string")
              || (p.apiKey !== undefined && typeof p.apiKey !== "string")
              || (p.clearApiKey !== undefined && typeof p.clearApiKey !== "boolean")
            ) {
              return reply(rpcError(id, ERR.PARAMS, "enabled is required; optional source/provider/model/baseURL/apiKey/clearApiKey have invalid types"));
            }
            const targetCwd = typeof p.cwd === "string" && p.cwd ? p.cwd : opts.cwd;
            const input: VisionSettingsInput = {
              enabled: p.enabled,
              ...(p.source !== undefined ? { source: p.source } : {}),
              ...(p.provider !== undefined ? { provider: p.provider } : {}),
              ...(p.model !== undefined ? { model: p.model } : {}),
              ...(p.baseURL !== undefined ? { baseURL: p.baseURL } : {}),
              ...(p.apiKey !== undefined ? { apiKey: p.apiKey } : {}),
              ...(p.clearApiKey !== undefined ? { clearApiKey: p.clearApiKey } : {}),
            };
            const result = await deps.saveVisionSettings(input, targetCwd);
            return reply(rpcResult(id!, redactSensitiveValue(result).value));
          }
          case "settings.providers.connections.create": {
            if (!deps.createProviderConnection) return reply(rpcError(id, ERR.METHOD, "named provider connections are not supported by this server"));
            if (
              typeof p.id !== "string" ||
              typeof p.label !== "string" ||
              typeof p.provider !== "string" ||
              typeof p.model !== "string" ||
              (p.baseURL !== undefined && typeof p.baseURL !== "string") ||
              (p.apiKey !== undefined && typeof p.apiKey !== "string") ||
              (p.clearApiKey !== undefined && typeof p.clearApiKey !== "boolean") ||
              (p.reasoningEffort !== undefined && typeof p.reasoningEffort !== "string") ||
              (p.clearReasoningEffort !== undefined && typeof p.clearReasoningEffort !== "boolean") ||
              (p.activate !== undefined && typeof p.activate !== "boolean")
            ) {
              return reply(rpcError(id, ERR.PARAMS, "id + label + provider + model required; optional baseURL/apiKey/clearApiKey/reasoningEffort/clearReasoningEffort/activate have invalid types"));
            }
            const targetCwd = typeof p.cwd === "string" && p.cwd ? p.cwd : opts.cwd;
            const input: ProviderConnectionCreateInput = {
              id: p.id,
              label: p.label,
              provider: p.provider,
              model: p.model,
              ...(p.baseURL !== undefined ? { baseURL: p.baseURL } : {}),
              ...(p.apiKey !== undefined ? { apiKey: p.apiKey } : {}),
              ...(p.clearApiKey !== undefined ? { clearApiKey: p.clearApiKey } : {}),
              ...(p.reasoningEffort !== undefined ? { reasoningEffort: p.reasoningEffort } : {}),
              ...(p.clearReasoningEffort !== undefined ? { clearReasoningEffort: p.clearReasoningEffort } : {}),
              ...(p.activate !== undefined ? { activate: p.activate } : {}),
            };
            const result = await deps.createProviderConnection(input, targetCwd);
            return reply(rpcResult(id!, redactSensitiveValue(result, [p.apiKey]).value));
          }
          case "settings.providers.connections.test": {
            if (!deps.testProviderConnection) return reply(rpcError(id, ERR.METHOD, "named provider connection testing is not supported by this server"));
            if (typeof p.id !== "string") return reply(rpcError(id, ERR.PARAMS, "named provider connection id required"));
            const targetCwd = typeof p.cwd === "string" && p.cwd ? p.cwd : opts.cwd;
            return reply(rpcResult(id!, redactSensitiveValue(await deps.testProviderConnection(p.id, targetCwd)).value));
          }
          case "settings.providers.connections.use":
          case "settings.providers.connections.remove": {
            if (typeof p.id !== "string") return reply(rpcError(id, ERR.PARAMS, "named provider connection id required"));
            const targetCwd = typeof p.cwd === "string" && p.cwd ? p.cwd : opts.cwd;
            if (req.method === "settings.providers.connections.use") {
              if (!deps.useProviderConnection) return reply(rpcError(id, ERR.METHOD, "named provider connection switching is not supported by this server"));
              return reply(rpcResult(id!, redactSensitiveValue(deps.useProviderConnection(p.id, targetCwd)).value));
            }
            if (!deps.removeProviderConnection) return reply(rpcError(id, ERR.METHOD, "named provider connection removal is not supported by this server"));
            return reply(rpcResult(id!, redactSensitiveValue(deps.removeProviderConnection(p.id, targetCwd)).value));
          }
          case "settings.profiles.unpin": {
            if (!deps.unpinProjectProfile) return reply(rpcError(id, ERR.METHOD, "project profile recovery not supported by this server"));
            const targetCwd = typeof p.cwd === "string" && p.cwd ? p.cwd : opts.cwd;
            return reply(rpcResult(id!, redactSensitiveValue(deps.unpinProjectProfile(targetCwd)).value));
          }
          case "settings.gateways.list": {
            if (!deps.gatewayStatuses) return reply(rpcError(id, ERR.METHOD, "gateway status not supported by this server"));
            const gateways = await deps.gatewayStatuses();
            return reply(rpcResult(id!, { gateways: redactSensitiveValue(gateways).value }));
          }
          case "settings.gateways.login.start": {
            if (!deps.startGatewayLogin) return reply(rpcError(id, ERR.METHOD, "gateway login not supported by this server"));
            if (typeof p.platform !== "string" || p.platform.trim().toLowerCase() !== "weixin") {
              return reply(rpcError(id, ERR.PARAMS, "platform must be 'weixin'"));
            }
            const login = await deps.startGatewayLogin("weixin");
            return reply(rpcResult(id!, { login: redactSensitiveValue(login).value }));
          }
          case "settings.gateways.login.status": {
            if (!deps.gatewayLoginStatus) return reply(rpcError(id, ERR.METHOD, "gateway login status not supported by this server"));
            if (
              typeof p.platform !== "string" ||
              p.platform.trim().toLowerCase() !== "weixin" ||
              (
                p.id !== undefined
                && (typeof p.id !== "string" || p.id.length < 1 || p.id.length > 128)
              )
            ) {
              return reply(rpcError(id, ERR.PARAMS, "platform must be 'weixin'; optional id must be 1-128 characters"));
            }
            const login = deps.gatewayLoginStatus("weixin", p.id);
            if (!login) return reply(rpcError(id, ERR.PARAMS, "gateway login session was not found"));
            return reply(rpcResult(id!, { login: redactSensitiveValue(login).value }));
          }
          case "settings.gateways.login.cancel": {
            if (!deps.cancelGatewayLogin) return reply(rpcError(id, ERR.METHOD, "gateway login cancellation not supported by this server"));
            if (
              typeof p.platform !== "string" ||
              p.platform.trim().toLowerCase() !== "weixin" ||
              typeof p.id !== "string" ||
              p.id.length < 1 ||
              p.id.length > 128
            ) {
              return reply(rpcError(id, ERR.PARAMS, "platform must be 'weixin' and id must be 1-128 characters"));
            }
            const login = deps.cancelGatewayLogin("weixin", p.id);
            if (!login) return reply(rpcError(id, ERR.PARAMS, "gateway login session was not found"));
            return reply(rpcResult(id!, { login: redactSensitiveValue(login).value }));
          }
          case "settings.organizations.list": {
            if (!deps.organizationConnections) return reply(rpcError(id, ERR.METHOD, "organization settings not supported by this server"));
            const targetCwd = typeof p.cwd === "string" && p.cwd ? p.cwd : opts.cwd;
            return reply(rpcResult(id!, redactSensitiveValue(deps.organizationConnections(targetCwd)).value));
          }
          case "settings.organizations.enroll": {
            if (!deps.enrollOrganizationConnection) return reply(rpcError(id, ERR.METHOD, "organization enrollment not supported by this server"));
            if (
              typeof p.id !== "string" ||
              typeof p.gatewayUrl !== "string" ||
              typeof p.code !== "string" ||
              (p.label !== undefined && typeof p.label !== "string") ||
              (p.activate !== undefined && typeof p.activate !== "boolean")
            ) {
              return reply(rpcError(id, ERR.PARAMS, "id + gatewayUrl + code required; optional label/activate have invalid types"));
            }
            const targetCwd = typeof p.cwd === "string" && p.cwd ? p.cwd : opts.cwd;
            const input: OrganizationEnrollmentInput = {
              id: p.id,
              gatewayUrl: p.gatewayUrl,
              code: p.code,
              ...(p.label !== undefined ? { label: p.label } : {}),
              ...(p.activate !== undefined ? { activate: p.activate } : {}),
            };
            const result = await deps.enrollOrganizationConnection(input, targetCwd);
            return reply(rpcResult(id!, redactSensitiveValue(result, [p.code]).value));
          }
          case "settings.organizations.use":
          case "settings.organizations.remove":
          case "settings.organizations.check": {
            if (typeof p.id !== "string") return reply(rpcError(id, ERR.PARAMS, "organization connection id required"));
            const targetCwd = typeof p.cwd === "string" && p.cwd ? p.cwd : opts.cwd;
            if (req.method === "settings.organizations.use") {
              if (!deps.useOrganizationConnection) return reply(rpcError(id, ERR.METHOD, "organization switching not supported by this server"));
              return reply(rpcResult(id!, redactSensitiveValue(deps.useOrganizationConnection(p.id, targetCwd)).value));
            }
            if (req.method === "settings.organizations.remove") {
              if (!deps.removeOrganizationConnection) return reply(rpcError(id, ERR.METHOD, "organization removal not supported by this server"));
              return reply(rpcResult(id!, redactSensitiveValue(deps.removeOrganizationConnection(p.id, targetCwd)).value));
            }
            if (!deps.checkOrganizationConnection) return reply(rpcError(id, ERR.METHOD, "organization connection check not supported by this server"));
            return reply(rpcResult(id!, redactSensitiveValue(await deps.checkOrganizationConnection(p.id, targetCwd)).value));
          }
          case "desk.connections.list": {
            if (!deps.deskConnections) return reply(rpcError(id, ERR.METHOD, "organization Desk is not supported by this server"));
            try {
              return reply(rpcResult(id!, redactSensitiveValue(deps.deskConnections()).value));
            } catch (error) {
              return reply(deskRpcError(id, error));
            }
          }
          case "desk.snapshot": {
            if (!deps.deskSnapshot) return reply(rpcError(id, ERR.METHOD, "organization Desk snapshots are not supported by this server"));
            if (
              typeof p.profileId !== "string"
              || !SERVE_PROFILE_ID_PATTERN.test(p.profileId)
              || (
                p.state !== undefined
                && (typeof p.state !== "string" || !SERVE_DESK_STATES.has(p.state as DeskTaskState))
              )
            ) {
              return reply(rpcError(id, ERR.PARAMS, "valid profileId required; optional state must be open, claimed, done, or cancelled"));
            }
            const profileId = p.profileId;
            const state = p.state as DeskTaskState | undefined;
            try {
              const result = await deps.deskSnapshot(profileId, state);
              return reply(rpcResult(id!, redactSensitiveValue(result).value));
            } catch (error) {
              return reply(deskRpcError(id, error));
            }
          }
          case "desk.task.get": {
            if (!deps.deskTask) return reply(rpcError(id, ERR.METHOD, "organization Desk task details are not supported by this server"));
            if (
              typeof p.profileId !== "string"
              || !SERVE_PROFILE_ID_PATTERN.test(p.profileId)
              || typeof p.taskId !== "string"
              || !SERVE_DESK_TASK_ID_PATTERN.test(p.taskId)
            ) {
              return reply(rpcError(id, ERR.PARAMS, "valid profileId and taskId required"));
            }
            const profileId = p.profileId;
            const taskId = p.taskId;
            try {
              const result = await deps.deskTask(profileId, taskId);
              return reply(rpcResult(id!, redactSensitiveValue(result).value));
            } catch (error) {
              return reply(deskRpcError(id, error));
            }
          }
          case "settings.providers.test":
          case "settings.providers.save": {
            const callback = req.method === "settings.providers.test" ? deps.testProviderSettings : deps.saveProviderSettings;
            if (!callback) return reply(rpcError(id, ERR.METHOD, "provider settings not supported by this server"));
            if (
              typeof p.provider !== "string" ||
              typeof p.model !== "string" ||
              (p.baseURL !== undefined && typeof p.baseURL !== "string") ||
              (p.apiKey !== undefined && typeof p.apiKey !== "string") ||
              (p.clearApiKey !== undefined && typeof p.clearApiKey !== "boolean") ||
              (p.reasoningEffort !== undefined && typeof p.reasoningEffort !== "string") ||
              (p.clearReasoningEffort !== undefined && typeof p.clearReasoningEffort !== "boolean") ||
              (p.activatePersonal !== undefined && typeof p.activatePersonal !== "boolean")
            ) {
              return reply(rpcError(id, ERR.PARAMS, "provider + model required; optional baseURL/apiKey/clearApiKey/reasoningEffort/clearReasoningEffort/activatePersonal have invalid types"));
            }
            const targetCwd = typeof p.cwd === "string" && p.cwd ? p.cwd : opts.cwd;
            const input: ProviderSettingsInput = {
              provider: p.provider,
              model: p.model,
              ...(p.baseURL !== undefined ? { baseURL: p.baseURL } : {}),
              ...(p.apiKey !== undefined ? { apiKey: p.apiKey } : {}),
              ...(p.clearApiKey !== undefined ? { clearApiKey: p.clearApiKey } : {}),
              ...(p.reasoningEffort !== undefined ? { reasoningEffort: p.reasoningEffort } : {}),
              ...(p.clearReasoningEffort !== undefined ? { clearReasoningEffort: p.clearReasoningEffort } : {}),
              ...(p.activatePersonal !== undefined ? { activatePersonal: p.activatePersonal } : {}),
            };
            const result = await callback(input, targetCwd);
            return reply(rpcResult(id!, redactSensitiveValue(result).value));
          }
          case "session.set-model": {
            // per-session model / thinking-effort switch (the composer picker). Rebuilds the session's
            // provider; takes effect on the NEXT turn. Refused mid-turn.
            if (typeof p.sessionId !== "string") return reply(rpcError(id, ERR.PARAMS, "sessionId required"));
            const s = hub.get(p.sessionId);
            if (!s) return reply(rpcError(id, ERR.NO_SESSION, `no live session ${p.sessionId}`));
            if (s.busy || s.configuring) return reply(rpcError(id, ERR.BUSY, "a turn/configuration change is running — switch after it finishes"));
            try {
              const binding = sessionSpaceBinding(s.meta);
              bindSafeLegacyPersonalSession(s, binding);
            } catch (error) {
              return reply(rpcError(id, ERR.UNAUTHORIZED, error instanceof Error ? error.message : String(error)));
            }
            const model = typeof p.model === "string" && p.model ? p.model : s.meta.model;
            if (p.effort !== undefined && typeof p.effort !== "string") {
              return reply(rpcError(id, ERR.PARAMS, "effort must be a string when provided"));
            }
            const effort = typeof p.effort === "string" && p.effort ? p.effort : null;
            if (!deps.buildProviderFor) return reply(rpcError(id, ERR.METHOD, "model switching not supported by this server"));
            const requestedRuntime = runtimeInfo(s.meta.cwd, model, s.meta.profileId, s.meta.spaceId);
            const requestedSpaceId = requestedRuntime.spaceId
              ?? failClosedSpaceId(requestedRuntime.profileId ?? s.meta.profileId);
            if (requestedSpaceId !== s.meta.spaceId) {
              return reply(rpcError(id, ERR.UNAUTHORIZED, "the selected model route belongs to a different Space"));
            }
            if (requestedRuntime.availableModels?.length && !requestedRuntime.availableModels.includes(model)) {
              return reply(rpcError(id, ERR.PARAMS, `model '${model}' is not authorized for the active organization connection`));
            }
            if (effort !== null && !requestedRuntime.effortLevels.includes(effort)) {
              return reply(rpcError(id, ERR.PARAMS, `thinking effort '${effort}' is not supported by model '${model}'`));
            }
            const hasRawImageHistory = s.history.some(
              (message) => message.role === "user" && Boolean(message.images?.length),
            );
            const requestedImageMode = requestedRuntime.attachmentCapabilities?.image.mode;
            if (
              hasRawImageHistory
              && requestedImageMode !== undefined
              && requestedImageMode !== "native"
            ) {
              return reply(rpcError(
                id,
                ERR.PARAMS,
                (
                  `model '${model}' cannot continue this session because its history contains ` +
                  "native image attachments; start a new session or choose an image-native model"
                ),
              ));
            }
            s.configuring = true;
            try {
              const provider = await deps.buildProviderFor(model, effort, s.meta.cwd, s.meta.profileId, s.meta.spaceId);
              if (closing) return;
              if (!provider) return reply(rpcError(id, ERR.INTERNAL, `could not build provider for ${model}`));
              if (provider.model !== model) return reply(rpcError(id, ERR.INTERNAL, `provider did not honor requested model ${model}`));
              try {
                sessionSpaceBinding(s.meta);
              } catch (error) {
                return reply(rpcError(id, ERR.UNAUTHORIZED, error instanceof Error ? error.message : String(error)));
              }
              s.provider = provider;
              s.meta.provider = provider.id;
              s.meta.model = model;
              s.meta.effort = effort;
              s.effort = effort;
              hub.save(s); // persist the picker immediately, even if no next turn is sent
              return reply(rpcResult(id!, { sessionId: s.meta.id, model, effort }));
            } finally {
              s.configuring = false;
            }
          }
          case "session.set-approval": {
            if (typeof p.sessionId !== "string") return reply(rpcError(id, ERR.PARAMS, "sessionId required"));
            if (!isApprovalMode(p.approval)) {
              return reply(rpcError(id, ERR.PARAMS, "approval must be suggest, auto-edit, or full-auto"));
            }
            const changed = hub.setApproval(p.sessionId, p.approval);
            if (changed === "missing") return reply(rpcError(id, ERR.NO_SESSION, `no session ${p.sessionId}`));
            if (changed === "busy") {
              return reply(rpcError(id, ERR.BUSY, "a turn/configuration change is running — switch approval mode after it finishes"));
            }
            return reply(rpcResult(id!, { sessionId: p.sessionId, approval: p.approval }));
          }
          case "automation.list": {
            // The automation timeline's data: cron jobs with their last outcome, plus this machine's
            // automated sessions (source=cron/gateway) so the desktop can render results and "continue
            // as conversation". Raw delivery targets are deliberately excluded from this renderer-facing
            // response: webhook paths/query strings and channel ids can themselves be credentials.
            if (
              p.sessionCursor !== undefined
              && (typeof p.sessionCursor !== "string" || !p.sessionCursor)
            ) {
              return reply(rpcError(id, ERR.PARAMS, "sessionCursor must be a non-empty opaque cursor"));
            }
            if (
              p.sessionLimit !== undefined
              && (
                !Number.isInteger(p.sessionLimit)
                || p.sessionLimit < 1
                || p.sessionLimit > 100
              )
            ) {
              return reply(rpcError(id, ERR.PARAMS, "sessionLimit must be an integer from 1 to 100"));
            }
            const now = Date.now();
            const nextRunDeadline = Date.now() + 40;
            const jobs = loadJobs().map((job) => automationJobForClient(
              job,
              now,
              Math.min(nextRunDeadline, Date.now() + 8),
            ));
            let automatedPage: ReturnType<SessionHub["listPage"]>;
            try {
              await sessionIndexReady();
              automatedPage = hub.listPage({
                sources: ["cron", "gateway"],
                ...(typeof p.sessionCursor === "string"
                  ? { cursor: p.sessionCursor }
                  : {}),
                ...(typeof p.sessionLimit === "number"
                  ? { limit: p.sessionLimit }
                  : {}),
              });
            } catch (error) {
              return reply(rpcError(
                id,
                ERR.PARAMS,
                error instanceof Error ? error.message : "invalid automation history page",
              ));
            }
            const automated = automatedPage.sessions.map(automationSessionForClient);
            return reply(rpcResult(id!, {
              jobs,
              sessions: automated,
              sessionPage: {
                hasMore: automatedPage.hasMore,
                limit: automatedPage.limit,
                ...(automatedPage.nextCursor
                  ? { nextCursor: automatedPage.nextCursor }
                  : {}),
              },
              scheduler: automationSchedulerInfo(),
            }));
          }
          case "automation.validate": {
            if (typeof p.schedule !== "string" || !p.schedule.trim()) {
              return reply(rpcError(id, ERR.PARAMS, "schedule required"));
            }
            if (p.id !== undefined && (typeof p.id !== "string" || !p.id.trim())) {
              return reply(rpcError(id, ERR.PARAMS, "id must be a non-empty automation id"));
            }
            if (p.tz !== undefined && typeof p.tz !== "string") {
              return reply(rpcError(id, ERR.PARAMS, "tz must be an IANA timezone name"));
            }
            const existing = typeof p.id === "string" ? findJob(p.id) : undefined;
            if (typeof p.id === "string" && !existing) {
              return reply(rpcError(id, ERR.PARAMS, `no job ${p.id}`));
            }
            const now = Date.now();
            const schedule = automationScheduleForRequest(p.schedule, now, existing);
            if ("error" in schedule) {
              return reply(rpcError(id, ERR.PARAMS, `bad schedule: ${schedule.error}`));
            }
            const requestedTimezone = typeof p.tz === "string" && p.tz.trim()
              ? p.tz.trim()
              : undefined;
            if (requestedTimezone && !validTz(requestedTimezone)) {
              return reply(rpcError(id, ERR.PARAMS, `invalid timezone "${requestedTimezone}"`));
            }
            const timezone = schedule.kind === "cron"
              ? p.tz === undefined
                ? existing?.tz
                : requestedTimezone
              : undefined;
            return reply(rpcResult(
              id!,
              automationScheduleValidation(schedule, timezone, now, existing),
            ));
          }
          case "learning.list": {
            const targetCwd = typeof p.cwd === "string" && p.cwd ? p.cwd : opts.cwd;
            const scopes = new Set<LearningScope>(["personal", "project", "organization"]);
            const states = new Set<LearningStatus>(["pending", "approved", "rejected", "revoked", "submitted"]);
            if (p.scope !== undefined && (typeof p.scope !== "string" || !scopes.has(p.scope as LearningScope))) {
              return reply(rpcError(id, ERR.PARAMS, "scope must be personal, project, or organization"));
            }
            if (p.status !== undefined && (typeof p.status !== "string" || !states.has(p.status as LearningStatus))) {
              return reply(rpcError(id, ERR.PARAMS, "status must be pending, approved, rejected, revoked, or submitted"));
            }
            if (p.limit !== undefined && (!Number.isInteger(p.limit) || p.limit < 1 || p.limit > 1_000)) {
              return reply(rpcError(id, ERR.PARAMS, "limit must be an integer from 1 to 1000"));
            }
            const runtime = runtimeInfo(targetCwd);
            const profileId = runtime.profileKind === "gateway" ? runtime.profileId : undefined;
            const organizationScopeId = profileId ? runtime.spaceId : undefined;
            const learnings = listLearnings({
              cwd: targetCwd,
              ...(organizationScopeId ? { profileId: organizationScopeId } : {}),
              ...(p.scope ? { scope: p.scope as LearningScope } : {}),
              ...(p.status ? { status: p.status as LearningStatus } : {}),
              ...(p.limit ? { limit: p.limit } : {}),
            });
            return reply(rpcResult(id!, {
              learnings,
              summary: {
                total: learnings.length,
                pending: learnings.filter((item) => item.status === "pending").length,
                approved: learnings.filter((item) => item.status === "approved").length,
                stable: learnings.filter((item) => item.stability === "stable").length,
              },
              organization: {
                active: Boolean(profileId && organizationScopeId),
                profileId,
                spaceId: organizationScopeId,
                submitAvailable: Boolean(profileId && organizationScopeId && deps.organizationLearningSubmit),
                syncAvailable: Boolean(profileId && organizationScopeId && deps.organizationLearningSync),
              },
            }));
          }
          case "learning.review": {
            if (typeof p.id !== "string" || !p.id.trim()) {
              return reply(rpcError(id, ERR.PARAMS, "learning id is required"));
            }
            if (p.decision !== "approve" && p.decision !== "reject" && p.decision !== "revoke") {
              return reply(rpcError(id, ERR.PARAMS, "decision must be approve, reject, or revoke"));
            }
            if (p.expectedRevision !== undefined && (!Number.isSafeInteger(p.expectedRevision) || p.expectedRevision < 1)) {
              return reply(rpcError(id, ERR.PARAMS, "expectedRevision must be a positive integer"));
            }
            if (p.note !== undefined && (typeof p.note !== "string" || p.note.length > 500)) {
              return reply(rpcError(id, ERR.PARAMS, "note must be a string up to 500 characters"));
            }
            const targetCwd = typeof p.cwd === "string" && p.cwd ? p.cwd : opts.cwd;
            const runtime = runtimeInfo(targetCwd);
            const profileId = runtime.profileKind === "gateway" ? runtime.profileId : undefined;
            const organizationScopeId = profileId ? runtime.spaceId : undefined;
            try {
              const learning = reviewLearning(p.id, p.decision, {
                cwd: targetCwd,
                ...(organizationScopeId ? { profileId: organizationScopeId } : {}),
                ...(p.expectedRevision !== undefined ? { expectedRevision: p.expectedRevision } : {}),
                ...(p.note ? { note: p.note } : {}),
              });
              return reply(rpcResult(id!, { learning }));
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              const code = /revision changed|changed; refresh/.test(message) ? ERR.CONFLICT : ERR.PARAMS;
              return reply(rpcError(id, code, message));
            }
          }
          case "learning.submit": {
            if (!deps.organizationLearningSubmit) return reply(rpcError(id, ERR.METHOD, "organization learning submission is unavailable"));
            if (typeof p.id !== "string" || !p.id.trim()) {
              return reply(rpcError(id, ERR.PARAMS, "learning id is required"));
            }
            const targetCwd = typeof p.cwd === "string" && p.cwd ? p.cwd : opts.cwd;
            const runtime = runtimeInfo(targetCwd);
            const profileId = runtime.profileKind === "gateway" ? runtime.profileId : undefined;
            const organizationScopeId = profileId ? runtime.spaceId : undefined;
            if (!profileId || !organizationScopeId) return reply(rpcError(id, ERR.PARAMS, "an organization connection with a verified Space must be active"));
            try {
              const result = await deps.organizationLearningSubmit(profileId, organizationScopeId, p.id.trim(), targetCwd);
              return reply(rpcResult(id!, result));
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              const code = /changed during|refresh and retry/.test(message) ? ERR.CONFLICT : ERR.PARAMS;
              return reply(rpcError(id, code, message));
            }
          }
          case "learning.sync": {
            if (!deps.organizationLearningSync) return reply(rpcError(id, ERR.METHOD, "organization learning sync is unavailable"));
            const targetCwd = typeof p.cwd === "string" && p.cwd ? p.cwd : opts.cwd;
            const runtime = runtimeInfo(targetCwd);
            const profileId = runtime.profileKind === "gateway" ? runtime.profileId : undefined;
            const organizationScopeId = profileId ? runtime.spaceId : undefined;
            if (!profileId || !organizationScopeId) return reply(rpcError(id, ERR.PARAMS, "an organization connection with a verified Space must be active"));
            try {
              const result = await deps.organizationLearningSync(profileId, organizationScopeId, targetCwd);
              return reply(rpcResult(id!, result));
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              const code = /changed during|refresh and retry/.test(message) ? ERR.CONFLICT : ERR.PARAMS;
              return reply(rpcError(id, code, message));
            }
          }
          case "tasks.list": {
            // The project's persistent task pool (the `task` tool's file store) — desktop's tasks panel.
            // File-backed, so it reflects tasks created by ANY hara process in that cwd. Read-only.
            const taskCwd = typeof p.cwd === "string" && p.cwd ? p.cwd : opts.cwd;
            return reply(rpcResult(id!, { tasks: loadTasks(taskCwd) }));
          }
          case "approvals.list": {
            // Unified approvals inbox: gateway-flow drafts awaiting the owner's verdict. (Per-turn tool
            // approvals stay on the live approval.request/reply channel — they are transient by nature.)
            return reply(rpcResult(id!, { flowDrafts: listPending() }));
          }
          case "approvals.resolve": {
            if (typeof p.id !== "string" || !["approve", "edit", "reject"].includes(p.verdict as string)) {
              return reply(rpcError(id, ERR.PARAMS, "id + verdict(approve|edit|reject) required"));
            }
            if (p.verdict === "edit" && (typeof p.draft !== "string" || !p.draft.trim())) {
              return reply(rpcError(id, ERR.PARAMS, "a non-empty draft is required for edit"));
            }
            const outcome = await resolvePending(p.id, p.verdict as "approve" | "edit" | "reject", typeof p.draft === "string" ? p.draft : undefined);
            return reply(rpcResult(id!, { outcome }));
          }
          case "automation.add": {
            if (
              typeof p.name !== "string"
              || !p.name.trim()
              || typeof p.schedule !== "string"
              || !p.schedule.trim()
              || typeof p.task !== "string"
              || !p.task.trim()
            ) {
              return reply(rpcError(id, ERR.PARAMS, "name + schedule + task required"));
            }
            if (
              p.mode !== undefined
              && p.mode !== "print"
              && p.mode !== "org"
              && p.mode !== "command"
            ) {
              return reply(rpcError(id, ERR.PARAMS, "mode must be print, org, or command"));
            }
            if (p.cwd !== undefined && (typeof p.cwd !== "string" || !p.cwd.trim())) {
              return reply(rpcError(id, ERR.PARAMS, "cwd must be a non-empty path"));
            }
            if (p.tz !== undefined && typeof p.tz !== "string") {
              return reply(rpcError(id, ERR.PARAMS, "tz must be an IANA timezone name"));
            }
            if (p.clearDeliver !== undefined) {
              return reply(rpcError(id, ERR.PARAMS, "clearDeliver only applies when updating a task"));
            }
            const sched = parseSchedule(p.schedule, Date.now());
            if ("error" in sched) return reply(rpcError(id, ERR.PARAMS, `bad schedule: ${sched.error}`));
            const requestedTimezone = typeof p.tz === "string" && p.tz.trim()
              ? p.tz.trim()
              : undefined;
            if (requestedTimezone && !validTz(requestedTimezone)) {
              return reply(rpcError(id, ERR.PARAMS, `invalid timezone "${requestedTimezone}"`));
            }
            const timezone = sched.kind === "cron" ? requestedTimezone : undefined;
            if (p.deliver !== undefined && (typeof p.deliver !== "string" || !p.deliver.trim())) {
              return reply(rpcError(id, ERR.PARAMS, "deliver must be a non-empty delivery target"));
            }
            const deliver = typeof p.deliver === "string" ? p.deliver.trim() : undefined;
            if (deliver) {
              const parsed = parseDeliver(deliver);
              if ("error" in parsed) return reply(rpcError(id, ERR.PARAMS, parsed.error));
              const configurationError = deliveryConfigurationError(deliver);
              if (configurationError) return reply(rpcError(id, ERR.PARAMS, configurationError));
              const conflict = deliveryInstructionConflict(p.task, deliver);
              if (conflict) return reply(rpcError(id, ERR.PARAMS, conflict));
            }
            if (p.deliverMode !== undefined && !isAutomationDeliveryMode(p.deliverMode)) {
              return reply(rpcError(id, ERR.PARAMS, "deliverMode must be always, on-output, or on-error"));
            }
            const deliverMode = isAutomationDeliveryMode(p.deliverMode)
              ? p.deliverMode
              : undefined;
            if (deliverMode && !deliver) return reply(rpcError(id, ERR.PARAMS, "deliverMode requires deliver"));
            const alertAfter = p.alertAfter === undefined ? undefined : Number(p.alertAfter);
            if (alertAfter !== undefined && (!Number.isInteger(alertAfter) || alertAfter < 1 || alertAfter > 1_000)) {
              return reply(rpcError(id, ERR.PARAMS, "alertAfter must be an integer from 1 to 1000"));
            }
            const job = addJob({
              name: p.name.trim().slice(0, 60),
              schedule: sched,
              task: p.task,
              mode: p.mode === "org" || p.mode === "command" ? p.mode : "print",
              cwd: typeof p.cwd === "string" ? p.cwd.trim() : opts.cwd,
              ...(timezone ? { tz: timezone } : {}),
              ...(deliver ? { deliver } : {}),
              ...(deliverMode ? { deliverMode } : {}),
              ...(alertAfter !== undefined ? { alertAfter } : {}),
              createdAt: Date.now(),
            });
            return reply(rpcResult(id!, {
              id: job.id,
              name: job.name,
              schedule: describeSchedule(job.schedule),
              scheduleSpec: automationScheduleSpec(job.schedule),
            }));
          }
          case "automation.update": {
            if (
              typeof p.id !== "string"
              || !p.id.trim()
              || typeof p.name !== "string"
              || !p.name.trim()
              || typeof p.schedule !== "string"
              || !p.schedule.trim()
              || typeof p.task !== "string"
              || !p.task.trim()
            ) {
              return reply(rpcError(id, ERR.PARAMS, "id + name + schedule + task required"));
            }
            let existing = findJob(p.id);
            if (!existing) return reply(rpcError(id, ERR.PARAMS, `no job ${p.id}`));
            if (existing.lastStatus === "running") {
              const state = recoverJobRunningState(existing.id);
              if (state.recovered) {
                return reply(rpcError(
                  id,
                  ERR.CONFLICT,
                  `job ${existing.id}'s previous owner exited; Hara recovered and disabled the attempt. Inspect the workspace, then retry the edit.`,
                ));
              }
              existing = state.current;
              if (!existing) return reply(rpcError(id, ERR.PARAMS, `no job ${p.id}`));
              if (existing.lastStatus === "running") {
                return reply(rpcError(id, ERR.BUSY, `job ${existing.id} is currently running`));
              }
            }
            if (p.mode !== "print" && p.mode !== "org" && p.mode !== "command") {
              return reply(rpcError(id, ERR.PARAMS, "mode must be print, org, or command"));
            }
            if (p.cwd !== undefined && (typeof p.cwd !== "string" || !p.cwd.trim())) {
              return reply(rpcError(id, ERR.PARAMS, "cwd must be a non-empty path"));
            }
            if (p.tz !== undefined && typeof p.tz !== "string") {
              return reply(rpcError(id, ERR.PARAMS, "tz must be an IANA timezone name"));
            }
            const now = Date.now();
            const parsedSchedule = automationScheduleForRequest(p.schedule, now, existing);
            if ("error" in parsedSchedule) {
              return reply(rpcError(id, ERR.PARAMS, `bad schedule: ${parsedSchedule.error}`));
            }
            const schedule: Schedule = parsedSchedule;
            const requestedTimezone = typeof p.tz === "string" && p.tz.trim()
              ? p.tz.trim()
              : undefined;
            if (requestedTimezone && !validTz(requestedTimezone)) {
              return reply(rpcError(id, ERR.PARAMS, `invalid timezone "${requestedTimezone}"`));
            }
            // Omission preserves the current cron timezone. An explicit empty string clears it; changing
            // to a non-cron schedule also drops timezone metadata because it no longer affects execution.
            const timezone = schedule.kind === "cron"
              ? p.tz === undefined
                ? existing.tz
                : requestedTimezone
              : undefined;
            if (p.clearDeliver !== undefined && typeof p.clearDeliver !== "boolean") {
              return reply(rpcError(id, ERR.PARAMS, "clearDeliver must be a boolean"));
            }
            if (
              p.clearDeliver === true
              && (p.deliver !== undefined || p.deliverMode !== undefined)
            ) {
              return reply(rpcError(
                id,
                ERR.PARAMS,
                "clearDeliver cannot be combined with deliver or deliverMode",
              ));
            }
            if (p.deliver !== undefined && (typeof p.deliver !== "string" || !p.deliver.trim())) {
              return reply(rpcError(id, ERR.PARAMS, "deliver must be a non-empty delivery target"));
            }
            const deliver = typeof p.deliver === "string" ? p.deliver.trim() : undefined;
            if (deliver) {
              const parsed = parseDeliver(deliver);
              if ("error" in parsed) return reply(rpcError(id, ERR.PARAMS, parsed.error));
              const configurationError = deliveryConfigurationError(deliver);
              if (configurationError) return reply(rpcError(id, ERR.PARAMS, configurationError));
            }
            if (p.deliverMode !== undefined && !isAutomationDeliveryMode(p.deliverMode)) {
              return reply(rpcError(id, ERR.PARAMS, "deliverMode must be always, on-output, or on-error"));
            }
            const deliverMode = isAutomationDeliveryMode(p.deliverMode)
              ? p.deliverMode
              : undefined;
            const delivery: CronDeliveryUpdate = p.clearDeliver === true
              ? { kind: "clear" }
              : deliver
                ? { kind: "replace", deliver, ...(deliverMode ? { mode: deliverMode } : {}) }
                : { kind: "preserve", ...(deliverMode ? { mode: deliverMode } : {}) };
            const effectiveDeliver = p.clearDeliver === true ? undefined : deliver ?? existing.deliver;
            if (effectiveDeliver) {
              const configurationError = deliveryConfigurationError(effectiveDeliver);
              if (configurationError) return reply(rpcError(id, ERR.PARAMS, configurationError));
            }
            const conflict = deliveryInstructionConflict(p.task, effectiveDeliver);
            if (conflict) return reply(rpcError(id, ERR.PARAMS, conflict));
            const alertAfter = p.alertAfter === undefined ? undefined : Number(p.alertAfter);
            if (alertAfter !== undefined && (!Number.isInteger(alertAfter) || alertAfter < 1 || alertAfter > 1_000)) {
              return reply(rpcError(id, ERR.PARAMS, "alertAfter must be an integer from 1 to 1000"));
            }
            const updated = updateJob(existing.id, {
              name: p.name.trim().slice(0, 60),
              schedule,
              task: p.task,
              mode: p.mode,
              cwd: typeof p.cwd === "string" ? p.cwd.trim() : existing.cwd,
              ...(timezone ? { tz: timezone } : {}),
              ...(alertAfter !== undefined ? { alertAfter } : {}),
            }, delivery, now);
            if (updated === "running") {
              return reply(rpcError(id, ERR.BUSY, `job ${existing.id} started running before the update`));
            }
            if (updated === "missing-deliver") {
              return reply(rpcError(id, ERR.PARAMS, "deliverMode requires an existing or replacement delivery target"));
            }
            if (!updated) return reply(rpcError(id, ERR.PARAMS, `no job ${existing.id}`));
            return reply(rpcResult(id!, {
              id: updated.id,
              name: updated.name,
              schedule: describeSchedule(updated.schedule),
              scheduleSpec: automationScheduleSpec(updated.schedule),
            }));
          }
          case "automation.run": {
            if (typeof p.id !== "string" || !p.id.trim()) {
              return reply(rpcError(id, ERR.PARAMS, "id required"));
            }
            let job = findJob(p.id);
            if (!job) return reply(rpcError(id, ERR.PARAMS, `no job ${p.id}`));
            if (job.lastStatus === "running") {
              const state = recoverJobRunningState(job.id);
              if (state.recovered) {
                return reply(rpcResult(id!, {
                  id: job.id,
                  ok: false,
                  error: `The previous owner exited; Hara recovered and disabled the attempt. Inspect the workspace, then run ${job.id} again explicitly.`,
                }));
              }
              job = state.current;
              if (!job) return reply(rpcError(id, ERR.PARAMS, `no job ${p.id}`));
              if (job.lastStatus === "running") {
                return reply(rpcError(id, ERR.BUSY, `job ${job.id} is already running`));
              }
            }
            const controller = new AbortController();
            const run = runJobTracked(job, { signal: controller.signal });
            automationRuns.set(controller, run);
            let result;
            try {
              result = await run;
            } finally {
              automationRuns.delete(controller);
            }
            return reply(rpcResult(id!, {
              id: job.id,
              ok: result.ok,
              ...(result.error
                ? { error: redactSensitiveText(result.error).text }
                : {}),
            }));
          }
          case "automation.toggle": {
            if (typeof p.id !== "string" || !p.id.trim() || typeof p.enabled !== "boolean") return reply(rpcError(id, ERR.PARAMS, "id + enabled required"));
            const job = findJob(p.id);
            if (!job || !setEnabled(job.id, p.enabled)) {
              return reply(rpcError(id, ERR.PARAMS, `no job ${p.id}`));
            }
            return reply(rpcResult(id!, { id: job.id, enabled: p.enabled }));
          }
          case "automation.delete": {
            if (typeof p.id !== "string" || !p.id.trim()) return reply(rpcError(id, ERR.PARAMS, "id required"));
            let job = findJob(p.id);
            if (!job) return reply(rpcError(id, ERR.PARAMS, `no job ${p.id}`));
            if (job.lastStatus === "running") {
              const state = recoverJobRunningState(job.id);
              if (state.recovered) {
                return reply(rpcError(
                  id,
                  ERR.CONFLICT,
                  `job ${job.id}'s previous owner exited; Hara recovered and disabled the attempt. Inspect the workspace, then retry deletion.`,
                ));
              }
              job = state.current;
              if (!job) return reply(rpcError(id, ERR.PARAMS, `no job ${p.id}`));
              if (job.lastStatus === "running") {
                return reply(rpcError(id, ERR.BUSY, `job ${job.id} is currently running`));
              }
            }
            if (!removeJob(job.id)) {
              const current = findJob(job.id);
              if (current?.lastStatus === "running") {
                return reply(rpcError(id, ERR.BUSY, `job ${job.id} started running before deletion`));
              }
              return reply(rpcError(id, ERR.PARAMS, `no job ${p.id}`));
            }
            return reply(rpcResult(id!, { id: job.id, deleted: true }));
          }
          case "automation.scheduler.install": {
            const before = automationSchedulerInfo();
            if (!before.supported) {
              return reply(rpcError(id, ERR.PARAMS, before.detail));
            }
            const installed = installScheduler(selfArgv());
            if (!installed.ok) {
              return reply(rpcError(
                id,
                ERR.INTERNAL,
                redactSensitiveText(installed.msg).text,
              ));
            }
            return reply(rpcResult(id!, { scheduler: automationSchedulerInfo() }));
          }
          case "presentation.create": {
            if (p.title !== undefined && typeof p.title !== "string") {
              return reply(rpcError(id, ERR.PARAMS, "title must be a string"));
            }
            if (p.project !== undefined && (!p.project || typeof p.project !== "object" || Array.isArray(p.project))) {
              return reply(rpcError(id, ERR.PARAMS, "project must be a PresentationProject object"));
            }
            if (p.actor !== undefined || p.taskRunId !== undefined) {
              return reply(rpcError(id, ERR.PARAMS, "actor and taskRunId are assigned by the authenticated host"));
            }
            try {
              const details = createPresentationArtifact(artifactHome, {
                ...(p.title !== undefined ? { title: p.title } : {}),
                ...(p.project !== undefined ? { project: p.project } : {}),
                actor: "user",
              });
              return reply(rpcResult(id!, details));
            } catch (error) {
              return reply(artifactRpcError(id, error, "import"));
            }
          }
          case "presentation.import": {
            if (typeof p.sourcePath !== "string" || !p.sourcePath) {
              return reply(rpcError(id, ERR.PARAMS, "sourcePath required"));
            }
            if (p.title !== undefined && typeof p.title !== "string") {
              return reply(rpcError(id, ERR.PARAMS, "title must be a string"));
            }
            if (p.actor !== undefined || p.taskRunId !== undefined) {
              return reply(rpcError(id, ERR.PARAMS, "actor and taskRunId are assigned by the authenticated host"));
            }
            try {
              const details = await importPresentationArtifact(artifactHome, {
                sourcePath: p.sourcePath,
                ...(p.title !== undefined ? { title: p.title } : {}),
                actor: "user",
              });
              return reply(rpcResult(id!, details));
            } catch (error) {
              return reply(artifactRpcError(id, error, "import"));
            }
          }
          case "presentation.update": {
            if (
              typeof p.artifactId !== "string"
              || typeof p.baseRevisionId !== "string"
              || !p.project
              || typeof p.project !== "object"
              || Array.isArray(p.project)
            ) {
              return reply(rpcError(id, ERR.PARAMS, "artifactId, baseRevisionId, and project required"));
            }
            if (p.actor !== undefined || p.taskRunId !== undefined) {
              return reply(rpcError(id, ERR.PARAMS, "actor and taskRunId are assigned by the authenticated host"));
            }
            try {
              return reply(rpcResult(id!, updatePresentationArtifact(artifactHome, {
                artifactId: p.artifactId,
                baseRevisionId: p.baseRevisionId,
                project: p.project,
                actor: "user",
              })));
            } catch (error) {
              return reply(artifactRpcError(id, error, "commit"));
            }
          }
          case "presentation.get": {
            if (typeof p.artifactId !== "string") {
              return reply(rpcError(id, ERR.PARAMS, "artifactId required"));
            }
            if (p.revisionId !== undefined && typeof p.revisionId !== "string") {
              return reply(rpcError(id, ERR.PARAMS, "revisionId must be a string"));
            }
            try {
              const details = getPresentationArtifact(
                artifactHome,
                p.artifactId,
                p.revisionId,
              );
              return reply(rpcResult(id!, details));
            } catch (error) {
              return reply(artifactRpcError(id, error, "open"));
            }
          }
          case "presentation.validate": {
            if (typeof p.artifactId !== "string" || typeof p.revisionId !== "string") {
              return reply(rpcError(id, ERR.PARAMS, "artifactId and revisionId required"));
            }
            try {
              const report = validatePresentationArtifact(artifactHome, {
                artifactId: p.artifactId,
                revisionId: p.revisionId,
              });
              return reply(rpcResult(id!, { report }));
            } catch (error) {
              return reply(artifactRpcError(id, error, "validate"));
            }
          }
          case "presentation.export": {
            if (
              typeof p.artifactId !== "string"
              || typeof p.revisionId !== "string"
              || typeof p.validationReportId !== "string"
              || typeof p.destinationPath !== "string"
              || (p.format !== "json" && p.format !== "html" && p.format !== "pdf" && p.format !== "pptx")
            ) {
              return reply(rpcError(
                id,
                ERR.PARAMS,
                "artifactId, revisionId, validationReportId, destinationPath, and format (json, html, pdf, or pptx) required",
              ));
            }
            try {
              const receipt = await exportPresentationArtifact(artifactHome, {
                artifactId: p.artifactId,
                revisionId: p.revisionId,
                validationReportId: p.validationReportId,
                destinationPath: p.destinationPath,
                format: p.format,
              });
              return reply(rpcResult(id!, { receipt }));
            } catch (error) {
              return reply(artifactRpcError(id, error, "export"));
            }
          }
          case "presentation.preview-file": {
            if (typeof p.artifactId !== "string" || typeof p.revisionId !== "string") {
              return reply(rpcError(id, ERR.PARAMS, "artifactId and revisionId required"));
            }
            try {
              return reply(rpcResult(id!, createPresentationPreviewFile(artifactHome, {
                artifactId: p.artifactId,
                revisionId: p.revisionId,
              })));
            } catch (error) {
              return reply(artifactRpcError(id, error, "open"));
            }
          }
          case "presentation.render": {
            if (!p.project || typeof p.project !== "object" || Array.isArray(p.project)) {
              return reply(rpcError(id, ERR.PARAMS, "project must be a PresentationProject object"));
            }
            try {
              return reply(rpcResult(id!, renderPresentationDraft({ project: p.project })));
            } catch (error) {
              return reply(artifactRpcError(id, error, "open"));
            }
          }
          case "presentation.preview": {
            if (typeof p.artifactId !== "string" || typeof p.revisionId !== "string") {
              return reply(rpcError(id, ERR.PARAMS, "artifactId and revisionId required"));
            }
            try {
              return reply(rpcResult(id!, renderPresentationPreview(artifactHome, {
                artifactId: p.artifactId,
                revisionId: p.revisionId,
              })));
            } catch (error) {
              return reply(artifactRpcError(id, error, "open"));
            }
          }
          case "artifact.import": {
            if (typeof p.sourcePath !== "string" || !p.sourcePath) {
              return reply(rpcError(id, ERR.PARAMS, "sourcePath required"));
            }
            if (
              p.kind !== undefined
              && p.kind !== "presentation"
              && p.kind !== "spreadsheet"
              && p.kind !== "document"
            ) return reply(rpcError(id, ERR.PARAMS, "kind must be presentation, spreadsheet, or document"));
            if (p.title !== undefined && typeof p.title !== "string") {
              return reply(rpcError(id, ERR.PARAMS, "title must be a string"));
            }
            try {
              const details = await importArtifact(artifactHome, {
                sourcePath: p.sourcePath,
                ...(p.title !== undefined ? { title: p.title } : {}),
                ...(p.kind !== undefined ? { kind: p.kind as ArtifactKind } : {}),
              });
              return reply(rpcResult(id!, details));
            } catch (error) {
              return reply(artifactRpcError(id, error, "import"));
            }
          }
          case "artifact.commit": {
            if (
              typeof p.artifactId !== "string"
              || typeof p.baseRevisionId !== "string"
              || typeof p.sourcePath !== "string"
              || !p.sourcePath
            ) {
              return reply(rpcError(id, ERR.PARAMS, "artifactId, baseRevisionId, and sourcePath required"));
            }
            if (p.actor !== undefined) {
              return reply(rpcError(id, ERR.PARAMS, "actor is assigned by the authenticated host"));
            }
            if (p.taskRunId !== undefined && typeof p.taskRunId !== "string") {
              return reply(rpcError(id, ERR.PARAMS, "taskRunId must be a string"));
            }
            if (p.changedPaths !== undefined && !Array.isArray(p.changedPaths)) {
              return reply(rpcError(id, ERR.PARAMS, "changedPaths must be an array"));
            }
            try {
              const details = await commitArtifact(artifactHome, {
                artifactId: p.artifactId,
                baseRevisionId: p.baseRevisionId,
                sourcePath: p.sourcePath,
                actor: "user",
                ...(p.taskRunId !== undefined ? { taskRunId: p.taskRunId } : {}),
                ...(p.changedPaths !== undefined ? { changedPaths: p.changedPaths as string[] } : {}),
              });
              return reply(rpcResult(id!, details));
            } catch (error) {
              return reply(artifactRpcError(id, error, "commit"));
            }
          }
          case "artifact.revert": {
            if (
              typeof p.artifactId !== "string"
              || typeof p.baseRevisionId !== "string"
              || typeof p.targetRevisionId !== "string"
            ) {
              return reply(rpcError(id, ERR.PARAMS, "artifactId, baseRevisionId, and targetRevisionId required"));
            }
            if (p.actor !== undefined) {
              return reply(rpcError(id, ERR.PARAMS, "actor is assigned by the authenticated host"));
            }
            if (p.taskRunId !== undefined && typeof p.taskRunId !== "string") {
              return reply(rpcError(id, ERR.PARAMS, "taskRunId must be a string"));
            }
            try {
              const details = revertArtifact(artifactHome, {
                artifactId: p.artifactId,
                baseRevisionId: p.baseRevisionId,
                targetRevisionId: p.targetRevisionId,
                actor: "user",
                ...(p.taskRunId !== undefined ? { taskRunId: p.taskRunId } : {}),
              });
              return reply(rpcResult(id!, details));
            } catch (error) {
              return reply(artifactRpcError(id, error, "revert"));
            }
          }
          case "artifact.validate": {
            if (typeof p.artifactId !== "string" || typeof p.revisionId !== "string") {
              return reply(rpcError(id, ERR.PARAMS, "artifactId and revisionId required"));
            }
            try {
              const report = validateArtifact(artifactHome, {
                artifactId: p.artifactId,
                revisionId: p.revisionId,
              });
              return reply(rpcResult(id!, { report }));
            } catch (error) {
              return reply(artifactRpcError(id, error, "validate"));
            }
          }
          case "artifact.export": {
            if (
              typeof p.artifactId !== "string"
              || typeof p.revisionId !== "string"
              || typeof p.validationReportId !== "string"
              || typeof p.destinationPath !== "string"
            ) {
              return reply(rpcError(
                id,
                ERR.PARAMS,
                "artifactId, revisionId, validationReportId, and destinationPath required",
              ));
            }
            try {
              const receipt = exportArtifact(artifactHome, {
                artifactId: p.artifactId,
                revisionId: p.revisionId,
                validationReportId: p.validationReportId,
                destinationPath: p.destinationPath,
              });
              return reply(rpcResult(id!, { receipt }));
            } catch (error) {
              return reply(artifactRpcError(id, error, "export"));
            }
          }
          case "artifact.list": {
            try {
              return reply(rpcResult(id!, listArtifacts(artifactHome)));
            } catch (error) {
              return reply(artifactRpcError(id, error, "list"));
            }
          }
          case "artifact.get": {
            if (typeof p.artifactId !== "string") {
              return reply(rpcError(id, ERR.PARAMS, "artifactId required"));
            }
            try {
              return reply(rpcResult(id!, getArtifact(artifactHome, p.artifactId)));
            } catch (error) {
              return reply(artifactRpcError(id, error, "open"));
            }
          }
          case "artifact.revisions": {
            if (typeof p.artifactId !== "string") {
              return reply(rpcError(id, ERR.PARAMS, "artifactId required"));
            }
            try {
              const revisions = listArtifactRevisions(artifactHome, p.artifactId);
              return reply(rpcResult(id!, { artifactId: p.artifactId, revisions }));
            } catch (error) {
              return reply(artifactRpcError(id, error, "list revisions"));
            }
          }
          case "skills.list": {
            const cwd = typeof p.cwd === "string" && p.cwd ? p.cwd : opts.cwd;
            return reply(rpcResult(id!, { skills: loadSkillIndex(cwd).map((s) => ({ id: s.id, description: s.description, source: s.source })) }));
          }
          case "project.panels": {
            // panels applicable to a project (plugin manifest `detect` markers under the cwd) — powers
            // the desktop's chat ↔ live-preview split for design/video projects.
            const ps = typeof p.sessionId === "string" ? hub.get(p.sessionId) : undefined;
            const pcwd = typeof p.cwd === "string" && p.cwd ? p.cwd : (ps?.meta.cwd ?? opts.cwd);
            const panels = panelsForProject(pcwd).map(({ plugin, panel }) => ({ plugin, id: panel.id, title: panel.title, command: panel.command, args: panel.args ?? [], port: panel.port }));
            return reply(rpcResult(id!, { cwd: pcwd, panels }));
          }
          case "files.search": {
            // fuzzy file lookup for the composer's @-mention autocomplete (codex fuzzyFileSearch).
            // Relative POSIX paths; empty query returns the first files as a browse list.
            const sess = typeof p.sessionId === "string" ? hub.get(p.sessionId) : undefined;
            const cwd = typeof p.cwd === "string" && p.cwd ? p.cwd : (sess?.meta.cwd ?? opts.cwd);
            const limit = Math.min(Math.max(Math.trunc(Number(p.limit) || 20), 1), 50);
            const inventory = await listProjectFilesAsync(cwd, {
              maxFiles: 8_000,
              maxDirectories: 20_000,
              maxEntries: 100_000,
              timeoutMs: 1_000,
              yieldEvery: 64,
            });
            const all = inventory.files;
            const query = typeof p.query === "string" ? p.query : "";
            const files = query ? fuzzyRank(query, all, (f) => f).slice(0, limit).map((r) => r.item) : all.slice(0, limit);
            return reply(rpcResult(id!, { files, cwd, truncated: inventory.truncated, reason: inventory.reason }));
          }
          case "session.context": {
            // context-spend breakdown + watermark on demand (codex thread/tokenUsage + /context).
            if (typeof p.sessionId !== "string") return reply(rpcError(id, ERR.PARAMS, "sessionId required"));
            const s = hub.get(p.sessionId);
            if (!s) return reply(rpcError(id, ERR.NO_SESSION, `no live session ${p.sessionId}`));
            const report = analyzeContext(s.history);
            return reply(rpcResult(id!, { sessionId: s.meta.id, ...ctxOf(s), total: report.total, rows: report.rows.slice(0, 8) }));
          }
          case "session.compact": {
            // manual compaction (codex thread/compact/start): summarize + replace history, keep working
            // notes, restore this-cwd touched files. Busy-guarded like a turn — it IS a provider call.
            if (typeof p.sessionId !== "string") return reply(rpcError(id, ERR.PARAMS, "sessionId required"));
            const s = hub.get(p.sessionId);
            if (!s) return reply(rpcError(id, ERR.NO_SESSION, `no live session ${p.sessionId}`));
            if (s.busy || s.configuring) return reply(rpcError(id, ERR.BUSY, "a turn/configuration change is running — compact after it finishes"));
            if (s.history.length < 2) return reply(rpcError(id, ERR.PARAMS, "nothing to compact yet"));
            s.busy = true;
            const compactAbort = new AbortController();
            s.abort = compactAbort;
            try {
              if (!(await refreshSessionProvider(s))) {
                return reply(rpcError(id, ERR.INTERNAL, `provider not authenticated for pinned model '${s.meta.model}'`));
              }
              broadcast("event.notice", { sessionId: s.meta.id, text: "✻ Compacting conversation…" });
              const summary = await compactSession(s, compactAbort);
              if (!summary) return reply(rpcError(id, ERR.INTERNAL, "compaction failed — try again or /clear"));
              broadcast("event.notice", { sessionId: s.meta.id, text: `(compacted — history replaced with a summary; ${s.meta.workingSet?.length ?? 0} notes kept)` });
              return reply(rpcResult(id!, { sessionId: s.meta.id, ctx: ctxOf(s), notes: s.meta.workingSet?.length ?? 0, history: historyForClient(s.history) }));
            } finally {
              if (s.abort === compactAbort) s.abort = null;
              s.busy = s.pendingProviderTurns > 0 || s.pendingToolRuns > 0;
            }
          }
          case "session.rewind": {
            // fork the thread back to before the n-th-most-recent user turn (codex thread/rollback;
            // n=1 drops the last exchange). History-only — file edits are not reverted.
            if (typeof p.sessionId !== "string" || !Number.isInteger(p.n)) return reply(rpcError(id, ERR.PARAMS, "sessionId + n required"));
            const s = hub.get(p.sessionId);
            if (!s) return reply(rpcError(id, ERR.NO_SESSION, `no live session ${p.sessionId}`));
            if (s.busy || s.configuring) return reply(rpcError(id, ERR.BUSY, "a turn/configuration change is running — rewind after it finishes"));
            const next = rewindTo(s.history, p.n);
            if (!next) return reply(rpcError(id, ERR.PARAMS, `n out of range (1..${s.history.filter((m) => m.role === "user").length})`));
            s.history.length = 0;
            s.history.push(...next);
            s.task = undefined;
            hub.save(s);
            return reply(rpcResult(id!, { sessionId: s.meta.id, history: historyForClient(s.history) }));
          }
          default:
            return reply(rpcError(id, ERR.METHOD, `unknown method ${req.method}`));
        }
        } catch (e: any) {
          const organizationAuthorizationRejected = isOrganizationAuthorizationRejection(e);
          const code = e instanceof SessionSpaceBoundaryError || organizationAuthorizationRejected
            ? ERR.UNAUTHORIZED
            : e instanceof ExternalSessionInputError ? ERR.PARAMS : ERR.INTERNAL;
          runtimeLog("rpc.failed", {
            method: req.method,
            code,
            category: code === ERR.UNAUTHORIZED
              ? "authorization"
              : code === ERR.PARAMS ? "invalid_request" : serveRuntimeFailureCategory(e),
          });
          return reply(rpcError(
            id,
            code,
            organizationAuthorizationRejected
              ? organizationAuthorizationRecoveryMessage()
              : redactSensitiveText(String(e?.message ?? e)).text,
          ));
        }
      })();
      inFlightRequests.add(task);
      const settled = (): void => {
        inFlightRequests.delete(task);
        // close() may already have returned after its bounded grace period. Once a late turn/provider
        // handshake clears busy/configuring, releaseIdle finishes the lock cleanup without waiting for exit.
        if (closing) hub.releaseIdle();
      };
      void task.then(
        settled,
        settled,
      );
    });
    ws.on("close", () => {
      authed.delete(ws);
      void releaseExternalTerminalsForSocket(ws);
      if (authed.size === 0) {
        // nobody left to answer — deny pending approvals now instead of stalling turns for the timeout
        for (const approval of pendingApprovals.values()) approval.finish(false);
        pendingApprovals.clear();
      }
    });
  });

  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closing = true; // message handlers check this before parsing, so no new work enters the hub
    runtimeLog("serve.stopping");
    if (sessionIndexRefreshTimer) clearInterval(sessionIndexRefreshTimer);
    closePromise = (async () => {
      const serverClosed = new Promise<void>((resolve) => {
        try {
          wss.close(() => resolve()); // stop accepting sockets immediately
        } catch {
          resolve(); // already closed/not running
        }
      });

      for (const approval of pendingApprovals.values()) approval.finish(false);
      pendingApprovals.clear();
      await Promise.all([...externalTerminalStreams.keys()].map((client) => releaseExternalTerminalsForSocket(client)));
      const ownedAutomationRuns = [...automationRuns.entries()];
      for (const [controller] of ownedAutomationRuns) {
        controller.abort(new Error("Hara Serve is shutting down"));
      }
      for (const session of hub.active()) session.abort?.abort();
      await externalSessions.close?.().catch(() => {});
      await deps.closeGatewayLogins?.().catch(() => {});

      for (const client of wss.clients) {
        try {
          client.close(1001, "server shutting down");
        } catch {
          client.terminate();
        }
      }
      const terminateTimer = setTimeout(() => {
        for (const client of wss.clients) client.terminate();
      }, SOCKET_CLOSE_GRACE_MS);
      terminateTimer.unref();

      if (!deps.quietDiscovery) await removeOwnedDiscovery(discoveryDir, discoveryPath, discovery).catch(() => {});

      // `runJobTracked` bounds child cancellation and terminal persistence itself. Unlike ordinary
      // non-cooperative provider work, a Serve-owned automation must be durable before an updater may
      // treat close() as complete; otherwise process exit can strand a false `running` marker.
      await Promise.allSettled(ownedAutomationRuns.map(([, run]) => run));

      const deadline = Date.now() + SHUTDOWN_GRACE_MS;
      let quiet = false;
      while (Date.now() < deadline) {
        if (
          inFlightRequests.size === 0 &&
          activeOperations.size === 0 &&
          hub.active().every((session) => !session.busy && !session.configuring && session.pendingProviderTurns === 0 && session.pendingToolRuns === 0)
        ) {
          quiet = true;
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
      }
      // Never release a lock while its turn/configuration may still persist. Idle sessions are safe to
      // release; an uncooperative in-flight operation retains ownership until it settles/process exit.
      if (quiet) hub.releaseAll();
      else hub.releaseIdle();

      for (const client of wss.clients) client.terminate();
      const remaining = deadline - Date.now();
      if (remaining > 0) {
        await Promise.race([
          serverClosed,
          new Promise<void>((resolve) => setTimeout(resolve, remaining)),
        ]);
      }
      clearTimeout(terminateTimer);
      authed.clear();
    })();
    return closePromise;
  };
  return { port, token, close };
}
