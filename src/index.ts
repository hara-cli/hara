#!/usr/bin/env node
import { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { emitKeypressEvents } from "node:readline";
import { runTui, askConfirm } from "./tui/run.js";
import { readClipboardImage, mediaTypeFor } from "./images.js";
import {
  describeImages,
  effectiveAttachmentCapabilities,
  locateImage,
  classifyVision,
  visionSidecarAuthorized,
  SCREENSHOT_SYSTEM,
} from "./vision.js";
import { setTheme } from "./tui/theme.js";
import { memoryDigest, memoryDir, readRecentLogs, scaffoldMemory, type Scope } from "./memory/store.js";
import {
  formatLearningList,
  listLearnings,
  reviewLearning,
  type LearningScope,
  type LearningStatus,
} from "./learning/store.js";
import { nextMode as cycleMode, type Approval } from "./tui/InputBox.js";
import { stdin, stdout } from "node:process";
import { readFileSync, existsSync, realpathSync, statSync, writeFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import {
  loadConfig,
  configPath,
  readRawConfig,
  updateRawConfig,
  writeConfigValue,
  setModelVisionOverride,
  providerCatalog,
  providerEnvKey,
  providerDefaultBaseURL,
  providerIsLocal,
  providerRequiresApiKey,
  normalizePersonalProviderConfig,
  clearPersonalProviderConfig,
  reusablePersonalProviderApiKey,
  updatePersonalProviderConfig,
  isProviderId,
  CONFIG_KEYS,
  APPROVAL_MODES,
  SANDBOX_MODES,
  COMPUTER_USE_MODES,
  REASONING_EFFORTS,
  type HaraConfig,
  type ApprovalMode,
  type ProviderId,
} from "./config.js";
import { runAgent, type RunOpts, type RunOutcome } from "./agent/loop.js";
import {
  formatAgentDuration,
  parseAgentRunTimeoutMs,
  MIN_AGENT_RUN_TIMEOUT_MS,
  MAX_AGENT_RUN_TIMEOUT_MS,
  MAX_AGENT_MAX_ROUNDS,
} from "./agent/limits.js";
import { parseSchemaArg, structuredOutputTool, STRUCTURED_INSTRUCTION, STRUCTURED_NUDGE } from "./agent/structured.js";
import { notifyDone } from "./notify.js";
import { startMcpServer, mcpServeToolNames } from "./mcp/server.js";
import { completionScript } from "./completions.js";
import { renderSessionMarkdown } from "./export.js";
import {
  loadEnrollment,
  clearEnrollment,
  enrollDevice,
  enrollGatewayProfile,
  upsertGatewayProfileFromEnrollment,
  enrollmentFromProfile,
  heartbeatEnrollment,
  heartbeat,
  gatewayBaseURL,
  syncOrgRoles,
  syncOrgRolesForProfile,
  submitOrganizationLearning as submitOrganizationLearningToControl,
  syncOrganizationLearnings as syncOrganizationLearningsFromControl,
  deviceTokenExpired,
  deviceTokenExpiryWarning,
} from "./org-fleet/enroll.js";
import {
  isOrganizationAuthorizationRejection,
  organizationAuthorizationRecoveryMessage,
} from "./org-fleet/errors.js";
import {
  loadActiveProfile,
  listProfiles,
  useProfile,
  addProfile,
  removeProfile,
  syncStoredPersonalProfile,
  setModel as setProfileModel,
  resetModel as resetProfileModel,
  setProfileVisionSettings,
  getProfile,
  effectiveModel,
  routingLabel,
  routeHost,
  activeId,
  resolveActive,
  setFlagOverride,
  writePin,
  removePin,
  unpinResolvedProjectProfile,
  pinFilePath,
  DEFAULT_ORG_ID,
  PERSONAL_ID,
  isValidProfileId,
  spaceIdForProfile,
  type Profile,
  type ActiveResolution,
} from "./profile/profile.js";
import { serviceBindingHost } from "./profile/organization-service.js";
import { loadPermissionRules, scaffoldPermissions, globalPermissionsPath, projectPermissionsPath } from "./security/permissions.js";
import { projectApprovalPolicy } from "./security/project-approvals.js";
import { routingProvider } from "./agent/route.js";
import {
  shouldAutoCompact,
  shouldAutoCompactTokens,
  autoCompactTokenCap,
  COMPACT_SYSTEM,
  buildFileRestore,
  compactedConversationHistory,
  compactedHistoryTokenEstimate,
  compactionSourceHistory,
  normalizeCompactionSummary,
  recentHistoryForCompaction,
  workingSetFromSummary,
} from "./agent/compact.js";
import { recentTouched, clearTouched } from "./agent/touched.js";
import { INTERJECT_PREFIX, disposeReminderScope } from "./agent/reminders.js";
import { checkForUpdate, fetchLatestVersion, isNewer } from "./update-check.js";
import {
  inspectInstallation,
  installationLabel,
  manualUpdateInstruction,
  upgradeNpmInstallation,
  type InstallationInfo,
} from "./update-install.js";
import { formatContextReport } from "./agent/context-report.js";
import { userTurnPreviews, rewindTo } from "./agent/rewind.js";
import { checkpoint, listCheckpoints, restoreCheckpoint } from "./checkpoints.js";
import { mapLimit, maxParallel } from "./concurrency.js";
import {
  parseVerdict,
  captureChanges,
  reviewPrompt,
  fixPrompt,
  REVIEWER_SYSTEM,
  isTreeClean,
  stripCommitFence,
  commitMessageInput,
  protectedStagedPaths,
  protectedTrackedWorkingTreePaths,
  protectedWorkingTreePaths,
  type CapturedChanges,
} from "./org/review-chain.js";
import { parseSchedule, describeSchedule, nextRun, validTz } from "./cron/schedule.js";
import {
  deliveryConfigurationError,
  deliveryInstructionConflict,
  parseDeliver,
} from "./cron/deliver.js";
import {
  addJob,
  recoverJobRunningState,
  removeJob,
  setEnabled,
  resolveJob,
  loadJobs,
  logPath,
  type CronJob,
} from "./cron/store.js";
import { runTick, runJobTracked, runSelfAttached, selfArgv } from "./cron/runner.js";
import { installScheduler, uninstallScheduler, isInstalled } from "./cron/install.js";
import { getTools, type Tool, type ToolContext } from "./tools/registry.js";
import { resetReachability } from "./tools/net-reachability.js";
import { resetRepeatGuard } from "./agent/repeat-guard.js";
import { allowsEvolutionTool, allowsMemoryDistillTool, EVOLUTION_SYSTEM, evolutionStatus, shouldAutoEvolve } from "./agent/evolution.js";
import {
  createNativeSubagentProvider,
  NATIVE_SUBAGENT_PROVIDER_ID,
  type NativeSubagentRequest,
} from "./subagent/native.js";
import {
  SubagentRuntime,
  subagentResultText,
  type SubagentLifecycleObserver,
} from "./subagent/runtime.js";
import {
  overrideProviderTarget,
  profileByIdForConfig,
  profileForConfig,
  resolveByokProviderTarget,
  resolveGatewayModel,
  type ProviderTargetOverride,
} from "./providers/target.js";
import { createProviderForTarget } from "./providers/factory.js";
import { resolvePlatform } from "./providers/registry.js";
import { boundedProviderTurn } from "./providers/bounded-turn.js";
import { levelsFor, normalizeEffort } from "./tui/model-picker.js";
import { isOfficialTokenPlanOpenAIEndpoint, tokenPlanModelHint } from "./providers/alibaba.js";
import { planNoteLines } from "./providers/plan-notes.js";
import { listModels } from "./providers/models.js";
import { createModelFetch } from "./network/model-fetch.js";
import { listJobs, tailJob, killJob } from "./exec/jobs.js";
import { readModelContextFileSync } from "./fs-read.js";
import { MIN_NODE_VERSION, unsupportedNodeMessage } from "./runtime.js";
import { redactKnownSecrets, redactSensitiveText } from "./security/secrets.js";
import { normalizePackageRegistry } from "./package-registry.js";
import {
  DeskClientError,
  deskOrganizationIdentityMatches,
  deskConnectionsSnapshot as localDeskConnectionsSnapshot,
  fetchDeskSnapshot,
  fetchDeskTask,
  removeProfileCreds,
  type DeskOrganizationIdentity,
  type DeskTaskState,
} from "./desk.js";

/** Render the background-job list for /jobs (user-facing view of what the agent has running in the
 *  background — dev servers, watchers, long tasks). Mirrors codex/Claude-Code process visibility. */
function renderBgJobs(): string {
  const js = listJobs();
  if (!js.length) return "(no background jobs — the agent starts them with bash {background:true})";
  const age = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`);
  const rows = js.map((j) => {
    const st = j.status === "running" ? "▶ running" : j.status === "killed" ? "✕ killed" : `● exited${j.code != null ? ` (${j.code})` : ""}`;
    const cmd = j.command.length > 64 ? j.command.slice(0, 64) + "…" : j.command;
    return `  ${j.id}  ${st}  ${age(j.ageMs).padStart(4)}  ${cmd}`;
  });
  return `Background jobs — /jobs tail <id> · /jobs kill <id>:\n${rows.join("\n")}`;
}
import { qwenDeviceLogin, loadQwenToken } from "./providers/qwen-oauth.js";
import { loadAgentContext, hasAgentsMd, hasProjectContent, INIT_PROMPT, findProjectRoot } from "./context/agents-md.js";
import {
  homeWorkspaceActionError,
  discoverProjectWorkspaces,
  isUnsafeProjectWorkspace,
  resolveWorkspaceSwitch,
  suggestedProjectWorkspace,
} from "./context/workspace-scope.js";
import { getEmbedder } from "./search/embed.js";
import { collectRepoChunksAsync, collectDirChunksAsync, buildIndex, indexPath, indexExists, type Chunk, type ChunkCollectionResult } from "./search/semindex.js";
import { searchHybrid } from "./search/hybrid.js";
import { expandMentionsAsync, fileCandidates, isSlashCommand, inlineLeadingPath } from "./context/mentions.js";
import {
  isGeneratedSessionId,
  newSessionId,
  shortId,
  resolveSessionId,
  validSessionId,
  sessionFileExists,
  saveSession,
  loadSession,
  acquireSessionLock,
  reclaimOrphanedSessionLocks,
  releaseSessionLock,
  ensureSessionMetadataIndex,
  findSessionMetadataByPrefix,
  recentSessionMetadata,
  latestForCwd,
  titleFrom,
  sessionSourceFromEnv,
  gatewayOwnerFromSessionId,
  automatedTitle,
  slugify,
  sanitizeSessionTitle,
  type SessionMeta,
  type SessionData,
} from "./session/store.js";
import {
  consumePendingTaskSteering,
  continueTaskExecution,
  createTaskExecution,
  finishTaskExecution,
  formatTaskExecution,
  hasPendingTaskSteering,
  newSteerInteraction,
  newTurnInteraction,
  recordTaskSteering,
  recoverTaskExecution,
  routeTaskInteraction,
  requestsTaskContinuation,
  taskExecutionContext,
  type TaskExecution,
  type TaskInteraction,
} from "./session/task.js";
import { displaySessionCwd, resolveSessionResumeTarget } from "./session/resume.js";
import {
  persistWorkspaceSessionFork,
  recentWorkspaceTransferCandidate,
} from "./session/transfer.js";
import { setSessionForceModel, isSessionForceModel, effectiveRoleModel } from "./session/session-model.js";
import { pruneStoredToolResults } from "./tools/result-limit.js";
import { createPhysicalOperationDrain } from "./session/operation-drain.js";
import {
  assertOrganizationModelAllowed,
  loadOrganizationExecutionPolicy,
  orgRolesDir,
  roleToolFilter,
  scaffoldRoles,
  type OrganizationExecutionPolicy,
  type Role,
} from "./org/roles.js";
import {
  buildAgentsIndex,
  canonicalProjectPath,
  loadActiveGlobalRoles,
  loadActiveRoles,
  resolveAgent,
  loadProjects,
  addProject,
  removeProject,
  type AgentIndexEntry,
} from "./org/projects.js";
import { loadSkillIndex, loadSkillBody, scaffoldSkills, globalSkillsDir } from "./skills/skills.js";
import { installPlugin, uninstallPlugin, listInstalled, enabledPlugins, setPluginEnabled, pluginMcpServers, pluginHooks, haraBinDir } from "./plugins/plugins.js";
import { routeByKeywords, buildDispatchPrompt, parseRoleId } from "./org/router.js";
import { decompose, topoOrder, topoWaves, savePlan, loadPlan, atomPrompt, verify, type Atom, type Plan } from "./org/planner.js";
import { closeMcp, registerLazyMcpServers } from "./mcp/client.js";
import { sandboxSupported, runShell, type SandboxMode } from "./sandbox.js";
import { undoLast } from "./undo.js";
import { searchAssets, scaffoldAssets, assetsDir, assetSearchRoots } from "./recall.js";
import type { Provider, NeutralMsg, ImageAttachment } from "./providers/types.js";
import {
  bindOrganizationProvider,
  refreshOrganizationExecutionPolicy,
} from "./providers/organization-bound.js";
import { c, out, statusLine } from "./ui.js";
import * as bar from "./statusbar.js";
import { nearest } from "./fuzzy.js";
import "./tools/builtin.js"; // register read_file/write_file/python/bash/job
import "./tools/inspect-image.js"; // register verified local image inspection
import "./tools/runtime.js"; // register tool_search/tool_result_read
import "./tools/edit.js"; // register edit_file
import "./tools/search.js"; // register grep/glob/ls
import "./tools/patch.js"; // register apply_patch
import "./tools/web.js"; // register web_fetch
import "./tools/agent.js"; // register agent (subagent spawn)
import "./tools/memory.js"; // register memory_search/get/write/forget/skill_create
import "./tools/learning.js"; // register reviewable execution-time learning capture
import { automaticSessionRecall } from "./tools/session-search.js"; // register + deterministic explicit-cue recall
import "./tools/skill.js"; // register the skill loader tool
import "./tools/codebase.js"; // register codebase_search (repo as a knowledge base)
import "./tools/todo.js"; // register todo_write (inline task checklist)
import { clearTodos, disposeTodoScope, restoreTodos, onTodosChange } from "./tools/todo.js"; // scoped session todo persistence
import "./tools/task.js"; // register task (project-level durable task pool)
import "./tools/send.js"; // register send_file (self-gates on HARA_GATEWAY — pushes a file to the chat)
import "./tools/external_agent.js"; // register external_agent (delegate to claude-code / codex headless)
import "./tools/ask_user.js"; // register ask_user (pause mid-turn to ask the user a structured question)
import "./tools/cron.js"; // register cronjob (model-facing scheduler — "remind me every morning" just works)
import { computerBackends } from "./tools/computer.js"; // register the computer tool + expose the backend probe
import "./tools/open-directory.js"; // register safe Finder/File Explorer directory opening
import "./tools/open-browser.js"; // register safe real-browser navigation for website/UI testing
import { HARA_RUNTIME_VERSION } from "./version.js";

const here = dirname(fileURLToPath(import.meta.url));
// Version: from a build-time define in the compiled single-binary (no package.json on its virtual FS),
// else read package.json (npm install / `node dist`). The read is wrapped so the binary never hits it.
const pkg = {
  version: HARA_RUNTIME_VERSION,
};

const maskKey = (v?: string) => (v ? `••••${v.slice(-4)}` : "(unset)");
const SECRET_CONFIG_KEY = /(?:apiKey|secret|token|password)$/i;
const maskProxy = (value: unknown): string => {
  if (typeof value !== "string" || !value.trim()) return "(unset)";
  try {
    const url = new URL(value);
    const authenticated = Boolean(url.username || url.password);
    url.username = "";
    url.password = "";
    return `${url.protocol}//${url.host}${authenticated ? " (credentials redacted)" : ""}`;
  } catch {
    return "(configured, invalid URL hidden)";
  }
};
const displayConfigValue = (key: string, value: unknown): string => {
  if (key === "proxy") return maskProxy(value);
  if (SECRET_CONFIG_KEY.test(key)) return maskKey(typeof value === "string" ? value : undefined);
  return value === undefined ? "(unset)" : String(value);
};

// One mutable HaraConfig object owns one foreground run. Once that run is attached to a persisted
// session, every auxiliary provider built from the same config (role, guardian, routing, fallback, or an
// interactive /model switch) must stay on the session's identity route. A WeakMap keeps this runtime-only
// binding out of config serialization and lets explicit callback bindings override it for hara serve.
const runtimeProfileBindings = new WeakMap<HaraConfig, string>();

/** Resolve the current authenticated organization enrollment that owns a durable Space. A personal
 * provider route may pay for inference inside that Space, but it never becomes the source of company
 * identity, Agent policy, or permissions. Prefer the active enrollment when several routes reach the
 * same tenant; otherwise keep the selection deterministic in profile-file order. */
function organizationEnrollmentForSpace(cfg: HaraConfig, expectedSpaceId: string): Profile | null {
  if (expectedSpaceId === PERSONAL_ID) return null;
  const candidates = listProfiles().filter(
    (profile) => profile.kind === "gateway" && spaceIdForProfile(profile) === expectedSpaceId,
  );
  const activeProfileId = resolveActive(cfg.cwd).id;
  return candidates.find((profile) => profile.id === activeProfileId) ?? candidates[0] ?? null;
}

/** Return undefined only for an unconstrained Personal Space. Company Spaces always return a concrete
 * server-authoritative catalog (possibly empty), so image routing fails closed while policy is unknown. */
function authorizedVisionModelsForRoute(
  cfg: HaraConfig,
  profile: Profile,
  expectedSpaceId: string,
): readonly string[] | undefined {
  if (expectedSpaceId === PERSONAL_ID) return undefined;
  const enrollment = profile.kind === "gateway"
    ? profile
    : organizationEnrollmentForSpace(cfg, expectedSpaceId);
  return enrollment?.availableModels ?? [];
}

async function buildProvider(
  cfg: HaraConfig,
  targetOverride?: ProviderTargetOverride,
  boundProfileId?: string,
  boundSpaceId?: string,
  reasoningEffortOverride?: HaraConfig["reasoningEffort"] | null,
  forceTargetModel = false,
): Promise<Provider | null> {
  // Identity-profile is the source of truth for routing. `cfg` is the *merged* HaraConfig (env +
  // project + global) and still drives non-routing concerns (model overrides, baseURL fallbacks
  // for things like routing/fallback helpers). The active profile decides "where to send
  // requests" — gateway (deviceToken at the gateway) vs BYOK (user's key direct to the provider).
  const effectiveProfileId = boundProfileId ?? runtimeProfileBindings.get(cfg);
  const ap = effectiveProfileId
    ? profileByIdForConfig(cfg, effectiveProfileId)
    : profileForConfig(cfg).profile;
  if (!ap) {
    throw new Error(`session profile '${effectiveProfileId}' is no longer available; re-enroll that connection or start a new session with an existing profile`);
  }
  if (!isValidProfileId(ap.id)) {
    throw new Error("the selected profile uses a legacy invalid id; re-add it with 1-64 letters, numbers, dots, underscores, or dashes");
  }
  const expectedSpaceId = boundSpaceId ?? spaceIdForProfile(ap);
  assertProfileAudience(cfg, ap.id, expectedSpaceId);
  if (ap.kind === "gateway") {
    if (!ap.gatewayUrl || !ap.deviceToken || deviceTokenExpired(ap.tokenExpiresAt)) return null;
    const baseURL = ap.baseURL || `${ap.gatewayUrl.replace(/\/$/, "")}/v1`;
    const model = forceTargetModel && targetOverride?.model
      ? targetOverride.model
      : resolveGatewayModel(cfg, ap, process.env, targetOverride?.model);
    if (ap.availableModels?.length && !ap.availableModels.includes(model)) {
      throw new Error(`model '${model}' is not authorized for organization connection '${ap.id}'`);
    }
    const target = {
      provider: "hara-gateway" as const,
      apiKey: ap.deviceToken,
      baseURL,
      model,
      ...(cfg.proxy ? { proxy: cfg.proxy } : {}),
    };
    const reasoningEffort = reasoningEffortOverride === null
      ? undefined
      : reasoningEffortOverride
        ?? (runtimeProfileBindings.get(cfg) === ap.id ? cfg.reasoningEffort : undefined)
        ?? gatewayDefaultReasoningEffort(ap, model);
    const rawProvider = await createProviderForTarget(target, reasoningEffort);
    const built = rawProvider
      ? bindOrganizationProvider(rawProvider, { ...ap }, () => profileByIdForConfig(cfg, ap.id))
      : null;
    if (!targetOverride && built) {
      cfg.provider = target.provider;
      cfg.model = target.model;
      cfg.baseURL = target.baseURL;
      cfg.apiKey = undefined;
      cfg.reasoningEffort = reasoningEffort;
      runtimeProfileBindings.set(cfg, ap.id);
    }
    return built;
  }

  const baseTarget = resolveByokProviderTarget(cfg, ap, false);
  const target = overrideProviderTarget(baseTarget, targetOverride);
  const connectionReasoningEffort = ap.id === PERSONAL_ID
    ? cfg.reasoningEffort
    : ap.reasoningEffort as HaraConfig["reasoningEffort"];
  const reasoningEffort = reasoningEffortOverride === null
    ? undefined
    : reasoningEffortOverride ?? connectionReasoningEffort;
  const rawProvider = await createProviderForTarget(target, reasoningEffort);
  let built = rawProvider;
  if (rawProvider && expectedSpaceId !== PERSONAL_ID) {
    const enrollment = organizationEnrollmentForSpace(cfg, expectedSpaceId);
    if (!enrollment) {
      throw new Error(`company Space '${expectedSpaceId}' is no longer enrolled; refusing personal-key inference`);
    }
    const policy = await ensureOrganizationExecutionPolicy(cfg, ap, expectedSpaceId);
    if (!policy) throw new Error("organization execution policy is unavailable; refusing personal-key inference");
    assertOrganizationModelAllowed(policy, target.model);
    built = bindOrganizationProvider(
      rawProvider,
      { ...enrollment },
      () => profileByIdForConfig(cfg, enrollment.id),
      { requirePersonalModelConnections: true },
    );
  }
  // The rest of the active run (status, vision classification, role defaults, resume) must see the resolved
  // identity route rather than the always-populated Personal/global fields. Explicit overrides stay isolated.
  if (!targetOverride && built) {
    cfg.provider = target.provider;
    cfg.model = target.model;
    cfg.baseURL = target.baseURL;
    cfg.apiKey = target.apiKey;
    cfg.reasoningEffort = reasoningEffort;
    runtimeProfileBindings.set(cfg, ap.id);
  }
  return built;
}

/** Select the provider that is allowed to receive image bytes for this exact session route. Explicit
 * vision configuration always wins, including when the conversation model is natively multimodal. */
async function buildImageProviderForRoute(
  cfg: HaraConfig,
  primary: Provider,
  profile: Profile,
  expectedSpaceId: string,
): Promise<{ provider: Provider; translated: boolean }> {
  const routeProfile = assertProfileAudience(cfg, profile.id, expectedSpaceId);
  const vision = visionRouteForProfile(cfg, routeProfile);
  if (vision.model) {
    const authorizedModels = authorizedVisionModelsForRoute(cfg, routeProfile, expectedSpaceId);
    if (!visionSidecarAuthorized(vision.model, authorizedModels)) {
      throw new Error(
        `vision-first model '${vision.model}' is not authorized for company Space '${expectedSpaceId}'; ` +
        "choose a model advertised by this organization or disable the vision-first route",
      );
    }
    if (routeProfile.kind === "gateway" && vision.source === "custom") {
      throw new Error("company vision routing must reuse the managed provider connection");
    }
    const visionProviderId = visionProviderForRoute(cfg, vision, primary.id);
    if (classifyVision(visionProviderId, vision.model, cfg.modelVision) !== "vision") {
      throw new Error(`vision-first model '${vision.model}' is not confirmed to accept image input`);
    }
    if (vision.source === "custom" && providerRequiresApiKey(visionProviderId) && !vision.apiKey) {
      throw new Error("the independent vision interface is missing its API key");
    }
    const imageProvider = await buildProvider(cfg, {
      ...(vision.source === "custom"
        ? { provider: visionProviderId, baseURL: vision.baseURL, apiKey: vision.apiKey }
        : {}),
      model: vision.model,
    }, routeProfile.id, expectedSpaceId, null, true);
    assertProfileAudience(cfg, routeProfile.id, expectedSpaceId);
    if (!imageProvider) {
      throw new Error(`vision-first model '${vision.model}' is not authenticated for profile '${routeProfile.id}'`);
    }
    return { provider: imageProvider, translated: true };
  }
  if (classifyVision(primary.id, primary.model, cfg.modelVision) !== "vision") {
    throw new Error(
      `model '${primary.model}' cannot inspect images through profile '${routeProfile.id}'; ` +
      "configure a vision-first model or switch to an image-capable conversation model",
    );
  }
  return { provider: primary, translated: false };
}

/** Wrap the main provider with per-turn model routing when `routeModel` is configured: trivial/non-coding
 *  turns go to the alternate (cheap/general) model, real coding/action work stays on the primary. No-op when
 *  routeModel is unset or equals the primary model. routeBaseURL/routeApiKey default to the primary's. */
async function withRouting(
  primary: Provider | null,
  cfg: HaraConfig,
  boundProfileId?: string,
  boundSpaceId?: string,
): Promise<Provider | null> {
  if (!primary || !cfg.routeModel || cfg.routeModel === primary.model) return primary;
  const alt = await buildProvider(cfg, {
    model: cfg.routeModel,
    ...(cfg.routeBaseURL ? { baseURL: cfg.routeBaseURL } : {}),
    ...(cfg.routeApiKey ? { apiKey: cfg.routeApiKey } : {}),
  }, boundProfileId, boundSpaceId);
  return alt ? routingProvider(primary, alt) : primary;
}

/** Build the main provider for a persisted conversation and synchronize the mutable runtime config with
 * that exact identity route. This is deliberately separate from auxiliary overrides: a resumed session's
 * profile/model are primary runtime state, while routing/fallback providers must not overwrite it. */
async function buildSessionBoundRuntime(
  cfg: HaraConfig,
  profileId: string,
  model: string,
  effort?: string | null,
  spaceId?: string,
): Promise<{ provider: Provider; profile: Profile } | null> {
  const profile = profileByIdForConfig(cfg, profileId);
  if (!profile) {
    throw new Error(`session profile '${profileId}' is no longer available; re-enroll that connection or start a new session with an existing profile`);
  }
  // Validate the session's durable model independently of process-local HARA_MODEL. The gateway target
  // resolver intentionally lets the environment override the provider used by this process, but that
  // temporary override must neither conceal a revoked saved pin nor become the session's new durable pin.
  if (profile.kind === "gateway" && profile.availableModels?.length && !profile.availableModels.includes(model)) {
    throw new Error(`model '${model}' is not authorized for organization connection '${profile.id}'`);
  }
  if (profile.kind === "gateway" || effort !== undefined) {
    // `cfg` originates from current connection defaults. A persisted session value (including
    // explicit provider-automatic `null`) must replace it; a company-bound legacy session with no
    // saved value must also clear any Personal default so only Control's default can win.
    cfg.reasoningEffort = (effort ?? undefined) as HaraConfig["reasoningEffort"];
  }
  runtimeProfileBindings.set(cfg, profileId);
  const expectedSpaceId = spaceId ?? spaceIdForProfile(profile);
  assertProfileAudience(cfg, profileId, expectedSpaceId);
  const primary = await buildProvider(
    cfg,
    { model },
    profileId,
    expectedSpaceId,
    effort === null ? null : undefined,
  );
  if (!primary) return null;
  cfg.provider = primary.id as ProviderId;
  cfg.model = primary.model;
  if (profile.kind === "gateway") {
    cfg.baseURL = profile.baseURL || (profile.gatewayUrl ? `${profile.gatewayUrl.replace(/\/+$/, "")}/v1` : undefined);
    cfg.apiKey = undefined;
  } else {
    const target = overrideProviderTarget(resolveByokProviderTarget(cfg, profile, false), { model: primary.model });
    cfg.baseURL = target.baseURL;
    cfg.apiKey = target.apiKey;
  }
  return { provider: (await withRouting(primary, cfg, profileId, expectedSpaceId)) ?? primary, profile };
}

/** Re-resolve a persisted session's mutable local connection and prove it still names the same durable
 * audience. Call before and after every asynchronously built auxiliary provider. A provider created before
 * a later re-enrollment remains frozen to the old credential; a provider created after it is rejected. */
function assertProfileAudience(
  cfg: HaraConfig,
  profileId: string,
  expectedSpaceId: string,
): Profile {
  const profile = profileByIdForConfig(cfg, profileId);
  if (!profile) {
    throw new Error(`session profile '${profileId}' is no longer available; start a new conversation`);
  }
  const currentSpaceId = spaceIdForProfile(profile);
  if (profile.kind === "byok" && expectedSpaceId !== PERSONAL_ID) {
    const enrollment = organizationEnrollmentForSpace(cfg, expectedSpaceId);
    if (!enrollment) {
      throw new Error(
        `session belongs to company Space '${expectedSpaceId}', but no current organization enrollment proves that audience`,
      );
    }
    return profile;
  }
  if (currentSpaceId !== expectedSpaceId) {
    throw new Error(
      `session belongs to Space '${expectedSpaceId}', but connection '${profileId}' now resolves to '${currentSpaceId}'; old history will not be sent across companies`,
    );
  }
  return profile;
}

/** Synchronize and validate the Control-reviewed execution floor before any company turn. Cached policy is
 * not treated as authoritative when Control is reachable through the same gateway used for inference: a
 * newly added deny/approval rule must take effect before the next request, not after a background refresh. */
async function ensureOrganizationExecutionPolicy(
  cfg: HaraConfig,
  profile: Profile,
  expectedSpaceId = spaceIdForProfile(profile),
): Promise<OrganizationExecutionPolicy | null> {
  if (expectedSpaceId === PERSONAL_ID) return null;
  const enrollment = profile.kind === "gateway"
    ? profile
    : organizationEnrollmentForSpace(cfg, expectedSpaceId);
  if (!enrollment) {
    throw new Error(`company Space '${expectedSpaceId}' is no longer enrolled; refusing company inference`);
  }
  const policy = await refreshOrganizationExecutionPolicy(
    enrollment,
    expectedSpaceId,
    () => profileByIdForConfig(cfg, enrollment.id),
  );
  if (profile.kind === "byok" && policy.allowPersonalModelConnections !== true) {
    throw new Error(
      "company policy does not allow personal model connections for this Space; choose a managed company model or ask an administrator",
    );
  }
  return policy;
}

/** One company-aware authorization guard for every built-in Git staging/commit path. The returned closure
 * freezes the first observed bundle revision, then required-syncs before each side effect and enforces both
 * shell denial and the availability of a real approval channel. */
function companyCommitGuard(
  cfg: HaraConfig,
  profile: Profile,
  options: { expectedVersion?: number; approvalChannel: boolean },
): () => Promise<string | null> {
  const expectedSpaceId = spaceIdForProfile(profile);
  let expectedVersion = options.expectedVersion;
  return async (): Promise<string | null> => {
    if (profile.kind !== "gateway") return null;
    try {
      const current = assertProfileAudience(cfg, profile.id, expectedSpaceId);
      const policy = await ensureOrganizationExecutionPolicy(cfg, current, expectedSpaceId);
      if (!policy) return "organization execution policy is unavailable";
      if (expectedVersion === undefined) expectedVersion = policy.version;
      else if (policy.version !== expectedVersion) {
        return `organization policy changed from version ${expectedVersion} to ${policy.version}`;
      }
      if (policy.toolDeny?.includes("bash")) return "organization policy denies shell execution";
      if (policy.requireApprovalForWrites && !options.approvalChannel) {
        return "organization policy requires a live human approval channel";
      }
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };
}

/** Guardian veto model: the CHEAP tier if `routeModel` is configured (a small classifier call, not real
 *  work), else the primary provider. Never blocks startup — any build failure just yields the fallback (and
 *  the guardian fails open when even that is absent). Returns the `{ provider, enabled }` shape runAgent wants,
 *  or undefined when guardian is off in config/env. */
async function buildGuardian(
  cfg: HaraConfig,
  primary: Provider | null,
  boundProfileId?: string,
  boundSpaceId?: string,
): Promise<{ provider: Provider | null; enabled: boolean } | undefined> {
  if (cfg.guardian === "off") return undefined;
  let gp: Provider | null = primary;
  if (cfg.routeModel && cfg.routeModel !== primary?.model) {
    gp = (await buildProvider(cfg, {
      model: cfg.routeModel,
      ...(cfg.routeBaseURL ? { baseURL: cfg.routeBaseURL } : {}),
      ...(cfg.routeApiKey ? { apiKey: cfg.routeApiKey } : {}),
    }, boundProfileId, boundSpaceId)) ?? primary;
  }
  return { provider: gp, enabled: true };
}

function authHint(cfg: HaraConfig, boundProfile?: Profile | null): string {
  const ap = boundProfile ?? profileForConfig(cfg).profile;
  if (ap.kind === "gateway") {
    if (deviceTokenExpired(ap.tokenExpiresAt)) {
      return `Active profile '${ap.id}' has expired organization access — re-enroll with \`hara profile add ${ap.id} --gateway ${ap.gatewayUrl || "<url>"} --code <code>\`.`;
    }
    return `Active profile '${ap.id}' is a gateway profile but is missing deviceToken — re-enroll with \`hara profile add ${ap.id} --gateway <url> --code <code>\`.`;
  }
  const target = resolveByokProviderTarget(cfg, ap, false);
  const provider = target.provider;
  if (provider === "qwen-oauth") return `Run ${c.bold("hara login qwen")} to authenticate.`;
  if (providerIsLocal(provider)) {
    return `Start ${provider === "ollama" ? "Ollama" : "LM Studio"} at ${c.bold(target.baseURL ?? "its local endpoint")}, then choose an installed model.`;
  }
  return `Set ${c.bold(providerEnvKey(provider))} (or ${c.bold("HARA_API_KEY")}), or run ${c.bold("hara setup")}.`;
}

function personalReasoningEffortLevels(
  provider: ProviderId,
  baseURL: string | undefined,
  model: string,
): NonNullable<HaraConfig["reasoningEffort"]>[] {
  return levelsFor(
    resolvePlatform(provider, baseURL ?? providerDefaultBaseURL(provider), undefined, model).reasoning,
    model,
  ).filter((effort): effort is NonNullable<HaraConfig["reasoningEffort"]> => !!effort);
}

function providerSettingsCatalog() {
  return providerCatalog().map((provider) => ({
    ...provider,
    knownVisionModels: [...new Set([
      ...(provider.knownModels ?? []),
      provider.defaultModel,
    ])].filter((model) => classifyVision(provider.id, model) === "vision"),
    ...(provider.knownModels?.length
      ? {
          knownModelEntries: provider.knownModels.map((model) => ({
            id: model,
            effortLevels: personalReasoningEffortLevels(
              provider.id,
              provider.defaultBaseURL,
              model,
            ),
          })),
        }
      : {}),
  }));
}

function gatewayReasoningEffortLevels(profile: Profile, model: string): NonNullable<HaraConfig["reasoningEffort"]>[] {
  const perModel = profile.modelCapabilities?.find((capability) => capability.model === model)?.thinkingEfforts;
  const advertised = perModel ?? profile.thinkingEfforts ?? [];
  return advertised.filter((effort): effort is NonNullable<HaraConfig["reasoningEffort"]> => (
    REASONING_EFFORTS.includes(effort as NonNullable<HaraConfig["reasoningEffort"]>)
  ));
}

function gatewayDefaultReasoningEffort(
  profile: Profile,
  model: string,
): HaraConfig["reasoningEffort"] {
  const effort = profile.defaultReasoningEffort;
  return effort && gatewayReasoningEffortLevels(profile, model).includes(
    effort as NonNullable<HaraConfig["reasoningEffort"]>,
  )
    ? effort as NonNullable<HaraConfig["reasoningEffort"]>
    : undefined;
}

function assertPersonalReasoningEffort(
  provider: ProviderId,
  baseURL: string | undefined,
  model: string,
  effort: HaraConfig["reasoningEffort"],
): void {
  if (effort === undefined) return;
  const levels = personalReasoningEffortLevels(provider, baseURL, model);
  if (!levels.includes(effort)) {
    throw new Error(`model '${model}' does not support reasoning effort '${effort}' on this connection`);
  }
}

function providerEnvironmentOverride(): boolean {
  return !!(
    process.env.HARA_PROVIDER ||
    process.env.HARA_MODEL ||
    process.env.HARA_BASE_URL
  );
}

function personalProviderConnectionsSnapshot(
  live: HaraConfig,
  resolution: ActiveResolution,
  catalog: ReturnType<typeof providerCatalog>,
) {
  const personal = profileByIdForConfig(live, PERSONAL_ID)!;
  return listProfiles()
    .filter((candidate) => candidate.kind === "byok")
    .map((candidate) => candidate.id === PERSONAL_ID ? personal : candidate)
    .filter((candidate) => !!candidate.provider && candidate.provider !== "hara-gateway")
    .map((candidate) => {
      // A card describes one persisted route. Provider ID is deliberately not a uniqueness key: two
      // accounts at the same endpoint remain separate because their profile IDs and credentials differ.
      const target = resolveByokProviderTarget(live, candidate, false, {});
      const entry = catalog.find((item) => item.id === target.provider)!;
      const keyConfigured = providerIsLocal(target.provider)
        || (target.provider === "qwen-oauth" ? loadQwenToken() !== null : !!target.apiKey);
      const reasoningStyle = resolvePlatform(
        target.provider,
        target.baseURL ?? providerDefaultBaseURL(target.provider),
        undefined,
        target.model,
      ).reasoning;
      const effortLevels = levelsFor(reasoningStyle, target.model)
        .filter((effort): effort is NonNullable<typeof effort> => !!effort);
      const savedEffort = candidate.id === PERSONAL_ID ? live.reasoningEffort : candidate.reasoningEffort;
      const reasoningEffort = savedEffort
        ? normalizeEffort(reasoningStyle, target.model, savedEffort as NonNullable<HaraConfig["reasoningEffort"]>)
        : undefined;
      const raw = candidate.id === PERSONAL_ID ? readRawConfig() : null;
      const canonicalConfigured = candidate.id !== PERSONAL_ID
        || ["provider", "model", "baseURL", "apiKey"].some((key) => raw && Object.hasOwn(raw, key));
      return {
        id: candidate.id,
        label: candidate.label || (candidate.id === PERSONAL_ID ? entry.label : candidate.id),
        provider: target.provider,
        model: target.model,
        ...(target.baseURL ? { baseURL: target.baseURL } : {}),
        location: entry.location as "cloud" | "local",
        auth: entry.auth as "api-key" | "oauth" | "none",
        keyConfigured,
        authenticated: keyConfigured,
        active: resolution.id === candidate.id,
        legacyPersonal: candidate.id === PERSONAL_ID,
        removable: candidate.id !== PERSONAL_ID || canonicalConfigured,
        ...(reasoningEffort ? { reasoningEffort } : {}),
        effortLevels,
        ...(target.apiKey ? { keyHint: maskKey(target.apiKey) } : {}),
        ...(candidate.createdAt ? { createdAt: candidate.createdAt } : {}),
      };
    });
}

const visionEnvironmentOverride = (): boolean => Boolean(
  process.env.HARA_VISION_MODEL?.trim()
  || process.env.HARA_VISION_SOURCE?.trim()
  || process.env.HARA_VISION_PROVIDER?.trim()
  || process.env.HARA_VISION_BASE_URL?.trim()
  || process.env.HARA_VISION_API_KEY?.trim(),
);

interface ConnectionVisionRoute {
  model?: string;
  source: "current" | "custom";
  provider?: ProviderId;
  baseURL?: string;
  apiKey?: string;
}

/** Releases before provider-bound vision settings stored an independent OpenAI-compatible endpoint and
 * key without the adapter ID. Recover those routes from an exact official endpoint when possible and
 * otherwise use the generic OpenAI-compatible adapter. This is a read-time compatibility path only;
 * the next explicit save persists the selected adapter. */
function visionProviderForRoute(
  cfg: HaraConfig,
  route: ConnectionVisionRoute,
  currentProvider: string,
): ProviderId {
  if (route.source === "current") return isProviderId(currentProvider) ? currentProvider : "openai";
  if (route.provider) return route.provider;
  return resolveByokProviderTarget(cfg, {
    id: "legacy-vision-route",
    kind: "byok",
    provider: "openai",
    baseURL: route.baseURL,
    apiKey: route.apiKey,
    defaultModel: route.model,
  }, false, {}).provider;
}

/** Read vision routing from the exact model connection. Personal intentionally keeps using config.json;
 * company and legacy named connections own independent profile fields. Explicit HARA_VISION_* values
 * overlay only the fields they name and never make an organization's route inherit Personal settings. */
function visionRouteForProfile(live: HaraConfig, profile: Profile): ConnectionVisionRoute {
  const personal = profile.id === PERSONAL_ID;
  const base: ConnectionVisionRoute = personal
    ? {
        model: live.visionModel,
        source: live.visionSource,
        provider: live.visionProvider,
        baseURL: live.visionBaseURL,
        apiKey: live.visionApiKey,
      }
    : {
        model: profile.visionModel,
        source: profile.visionSource ?? "current",
        provider: profile.visionProvider,
        baseURL: profile.visionBaseURL,
        apiKey: profile.visionApiKey,
      };
  if (personal || !visionEnvironmentOverride()) {
    return profile.kind === "gateway" ? { ...base, source: "current" } : base;
  }
  const customRouteOverridden = Boolean(
    process.env.HARA_VISION_SOURCE?.trim()
    || process.env.HARA_VISION_PROVIDER?.trim()
    || process.env.HARA_VISION_BASE_URL?.trim()
    || process.env.HARA_VISION_API_KEY?.trim(),
  );
  const route: ConnectionVisionRoute = {
    model: process.env.HARA_VISION_MODEL?.trim() ? live.visionModel : base.model,
    source: customRouteOverridden ? live.visionSource : base.source,
    provider: process.env.HARA_VISION_PROVIDER?.trim() ? live.visionProvider : base.provider,
    baseURL: process.env.HARA_VISION_BASE_URL?.trim() ? live.visionBaseURL : base.baseURL,
    apiKey: process.env.HARA_VISION_API_KEY?.trim() ? live.visionApiKey : base.apiKey,
  };
  return profile.kind === "gateway" ? { ...route, source: "current" } : route;
}

function visionSettingsSnapshot(live: HaraConfig, profile: Profile) {
  const expectedSpaceId = spaceIdForProfile(profile);
  const authorizedModels = authorizedVisionModelsForRoute(live, profile, expectedSpaceId);
  const route = visionRouteForProfile(live, profile);
  const source = route.source;
  const currentTarget = profile.kind === "gateway"
    ? { provider: "hara-gateway" as const, model: profile.model || profile.defaultModel || live.model }
    : resolveByokProviderTarget(live, profile, false, {});
  const provider = visionProviderForRoute(live, route, currentTarget.provider);
  const providerEntry = providerSettingsCatalog().find((candidate) => candidate.id === provider);
  const availableModels = [...new Set([
    ...(authorizedModels ?? providerEntry?.knownVisionModels ?? []),
    ...(source === "current" && classifyVision(provider, currentTarget.model, live.modelVision) === "vision"
      ? [currentTarget.model]
      : []),
    ...(route.model && classifyVision(provider, route.model, live.modelVision) === "vision"
      ? [route.model]
      : []),
  ])].filter((model) => classifyVision(provider, model, live.modelVision) === "vision");
  const modelAuthorized = !route.model
    || (
      visionSidecarAuthorized(route.model, authorizedModels)
      && classifyVision(provider, route.model, live.modelVision) === "vision"
    );
  return {
    enabled: Boolean(route.model),
    source,
    provider,
    ...(route.model ? { model: route.model } : {}),
    ...(source === "custom" && route.baseURL ? { baseURL: route.baseURL } : {}),
    apiKeyConfigured: source === "custom" && Boolean(route.apiKey),
    usesManagedCredential: profile.kind === "gateway",
    editable: !visionEnvironmentOverride(),
    authorized: modelAuthorized,
    availableModels,
    ...(authorizedModels ? { authorizedModels: [...authorizedModels] } : {}),
  };
}

function normalizeVisionBaseURL(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("vision endpoint must be a valid HTTP(S) URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("vision endpoint must be an HTTP(S) URL without embedded credentials");
  }
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

async function saveVisionSettings(
  input: {
    enabled: boolean;
    source?: "current" | "custom";
    provider?: string;
    model?: string;
    baseURL?: string;
    apiKey?: string;
    clearApiKey?: boolean;
  },
  targetCwd: string,
) {
  if (visionEnvironmentOverride()) {
    throw new Error("vision routing is overridden by HARA_VISION_* environment variables; remove the override before editing Settings");
  }
  const live = loadConfig({ cwd: targetCwd });
  const profile = profileForConfig(live).profile;
  if (!input.enabled) {
    const cleared = setProfileVisionSettings(profile.id, undefined);
    if (!cleared.ok) throw new Error(cleared.reason);
    return providerSettingsSnapshot(targetCwd);
  }
  const model = input.model?.trim();
  if (!model || model.length > 200 || /[\u0000-\u001f\u007f]/.test(model)) {
    throw new Error("vision-first model must be a 1-200 character model ID");
  }
  const existingRoute = visionRouteForProfile(live, profile);
  const source = profile.kind === "gateway" ? "current" : input.source ?? existingRoute.source;
  if (source !== "current" && source !== "custom") {
    throw new Error("vision source must be current or custom");
  }
  if (profile.kind === "gateway" && input.source === "custom") {
    throw new Error("company vision routing must reuse the managed provider connection");
  }
  const authorizedModels = authorizedVisionModelsForRoute(live, profile, spaceIdForProfile(profile));
  if (!visionSidecarAuthorized(model, authorizedModels)) {
    throw new Error(`vision-first model '${model}' is not authorized for the active company connection`);
  }
  if (profile.kind === "gateway" && (input.baseURL?.trim() || input.apiKey?.trim())) {
    throw new Error("company vision routing uses the managed gateway credential and does not accept a separate endpoint or key");
  }
  const currentTarget = profile.kind === "gateway"
    ? { provider: "hara-gateway" as const }
    : resolveByokProviderTarget(live, profile, false, {});
  let provider: ProviderId | undefined;
  let baseURL: string | undefined;
  let apiKey: string | undefined;
  if (source === "custom") {
    if (!isProviderId(input.provider) || input.provider === "hara-gateway") {
      throw new Error("a custom vision route requires a supported provider/protocol adapter");
    }
    const candidate = normalizePersonalProviderConfig({
      provider: input.provider,
      model,
      baseURL: input.baseURL,
      apiKey: input.apiKey,
      clearApiKey: input.clearApiKey,
    });
    provider = candidate.provider;
    baseURL = candidate.baseURL;
    apiKey = candidate.apiKey;
    const previousProvider = visionProviderForRoute(live, existingRoute, currentTarget.provider);
    const sameRoute = existingRoute.source === "custom"
      && previousProvider === provider
      && normalizeVisionBaseURL(existingRoute.baseURL) === normalizeVisionBaseURL(baseURL);
    if (!apiKey && !input.clearApiKey && sameRoute) apiKey = existingRoute.apiKey;
    if (providerRequiresApiKey(provider) && !apiKey) {
      throw new Error("a custom vision interface requires its own API key; use the current-provider mode to reuse the active key");
    }
  }
  const capabilityProvider = source === "custom" ? provider! : currentTarget.provider;
  if (classifyVision(capabilityProvider, model, live.modelVision) !== "vision") {
    throw new Error(`model '${model}' is not confirmed to accept image input`);
  }
  if (profile.kind !== "gateway") {
    const providerEntry = providerSettingsCatalog().find((candidate) => candidate.id === capabilityProvider)!;
    const currentPersonalTarget = source === "current"
      ? resolveByokProviderTarget(live, profile, false, {})
      : undefined;
    const candidate = source === "custom"
      ? {
          provider: provider!,
          model,
          ...(baseURL ? { baseURL } : {}),
          ...(apiKey ? { apiKey } : {}),
        }
      : {
          provider: currentPersonalTarget!.provider,
          model,
          ...(currentPersonalTarget!.baseURL ? { baseURL: currentPersonalTarget!.baseURL } : {}),
          ...(currentPersonalTarget!.apiKey ? { apiKey: currentPersonalTarget!.apiKey } : {}),
        };
    const tested = visionOnlyTestResult(
      await testProviderSettingsCandidate(candidate, { reusePersonalApiKey: false }),
      capabilityProvider,
      providerEntry.knownVisionModels,
      live.modelVision,
    );
    if (!tested.ok || !tested.models.includes(model)) {
      throw new Error(tested.error || `the vision connection did not verify model '${model}'`);
    }
  }
  const saved = setProfileVisionSettings(profile.id, {
    model,
    source,
    ...(source === "custom" && provider ? { provider } : {}),
    ...(source === "custom" && baseURL ? { baseURL } : {}),
    ...(source === "custom" && apiKey ? { apiKey } : {}),
  });
  if (!saved.ok) throw new Error(saved.reason);
  return providerSettingsSnapshot(targetCwd);
}

function providerSettingsSnapshot(targetCwd: string) {
  const live = loadConfig({ cwd: targetCwd });
  const { profile, resolution } = profileForConfig(live);
  const catalog = providerSettingsCatalog();
  const connections = personalProviderConnectionsSnapshot(live, resolution, catalog);
  const switchLocked = resolution.source === "flag" || resolution.source === "env" || resolution.source === "pin";

  if (profile.kind === "gateway") {
    const entry = catalog.find((candidate) => candidate.id === "hara-gateway")!;
    const tokenExpired = deviceTokenExpired(profile.tokenExpiresAt);
    const model = process.env.HARA_MODEL || effectiveModel(profile) || live.model;
    const effortLevels = gatewayReasoningEffortLevels(profile, model);
    const reasoningEffort = gatewayDefaultReasoningEffort(profile, model);
    return {
      current: {
        provider: "hara-gateway",
        model,
        baseURL: profile.baseURL || (profile.gatewayUrl ? `${profile.gatewayUrl.replace(/\/+$/, "")}/v1` : undefined),
        location: entry.location,
        auth: entry.auth,
        keyConfigured: !!profile.deviceToken,
        authenticated: !!profile.gatewayUrl && !!profile.deviceToken && !tokenExpired,
        profileId: profile.id,
        profileKind: profile.kind,
        profileSource: resolution.source,
        editable: false,
        effortLevels,
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(profile.tokenExpiresAt ? { tokenExpiresAt: profile.tokenExpiresAt, tokenExpired } : {}),
      },
      providers: catalog,
      connections,
      switchLocked,
      vision: visionSettingsSnapshot(live, profile),
    };
  }

  const target = resolveByokProviderTarget(live, profile, false);
  const provider = target.provider;
  const entry = catalog.find((candidate) => candidate.id === provider) ?? catalog[0];
  const baseURL = target.baseURL;
  const model = target.model;
  const apiKey = target.apiKey;
  const environmentOverride = providerEnvironmentOverride();
  const keyConfigured =
    providerIsLocal(provider) ||
    (provider === "qwen-oauth" ? loadQwenToken() !== null : !!apiKey);
  const reasoningStyle = resolvePlatform(
    provider,
    baseURL ?? providerDefaultBaseURL(provider),
    undefined,
    model,
  ).reasoning;
  const effortLevels = levelsFor(reasoningStyle, model)
    .filter((effort): effort is NonNullable<typeof effort> => !!effort);
  const savedReasoningEffort = profile.id === PERSONAL_ID
    ? live.reasoningEffort
    : profile.reasoningEffort as HaraConfig["reasoningEffort"];
  const reasoningEffort = savedReasoningEffort
    ? normalizeEffort(reasoningStyle, model, savedReasoningEffort)
    : undefined;

  return {
    current: {
      provider,
      model,
      ...(baseURL ? { baseURL } : {}),
      location: entry.location,
      auth: entry.auth,
      keyConfigured,
      authenticated: keyConfigured,
      profileId: profile.id,
      profileKind: profile.kind,
      profileSource: resolution.source,
      editable: !environmentOverride,
      ...(reasoningEffort ? { reasoningEffort } : {}),
      effortLevels,
      ...(environmentOverride ? { environmentOverride: true } : {}),
    },
    providers: catalog,
    connections,
    switchLocked,
    vision: visionSettingsSnapshot(live, profile),
  };
}

function cleanNamedProviderConnectionId(value: string): string {
  const id = value.trim();
  if (!isValidProfileId(id) || id === PERSONAL_ID) {
    throw new Error("named connection id must use 1-64 letters, numbers, dots, underscores, or dashes and cannot be 'personal'");
  }
  return id;
}

function cleanNamedProviderConnectionLabel(value: string): string {
  const label = value.trim();
  if (!label || label.length > 80 || /[\u0000-\u001f\u007f]/.test(label)) {
    throw new Error("connection name must be 1-80 printable characters");
  }
  return label;
}

async function createNamedProviderConnection(
  input: {
    id: string;
    label: string;
    provider: string;
    model: string;
    baseURL?: string;
    apiKey?: string;
    clearApiKey?: boolean;
    reasoningEffort?: string;
    clearReasoningEffort?: boolean;
    activate?: boolean;
  },
  targetCwd: string,
) {
  const id = cleanNamedProviderConnectionId(input.id);
  const label = cleanNamedProviderConnectionLabel(input.label);
  if (getProfile(id)) {
    throw new Error(`connection '${id}' already exists; choose a new name instead of overwriting it`);
  }
  if (!isProviderId(input.provider) || input.provider === "hara-gateway") {
    throw new Error("provider is not a configurable personal provider");
  }
  const resolution = resolveActive(targetCwd);
  const switchLocked = resolution.source === "flag" || resolution.source === "env" || resolution.source === "pin";
  if (input.activate && (switchLocked || providerEnvironmentOverride())) {
    throw new Error("the active connection is locked by a flag, environment variable, or project pin; save without switching or remove that override first");
  }
  const normalized = normalizePersonalProviderConfig({
    provider: input.provider,
    model: input.model,
    baseURL: input.baseURL,
    apiKey: input.apiKey,
    clearApiKey: input.clearApiKey,
    reasoningEffort: input.reasoningEffort as HaraConfig["reasoningEffort"],
    clearReasoningEffort: input.clearReasoningEffort,
  });
  assertPersonalReasoningEffort(
    normalized.provider,
    normalized.baseURL,
    normalized.model,
    normalized.reasoningEffort,
  );
  if (providerRequiresApiKey(normalized.provider) && !normalized.apiKey) {
    throw new Error("a new API key is required for a named cloud connection");
  }
  const now = new Date().toISOString();
  const added = addProfile({
    id,
    kind: "byok",
    label,
    provider: normalized.provider,
    apiKey: normalized.apiKey,
    baseURL: normalized.baseURL,
    defaultModel: normalized.model,
    ...(normalized.reasoningEffort ? { reasoningEffort: normalized.reasoningEffort } : {}),
    createdAt: now,
    updatedAt: now,
  }, { activate: input.activate === true });
  if (!added.ok) throw new Error(added.reason);
  return providerSettingsSnapshot(targetCwd);
}

function useNamedProviderConnection(inputId: string, targetCwd: string) {
  const id = inputId.trim();
  if (!isValidProfileId(id)) throw new Error("invalid personal connection id");
  const resolution = resolveActive(targetCwd);
  const target = getProfile(id);
  if (!target || target.kind !== "byok") throw new Error("personal connection was not found");
  if (
    resolution.source === "flag"
    || resolution.source === "env"
    || resolution.source === "pin"
    || providerEnvironmentOverride()
  ) {
    throw new Error("the active connection is locked by a flag, environment variable, or project pin; remove that override before switching");
  }
  const switched = useProfile(target.id);
  if (!switched.ok) throw new Error(switched.reason);
  return providerSettingsSnapshot(targetCwd);
}

function removeNamedProviderConnection(inputId: string, targetCwd: string) {
  if (inputId.trim() === PERSONAL_ID) {
    if (providerEnvironmentOverride()) {
      throw new Error("provider/model/base URL is overridden by HARA_* environment variables; remove the override before clearing Personal");
    }
    const live = loadConfig({ cwd: targetCwd });
    const personal = profileByIdForConfig(live, PERSONAL_ID)!;
    const target = resolveByokProviderTarget(live, personal, false, {});
    const credentialEnvKey = providerEnvKey(target.provider);
    if (
      process.env.HARA_API_KEY?.trim()
      || (credentialEnvKey && process.env[credentialEnvKey]?.trim())
    ) {
      throw new Error(`the Personal credential is supplied by ${process.env.HARA_API_KEY?.trim() ? "HARA_API_KEY" : credentialEnvKey}; remove that environment variable before clearing the connection`);
    }
    clearPersonalProviderConfig();
    syncStoredPersonalProfile();
    return providerSettingsSnapshot(targetCwd);
  }
  const id = cleanNamedProviderConnectionId(inputId);
  const target = getProfile(id);
  if (!target || target.kind !== "byok") throw new Error("personal connection was not found");
  const resolution = resolveActive(targetCwd);
  if (
    resolution.id === id
    && (resolution.source === "flag" || resolution.source === "env" || resolution.source === "pin")
  ) {
    throw new Error("this connection is selected by a flag, environment variable, or project pin; remove that override before deleting it");
  }
  const removed = removeProfile(id);
  if (!removed.ok) throw new Error(removed.reason);
  return providerSettingsSnapshot(targetCwd);
}

function organizationAccessState(profile: Profile, now = Date.now()): "valid" | "permanent" | "expiring" | "expired" | "legacy" | "invalid" {
  if (!profile.deviceToken || !profile.gatewayUrl) return "invalid";
  if (profile.tokenNeverExpires) return "permanent";
  if (!profile.tokenExpiresAt) return "legacy";
  const expiry = Date.parse(profile.tokenExpiresAt);
  if (!Number.isFinite(expiry)) return "invalid";
  if (expiry <= now) return "expired";
  return expiry - now <= 24 * 60 * 60_000 ? "expiring" : "valid";
}

function publicGatewayIdentity(value: string | undefined): { gatewayUrl: string; gatewayHost: string } {
  try {
    const url = new URL(value || "");
    return { gatewayUrl: url.origin, gatewayHost: url.host };
  } catch {
    return { gatewayUrl: "", gatewayHost: "invalid endpoint" };
  }
}

function organizationConnectionsSnapshot(targetCwd: string) {
  const resolution = resolveActive(targetCwd);
  const connections = listProfiles()
    .filter((profile) => profile.kind === "gateway")
    .map((profile) => {
      const endpoint = publicGatewayIdentity(profile.gatewayUrl);
      const model = effectiveModel(profile) || "";
      const reasoningEffort = gatewayDefaultReasoningEffort(profile, model);
      return {
        id: profile.id,
        spaceId: spaceIdForProfile(profile),
        label: profile.label || profile.id,
        ...(profile.tenantId ? { tenantId: profile.tenantId } : {}),
        ...(profile.tenantName ? { tenantName: profile.tenantName } : {}),
        active: profile.id === resolution.id,
        ...endpoint,
        model,
        ...(reasoningEffort ? { reasoningEffort } : {}),
        effortLevels: gatewayReasoningEffortLevels(profile, model),
        ...(profile.availableModels?.length ? { availableModels: [...profile.availableModels] } : {}),
        ...(profile.enrolledAt ? { enrolledAt: profile.enrolledAt } : {}),
        ...(profile.tokenExpiresAt ? { expiresAt: profile.tokenExpiresAt } : {}),
        ...(profile.tokenNeverExpires ? { tokenNeverExpires: true } : {}),
        ...(profile.serviceBindings?.length
          ? {
              services: profile.serviceBindings.map((binding) => ({
                service: binding.service,
                mode: binding.mode,
                accountRegion: binding.accountRegion,
                host: serviceBindingHost(binding.apiOrigin),
                status: binding.status,
                capabilitiesVersion: binding.capabilitiesVersion,
                configVersion: binding.configVersion,
              })),
            }
          : {}),
        accessState: organizationAccessState(profile),
      };
    });
  return {
    activeId: resolution.id,
    activeSource: resolution.source,
    switchLocked: resolution.source === "flag" || resolution.source === "env" || resolution.source === "pin",
    connections,
  };
}

/** A provider profile is a route; a Space is the durable Personal/company data boundary presented by
 * Desktop. Multiple connections that resolve to the same Control tenant intentionally collapse to one
 * company Space so reconnecting cannot fork identity or mix history. */
function spaceDirectorySnapshot(targetCwd: string) {
  const resolution = resolveActive(targetCwd);
  const profiles = listProfiles();
  const activeProfile = profiles.find((profile) => profile.id === resolution.id)
    ?? profiles.find((profile) => profile.id === PERSONAL_ID)!;
  const activeSpaceId = spaceIdForProfile(activeProfile);
  const organizationSpaces = new Map<string, { profile: Profile; profileIds: string[] }>();
  for (const profile of profiles) {
    if (profile.kind !== "gateway") continue;
    const spaceId = spaceIdForProfile(profile);
    const existing = organizationSpaces.get(spaceId);
    if (!existing) {
      organizationSpaces.set(spaceId, { profile, profileIds: [profile.id] });
      continue;
    }
    existing.profileIds.push(profile.id);
    if (profile.id === resolution.id) existing.profile = profile;
  }
  const personalRoute = activeProfile.kind === "byok" ? activeProfile : profiles.find((profile) => profile.id === PERSONAL_ID)!;
  const personalProfileIds = profiles.filter((profile) => profile.kind === "byok").map((profile) => profile.id);
  const spaces = [
    {
      id: PERSONAL_ID,
      name: personalRoute.label || "Personal",
      kind: "personal" as const,
      profileId: personalRoute.id,
      profileIds: personalProfileIds,
      active: activeSpaceId === PERSONAL_ID,
      authoritative: true,
      agentProfilePermission: "edit" as const,
    },
    ...[...organizationSpaces.entries()].map(([spaceId, entry]) => ({
      id: spaceId,
      name: entry.profile.tenantName || entry.profile.label || entry.profile.id,
      kind: "organization" as const,
      profileId: entry.profile.id,
      profileIds: entry.profileIds,
      active: spaceId === activeSpaceId,
      ...(entry.profile.tenantId ? { tenantId: entry.profile.tenantId } : {}),
      authoritative: Boolean(entry.profile.tenantId),
      // Until Control returns a membership role/capability, company Agent profiles fail closed as view-only.
      agentProfilePermission: "view" as const,
      accessState: organizationAccessState(entry.profile),
      // A missing or stale bundle is intentionally shown as blocked. The inference path still performs a
      // required fresh Control sync before every personal-key turn; this field is presentation only.
      personalModelConnections: loadOrganizationExecutionPolicy(spaceId)?.allowPersonalModelConnections === true
        ? "allowed" as const
        : "blocked" as const,
    })),
  ];
  return {
    activeId: activeSpaceId,
    activeProfileId: activeProfile.id,
    activeSource: resolution.source,
    switchLocked: resolution.source === "flag" || resolution.source === "env" || resolution.source === "pin",
    spaces,
  };
}

function useSpaceConnection(spaceId: string, targetCwd: string) {
  const current = spaceDirectorySnapshot(targetCwd);
  if (current.switchLocked) {
    throw new Error("the active Space is locked by a flag, environment variable, or project pin; remove that override before switching");
  }
  const target = current.spaces.find((space) => space.id === spaceId);
  if (!target) throw new Error("Space was not found");
  if (target.kind === "organization" && (target.accessState === "expired" || target.accessState === "invalid")) {
    throw new Error("this company connection is unavailable; re-enroll it in AI & Models before switching");
  }
  const profileId = target.kind === "personal" ? PERSONAL_ID : target.profileId;
  const switched = useProfile(profileId);
  if (!switched.ok) throw new Error(switched.reason);
  return spaceDirectorySnapshot(targetCwd);
}

function assertOrganizationId(value: string): string {
  const id = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id) || id === PERSONAL_ID) {
    throw new Error("invalid organization connection id");
  }
  return id;
}

function deskOrganizationIdentity(profile: Profile): DeskOrganizationIdentity {
  if (profile.kind !== "gateway" || !profile.gatewayUrl) {
    throw new DeskClientError("NOT_CONFIGURED", "organization connection is not available");
  }
  return {
    profileId: profile.id,
    gatewayUrl: profile.gatewayUrl,
    ...(profile.deviceId ? { deviceId: profile.deviceId } : {}),
    ...(profile.enrolledAt ? { enrolledAt: profile.enrolledAt } : {}),
  };
}

function assertDeskOrganizationProfile(value: string): DeskOrganizationIdentity {
  const id = assertOrganizationId(value);
  const profile = getProfile(id);
  if (!profile || profile.kind !== "gateway") {
    throw new DeskClientError("NOT_CONFIGURED", `organization connection '${id}' was not found`);
  }
  return deskOrganizationIdentity(profile);
}

async function fetchDeskSnapshotForProfile(
  profileId: string,
  state?: DeskTaskState,
) {
  const identity = assertDeskOrganizationProfile(profileId);
  const result = await fetchDeskSnapshot(identity, state);
  const current = assertDeskOrganizationProfile(profileId);
  if (!deskOrganizationIdentityMatches(identity, current)) {
    throw new DeskClientError(
      "CONFLICT",
      "organization connection changed during the Desk read",
    );
  }
  return result;
}

async function fetchDeskTaskForProfile(profileId: string, taskId: string) {
  const identity = assertDeskOrganizationProfile(profileId);
  const result = await fetchDeskTask(identity, taskId);
  const current = assertDeskOrganizationProfile(profileId);
  if (!deskOrganizationIdentityMatches(identity, current)) {
    throw new DeskClientError(
      "CONFLICT",
      "organization connection changed during the Desk read",
    );
  }
  return result;
}

async function testProviderSettingsCandidate(input: {
  provider: string;
  model: string;
  baseURL?: string;
  apiKey?: string;
  clearApiKey?: boolean;
  reasoningEffort?: string;
  clearReasoningEffort?: boolean;
}, options: { reusePersonalApiKey?: boolean } = {}): Promise<{
  ok: boolean;
  models: string[];
  entries: Array<{
    id: string;
    providerId: string;
    effortLevels: string[];
    attachmentCapabilities: ReturnType<typeof effectiveAttachmentCapabilities>;
  }>;
  error?: string;
}> {
  if (!isProviderId(input.provider) || input.provider === "hara-gateway") {
    throw new Error("provider is not a configurable personal provider");
  }
  const candidate = normalizePersonalProviderConfig({
    provider: input.provider,
    model: input.model,
    baseURL: input.baseURL,
    apiKey: input.apiKey,
    clearApiKey: input.clearApiKey,
    reasoningEffort: input.reasoningEffort as HaraConfig["reasoningEffort"],
    clearReasoningEffort: input.clearReasoningEffort,
  });
  assertPersonalReasoningEffort(
    candidate.provider,
    candidate.baseURL,
    candidate.model,
    candidate.reasoningEffort,
  );
  const raw = readRawConfig();
  const apiKey = options.reusePersonalApiKey === false
    ? candidate.apiKey
    : reusablePersonalProviderApiKey(candidate, raw);
  if (providerRequiresApiKey(candidate.provider) && !apiKey) {
    return {
      ok: false,
      models: [],
      entries: [],
      error: "A new API key is required when the provider or endpoint changes",
    };
  }
  const configuredProxy =
    typeof raw.proxy === "string" && raw.proxy.trim() ? raw.proxy.trim() : undefined;
  const models = await listModels(
    candidate.baseURL,
    apiKey ?? "",
    createModelFetch(configuredProxy),
  );
  const entries = [...new Set([candidate.model, ...models])].map((model) => ({
    id: model,
    providerId: candidate.provider,
    effortLevels: levelsFor(
      resolvePlatform(
        candidate.provider,
        candidate.baseURL ?? providerDefaultBaseURL(candidate.provider),
        undefined,
        model,
      ).reasoning,
      model,
    ).filter((effort): effort is NonNullable<typeof effort> => !!effort),
    attachmentCapabilities: effectiveAttachmentCapabilities(candidate.provider, model),
  }));
  const probeModel =
    providerIsLocal(candidate.provider) &&
    models.length > 0 &&
    !models.includes(candidate.model) &&
    (candidate.model === "local-model" || candidate.model === "qwen3")
      ? models[0]
      : candidate.model;
  const provider = await createProviderForTarget(
    {
      provider: candidate.provider,
      apiKey,
      model: probeModel,
      baseURL: candidate.baseURL,
      ...(configuredProxy ? { proxy: configuredProxy } : {}),
    },
    candidate.reasoningEffort,
  );
  if (!provider) {
    const error = candidate.provider === "qwen-oauth"
      ? "Qwen browser sign-in is not complete; run `hara login qwen` first"
      : "provider is not authenticated";
    return { ok: false, models, entries, error };
  }
  const result = await boundedProviderTurn(
    provider,
    {
      system: "This is a connection check. Reply with the single word ok.",
      history: [{ role: "user", content: "ok" }],
      tools: [],
      onText: () => {},
    },
    { timeoutMs: 12_000, label: "provider connection test" },
  );
  if (result.stop === "error") {
    return {
      ok: false,
      models,
      entries,
      error: redactKnownSecrets(
        result.errorMsg || "provider connection test failed",
        [apiKey],
      ).text.slice(0, 500),
    };
  }
  return { ok: true, models, entries };
}

function visionOnlyTestResult(
  result: Awaited<ReturnType<typeof testProviderSettingsCandidate>>,
  provider: string,
  extraModels: readonly string[],
  overrides: HaraConfig["modelVision"],
) {
  const models = [...new Set([...result.models, ...extraModels])]
    .filter((model) => classifyVision(provider, model, overrides) === "vision");
  const byId = new Map(result.entries.map((entry) => [entry.id, entry]));
  const entries = models.map((model) => byId.get(model) ?? {
    id: model,
    providerId: provider,
    effortLevels: [],
    attachmentCapabilities: effectiveAttachmentCapabilities(provider, model, overrides),
  });
  return {
    ok: result.ok && models.length > 0,
    models,
    entries,
    ...(result.error
      ? { error: result.error }
      : models.length === 0
        ? { error: "This connection did not expose any model confirmed to accept image input" }
        : {}),
  };
}

async function testVisionSettingsCandidate(
  input: {
    source: "current" | "custom";
    provider?: string;
    model?: string;
    baseURL?: string;
    apiKey?: string;
    clearApiKey?: boolean;
  },
  targetCwd: string,
) {
  const live = loadConfig({ cwd: targetCwd });
  const profile = profileForConfig(live).profile;
  if (input.source === "current") {
    if (profile.kind === "gateway") {
      const models = [...new Set(profile.availableModels ?? [])]
        .filter((model) => classifyVision("hara-gateway", model, live.modelVision) === "vision");
      return {
        ok: models.length > 0,
        models,
        entries: models.map((model) => ({
          id: model,
          providerId: "hara-gateway",
          effortLevels: gatewayReasoningEffortLevels(profile, model),
          attachmentCapabilities: effectiveAttachmentCapabilities("hara-gateway", model, live.modelVision),
        })),
        ...(models.length === 0
          ? { error: "This company connection has not authorized an image-capable model" }
          : {}),
      };
    }
    const target = resolveByokProviderTarget(live, profile, false, {});
    const providerEntry = providerSettingsCatalog().find((candidate) => candidate.id === target.provider);
    const result = await testProviderSettingsCandidate({
      provider: target.provider,
      model: input.model?.trim() || target.model,
      ...(target.baseURL ? { baseURL: target.baseURL } : {}),
      ...(target.apiKey ? { apiKey: target.apiKey } : {}),
    }, { reusePersonalApiKey: false });
    return visionOnlyTestResult(
      result,
      target.provider,
      [...(providerEntry?.knownVisionModels ?? []), target.model],
      live.modelVision,
    );
  }

  if (profile.kind === "gateway") {
    throw new Error("company vision routing must reuse the managed provider connection");
  }
  if (!isProviderId(input.provider) || input.provider === "hara-gateway" || input.provider === "qwen-oauth") {
    throw new Error("a custom vision interface requires a supported API provider/protocol adapter");
  }
  const providerEntry = providerSettingsCatalog().find((candidate) => candidate.id === input.provider)!;
  const model = input.model?.trim() || providerEntry.knownVisionModels[0] || providerEntry.defaultModel;
  const candidate = normalizePersonalProviderConfig({
    provider: input.provider,
    model,
    baseURL: input.baseURL,
    apiKey: input.apiKey,
    clearApiKey: input.clearApiKey,
  });
  const savedRoute = visionRouteForProfile(live, profile);
  const sameSavedRoute = savedRoute.source === "custom"
    && (savedRoute.provider ?? live.provider) === candidate.provider
    && normalizeVisionBaseURL(savedRoute.baseURL) === normalizeVisionBaseURL(candidate.baseURL);
  const apiKey = candidate.apiKey
    ?? (!candidate.clearApiKey && sameSavedRoute ? savedRoute.apiKey : undefined);
  const result = await testProviderSettingsCandidate({
    provider: candidate.provider,
    model: candidate.model,
    ...(candidate.baseURL ? { baseURL: candidate.baseURL } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(candidate.clearApiKey ? { clearApiKey: true } : {}),
  }, { reusePersonalApiKey: false });
  return visionOnlyTestResult(
    result,
    candidate.provider,
    providerEntry.knownVisionModels,
    live.modelVision,
  );
}

async function testNamedProviderConnection(inputId: string, targetCwd: string) {
  const id = inputId.trim();
  if (!isValidProfileId(id)) throw new Error("invalid personal connection id");
  const live = loadConfig({ cwd: targetCwd });
  const profile = getProfile(id);
  if (!profile || profile.kind !== "byok") throw new Error("personal connection was not found");
  // Test the persisted identity itself. Ambient one-shot HARA_* routing must not silently test another
  // endpoint or key, especially when two saved connections use the same provider.
  const target = resolveByokProviderTarget(live, profileByIdForConfig(live, profile.id) ?? profile, false, {});
  return testProviderSettingsCandidate({
    provider: target.provider,
    model: target.model,
    ...(target.baseURL ? { baseURL: target.baseURL } : {}),
    ...(target.apiKey ? { apiKey: target.apiKey } : {}),
  }, { reusePersonalApiKey: false });
}

const SETUP_DEFAULT_MODEL: Record<string, string> = {
  anthropic: "claude-opus-4-8",
  "token-plan": "qwen3.8-max",
  "minimax-token-plan": "MiniMax-M3",
  "volcengine-agent-plan": "auto",
  qwen: "qwen-plus",
  openai: "gpt-4o-mini",
  glm: "glm-4.6",
  deepseek: "deepseek-v4-flash",
  openrouter: "openai/gpt-4o-mini",
  ollama: "qwen3",
  lmstudio: "local-model",
  "qwen-oauth": "coder-model",
};

/** Numbered provider menu for `hara setup`. Token Plan is Alibaba's only new-user subscription entry;
 * legacy DashScope and Qwen Code OAuth profiles remain loadable but are not advertised here. */
const SETUP_MENU: { label: string; id: ProviderId | "custom" }[] = [
  { label: "Anthropic", id: "anthropic" },
  { label: "OpenAI", id: "openai" },
  { label: "Alibaba Cloud Model Studio Token Plan (API key, Beijing)", id: "token-plan" },
  { label: "MiniMax Token Plan (API key, Responses)", id: "minimax-token-plan" },
  { label: "Volcengine Ark Agent Plan (API key, Beijing, Responses)", id: "volcengine-agent-plan" },
  { label: "GLM (Zhipu)", id: "glm" },
  { label: "DeepSeek", id: "deepseek" },
  { label: "Ollama (local, no key)", id: "ollama" },
  { label: "LM Studio (local, no key)", id: "lmstudio" },
  { label: "OpenAI-compatible (custom base URL)", id: "custom" },
];

/** Read a secret from the TTY without echoing it (shows `*` per char). Falls back to a plain
 *  readline question when stdin isn't a raw-capable TTY (piped input / odd terminals) so scripted
 *  `printf 'key\n' | hara setup` still works. Handles backspace, Enter, and Ctrl-C/Ctrl-D. */
function readSecret(prompt: string, rl: ReturnType<typeof createInterface>): Promise<string> {
  const input = stdin;
  if (!input.isTTY || typeof (input as any).setRawMode !== "function") {
    // Non-TTY (piped/scripted): can't suppress echo at the terminal level; read it plainly.
    return rl.question(prompt);
  }
  return new Promise<string>((resolve, reject) => {
    stdout.write(prompt);
    let buf = "";
    const prevRaw = (input as any).isRaw ?? false;
    // Pause the readline interface so it doesn't also consume keystrokes / echo while we read raw.
    // We restore it in cleanup() before the next rl.question() runs.
    rl.pause();
    (input as any).setRawMode(true);
    input.resume();
    const onData = (chunk: Buffer): void => {
      const s = chunk.toString("utf8");
      for (const ch of s) {
        const code = ch.charCodeAt(0);
        if (ch === "\r" || ch === "\n") {
          cleanup();
          stdout.write("\n");
          resolve(buf);
          return;
        } else if (code === 3) {
          // Ctrl-C → abort the wizard (mirror readline's SIGINT behavior).
          cleanup();
          stdout.write("\n");
          reject(new Error("cancelled"));
          return;
        } else if (code === 4) {
          // Ctrl-D → end of input; resolve with whatever we have.
          cleanup();
          stdout.write("\n");
          resolve(buf);
          return;
        } else if (code === 127 || code === 8) {
          // Backspace/Delete.
          if (buf.length) {
            buf = buf.slice(0, -1);
            stdout.write("\b \b");
          }
        } else if (code >= 32) {
          buf += ch;
          stdout.write("*");
        }
      }
    };
    const cleanup = (): void => {
      input.removeListener("data", onData);
      try {
        (input as any).setRawMode(prevRaw);
      } catch {
        /* best-effort */
      }
      // Hand control back to readline for the next prompt (model question).
      rl.resume();
    };
    input.on("data", onData);
  });
}

/** One-shot validation ping: build the provider exactly as the runtime would (anthropic vs the
 *  OpenAI-compatible path with the resolved base URL) and send a tiny prompt with a short timeout.
 *  Never throws — returns true on a clean turn, false on any error/timeout. Used only to print a
 *  friendly "connected" hint; the wizard saves config regardless. */
async function pingProvider(args: { provider: ProviderId; apiKey: string; model: string; baseURL?: string }): Promise<boolean> {
  const { provider, apiKey, model, baseURL } = args;
  if ((!apiKey && !providerIsLocal(provider)) || !model) return false;
  try {
    const prov = await createProviderForTarget({ provider, apiKey: apiKey || undefined, model, baseURL });
    if (!prov) return false;
    const r = await boundedProviderTurn(prov, {
      system: "Reply with the single word: ok",
      history: [{ role: "user", content: "ping" }],
      tools: [],
      onText: () => {},
    }, { timeoutMs: 12_000, label: "provider connectivity check" });
    return r.stop !== "error";
  } catch {
    return false;
  }
}

/** Interactive first-run setup: pick a provider (numbered menu), API key (masked), and model →
 *  ~/.hara/config.json. Token Plan models are selected from the key-scoped live catalog when possible;
 *  the documented text-model catalog is only an explicitly unverified setup fallback. */
async function runSetup(): Promise<void> {
  if (!stdin.isTTY) {
    out(c.yellow("`hara setup` is interactive — run it in a terminal, or use `hara config set <key> <value>` in scripts.\n"));
    return;
  }
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    out(c.bold("hara setup") + c.dim(" — configure a provider, key, and model (Ctrl-C to cancel)\n\n"));
    SETUP_MENU.forEach((m, i) => out(`  ${c.bold(String(i + 1))}) ${m.label}\n`));
    out("\n");
    const pick = (await rl.question(`Provider [1]: `)).trim() || "1";
    const idx = Number.parseInt(pick, 10);
    const choice = Number.isInteger(idx) && idx >= 1 && idx <= SETUP_MENU.length ? SETUP_MENU[idx - 1] : SETUP_MENU[0];

    // Resolve the concrete provider id + base URL. "custom" = OpenAI-compatible: ask for the base
    // URL and store the chosen provider as "openai" (the generic OpenAI-compatible dispatch).
    let provider: ProviderId;
    let baseURL = "";
    if (choice.id === "custom") {
      provider = "openai";
      baseURL = (await rl.question(`Base URL ${c.dim("(OpenAI-compatible endpoint, e.g. https://your-host/v1)")}: `)).trim();
    } else {
      provider = choice.id;
      // GLM/DeepSeek/OpenRouter carry a preset base URL (PROVIDER_DEFAULTS) — written explicitly so
      // the personal profile is self-contained. anthropic/openai use their built-in defaults.
      baseURL = providerDefaultBaseURL(provider) ?? "";
    }

    const envKey = providerEnvKey(provider);
    const apiKey = providerRequiresApiKey(provider)
      ? (await readSecret(`API key ${c.dim(`(masked; blank = use the ${envKey} env var)`)}: `, rl)).trim()
      : "";
    const defaultModel = SETUP_DEFAULT_MODEL[choice.id === "custom" ? "openai" : provider] ?? "";
    const effectiveSetupKey = apiKey || process.env[envKey] || process.env.HARA_API_KEY || "";
    const preset = providerCatalog().find((entry) => entry.id === provider);
    const liveModels = effectiveSetupKey && baseURL
      ? await listModels(baseURL, effectiveSetupKey).catch(() => [])
      : [];
    const modelChoices = liveModels.length ? liveModels : [...(preset?.knownModels ?? [])];
    let model: string;
    if (modelChoices.length) {
      out(liveModels.length
        ? c.dim("\nModels authorized for this key:\n")
        : c.yellow("\nKnown provider models (not yet verified for this key):\n"));
      modelChoices.forEach((modelId, i) => out(`  ${c.bold(String(i + 1))}) ${modelId}\n`));
      const defaultIndex = Math.max(0, modelChoices.indexOf(defaultModel));
      while (true) {
        const pickedModel = (await rl.question(`Model [${defaultIndex + 1}: ${modelChoices[defaultIndex]}]: `)).trim();
        if (!pickedModel) {
          model = modelChoices[defaultIndex];
          break;
        }
        if (/^\d+$/.test(pickedModel)) {
          const pickedIndex = Number.parseInt(pickedModel, 10);
          if (pickedIndex >= 1 && pickedIndex <= modelChoices.length) {
            model = modelChoices[pickedIndex - 1];
            break;
          }
        }
        out(c.yellow(`Choose a number from 1 to ${modelChoices.length}.\n`));
      }
    } else {
      model = (await rl.question(`Model [${defaultModel || "?"}]: `)).trim() || defaultModel;
    }

    updatePersonalProviderConfig({
      provider,
      model,
      ...(baseURL ? { baseURL } : {}),
      ...(apiKey ? { apiKey } : {}),
      ...(!providerRequiresApiKey(provider) ? { clearApiKey: true } : {}),
    });

    // One-shot validation ping (best-effort; never blocks saving). Only when we have a key + model.
    if ((effectiveSetupKey || providerIsLocal(provider)) && model) {
      out(c.dim("\nChecking connection… "));
      const ok = await pingProvider({ provider, apiKey: effectiveSetupKey, model, baseURL: baseURL || undefined });
      out(ok ? c.green("✓ connected\n") : c.yellow(`⚠ couldn't reach ${provider} (saved anyway)\n`));
    }

    // A subscription plan's cost shape is invisible from the model list and explains most "Hara is slow"
    // / "Hara stopped" reports. Say it once, here, where a first-run user is still reading.
    const planLines = planNoteLines(provider);
    if (planLines.length) {
      out(c.dim(`\nAbout this plan:\n`) + planLines.map((line) => c.dim(`  · ${line}\n`)).join(""));
    }
    out(c.green(`\n✓ saved to ${configPath()}\n`) + c.dim(`Check it with ${c.bold("hara doctor")}, then just run ${c.bold("hara")}.\n`));
  } catch (e: any) {
    if (e?.message === "cancelled") out(c.dim("\n(cancelled)\n"));
    else throw e;
  } finally {
    rl.close();
  }
}

function agentRunLimits(cfg: Pick<HaraConfig, "runTimeoutMs" | "maxAgentRounds">): { timeoutMs: number; maxRounds: number } {
  return { timeoutMs: cfg.runTimeoutMs, maxRounds: cfg.maxAgentRounds };
}

async function runInit(
  provider: Provider,
  cwd: string,
  sandbox: SandboxMode = "off",
  cfg?: HaraConfig,
  profileId?: string,
  spaceId?: string,
): Promise<void> {
  if (isUnsafeProjectWorkspace(cwd)) throw new Error(homeWorkspaceActionError("initialize AGENTS.md"));
  const history: NeutralMsg[] = [{ role: "user", content: INIT_PROMPT }];
  await runAgent(history, {
    provider,
    ctx: { cwd, sandbox, ...(profileId ? { profileId } : {}), ...(spaceId ? { spaceId } : {}) },
    approval: "full-auto",
    approvalChannel: false,
    confirm: async () => true,
    ...(cfg ? agentRunLimits(cfg) : {}),
  });
}

interface OrgOpts {
  cfg: HaraConfig;
  baseProvider: Provider;
  /** Exact identity route for every managed role, role model, nested agent, and control-plane request. */
  profileId: string;
  /** Immutable audience for organization learning and prompt memory. */
  spaceId: string;
  cwd: string;
  sandbox: SandboxMode;
  approval: ApprovalMode;
  approvalChannel: boolean;
  confirm: (q: string) => Promise<boolean>;
  projectContext?: string;
  stats: { input: number; output: number };
  forceRole?: string;
  parallel?: boolean; // execute independent atoms (same dependency wave) concurrently
  review?: boolean; // after implementing, loop a reviewer role until it approves (implement → review → fix)
  rounds?: number; // max review rounds (default 3)
  commit?: boolean; // commit the result (with --review: only after approval) — guarded to a clean start tree
  /** Control bundle snapshot from which every managed role in this operation was resolved. */
  organizationPolicyVersion?: number;
}

async function acquireOrganizationSnapshot(o: OrgOpts): Promise<string | null> {
  try {
    const profile = assertProfileAudience(o.cfg, o.profileId, o.spaceId);
    const policy = await ensureOrganizationExecutionPolicy(o.cfg, profile, o.spaceId);
    o.organizationPolicyVersion = policy?.version;
    return null;
  } catch (error) {
    if (isOrganizationAuthorizationRejection(error)) return organizationAuthorizationRecoveryMessage();
    return error instanceof Error ? error.message : String(error);
  }
}

function organizationSnapshotChanged(o: OrgOpts): string | null {
  try {
    assertProfileAudience(o.cfg, o.profileId, o.spaceId);
    const policy = loadOrganizationExecutionPolicy(o.spaceId);
    if (o.spaceId !== PERSONAL_ID && !policy) return "organization execution policy is unavailable";
    if (policy && policy.version !== o.organizationPolicyVersion) {
      return `organization role bundle changed from version ${o.organizationPolicyVersion} to ${policy.version}; retry so persona and policy use one snapshot`;
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function bindRolesToOrganizationSnapshot(roles: Role[], o: OrgOpts): string | null {
  if (o.spaceId === PERSONAL_ID) return null;
  const roleVersions = new Set(
    roles.map((role) => role.organizationPolicyVersion).filter((version): version is number => version !== undefined),
  );
  if (roleVersions.size > 1) return "managed roles came from multiple organization bundle versions";
  const roleVersion = roleVersions.values().next().value as number | undefined;
  if (roleVersion !== undefined && roleVersion !== o.organizationPolicyVersion) {
    return `organization role bundle changed from version ${o.organizationPolicyVersion} to ${roleVersion}; retry so persona and policy use one snapshot`;
  }
  return organizationSnapshotChanged(o);
}

/** Stage everything and commit with an AI-written message. Returns a one-line summary or "error: …".
 *  Used by `hara org --commit`; the caller guards on a clean start tree so this only captures the run's work. */
async function autoCommit(
  provider: Provider,
  cwd: string,
  signal?: AbortSignal,
  authorizationGuard?: () => string | null | Promise<string | null>,
): Promise<string> {
  if (signal?.aborted) return "error: commit interrupted before staging";
  const beforeAuthorization = await authorizationGuard?.();
  if (beforeAuthorization) return `error: commit authorization changed (${beforeAuthorization})`;
  const before = protectedWorkingTreePaths(cwd);
  if (before.length) return `error: refusing to stage protected path(s): ${before.map((p) => JSON.stringify(p)).join(", ")}`;
  // Generate the message from the unstaged candidate first. A long model request must not leave the Git
  // index modified when Control tightens company policy while that request is in flight.
  const candidate = captureChanges(cwd, 120_000, { includeUntracked: true });
  if (candidate.error) return `error: git diff failed closed (${candidate.error})`;
  if (candidate.skippedFiles.length) {
    return `error: refusing to inspect or commit protected path(s): ${candidate.skippedFiles.map((p) => JSON.stringify(p)).join(", ")}`;
  }
  const changeInput = commitMessageInput(candidate);
  if (!changeInput.trim()) return "nothing to commit";
  const r = await boundedProviderTurn(provider, {
    system: COMMIT_SYSTEM,
    history: [{ role: "user", content: `Write a commit message for these staged changes:\n\n${changeInput.slice(0, 120_000)}` }],
    tools: [],
    onText: () => {},
  }, { timeoutMs: 30_000, label: "commit message generation", signal });
  if (signal?.aborted) return "error: commit interrupted; nothing was committed";
  if (r.stop === "error") return `error: commit message generation failed (${r.errorMsg ?? "provider error"})`;
  const afterAuthorization = await authorizationGuard?.();
  if (afterAuthorization) return `error: commit authorization changed (${afterAuthorization})`;
  const msg = stripCommitFence(r.text);
  if (!msg) return "error: no commit message produced";
  const stagingAuthorization = await authorizationGuard?.();
  if (stagingAuthorization) return `error: commit authorization changed (${stagingAuthorization})`;
  try {
    await runShell("git add -A", cwd, "off", { timeout: 30_000, maxBuffer: 1_000_000, signal });
  } catch (error) {
    return `error: git add failed (${error instanceof Error ? error.message : String(error)})`;
  }
  const protectedAfterStage = protectedStagedPaths(cwd);
  if (signal?.aborted) return "error: commit interrupted after staging; nothing was committed";
  if (protectedAfterStage.length) {
    return `error: refusing to inspect or commit protected staged path(s): ${protectedAfterStage.map((p) => JSON.stringify(p)).join(", ")}`;
  }
  const tmp = join(tmpdir(), `hara-org-commit-${process.pid}.txt`);
  writeFileSync(tmp, msg + "\n", "utf8");
  try {
    const protectedBeforeCommit = protectedStagedPaths(cwd);
    if (signal?.aborted) return "error: commit interrupted; nothing was committed";
    if (protectedBeforeCommit.length) {
      return `error: staged paths changed while writing the message; protected path(s) will not be committed: ${protectedBeforeCommit.map((p) => JSON.stringify(p)).join(", ")}`;
    }
    const finalAuthorization = await authorizationGuard?.();
    if (finalAuthorization) return `error: commit authorization changed (${finalAuthorization})`;
    const res = await runShell(`git commit -F ${JSON.stringify(tmp)}`, cwd, "off", { timeout: 30_000, maxBuffer: 1_000_000, signal });
    return (res.stdout || "").trim().split("\n")[0] || "committed";
  } catch (e) {
    return `error: git commit failed (${e instanceof Error ? e.message : String(e)})`;
  } finally {
    try {
      rmSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
  }
}

/** Format an autoCommit result + emit it. */
async function commitStep(
  provider: Provider,
  cwd: string,
  signal?: AbortSignal,
  authorizationGuard?: () => string | null | Promise<string | null>,
): Promise<void> {
  if (signal?.aborted) return;
  const r = await autoCommit(provider, cwd, signal, authorizationGuard);
  if (r.startsWith("error:")) out(c.red(`✗ ${r}\n`));
  else if (r === "nothing to commit") out(c.dim("(nothing to commit)\n"));
  else out(c.green(`✓ committed · ${r.slice(0, 100)}\n`));
}

/** Dispatch a task to the owning role and run that role's agent (its persona + tool subset + model). */
function runFailureDetail(outcome: RunOutcome): string | null {
  if (outcome.status === "completed") return null;
  if (outcome.error?.trim()) return outcome.error.trim();
  if (outcome.status === "empty") return "the model returned an empty response";
  if (outcome.status === "halted") return "the run was halted by safety controls";
  return "the agent run failed";
}

async function runOrg(task: string, o: OrgOpts): Promise<RunOutcome> {
  const snapshotError = await acquireOrganizationSnapshot(o);
  if (snapshotError) return { status: "error", error: `organization policy sync failed: ${snapshotError}` };
  const roles = loadActiveRoles(o.cwd, o.profileId);
  const roleSnapshotError = bindRolesToOrganizationSnapshot(roles, o);
  if (roleSnapshotError) return { status: "error", error: roleSnapshotError };
  if (!roles.length) {
    out(c.yellow("No roles defined — run ") + c.bold("hara roles init") + c.yellow(" to scaffold some.\n"));
    return { status: "error", error: "no roles are defined" };
  }
  let role: Role | undefined;
  if (o.forceRole) {
    role = roles.find((r) => r.id === o.forceRole);
    if (!role) {
      out(c.red(`No role '${o.forceRole}'. Available: ${roles.map((r) => r.id).join(", ")}\n`));
      return { status: "error", error: `no role '${o.forceRole}' is available` };
    }
  } else {
    const routableRoles = roles.filter((candidate) => candidate.modelInvocable !== false);
    if (!routableRoles.length) {
      out(c.yellow("No automatically routable roles — choose an explicit role with --role <id>.\n"));
      return { status: "error", error: "no roles allow automatic invocation" };
    }
    const kw = routeByKeywords(task, routableRoles);
    if (kw) {
      role = kw.role;
    } else {
      const r = await boundedProviderTurn(o.baseProvider, {
        system: "You are a task dispatcher. Reply with only a role id.",
        history: [{ role: "user", content: buildDispatchPrompt(task, routableRoles) }],
        tools: [],
        onText: () => {},
      }, { timeoutMs: 20_000, label: "role dispatch" });
      const changed = organizationSnapshotChanged(o);
      if (changed) return { status: "error", error: changed };
      if (r.stop === "error") out(c.yellow(`(role dispatch unavailable — using ${routableRoles[0].id})\n`));
      role = parseRoleId(r.text, routableRoles) ?? routableRoles[0];
    }
  }
  out(c.dim(`→ ${role.id} owns this task\n`));

  // Role-model resolution: respect role.model by default; --force collapses everything to cfg.model.
  const __roleModel = effectiveRoleModel(role.model, o.cfg.model);
  const roleProvider = __roleModel
    ? ((await buildProvider(o.cfg, { model: __roleModel }, o.profileId)) ?? o.baseProvider)
    : o.baseProvider;
  const toolFilter = roleToolFilter(role);

  const history: NeutralMsg[] = [{ role: "user", content: await expandMentionsAsync(task, o.cwd) }];
  const runImplementer = async (): Promise<RunOutcome> => {
    return runAgent(history, {
      provider: roleProvider,
      ctx: { cwd: o.cwd, sandbox: o.sandbox, profileId: o.profileId, spaceId: o.spaceId },
      approval: o.approval,
      approvalChannel: o.approvalChannel,
      confirm: o.confirm,
      projectContext: o.projectContext,
      memory: memoryDigest(o.cwd, o.spaceId),
      stats: o.stats,
      systemOverride: role.system,
      organizationPolicyVersion: o.organizationPolicyVersion,
      toolFilter,
      ...agentRunLimits(o.cfg),
      ...(role.readOnly ? { hooks: false } : {}),
    });
  };
  const wasClean = o.commit ? isTreeClean(o.cwd) : false; // capture BEFORE the implementer edits anything
  const doCommit = async (ok: boolean): Promise<void> => {
    if (!o.commit) return;
    if (!ok) return void out(c.yellow("(not committing — review didn't approve; changes left in your working tree)\n"));
    if (!wasClean) return void out(c.yellow("(not auto-committing — the tree wasn't clean before this run; commit manually)\n"));
    const commitProfile = assertProfileAudience(o.cfg, o.profileId, o.spaceId);
    const commitAuthorization = companyCommitGuard(o.cfg, commitProfile, {
      expectedVersion: o.organizationPolicyVersion,
      approvalChannel: o.approvalChannel,
    });
    const authorizationError = await commitAuthorization();
    if (authorizationError) return void out(c.yellow(`(not auto-committing — ${authorizationError})\n`));
    await commitStep(o.baseProvider, o.cwd, undefined, commitAuthorization);
  };
  let implementerOutcome = await runImplementer();
  if (implementerOutcome.status !== "completed") return implementerOutcome;

  if (!o.review) {
    await doCommit(true);
    return implementerOutcome;
  }

  // Review chain: a reviewer role inspects the diff and APPROVES or sends it back, looping until clean.
  const reviewer = roles.find((r) => r.id === "reviewer");
  const __revModel = effectiveRoleModel(reviewer?.model, o.cfg.model);
  const revProvider = __revModel ? ((await buildProvider(o.cfg, { model: __revModel }, o.profileId)) ?? o.baseProvider) : o.baseProvider;
  const revSystem = reviewer?.system ?? REVIEWER_SYSTEM;
  const revTools = roleToolFilter(reviewer ? { ...reviewer, readOnly: true } : undefined) ?? ((n: string) => READONLY_TOOLS.has(n));
  const maxRounds = Math.max(1, o.rounds ?? 3);
  for (let round = 1; round <= maxRounds; round++) {
    const changes = captureChanges(o.cwd);
    if (changes.error) {
      out(c.red(`(review change capture failed closed: ${changes.error})\n`));
      await doCommit(false);
      return { status: "halted", error: `review change capture failed: ${changes.error}` };
    }
    if (!changes.diff && !changes.newFiles.length && !changes.skippedFiles.length && !changes.omittedDeletions.length) {
      out(c.dim("(no changes to review)\n"));
      return implementerOutcome;
    }
    out(c.dim(`🔍 reviewer · round ${round}/${maxRounds}\n`));
    const rHist: NeutralMsg[] = [{ role: "user", content: reviewPrompt(task, changes) }];
    const reviewerOutcome = await runAgent(rHist, {
      provider: revProvider,
      ctx: { cwd: o.cwd, sandbox: o.sandbox, profileId: o.profileId, spaceId: o.spaceId },
      approval: "full-auto", // reviewer is read-only via revTools, so nothing to confirm
      approvalChannel: o.approvalChannel,
      confirm: o.confirm,
      projectContext: o.projectContext,
      memory: memoryDigest(o.cwd, o.spaceId),
      stats: o.stats,
      systemOverride: revSystem,
      organizationPolicyVersion: o.organizationPolicyVersion,
      toolFilter: revTools,
      hooks: false,
      ...agentRunLimits(o.cfg),
    });
    if (reviewerOutcome.status !== "completed") return reviewerOutcome;
    const verdict = parseVerdict(lastAssistantText(rHist));
    if (verdict.approved) {
      out(c.green(`✓ reviewer approved after ${round} round(s)\n`));
      await doCommit(true);
      return implementerOutcome;
    }
    if (round === maxRounds) {
      out(c.yellow(`⚠ stopped after ${maxRounds} round(s) — reviewer still wants changes.\n`));
      await doCommit(false);
      return { status: "halted", error: `reviewer did not approve after ${maxRounds} round(s)` };
    }
    out(c.yellow(`✗ changes requested — back to ${role.id} (round ${round})\n`));
    history.push({ role: "user", content: fixPrompt(verdict.issues) });
    implementerOutcome = await runImplementer();
    if (implementerOutcome.status !== "completed") return implementerOutcome;
  }
  return implementerOutcome;
}

function lastAssistantText(history: NeutralMsg[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i] as { role: string; text?: string };
    if (m.role === "assistant" && typeof m.text === "string") return m.text;
  }
  return "";
}

/** Run one atom (routed to its role if any), then gate it (its `check` command, else an LLM verify). */
async function executeAtom(atom: Atom, plan: Plan, done: Atom[], roles: Role[], o: OrgOpts): Promise<boolean> {
  atom.status = "running";
  await savePlan(o.cwd, plan);
  const role = atom.role ? roles.find((r) => r.id === atom.role) : undefined;
  if (atom.role && !role) {
    atom.status = "failed";
    atom.note = `planned role '${atom.role}' is no longer available`;
    await savePlan(o.cwd, plan);
    out(c.red(`  ✗ ${atom.id} ${atom.note}\n`));
    return false;
  }
  const __atomModel = effectiveRoleModel(role?.model, o.cfg.model);
  const roleProvider = __atomModel ? ((await buildProvider(o.cfg, { model: __atomModel }, o.profileId)) ?? o.baseProvider) : o.baseProvider;
  const toolFilter = roleToolFilter(role);
  const history: NeutralMsg[] = [{ role: "user", content: atomPrompt(atom, plan, done) }];
  try {
    const outcome = await runAgent(history, {
      provider: roleProvider,
      ctx: { cwd: o.cwd, sandbox: o.sandbox, profileId: o.profileId, spaceId: o.spaceId },
      approval: o.approval,
      approvalChannel: o.approvalChannel,
      confirm: o.confirm,
      projectContext: o.projectContext,
      memory: memoryDigest(o.cwd, o.spaceId),
      stats: o.stats,
      systemOverride: role?.system,
      organizationPolicyVersion: o.organizationPolicyVersion,
      toolFilter,
      ...(role?.readOnly ? { hooks: false } : {}),
      quiet: o.parallel, // concurrent atoms would otherwise interleave their streamed output
      ...agentRunLimits(o.cfg),
    });
    const failure = runFailureDetail(outcome);
    if (failure) {
      atom.status = "failed";
      atom.note = failure;
      await savePlan(o.cwd, plan);
      out(c.red(`  ✗ ${atom.id} agent ${outcome.status}: ${failure}\n`));
      return false;
    }
  } catch (e: any) {
    atom.status = "failed";
    atom.note = e.message;
    await savePlan(o.cwd, plan);
    out(c.red(`  ✗ ${atom.id} errored: ${e.message}\n`));
    return false;
  }
  // `atom.check` is untrusted model output. Executing it through runShell would bypass the ordinary bash
  // tool policy, approvals, hooks, and organization write floor. The implementation Agent may run an
  // appropriate check through its governed tools; this independent verifier remains model-only.
  if (atom.check) out(c.dim(`  · proposed check kept as plan metadata (not auto-executed): ${atom.check.slice(0, 160)}\n`));
  const v = await verify(o.baseProvider, atom, lastAssistantText(history));
  const changed = organizationSnapshotChanged(o);
  if (changed) {
    atom.status = "failed";
    atom.note = changed;
    await savePlan(o.cwd, plan);
    out(c.red(`  ✗ ${atom.id} ${changed}\n`));
    return false;
  }
  atom.status = v.ok ? "done" : "failed";
  atom.note = v.reason;
  await savePlan(o.cwd, plan);
  out(v.ok ? c.green(`  ✓ ${atom.id} verified\n`) : c.yellow(`  ⚠ ${atom.id}: ${v.reason}\n`));
  return v.ok;
}

/** Execute a plan's atoms (sequential, or parallel waves with --parallel). Atoms already marked `done`
 *  are skipped — so this doubles as the resume engine. Stops on the first failure. */
async function executePlan(plan: Plan, roles: Role[], o: OrgOpts): Promise<RunOutcome> {
  const done: Atom[] = plan.atoms.filter((a) => a.status === "done");
  const doneIds = new Set(done.map((a) => a.id));
  let failed = false;

  if (o.parallel) {
    const waved = topoWaves(plan.atoms);
    if ("error" in waved) {
      out(c.red(`${waved.error}\n`));
      return { status: "error", error: waved.error };
    }
    out(c.dim(`Parallel mode — ${waved.ok.length} wave(s).\n`));
    for (const wave of waved.ok) {
      const todo = wave.filter((a) => !doneIds.has(a.id));
      if (!todo.length) continue; // whole wave already complete (resume)
      out(c.cyan(`\n▶ wave [${todo.map((a) => a.id).join(", ")}] — ${todo.length} in parallel\n`));
      const results = await mapLimit(todo, maxParallel(), (atom) => executeAtom(atom, plan, done, roles, o)); // bounded
      todo.forEach((atom, i) => {
        if (results[i]) {
          done.push(atom);
          doneIds.add(atom.id);
        }
      });
      if (results.some((r) => !r)) {
        failed = true;
        out(c.dim("Stopping — a wave atom failed. Inspect .hara/org/plan.json, then fix & `hara plan resume`.\n"));
        break;
      }
    }
  } else {
    const ord = topoOrder(plan.atoms);
    if ("error" in ord) {
      out(c.red(`${ord.error}\n`));
      return { status: "error", error: ord.error };
    }
    for (const atom of ord.ok) {
      if (doneIds.has(atom.id)) continue; // resume: skip completed atoms
      out(c.cyan(`\n▶ ${atom.id} ${atom.title}\n`));
      if (await executeAtom(atom, plan, done, roles, o)) {
        done.push(atom);
        doneIds.add(atom.id);
      } else {
        failed = true;
        out(c.dim("Stopping — inspect .hara/org/plan.json, then fix & `hara plan resume`.\n"));
        break;
      }
    }
  }
  out(c.bold(`\nPlan: ${plan.atoms.filter((a) => a.status === "done").length}/${plan.atoms.length} atoms done.\n`));
  if (failed || plan.atoms.some((atom) => atom.status === "failed")) {
    const first = plan.atoms.find((atom) => atom.status === "failed");
    return { status: "error", error: first ? `atom ${first.id} failed${first.note ? `: ${first.note}` : ""}` : "plan execution failed" };
  }
  if (plan.atoms.some((atom) => atom.status !== "done")) {
    return { status: "halted", error: "plan stopped before every atom completed" };
  }
  return { status: "completed" };
}

/** Decompose a task into atoms, sequence them (DAG), and execute each with a verify gate.
 *  With `parallel`, independent atoms (the same dependency wave) run concurrently. */
async function runPlan(task: string, o: OrgOpts): Promise<RunOutcome> {
  const snapshotError = await acquireOrganizationSnapshot(o);
  if (snapshotError) return { status: "error", error: `organization policy sync failed: ${snapshotError}` };
  const roles = loadActiveRoles(o.cwd, o.profileId);
  const roleSnapshotError = bindRolesToOrganizationSnapshot(roles, o);
  if (roleSnapshotError) return { status: "error", error: roleSnapshotError };
  out(c.dim("Planning…\n"));
  const plan = await decompose(o.baseProvider, task, roles);
  const changed = organizationSnapshotChanged(o);
  if (changed) return { status: "error", error: changed };
  if (!plan.atoms.length) {
    out(c.red("Planner returned no atoms — try rephrasing the task.\n"));
    return { status: "error", error: "planner returned no atoms" };
  }
  const ord = topoOrder(plan.atoms);
  if ("error" in ord) {
    out(c.red(`${ord.error}\n`));
    return { status: "error", error: ord.error };
  }
  out(c.bold(`\nPlan (${ord.ok.length} atoms):\n`));
  for (const a of ord.ok) {
    out(`  ${c.cyan(a.id)} ${a.title}${a.deps.length ? c.dim(" ←" + a.deps.join(",")) : ""}${a.role ? c.dim(" @" + a.role) : ""}${a.check ? c.dim(" ✓" + a.check) : ""}\n`);
  }
  if (o.approval !== "full-auto") {
    const ok = await o.confirm(`${c.yellow("▶")} Execute this ${ord.ok.length}-atom plan?`);
    if (!ok) {
      out(c.dim("(cancelled)\n"));
      return { status: "halted", error: "plan execution was cancelled" };
    }
  }
  await savePlan(o.cwd, plan);
  return executePlan(plan, roles, o);
}

/** Resume the saved plan (.hara/org/plan.json): re-run atoms that aren't done; completed atoms are skipped. */
async function runResume(o: OrgOpts): Promise<RunOutcome> {
  const snapshotError = await acquireOrganizationSnapshot(o);
  if (snapshotError) return { status: "error", error: `organization policy sync failed: ${snapshotError}` };
  const roles = loadActiveRoles(o.cwd, o.profileId);
  const roleSnapshotError = bindRolesToOrganizationSnapshot(roles, o);
  if (roleSnapshotError) return { status: "error", error: roleSnapshotError };
  const plan = loadPlan(o.cwd);
  if (!plan) {
    out(c.red('No saved plan at .hara/org/plan.json — run `hara plan "<task>"` first.\n'));
    return { status: "error", error: "no saved plan" };
  }
  const remaining = plan.atoms.filter((a) => a.status !== "done");
  if (!remaining.length) {
    out(c.green(`Plan already complete — ${plan.atoms.length}/${plan.atoms.length} done.\n`));
    return { status: "completed" };
  }
  out(c.bold(`Resuming: ${plan.task}\n`) + c.dim(`${plan.atoms.length - remaining.length}/${plan.atoms.length} done · ${remaining.length} to go\n`));
  for (const a of remaining) out(`  ${c.cyan(a.id)} ${a.title} ${c.dim("(" + a.status + ")")}\n`);
  if (o.approval !== "full-auto") {
    const ok = await o.confirm(`${c.yellow("▶")} Resume the ${remaining.length} remaining atom(s)?`);
    if (!ok) {
      out(c.dim("(cancelled)\n"));
      return { status: "halted", error: "plan resume was cancelled" };
    }
  }
  for (const a of plan.atoms) if (a.status === "failed" || a.status === "running") a.status = "pending"; // retry interrupted
  await savePlan(o.cwd, plan);
  return executePlan(plan, roles, o);
}

const READONLY_TOOLS = new Set(["read_file", "inspect_image", "grep", "glob", "ls", "web_fetch", "web_search", "codebase_search", "todo_write"]);
const REVIEW_SYSTEM =
  "You are a senior code reviewer. Review the safe Git status metadata the user provides for: correctness bugs, security " +
  "issues, missing error handling, unclear naming, and missing/weak tests. You may read files (read-only) " +
  "to inspect their current contents; historical patch lines are intentionally unavailable. Be concise and specific — cite file:line and the concrete fix. Group findings by severity: " +
  "**Blocker**, **Should-fix**, **Nit**. If nothing material is wrong, say the diff looks good. Never edit files.";

function standaloneReviewPrompt(changes: CapturedChanges): string {
  const parts = ["Review these changes:"];
  if (changes.diff) parts.push(`Change metadata only (status + path; no historical patch contents):\n\`\`\`text\n${changes.diff}\n\`\`\``);
  if (changes.newFiles.length) parts.push(`New files (inspect with read_file): ${changes.newFiles.map((p) => JSON.stringify(p)).join(", ")}`);
  if (changes.skippedFiles.length) {
    parts.push(
      "Protected paths were omitted and MUST NOT be opened during this review: " +
      changes.skippedFiles.map((p) => JSON.stringify(p)).join(", "),
    );
  }
  if (changes.omittedDeletions.length) {
    parts.push(
      "Tracked deletions were detected; their historical contents were omitted because old filesystem " +
      "identity cannot be verified safely: " + changes.omittedDeletions.map((p) => JSON.stringify(p)).join(", "),
    );
  }
  return parts.join("\n\n");
}
const COMMIT_SYSTEM =
  "Write a git commit message for the staged change metadata. A concise imperative subject (≤72 chars; an optional " +
  "conventional-commits prefix like feat:/fix:/refactor:/docs:/test:/chore: is welcome). If the change is " +
  "non-trivial, add a blank line then a short body (a few bullets or sentences) on what changed and why. " +
  "Output ONLY the commit message — no code fences, no preamble, no surrounding quotes.";
const SESSION_NAME_SYSTEM =
  "Name this coding session as a SHORT slug: 2–4 English words, lowercase, hyphen-separated, ASCII only " +
  "(e.g. add-semantic-search, fix-login-redirect). If the conversation is in another language, translate the " +
  "gist to English (use pinyin only if a term is untranslatable). Output ONLY the slug.";

/** One short model call → a 2–4 word English kebab-case session name summarizing the work.
 *  Always ASCII (translates non-English gist). Falls back to the lexical title on any failure. */
async function nameSession(provider: Provider, history: NeutralMsg[], signal?: AbortSignal): Promise<string> {
  const text = (m: NeutralMsg | undefined): string => {
    if (!m) return "";
    if (m.role === "assistant") return typeof m.text === "string" ? m.text : "";
    if (m.role === "user") return typeof m.content === "string" ? m.content : "";
    return "";
  };
  const basis =
    `User: ${text(history.find((m) => m.role === "user")).slice(0, 800)}\n` +
    `Assistant: ${text(history.find((m) => m.role === "assistant")).slice(0, 800)}`;
  const fallback = titleFrom(history);
  if (signal?.aborted) return fallback;
  try {
    const r = await boundedProviderTurn(
      provider,
      { system: SESSION_NAME_SYSTEM, history: [{ role: "user", content: basis }], tools: [], onText: () => {} },
      { timeoutMs: 10_000, label: "session naming", signal },
    );
    if (signal?.aborted || r.stop === "error") return fallback;
    return sanitizeSessionTitle(slugify(r.text) || fallback, 40);
  } catch {
    return fallback;
  }
}
/** Render a proposed plan as a bordered block for the transcript (codex ProposedPlanCell-style).
 *  Left-border-only frame — right-edge alignment against variable-width content is brittle, and the
 *  open right side lets long lines wrap naturally. Emitted via the diff sink channel (renders verbatim,
 *  not dimmed like notice). */
const renderPlanBlock = (plan: string): string => {
  const lines = plan.replace(/\n+$/, "").split("\n");
  const top = c.cyan("╭─ ") + c.bold(c.cyan("Plan")) + c.cyan(" " + "─".repeat(42));
  const body = lines.map((l) => c.cyan("│ ") + l).join("\n");
  return `${top}\n${body}\n${c.cyan("╰" + "─".repeat(48))}`;
};

// Plan mode's contract (Claude-Code style handshake): the MODEL decides when the plan is ready by
// calling `exit_plan` — we never nag with a proceed-prompt after turns that were just investigation
// or Q&A. codex's equivalent is the plan streaming to a dedicated cell + Enter-to-implement.
const PLAN_SYSTEM =
  "You are in PLAN MODE — a read-only investigation phase. Explore with read_file / grep / glob / ls / " +
  "web tools and think. Do NOT edit files or run mutating commands — only investigate and plan. " +
  "When (and only when) you have a complete, actionable plan, call the `exit_plan` tool with the full plan " +
  "(concise markdown, short numbered steps), then stop and wait for the user's decision. " +
  "If the user is asking a question, or the plan isn't ready yet, just answer normally WITHOUT calling exit_plan.";
const MEMORY_DISTILL_SYSTEM =
  "You consolidate an agent's short-term daily memory logs into its durable long-term memory. You're given " +
  "the current durable memory and recent daily logs. Extract ONLY durable, reusable facts / decisions / " +
  "conventions / user preferences from the logs that are NOT already captured, and persist each with " +
  "memory_write (target=memory, or target=user for preferences; pick the right scope=project|global). " +
  "Skip the ephemeral, the one-off, and anything already known. Be terse and de-duplicated. Then reply DONE.";

async function curateSessionLearning(
  provider: Provider,
  history: NeutralMsg[],
  cfg: HaraConfig,
  options: {
    cwd: string;
    sandbox: SandboxMode;
    profileId?: string;
    spaceId?: string;
    sessionId?: string;
    spawn?: ToolContext["spawn"];
    ui?: ToolContext["ui"];
    confirm: (question: string, signal?: AbortSignal) => Promise<boolean | "always">;
    approvalChannel: boolean;
    memory: string;
    stats: { input: number; output: number; lastInput?: number };
    signal?: AbortSignal;
  },
): Promise<RunOutcome> {
  // Curation gets a private transcript branch: its DONE/tool chatter must not become task conversation or
  // create assistant→assistant role adjacency. Memory/skill writes remain the only durable side effects.
  const curationHistory: NeutralMsg[] = [
    ...history,
    { role: "user", content: "Run the evidence-gated self-evolution curation now. If nothing qualifies, write nothing." },
  ];
  return runAgent(curationHistory, {
    provider,
    ctx: {
      cwd: options.cwd,
      sandbox: options.sandbox,
      profileId: options.profileId,
      spaceId: options.spaceId,
      sessionId: options.sessionId,
      spawn: options.spawn,
      ui: options.ui,
    },
    approval: cfg.assetCapture === "auto" ? "full-auto" : "suggest",
    approvalChannel: options.approvalChannel,
    confirm: options.confirm,
    toolFilter: (name) => allowsEvolutionTool(name, cfg.assetCapture),
    systemOverride: EVOLUTION_SYSTEM,
    memory: options.memory,
    stats: options.stats,
    signal: options.signal,
    ...agentRunLimits(cfg),
  });
}
// The bounded checkpoint contract + recent-turn preservation live in agent/compact.ts so CLI and serve
// cannot drift into different context semantics.

/** Summarize the conversation and replace history with the summary (keeping working-memory notes). Shared by
 *  /compact (manual) and auto-compaction. Returns the summary, or null on failure / nothing to do. */
async function compactConversation(
  provider: Provider,
  history: NeutralMsg[],
  meta: SessionMeta,
  stats: { input: number; output: number; lastInput?: number },
  signal?: AbortSignal,
  task?: TaskExecution,
  onProviderTurn?: RunOpts["onProviderTurn"],
): Promise<string | null> {
  if (history.length < 2 || signal?.aborted) return null;
  const recent = recentHistoryForCompaction(history);
  const r = await boundedProviderTurn(provider, {
    system: COMPACT_SYSTEM,
    history: [...compactionSourceHistory(history), { role: "user", content: "Create the bounded execution checkpoint now." }],
    tools: [],
    onText: () => {},
  }, { timeoutMs: 60_000, label: "conversation compaction", signal, onProviderTurn });
  // A provider may report billable usage with an error/aborted result. Account for the physical request
  // exactly once even when the original history must remain authoritative.
  stats.input += r.usage?.input ?? 0;
  stats.output += r.usage?.output ?? 0;
  if (signal?.aborted || r.stop === "error") return null;
  const rawSummary = r.text.trim();
  if (!rawSummary) return null;
  const summary = normalizeCompactionSummary(rawSummary);
  const workingSet = workingSetFromSummary(summary);
  // TW5-style file restore: the summary alone loses the working set's ACTUAL content — re-attach the
  // most recently touched files (current on-disk state, byte-capped) so work continues without re-reads.
  const restore = buildFileRestore(recentTouched(5), (p) => {
    if (signal?.aborted) return null;
    try {
      return readModelContextFileSync(p, 32 * 1024);
    } catch {
      return null;
    }
  });
  // Cancellation during the file snapshot must leave the original conversation untouched.
  if (signal?.aborted) return null;
  meta.workingSet = workingSet; // survives the history wipe + injects into the next turns
  const compacted = compactedConversationHistory(summary, recent, restore);
  history.length = 0;
  history.push(...compacted);
  stats.lastInput = compactedHistoryTokenEstimate(compacted); // reflect replacement, not the large summarizer request
  saveSession(meta, history, task);
  return summary;
}

/** Auto-compact (à la Claude Code) when the last turn filled the context past the threshold, so the NEXT turn
 *  doesn't overflow. Opt-out via `autoCompact: false` / `HARA_AUTO_COMPACT=0`. Best-effort; `notify` surfaces
 *  a one-line status. Returns true if it compacted. */
async function maybeAutoCompact(
  provider: Provider,
  history: NeutralMsg[],
  meta: SessionMeta,
  stats: { input: number; output: number; lastInput?: number },
  cfg: HaraConfig,
  notify: (m: string) => void,
  signal?: AbortSignal,
  task?: TaskExecution,
  onProviderTurn?: RunOpts["onProviderTurn"],
): Promise<boolean> {
  if (signal?.aborted) return false;
  const lastInput = stats.lastInput ?? 0;
  const pct = bar.ctxPctFor(cfg.model, lastInput);
  // Two triggers, whichever hits first: % of window (small-window models) OR an absolute token cap
  // (huge-window models, where 85% is an unreachable 850k). Cap is overridable via env.
  const cap = autoCompactTokenCap(process.env.HARA_AUTO_COMPACT_TOKENS);
  const overPct = shouldAutoCompact(pct, history.length, cfg.autoCompact);
  const overCap = shouldAutoCompactTokens(lastInput, history.length, cfg.autoCompact, cap);
  if (!overPct && !overCap) return false;
  if (signal?.aborted) return false;
  notify(`✻ Auto-compacting conversation (context ${pct}% full, ~${Math.round(lastInput / 1000)}k tok)…`);
  const summary = await compactConversation(provider, history, meta, stats, signal, task, onProviderTurn);
  if (signal?.aborted) return false;
  notify(summary ? `(auto-compacted — context replaced with a summary; ${meta.workingSet?.length ?? 0} notes kept)` : "(auto-compact failed — use /compact or /clear)");
  return !!summary;
}

/** Run a (read-only by default) sub-agent to completion, quietly, and return its final text. */
const subagentRuntimes = new WeakMap<object, SubagentRuntime<NativeSubagentRequest>>();

function subagentRuntimeFor(stats: object): SubagentRuntime<NativeSubagentRequest> {
  const current = subagentRuntimes.get(stats);
  if (current) return current;
  const runtime = new SubagentRuntime<NativeSubagentRequest>({
    maxConcurrent: maxParallel(),
    maxQueued: maxParallel() * 4,
  });
  runtime.register(createNativeSubagentProvider());
  subagentRuntimes.set(stats, runtime);
  return runtime;
}

async function runSubagent(
  cfg: HaraConfig,
  baseProvider: Provider,
  cwd: string,
  sandbox: SandboxMode,
  projectContext: string | undefined,
  stats: { input: number; output: number; lastInput?: number },
  task: string,
  roleId?: string,
  signal?: AbortSignal,
  observers?: Pick<RunOpts, "onProviderTurn" | "onToolRun"> & {
    onSubagentLifecycle?: SubagentLifecycleObserver;
  },
  boundProfileId?: string,
  expectedSpaceId?: string,
): Promise<string> {
  const executionProfileId = boundProfileId ?? runtimeProfileBindings.get(cfg);
  const assertAudience = (): void => {
    if (!expectedSpaceId) return;
    if (!executionProfileId) throw new Error("subagent session has no bound provider identity");
    assertProfileAudience(cfg, executionProfileId, expectedSpaceId);
  };
  assertAudience();
  const result = await subagentRuntimeFor(stats).run(NATIVE_SUBAGENT_PROVIDER_ID, {
    task,
    ...(roleId !== undefined ? { role: roleId } : {}),
    signal,
    baseProvider,
    cwd,
    sandbox,
    projectContext,
    profileId: executionProfileId,
    spaceId: expectedSpaceId,
    parentStats: stats,
    timeoutMs: cfg.runTimeoutMs,
    maxRounds: cfg.maxAgentRounds,
    ...(observers ? {
      observers: {
        onProviderTurn: observers.onProviderTurn,
        onToolRun: observers.onToolRun,
      },
    } : {}),
    isReadonlyTool: (name) => READONLY_TOOLS.has(name),
    assertAudience,
    resolveProvider: async (model, profileId) => {
      assertAudience();
      const resolved = await buildProvider(cfg, { model }, profileId);
      assertAudience();
      return resolved;
    },
  }, observers?.onSubagentLifecycle);
  return subagentResultText(result);
}

/** Check the hara setup and print a health summary (provider/auth/model/node/assets/roles). */
function roleMeta(role: Role): string {
  return [
    role.source,
    role.readOnly ? "read-only" : "",
    role.modelInvocable === false ? "explicit-only" : "",
    ...(role.compatibilityWarnings ?? []),
  ].filter(Boolean).join(" · ");
}

const packageRoot = resolve(here, "..");

function activeInstallation(): InstallationInfo {
  return inspectInstallation(packageRoot, { buildVersion: process.env.HARA_BUILD_VERSION });
}

function shadowInstallLines(installation: InstallationInfo): string[] {
  if (!installation.shadowCommands.length) return [];
  return [
    c.yellow(`⚠ ${installation.shadowCommands.length} other Hara command(s) are visible in PATH; switching Node or PATH can activate an older copy:`),
    ...installation.shadowCommands.map((path) => `  ${c.dim(path)}`),
  ];
}

async function runUpdateCommand(checkOnly: boolean): Promise<void> {
  const installation = activeInstallation();
  out(`${c.bold("hara update")}\n`);
  out(`  current ${c.bold(pkg.version)} · ${c.bold(installationLabel(installation))} · ${c.dim(installation.launchPath)}\n`);
  const latest = await fetchLatestVersion();
  if (!latest) {
    process.stderr.write("hara: could not reach the npm registry; no installation was changed.\n");
    process.exitCode = 1;
    return;
  }
  out(`  latest  ${c.bold(latest)}\n`);
  for (const line of shadowInstallLines(installation)) out(line + "\n");
  if (!isNewer(latest, pkg.version)) {
    out(c.green(`✓ the active ${installationLabel(installation)} is up to date\n`));
    if (installation.shadowCommands.length) {
      out(c.yellow("  The PATH copies above are separate installations; this check did not execute or modify them.\n"));
    }
    return;
  }
  if (checkOnly) {
    out(`  next    ${installation.kind === "npm" ? "run `hara update` without --check" : manualUpdateInstruction(installation)}\n`);
    return;
  }
  if (installation.kind !== "npm") {
    out(c.yellow("This installation cannot be replaced through npm.\n"));
    out(`  ${manualUpdateInstruction(installation)}\n`);
    process.exitCode = 2;
    return;
  }
  try {
    const result = upgradeNpmInstallation(installation, latest);
    out(c.green(`✓ upgraded and verified ${result.packageRoot} at ${result.version}\n`));
    out("  Restart Hara, then confirm with: hara --version\n");
    if (installation.shadowCommands.length) {
      out(c.yellow("  Only the active npm prefix was upgraded; the PATH copies listed above remain independent.\n"));
    }
  } catch (error) {
    process.stderr.write(`hara: update failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.stderr.write("No other Hara installation was modified. Run `hara doctor` to inspect active and shadow commands.\n");
    process.exitCode = 1;
  }
}

function doctorRuntime(cfg: HaraConfig): { live: HaraConfig; profile: Profile } {
  const boundProfileId = runtimeProfileBindings.get(cfg);
  const profile = boundProfileId
    ? profileByIdForConfig(cfg, boundProfileId)
    : profileForConfig(cfg).profile;
  if (!profile) throw new Error(`active profile '${boundProfileId}' is no longer available`);
  if (profile.kind === "gateway") {
    const requestedModel = boundProfileId ? cfg.model : undefined;
    return {
      profile,
      live: {
        ...cfg,
        provider: "hara-gateway",
        model: resolveGatewayModel(cfg, profile, process.env, requestedModel),
        baseURL: profile.baseURL || (profile.gatewayUrl ? `${profile.gatewayUrl.replace(/\/+$/, "")}/v1` : undefined),
        apiKey: profile.deviceToken,
      },
    };
  }
  const target = resolveByokProviderTarget(cfg, profile, false);
  return {
    profile,
    live: {
      ...cfg,
      provider: target.provider,
      model: target.model,
      baseURL: target.baseURL,
      apiKey: target.apiKey,
    },
  };
}

function runDoctor(cfg: HaraConfig): string {
  const { live, profile } = doctorRuntime(cfg);
  const ok = (b: boolean): string => (b ? c.green("✓") : c.red("✗"));
  const dot = c.dim("·");
  const nodeSupported = unsupportedNodeMessage() === null;
  const envKey = providerEnvKey(live.provider);
  const hasKey = !!(live.apiKey || (envKey ? process.env[envKey] : undefined) || process.env.HARA_API_KEY);
  const oauthOk = live.provider === "qwen-oauth" && loadQwenToken() !== null;
  const gatewayOk = profile.kind === "gateway" && !!profile.deviceToken && !deviceTokenExpired(profile.tokenExpiresAt);
  const authed = hasKey || oauthOk || gatewayOk || providerIsLocal(live.provider);
  const ad = assetsDir();
  const roles = loadActiveRoles(live.cwd, profile.id);
  const vcap = classifyVision(live.provider, live.model, live.modelVision);
  const visionRoute = visionRouteForProfile(live, profile);
  const visionAuthorized = visionSidecarAuthorized(
    visionRoute.model,
    authorizedVisionModelsForRoute(live, profile, spaceIdForProfile(profile)),
  );
  const imageStatus = visionRoute.model
    ? visionAuthorized
      ? c.dim("vision-first via ") + c.bold(visionRoute.model) + c.dim(` → text for ${live.model}`)
      : c.yellow(`vision-first ${visionRoute.model} is not authorized for this Space`)
    : vcap === "vision"
      ? c.dim("native on the conversation model")
      : vcap === "text"
        ? c.dim("off — configure visionModel or use an image-capable model")
        : c.dim("checked on first image");
  const installation = activeInstallation();
  const lines = [
    c.bold("hara doctor"),
    `${ok(nodeSupported)} node ${process.versions.node} ${c.dim(`(need ≥${MIN_NODE_VERSION})`)}`,
    `${dot} install ${c.bold(installationLabel(installation))} · ${c.dim(installation.launchPath)}`,
    ...shadowInstallLines(installation),
    `${dot} provider ${c.bold(live.provider)} · model ${c.bold(live.model)}${live.baseURL ? c.dim(" · " + live.baseURL) : ""}`,
    `${ok(authed)} auth ${providerIsLocal(live.provider) ? c.dim("not required (local endpoint)") : authed ? c.dim("configured") : c.yellow("missing — " + authHint(live, profile))}`,
    `${ok(existsSync(configPath()))} config ${c.dim(configPath())}`,
    `${dot} code-assets ${existsSync(ad) ? c.dim(ad) : c.dim("none — run: hara recall --init")}`,
    `${dot} roles ${roles.length ? c.dim(`${roles.length} (${roles.slice(0, 8).map((r) => r.id).join(", ")}${roles.length > 8 ? ", …" : ""})`) : c.dim("none — run: hara roles init")}`,
    `${dot} skills ${(() => { const n = loadSkillIndex(live.cwd).length; return n ? c.dim(`${n} (${loadSkillIndex(live.cwd).map((s) => s.id).slice(0, 6).join(", ")})`) : c.dim("none — run: hara skills init"); })()}`,
    `${dot} memory ${existsSync(join(homedir(), ".hara", "memory")) ? c.dim("~/.hara/memory + project") : c.dim("none yet (created on first write)")} ${c.dim("· evolve")} ${c.bold(live.evolve)} ${c.dim("· capture")} ${c.bold(live.assetCapture)}`,
    `${dot} search ${c.dim("lexical (always on)")}${live.embedProvider === "off" ? c.dim(" · semantic off (hara config set embedProvider ollama|qwen)") : c.dim(" · semantic ") + c.bold(live.embedProvider) + (() => { const idx = ["repo", "assets", "memory"].filter((n) => indexExists(n, live.cwd)); return c.dim(" · indexed: ") + (idx.length ? c.green(idx.join(", ")) : c.yellow("none — run: hara index --all")); })()}`,
    `${dot} images ${imageStatus}`,
    `${dot} screen ${live.computerUse === "off" ? c.dim("off (hara config set computerUse read|click|full)") : c.bold(live.computerUse) + c.dim(` · ${computerBackends()}${live.computerApps.length ? " · apps: " + live.computerApps.join(", ") : " · no app allowlist"}`)}`,
    `${dot} plugins ${(() => { const inst = listInstalled(); const on = enabledPlugins().length; return inst.length ? c.dim(`${on}/${inst.length} enabled: ${inst.map((p) => p.name).slice(0, 6).join(", ")}`) : c.dim("none — hara plugin add <source>"); })()}`,
    `${dot} mcp ${c.dim(`client: ${Object.keys({ ...pluginMcpServers(), ...live.mcpServers }).length} server(s) · serve: ${mcpServeToolNames().length} read tools via \`hara mcp\``)}`,
    `${dot} hooks ${(() => { const ph = pluginHooks(); const pre = (live.hooks.PreToolUse ?? []).length + (ph.PreToolUse ?? []).length; const post = (live.hooks.PostToolUse ?? []).length + (ph.PostToolUse ?? []).length; return pre + post ? c.dim(`${pre} pre · ${post} post`) : c.dim("none — config.json \"hooks\""); })()}`,
    `${dot} run-limits ${c.bold(formatAgentDuration(live.runTimeoutMs))}${c.dim(" active execution · ")}${c.bold(String(live.maxAgentRounds))}${c.dim(" rounds · sub-agents ≤8m/24")}`,
    `${dot} notify ${live.notify === "off" ? c.dim("off — hara config set notify bell|system") : c.bold(live.notify)}`,
    `${dot} cron ${(() => { try { const n = loadJobs().length; return n ? `${n} job(s) · ${isInstalled() ? c.green("scheduler installed") : c.yellow("scheduler off — hara cron install")}` : c.dim("no jobs — hara cron add"); } catch { return c.red("job store invalid — run hara cron list"); } })()}`,
    `${dot} input ${live.vimMode ? c.bold("vim") + c.dim(" (modal)") : c.dim("default — hara config set vimMode true for vim keys")}`,
  ];
  return lines.join("\n");
}

function mentionCompleter(line: string, cwd: string): [string[], string] {
  const m = /@([^\s@]*)$/.exec(line);
  if (!m) return [[], line];
  return [fileCandidates(cwd, m[1]).map((f) => "@" + f), "@" + m[1]];
}

interface Slash {
  name: string;
  aliases?: string[];
  desc: string;
  run: (args: string) => Promise<"exit" | void> | ("exit" | void);
}

function helpText(commands: Slash[]): string {
  const lines = commands.map((cmd) => `  /${cmd.name.padEnd(13)} ${c.dim(cmd.desc)}`);
  return c.bold("Commands:\n") + lines.join("\n") + "\n" + c.dim("  @path          attach a file's contents (Tab to complete)\n");
}

// Commander applies --cwd in a preAction hook. Retain the shell's launch directory so an interactive
// cross-workspace launch can offer to carry a very recent conversation instead of silently starting blank.
const invocationCwd = (() => {
  try {
    return realpathSync.native(process.cwd());
  } catch {
    return resolve(process.cwd());
  }
})();

const program = new Command();
program
  .name("hara")
  .description("A coding agent CLI that runs like an engineering org.")
  .version(pkg.version)
  .option("-p, --print <prompt>", "run a single prompt non-interactively, then exit")
  .option("--schema <json|file>", "(with -p) force a schema-shaped result: the model must call structured_output; stdout = that JSON")
  .option("--role <id>", "(with -p) run as a local, global:name, or project:name role (qualified projects run at their registered home)")
  .option("-y, --yes", "auto-approve all tool actions (= --approval full-auto)")
  .option("-m, --model <model>", "model id (overrides config)")
  .option("--approval <mode>", "approval mode: suggest | auto-edit | full-auto")
  .option("--profile <id>", "use this identity profile for this run (personal / org id) — see `hara profile list`")
  .option("--overlay <name>", "apply a named config overlay from ~/.hara/config.json (legacy: --profile)")
  .option("--cwd <dir>", "run from this explicit project directory (alternative to cd)")
  .option("--proxy <url>", "HTTP(S) proxy for model, organization, and web-tool traffic in this run")
  .option("--registry <url>", "package registry for installs in this run: npmjs, npmmirror, or an HTTP(S) URL")
  .option("--lang <tag>", "reply language for this run, for example zh-CN or en (default: follow latest message)")
  .option("-c, --continue", "resume the most recent session in this directory")
  .option("--resume <id>", "resume a specific session by id")
  .option("--sandbox <mode>", "sandbox the shell: off | workspace-write | read-only");

// Wire the global `--profile <id>` flag into the resolution chain BEFORE any subcommand
// action runs. resolveActive() consults setFlagOverride() at the top of the priority chain,
// so this single hook covers `hara whoami`, `hara profile list`, `hara model …`, and the
// default REPL action — without each subcommand having to reach into program.opts() itself.
// Validation: unknown id is a hard fail (don't silently fall through to default; the user
// asked for a specific identity, surface the mistake).
program.hook("preAction", (thisCmd) => {
  const cwdFlag = thisCmd.opts().cwd as string | undefined;
  if (cwdFlag) {
    try {
      const target = realpathSync.native(resolve(cwdFlag));
      if (!statSync(target).isDirectory()) throw new Error("not a directory");
      process.chdir(target);
    } catch (error) {
      out(c.red(`Cannot use --cwd '${cwdFlag}': ${error instanceof Error ? error.message : String(error)}.\n`));
      process.exit(2);
    }
  }
  const proxyFlag = thisCmd.opts().proxy as string | undefined;
  if (proxyFlag) {
    try {
      const parsed = new URL(proxyFlag);
      if (
        !(parsed.protocol === "http:" || parsed.protocol === "https:")
        || parsed.pathname !== "/"
        || parsed.search
        || parsed.hash
        || parsed.username
        || parsed.password
      ) throw new Error("invalid or credential-bearing proxy URL");
      process.env.HARA_WEB_PROXY = parsed.origin;
      process.env.HARA_MODEL_PROXY = parsed.origin;
    } catch {
      out(c.red("Cannot use --proxy: provide an HTTP(S) origin such as http://127.0.0.1:7890. Put authenticated proxy URLs in `hara config set proxy …` or HTTPS_PROXY so credentials do not enter the process list.\n"));
      process.exit(2);
    }
  }
  const languageFlag = thisCmd.opts().lang as string | undefined;
  if (languageFlag) {
    if (languageFlag === "auto") delete process.env.HARA_REPLY_LANGUAGE;
    else if (/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,3}$/u.test(languageFlag)) {
      process.env.HARA_REPLY_LANGUAGE = languageFlag;
    } else {
      out(c.red("Cannot use --lang: provide a language tag such as zh-CN or en, or use auto.\n"));
      process.exit(2);
    }
  }
  const registryFlag = thisCmd.opts().registry as string | undefined;
  if (registryFlag) {
    try {
      process.env.HARA_PACKAGE_REGISTRY = normalizePackageRegistry(registryFlag);
    } catch {
      out(c.red("Cannot use --registry: provide npmjs, npmmirror, or an HTTP(S) registry URL without credentials/query/fragment.\n"));
      process.exit(2);
    }
  }
  const flag = thisCmd.opts().profile as string | undefined;
  if (!flag) return;
  if (!getProfile(flag)) {
    out(c.red(`No identity profile '${flag}'.\n`) + c.dim("List: `hara profile list`\n"));
    process.exit(1);
  }
  setFlagOverride(flag);
});

program
  .command("init")
  .description("analyze the project and (re)generate AGENTS.md")
  .action(async () => {
    const cfg = loadConfig();
    const planProfile = profileForConfig(cfg).profile;
    const profileId = planProfile.id;
    if (isUnsafeProjectWorkspace(cfg.cwd)) {
      out(c.red(homeWorkspaceActionError("initialize AGENTS.md")) + "\n");
      process.exitCode = 2;
      return;
    }
    const provider = await buildProvider(cfg, undefined, profileId);
    if (!provider) {
      out(c.red(`Not authenticated for provider '${cfg.provider}'.\n`) + authHint(cfg) + "\n");
      process.exit(1);
    }
    out(c.dim("Analyzing project to generate AGENTS.md…\n"));
    await runInit(provider, cfg.cwd, cfg.sandbox, cfg, profileId, spaceIdForProfile(planProfile));
  });

program
  .command("sessions")
  .description("list saved sessions")
  .action(async () => {
    await ensureSessionMetadataIndex();
    const metas = recentSessionMetadata({ sources: ["interactive"], limit: 100 });
    if (!metas.length) {
      out(c.dim("No sessions yet.\n"));
      return;
    }
    for (const m of metas) {
      out(`${c.bold(shortId(m.id))}  ${c.dim(m.updatedAt.slice(0, 16).replace("T", " "))}  ${c.dim(m.provider + ":" + m.model)}  ${m.title || c.dim("(untitled)")}\n`);
      out(`          ${c.dim(displaySessionCwd(m.cwd))}\n`);
    }
    if (metas.length === 100) out(c.dim("(showing the 100 most recent interactive sessions)\n"));
    out(c.dim("\nResume:  hara resume <id>\n"));
  });

program
  .command("resume [id]")
  .description("resume a session in its saved project — no id resumes the most recent here")
  .action(async (id?: string) => {
    await ensureSessionMetadataIndex();
    const target = resolveSessionResumeTarget(id, process.cwd());
    if (!target.ok) {
      if (target.reason === "not-found") {
        out(c.red(`No session matching '${id ?? ""}'.`) + c.dim(" Run `hara sessions` to list.\n"));
        process.exitCode = 1;
      } else if (target.reason === "no-current") {
        out(c.dim("No sessions for this directory yet — `hara sessions` lists all projects.\n"));
      } else if (target.reason === "unreadable") {
        out(c.red(`Session ${shortId(target.id ?? id ?? "")} exists but is unreadable or corrupt; refusing to resume it.\n`));
        process.exitCode = 2;
      } else {
        out(c.red(`Session ${shortId(target.id ?? id ?? "")} belongs to ${target.cwd}, but that project directory is unavailable.\n`));
        process.exitCode = 2;
      }
      return;
    }
    out(c.dim(`↩ resuming ${shortId(target.id)} in ${displaySessionCwd(target.cwd)}…\n`));
    // Reuse the existing --resume path exactly (one engine), inheriting this terminal. selfArgv() inside
    // runSelfAttached distinguishes node+entry from a Bun-compiled binary (whose argv[1] is a user arg).
    // Launch from the persisted project root: the low-level --resume engine intentionally refuses a
    // foreign cwd so a transcript can never be reinterpreted against the wrong repository.
    try {
      const result = await runSelfAttached(["--resume", target.id], target.cwd);
      if (result.signal) {
        out(c.yellow(`Resumed Hara process stopped by ${result.signal}.\n`));
        process.exitCode = 1;
      } else if (result.code) {
        process.exitCode = result.code;
      }
    } catch (error) {
      out(c.red(`Could not start the resumed Hara process: ${error instanceof Error ? error.message : String(error)}\n`));
      process.exitCode = 1;
    }
  });

program
  .command("org <task...>")
  .description("dispatch a task to the owning role and run it (--review loops a reviewer until it approves)")
  .option("--role <id>", "force a specific role")
  .option("--review", "after implementing, loop a reviewer role until it approves (implement → review → fix)")
  .option("--rounds <n>", "max review rounds with --review (default 3)", (v) => parseInt(v, 10))
  .option("--commit", "commit the result with an AI message (with --review: only after approval; needs a clean start tree)")
  .action(async (
    taskParts: string[],
    _localOpts: { role?: string; review?: boolean; rounds?: number; commit?: boolean },
    command: Command,
  ) => {
    // The root headless command and `org` both expose --role. Commander stores that shared flag on the
    // parent command, while review/rounds/commit stay local; optsWithGlobals is the supported merged view.
    // Without it, flow-approved `hara org --role ...` children silently fell back to model dispatching.
    const opts2 = command.optsWithGlobals() as { role?: string; review?: boolean; rounds?: number; commit?: boolean };
    let cfg = loadConfig();
    let orgProfileId = profileForConfig(cfg).profile.id;
    const initialOrgProfile = profileByIdForConfig(cfg, orgProfileId);
    if (initialOrgProfile?.kind === "gateway") {
      try {
        await ensureOrganizationExecutionPolicy(cfg, initialOrgProfile, spaceIdForProfile(initialOrgProfile));
      } catch (error) {
        const message = isOrganizationAuthorizationRejection(error)
          ? organizationAuthorizationRecoveryMessage()
          : redactSensitiveText(error instanceof Error ? error.message : String(error)).text;
        process.stderr.write(`hara: organization policy sync failed — ${message}\n`);
        process.exitCode = 2;
        return;
      }
    }
    // Home dispatch (globally addressable, executes at home): a --role of "project:name" — or a bare name
    // that only exists in a REGISTERED project — resolves via the global agent index and runs with cwd =
    // that project (its AGENTS.md/data context), instead of failing or running context-blind here.
    let orgCwd = cfg.cwd;
    let forceRole = opts2.role;
    if (opts2.role && (opts2.role.includes(":") || !loadActiveRoles(cfg.cwd, orgProfileId).some((r) => r.id === opts2.role))) {
      const hit = resolveAgent(opts2.role, cfg.cwd, orgProfileId);
      if (hit && "ambiguous" in hit) {
        out(c.yellow(`'${opts2.role}' exists in several projects — qualify it:\n`) + hit.ambiguous.map((e) => `  ${e.project}:${e.name}`).join("\n") + "\n");
        process.exit(1);
      }
      if (hit?.home) {
        orgCwd = hit.home;
        forceRole = hit.name;
        cfg = loadConfig({ cwd: hit.home });
        orgProfileId = profileForConfig(cfg).profile.id;
        out(c.dim(`(dispatching to ${hit.project}:${hit.name} · home ${hit.home})\n`));
      } else if (hit) {
        // Explicit `global:name` is an address, not the literal role id. Global roles intentionally run
        // in the caller's current project so they retain that project's AGENTS.md and tool context.
        forceRole = hit.name;
        out(c.dim(`(dispatching to global:${hit.name} · current home ${orgCwd})\n`));
      } else if (!hit) {
        out(c.red(`No agent '${opts2.role}' was found here or in the registered project index.\n`));
        process.exit(1);
      }
    }
    const provider = await buildProvider(cfg, undefined, orgProfileId);
    if (!provider) {
      out(c.red(`Not authenticated for provider '${cfg.provider}' at ${orgCwd}.\n`) + authHint(cfg) + "\n");
      process.exit(1);
    }
    const orgProfile = profileByIdForConfig(cfg, orgProfileId);
    if (!orgProfile) {
      out(c.red(`Organization connection '${orgProfileId}' is no longer available.\n`));
      process.exit(1);
    }
    const stats = { input: 0, output: 0, lastInput: 0 };
    const outcome = await runOrg(taskParts.join(" "), {
      cfg,
      baseProvider: provider,
      profileId: orgProfileId,
      spaceId: spaceIdForProfile(orgProfile),
      cwd: orgCwd,
      sandbox: cfg.sandbox,
      approval: "full-auto",
      approvalChannel: false,
      confirm: async () => true,
      projectContext: loadAgentContext(orgCwd) || undefined,
      stats,
      forceRole,
      review: opts2.review,
      rounds: opts2.rounds,
      commit: opts2.commit,
    });
    const failure = runFailureDetail(outcome);
    if (failure) {
      process.stderr.write(`hara: org run failed (${outcome.status}) — ${failure}\n`);
      process.exitCode = 2;
    }
    if (stats.input || stats.output) out(statusLine(cfg.model, stats.input, stats.output) + "\n");
  });

program
  .command("agents")
  .description("global agent index — every addressable agent (global roles + registered projects) and its home")
  .action(() => {
    const idx = buildAgentsIndex();
    if (!idx.length) {
      out(c.dim("(no agents — add roles to ~/.hara/roles or ~/.claude/agents, install OpenClaw/Hermes identities, or register projects: hara projects add <name> <path>)\n"));
      return;
    }
    for (const e of idx) {
      const ref = e.project ? `${e.project}:${e.name}` : `global:${e.name}`;
      const displayName = e.identity?.displayName;
      out(c.bold(ref) + (displayName && displayName !== e.name ? `  ${displayName}` : "") + c.dim(e.home ? `  · ${e.home}` : "  · current project") + "\n");
      if (e.description) out(c.dim(`  ${e.description.slice(0, 120)}\n`));
    }
    out(c.dim(`\n${idx.length} agent(s). Run one: hara org --role <global:name|project:name> "<task>"\n`));
  });

const projectsCmd = program.command("projects").description("register project homes for the global agent index (see `hara agents`)");
projectsCmd.command("list").action(() => {
  const list = loadProjects();
  out(list.length ? list.map((p) => `${c.bold(p.name)}  ${c.dim(p.path)}`).join("\n") + "\n" : c.dim("(none — hara projects add <name> <path>)\n"));
});
projectsCmd.command("add <name> <path>").action((name: string, path: string) => {
  const err = addProject(name, resolve(path));
  out(err ? c.red(`${err}\n`) : c.green(`✓ registered ${name} → ${resolve(path)}\n`));
  if (err) process.exit(1);
});
projectsCmd.command("remove <name>").action((name: string) => {
  out(removeProject(name) ? c.green(`✓ removed ${name}\n`) : c.yellow(`no project '${name}'\n`));
});

program
  .command("plan [task...]")
  .description("decompose a task into atoms, sequence them (DAG), and execute each with a verify gate")
  .option("--parallel", "run independent atoms (same dependency wave) concurrently")
  .action(async (taskParts: string[], opts: { parallel?: boolean }) => {
    const cfg = loadConfig();
    const planProfile = profileForConfig(cfg).profile;
    const profileId = planProfile.id;
    const provider = await buildProvider(cfg, undefined, profileId);
    if (!provider) {
      out(c.red(`Not authenticated for provider '${cfg.provider}'.\n`) + authHint(cfg) + "\n");
      process.exit(1);
    }
    const stats = { input: 0, output: 0, lastInput: 0 };
    const o: OrgOpts = {
      cfg,
      baseProvider: provider,
      profileId,
      spaceId: spaceIdForProfile(planProfile),
      cwd: cfg.cwd,
      sandbox: cfg.sandbox,
      approval: "full-auto",
      approvalChannel: false,
      confirm: async () => true,
      projectContext: loadAgentContext(cfg.cwd) || undefined,
      stats,
      parallel: opts.parallel,
    };
    const task = (taskParts ?? []).join(" ").trim();
    let outcome: RunOutcome | undefined;
    if (task === "resume") outcome = await runResume(o);
    else if (!task) out(c.dim('usage: hara plan "<task>"   (or: hara plan resume)\n'));
    else outcome = await runPlan(task, o);
    if (outcome) {
      const failure = runFailureDetail(outcome);
      if (failure) {
        process.stderr.write(`hara: plan run failed (${outcome.status}) — ${failure}\n`);
        process.exitCode = 2;
      }
    }
    if (stats.input || stats.output) out(statusLine(cfg.model, stats.input, stats.output) + "\n");
  });

program
  .command("recall [query...]")
  .description("search your code-asset library (~/.hara/code-assets) for snippets/playbooks")
  .option("--init", "scaffold the code-assets directory with an example")
  .action(async (parts: string[], opts2: { init?: boolean }) => {
    if (opts2.init) {
      const w = scaffoldAssets();
      out(w.length ? c.green(`Scaffolded ${assetsDir()}: ${w.join(", ")}\n`) : c.dim(`Assets already exist at ${assetsDir()}\n`));
      return;
    }
    const q = (parts ?? []).join(" ");
    if (!q) return void out(c.dim("usage: hara recall <query>   (or: hara recall --init)\n"));
    const hits = await searchHybrid(q, process.cwd(), { indexName: "assets", roots: assetSearchRoots(process.cwd()) });
    if (!hits.length) return void out(c.dim(`No matches in ${assetsDir()} (add .md files, or run: hara recall --init)\n`));
    for (const h of hits) out(`${c.cyan(h.path)}  ${c.dim(h.title)}\n`);
  });

program
  .command("index")
  .description("build the semantic index (opt-in; needs an embedding provider)")
  .option("--repo", "index the current project — for codebase_search (default)")
  .option("--assets", "index your global code-assets, skills & memory — for recall / memory_search")
  .option("--all", "index everything")
  .action(async (opts: { repo?: boolean; assets?: boolean; all?: boolean }) => {
    const cfg = loadConfig();
    const cwd = process.cwd();
    let doRepo = !!(opts.all || opts.repo || (!opts.assets && !opts.all));
    const doAssets = !!(opts.all || opts.assets);
    if (doRepo && isUnsafeProjectWorkspace(cwd)) {
      if (!doAssets) {
        out(c.red(homeWorkspaceActionError("build a repository index")) + "\n");
        process.exitCode = 2;
        return;
      }
      out(c.yellow(homeWorkspaceActionError("build the repository part of --all")) + c.dim(" Global assets/memory will still be indexed.\n"));
      doRepo = false;
    }
    const embed = getEmbedder(cfg);
    if (!embed) {
      out(c.yellow("Semantic search is off — search stays lexical (which still works).\n"));
      out(c.dim("Turn it on with an embedding provider, then re-run `hara index`:\n"));
      out(c.dim("  hara config set embedProvider ollama   # local & offline (needs Ollama + an embed model)\n"));
      out(c.dim("  hara config set embedProvider qwen     # DashScope text-embedding-v3 (uses your key)\n"));
      return;
    }
    const model = `${cfg.embedProvider}:${cfg.embedModel ?? "default"}`;
    const build = async (name: string, chunks: Chunk[], blurb: string): Promise<void> => {
      if (!chunks.length) return void out(c.dim(`Nothing to index for ${name}.\n`));
      out(c.dim(`Indexing ${chunks.length} ${name} chunks with ${cfg.embedProvider}…\n`));
      try {
        const r = await buildIndex(name, chunks, embed, cwd, model);
        const detail = r.reused ? `${r.embedded} embedded, ${r.reused} reused` : `${r.embedded} embedded`;
        out(c.green(`Indexed ${r.total} chunks`) + c.dim(` (${detail}) → ${indexPath(name, cwd)} · ${blurb}`) + "\n");
      } catch (e) {
        out(c.red(`Indexing ${name} failed: ${(e as Error).message}\n`));
        out(c.dim("Check the embedding endpoint/key; search still works lexically.\n"));
      }
    };
    const collectionOptions = {
      maxFiles: 50_000,
      maxDirectories: 100_000,
      maxEntries: 500_000,
      timeoutMs: 60_000,
      yieldEvery: 128,
    };
    const noteTruncation = (name: string, collection: ChunkCollectionResult): void => {
      if (collection.truncated) {
        out(c.yellow(`Index collection for ${name} stopped at its ${collection.reason?.replace("_", " ") ?? "safety limit"}; the partial index is not being published.\n`));
      }
    };
    if (doRepo) {
      const repo = await collectRepoChunksAsync(findProjectRoot(cwd), collectionOptions);
      noteTruncation("repo", repo);
      if (!repo.truncated) await build("repo", repo.chunks, "codebase_search");
    }
    if (doAssets) {
      const [assets, skills, memory] = await Promise.all([
        collectDirChunksAsync(assetsDir(), "code-assets", collectionOptions),
        collectDirChunksAsync(globalSkillsDir(), "skills", collectionOptions),
        collectDirChunksAsync(memoryDir("global", cwd), "memory", collectionOptions),
      ]);
      noteTruncation("assets", assets);
      noteTruncation("skills", skills);
      noteTruncation("memory", memory);
      if (!assets.truncated && !skills.truncated) {
        await build("assets", [...assets.chunks, ...skills.chunks], "recall");
      }
      if (!memory.truncated) await build("memory", memory.chunks, "memory_search");
    }
  });

program
  .command("doctor")
  .description("check your hara setup (install / provider / auth / model / node / assets / roles)")
  .action(() => out(runDoctor(loadConfig()) + "\n"));

program
  .command("update")
  .alias("upgrade")
  .description("update the active Hara installation and verify the resulting version")
  .option("--check", "check the latest version and installation source without changing anything")
  .action(async (opts: { check?: boolean }) => runUpdateCommand(opts.check === true));

program
  .command("setup")
  .description("interactive first-run setup — pick a provider, API key, and model")
  .action(runSetup);

// ────────────────────────────────────────────────────────────────────────────────
// Identity profiles — the single switch for "who am I as right now" (personal vs each
// org I belong to). Switching a profile flips provider, key/token, base URL, AND the
// default model the gateway / setup chose. See src/profile/profile.ts.
// ────────────────────────────────────────────────────────────────────────────────

function fmtProfile(p: Profile, mark = ""): string {
  const kindBadge = p.kind === "gateway" ? c.bold(c.cyan("ORG")) : c.bold(c.dim("PERSONAL"));
  const label = p.label ? `${c.bold(p.label)} ` : "";
  const model = effectiveModel(p) || c.dim("(unset)");
  const route = routingLabel(p);
  return `${mark} ${kindBadge}  ${label}${c.dim("[" + p.id + "]")}  ${c.dim("· model")} ${model}  ${c.dim("· →")} ${route}`;
}

/** Human-readable suffix for the active row: "(active · <where it came from>)".
 *  pin gets a relative file path; flag/env/default each get their own tag. */
function activeSuffix(r: ActiveResolution): string {
  switch (r.source) {
    case "flag":
      return c.dim("(active · ") + c.bold("--profile flag") + c.dim(")");
    case "env":
      return c.dim("(active · ") + c.bold("HARA_PROFILE env") + c.dim(")");
    case "pin": {
      const rel = r.pinFile ? relPath(r.pinFile) : ".hara-profile";
      return c.dim("(active · ") + c.bold("pinned by " + rel) + c.dim(")");
    }
    case "default":
      return c.dim("(active · ") + c.bold("global default") + c.dim(")");
    case "fallback":
      return c.dim("(active · fallback)");
  }
}

/** Render an absolute path relative to cwd. Same-dir paths get `./` for clarity
 *  ("pinned by ./.hara-profile" reads better than "pinned by .hara-profile" because
 *  the leading `.` of the filename is otherwise hard to spot). Parent-dir pins keep
 *  their relative form (`../../.hara-profile`) — still way more readable than absolute. */
function relPath(abs: string): string {
  try {
    const r = relative(process.cwd(), abs);
    if (!r) return ".";
    // r could be: ".hara-profile", "sub/.hara-profile", "../.hara-profile".
    // For the same-cwd hit we want `./.hara-profile` — start with "./" unless it already
    // navigates with ".." (which speaks for itself).
    if (r.startsWith("..")) return r;
    return "./" + r;
  } catch {
    return abs;
  }
}

/** Stable "▶ active" line — first thing printed at startup so the user always sees where requests
 *  are going. Tests look for this prefix; keep the format. */
export function activeProfileLine(p: Profile): string {
  const route = routingLabel(p);
  const model = effectiveModel(p) || "(unset)";
  return `▶ ${p.label || p.id} · ${model} · ${route}`;
}

/** Shared whoami body so the `profile current` alias reuses the same output exactly. */
function printWhoami(): void {
  const r = resolveActive();
  const p = loadActiveProfile();
  out(c.bold("active profile") + "  " + activeSuffix(r) + "\n" + fmtProfile(p, " ") + "\n");
  if (p.kind === "gateway") {
    out(c.dim(`  gateway:  ${p.gatewayUrl}\n`));
    if (p.deviceId) out(c.dim(`  device:   ${p.deviceId.length > 8 ? "…" + p.deviceId.slice(-8) : p.deviceId}\n`));
    if (p.availableModels?.length) out(c.dim(`  available: ${p.availableModels.join(", ")}\n`));
    if (p.tokenExpiresAt) out(c.dim(`  expires:  ${p.tokenExpiresAt}\n`));
    const warning = deviceTokenExpiryWarning(p.tokenExpiresAt);
    if (warning) out(c.yellow(`  ⚠ ${warning}\n`));
  } else {
    out(c.dim(`  provider: ${p.provider}\n`));
    if (p.baseURL) out(c.dim(`  baseURL:  ${p.baseURL}\n`));
    out(c.dim(`  key:      ${p.apiKey ? maskKey(p.apiKey) : "(env / unset)"}\n`));
  }
}

program
  .command("whoami")
  .description("show the active identity profile (label · model · routing target · source)")
  .action(printWhoami);

const profileCmd = program.command("profile").description("manage identity profiles (personal / org A / org B…)");

// `profile current` — nvm muscle-memory ("nvm current" → "hara profile current"). Same as `hara whoami`.
profileCmd
  .command("current")
  .description("alias of `hara whoami` — print the active identity profile (with source)")
  .action(printWhoami);

// ── `profile list` (alias `ls`) ────────────────────────────────────────────────
// Layout: profiles grouped by kind (PERSONAL above ORG), one line per profile, columns
// aligned across the whole table (so id/model/routing visually stack). Active row is
// prefixed with `→ *` (so you can read it at a glance even in copy-pasted output) and
// suffixed with the source tag. Footer is a 2-line hint pointing at the two switching
// gestures: `profile use <id>` (write the default), `profile pin <id>` (lock this dir).
function renderProfileList(): string {
  const r = resolveActive();
  const ps = listProfiles();
  const lines: string[] = [];
  // Group by kind so the "where am I in the world" stratification is visible.
  const groups: Array<{ kind: "byok" | "gateway"; title: string; rows: Profile[] }> = [
    { kind: "byok", title: "PERSONAL", rows: ps.filter((p) => p.kind === "byok") },
    { kind: "gateway", title: "ORG", rows: ps.filter((p) => p.kind === "gateway") },
  ];
  // Column widths from raw (un-styled) strings — styling never participates in padding.
  const idW = Math.max(2, ...ps.map((p) => p.id.length));
  const labelW = Math.max(0, ...ps.map((p) => (p.label || "").length));
  const modelW = Math.max(5, ...ps.map((p) => (effectiveModel(p) || "(unset)").length));
  for (const g of groups) {
    if (!g.rows.length) continue;
    if (lines.length) lines.push(""); // blank between groups
    lines.push(c.dim(g.title));
    for (const p of g.rows) {
      const isActive = p.id === r.id;
      const mark = isActive ? c.green("→ *") : "   ";
      const id = p.id.padEnd(idW, " ");
      const label = (p.label || "").padEnd(labelW, " ");
      const model = (effectiveModel(p) || "(unset)").padEnd(modelW, " ");
      const route = routingLabel(p);
      const tail = isActive ? "  " + activeSuffix(r) : "";
      const cols = `${mark}  ${c.dim("[")}${c.bold(id)}${c.dim("]")}  ${label}  ${c.dim("· model")} ${model}  ${c.dim("· →")} ${route}${tail}`;
      lines.push(cols);
    }
  }
  // Tail hint — nudge users toward the two everyday gestures.
  lines.push("");
  lines.push(c.dim("💡 use ") + "`hara profile use <id>`" + c.dim(" to switch · ") + "`hara profile pin <id>`" + c.dim(" to lock to this dir"));
  return lines.join("\n");
}

profileCmd
  .command("list")
  .alias("ls")
  .description("list all profiles (active marked with → *) — alias: `ls`")
  .action(() => {
    out(renderProfileList() + "\n");
  });

profileCmd
  .command("use <id>")
  .description("switch the active profile (echoes the diff: profile / model / routing)")
  .option("-y, --yes", "skip confirmation when switching INTO a gateway profile from BYOK")
  .action(async (id: string, opts: { yes?: boolean }) => {
    const before = loadActiveProfile();
    const target = getProfile(id);
    if (!target) {
      out(c.red(`No profile '${id}'.\n`) + c.dim("List: `hara profile list`\n"));
      process.exit(1);
    }
    // Safety: BYOK → gateway is the direction that changes where your traffic goes (from your own
    // key to a controlled gateway). Confirm unless -y. The reverse direction is allowed silently
    // but the diff is still echoed.
    if (before.kind === "byok" && target.kind === "gateway" && !opts.yes) {
      const ok = await askConfirm(`Switch to gateway profile '${id}' (${target.gatewayUrl})? Traffic will route through the org gateway.`);
      if (!ok) {
        out(c.dim("(unchanged)\n"));
        return;
      }
    }
    const r = useProfile(id);
    if (!r.ok) {
      out(c.red(r.reason + "\n"));
      process.exit(1);
    }
    const after = r.profile;
    const modelBefore = effectiveModel(before) || "(unset)";
    const modelAfter = effectiveModel(after) || "(unset)";
    const routeBefore = routingLabel(before);
    const routeAfter = routingLabel(after);
    out(c.green("✓ switched\n"));
    out(`  profile:  ${c.dim(before.id)} ${c.dim("→")} ${c.bold(after.id)}\n`);
    out(`  model:    ${c.dim(modelBefore)} ${c.dim("→")} ${c.bold(modelAfter)}\n`);
    out(`  routing:  ${c.dim(routeBefore)} ${c.dim("→")} ${c.bold(routeAfter)}\n`);
  });

profileCmd
  .command("add <id>")
  .description("add a new identity profile (gateway = `hara enroll`; byok = your own key)")
  .option("--gateway <url>", "(gateway) join this hara-control gateway")
  .option("--code <code>", "(gateway) enrollment code from your admin")
  .option("--label <label>", "human-friendly label for the profile")
  .option("--byok", "(byok) BYOK profile — bring your own provider key")
  .option("--provider <id>", "(byok/local) anthropic | token-plan | minimax-token-plan | volcengine-agent-plan | openai-compatible | openai | glm | deepseek | openrouter | ollama | lmstudio (legacy: qwen | qwen-oauth)")
  .option("--key <key>", "(byok) API key for scripts; omit in a terminal for masked input")
  .option("--no-key-prompt", "(byok) do not prompt for a missing API key; resolve it from the provider environment at use-time")
  .option("--base-url <url>", "(byok) override the provider base URL (OpenAI-compatible endpoints)")
  .option("--model <model>", "(byok) default model for this profile")
  .action(async (id: string, opts: { gateway?: string; code?: string; label?: string; byok?: boolean; provider?: string; key?: string; keyPrompt?: boolean; baseUrl?: string; model?: string }, command: Command) => {
    if (opts.gateway) {
      if (!opts.code) return void out(c.red("gateway profile add needs --code <code> from your hara-control admin\n"));
      try {
        const { enrollment: e } = await enrollGatewayProfile({
          id,
          label: opts.label || id,
          gatewayUrl: opts.gateway,
          code: opts.code,
        });
        out(c.green(`✓ enrolled and switched to '${id}' (${e.gatewayUrl})`) + c.dim(` · model ${e.model || "(gateway default)"}\n`));
        const nRoles = await syncOrgRoles();
        if (nRoles > 0) out(c.dim(`  ↳ synced ${nRoles} org role${nRoles === 1 ? "" : "s"} → ~/.hara/org-roles/\n`));
      } catch (err) {
        out(c.red(`Enroll failed: ${err instanceof Error ? err.message : String(err)}\n`));
        process.exit(1);
      }
      return;
    }
    if (opts.byok || opts.provider) {
      const requestedProvider = opts.provider || "anthropic";
      const providerAlias = requestedProvider === "openai-compatible";
      const resolvedProvider = providerAlias ? "openai" : requestedProvider;
      if (!isProviderId(resolvedProvider)) {
        out(c.red(`Unknown provider '${requestedProvider}'. Run \`hara setup\` to see supported providers.\n`));
        process.exit(1);
      }
      const provider = resolvedProvider;
      if (provider === "hara-gateway") {
        out(c.red("`--provider hara-gateway` is retired — use --gateway <url> --code <code> instead.\n"));
        process.exit(1);
      }
      if (providerAlias && !opts.baseUrl?.trim()) {
        out(c.red("`--provider openai-compatible` requires --base-url <https-url>.\n"));
        process.exit(1);
      }
      const preset = providerCatalog().find((entry) => entry.id === provider)!;
      // Commander assigns an option name shared with the root command to the root even when it appears
      // after this subcommand. Read the merged option view so `profile add ... --model X` cannot silently
      // fall back to the provider preset while the success message claims X was stored.
      const requestedModel = opts.model ?? command.optsWithGlobals().model;
      let providedApiKey = opts.key;
      if (
        providedApiKey === undefined
        && opts.keyPrompt !== false
        && providerRequiresApiKey(provider)
        && stdin.isTTY
      ) {
        const rl = createInterface({ input: stdin, output: stdout });
        try {
          providedApiKey = (await readSecret(
            `API key ${c.dim(`(masked; blank = use the ${providerEnvKey(provider)} env var)`)}: `,
            rl,
          )).trim() || undefined;
        } catch (error) {
          if (error instanceof Error && error.message === "cancelled") {
            out(c.dim("(cancelled)\n"));
            process.exitCode = 130;
            return;
          }
          throw error;
        } finally {
          rl.close();
        }
      }
      let normalized;
      try {
        normalized = normalizePersonalProviderConfig({
          provider,
          apiKey: providedApiKey,
          baseURL: opts.baseUrl ?? preset.defaultBaseURL,
          model: requestedModel ?? preset.defaultModel,
        });
      } catch (err) {
        out(c.red(`Invalid provider profile: ${err instanceof Error ? err.message : String(err)}\n`));
        process.exit(1);
      }
      const p: Profile = {
        id,
        kind: "byok",
        label: opts.label || id,
        provider: normalized.provider,
        apiKey: normalized.apiKey,
        baseURL: normalized.baseURL,
        defaultModel: normalized.model,
      };
      const r = addProfile(p);
      if (!r.ok) {
        out(c.red(r.reason + "\n"));
        process.exit(1);
      }
      const providerLabel = providerAlias ? "openai-compatible" : provider;
      out(c.green(`✓ added BYOK profile '${id}'`) + c.dim(` · provider ${providerLabel} · model ${normalized.model}\n`));
      out(c.dim(`Switch to it with \`hara profile use ${id}\`.\n`));
      return;
    }
    out(c.red("usage:\n") + c.dim("  hara profile add <id> --gateway <url> --code <code> [--label …]\n") + c.dim("  hara profile add <id> --byok --provider anthropic|token-plan|minimax-token-plan|volcengine-agent-plan|openai-compatible|openai|glm|deepseek|openrouter|ollama|lmstudio [--base-url … --model …]\n"));
    process.exit(1);
  });

profileCmd
  .command("remove <id>")
  .alias("rm")
  .alias("uninstall")
  .description("remove a profile (active falls back to personal) — aliases: `rm`, `uninstall`")
  .action((id: string) => {
    // Capture the profile before removal so we can mention the gateway host in the token-hint
    // line (5 below). After removeProfile, getProfile(id) is gone.
    const before = getProfile(id);
    if (before?.kind === "gateway") removeProfileCreds(id);
    const r = removeProfile(id);
    if (!r.ok) {
      out(c.red(r.reason + "\n"));
      process.exit(1);
    }
    if (r.activeChanged) {
      // Single line that reads naturally: "removed 'X' · active → personal".
      out(c.green(`✓ removed '${id}'`) + c.dim(` · active → ${PERSONAL_ID}\n`));
    } else {
      out(c.green(`✓ removed '${id}'\n`));
    }
    // For gateway profiles: we deliberately do NOT phone the control plane to revoke the device
    // token (that's a privileged operation that needs admin auth + we don't want a stale CLI
    // calling production). Print a one-line hint so the user knows the *server-side* identity
    // outlives this local removal — and who to ask if they want it gone there too.
    if (r.removedKind === "gateway") {
      const host = (() => {
        try {
          return before?.gatewayUrl ? new URL(before.gatewayUrl).host : (before?.gatewayUrl || "the gateway");
        } catch {
          return before?.gatewayUrl || "the gateway";
        }
      })();
      out(c.dim(`💡 token left registered at ${host}; ask your admin to revoke if needed\n`));
    }
  });

// ── `.hara-profile` project pin (like .nvmrc but personal — keep it out of repos) ─────
profileCmd
  .command("pin [id]")
  .description("write `.hara-profile` in this dir to lock the active profile here (omit id = pin current active)")
  .action(async (id?: string) => {
    const target = (id && id.trim()) || activeId();
    if (!getProfile(target)) {
      out(c.red(`No profile '${target}'.\n`) + c.dim("List: `hara profile list`\n"));
      process.exit(1);
    }
    try {
      const { file } = await writePin(process.cwd(), target);
      out(c.green(`✓ pinned ${target} to ${relPath(file)}\n`));
      // .hara-profile carries personal identity (which org you're as), unlike .nvmrc which
      // is project-level. Nudge user toward GLOBAL gitignore so they don't accidentally
      // commit it. We intentionally do NOT modify .gitignore — that's user space.
      out(c.dim("💡 .hara-profile is personal identity — add it to your global gitignore (unlike .nvmrc, don't commit it)\n"));
    } catch (err) {
      out(c.red(`pin failed: ${err instanceof Error ? err.message : String(err)}\n`));
      process.exit(1);
    }
  });

profileCmd
  .command("unpin")
  .description("remove `.hara-profile` from this dir")
  .action(() => {
    const file = pinFilePath(process.cwd());
    const ok = removePin(process.cwd());
    if (ok) out(c.green(`✓ unpinned`) + c.dim(` · removed ${relPath(file)}\n`));
    else out(c.dim(`(no ${relPath(file)} here — nothing to unpin)\n`));
  });

// ── per-profile model switching ──────────────────────────────────────────────────
const modelCmd = program.command("model").description("manage the model on the active profile");
modelCmd
  .command("list")
  .description("list models for the active profile (gateway profiles list what the control plane advertised)")
  .action(() => {
    const p = loadActiveProfile();
    const cur = effectiveModel(p);
    if (p.kind === "gateway") {
      const list = p.availableModels?.length ? p.availableModels : (p.defaultModel ? [p.defaultModel] : []);
      if (!list.length) {
        out(c.dim("(gateway didn't advertise any models — use the gateway default; `hara model use <id>` to override locally)\n"));
        return;
      }
      for (const m of list) out(`${m === cur ? c.green("*") : " "} ${m}\n`);
    } else {
      // BYOK has no constrained list — show the current effective + suggestion.
      out(`${c.green("*")} ${cur || c.dim("(unset)")}\n`);
      out(c.dim("(BYOK profiles accept any model id the provider supports — `hara model use <id>` to switch)\n"));
    }
  });
modelCmd
  .command("use <model>")
  .description("override the model on the active profile (validated against availableModels on gateway profiles)")
  .action((model: string) => {
    const id = activeId();
    const r = setProfileModel(id, model);
    if (!r.ok) {
      out(c.red(r.reason + "\n"));
      process.exit(1);
    }
    out(c.green(`✓ model → ${model}`) + c.dim(` (profile ${id})\n`));
  });
modelCmd
  .command("reset")
  .description("clear the per-profile model override → fall back to defaultModel")
  .action(() => {
    const id = activeId();
    const r = resetProfileModel(id);
    if (!r.ok) {
      out(c.red(r.reason + "\n"));
      process.exit(1);
    }
    const p = loadActiveProfile();
    out(c.green(`✓ reset`) + c.dim(` · effective model → ${effectiveModel(p) || "(unset)"}\n`));
  });

// ── `hara enroll` — kept as a convenience alias mapping to the default-org gateway profile.
program
  .command("enroll [gateway-url]")
  .description("alias of `hara profile add default-org --gateway <url> --code <code>` (B-end: join a fleet)")
  .option("--code <code>", "enrollment code from your hara-control admin")
  .option("--status", "alias of `hara whoami`")
  .option("--clear", "switch active profile back to personal (does NOT delete the gateway profile)")
  .action(async (gatewayUrl: string | undefined, opts: { code?: string; status?: boolean; clear?: boolean }) => {
    if (opts.status) {
      printWhoami();
      return;
    }
    if (opts.clear) {
      // Behavior change: don't *delete* the gateway profile (keeps the token around for re-use);
      // just switch active back to personal. Legacy clearEnrollment() also called to remove any
      // stray org.json file from pre-migration installs.
      clearEnrollment();
      const r = useProfile(PERSONAL_ID);
      return void out(r.ok ? c.green("✓ active → personal") + c.dim(" — gateway profile preserved (remove with `hara profile remove default-org`)\n") : c.dim("(no change)\n"));
    }
    if (!gatewayUrl) return void out(c.red("usage: hara enroll <gateway-url> --code <code>   (or --status / --clear)\n"));
    if (!opts.code) return void out(c.red("Need --code <code> — ask your hara-control admin to issue an enrollment code.\n"));
    try {
      const e = await enrollDevice(gatewayUrl, opts.code);
      upsertGatewayProfileFromEnrollment(DEFAULT_ORG_ID, "Default Org", e);
      useProfile(DEFAULT_ORG_ID);
      out(c.green(`✓ enrolled with ${e.gatewayUrl}`) + c.dim(` · device ${e.deviceId || "?"} · model ${e.model || "(gateway default)"} · profile ${DEFAULT_ORG_ID}\n`) + c.dim("hara routes through the gateway now — the real provider key stays server-side.\n"));
      const nRoles = await syncOrgRoles();
      if (nRoles > 0) out(c.dim(`  ↳ synced ${nRoles} org role${nRoles === 1 ? "" : "s"} → ~/.hara/org-roles/\n`));
    } catch (err) {
      out(c.red(`Enroll failed: ${err instanceof Error ? err.message : String(err)}\n`));
    }
  });

program
  .command("permissions")
  .description("show or scaffold command permission rules (bash allow/ask/deny + read-only autorun)")
  .option("--init", "write a starter permissions.json")
  .option("--project", "with --init, write it in this project (.hara/permissions.json) instead of globally")
  .action((opts: { init?: boolean; project?: boolean }) => {
    if (opts.init) {
      const p = scaffoldPermissions(process.cwd(), opts.project ? "project" : "global");
      return void out(p ? c.green(`✓ wrote ${p}\n`) : c.dim("(permissions file already exists — edit it directly)\n"));
    }
    const r = loadPermissionRules(process.cwd());
    const pp = projectPermissionsPath(process.cwd());
    out(
      c.bold("Command permissions") +
        c.dim(" (bash) — deny blocks even in full-auto; allow / read-only auto-runs even in suggest\n") +
        `  ${c.dim("global: ")} ${globalPermissionsPath()}\n` +
        `  ${c.dim("project:")} ${pp ?? "(none)"}\n` +
        `  ${c.dim("read-only autorun:")} ${r.readonlyAutorun ? c.green("on") : "off"}\n` +
        `  ${c.green("allow")}: ${r.allow.length ? r.allow.join(", ") : c.dim("(none)")}\n` +
        `  ${c.red("deny")} : ${r.deny.length ? r.deny.join(", ") : c.dim("(none)")}\n` +
        c.dim("  edit the JSON to customize, or `hara permissions --init` for a starter.\n"),
    );
  });

const gatewayCommand = program
  .command("gateway")
  .description("run a supported chat gateway so you can drive your local hara from your phone — opt-in daemon")
  .option("--platform <name>", "chat platform: telegram | weixin | discord | feishu | slack | mattermost | matrix | dingtalk | wecom | signal")
  .option("--login", "(weixin) scan a QR to log in and save credentials, then exit")
  .option("--recover-outcome <message-id>", "recover exactly one interrupted/terminal run marker by its original platform message id")
  .option("--confirm-recovery <action:message-id>", "required exact confirmation: terminalize:<id> or delete-terminal:<id>")
  .option("--cwd <dir>", "directory hara operates in per message (default: ~/.hara/workspace)");

gatewayCommand
  .command("status")
  .description("show redacted configuration, live process, connection, poll, and error state")
  .option("--json", "print stable machine-readable JSON")
  .action(async (opts: { json?: boolean }, command) => {
    const mod = await import("./gateway/serve.js");
    const platform = command.parent?.opts().platform as string | undefined;
    const statuses = platform
      ? [await mod.gatewayStatus(platform)]
      : await mod.listGatewayStatuses();
    if (opts.json) {
      out(`${JSON.stringify(platform ? statuses[0] : { gateways: statuses }, null, 2)}\n`);
      return;
    }
    const timestamp = (value: number | undefined): string => value ? new Date(value).toISOString() : "never";
    for (const [index, status] of statuses.entries()) {
      if (index) out("\n");
      out(
        `${c.bold(`${status.label} (${status.platform})`)}\n` +
        `  configuration: ${status.configuration}\n` +
        `  process: ${status.running ? `running${status.pid ? ` (pid ${status.pid})` : ""}` : "stopped"}` +
        `${status.runningInstances > 1 ? ` · ${status.runningInstances} credential-scoped instances` : ""}\n` +
        `  transport: ${status.runtimeState}\n` +
        `  started: ${timestamp(status.startedAt)}\n` +
        `  last connected/poll/message: ${timestamp(status.lastConnectedAt)} / ${timestamp(status.lastPollAt)} / ${timestamp(status.lastMessageAt)}\n` +
        `  last error: ${status.lastErrorCode ?? "none"}${status.lastErrorAt ? ` at ${timestamp(status.lastErrorAt)}` : ""}\n` +
        `  action: ${status.recommendation}\n`,
      );
    }
  });

gatewayCommand.action(async (opts) => {
  const mod = await import("./gateway/serve.js");
  const platform = opts.platform || "telegram";
  if (opts.recoverOutcome !== undefined || opts.confirmRecovery !== undefined) {
    if (typeof opts.recoverOutcome !== "string" || typeof opts.confirmRecovery !== "string") {
      throw new Error("gateway outcome recovery requires both --recover-outcome <message-id> and --confirm-recovery <action:message-id>");
    }
    const result = await mod.recoverGatewayRunOutcome({
      platform,
      messageId: opts.recoverOutcome,
      confirmation: opts.confirmRecovery,
    });
    if (result === "missing") out(c.yellow("No outcome marker exists for that message id and gateway credential.\n"));
    else if (result === "terminalized") {
      out(c.green("✓ interrupted marker converted to terminal; one active slot is free and coding remains blocked from rerun.\n"));
    } else if (result === "already-terminal") {
      out(c.yellow("Marker is already terminal. Delete it only after platform redelivery is impossible, using delete-terminal:<same-message-id>.\n"));
    } else {
      out(c.yellow("✓ terminal marker removed. This message id is no longer protected if the platform redelivers it later.\n"));
    }
    return;
  }
  if (platform === "weixin" && opts.login) {
    await mod.weixinLogin();
    return;
  }
  const cwd = opts.cwd ? (await import("node:path")).resolve(opts.cwd) : undefined; // undefined → ~/.hara/workspace
  await mod.runGateway({ cwd, platform });
});

program
  .command("serve")
  .description("run the local hara server (WebSocket JSON-RPC) that desktop shells / IDE clients drive — persistent sessions, streaming events, approval round-trips")
  .option("--host <host>", "bind address — keep it loopback unless you know what you're doing", "127.0.0.1")
  .option("--port <n>", "port to listen on", "8790")
  .option("--token <token>", "auth token (default: generated; written to ~/.hara/serve.json for clients to discover)")
  .option("--cwd <dir>", "default working directory for new sessions (default: current directory)")
  .option("--approval <mode>", "default approval mode for sessions: suggest | auto-edit | full-auto", "auto-edit")
  .action(async (o) => {
    const cwd = o.cwd ? (await import("node:path")).resolve(o.cwd) : process.cwd();
    const sessionLockRecovery = reclaimOrphanedSessionLocks();
    if (sessionLockRecovery.scanned > 0 || sessionLockRecovery.deferred > 0) {
      out(c.dim(
        `hara: session locks checked ${sessionLockRecovery.scanned}`
        + ` · reclaimed ${sessionLockRecovery.reclaimed}`
        + ` · live ${sessionLockRecovery.live}`
        + ` · malformed ${sessionLockRecovery.malformed}`
        + ` · deferred ${sessionLockRecovery.deferred}\n`,
      ));
    }
    const cfg = loadConfig({ cwd });
    const initialProfile = profileForConfig(cfg).profile;
    if (initialProfile.kind === "gateway") {
      try {
        await ensureOrganizationExecutionPolicy(cfg, initialProfile);
      } catch (error) {
        // Desktop must still open Settings and Personal recovery surfaces when a formerly active company
        // enrollment expires or is revoked. Company inference remains fail-closed because every provider
        // build/turn below performs the same required policy refresh before sending history.
        const message = isOrganizationAuthorizationRejection(error)
          ? organizationAuthorizationRecoveryMessage()
          : redactSensitiveText(error instanceof Error ? error.message : String(error)).text;
        process.stderr.write(`hara: company connection needs attention — ${message}\n`);
      }
    }
    const provider0 = await withRouting(await buildProvider(cfg), cfg);
    const guardianOpt = await buildGuardian(cfg, provider0);
    const sandbox = (process.env.HARA_SANDBOX ?? cfg.sandbox ?? "off") as SandboxMode;
    const approval = (APPROVAL_MODES as readonly string[]).includes(o.approval) ? (o.approval as ApprovalMode) : "auto-edit";
    const { startServe } = await import("./serve/server.js");
    const { GatewayLoginManager } = await import("./gateway/login.js");
    const gatewayLogins = new GatewayLoginManager();
    const controlPlaneRefreshAt = new Map<string, number>();
    const refreshSessionControlPlane = async (
      profile: Profile,
      targetCwd: string,
      live: HaraConfig,
      expectedSpaceId = spaceIdForProfile(profile),
    ): Promise<void> => {
      if (expectedSpaceId === PERSONAL_ID) return;
      const organizationProfile = profile.kind === "gateway"
        ? profile
        : organizationEnrollmentForSpace(live, expectedSpaceId);
      if (!organizationProfile) {
        throw new Error(`company Space '${expectedSpaceId}' is no longer enrolled; refusing company inference`);
      }
      const enrollment = enrollmentFromProfile(organizationProfile);
      if (!enrollment) return;
      await ensureOrganizationExecutionPolicy(live, profile, expectedSpaceId);
      const now = Date.now();
      if (now - (controlPlaneRefreshAt.get(organizationProfile.id) ?? 0) < 60_000) return;
      controlPlaneRefreshAt.set(organizationProfile.id, now);
      void heartbeatEnrollment(enrollment, undefined, { profileId: organizationProfile.id });
      void syncOrganizationLearningsFromControl(organizationProfile.id, {
        cwd: targetCwd,
        organizationScopeId: expectedSpaceId,
      }).catch(() => undefined);
    };
    const handle = await startServe(
      { host: o.host, port: Number(o.port) || 8790, token: o.token, cwd },
      {
        version: pkg.version,
        providerId: cfg.provider,
        model: cfg.model,
        // `hara serve` is persistent, but config.json is user-editable at any time. Re-read it for every
        // new/resumed session and model operation so a repaired/rotated key takes effect without restarting
        // the desktop server (and, critically, never ask for a key that is already on disk).
        buildSessionProvider: async (targetCwd, profileId, spaceId) => {
          const live = loadConfig({ cwd: targetCwd ?? cwd });
          const profile = profileId ? profileByIdForConfig(live, profileId) : profileForConfig(live).profile;
          if (!profile) throw new Error(`session profile '${profileId}' is no longer available; re-enroll that connection or start a new session with an existing profile`);
          const expectedSpaceId = spaceId ?? spaceIdForProfile(profile);
          assertProfileAudience(live, profile.id, expectedSpaceId);
          await refreshSessionControlPlane(profile, targetCwd ?? cwd, live, expectedSpaceId);
          return withRouting(
            await buildProvider(live, undefined, profileId, expectedSpaceId),
            live,
            profileId,
            expectedSpaceId,
          );
        },
        buildProviderFor: async (model, effort, targetCwd, profileId, spaceId) => {
          const live = loadConfig({ cwd: targetCwd ?? cwd });
          const profile = profileId ? profileByIdForConfig(live, profileId) : profileForConfig(live).profile;
          if (!profile) throw new Error(`session profile '${profileId}' is no longer available; re-enroll that connection or start a new session with an existing profile`);
          const expectedSpaceId = spaceId ?? spaceIdForProfile(profile);
          assertProfileAudience(live, profile.id, expectedSpaceId);
          await refreshSessionControlPlane(profile, targetCwd ?? cwd, live, expectedSpaceId);
          if (
            profile.kind === "gateway"
            && profile.availableModels?.length
            && !profile.availableModels.includes(model)
          ) {
            throw new Error(`model '${model}' is not authorized for organization connection '${profile.id}'`);
          }
          const resolvedEffort = effort === null
            ? undefined
            : effort !== undefined
            ? effort as HaraConfig["reasoningEffort"]
            : profile.kind === "gateway"
              ? gatewayDefaultReasoningEffort(profile, model)
              : profile.id === PERSONAL_ID
                ? live.reasoningEffort
                : profile.reasoningEffort as HaraConfig["reasoningEffort"];
          const runtimeCfg = { ...live, reasoningEffort: resolvedEffort };
          return withRouting(
            await buildProvider(
              runtimeCfg,
              { model },
              profileId,
              expectedSpaceId,
              effort === null ? null : resolvedEffort,
            ),
            runtimeCfg,
            profileId,
            expectedSpaceId,
          );
        },
        listModels: async (targetCwd, profileId, spaceId) => {
          const live = loadConfig({ cwd: targetCwd ?? cwd });
          const profile = profileId ? profileByIdForConfig(live, profileId) : profileForConfig(live).profile;
          if (!profile) throw new Error(`session profile '${profileId}' is no longer available`);
          const expectedSpaceId = spaceId ?? spaceIdForProfile(profile);
          assertProfileAudience(live, profile.id, expectedSpaceId);
          if (profile.kind === "gateway") {
            const policy = await ensureOrganizationExecutionPolicy(live, profile, expectedSpaceId);
            const allowed = (models: string[]): string[] => models.filter((model) => {
              try {
                if (policy) assertOrganizationModelAllowed(policy, model);
                return true;
              } catch {
                return false;
              }
            });
            if (profile.availableModels?.length) return allowed([...profile.availableModels]);
            const baseURL = profile.baseURL || (profile.gatewayUrl ? `${profile.gatewayUrl.replace(/\/+$/, "")}/v1` : undefined);
            return allowed(await listModels(
              baseURL,
              profile.deviceToken ?? "",
              createModelFetch(live.proxy),
            ));
          }
          const target = resolveByokProviderTarget(live, profile, false);
          const models = await listModels(
            target.baseURL,
            target.apiKey ?? "",
            createModelFetch(live.proxy),
          );
          if (expectedSpaceId === PERSONAL_ID) return models;
          const policy = await ensureOrganizationExecutionPolicy(live, profile, expectedSpaceId);
          return models.filter((model) => {
            try {
              if (policy) assertOrganizationModelAllowed(policy, model);
              return true;
            } catch {
              return false;
            }
          });
        },
        prepareImages: async (images, opts) => {
          const live = loadConfig({ cwd: opts.cwd });
          const profileId = opts.profileId ?? PERSONAL_ID;
          const profile = assertProfileAudience(live, profileId, opts.spaceId);
          const target = profile.kind === "gateway"
            ? { provider: "hara-gateway", model: opts.model }
            : { ...resolveByokProviderTarget(live, profile, false), model: opts.model };
          const vision = visionRouteForProfile(live, profile);
          if (vision.model) {
            const authorizedModels = authorizedVisionModelsForRoute(live, profile, opts.spaceId);
            if (!visionSidecarAuthorized(vision.model, authorizedModels)) {
              throw new Error(
                `vision-first model '${vision.model}' is not authorized for company Space '${opts.spaceId}'`,
              );
            }
            if (profile.kind === "gateway" && vision.source === "custom") {
              throw new Error("company vision routing must reuse the managed provider connection");
            }
            const visionProviderId = visionProviderForRoute(live, vision, target.provider);
            if (classifyVision(visionProviderId, vision.model, live.modelVision) !== "vision") {
              throw new Error(`vision-first model '${vision.model}' is not confirmed to accept image input`);
            }
            if (vision.source === "custom" && providerRequiresApiKey(visionProviderId) && !vision.apiKey) {
              throw new Error("the independent vision interface is missing its API key");
            }
            const visionProvider = await buildProvider(live, {
              ...(vision.source === "custom"
                ? { provider: visionProviderId, baseURL: vision.baseURL, apiKey: vision.apiKey }
                : {}),
              model: vision.model,
            }, profileId, opts.spaceId, null, true);
            assertProfileAudience(live, profileId, opts.spaceId);
            if (!visionProvider) {
              throw new Error(`vision-first model '${vision.model}' is not authenticated for profile '${profile.id}'`);
            }
            const description = await describeImages(visionProvider, images, { signal: opts.signal });
            assertProfileAudience(live, profileId, opts.spaceId);
            return { description, viaModel: vision.model };
          }
          const native = classifyVision(target.provider, opts.model, live.modelVision);
          if (native === "vision") return { images };
          throw new Error(
            native === "text"
              ? `model '${opts.model}' cannot read images; configure a vision-first model or switch this conversation to an image-capable model`
              : (
                  `image capability for model '${opts.model}' is unknown; ` +
                  "choose a model with advertised image support or set a modelVision override"
                ),
          );
        },
        providerSettings: (targetCwd) => providerSettingsSnapshot(targetCwd ?? cwd),
        testVisionSettings: (input, targetCwd) => testVisionSettingsCandidate(input, targetCwd ?? cwd),
        saveVisionSettings: async (input, targetCwd) => saveVisionSettings(input, targetCwd ?? cwd),
        unpinProjectProfile: (targetCwd) => {
          const settingsCwd = targetCwd ?? cwd;
          const removed = unpinResolvedProjectProfile(settingsCwd);
          return {
            removed,
            providers: providerSettingsSnapshot(settingsCwd),
            organizations: organizationConnectionsSnapshot(settingsCwd),
          };
        },
        gatewayStatuses: async () => {
          const gateway = await import("./gateway/serve.js");
          return gateway.listGatewayStatuses(["weixin", "feishu"]);
        },
        startGatewayLogin: (platform) => gatewayLogins.start(platform),
        gatewayLoginStatus: (platform, id) => gatewayLogins.status(platform, id),
        cancelGatewayLogin: (platform, id) => gatewayLogins.cancel(platform, id),
        closeGatewayLogins: () => gatewayLogins.close(),
        organizationConnections: (targetCwd) => organizationConnectionsSnapshot(targetCwd ?? cwd),
        spaces: (targetCwd) => spaceDirectorySnapshot(targetCwd ?? cwd),
        useSpace: (spaceId, targetCwd) => useSpaceConnection(spaceId, targetCwd ?? cwd),
        enrollOrganizationConnection: async (input, targetCwd) => {
          const settingsCwd = targetCwd ?? cwd;
          const resolution = resolveActive(settingsCwd);
          if (input.activate !== false && (resolution.source === "flag" || resolution.source === "env" || resolution.source === "pin")) {
            throw new Error("the active profile is locked by a flag, environment variable, or project pin; remove that override before activating an organization connection");
          }
          await enrollGatewayProfile(input, AbortSignal.timeout(30_000));
          return organizationConnectionsSnapshot(settingsCwd);
        },
        useOrganizationConnection: (inputId, targetCwd) => {
          const settingsCwd = targetCwd ?? cwd;
          const id = assertOrganizationId(inputId);
          const target = getProfile(id);
          if (!target || target.kind !== "gateway") throw new Error("organization connection was not found");
          const resolution = resolveActive(settingsCwd);
          if (resolution.source === "flag" || resolution.source === "env" || resolution.source === "pin") {
            throw new Error("the active profile is locked by a flag, environment variable, or project pin; remove that override before switching");
          }
          const switched = useProfile(id);
          if (!switched.ok) throw new Error("organization connection could not be activated");
          return organizationConnectionsSnapshot(settingsCwd);
        },
        removeOrganizationConnection: (inputId, targetCwd) => {
          const settingsCwd = targetCwd ?? cwd;
          const id = assertOrganizationId(inputId);
          const target = getProfile(id);
          if (!target || target.kind !== "gateway") throw new Error("organization connection was not found");
          removeProfileCreds(id);
          const removed = removeProfile(id);
          if (!removed.ok) throw new Error("organization connection could not be removed");
          return organizationConnectionsSnapshot(settingsCwd);
        },
        checkOrganizationConnection: async (inputId) => {
          const id = assertOrganizationId(inputId);
          const profile = getProfile(id);
          if (!profile || profile.kind !== "gateway") throw new Error("organization connection was not found");
          const enrollment = enrollmentFromProfile(profile);
          const ok = !!enrollment
            && !deviceTokenExpired(enrollment.expiresAt)
            && await heartbeatEnrollment(enrollment, AbortSignal.timeout(15_000), { profileId: id });
          return { id, ok, checkedAt: Date.now() };
        },
        organizationLearningSubmit: async (profileId, organizationScopeId, candidateId, targetCwd) => {
          const learningCwd = targetCwd ?? cwd;
          const candidate = listLearnings({
            cwd: learningCwd,
            profileId: organizationScopeId,
            scope: "organization",
            limit: 1_000,
          }).find((item) => item.id === candidateId || item.clientId === candidateId || item.remoteId === candidateId);
          if (!candidate) throw new Error("organization learning candidate not found");
          return submitOrganizationLearningToControl(profileId, candidate, {
            cwd: learningCwd,
            organizationScopeId,
          });
        },
        organizationLearningSync: (profileId, organizationScopeId, targetCwd) => syncOrganizationLearningsFromControl(
          profileId,
          { cwd: targetCwd ?? cwd, organizationScopeId },
        ),
        deskConnections: () => localDeskConnectionsSnapshot(
          listProfiles()
            .filter((profile) => profile.kind === "gateway")
            .map(deskOrganizationIdentity),
        ),
        deskSnapshot: fetchDeskSnapshotForProfile,
        deskTask: fetchDeskTaskForProfile,
        testProviderSettings: (input) => testProviderSettingsCandidate(input),
        createProviderConnection: (input, targetCwd) => createNamedProviderConnection(
          input,
          targetCwd ?? cwd,
        ),
        testProviderConnection: (inputId, targetCwd) => testNamedProviderConnection(
          inputId,
          targetCwd ?? cwd,
        ),
        useProviderConnection: (inputId, targetCwd) => useNamedProviderConnection(
          inputId,
          targetCwd ?? cwd,
        ),
        removeProviderConnection: (inputId, targetCwd) => removeNamedProviderConnection(
          inputId,
          targetCwd ?? cwd,
        ),
        saveProviderSettings: async (input, targetCwd) => {
          const settingsCwd = targetCwd ?? cwd;
          if (!isProviderId(input.provider) || input.provider === "hara-gateway") {
            throw new Error("provider is not a configurable personal provider");
          }
          if (providerEnvironmentOverride()) {
            throw new Error("provider/model/base URL is overridden by HARA_* environment variables; remove the override before editing System Settings");
          }
          const resolution = resolveActive(settingsCwd);
          const liveBefore = loadConfig({ cwd: settingsCwd });
          const switchLocked = resolution.source === "flag" || resolution.source === "env" || resolution.source === "pin";
          if (
            resolution.id !== PERSONAL_ID
            && input.activatePersonal === true
            && switchLocked
          ) {
            throw new Error(`profile '${resolution.id}' is selected by ${resolution.source}; switch or unpin it before activating Personal`);
          }
          const normalized = normalizePersonalProviderConfig({
            provider: input.provider,
            model: input.model,
            baseURL: input.baseURL,
            apiKey: input.apiKey,
            clearApiKey: input.clearApiKey,
            reasoningEffort: input.reasoningEffort as HaraConfig["reasoningEffort"],
            clearReasoningEffort: input.clearReasoningEffort,
          });
          assertPersonalReasoningEffort(
            normalized.provider,
            normalized.baseURL,
            normalized.model,
            normalized.reasoningEffort,
          );
          const currentPersonal = profileByIdForConfig(liveBefore, PERSONAL_ID)!;
          const currentTarget = resolveByokProviderTarget(liveBefore, currentPersonal, false, {});
          const reusableRaw = {
            provider: currentTarget.provider,
            baseURL: currentTarget.baseURL,
            apiKey: currentTarget.apiKey,
          };
          const availableKey = reusablePersonalProviderApiKey(normalized, reusableRaw);
          if (providerRequiresApiKey(normalized.provider) && !availableKey) {
            throw new Error("a new API key is required when the provider or endpoint changes");
          }
          const storedKey = normalized.apiKey
            ?? reusablePersonalProviderApiKey(normalized, reusableRaw, {});
          updatePersonalProviderConfig({
            ...normalized,
            ...(input.reasoningEffort !== undefined
              ? { reasoningEffort: input.reasoningEffort as HaraConfig["reasoningEffort"] }
              : {}),
            ...(input.clearReasoningEffort === true ? { clearReasoningEffort: true } : {}),
            ...(storedKey ? { apiKey: storedKey } : {}),
          });
          syncStoredPersonalProfile();
          if (input.activatePersonal === true) {
            const switched = useProfile(PERSONAL_ID);
            if (!switched.ok) throw new Error(switched.reason);
          }
          return providerSettingsSnapshot(settingsCwd);
        },
        effortLevels: levelsFor(
          resolvePlatform(
            cfg.provider,
            cfg.baseURL ?? providerDefaultBaseURL(cfg.provider),
            undefined,
            cfg.model,
          ).reasoning,
          cfg.model,
        ).filter((e): e is NonNullable<typeof e> => !!e),
        runtimeInfo: (targetCwd, selectedModel, profileId, spaceId) => {
          const live = loadConfig({ cwd: targetCwd ?? cwd });
          const profile = profileId ? profileByIdForConfig(live, profileId) : profileForConfig(live).profile;
          if (!profile) throw new Error(`session profile '${profileId}' is no longer available; re-enroll that connection or start a new session with an existing profile`);
          const expectedSpaceId = spaceId ?? spaceIdForProfile(profile);
          assertProfileAudience(live, profile.id, expectedSpaceId);
          const organizationProfile = expectedSpaceId === PERSONAL_ID
            ? null
            : profile.kind === "gateway"
              ? profile
              : organizationEnrollmentForSpace(live, expectedSpaceId);
          const current = profileId
            ? profile.kind === "gateway"
              ? {
                  provider: "hara-gateway",
                  model: process.env.HARA_MODEL || effectiveModel(profile) || live.model,
                  baseURL: profile.baseURL || (profile.gatewayUrl ? `${profile.gatewayUrl.replace(/\/+$/, "")}/v1` : undefined),
                }
              : resolveByokProviderTarget(live, profile, false)
            : providerSettingsSnapshot(targetCwd ?? cwd).current;
          const model = selectedModel ?? current.model;
          const inferredEfforts = levelsFor(
            resolvePlatform(current.provider, current.baseURL, undefined, model).reasoning,
            model,
          ).filter((e): e is NonNullable<typeof e> => !!e);
          const advertisedEfforts = profile.kind === "gateway"
            ? gatewayReasoningEffortLevels(profile, model)
            : undefined;
          const reasoningStyle = resolvePlatform(
            current.provider,
            current.baseURL,
            undefined,
            model,
          ).reasoning;
          const defaultReasoningEffort = profile.kind === "gateway"
            ? gatewayDefaultReasoningEffort(profile, model)
            : (profile.id === PERSONAL_ID ? live.reasoningEffort : profile.reasoningEffort)
              ? normalizeEffort(
                  reasoningStyle,
                  model,
                  (profile.id === PERSONAL_ID ? live.reasoningEffort : profile.reasoningEffort) as NonNullable<HaraConfig["reasoningEffort"]>,
                )
              : undefined;
          const visionRoute = visionRouteForProfile(live, profile);
          return {
            providerId: current.provider,
            model,
            profileId: profile.id,
            profileKind: profile.kind,
            spaceId: expectedSpaceId,
            ...(organizationProfile ? { organizationProfileId: organizationProfile.id } : {}),
            effortLevels: advertisedEfforts ?? inferredEfforts,
            ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
            attachmentCapabilities: effectiveAttachmentCapabilities(
              current.provider,
              model,
              live.modelVision,
              visionRoute.model,
              expectedSpaceId === PERSONAL_ID
                ? undefined
                : organizationProfile?.availableModels ?? [],
            ),
            ...(profile.kind === "gateway" && profile.availableModels?.length
              ? { availableModels: [...profile.availableModels] }
              : {}),
          };
        },
        autoCompact: (targetCwd) => {
          const live = loadConfig({ cwd: targetCwd ?? cwd });
          return {
            enabled: live.autoCompact,
            tokenCap: autoCompactTokenCap(process.env.HARA_AUTO_COMPACT_TOKENS),
          };
        },
        runLimits: (targetCwd) => agentRunLimits(loadConfig({ cwd: targetCwd ?? cwd })),
        spawnSubagent: (provider, scwd, projectContext, stats, task, role, signal, observers, profileId, spaceId) => {
          const live = loadConfig({ cwd: scwd });
          return runSubagent(live, provider, scwd, sandbox, projectContext, stats, task, role, signal, observers, profileId, spaceId);
        },
        guardian: guardianOpt,
        buildGuardian: async (targetCwd, profileId, spaceId) => {
          const live = loadConfig({ cwd: targetCwd ?? cwd });
          const boundProfileId = profileId ?? PERSONAL_ID;
          if (!spaceId) throw new Error("session has no durable Space binding");
          assertProfileAudience(live, boundProfileId, spaceId);
          const base = await withRouting(
            await buildProvider(live, undefined, profileId, spaceId),
            live,
            profileId,
            spaceId,
          );
          assertProfileAudience(live, boundProfileId, spaceId);
          const guardian = await buildGuardian(live, base, profileId, spaceId);
          assertProfileAudience(live, boundProfileId, spaceId);
          return guardian;
        },
        sandbox,
        approval,
      },
    );
    const setupStatus = provider0 ? `${cfg.provider}:${cfg.model}` : `setup required · ${cfg.provider}:${cfg.model}`;
    out(c.bold("hara serve") + c.dim(`  ·  ws://${o.host}:${handle.port}  ·  ${setupStatus}  ·  approval ${approval}  ·  token → ~/.hara/serve.json\n`));
    const bye = async (): Promise<void> => {
      await handle.close();
      process.exit(0);
    };
    process.on("SIGINT", bye);
    process.on("SIGTERM", bye);
  });

program
  .command("remote [action] [text]")
  .description("register THIS tmux pane for explicit /remote send relays from chat. actions: ask \"<q>\" | bind | back | status")
  .action(async (action = "status", text?: string) => {
    const { registerTmuxRoute, unbindPane, listRoutes } = await import("./gateway/tmux-routes.js");
    const pane = process.env.TMUX_PANE; // set by tmux inside every pane
    const needPane = (): void => {
      if (!pane) {
        out(c.red("`hara remote` must run inside tmux ($TMUX_PANE unset) — it injects chat replies into a tmux pane.\n"));
        process.exit(2);
      }
    };
    if (action === "status") {
      const rs = listRoutes();
      out(rs.length ? rs.map((r) => `${r.pane}  [${r.mode ?? "once"} · ${r.peer ? "chat-bound" : "legacy-unscoped"}]  ${r.cwd ?? ""}`).join("\n") + "\n" : "(no panes registered)\n");
      return;
    }
    if (action === "unbind" || action === "back") {
      needPane();
      out(unbindPane(pane!) ? `✓ ${action === "back" ? "back from remote — unbound" : "unbound"} ${pane}\n` : `${pane} was not registered\n`);
      return;
    }
    const resolveWeixinPeer = async () => {
      const wx = await import("./gateway/weixin.js");
      const creds = wx.loadWeixinCreds() ?? undefined;
      const configured = process.env.HARA_WX_PEER?.trim();
      if (configured) return { peer: configured, wx, creds };
      if (!creds) return { wx };
      const peers = wx.weixinKnownPeers(creds.account_id);
      return { peer: peers.find((candidate) => candidate.endsWith("@im.wechat")) || peers[0], wx, creds };
    };
    if (action === "bind") {
      needPane();
      const { peer } = await resolveWeixinPeer();
      if (!peer) {
        out(c.red("No known WeChat chat to bind. Log in/start the WeChat gateway or set HARA_WX_PEER, then retry. No route was created.\n"));
        process.exitCode = 2;
        return;
      }
      registerTmuxRoute(pane!, peer, process.cwd(), "bind");
      out(c.green(`🔗 bound ${pane}`) + ` to one WeChat chat for 12 hours — ordinary chat stays in Hara; use \`/remote send <message>\` explicitly, renew with \`hara remote bind\`, or unbind locally.\n`);
      return;
    }
    if (action === "ask") {
      needPane();
      if (!text) return void out(c.red('usage: hara remote ask "<question>"\n'));
      try {
        const { peer, wx, creds } = await resolveWeixinPeer();
        if (!wx || !creds || !peer) {
          out(c.red("No known WeChat chat. Log in/start the WeChat gateway or set HARA_WX_PEER. No route was created.\n"));
          process.exitCode = 2;
          return;
        }
        registerTmuxRoute(pane!, peer, process.cwd(), "once");
        await wx.weixinAdapter(creds).send(peer, `${text}\n\n回复本地终端请使用：/remote send <回复内容>`);
        out(c.green(`↩ asked on WeChat + registered ${pane}`) + ` for that chat for 30 minutes — answer explicitly with \`/remote send <reply>\`; ordinary chat is never injected.\n`);
      } catch (e: any) {
        unbindPane(pane!);
        out(c.yellow(`WeChat push failed (${e.message}); the temporary route was removed. Retry when the gateway is available.\n`));
      }
      return;
    }
    out(c.red(`unknown action '${action}'. use: ask "<q>" | bind | back | status\n`));
  });

program
  .command("export [session]")
  .description("export a session to a Markdown transcript (default: the latest in this directory)")
  .option("--out <file>", "write to a file instead of stdout")
  .action(async (sessionArg: string | undefined, opts: { out?: string }) => {
    await ensureSessionMetadataIndex();
    const data = sessionArg ? (() => { const id = resolveSessionId(sessionArg); return id ? loadSession(id) : null; })() : latestForCwd(process.cwd());
    if (!data) return void out(c.red(sessionArg ? `No session matching '${sessionArg}'.\n` : "No session for this directory — pass an id (see `hara sessions`).\n"));
    const md = renderSessionMarkdown(data);
    if (opts.out) {
      writeFileSync(opts.out, md, "utf8");
      out(c.green(`✓ wrote ${opts.out}`) + c.dim(` (${md.length} chars)\n`));
    } else {
      out(md);
    }
  });

program
  .command("completions <shell>")
  .description("print a shell completion script: bash | zsh | fish (eval it in your shell rc)")
  .action((shell: string) => {
    const top = program.commands.map((cmd) => cmd.name()).filter((n) => n && n !== "completions").sort();
    const subs: Record<string, string[]> = {};
    for (const cmd of program.commands) {
      const sub = cmd.commands.map((s) => s.name()).filter(Boolean);
      if (sub.length) subs[cmd.name()] = sub;
    }
    const script = completionScript(shell, { top, subs });
    if (!script) return void out(c.red(`Unsupported shell '${shell}'. Use: bash | zsh | fish\n`));
    out(script);
  });

program
  .command("mcp")
  .description("run hara as an MCP server (stdio) — expose its read/search tools (incl. codebase_search) to other MCP clients")
  .action(async () => {
    const cfg = loadConfig();
    // stdout is the JSON-RPC transport — diagnostics MUST go to stderr only.
    process.stderr.write(c.dim(`hara mcp · serving over stdio · cwd ${cfg.cwd}\n  tools: ${mcpServeToolNames().join(", ") || "(none)"}\n  (read-only by default; set HARA_MCP_TOOLS to override)\n`));
    await startMcpServer(pkg.version, { cwd: cfg.cwd, sandbox: "read-only" });
  });

program
  .command("review")
  .description("review your uncommitted changes for bugs, security, and missing tests")
  .option("--staged", "review only staged changes")
  .option("--base <ref>", "review against a base ref (e.g. main) instead of just the working tree")
  .action(async (opts: { staged?: boolean; base?: string }) => {
    const cfg = loadConfig();
    const reviewProfile = profileForConfig(cfg).profile;
    const provider = await buildProvider(cfg, undefined, reviewProfile.id);
    if (!provider) {
      out(c.red(`Not authenticated for provider '${cfg.provider}'.\n`) + authHint(cfg) + "\n");
      process.exit(1);
    }
    const changes = captureChanges(cfg.cwd, 120_000, {
      staged: opts.staged,
      base: opts.base,
      includeUntracked: !opts.staged && !opts.base,
    });
    if (changes.error) return void out(c.red(`Git change capture failed closed: ${changes.error}\n`) + c.dim("(is this a git repo / valid base ref?)\n"));
    if (!changes.diff && !changes.newFiles.length && !changes.skippedFiles.length && !changes.omittedDeletions.length) {
      return void out(c.dim("No changes to review.\n"));
    }
    if (changes.skippedFiles.length) {
      out(c.yellow(`Protected paths omitted: ${changes.skippedFiles.map((p) => JSON.stringify(p)).join(", ")}\n`));
    }
    out(c.dim(`Reviewing ${changes.diff ? changes.diff.split("\n").length : 0} safe change entries…\n\n`));
    const stats = { input: 0, output: 0, lastInput: 0 };
    await runAgent([{ role: "user", content: standaloneReviewPrompt(changes) }], {
      provider,
      ctx: {
        cwd: cfg.cwd,
        sandbox: cfg.sandbox,
        profileId: reviewProfile.id,
        spaceId: spaceIdForProfile(reviewProfile),
      },
      approval: "full-auto",
      approvalChannel: false,
      confirm: async () => true,
      systemOverride: REVIEW_SYSTEM,
      toolFilter: (n) => READONLY_TOOLS.has(n), // read-only: the reviewer can inspect, never edit
      hooks: false,
      projectContext: loadAgentContext(cfg.cwd) || undefined,
      memory: memoryDigest(cfg.cwd, learningContext(cfg.cwd).profileId),
      stats,
      ...agentRunLimits(cfg),
    });
    if (stats.input || stats.output) out("\n" + statusLine(cfg.model, stats.input, stats.output) + "\n");
  });

program
  .command("commit")
  .description("generate a commit message from staged changes and commit (-y to skip the confirm)")
  .option("-a, --all", "stage all tracked changes first (git add -u)")
  .action(async (opts: { all?: boolean }) => {
    const skipConfirm = !!program.opts().yes; // reuse the global -y/--yes (auto-approve)
    const cfg = loadConfig();
    const commitProfile = profileForConfig(cfg).profile;
    const provider = await buildProvider(cfg, undefined, commitProfile.id);
    if (!provider) {
      out(c.red(`Not authenticated for provider '${cfg.provider}'.\n`) + authHint(cfg) + "\n");
      process.exit(1);
    }
    const authorizeCommit = companyCommitGuard(cfg, commitProfile, { approvalChannel: !skipConfirm });
    const initialAuthorization = await authorizeCommit();
    if (initialAuthorization) return void out(c.red(`Commit blocked: ${initialAuthorization}.\n`));
    if (opts.all) {
      const protectedTracked = protectedTrackedWorkingTreePaths(cfg.cwd);
      if (protectedTracked.length) {
        return void out(c.red(`Refusing to stage protected path(s): ${protectedTracked.map((p) => JSON.stringify(p)).join(", ")}\n`));
      }
    }
    const candidate = captureChanges(cfg.cwd, 120_000, opts.all
      ? { includeUntracked: false }
      : { staged: true, includeUntracked: false });
    if (candidate.error) return void out(c.red(`git diff failed closed: ${candidate.error}\n`) + c.dim("(is this a git repo?)\n"));
    if (candidate.skippedFiles.length) {
      return void out(c.red(`Refusing to inspect or commit protected path(s): ${candidate.skippedFiles.map((p) => JSON.stringify(p)).join(", ")}\n`));
    }
    const changeInput = commitMessageInput(candidate);
    if (!changeInput.trim()) return void out(c.dim("Nothing staged. Stage changes with `git add`, or use `hara commit -a`.\n"));
    out(c.dim("Writing a commit message…\n"));
    const r = await boundedProviderTurn(provider, {
      system: COMMIT_SYSTEM,
      history: [{ role: "user", content: `Write a commit message for these staged changes:\n\n${changeInput.slice(0, 120_000)}` }],
      tools: [],
      onText: () => {},
    }, { timeoutMs: 30_000, label: "commit message generation" });
    if (r.stop === "error") return void out(c.red(`message generation failed: ${r.errorMsg ?? "provider error"}\n`));
    const msg = r.text.trim().replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "").trim();
    if (!msg) return void out(c.red("No commit message produced — commit manually or retry.\n"));
    out("\n" + c.bold("Proposed commit message:\n") + c.dim("─".repeat(48) + "\n") + msg + "\n" + c.dim("─".repeat(48)) + "\n\n");
    if (!skipConfirm) {
      const rl = createInterface({ input: stdin, output: stdout });
      const ans = (await rl.question(`Commit with this message? ${c.dim("[Y/n]")} `)).trim().toLowerCase();
      rl.close();
      if (ans === "n" || ans === "no") return void out(c.dim("(cancelled — nothing committed)\n"));
    }
    const beforeMutationAuthorization = await authorizeCommit();
    if (beforeMutationAuthorization) return void out(c.red(`Commit blocked: ${beforeMutationAuthorization}.\n`));
    if (opts.all) {
      try {
        await runShell("git add -u", cfg.cwd, "off", { timeout: 30_000, maxBuffer: 1_000_000 });
      } catch (error) {
        return void out(c.red(`git add failed: ${error instanceof Error ? error.message : String(error)}\n`));
      }
    }
    const protectedStaged = protectedStagedPaths(cfg.cwd);
    if (protectedStaged.length) {
      return void out(c.red(`Refusing to inspect or commit protected staged path(s): ${protectedStaged.map((p) => JSON.stringify(p)).join(", ")}\n`));
    }
    const tmp = join(tmpdir(), `hara-commit-${process.pid}.txt`);
    writeFileSync(tmp, msg + "\n", "utf8");
    try {
      const protectedBeforeCommit = protectedStagedPaths(cfg.cwd);
      if (protectedBeforeCommit.length) {
        return void out(c.red(`Staged paths changed; refusing to commit protected path(s): ${protectedBeforeCommit.map((p) => JSON.stringify(p)).join(", ")}\n`));
      }
      const finalAuthorization = await authorizeCommit();
      if (finalAuthorization) return void out(c.red(`Commit blocked: ${finalAuthorization}.\n`));
      const res = await runShell(`git commit -F ${JSON.stringify(tmp)}`, cfg.cwd, "off", { timeout: 30_000, maxBuffer: 1_000_000 });
      out(c.green("✓ committed ") + c.dim(((res.stdout || "").trim().split("\n")[0] || "").slice(0, 100)) + "\n");
    } catch (e) {
      out(c.red(`git commit failed: ${e instanceof Error ? e.message : String(e)}\n`));
    } finally {
      try {
        rmSync(tmp);
      } catch {
        /* best-effort cleanup */
      }
    }
  });

function renderCronJobs(): string {
  const head = isInstalled() ? c.green("scheduler: installed") : c.yellow("scheduler: NOT installed — run `hara cron install`");
  let jobs: CronJob[];
  try {
    jobs = loadJobs();
  } catch (error) {
    return head + "\n" + c.red(`${error instanceof Error ? error.message : String(error)}\n`);
  }
  if (!jobs.length) return head + "\n" + c.dim('No jobs. Add one:  hara cron add "every 1h" "<task>"\n');
  const now = Date.now();
  const lines = jobs.map((j) => {
    const nxt = nextRun(j, now);
    const nextLabel = nxt !== null && nxt <= now ? "due now" : nxt !== null ? new Date(nxt).toLocaleString() : "—";
    const elapsed = j.lastDurationMs === undefined ? "" : ` after ${formatAgentDuration(j.lastDurationMs)}`;
    const status = j.lastStatus === "running"
      ? c.yellow(`running since ${new Date(j.runningSince ?? j.lastRunAt ?? now).toLocaleString()}`)
      : j.lastStatus === "timed_out"
        ? c.red(`timed out${elapsed}`)
        : j.lastStatus === "ok"
          ? c.green(`ok${elapsed}`)
          : j.lastStatus === "error"
            ? c.red(`err${elapsed}`)
            : c.dim("—");
    const delivery = j.deliver ? ` · deliver ${j.deliver} (${j.deliverMode ?? "always"})` : "";
    return `${c.bold(j.id)} ${describeSchedule(j.schedule)} ${c.dim(`· ${j.mode}${delivery} · next ${nextLabel} · last ${status}`)}${j.enabled ? "" : c.dim(" [disabled]")}\n   ${c.dim(j.name)}`;
  });
  return head + "\n" + lines.join("\n") + "\n";
}

const cronCmd = program.command("cron").description("scheduled tasks — run a prompt/org task on a schedule (fired by your OS via `hara cron install`)");
cronCmd
  .command("add <schedule> <task...>")
  .description('schedule a task — schedule = cron expr ("0 9 * * *"), "every 30m", "in 2h", or an ISO timestamp')
  .option("--name <name>", "a label for the job")
  .option("--org", "run via `hara org` (role routing + review) instead of a plain `hara -p` prompt")
  .option("--command", "run the task as a plain SHELL COMMAND — deterministic, no agent, no tokens")
  .option("--tz <zone>", 'IANA timezone for cron exprs (e.g. "Asia/Shanghai"); default = local time')
  .option("--deliver <spec>", "push selected results: telegram:<chatId> | feishu:<chatId> | weixin:<peerId> | webhook:<url>")
  .option("--deliver-mode <mode>", "notification policy: always (default) | on-output | on-error")
  .option("--alert-after <n>", "send a 🚨 after N consecutive failures (1..1000; default 3)")
  .action((schedule: string, taskParts: string[], opts: { name?: string; org?: boolean; command?: boolean; tz?: string; deliver?: string; deliverMode?: string; alertAfter?: string }) => {
    const task = taskParts.join(" ");
    if (opts.org && opts.command) return void out(c.red("--org and --command are mutually exclusive\n"));
    const sched = parseSchedule(schedule, Date.now());
    if ("error" in sched) return void out(c.red(sched.error + "\n"));
    if (opts.tz && !validTz(opts.tz)) return void out(c.red(`invalid timezone "${opts.tz}" (IANA name, e.g. Asia/Shanghai)\n`));
    if (opts.tz && sched.kind !== "cron") return void out(c.red("--tz only applies to cron expressions\n"));
    if (opts.deliver) {
      const d = parseDeliver(opts.deliver);
      if ("error" in d) return void out(c.red(d.error + "\n"));
      const configurationError = deliveryConfigurationError(opts.deliver);
      if (configurationError) return void out(c.red(configurationError + "\n"));
      const conflict = deliveryInstructionConflict(task, opts.deliver);
      if (conflict) return void out(c.red(conflict + "\n"));
    }
    if (opts.deliverMode && !opts.deliver) return void out(c.red("--deliver-mode requires --deliver\n"));
    if (opts.deliverMode && !["always", "on-output", "on-error"].includes(opts.deliverMode)) {
      return void out(c.red("--deliver-mode must be always, on-output, or on-error\n"));
    }
    const alertAfter = opts.alertAfter === undefined ? undefined : Number(opts.alertAfter);
    if (alertAfter !== undefined && (!Number.isInteger(alertAfter) || alertAfter < 1 || alertAfter > 1_000)) {
      return void out(c.red("--alert-after must be an integer from 1 to 1000\n"));
    }
    const mode = opts.command ? ("command" as const) : opts.org ? ("org" as const) : ("print" as const);
    let job: CronJob;
    try {
      job = addJob({
        name: opts.name || task.slice(0, 48),
        schedule: sched,
        task,
        mode,
        cwd: process.cwd(),
        ...(opts.tz ? { tz: opts.tz } : {}),
        ...(opts.deliver ? { deliver: opts.deliver } : {}),
        ...(opts.deliverMode ? { deliverMode: opts.deliverMode as "always" | "on-output" | "on-error" } : {}),
        ...(alertAfter !== undefined ? { alertAfter } : {}),
        createdAt: Date.now(),
      });
    } catch (error) {
      return void out(c.red(`${error instanceof Error ? error.message : String(error)}\n`));
    }
    out(c.green(`✓ scheduled ${job.id}`) + c.dim(` · ${describeSchedule(sched)}${opts.tz ? ` @ ${opts.tz}` : ""} · ${job.mode}${opts.deliver ? ` · → ${opts.deliver} (${opts.deliverMode ?? "always"})` : ""}${alertAfter !== undefined ? ` · alert ≥${alertAfter}` : ""} · cwd ${job.cwd}\n`));
    if (!isInstalled()) out(c.yellow("⚠ scheduler not installed yet — run `hara cron install` so jobs actually fire.\n"));
  });
// Resolve an id/prefix to one job, printing a clear error for none / ambiguous (never act on a guess).
const cronResolve = (id: string): CronJob | null => {
  let r: ReturnType<typeof resolveJob>;
  try {
    r = resolveJob(id);
  } catch (error) {
    out(c.red(`${error instanceof Error ? error.message : String(error)}\n`));
    return null;
  }
  if (r === "ambiguous") return void out(c.red(`ambiguous id "${id}" — matches multiple jobs; type more characters\n`)), null;
  if (!r) return void out(c.red(`no such job: ${id}\n`)), null;
  return r;
};
/** Commander actions otherwise inherit Node's default SIGTERM/SIGINT exit, which kills only the tick parent
 * and can orphan its detached job process group. Convert the signal into cooperative cancellation, await
 * tree cleanup + lock release, then retain the conventional shell exit status. */
const withCronCliSignal = async <T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> => {
  const controller = new AbortController();
  let interrupted: NodeJS.Signals | undefined;
  const stop = (signal: NodeJS.Signals): void => {
    interrupted ??= signal;
    if (!controller.signal.aborted) controller.abort(new Error(`cron command interrupted by ${signal}`));
  };
  const onInt = (): void => stop("SIGINT");
  const onTerm = (): void => stop("SIGTERM");
  process.once("SIGINT", onInt);
  process.once("SIGTERM", onTerm);
  try {
    return await run(controller.signal);
  } finally {
    process.removeListener("SIGINT", onInt);
    process.removeListener("SIGTERM", onTerm);
    if (interrupted) process.exitCode = interrupted === "SIGINT" ? 130 : 143;
  }
};
cronCmd.command("list").alias("ls").description("list scheduled jobs").action(() => out(renderCronJobs()));
cronCmd
  .command("remove <id>")
  .alias("rm")
  .description("delete a job (by id or unique prefix)")
  .action((id: string) => {
    const j = cronResolve(id);
    if (!j) return;
    const state = recoverJobRunningState(j.id);
    if (state.recovered) {
      out(c.yellow(
        `Recovered and disabled interrupted run ${j.id}; an orphaned child may still exist. `
        + "Inspect the process/workspace, then run the remove command again.\n",
      ));
      return;
    }
    if (state.current?.lastStatus === "running") {
      out(c.yellow(`Job ${j.id} is still owned by a live Hara process; wait for it to finish before removal.\n`));
      return;
    }
    out(removeJob(j.id)
      ? c.green(`✓ removed ${j.id}\n`)
      : c.red("job changed concurrently; retry removal\n"));
  });
cronCmd.command("enable <id>").description("enable a job").action((id: string) => {
  const j = cronResolve(id);
  if (j) {
    setEnabled(j.id, true);
    out(c.green(`✓ enabled ${j.id}\n`));
  }
});
cronCmd.command("disable <id>").description("disable a job (keeps it, stops firing)").action((id: string) => {
  const j = cronResolve(id);
  if (j) {
    setEnabled(j.id, false);
    out(c.green(`✓ disabled ${j.id}\n`));
  }
});
cronCmd
  .command("run <id>")
  .description("run a job right now, ignoring its schedule")
  .action(async (id: string) => {
    const job = cronResolve(id);
    if (!job) return;
    out(c.dim(`running ${job.id} (${job.name})…\n`));
    const r = await withCronCliSignal((signal) => runJobTracked(job, { signal }));
    out((r.ok ? c.green("✓ done") : c.red(`✗ ${r.error}`)) + c.dim(` · log: ${logPath(job.id)}\n`));
  });
cronCmd
  .command("tick")
  .description("run all due jobs now (your OS scheduler calls this every minute)")
  .action(async () => {
    const r = await withCronCliSignal((signal) => runTick(Date.now(), undefined, { signal }));
    if (r.skipped) return void out(c.dim(`(skipped — ${r.skipped})\n`));
    if (r.stopped) return void out(c.yellow(`(stopped — ${r.stopped}; ran ${r.ran.length} job(s): ${r.ran.join(", ") || "none"})\n`));
    out(c.dim(r.ran.length ? `ran ${r.ran.length} job(s): ${r.ran.join(", ")}\n` : "(no jobs due)\n"));
  });
cronCmd
  .command("install")
  .description("register the per-minute tick with your OS scheduler (launchd on macOS, crontab on Linux)")
  .action(() => {
    const r = installScheduler(selfArgv());
    out((r.ok ? c.green("✓ ") : c.red("✗ ")) + r.msg + "\n");
  });
cronCmd.command("uninstall").description("remove the OS scheduler entry").action(() => {
  const r = uninstallScheduler();
  out((r.ok ? c.green("✓ ") : c.red("✗ ")) + r.msg + "\n");
});
cronCmd
  .command("logs <id>")
  .description("show a job's recent run output")
  .action((id: string) => {
    const job = cronResolve(id);
    if (!job) return;
    const p = logPath(job.id);
    out(existsSync(p) ? readFileSync(p, "utf8").slice(-4000) + "\n" : c.dim("(no runs yet)\n"));
  });

const memoryCmd = program.command("memory").description("inspect + consolidate hara's durable memory (~/.hara/memory + project .hara/memory)");
memoryCmd.command("show").description("print the memory digest injected at session start").action(() => {
  const cwd = process.cwd();
  const d = memoryDigest(cwd, learningContext(cwd).profileId);
  out(d ? d + "\n" : c.dim("(memory is empty — `hara memory init`, or let the agent write via memory_write)\n"));
});
memoryCmd.command("init").description("scaffold the memory dirs + seed files (global + project)").action(async () => {
  const w = await scaffoldMemory(process.cwd());
  out(w.length ? c.green(`Scaffolded: ${w.join(", ")}\n`) : c.dim("Memory already scaffolded.\n"));
});
memoryCmd
  .command("distill")
  .description("consolidate recent daily logs into durable MEMORY (promote short-term → long-term)")
  .option("--days <n>", "days of logs to consider (default 14)", (v) => parseInt(v, 10))
  .option("--scope <s>", "global | project | all (default all)")
  .action(async (opts: { days?: number; scope?: string }) => {
    const cfg = loadConfig();
    const distillProfile = profileForConfig(cfg).profile;
    const provider = await buildProvider(cfg, undefined, distillProfile.id);
    if (!provider) {
      out(c.red(`Not authenticated for provider '${cfg.provider}'.\n`) + authHint(cfg) + "\n");
      process.exit(1);
    }
    const days = opts.days && opts.days > 0 ? opts.days : 14;
    const scopes: Scope[] = opts.scope === "global" ? ["global"] : opts.scope === "project" ? ["project"] : ["project", "global"];
    const logs = scopes
      .map((s) => readRecentLogs(s, cfg.cwd, days))
      .filter(Boolean)
      .join("\n\n");
    if (!logs.trim()) return void out(c.dim(`No daily logs in the last ${days} day(s) to distill. (The agent jots them via memory_write target=log.)\n`));
    out(c.dim(`Distilling ${days}-day logs → durable memory…\n`));
    const stats = { input: 0, output: 0, lastInput: 0 };
    const history: NeutralMsg[] = [{ role: "user", content: `Current durable memory:\n\n${memoryDigest(cfg.cwd, undefined, undefined, { includeReviewedLearning: false }) || "(empty)"}\n\n---\n\nRecent daily logs (last ${days} days):\n\n${logs.slice(0, 80_000)}` }];
    await runAgent(history, {
      provider,
      ctx: {
        cwd: cfg.cwd,
        sandbox: cfg.sandbox,
        profileId: distillProfile.id,
        spaceId: spaceIdForProfile(distillProfile),
      },
      approval: "full-auto",
      approvalChannel: false,
      confirm: async () => true,
      toolFilter: allowsMemoryDistillTool,
      systemOverride: MEMORY_DISTILL_SYSTEM,
      stats,
      ...agentRunLimits(cfg),
    });
    if (stats.input || stats.output) out(statusLine(cfg.model, stats.input, stats.output) + "\n");
  });

const learningContext = (cwd: string): { cwd: string; profileId?: string; routeProfileId?: string } => {
  const resolution = resolveActive(cwd);
  const profile = getProfile(resolution.id);
  return {
    cwd,
    ...(profile?.kind === "gateway"
      ? { profileId: spaceIdForProfile(profile), routeProfileId: profile.id }
      : {}),
  };
};
const learningCmd = program.command("learning").description("review, approve, reject, or revoke execution-time business learning");
learningCmd
  .command("list")
  .alias("ls")
  .description("list reviewable and active learning for this project/profile")
  .option("--scope <scope>", "personal | project | organization")
  .option("--status <state>", "pending | approved | rejected | revoked | submitted")
  .option("--limit <n>", "maximum rows (default 200)", (value) => Number.parseInt(value, 10))
  .action((options: { scope?: string; status?: string; limit?: number }) => {
    const cwd = process.cwd();
    const scopes = new Set<LearningScope>(["personal", "project", "organization"]);
    const states = new Set<LearningStatus>(["pending", "approved", "rejected", "revoked", "submitted"]);
    if (options.scope && !scopes.has(options.scope as LearningScope)) {
      return void out(c.red("scope must be personal, project, or organization\n"));
    }
    if (options.status && !states.has(options.status as LearningStatus)) {
      return void out(c.red("status must be pending, approved, rejected, revoked, or submitted\n"));
    }
    const items = listLearnings({
      ...learningContext(cwd),
      ...(options.scope ? { scope: options.scope as LearningScope } : {}),
      ...(options.status ? { status: options.status as LearningStatus } : {}),
      ...(Number.isSafeInteger(options.limit) ? { limit: options.limit } : {}),
    });
    out(formatLearningList(items) + "\n");
  });
for (const decision of ["approve", "reject", "revoke"] as const) {
  learningCmd
    .command(`${decision} <id>`)
    .description(`${decision} one personal/project learning candidate (organization learning is reviewed in Control)`)
    .option("--revision <n>", "optimistic candidate revision", (value) => Number.parseInt(value, 10))
    .option("--note <text>", "short review note")
    .action((id: string, options: { revision?: number; note?: string }) => {
      try {
        const item = reviewLearning(id, decision, {
          ...learningContext(process.cwd()),
          ...(Number.isSafeInteger(options.revision) ? { expectedRevision: options.revision } : {}),
          ...(options.note ? { note: options.note } : {}),
        });
        out(c.green(`✓ ${item.id.slice(0, 8)} ${item.status} · revision ${item.revision}\n`));
      } catch (error) {
        out(c.red(`${error instanceof Error ? error.message : String(error)}\n`));
        process.exitCode = 1;
      }
    });
}
learningCmd
  .command("submit <id>")
  .description("submit one stable, redacted organization candidate to Hara Control for admin review")
  .action(async (id: string) => {
    const cwd = process.cwd();
    const context = learningContext(cwd);
    if (!context.profileId || !context.routeProfileId) {
      out(c.red("an organization connection must be active before submitting organization learning\n"));
      process.exitCode = 1;
      return;
    }
    const candidate = listLearnings({ ...context, scope: "organization", limit: 1_000 })
      .find((item) => item.id === id || item.clientId === id || item.remoteId === id);
    if (!candidate) {
      out(c.red("organization learning candidate not found\n"));
      process.exitCode = 1;
      return;
    }
    try {
      const result = await submitOrganizationLearningToControl(context.routeProfileId, candidate, {
        cwd,
        organizationScopeId: context.profileId,
      });
      out(c.green(`✓ submitted ${candidate.id.slice(0, 8)} · Control ${result.status} · remote revision ${result.revision}\n`));
    } catch (error) {
      out(c.red(`${error instanceof Error ? error.message : String(error)}\n`));
      process.exitCode = 1;
    }
  });
learningCmd
  .command("sync")
  .description("pull the versioned, Control-approved organization learning bundle")
  .action(async () => {
    const cwd = process.cwd();
    const context = learningContext(cwd);
    if (!context.profileId || !context.routeProfileId) {
      out(c.red("an organization connection must be active before syncing organization learning\n"));
      process.exitCode = 1;
      return;
    }
    try {
      const result = await syncOrganizationLearningsFromControl(context.routeProfileId, {
        cwd,
        organizationScopeId: context.profileId,
      });
      out(c.green(`✓ organization learning v${result.version} · ${result.learnings.length} approved\n`));
    } catch (error) {
      out(c.red(`${error instanceof Error ? error.message : String(error)}\n`));
      process.exitCode = 1;
    }
  });

const rolesCmd = program.command("roles").description("list/manage Hara roles and compatible Claude Code agents");
rolesCmd
  .command("init")
  .description("scaffold example roles")
  .action(() => {
    const written = scaffoldRoles(process.cwd());
    out(
      written.length
        ? c.green(`Created ${written.length} file(s) in .hara/roles/: ${written.join(", ")}\n`)
        : c.dim("Roles already exist in .hara/roles/.\n"),
    );
  });
rolesCmd.action(() => {
  const roles = loadActiveRoles(process.cwd());
  if (!roles.length) {
    out(c.dim("No roles. Run `hara roles init`.\n"));
    return;
  }
  for (const r of roles) {
    const meta = roleMeta(r);
    out(`${c.bold(r.id)}${r.model ? c.dim(` (${r.model})`) : ""}${meta ? c.dim(`  [${meta}]`) : ""}  ${c.dim("owns: " + r.owns.join(", "))}\n  ${r.description}\n`);
  }
});

program
  .command("feedback [description...]")
  .description("file a structured bug/feature report to GitHub (hara-cli/hara) — humans and agents use the same door")
  .option("--session", "append a REDACTED tail of the most recent session (the issue is PUBLIC)")
  .option("--dry-run", "print the issue body without filing")
  .action(async (parts: string[], o: { session?: boolean; dryRun?: boolean }) => {
    // the hara-hub verdict: feedback is a command, not a server — GitHub Issues is the bus
    const { collectEnv, buildIssueBody, issueTitle, FEEDBACK_REPO, NEW_ISSUE_URL } = await import("./feedback.js");
    const desc = (parts ?? []).join(" ").trim();
    if (!desc) {
      out(`Usage: hara feedback "what happened…" [--session] [--dry-run] — files a structured issue to ${FEEDBACK_REPO}\n`);
      return;
    }
    let tail: string | undefined;
    if (o.session) {
      const { ensureSessionMetadataIndex, recentSessionMetadata, loadSession } = await import("./session/store.js");
      await ensureSessionMetadataIndex();
      const metas = recentSessionMetadata({ sources: ["interactive"], limit: 1 });
      const last = metas[0] ? loadSession(metas[0].id) : null;
      if (last) {
        tail = last.history
          .slice(-8)
          .map((m: any) => (m.role === "user" ? `user: ${m.content}` : m.role === "assistant" && m.text ? `assistant: ${m.text}` : ""))
          .filter(Boolean)
          .join("\n")
          .slice(-3000);
        out(c.yellow("⚠ --session attaches a redacted tail of your last session to a PUBLIC issue.\n"));
      }
    }
    const { readRawConfig } = await import("./config.js");
    const raw = readRawConfig() as { provider?: string; model?: string };
    const modelLabel = raw.provider && raw.model ? `${raw.provider}:${raw.model}` : undefined;
    const body = buildIssueBody(desc, collectEnv(pkg.version, modelLabel), tail);
    if (o.dryRun) {
      out(body + "\n");
      return;
    }
    const { execFileSync } = await import("node:child_process");
    try {
      execFileSync("gh", ["--version"], { stdio: "ignore" });
      const url = execFileSync("gh", ["issue", "create", "--repo", FEEDBACK_REPO, "--title", issueTitle(desc), "--body", body, "--label", "feedback"], { encoding: "utf8" });
      out(c.green("✓ filed: ") + url.trim() + "\n");
    } catch {
      out(`\n(gh CLI unavailable or filing failed — copy everything below into ${NEW_ISSUE_URL})\n\n# ${issueTitle(desc)}\n\n${body}\n`);
    }
  });

// `hara desk` — connect to a hara-desk coordination server (identity registry + task board).
// The desk is the closed-source enterprise piece; this is the open-source client side.
const deskCmd = program.command("desk").description("coordinate with a hara-desk server (register · post · board · claim · complete)");

const resolveDeskProfile = (requested?: string): {
  profileId: string;
  identity: DeskOrganizationIdentity;
} | null => {
  const profileId = requested?.trim() || resolveActive(process.cwd()).id;
  if (!isValidProfileId(profileId)) throw new Error("invalid organization connection id");
  const profile = getProfile(profileId);
  if (!profile || profile.kind !== "gateway") {
    if (!requested) return null;
    throw new Error(
      `organization connection '${profileId}' was not found`,
    );
  }
  return {
    profileId,
    identity: deskOrganizationIdentity(profile),
  };
};

const loadDeskCliCreds = async (requested?: string) => {
  const resolved = resolveDeskProfile(requested);
  const { loadCreds, loadProfileCreds } = await import("./desk.js");
  return {
    profileId: resolved?.profileId,
    creds: resolved
      ? loadProfileCreds(resolved.identity)
      : loadCreds(),
  };
};

const missingDeskRegistration = (profileId?: string): string =>
  profileId
    ? `Desk is not configured for '${profileId}' — run \`hara desk register --profile ${profileId} --url … --key …\`\n`
    : "Desk is not configured — run `hara desk register --url … --key …` first\n";

deskCmd
  .command("register")
  .description("register with the active organization's Desk (or a standalone Desk when no organization is active)")
  .requiredOption("--url <url>", "desk base URL (e.g. http://127.0.0.1:4200)")
  .requiredOption("--key <enrollKey>", "the desk's enroll key")
  .option("--profile <id>", "organization connection id (default: active organization)")
  .option("--name <name>", "agent name shown in the registry", "hara-cli")
  .option("--owner <owner>", "the human this agent belongs to", "me")
  .action(async (o: { url: string; key: string; profile?: string; name: string; owner: string }) => {
    const { registerAgent } = await import("./desk.js");
    try {
      const resolved = resolveDeskProfile(o.profile);
      const creds = await registerAgent(
        o.url,
        o.key,
        o.name,
        o.owner,
        "hara-cli",
        resolved?.identity,
      );
      const scope = resolved ? ` [${resolved.profileId}]` : " [standalone]";
      out(c.green("✓ registered ") + `${creds.agentId} (owner ${creds.owner}) → ${creds.url}${scope}\n`);
    } catch (e: any) {
      out(c.red(`register failed: ${e.message}\n`));
    }
  });
deskCmd
  .command("post [title...]")
  .description("post a task or feedback report to the board")
  .option("--profile <id>", "organization connection id (default: active organization)")
  .option("--dispatch", "a dispatch task (someone does work) instead of a feedback report")
  .option("--high", "high-risk dispatch (needs an owner ack before it can complete)")
  .option("--body <text>", "task body / details", "")
  .action(async (parts: string[], o: { profile?: string; dispatch?: boolean; high?: boolean; body: string }) => {
    const { deskCall } = await import("./desk.js");
    let profileId: string | undefined;
    let creds;
    try {
      ({ profileId, creds } = await loadDeskCliCreds(o.profile));
    } catch (e: any) {
      return void out(c.red(`${e.message}\n`));
    }
    if (!creds) return void out(c.red(missingDeskRegistration(profileId)));
    const title = (parts ?? []).join(" ").trim();
    if (!title) return void out("Usage: hara desk post <title> [--dispatch] [--high] [--body …]\n");
    try {
      const r = await deskCall(creds.url, "POST", "/tasks", { token: creds.token, body: { kind: o.dispatch ? "dispatch" : "feedback", risk: o.high ? "high" : "low", title, body: o.body } }) as any;
      out(c.green("✓ posted ") + `${r.task.id} (${r.task.kind}/${r.task.state})\n`);
    } catch (e: any) {
      out(c.red(`post failed: ${e.message}\n`));
    }
  });
deskCmd
  .command("board")
  .description("list the board (default: open tasks)")
  .option("--profile <id>", "organization connection id (default: active organization)")
  .option("--state <state>", "open | claimed | done | cancelled", "open")
  .option("--kind <kind>", "feedback | dispatch")
  .action(async (o: { profile?: string; state: string; kind?: string }) => {
    const { deskCall } = await import("./desk.js");
    let profileId: string | undefined;
    let creds;
    try {
      ({ profileId, creds } = await loadDeskCliCreds(o.profile));
    } catch (e: any) {
      return void out(c.red(`${e.message}\n`));
    }
    if (!creds) return void out(c.red(missingDeskRegistration(profileId)));
    try {
      const q = `/tasks?state=${encodeURIComponent(o.state)}${o.kind ? `&kind=${encodeURIComponent(o.kind)}` : ""}`;
      const r = await deskCall(creds.url, "GET", q, { token: creds.token }) as any;
      if (!r.tasks.length) return void out(c.dim("(board empty)\n"));
      for (const t of r.tasks) out(`${t.id}  ${c.bold(t.kind)}${t.risk === "high" ? c.red("!") : " "} ${t.state.padEnd(8)} ${t.title}\n`);
    } catch (e: any) {
      out(c.red(`board failed: ${e.message}\n`));
    }
  });
for (const [verb, path, ok] of [
  ["claim", "claim", "claimed"],
  ["complete", "complete", "completed"],
  ["ack", "ack", "acked"],
  ["cancel", "cancel", "cancelled"],
] as const) {
  deskCmd
    .command(`${verb} <taskId>`)
    .description(`${verb} a task`)
    .option("--profile <id>", "organization connection id (default: active organization)")
    .option("--detail <text>", "note (complete)", "")
    .action(async (taskId: string, o: { profile?: string; detail: string }) => {
      const { deskCall } = await import("./desk.js");
      let profileId: string | undefined;
      let creds;
      try {
        ({ profileId, creds } = await loadDeskCliCreds(o.profile));
      } catch (e: any) {
        return void out(c.red(`${e.message}\n`));
      }
      if (!creds) return void out(c.red(missingDeskRegistration(profileId)));
      try {
        const r = await deskCall(creds.url, "POST", `/tasks/${encodeURIComponent(taskId)}/${path}`, { token: creds.token, body: verb === "complete" ? { detail: o.detail } : {} }) as any;
        out(c.green(`✓ ${ok} `) + `${r.task?.id ?? taskId}${r.task ? ` (${r.task.state})` : ""}\n`);
      } catch (e: any) {
        out(c.red(`${verb} failed: ${e.message}\n`));
      }
    });
}

const skillsCmd = program.command("skills").description("manage skills (.hara/skills/<name>/SKILL.md)");
skillsCmd
  .command("init")
  .description("scaffold an example skill")
  .action(async () => {
    const written = await scaffoldSkills(process.cwd());
    out(
      written.length
        ? c.green(`Created an example skill: ${written.join(", ")}\n`)
        : c.dim("Skills already exist in .hara/skills/.\n"),
    );
  });
skillsCmd.action(() => {
  const skills = loadSkillIndex(process.cwd());
  if (!skills.length) {
    out(c.dim("No skills. Run `hara skills init`, or the agent saves them with skill_create.\n"));
    return;
  }
  for (const s of skills) {
    out(`${c.bold(s.id)}${s.context === "fork" ? c.dim(" (fork)") : ""}  ${c.dim(s.source)}\n  ${s.description}\n`);
  }
});

const pluginCmd = program
  .command("plugin")
  .alias("plugins")
  .description("manage plugins (bundle skills/roles/MCP servers)");
pluginCmd
  .command("add <source>")
  .description("install a plugin from file:<path> | github:<owner/repo> | git:<url>")
  .action((source: string) => {
    try {
      const p = installPlugin(source);
      setPluginEnabled(p.name, true);
      const m = p.manifest;
      const parts = [
        m.skills?.length ? `${m.skills.length} skill dir(s)` : "",
        m.agents?.length ? `${m.agents.length} role dir(s)` : "",
        m.mcpServers ? `${Object.keys(m.mcpServers).length} mcp server(s)` : "",
      ].filter(Boolean);
      out(c.green(`Installed ${p.name}@${p.version}${parts.length ? c.dim(" — " + parts.join(", ")) : ""}\n`));
      // Hara's model-controlled subprocesses append this directory automatically. The user's independent
      // interactive shell still needs its own PATH entry when they want to invoke the command directly.
      const bins = Object.keys(m.bin ?? {});
      if (bins.length) {
        const onPath = (process.env.PATH ?? "").split(delimiter).includes(haraBinDir());
        out(c.green(`Linked command(s): ${bins.join(", ")} → ${c.dim(haraBinDir())}\n`));
        out(c.dim("  available to tool commands started inside Hara automatically\n"));
        if (!onPath) out(c.yellow(`  add to PATH once:  echo 'export PATH="$HOME/.hara/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc\n`));
      }
      // Surface the code-execution surface without echoing manifest-provided arguments or hook bodies:
      // those fields may contain credentials. Installing a plugin means trusting code from its author.
      const execs: string[] = [];
      for (const [name, s] of Object.entries(m.mcpServers ?? {})) execs.push(`mcp ${name}: ${s.command}`);
      for (const _hook of [...(m.hooks?.PreToolUse ?? []), ...(m.hooks?.PostToolUse ?? [])]) execs.push("hook configured (command hidden)");
      if (execs.length) {
        out(
          c.yellow(`⚠ ${p.name} will run these commands on every hara launch (a plugin is code you run — review them):\n`) +
            execs.map((e) => c.dim(`    ${e}`)).join("\n") +
            c.dim(`\n    disable: hara plugin disable ${p.name}\n`),
        );
      }
    } catch (e: any) {
      out(c.red(`Install failed: ${e.message}\n`));
    }
  });
pluginCmd
  .command("remove <name>")
  .alias("uninstall")
  .description("uninstall a plugin")
  .action((name: string) => {
    try {
      out(uninstallPlugin(name) ? c.green(`Removed ${name}\n`) : c.dim(`(no plugin '${name}')\n`));
    } catch (error: any) {
      out(c.red(`Remove failed: ${error?.message ?? String(error)}\n`));
    }
  });
pluginCmd
  .command("enable <name>")
  .description("enable an installed plugin")
  .action((name: string) => (setPluginEnabled(name, true), out(c.green(`Enabled ${name}\n`))));
pluginCmd
  .command("disable <name>")
  .description("disable an installed plugin (keeps it installed)")
  .action((name: string) => (setPluginEnabled(name, false), out(c.green(`Disabled ${name}\n`))));
pluginCmd.action(() => {
  const installed = listInstalled();
  if (!installed.length) return void out(c.dim("No plugins. Install with `hara plugin add <source>`.\n"));
  const on = new Set(enabledPlugins().map((p) => p.name));
  for (const p of installed) {
    out(`${on.has(p.name) ? c.green("●") : c.dim("○")} ${c.bold(p.name)}@${p.version}${p.manifest.description ? c.dim("  " + p.manifest.description) : ""}\n`);
  }
});

const login = program.command("login").description("authenticate a provider");
login
  .command("qwen")
  .description("legacy Qwen Code OAuth login (not Alibaba Token Plan; new setup uses a Token Plan API key)")
  .action(async () => {
    try {
      await qwenDeviceLogin((m) => out(m + "\n"));
      writeConfigValue("provider", "qwen-oauth");
      writeConfigValue("model", "coder-model");
      out(c.green("\n✓ Qwen OAuth complete — provider set to qwen-oauth (model coder-model).\n"));
    } catch (e: any) {
      out(c.red(`\nQwen OAuth failed: ${e.message}\n`));
      process.exit(1);
    }
  });

const config = program.command("config").description("manage ~/.hara/config.json");
config
  .command("set <key> <value>")
  .description(`set a config value (keys: ${CONFIG_KEYS.join(" | ")})`)
  .action((key: string, value: string) => {
    if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
      out(c.red(`Unknown key '${key}'. Valid keys: ${CONFIG_KEYS.join(", ")}.\n`));
      process.exit(1);
    }
    if (key === "approval" && !APPROVAL_MODES.includes(value as ApprovalMode)) {
      out(c.red(`Invalid approval mode. One of: ${APPROVAL_MODES.join(", ")}.\n`));
      process.exit(1);
    }
    if (key === "sandbox" && !SANDBOX_MODES.includes(value as SandboxMode)) {
      out(c.red(`Invalid sandbox mode. One of: ${SANDBOX_MODES.join(", ")}.\n`));
      process.exit(1);
    }
    if (key === "computerUse" && !COMPUTER_USE_MODES.includes(value as HaraConfig["computerUse"])) {
      out(c.red(`Invalid computer-use mode. One of: ${COMPUTER_USE_MODES.join(", ")}.\n`));
      process.exit(1);
    }
    if (key === "reasoningEffort" && !REASONING_EFFORTS.includes(value as typeof REASONING_EFFORTS[number])) {
      out(c.red(`Invalid reasoning effort. One of: ${REASONING_EFFORTS.join(", ")}.\n`));
      process.exit(1);
    }
    if (key === "proxy") {
      try {
        const parsed = new URL(value);
        if (!(["http:", "https:"] as const).includes(parsed.protocol as "http:" | "https:") || parsed.pathname !== "/" || parsed.search || parsed.hash) {
          throw new Error("invalid proxy URL");
        }
      } catch {
        out(c.red("Invalid proxy. Use an HTTP(S) proxy URL such as http://127.0.0.1:7890; paths, queries, and fragments are not allowed.\n"));
        process.exit(1);
      }
    }
    if (key === "packageRegistry") {
      try {
        value = normalizePackageRegistry(value) ?? "";
        if (!value) throw new Error("empty registry");
      } catch {
        out(c.red("Invalid package registry. Use npmjs, npmmirror, or an HTTP(S) URL without credentials, query parameters, or a fragment.\n"));
        process.exit(1);
      }
    }
    if (key === "runTimeoutMs") {
      const parsed = parseAgentRunTimeoutMs(value);
      if (parsed === undefined || parsed < MIN_AGENT_RUN_TIMEOUT_MS || parsed > MAX_AGENT_RUN_TIMEOUT_MS) {
        out(c.red("Invalid runTimeoutMs. Use 1s..2h, for example `30m`, `90s`, or milliseconds.\n"));
        process.exit(1);
      }
    }
    if (key === "maxAgentRounds") {
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_AGENT_MAX_ROUNDS) {
        out(c.red(`Invalid maxAgentRounds. Use an integer from 1 to ${MAX_AGENT_MAX_ROUNDS}.\n`));
        process.exit(1);
      }
    }
    writeConfigValue(key, value);
    out(c.green(`Set ${key} → ${configPath()}\n`));
    const computerUseOverride = String(process.env.HARA_COMPUTER_USE ?? "").trim();
    if (key === "computerUse" && computerUseOverride && computerUseOverride !== value) {
      out(c.yellow(
        `Saved ${value}, but HARA_COMPUTER_USE currently overrides it for this process. ` +
        "Unset that environment variable and restart Hara to use the saved value.\n",
      ));
    }
  });
config
  .command("get [key]")
  .description("show config (credentials masked)")
  .action((key?: string) => {
    const raw = readRawConfig();
    if (key) {
      out(displayConfigValue(key, raw[key]) + "\n");
    } else {
      out(
        `path:     ${configPath()}\n` +
          `provider: ${raw.provider ?? "(default anthropic)"}\n` +
          `model:    ${raw.model ?? "(provider default)"}\n` +
          `baseURL:  ${raw.baseURL ?? "(provider default)"}\n` +
          `approval: ${raw.approval ?? "(default suggest)"}\n` +
          `sandbox:  ${raw.sandbox ?? "(default off)"}\n` +
          `timeout:  ${raw.runTimeoutMs ?? "(default 30m)"}\n` +
          `rounds:   ${raw.maxAgentRounds ?? "(default 64)"}\n` +
          `proxy:    ${maskProxy(raw.proxy)}\n` +
          `apiKey:   ${maskKey(raw.apiKey)}\n`,
      );
    }
  });
config
  .command("path")
  .description("print the config file path")
  .action(() => out(configPath() + "\n"));

// default action (interactive REPL / one-shot)
program.action(async (opts) => {
  pruneStoredToolResults();
  if (
    (!opts.print || opts.continue || opts.resume)
    && process.env.HARA_CRON !== "1"
    && !process.env.HARA_GATEWAY
  ) await ensureSessionMetadataIndex();
  let startupWorkspaceTransferId: string | undefined;
  // Identity-profile selection (--profile flag) is now handled by the program-level preAction
  // hook above — see setFlagOverride() + resolveActive() in profile.ts. activeId() / loadActiveProfile()
  // pick it up automatically. `HARA_PROFILE` env still works as a transient override (one slot lower
  // in the priority chain than --profile).
  // An interactive launch from Home gets an explicit, pre-provider handoff. Candidate discovery is limited
  // to paths the user already established through interactive sessions/project registration; Hara never
  // enumerates Home and never silently promotes a readable child into the workspace.
  if (
    !opts.print
    && !opts.cwd
    && !opts.resume
    && stdin.isTTY
    && stdout.isTTY
    && isUnsafeProjectWorkspace(process.cwd())
  ) {
    let candidate: string | undefined;
    try {
      await ensureSessionMetadataIndex();
      const recent = recentSessionMetadata({ sources: ["interactive"], limit: 100 })
        .map((session) => session.cwd);
      candidate = suggestedProjectWorkspace(recent);
      if (!candidate) {
        // Sessions launched from Home contain no usable project signal. Prefer bounded, marker-backed
        // discovery under conventional project containers; old registrations remain a final fallback.
        candidate = suggestedProjectWorkspace([
          ...discoverProjectWorkspaces(),
          ...loadProjects().map((project) => project.path),
        ]);
      }
    } catch {
      // A damaged optional history/registry must not weaken the Home boundary or block startup.
    }

    const startupUsesTui = process.env.HARA_TUI !== "0";
    if (candidate && startupUsesTui) {
      // A readline question before Ink mounts leaves stdin unreadable on some terminals. The small Ink
      // confirmation unmounts cleanly and is the same handoff used by the first-run AGENTS.md prompt.
      if (await askConfirm(`Home is protected as personal-data scope. Switch to recent project ${displaySessionCwd(candidate)}?`)) {
        process.chdir(candidate);
      }
    } else if (!candidate && startupUsesTui) {
      out(
        c.yellow("Home is protected as personal-data scope; no recent project is available to offer safely. ")
          + c.dim("Start with `hara --cwd /path/to/project`, or use `/cd /path/to/project` after startup.\n"),
      );
    } else {
      const rl = createInterface({ input: stdin, output: stdout });
      try {
        if (candidate) {
          const answer = (
            await rl.question(
              c.yellow(`Home is protected as personal-data scope. Switch to recent project ${displaySessionCwd(candidate)}? `)
                + c.dim("[Y/n] "),
            )
          ).trim().toLowerCase();
          if (answer === "" || answer === "y" || answer === "yes") process.chdir(candidate);
        } else {
          const answer = (
            await rl.question(
              c.yellow("Home is protected as personal-data scope. Enter a project directory to switch now")
                + c.dim(" (leave empty to stay at Home): "),
            )
          ).trim();
          if (answer) {
            const switched = resolveWorkspaceSwitch(answer, process.cwd());
            if (switched.ok) process.chdir(switched.cwd);
            else out(c.red(`(${switched.error})\n`));
          }
        }
      } finally {
        rl.close();
      }
    }
  }
  // `hara --cwd …` is often the user's response to the protected-Home guidance. In an interactive
  // terminal, offer to fork a very recent source-directory thread into the selected workspace. The old
  // session stays intact, and headless/scripted launches keep their established non-interactive behavior.
  if (
    !opts.print
    && opts.cwd
    && !opts.resume
    && !opts.continue
    && stdin.isTTY
    && stdout.isTTY
  ) {
    let candidate: SessionData | null = null;
    try {
      candidate = recentWorkspaceTransferCandidate(invocationCwd, process.cwd());
    } catch {
      // Optional continuity discovery must never make an explicit --cwd unusable.
    }
    if (candidate) {
      const question =
        `Continue recent session ${shortId(candidate.meta.id)} from ${displaySessionCwd(candidate.meta.cwd)} `
        + `with its current context in ${displaySessionCwd(process.cwd())}?`;
      let transfer = false;
      if (process.env.HARA_TUI !== "0") {
        transfer = await askConfirm(question);
      } else {
        const prompt = createInterface({ input: stdin, output: stdout });
        try {
          const answer = (await prompt.question(c.yellow(question) + c.dim(" [Y/n] "))).trim().toLowerCase();
          transfer = answer === "" || answer === "y" || answer === "yes";
        } finally {
          prompt.close();
        }
      }
      if (transfer) {
        try {
          const fork = persistWorkspaceSessionFork(candidate, process.cwd());
          startupWorkspaceTransferId = fork.meta.id;
          out(c.green(
            `Continuing ${shortId(candidate.meta.id)} as ${shortId(fork.meta.id)} in ${displaySessionCwd(fork.meta.cwd)}; `
            + "the original session remains saved.\n",
          ));
        } catch (error) {
          out(c.red(`Could not carry the recent session into ${displaySessionCwd(process.cwd())}: ${error instanceof Error ? error.message : String(error)}.\n`));
          out(c.dim(`The original session ${shortId(candidate.meta.id)} is unchanged; no blank replacement was started.\n`));
          process.exitCode = 2;
          return;
        }
      } else {
        out(c.dim(
          `Starting a fresh session in ${displaySessionCwd(process.cwd())}; `
          + `the previous session ${shortId(candidate.meta.id)} remains saved.\n`,
        ));
      }
    }
  }
  // Resolve addressable headless roles BEFORE loading config/provider/MCP. A qualified project role is
  // an execution-home selection, so every downstream route (credentials, model, AGENTS.md, tools) must be
  // constructed from that home rather than from the shell directory that happened to launch hara.
  let requestedHeadlessAgent: AgentIndexEntry | undefined;
  if (opts.print && opts.role) {
    const ref = String(opts.role).trim();
    const explicitResumeId = startupWorkspaceTransferId
      ?? (opts.resume
        ? resolveSessionId(String(opts.resume))
        : opts.continue
          ? latestForCwd(process.cwd())?.meta.id ?? null
          : null);
    const explicitResume = explicitResumeId ? loadSession(explicitResumeId) : null;
    const roleRouteProfileId = explicitResume?.meta.profileId ?? resolveActive(process.cwd()).id;
    // 0.134.1 stored managed role bundles in one unscoped directory. Do not guess which organization
    // owned those files: refresh the exact authenticated profile before the first post-upgrade lookup so
    // an explicit `--role` can seed its new identity-scoped directory and start on the first attempt.
    const roleRouteProfile = getProfile(roleRouteProfileId);
    if (roleRouteProfile?.kind === "gateway") {
      try {
        await syncOrgRolesForProfile(roleRouteProfile, undefined, { required: true });
      } catch (error) {
        const message = isOrganizationAuthorizationRejection(error)
          ? organizationAuthorizationRecoveryMessage()
          : redactSensitiveText(error instanceof Error ? error.message : String(error)).text;
        process.stderr.write(`hara: organization role sync failed — ${message}\n`);
        process.exitCode = 2;
        return;
      }
    }
    const isLocalRole = !ref.includes(":")
      && loadActiveRoles(process.cwd(), roleRouteProfileId).some((role) => role.id === ref);
    if (!isLocalRole) {
      const hit = resolveAgent(ref, process.cwd(), roleRouteProfileId);
      if (hit && "ambiguous" in hit) {
        process.stderr.write(
          `hara: role '${ref}' is ambiguous; choose one of: ${hit.ambiguous.map((entry) => `${entry.project}:${entry.name}`).join(", ")}\n`,
        );
        process.exitCode = 2;
        return;
      }
      if (!hit) {
        process.stderr.write(`hara: no agent '${ref}' was found locally, globally, or in the registered project index.\n`);
        process.exitCode = 2;
        return;
      }
      requestedHeadlessAgent = hit;
    }
  }
  const cfg = loadConfig({ overlay: opts.overlay, ...(requestedHeadlessAgent?.home ? { cwd: requestedHeadlessAgent.home } : {}) });
  const cwd = cfg.cwd;
  const homeWorkspace = isUnsafeProjectWorkspace(cwd);
  const machineOutput = !!opts.print && !!opts.schema;
  if (opts.model) cfg.model = opts.model;
  // Resolve a persisted session's identity before role bodies, providers, or MCP transports are loaded.
  // This read is only an early routing hint; the authoritative snapshot is re-read under the lock below.
  const launchResumeId = startupWorkspaceTransferId
    ?? (opts.resume ? resolveSessionId(String(opts.resume)) : opts.continue ? latestForCwd(cwd)?.meta.id ?? null : null);
  const launchResume = launchResumeId ? loadSession(launchResumeId) : null;
  let sessionRouteProfileId = launchResume?.meta.profileId ?? profileForConfig(cfg).profile.id;
  // Resolve the concrete role before constructing any user/plugin MCP transport. MCP servers are arbitrary
  // stdio subprocesses, so a read-only persona must not start them merely by launching a turn. Reusing this
  // object later also closes the resolve→connect→re-resolve race where a role could disappear or change policy.
  let requestedHeadlessRole: Role | undefined;
  let requestedHeadlessAgentRef: string | undefined;
  if (opts.print && opts.role) {
    const requestedRole = String(opts.role).trim();
    requestedHeadlessRole = requestedHeadlessAgent?.project
      ? loadActiveRoles(requestedHeadlessAgent.home, sessionRouteProfileId).find((candidate) => candidate.id === requestedHeadlessAgent!.name)
      : requestedHeadlessAgent
        ? loadActiveGlobalRoles(sessionRouteProfileId).find((candidate) => candidate.id === requestedHeadlessAgent!.name)
        : loadActiveRoles(cwd, sessionRouteProfileId).find((candidate) => candidate.id === requestedRole);
    if (!requestedHeadlessRole) {
      process.stderr.write(`hara: role '${opts.role}' disappeared from its declared home (${cwd}); refusing to start providers or MCP servers under the wrong persona.\n`);
      process.exitCode = 2;
      return;
    }
    if (requestedHeadlessAgent) {
      requestedHeadlessAgentRef = requestedHeadlessAgent.project
        ? `${requestedHeadlessAgent.project}:${requestedHeadlessAgent.name}`
        : `global:${requestedHeadlessAgent.name}`;
    }
  }
  const launchProfile = profileByIdForConfig(cfg, sessionRouteProfileId);
  const freshProfileModel = launchProfile
    ? launchProfile.kind === "gateway"
      ? process.env.HARA_MODEL || effectiveModel(launchProfile) || cfg.model
      : resolveByokProviderTarget(cfg, launchProfile, false).model
    : cfg.model;
  const launchModel = opts.model ? cfg.model : launchResume?.meta.model || freshProfileModel;
  let initialRuntime: { provider: Provider; profile: Profile } | null = null;
  try {
    if (launchProfile?.kind === "gateway") {
      await ensureOrganizationExecutionPolicy(cfg, launchProfile);
    }
    initialRuntime = await buildSessionBoundRuntime(cfg, sessionRouteProfileId, launchModel, launchResume?.meta.effort);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (machineOutput) process.stderr.write(`hara: ${message}\n`);
    else out(c.red(`Cannot open session: ${message}.\n`));
    process.exitCode = 2;
    return;
  }
  const provider0 = initialRuntime?.provider ?? null;
  if (!provider0) {
    // First-run friendliness: offer the setup wizard instead of just erroring (interactive TTY only).
    if (stdin.isTTY && !opts.print) {
      const rl = createInterface({ input: stdin, output: stdout });
      const ans = (await rl.question(c.yellow(`Not authenticated for '${cfg.provider}'. Run setup now? `) + c.dim("[Y/n] "))).trim().toLowerCase();
      rl.close();
      if (ans === "" || ans === "y" || ans === "yes") {
        await runSetup();
        out(c.dim(`\nThen run ${c.bold("hara")} to start.\n`));
        process.exit(0);
      }
    }
    const boundProfile = profileByIdForConfig(cfg, sessionRouteProfileId);
    const message = `Not authenticated for profile '${sessionRouteProfileId}' (provider '${cfg.provider}').\n${authHint(cfg, boundProfile)}\n`;
    if (machineOutput) process.stderr.write(message);
    else out(c.red(`Not authenticated for profile '${sessionRouteProfileId}' (provider '${cfg.provider}').\n`) + authHint(cfg, boundProfile) + "\n");
    process.exit(1);
  }
  let provider: Provider = provider0;
  // The session-bound profile is the source of truth for every gateway-side concern too. The globally
  // active profile may change independently while an older conversation is being resumed.
  let __activeP = initialRuntime?.profile ?? loadActiveProfile();
  // These objects can make independent model/control-plane requests. They are intentionally constructed
  // only after the session lock establishes the authoritative profile; pre-lock copies could retain a
  // credential or managed role from whichever connection happened to be active during startup.
  let fbOpt: { provider: Provider } | undefined;
  let guardianOpt: Awaited<ReturnType<typeof buildGuardian>>;
  const bindAuxiliaryRuntime = async (
    primary: Provider,
    profile: Profile,
    expectedSpaceId?: string,
  ): Promise<void> => {
    const assertAudience = (): void => {
      if (expectedSpaceId) assertProfileAudience(cfg, profile.id, expectedSpaceId);
    };
    assertAudience();
    if (profile.kind === "gateway") {
      await ensureOrganizationExecutionPolicy(cfg, profile, expectedSpaceId ?? spaceIdForProfile(profile));
      assertAudience();
    }
    // Fallback provider, built correctly for CROSS-PROVIDER failover. Passing profile.id is essential:
    // every fallback request of a persisted session stays inside the same identity boundary.
    let fallbackProv: Provider | null = null;
    if (cfg.fallbackModel && cfg.fallbackModel !== primary.model) {
      const fp = cfg.fallbackProvider;
      const cross = !!fp && fp !== primary.id;
      const family = (model: string): string => model.toLowerCase().split(/[-.:/]/)[0];
      const fallbackEnvKey = fp ? providerEnvKey(fp) : "";
      const crossKey = cfg.fallbackApiKey ?? (fallbackEnvKey ? process.env[fallbackEnvKey] : undefined);
      if (fp === "hara-gateway") {
        process.stderr.write("hara: fallbackProvider cannot be hara-gateway; select an enrolled gateway profile instead. Fallback disabled.\n");
      } else if (cross && providerRequiresApiKey(fp!) && !crossKey) {
        process.stderr.write(`hara: fallbackProvider '${fp}' needs its own key — set fallbackApiKey. Fallback disabled.\n`);
      } else if (!fp && !cfg.fallbackBaseURL && family(cfg.fallbackModel) !== family(primary.model)) {
        process.stderr.write(`hara: fallbackModel '${cfg.fallbackModel}' looks like a different vendor than '${primary.model}', but no fallbackProvider/fallbackBaseURL is set — it would hit the PRIMARY endpoint (likely 400). Set fallbackProvider (+ fallbackApiKey). Fallback disabled.\n`);
      } else {
        fallbackProv = await buildProvider(cfg, {
          ...(fp ? { provider: fp } : {}),
          model: cfg.fallbackModel,
          ...(cfg.fallbackBaseURL ? { baseURL: cfg.fallbackBaseURL } : {}),
          ...(cross ? { apiKey: crossKey } : cfg.fallbackApiKey ? { apiKey: cfg.fallbackApiKey } : {}),
        }, profile.id);
        assertAudience();
      }
    }
    const nextGuardian = await buildGuardian(cfg, primary, profile.id);
    assertAudience();
    if (profile.kind === "gateway" || primary.id === "hara-gateway") {
      const boundEnrollment = enrollmentFromProfile(profile);
      if (boundEnrollment) void heartbeatEnrollment(boundEnrollment, undefined, { profileId: profile.id });
    }
    fbOpt = fallbackProv ? { provider: fallbackProv } : undefined;
    guardianOpt = nextGuardian;
  };
  /** The engine owns local-file validation; this selector owns provider identity. An explicitly configured
   * vision-first model receives only the image and focused prompt; company authorization is checked against
   * the current Space before and after the call. No credential ever enters model context. */
  const inspectImageWithCurrentRoute = async (
    primary: Provider,
    profile: Profile,
    image: ImageAttachment,
    hint?: string,
    signal?: AbortSignal,
    expectedSpaceId?: string,
  ): Promise<{ text: string; model: string }> => {
    if (expectedSpaceId) assertProfileAudience(cfg, profile.id, expectedSpaceId);
    const route = await buildImageProviderForRoute(
      cfg,
      primary,
      profile,
      expectedSpaceId ?? spaceIdForProfile(profile),
    );
    const text = await describeImages(
      route.provider,
      [image],
      route.translated ? { signal } : { hint, signal },
    );
    if (expectedSpaceId) assertProfileAudience(cfg, profile.id, expectedSpaceId);
    return {
      text,
      model: route.provider.model,
    };
  };
  // Safety UX: first line of stdout = "where am I sending requests right now". Stable, scriptable,
  // and reassuring at the start of every session. Suppressed in pure -p print mode to keep that
  // path clean stdout-only (the user wants the model output, not banner noise). Set HARA_QUIET=1
  // to suppress everywhere.
  if (!opts.print && process.env.HARA_QUIET !== "1") {
    out(c.dim(activeProfileLine(__activeP)) + "\n");
    const expiryWarning = __activeP.kind === "gateway"
      ? deviceTokenExpiryWarning(__activeP.tokenExpiresAt)
      : null;
    if (expiryWarning) out(c.yellow(`⚠ ${expiryWarning}\n`));
  }
  let approval: ApprovalMode = opts.yes ? "full-auto" : ((opts.approval as ApprovalMode) || cfg.approval);
  let currentTurn: AbortController | null = null; // set during a running turn so Esc can abort it
  const autoApprove = new Set<string>(); // opaque project scopes accepted during this attached session
  const projectApprovals = projectApprovalPolicy(cwd);
  let recalledContext = ""; // snippets queued by /recall, prepended to the next message
  let recalledSkillPolicies: NonNullable<RunOpts["skillPolicies"]> = [];
  const sandbox: SandboxMode = (opts.sandbox as SandboxMode) || cfg.sandbox;
  if (sandbox !== "off" && !sandboxSupported()) {
    const message = `(sandbox '${sandbox}' is macOS-only; shell runs unsandboxed here)\n`;
    if (machineOutput) process.stderr.write(message);
    else out(c.yellow(message));
  }
  const stats = { input: 0, output: 0, lastInput: 0 };

  // Advertise configured MCP capabilities without starting any subprocess or blocking startup for permission.
  // The model can call `mcp_connect` when a task first needs ONE server; that external-boundary tool goes
  // through the ordinary interactive grant, and the newly discovered tools appear on the next model round.
  // Read-only headless roles do not receive the launcher at all.
  const mcpAll = { ...pluginMcpServers(), ...cfg.mcpServers }; // user config wins over plugin-contributed servers
  let lazyMcpRegistered = false;
  const registerRunMcp = (): void => {
    if (lazyMcpRegistered || requestedHeadlessRole?.readOnly || !Object.keys(mcpAll).length) return;
    lazyMcpRegistered = true;
    registerLazyMcpServers(
      mcpAll,
      (message) => machineOutput ? process.stderr.write(message + "\n") : out(c.dim(message + "\n")),
    );
  };
  const reloadRequestedHeadlessRole = async (profile: Profile): Promise<boolean> => {
    if (!opts.print || !opts.role) return true;
    // The role body and its tool policy are organization-controlled input. Refresh and reload them only
    // after identity is authoritative so an early active-profile hint cannot leak another tenant's prompt
    // or accidentally grant MCP access to a role that is read-only in the saved session's organization.
    if (profile.kind === "gateway" && !existsSync(orgRolesDir(profile.id))) {
      try {
        await syncOrgRolesForProfile(profile, undefined, { required: true });
      } catch (error) {
        const message = isOrganizationAuthorizationRejection(error)
          ? organizationAuthorizationRecoveryMessage()
          : redactSensitiveText(error instanceof Error ? error.message : String(error)).text;
        process.stderr.write(`hara: organization role sync failed — ${message}\n`);
        process.exitCode = 2;
        return false;
      }
    }
    const requestedRole = String(opts.role).trim();
    requestedHeadlessRole = requestedHeadlessAgent?.project
      ? loadActiveRoles(requestedHeadlessAgent.home, profile.id).find((candidate) => candidate.id === requestedHeadlessAgent!.name)
      : requestedHeadlessAgent
        ? loadActiveGlobalRoles(profile.id).find((candidate) => candidate.id === requestedHeadlessAgent!.name)
        : loadActiveRoles(cwd, profile.id).find((candidate) => candidate.id === requestedRole);
    if (requestedHeadlessRole) return true;
    process.stderr.write(`hara: role '${opts.role}' is not available for session profile '${profile.id}'; refusing to reuse a persona from another connection.\n`);
    process.exitCode = 2;
    return false;
  };

  // one-shot
  if (opts.print) {
    let headlessLockId: string | null = null;
    let meta: SessionMeta | null = null;
    const headlessLaunchSpaceId = spaceIdForProfile(__activeP);
    const headlessOperations = createPhysicalOperationDrain(() => {
      if (!headlessLockId) return;
      const lockId = headlessLockId;
      headlessLockId = null;
      releaseSessionLock(lockId);
    });
    const trackHeadlessOperation = headlessOperations.observe;
    try {
    const projectContext = loadAgentContext(cwd) || undefined;
    const assertHeadlessAudience = (): Profile => {
      const profileId = meta?.profileId ?? sessionRouteProfileId;
      const spaceId = meta?.spaceId ?? headlessLaunchSpaceId;
      if (!profileId || !spaceId) throw new Error("headless session has no durable Space binding");
      return assertProfileAudience(cfg, profileId, spaceId);
    };
    // Headless image inspection follows the same explicit vision-first route as interactive and Serve.
    // Company sessions remain pinned to the session's exact profile + Space authorization.
    const describeImage = async (path: string, hint?: string, signal?: AbortSignal): Promise<string> => {
      const routeProfile = assertHeadlessAudience();
      try {
        const route = await buildImageProviderForRoute(
          cfg,
          provider,
          routeProfile,
          meta?.spaceId ?? headlessLaunchSpaceId,
        );
        const description = await describeImages(route.provider, [{ path, mediaType: "image/png" }], { system: SCREENSHOT_SYSTEM, hint, signal });
        assertHeadlessAudience();
        return description;
      } catch {
        assertHeadlessAudience();
        return "";
      }
    };
    // Headless session continuity: --resume <id> / --continue loads the session, appends this prompt, and
    // saves it back — so `hara -p … --resume <id>` continues a thread (used by cron, scripts, the chat gateway).
    // Plain `hara -p` stays stateless. A --resume id with no match is created WITH that id (stable per caller).
    let continuationSession = false;
    let task: TaskExecution | undefined;
    let requiresAudienceBindingSave = false;
    const history: NeutralMsg[] = [];
    if (opts.resume || opts.continue) {
      const resumeArg = opts.resume ? String(opts.resume) : undefined;
      if (resumeArg && !validSessionId(resumeArg)) {
        process.stderr.write("hara: --resume contains an invalid session id. Use an id shown by `hara sessions`.\n");
        process.exitCode = 2;
        return;
      }
      // Cron print runs receive a freshly generated full UUID. It is an exact new-session identity, not a
      // user-entered prefix; scanning and parsing every historical transcript would make recurring jobs
      // progressively slower as their run history grows.
      const exactGeneratedCronSession =
        process.env.HARA_CRON === "1"
        && !!resumeArg
        && isGeneratedSessionId(resumeArg);
      const resolvedResume = resumeArg
        ? resolveSessionId(resumeArg, { allowPrefix: !exactGeneratedCronSession })
        : null;
      if (resumeArg && !resolvedResume && !exactGeneratedCronSession) {
        const prefixMatches = findSessionMetadataByPrefix(resumeArg);
        if (prefixMatches.sessions.length > 1 || !prefixMatches.exhaustive) {
          process.stderr.write(`hara: session prefix '${resumeArg}' is ambiguous; use more characters.\n`);
          process.exitCode = 2;
          return;
        }
      }
      const rid = (resumeArg ? (resolvedResume ?? resumeArg) : latestForCwd(cwd)?.meta.id) ?? newSessionId();
      const lock = acquireSessionLock(rid);
      if (!lock.ok) {
        process.stderr.write(`hara: session ${shortId(rid)} is already open in another process (pid ${lock.pid ?? "unknown"}); refusing a concurrent headless resume.\n`);
        process.exitCode = 1;
        await closeMcp();
        return;
      }
      headlessLockId = rid;
      // Re-read only after acquiring the single-writer lock. Loading first would leave a race window where
      // another gateway/cron process appends history that this stale snapshot later overwrites.
      const prior = loadSession(rid);
      continuationSession = Boolean(prior?.history.length);
      task = recoverTaskExecution(prior?.task);
      if (sessionFileExists(rid) && !prior) {
        process.stderr.write(`hara: session ${shortId(rid)} exists but is unreadable or corrupt; refusing to overwrite it. Inspect ~/.hara/sessions/${rid}.json.\n`);
        process.exitCode = 2;
        return;
      }
      if (prior && canonicalProjectPath(prior.meta.cwd) !== canonicalProjectPath(cwd)) {
        process.stderr.write(
          `hara: session ${shortId(rid)} belongs to ${prior.meta.cwd}, but this run is rooted at ${cwd}; refusing to resume across project homes. Run hara from the session's project directory instead.\n`,
        );
        process.exitCode = 2;
        return;
      }
      if (prior && requestedHeadlessAgent?.project) {
        const priorHome = canonicalProjectPath(prior.meta.cwd);
        if (priorHome !== requestedHeadlessAgent.home) {
          process.stderr.write(
            `hara: session ${shortId(rid)} belongs to ${prior.meta.cwd}; refusing to resume it as ${requestedHeadlessAgent.project}:${requestedHeadlessAgent.name} at ${requestedHeadlessAgent.home}. Start a new role session or resume one from that home.\n`,
          );
          process.exitCode = 2;
          return;
        }
      }
      if (prior?.history) history.push(...prior.history);
      // Stamp who created this session (cron runner sets HARA_CRON, gateway sets HARA_GATEWAY) and give
      // automated sessions a "name · time" title UP FRONT — the raw prompt must never become the title.
      const src = sessionSourceFromEnv();
      // A cron parent deliberately creates the occurrence before spawning this process so even launch
      // failures appear in Desktop. That record has no audience yet. Treat it as a new session only when
      // every unforgeable-by-accident invariant still matches this exact generated cron run and it contains
      // no user/model/task data. Ordinary legacy sessions remain fail-closed below.
      const bindablePendingCronOccurrence = Boolean(
        prior
        && exactGeneratedCronSession
        && prior.meta.pendingRouteBinding === "cron"
        && prior.meta.source === "cron"
        && src.source === "cron"
        && !!src.jobId
        && prior.meta.jobId === src.jobId
        && !prior.meta.profileId
        && !prior.meta.spaceId
        && prior.meta.provider === ""
        && prior.meta.model === ""
        && prior.history.length === 0
        && !prior.task
      );
      if (prior?.meta.profileId && prior.meta.profileId !== sessionRouteProfileId) {
        process.stderr.write(`hara: session ${shortId(rid)} changed identity while it was being opened; retry the resume.\n`);
        process.exitCode = 2;
        return;
      }
      const authoritativeProfileId = prior?.meta.profileId ?? profileForConfig(cfg).profile.id;
      const authoritativeProfile = getProfile(authoritativeProfileId) ?? profileForConfig(cfg).profile;
      const authoritativeSpaceId = spaceIdForProfile(authoritativeProfile);
      if (
        prior
        && !prior.meta.spaceId
        && !bindablePendingCronOccurrence
        && !(
          prior.meta.profileId === PERSONAL_ID
          && prior.meta.provider !== "hara-gateway"
          && authoritativeProfile.kind === "byok"
        )
      ) {
        process.stderr.write(
          `hara: legacy organization session ${shortId(rid)} has no verifiable Space binding; its history remains local and read-only. Start a new conversation in the intended company.\n`,
        );
        process.exitCode = 2;
        return;
      }
      if (prior?.meta.spaceId && prior.meta.spaceId !== authoritativeSpaceId) {
        process.stderr.write(
          `hara: session ${shortId(rid)} belongs to Space '${prior.meta.spaceId}', but profile '${authoritativeProfileId}' now resolves to '${authoritativeSpaceId}'; refusing to send old history across companies.\n`,
        );
        process.exitCode = 2;
        return;
      }
      meta = prior?.meta ?? {
        id: rid,
        cwd,
        haraVersion: pkg.version,
        profileId: authoritativeProfileId,
        spaceId: authoritativeSpaceId,
        provider: cfg.provider,
        model: cfg.model,
        title: src.source === "interactive" ? "" : automatedTitle(src.source, src.sourceName),
        createdAt: new Date().toISOString(),
        updatedAt: "",
        ...(src.source !== "interactive"
          ? {
              source: src.source,
              sourceName: src.sourceName,
              ...(src.jobId ? { jobId: src.jobId } : {}),
            }
          : { source: "interactive" as const }),
      };
      requiresAudienceBindingSave = !prior || bindablePendingCronOccurrence;
      if (bindablePendingCronOccurrence) delete meta.pendingRouteBinding;
      if (meta.haraVersion !== pkg.version) {
        meta.haraVersion = pkg.version;
        requiresAudienceBindingSave = true;
      }
      if (src.source === "gateway") {
        const gatewayOwner = gatewayOwnerFromSessionId(rid, src.sourceName ?? "");
        if (meta.source !== "gateway") {
          meta.source = "gateway";
          requiresAudienceBindingSave = true;
        }
        if (meta.sourceName !== src.sourceName) {
          meta.sourceName = src.sourceName;
          requiresAudienceBindingSave = true;
        }
        if (gatewayOwner && meta.gatewayOwner !== gatewayOwner) {
          meta.gatewayOwner = gatewayOwner;
          requiresAudienceBindingSave = true;
        }
      } else if (src.source === "cron" && src.jobId && meta.jobId !== src.jobId) {
        meta.source = "cron";
        meta.sourceName = src.sourceName;
        meta.jobId = src.jobId;
        requiresAudienceBindingSave = true;
      }
      meta.profileId = authoritativeProfileId;
      if (!meta.spaceId) {
        meta.spaceId = authoritativeSpaceId;
        requiresAudienceBindingSave = true;
      }
      if (requestedHeadlessAgentRef) {
        if (meta.agentRef && meta.agentRef !== requestedHeadlessAgentRef) {
          process.stderr.write(
            `hara: session ${shortId(rid)} belongs to agent '${meta.agentRef}', not '${requestedHeadlessAgentRef}'; refusing to mix persona history. Start or resume that agent's own thread.\n`,
          );
          process.exitCode = 2;
          return;
        }
        if (!meta.agentRef) {
          if (prior?.history.length) {
            process.stderr.write(
              `hara: session ${shortId(rid)} already has unbound history; refusing to relabel it as '${requestedHeadlessAgentRef}'. Start a fresh agent thread.\n`,
            );
            process.exitCode = 2;
            return;
          }
          meta.agentRef = requestedHeadlessAgentRef;
          requiresAudienceBindingSave = true;
        }
      } else if (meta.agentRef) {
        process.stderr.write(
          `hara: session ${shortId(rid)} is bound to agent '${meta.agentRef}'; resume it with --role ${meta.agentRef} so its persona cannot be dropped.\n`,
        );
        process.exitCode = 2;
        return;
      }
      // Checklist continuity remains in meta; execution identity is restored independently in top-level
      // SessionData.task so transcript/interaction changes cannot silently replace the active objective.
      restoreTodos(meta.todos);
      onTodosChange((list) => {
        if (meta) meta.todos = [...list];
      });
      // The saved profile is an identity boundary. Rebuild from the authoritative under-lock snapshot;
      // never reinterpret an old conversation through whatever organization happens to be active now.
      const desiredModel = opts.model ? String(opts.model) : meta.model || cfg.model;
      try {
        const bound = await buildSessionBoundRuntime(cfg, authoritativeProfileId, desiredModel, meta.effort);
        if (!bound) throw new Error(`profile '${authoritativeProfileId}' is not authenticated`);
        provider = bound.provider;
        __activeP = bound.profile;
        sessionRouteProfileId = authoritativeProfileId;
        meta.provider = provider.id;
        meta.model = desiredModel;
      } catch (error) {
        const message = isOrganizationAuthorizationRejection(error)
          ? organizationAuthorizationRecoveryMessage()
          : redactSensitiveText(error instanceof Error ? error.message : String(error)).text;
        process.stderr.write(`hara: cannot resume session ${shortId(rid)} — ${message}.\n`);
        process.exitCode = 2;
        return;
      }
    }
    assertHeadlessAudience();
    await bindAuxiliaryRuntime(provider, __activeP, meta?.spaceId ?? headlessLaunchSpaceId);
    assertHeadlessAudience();
    if (!(await reloadRequestedHeadlessRole(__activeP))) return;
    assertHeadlessAudience();
    registerRunMcp();
    // --schema: schema-enforced structured output. The schema (inline JSON or a file path) becomes a run-scoped
    // structured_output tool the model MUST call; stdout is then exactly that JSON (streaming suppressed), so
    // scripts / gateway flows / cron parse a guaranteed shape instead of regex-fishing prose.
    let schemaObj: object | null = null;
    if (opts.schema) {
      const rawArg = String(opts.schema);
      let raw = rawArg;
      if (existsSync(rawArg)) {
        try {
          raw = readModelContextFileSync(rawArg, 1024 * 1024);
        } catch (error) {
          process.stderr.write(`hara: refusing unsafe schema file: ${error instanceof Error ? error.message : String(error)}\n`);
          process.exitCode = 2;
          await closeMcp();
          return;
        }
      }
      const parsed = parseSchemaArg(raw);
      if ("error" in parsed) {
        process.stderr.write(`hara: ${parsed.error}\n`);
        process.exitCode = 2;
        await closeMcp();
        return;
      }
      schemaObj = parsed;
    }
    // Recover any steering that was acknowledged by serve before a crash but had not yet reached a model
    // round. The next session write commits its transcript copy and consumed marker atomically.
    const recoveredHeadlessSteering = consumePendingTaskSteering(task);
    if (recoveredHeadlessSteering) {
      task = recoveredHeadlessSteering.task;
      history.push(...recoveredHeadlessSteering.entries.map((entry): NeutralMsg => ({
        role: "user",
        content: `${INTERJECT_PREFIX}\n\n${entry.content}`,
      })));
    }
    // Inbound images (gateway): attach them only to a natively multimodal pinned model. A text-only route
    // receives an explicit marker instead of silently forwarding private chat media to a second model.
    const printText = String(opts.print);
    if (meta && requiresAudienceBindingSave) {
      // Automated recall must first be able to reload the exact durable audience identity. This is especially
      // important for a brand-new gateway thread: without the pre-prompt snapshot, session_search correctly
      // fails closed because no persisted owner exists yet.
      saveSession(meta, history, task);
    }
    const automaticRecall = meta
      ? await automaticSessionRecall(printText, { cwd, sessionId: meta.id })
      : "";
    const userText = (automaticRecall ? `${automaticRecall}\n\n---\n\n` : "")
      + await expandMentionsAsync(printText, cwd)
      + (schemaObj ? STRUCTURED_INSTRUCTION : "");
    const inboundImgs = (process.env.HARA_GATEWAY_IMAGES ?? "")
      .split("\n")
      .map((s) => s.trim())
      .filter((p) => p && existsSync(p))
      .map((p) => ({ path: p, mediaType: mediaTypeFor(p) ?? "image/jpeg" }));
    if (inboundImgs.length && classifyVision(cfg.provider, cfg.model, cfg.modelVision) === "vision") {
      history.push({ role: "user", content: userText, images: inboundImgs }); // native vision → inline
    } else if (inboundImgs.length) {
      const n = inboundImgs.length;
      history.push({
        role: "user",
        content: (
          `${userText}\n\n[${n} image${n > 1 ? "s were" : " was"} not sent to the model because ` +
          `${cfg.model} has no verified native image input. Ask the user to switch this conversation to ` +
          "an image-capable model and resend the image.]"
        ),
      });
    } else {
      history.push({ role: "user", content: userText });
    }
    // A resumed unfinished task keeps its objective; this prompt is a new turn that steers it. A completed
    // task (or a stateless -p run) starts a fresh execution identity. Persist before provider side effects so
    // a crash is recoverable as paused rather than looking like a completed turn.
    const headlessInteraction: TaskInteraction = task && task.status !== "completed" &&
      (recoveredHeadlessSteering !== null || requestsTaskContinuation(String(opts.print)))
      ? newSteerInteraction(task.turnId)
      : newTurnInteraction();
    if (headlessInteraction.kind === "steer") {
      const continued = continueTaskExecution(task, headlessInteraction);
      task = continued.ok ? continued.task : createTaskExecution(String(opts.print), headlessInteraction.turnId);
    } else {
      task = createTaskExecution(String(opts.print), headlessInteraction.turnId);
      clearTodos();
      if (meta) meta.todos = [];
    }
    // The compatibility migration hides abandoned zero-turn drafts instead of deleting them. An explicit
    // resume is the user's reversible restore action: only revive the thread after a real user turn has
    // been staged and every profile/Space/provider check above has succeeded. Failed resume attempts leave
    // the archived draft hidden.
    if (meta?.archived && opts.resume) delete meta.archived;
    if (meta) saveSession(meta, history, task);
    // --role: run this headless turn AS an org role/agent persona (the gateway's /agent switch lands here).
    // Local roles resolve at cwd; qualified project agents were resolved before config/provider startup and
    // cwd is already their registered home. Explicit global roles remain portable in the current project.
    let roleOverride: string | undefined;
    let headlessProvider = provider;
    let headlessToolFilter: ((name: string) => boolean) | undefined;
    let headlessHooks = true;
    const headlessRolePolicyVersion = requestedHeadlessRole && (meta?.spaceId ?? headlessLaunchSpaceId) !== PERSONAL_ID
      ? requestedHeadlessRole.organizationPolicyVersion
      : undefined;
    if (requestedHeadlessRole) {
      roleOverride = requestedHeadlessRole.system;
      headlessToolFilter = roleToolFilter(requestedHeadlessRole);
      if (requestedHeadlessRole.readOnly) headlessHooks = false;
      const roleModel = effectiveRoleModel(requestedHeadlessRole.model, cfg.model);
      if (roleModel && roleModel !== provider.model) {
        assertHeadlessAudience();
        const selected = await buildProvider(cfg, { model: roleModel }, meta?.profileId ?? sessionRouteProfileId);
        assertHeadlessAudience();
        if (!selected) {
          process.stderr.write(`hara: role '${opts.role}' requires model '${roleModel}', but that provider is not authenticated.\n`);
          process.exitCode = 2;
          await closeMcp();
          return;
        }
        headlessProvider = selected;
      }
    }
    let structured: unknown;
    let structuredSet = false;
    const printRunOpts = {
      provider: headlessProvider,
      ctx: {
        cwd,
        sandbox,
        profileId: meta?.profileId ?? sessionRouteProfileId,
        spaceId: meta?.spaceId ?? headlessLaunchSpaceId,
        ...(meta ? { sessionId: meta.id } : {}),
        spawn: (t: string, role?: string, signal?: AbortSignal) => runSubagent(
          cfg,
          headlessProvider,
          cwd,
          sandbox,
          projectContext,
          stats,
          t,
          role,
          signal,
          {
            onProviderTurn: trackHeadlessOperation,
            onToolRun: trackHeadlessOperation,
          },
          meta?.profileId ?? sessionRouteProfileId,
          meta?.spaceId ?? headlessLaunchSpaceId,
        ),
        describeImage,
        inspectImage: (image: ImageAttachment, hint?: string, signal?: AbortSignal) =>
          inspectImageWithCurrentRoute(headlessProvider, __activeP, image, hint, signal, meta?.spaceId ?? headlessLaunchSpaceId),
      },
      approval: "full-auto" as const,
      approvalChannel: false,
      confirm: async () => true,
      projectContext,
      memory: memoryDigest(cwd, meta?.spaceId ?? headlessLaunchSpaceId),
      continuationSession,
      executionContext: taskExecutionContext(task, headlessInteraction, meta?.todos ?? []),
      taskIntake: {
        task,
        current: () => task,
        onUpdate: (next: TaskExecution): void => {
          task = next;
        },
        onCheckpoint: (next: TaskExecution): void => {
          task = next;
          if (meta) saveSession(meta, history, task);
        },
        onRoundUsage: (next: TaskExecution): void => {
          task = next;
          if (meta) saveSession(meta, history, task);
        },
      },
      ...(roleOverride ? { systemOverride: roleOverride } : {}),
      ...(headlessRolePolicyVersion !== undefined
        ? { organizationPolicyVersion: headlessRolePolicyVersion }
        : {}),
      ...(headlessToolFilter ? { toolFilter: headlessToolFilter } : {}),
      hooks: headlessHooks,
      stats,
      guardian: guardianOpt, // safety layer stays on in headless -p (fail-open; breaker aborts, never hangs)
      onProviderTurn: trackHeadlessOperation,
      onToolRun: trackHeadlessOperation,
      ...agentRunLimits(cfg),
      ...(schemaObj
        ? {
            extraTools: [structuredOutputTool(schemaObj, (v: unknown) => ((structured = v), (structuredSet = true)))],
            quiet: true, // stdout must be exactly the JSON — no streamed prose
          }
        : {}),
    };
    let runOutcome = await runAgent(history, printRunOpts);
    if (schemaObj) {
      // The tool call IS the answer — if the model finished without it, nudge and retry (bounded).
      for (let attempt = 0; attempt < 2 && !structuredSet && runOutcome.status === "completed"; attempt++) {
        history.push({ role: "user", content: STRUCTURED_NUDGE });
        runOutcome = await runAgent(history, printRunOpts);
      }
      const failure = runFailureDetail(runOutcome);
      if (failure) {
        // A valid structured_output call is provisional until the whole agent run completes. A later provider
        // error or safety halt must never be hidden behind stale-looking success JSON on stdout.
        process.stderr.write(`hara: structured run failed (${runOutcome.status}) — ${failure}\n`);
        process.exitCode = 2;
      }
      else if (structuredSet) out(JSON.stringify(structured) + "\n");
      else {
        process.stderr.write("hara: model never called structured_output — no result.\n");
        process.exitCode = 2;
      }
    } else {
      const failure = runFailureDetail(runOutcome);
      if (failure) {
        process.stderr.write(`hara: headless run failed (${runOutcome.status}) — ${failure}\n`);
        process.exitCode = 2;
      }
    }
    if (meta) {
      task = finishTaskExecution(task, runOutcome, meta.todos ?? [], false);
      // Long-session safety: auto-compact before saving so a long chat/cron thread never overflows context.
      // Silent (no-op notify) in headless mode so nothing leaks into a captured -p reply. Opt-out via config.
      if (runOutcome.status === "completed") {
        await maybeAutoCompact(
          headlessProvider,
          history,
          meta,
          stats,
          cfg,
          () => {},
          undefined,
          task,
          trackHeadlessOperation,
        );
      }
      saveSession(meta, history, task); // persist when resuming/continuing; plain -p stays stateless
    }
    if (!schemaObj && runOutcome.status === "completed" && (stats.input || stats.output)) out(statusLine(headlessProvider.model, stats.input, stats.output) + "\n");
    await closeMcp();
    return;
    } finally {
      // Do not await here: the logical deadline stays hard. The live drain includes operations registered
      // by an already-observed outer tool after cleanup begins, and releases the PID-backed session lease
      // only when the entire physical tree is empty. Handle-less inert Promises cannot keep the process
      // alive; after process exit the ordinary stale-PID recovery remains authoritative.
      headlessOperations.close();
      await closeMcp();
    }
  }

  // interactive REPL — ink TUI by default on a real terminal; HARA_TUI=0 forces the classic readline path
  const useTui = stdin.isTTY && stdout.isTTY && process.env.HARA_TUI !== "0";
  out(c.bold(`hara ${pkg.version}`) + c.dim(`  ·  ${cfg.provider}:${cfg.model}  ·  ${approval}${sandbox !== "off" ? `  ·  sandbox:${sandbox}` : ""}  ·  ${cwd}\n`));
  if (homeWorkspace) {
    out(c.yellow("⚠ Home or a directory containing it is not treated as a project workspace. Switch with `/cd /path/to/project`, or launch with `hara --cwd /path/to/project`; project-scoped execution is disabled here.\n"));
  }
  // Startup update notice — cache-driven (a previous session's background probe), so it costs zero
  // latency; today's probe (if due) fires in the background for the NEXT launch. TTY sessions only.
  if (cfg.updateCheck && stdout.isTTY) {
    const upd = checkForUpdate(pkg.version);
    if (upd) out(c.yellow(`⬆ ${upd}`) + "\n");
  }
  const rl = createInterface({
    input: stdin,
    output: stdout,
    completer: (line: string): [string[], string] => {
      const sm = /^\/(\w*)$/.exec(line); // `/<partial>` → complete command names
      if (sm) {
        const q = sm[1].toLowerCase();
        return [[...byName.keys()].filter((n) => n.startsWith(q)).sort().map((n) => "/" + n), line];
      }
      return mentionCompleter(line, cwd);
    },
  });
  const confirm = async (q: string, signal?: AbortSignal) => {
    const prompt = `${q} ${c.dim("[y/N]")} `;
    const answer = signal ? await rl.question(prompt, { signal }) : await rl.question(prompt);
    return answer.trim().toLowerCase().startsWith("y");
  };
  // ask_user (classic REPL): print the question + a numbered menu (matching the setup menu look) and read the
  // answer through the SAME rl.question channel confirm uses. A bare option number selects it; any other text
  // is taken as a free-text answer — so the user can always type their own response.
  const askUser = async (q: string, options?: string[], signal?: AbortSignal): Promise<string> => {
    out(c.bold("\n? ") + q + "\n");
    const opts = (options ?? []).map((o) => o.trim()).filter(Boolean);
    opts.forEach((o, i) => out(`  ${c.bold(String(i + 1))}) ${o}\n`));
    const hint = opts.length ? c.dim(`(1-${opts.length} to pick, or type your own answer) `) : c.dim("(type your answer) ");
    const prompt = `${c.cyan("›")} ${hint}`;
    const raw = (signal ? await rl.question(prompt, { signal }) : await rl.question(prompt)).trim();
    if (opts.length) {
      const n = Number.parseInt(raw, 10);
      if (Number.isInteger(n) && n >= 1 && n <= opts.length) return opts[n - 1];
    }
    return raw;
  };
  // shift+tab cycles the approval mode (classic REPL only; the TUI handles its own keys).
  // Bare /approval is the reliable fallback everywhere.
  if (stdin.isTTY && !useTui) {
    try {
      emitKeypressEvents(stdin);
      stdin.on("keypress", (_s: string, key: { name?: string; shift?: boolean } | undefined) => {
        if (key && key.shift && key.name === "tab") {
          approval = bar.nextMode(approval);
          if (bar.isActive()) bar.update({ approval });
        } else if (key?.name === "escape" && currentTurn) {
          currentTurn.abort(); // interrupt the running turn
        }
      });
    } catch {
      /* keypress unavailable; /approval still works */
    }
  }

  // First-run AGENTS.md offer — classic REPL only. In TUI mode we must NOT call rl.question before ink
  // mounts: a readline question puts stdin in a state ink can't read from, leaving the input box dead
  // (the TUI shows a `/init` tip instead, below). See the `tip` in the runTui header.
  if (!homeWorkspace && !hasAgentsMd(cwd) && hasProjectContent(cwd) && !useTui) {
    const ans = (await rl.question(`${c.dim("No AGENTS.md here — analyze this project and create one?")} ${c.dim("[Y/n]")} `)).trim().toLowerCase();
    if (ans === "" || ans.startsWith("y")) {
      out(c.dim("Analyzing project…\n"));
      try {
        await runInit(provider, cwd, sandbox, cfg, __activeP.id, spaceIdForProfile(__activeP));
      } catch (e: any) {
        out(c.red(`[init error] ${e.message}\n`));
      }
    }
  }
  let projectContext = loadAgentContext(cwd) || undefined;
  const refreshProjectContext = (): string | undefined => {
    projectContext = loadAgentContext(cwd) || undefined;
    return projectContext;
  };
  const spawn = (t: string, role?: string, signal?: AbortSignal) => runSubagent(
    cfg,
    provider,
    cwd,
    sandbox,
    projectContext,
    stats,
    t,
    role,
    signal,
    undefined,
    meta.profileId,
    meta.spaceId,
  );

  // session: --resume <id> / --continue (latest in this cwd) / new
  let resumeId: string | null = null;
  if (startupWorkspaceTransferId) {
    resumeId = startupWorkspaceTransferId;
  } else if (opts.resume) {
    const rid = resolveSessionId(opts.resume); // accept a full UUID or a unique prefix (short id)
    resumeId = rid;
    if (!resumeId) out(c.yellow(`(no session '${opts.resume}'; starting fresh)\n`));
  } else if (opts.continue) {
    resumeId = latestForCwd(cwd)?.meta.id ?? null;
    if (!resumeId) out(c.dim("(no prior session in this directory; starting fresh)\n"));
  }
  // Single-writer guard: two hara processes on the SAME session race writes to its append-only history and
  // corrupt it. Acquire BEFORE reading the history, then re-read under the lock so no stale snapshot can
  // overwrite a turn appended between load and lock.
  const sessionId = resumeId ?? newSessionId();
  const lock = acquireSessionLock(sessionId);
  if (!lock.ok) {
    out(
      c.red(`Session ${shortId(sessionId)} is already open in another hara process (pid ${lock.pid}).`) +
        c.dim(` Resuming the same session twice races writes and can corrupt its history. Close that one, or run \`hara\` for a new session. (Override: rm ~/.hara/sessions/${sessionId}.lock)\n`),
    );
    process.exit(1);
  }
  process.on("exit", () => releaseSessionLock(sessionId));
  const resumed: SessionData | null = resumeId ? loadSession(resumeId) : null;
  if (resumeId && sessionFileExists(resumeId) && !resumed) {
    releaseSessionLock(sessionId);
    out(c.red(`Session ${shortId(resumeId)} exists but is unreadable or corrupt; refusing to overwrite it. Inspect ~/.hara/sessions/${resumeId}.json.\n`));
    process.exit(2);
  }
  if (resumed && canonicalProjectPath(resumed.meta.cwd) !== canonicalProjectPath(cwd)) {
    releaseSessionLock(sessionId);
    out(
      c.red(`Session ${shortId(resumed.meta.id)} belongs to ${resumed.meta.cwd}, but this run is rooted at ${cwd}; refusing to resume across project homes.\n`) +
        c.dim(`Run hara from the session's project directory instead.\n`),
    );
    process.exit(2);
  }
  if (resumed?.meta.profileId && resumed.meta.profileId !== sessionRouteProfileId) {
    releaseSessionLock(sessionId);
    out(c.red(`Session ${shortId(sessionId)} changed identity while it was being opened; retry the resume.\n`));
    process.exit(2);
  }
  const legacyProfileBinding = Boolean(resumed && !resumed.meta.profileId);
  const meta: SessionMeta = resumed?.meta ?? {
    id: sessionId,
    cwd,
    haraVersion: pkg.version,
    profileId: sessionRouteProfileId,
    spaceId: spaceIdForProfile(profileForConfig(cfg).profile),
    provider: cfg.provider,
    model: cfg.model,
    title: "",
    createdAt: new Date().toISOString(),
    updatedAt: "",
    source: "interactive",
  };
  meta.haraVersion = pkg.version;
  const authoritativeProfileId = meta.profileId ?? profileForConfig(cfg).profile.id;
  meta.profileId = authoritativeProfileId;
  const currentBoundProfile = getProfile(authoritativeProfileId) ?? profileForConfig(cfg).profile;
  const currentSpaceId = spaceIdForProfile(currentBoundProfile);
  if (
    resumed
    && !resumed.meta.spaceId
    && !(
      resumed.meta.profileId === PERSONAL_ID
      && resumed.meta.provider !== "hara-gateway"
      && currentBoundProfile.kind === "byok"
    )
  ) {
    releaseSessionLock(sessionId);
    out(c.red(`Legacy organization session ${shortId(sessionId)} has no verifiable Space binding; its history remains local and read-only. Start a new conversation in the intended company.\n`));
    process.exit(2);
  }
  if (meta.spaceId && meta.spaceId !== currentSpaceId) {
    releaseSessionLock(sessionId);
    out(c.red(`Session ${shortId(sessionId)} belongs to Space '${meta.spaceId}', but its provider connection now resolves to '${currentSpaceId}'; refusing to send old history across companies.\n`));
    process.exit(2);
  }
  const legacySpaceBinding = Boolean(resumed && !resumed.meta.spaceId);
  meta.spaceId = currentSpaceId;
  // Conversation transcript and task execution are restored independently. A process that disappeared
  // mid-run leaves `running`; recovery turns it into an explicit paused/interrupted task.
  let task: TaskExecution | undefined = recoverTaskExecution(resumed?.task);
  let resumeTaskPending = Boolean(resumeId && task && task.status !== "completed");
  // Task-state continuity (interactive twin of the -p path): restore the checklist, mirror changes onto meta.
  restoreTodos(meta.todos);
  onTodosChange((list) => {
    meta.todos = [...list];
  });
  // Per-session route/model precedence on resume: explicit --model wins inside the session's saved
  // profile; otherwise restore the saved model. Missing/expired/unauthorized routes fail closed instead
  // of degrading to the currently active organization or Personal.
  if (resumed) {
    const desiredModel = opts.model ? String(opts.model) : meta.model || cfg.model;
    try {
      const bound = await buildSessionBoundRuntime(cfg, authoritativeProfileId, desiredModel, meta.effort);
      if (!bound) throw new Error(`profile '${authoritativeProfileId}' is not authenticated`);
      provider = bound.provider;
      __activeP = bound.profile;
      sessionRouteProfileId = authoritativeProfileId;
      meta.provider = provider.id;
      meta.model = desiredModel;
    } catch (error) {
      releaseSessionLock(sessionId);
      out(c.red(`Cannot resume session ${shortId(sessionId)}: ${error instanceof Error ? error.message : String(error)}.\n`));
      process.exit(2);
    }
  }
  if (legacyProfileBinding || legacySpaceBinding) {
    // Migration is an identity decision, not a turn side effect. Persist it as soon as the selected
    // provider has validated so opening and immediately exiting cannot leave the transcript unbound.
    saveSession(meta, resumed?.history ?? [], task);
  }
  const assertInteractiveAudience = (): Profile => {
    if (!meta.spaceId) throw new Error("session has no durable Space binding");
    return assertProfileAudience(cfg, authoritativeProfileId, meta.spaceId);
  };
  const rebuildInteractiveProvider = async (
    model: string,
    effort: HaraConfig["reasoningEffort"] = cfg.reasoningEffort,
  ): Promise<Provider | null> => {
    assertInteractiveAudience();
    const candidateCfg: HaraConfig = { ...cfg, reasoningEffort: effort };
    const nextProvider = await buildProvider(candidateCfg, { model }, authoritativeProfileId);
    const currentProfile = assertInteractiveAudience();
    if (!nextProvider) return null;
    await bindAuxiliaryRuntime(nextProvider, currentProfile, meta.spaceId);
    assertInteractiveAudience();
    cfg.provider = nextProvider.id as ProviderId;
    cfg.model = nextProvider.model;
    cfg.reasoningEffort = effort;
    if (currentProfile.kind === "gateway") {
      cfg.baseURL = currentProfile.baseURL
        || (currentProfile.gatewayUrl ? `${currentProfile.gatewayUrl.replace(/\/+$/, "")}/v1` : undefined);
      cfg.apiKey = undefined;
    } else {
      const target = overrideProviderTarget(
        resolveByokProviderTarget(cfg, currentProfile, false),
        { model: nextProvider.model },
      );
      cfg.baseURL = target.baseURL;
      cfg.apiKey = target.apiKey;
    }
    __activeP = currentProfile;
    return nextProvider;
  };
  try {
    assertInteractiveAudience();
    await bindAuxiliaryRuntime(provider, __activeP, meta.spaceId);
    assertInteractiveAudience();
  } catch (error) {
    releaseSessionLock(sessionId);
    out(c.red(`Cannot initialize session ${shortId(sessionId)}: ${error instanceof Error ? error.message : String(error)}.\n`));
    process.exit(2);
  }
  registerRunMcp();
  const history: NeutralMsg[] = resumed?.history ? [...resumed.history] : [];
  const persistSession = (): void => {
    // Opening an archived legacy draft is read-only until the user actually submits content. The first
    // persisted turn revives it, preserving the reversible archive contract without letting zero-turn
    // drafts silently reappear in the conversation list.
    if (resumeId && meta.archived && history.length > 0) delete meta.archived;
    saveSession(meta, history, task);
  };
  const taskIntakeForRun = () => task
    ? {
        task,
        current: (): TaskExecution | undefined => task,
        onUpdate: (next: TaskExecution): void => {
          task = next;
        },
        onCheckpoint: (next: TaskExecution): void => {
          task = next;
          persistSession();
        },
        onRoundUsage: (next: TaskExecution): void => {
          task = next;
          persistSession();
        },
      }
    : undefined;
  let requestedWorkspaceSwitch: string | null = null;
  let requestedSessionSwitch: { id: string; cwd: string; kind: "resume" | "workspace-transfer"; historyCount?: number } | null = null;
  const queueWorkspaceSwitch = (target: string): string => {
    if (history.length === 0) {
      requestedWorkspaceSwitch = target;
      return `(switching workspace → ${target})`;
    }
    const fork = persistWorkspaceSessionFork({ meta, history, ...(task ? { task } : {}) }, target);
    requestedSessionSwitch = {
      id: fork.meta.id,
      cwd: fork.meta.cwd,
      kind: "workspace-transfer",
      historyCount: history.length,
    };
    return `(switching workspace with ${history.length} messages of current context → ${fork.meta.cwd}; original session stays saved)`;
  };
  const relaunchRequestedTarget = async (): Promise<void> => {
    if (!requestedWorkspaceSwitch && !requestedSessionSwitch) return;
    const sessionSwitch = requestedSessionSwitch;
    const target = sessionSwitch?.cwd ?? requestedWorkspaceSwitch!;
    requestedWorkspaceSwitch = null;
    requestedSessionSwitch = null;
    // The foreground child starts a new session. Do not keep the old session artificially locked for the
    // entire lifetime of the new workspace merely because this small parent process is waiting on it.
    releaseSessionLock(sessionId);
    const args: string[] = [];
    if (opts.profile) args.push("--profile", String(opts.profile));
    if (opts.overlay) args.push("--overlay", String(opts.overlay));
    if (opts.model) args.push("--model", String(opts.model));
    if (opts.yes) args.push("--yes");
    else if (opts.approval) args.push("--approval", String(opts.approval));
    if (opts.sandbox) args.push("--sandbox", String(opts.sandbox));
    if (sessionSwitch) args.push("--resume", sessionSwitch.id);
    out(c.dim(sessionSwitch?.kind === "workspace-transfer"
      ? `Continuing current context as session ${shortId(sessionSwitch.id)} → ${displaySessionCwd(target)}\n`
      : sessionSwitch
        ? `Resuming session ${shortId(sessionSwitch.id)} → ${displaySessionCwd(target)}\n`
        : `Switching workspace → ${target}\n`));
    try {
      const result = await runSelfAttached(args, target);
      if (result.signal) {
        out(c.yellow(`Hara in ${target} stopped by ${result.signal}.\n`));
        process.exitCode = 1;
      } else if (result.code) {
        process.exitCode = result.code;
      }
    } catch (error) {
      out(c.red(`Could not start Hara in ${target}: ${error instanceof Error ? error.message : String(error)}\n`));
      process.exitCode = 1;
    }
  };
  const keepUnfinishedTaskActive = (): void => {
    resumeTaskPending = Boolean(task && task.status !== "completed");
  };
  let continuationSession = Boolean(resumed?.history.length);
  const memorySnap = memoryDigest(cwd, meta.spaceId); // durable reviewed context, read once (frozen snapshot)
  const buildMemory = (): string =>
    (meta.workingSet?.length ? `## Working memory (this task)\n${meta.workingSet.map((w) => `- ${w}`).join("\n")}\n\n` : "") + memorySnap;
  if (resumed) out(c.dim(`(resumed ${shortId(meta.id)} · ${history.length} msgs · model = ${cfg.model})\n`));

  // Explicit vision-first state is shared by `/vision`, pasted attachments, image tools, and computer use.
  // When enabled it wins over native image support: the conversation model receives description text only.
  const interactiveVisionSpaceId = meta.spaceId ?? spaceIdForProfile(__activeP);
  let interactiveVisionRoute = visionRouteForProfile(cfg, __activeP);
  let visionProvider: Provider | null | undefined;
  let remindedVision = false;
  /** `/vision <model|off>` controls vision-first; `/vision main …` corrects native capability metadata. */
  const applyVision = (arg: string): string => {
    const parts = arg.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) {
      const cap = classifyVision(cfg.provider, cfg.model, cfg.modelVision);
      const authorizedModels = authorizedVisionModelsForRoute(cfg, __activeP, interactiveVisionSpaceId);
      const configured = interactiveVisionRoute.model
        ? visionSidecarAuthorized(interactiveVisionRoute.model, authorizedModels)
          ? `${interactiveVisionRoute.model} (all images first)`
          : `${interactiveVisionRoute.model} (not authorized for this Space)`
        : "off";
      return `images — vision-first: ${configured} · conversation model ${cfg.model}: ${cap}${cap === "unknown" ? " (checked on first image)" : ""}`;
    }
    if (parts[0] === "main") {
      const v = parts[1];
      if (!v || !["yes", "no", "auto"].includes(v)) return "usage: /vision main yes|no|auto";
      if (v === "auto") {
        const m = { ...cfg.modelVision };
        delete m[cfg.model];
        cfg.modelVision = m;
        setModelVisionOverride(cfg.model, null);
      } else {
        cfg.modelVision = { ...cfg.modelVision, [cfg.model]: v as "yes" | "no" };
        setModelVisionOverride(cfg.model, v as "yes" | "no");
      }
      return `(${cfg.model} vision = ${v})`;
    }
    if (parts.length === 1 && parts[0].toLowerCase() === "off") {
      if (visionEnvironmentOverride()) return "(HARA_VISION_* controls this route; remove the environment override first)";
      const cleared = setProfileVisionSettings(__activeP.id, undefined);
      if (!cleared.ok) return `(${cleared.reason})`;
      interactiveVisionRoute = { source: "current" };
      if (__activeP.id === PERSONAL_ID) {
        cfg.visionModel = undefined;
        cfg.visionSource = "current";
        cfg.visionProvider = undefined;
        cfg.visionBaseURL = undefined;
        cfg.visionApiKey = undefined;
      } else {
        delete __activeP.visionModel;
        delete __activeP.visionSource;
        delete __activeP.visionProvider;
        delete __activeP.visionBaseURL;
        delete __activeP.visionApiKey;
      }
      visionProvider = undefined;
      return "(vision-first off; image-capable conversation models now receive images directly)";
    }
    const model = parts.join(" ");
    const authorizedModels = authorizedVisionModelsForRoute(cfg, __activeP, interactiveVisionSpaceId);
    if (!visionSidecarAuthorized(model, authorizedModels)) {
      return `(vision-first model '${model}' is not authorized for this company Space)`;
    }
    if (classifyVision(provider.id, model, cfg.modelVision) !== "vision") {
      return `(model '${model}' is not confirmed to accept image input; choose it in Desktop after loading the provider's visual models)`;
    }
    if (visionEnvironmentOverride()) return "(HARA_VISION_* controls this route; remove the environment override first)";
    const saved = setProfileVisionSettings(__activeP.id, { model, source: "current" });
    if (!saved.ok) return `(${saved.reason})`;
    interactiveVisionRoute = { model, source: "current" };
    if (__activeP.id === PERSONAL_ID) {
      cfg.visionModel = model;
      cfg.visionSource = "current";
      cfg.visionProvider = undefined;
      cfg.visionBaseURL = undefined;
      cfg.visionApiKey = undefined;
    } else {
      __activeP.visionModel = model;
      __activeP.visionSource = "current";
      delete __activeP.visionProvider;
      delete __activeP.visionBaseURL;
      delete __activeP.visionApiKey;
    }
    visionProvider = undefined;
    return `(vision-first → ${model}; every image will be described here before the conversation model runs)`;
  };

  const commands: Slash[] = [
    { name: "help", desc: "show this help", run: () => void out(helpText(commands)) },
    {
      name: "cd",
      desc: "switch to a project workspace: /cd <directory>",
      run: (a) => {
        const result = resolveWorkspaceSwitch(a, cwd);
        if (!result.ok) return void out(c.red(`(${result.error})\n`));
        if (result.cwd === realpathSync.native(cwd)) return void out(c.dim(`(already in ${result.cwd})\n`));
        try {
          out(c.dim(queueWorkspaceSwitch(result.cwd) + "\n"));
          return "exit";
        } catch (error) {
          return void out(c.red(`(could not switch workspace without losing context: ${error instanceof Error ? error.message : String(error)})\n`));
        }
      },
    },
    {
      name: "continue",
      desc: "resume the unfinished task: /continue [instruction]",
      // Interactive loops translate this command into an ordinary model turn before slash dispatch. This
      // fallback only protects future callers that invoke the command table directly.
      run: () => void out(c.dim("(type /continue [instruction] in an interactive session)\n")),
    },
    {
      name: "resume",
      desc: "switch to a saved session: /resume <id>",
      run: (a) => {
        if (!a.trim()) {
          const ms = recentSessionMetadata({ sources: ["interactive"], limit: 12 });
          if (!ms.length) return void out(c.dim("No sessions yet.\n"));
          for (const m of ms) {
            out(`  ${shortId(m.id)}  ${c.dim(displaySessionCwd(m.cwd))}  ${m.title || "(untitled)"}\n`);
          }
          return void out(c.dim("Use /resume <id> to switch sessions.\n"));
        }
        const target = resolveSessionResumeTarget(a.trim(), cwd);
        if (!target.ok) {
          if (target.reason === "cwd-unavailable") return void out(c.red(`(saved project unavailable: ${target.cwd})\n`));
          return void out(c.red(`(cannot resume '${a.trim()}': ${target.reason})\n`));
        }
        if (target.id === sessionId) return void out(c.dim("(this session is already open)\n"));
        requestedSessionSwitch = { id: target.id, cwd: target.cwd, kind: "resume" };
        return "exit";
      },
    },
    {
      name: "init",
      desc: "analyze project & regenerate AGENTS.md",
      run: async () => {
        out(c.dim("Analyzing project…\n"));
        try {
          await runInit(provider, cwd, sandbox, cfg, authoritativeProfileId, meta.spaceId);
          projectContext = loadAgentContext(cwd) || undefined;
          out(c.green("AGENTS.md updated.\n"));
        } catch (e: any) {
          out(c.red(`[init error] ${e.message}\n`));
        }
      },
    },
    {
      name: "tools",
      desc: "list available tools",
      run: () => {
        out(c.bold("Tools:\n"));
        for (const t of getTools()) out(`  ${t.name}${t.kind !== "read" ? c.yellow(" *") : ""}  ${c.dim(t.description)}\n`);
        out(c.dim("  * may prompt for confirmation (depends on approval mode)\n"));
      },
    },
    {
      name: "model",
      desc: "show or switch model: /model [id [--force|all]]",
      run: async (a) => {
        try {
          assertInteractiveAudience();
        } catch (error) {
          return void out(c.red(`(${error instanceof Error ? error.message : String(error)})\n`));
        }
        const parts = (a || "").trim().split(/\s+/).filter(Boolean);
        const force = parts.some((p) => p === "--force" || p === "all" || p === "-f");
        const id = parts.find((p) => p !== "--force" && p !== "all" && p !== "-f");
        if (!id) {
          // Bare /model: pinned model + per-role overrides table, so the user sees what's pinned now
          // and which roles deviate from it.
          const __force = isSessionForceModel();
          const __lines = [`${cfg.provider}:${cfg.model}`];
          if (meta.model && meta.model !== cfg.model) {
            __lines.push(c.dim(`session pinned: ${meta.model} (cfg drift — /model ${meta.model} to re-pin)`));
          } else {
            __lines.push(c.dim(`session pinned: ${meta.model || "(none)"}${__force ? c.yellow(" · forced (all roles use session model)") : ""}`));
          }
          const __roles = loadActiveRoles(cwd, authoritativeProfileId);
          if (__roles.length) {
            __lines.push(c.dim("roles:"));
            for (const r of __roles) {
              const eff = __force ? cfg.model : (r.model || cfg.model);
              const tag = __force && r.model && r.model !== cfg.model ? c.yellow(" (overridden by --force)") : r.model ? c.dim(" (role pin)") : c.dim(" (session)");
              __lines.push(`  ${r.id}: ${eff}${tag}`);
            }
          }
          return void out(__lines.join("\n") + "\n");
        }
        try {
          const nextProvider = await rebuildInteractiveProvider(id);
          if (!nextProvider) return void out(c.red("(could not rebuild provider)\n"));
          provider = nextProvider;
          meta.model = nextProvider.model;
          setSessionForceModel(force);
          remindedVision = false;
          if (bar.isActive()) bar.update({ model: nextProvider.model });
          persistSession(); // persist only after provider + Space checks both succeed
          out(c.dim(`(model → ${cfg.provider}:${nextProvider.model}${force ? " · forced (all roles)" : ""})\n`));
        } catch (error) {
          out(c.red(`(${error instanceof Error ? error.message : String(error)})\n`));
        }
      },
    },
    {
      name: "vision",
      desc: "set native image capability for a custom model: /vision main yes|no|auto",
      run: (a) => void out(applyVision(a || "") + "\n"),
    },
    {
      name: "approval",
      desc: `cycle/set approval: /approval [${APPROVAL_MODES.join("|")}]`,
      run: (a) => {
        if (a) {
          if (APPROVAL_MODES.includes(a as ApprovalMode)) approval = a as ApprovalMode;
          else return void out(c.red(`Invalid mode. One of: ${APPROVAL_MODES.join(", ")}\n`));
        } else {
          approval = bar.nextMode(approval); // bare /approval cycles
        }
        bar.update({ approval });
        out(c.dim(`(approval → ${approval})\n`));
      },
    },
    { name: "usage", desc: "show token usage this session", run: () => void out(statusLine(cfg.model, stats.input, stats.output) + "\n") },
    { name: "jobs", desc: "list/tail/kill background shell jobs (dev servers, watchers)", run: (a) => {
      const [sub, jid] = (a || "").trim().split(/\s+/);
      if (sub === "kill" && jid) return void out((killJob(jid) ? `✕ killed ${jid}` : `no running job ${jid}`) + "\n");
      if (sub === "tail" && jid) return void out((tailJob(jid) ?? `no job ${jid}`) + "\n");
      out(renderBgJobs() + "\n");
    } },
    { name: "doctor", desc: "check your hara setup", run: () => void out(runDoctor(cfg) + "\n") },
    {
      name: "roles",
      desc: "list org roles",
      run: () => {
        const rs = loadActiveRoles(cwd, authoritativeProfileId);
        if (!rs.length) return void out(c.dim("No roles. Run `hara roles init`.\n"));
        for (const r of rs) out(`  ${r.id}  ${c.dim(`[${roleMeta(r)}] owns: ${r.owns.join(", ")}`)}\n`);
      },
    },
    {
      name: "skills",
      desc: "list available skills",
      run: () => {
        const ss = loadSkillIndex(cwd);
        if (!ss.length) return void out(c.dim("No skills. Run `hara skills init`.\n"));
        for (const s of ss) out(`  ${s.id}  ${c.dim(s.description)}\n`);
      },
    },
    {
      name: "skill",
      desc: "load a skill's instructions into your next message: /skill <id>",
      run: (a) => {
        if (!a) return void out(c.dim("usage: /skill <id>\n"));
        const sk = loadSkillIndex(cwd).find((s) => s.id === a.trim());
        if (!sk) return void out(c.dim(`(no skill '${a.trim()}')\n`));
        recalledContext += (recalledContext ? "\n\n" : "") + `Skill \`${sk.id}\`:\n${loadSkillBody(sk)}`;
        if (sk.allowedTools !== undefined) {
          recalledSkillPolicies = [...recalledSkillPolicies, { id: sk.id, allowedTools: sk.allowedTools }];
        }
        out(c.green(`↗ loaded skill ${sk.id} (added to your next message)\n`));
      },
    },
    {
      name: "org",
      desc: "dispatch a task to the owning role: /org <task>",
      run: async (a) => {
        if (!a) return void out(c.dim("usage: /org <task>\n"));
        await runOrg(a, {
          cfg,
          baseProvider: provider,
          profileId: authoritativeProfileId,
          spaceId: meta.spaceId!,
          cwd,
          sandbox,
          approval,
          approvalChannel: true,
          confirm,
          projectContext,
          stats,
        });
        out(statusLine(cfg.model, stats.input, stats.output) + "\n");
      },
    },
    {
      name: "plan",
      desc: "decompose + execute a task as atoms (DAG + verify): /plan <task>",
      run: async (a) => {
        if (!a) return void out(c.dim("usage: /plan <task>\n"));
        await runPlan(a, {
          cfg,
          baseProvider: provider,
          profileId: authoritativeProfileId,
          spaceId: meta.spaceId!,
          cwd,
          sandbox,
          approval,
          approvalChannel: true,
          confirm,
          projectContext,
          stats,
        });
        if (bar.isActive()) bar.update({ input: stats.input, output: stats.output, ctxPct: bar.ctxPctFor(cfg.model, stats.lastInput ?? 0) });
        else out(statusLine(cfg.model, stats.input, stats.output) + "\n");
      },
    },
    {
      name: "sessions",
      desc: "list saved sessions",
      run: () => {
        const ms = recentSessionMetadata({ sources: ["interactive"], limit: 100 });
        if (!ms.length) return void out(c.dim("No sessions yet.\n"));
        for (const m of ms) out(`  ${shortId(m.id)}  ${c.dim(m.updatedAt.slice(0, 16).replace("T", " "))}  ${c.dim(displaySessionCwd(m.cwd))}  ${m.title || "(untitled)"}\n`);
      },
    },
    {
      name: "undo",
      desc: "revert the last file change(s) made this session",
      run: async () => {
        const r = await undoLast();
        if ("error" in r) return void out(c.dim(`(${r.error})\n`));
        out(c.green(`↩ reverted: ${r.files.join(", ")}\n`));
      },
    },
    {
      name: "context",
      desc: "show what's filling the context window (token breakdown by category)",
      run: () => void out(formatContextReport(history, cfg.model) + "\n"),
    },
    {
      name: "task",
      desc: "show separated task/run state: /task · /task clear",
      run: (a) => {
        if ((a ?? "").trim() === "clear") {
          task = undefined;
          resumeTaskPending = false;
          persistSession();
          return void out(c.dim("(task state cleared; conversation kept)\n"));
        }
        out(formatTaskExecution(task) + "\n");
      },
    },
    {
      name: "new",
      desc: "start a new task while keeping conversation context",
      run: () => {
        task = undefined;
        resumeTaskPending = false;
        clearTodos();
        meta.todos = [];
        persistSession();
        out(c.dim("(new task boundary; conversation kept — type the new objective)\n"));
      },
    },
    {
      name: "rewind",
      desc: "fork the conversation back to an earlier turn: /rewind (list) · /rewind <n> (files unchanged)",
      run: (a) => {
        const arg = (a ?? "").trim();
        if (!arg) {
          const turns = userTurnPreviews(history);
          return void out(turns.length ? "Recent turns (newest first) — `/rewind <n>` forks from before it (files unchanged):\n" + turns.map((t) => `  ${t.n}. ${t.preview}`).join("\n") + "\n" : c.dim("(nothing to rewind)\n"));
        }
        const nh = rewindTo(history, Number(arg));
        if (!nh) return void out(c.dim(`(no such turn: ${arg})\n`));
        history.length = 0;
        history.push(...nh);
        task = undefined; // the dropped transcript may have owned the current task; do not retain stale identity
        resumeTaskPending = false;
        persistSession();
        out(c.green(`(rewound — dropped the last ${arg} turn(s); ${history.length} messages kept. Files are unchanged. Type your next message.)\n`));
      },
    },
    {
      name: "checkpoint",
      desc: "file-state checkpoints: /checkpoint (list) · /checkpoint restore <n> (revert files to a checkpoint)",
      run: (a) => {
        const parts = (a ?? "").trim().split(/\s+/);
        const cps = listCheckpoints(cwd);
        if (parts[0] !== "restore") {
          return void out(cps.length ? "File checkpoints (newest first) — `/checkpoint restore <n>` reverts files to it:\n" + cps.map((cp, i) => `  ${i + 1}. ${cp.sha}  ${cp.label}`).join("\n") + "\n" : c.dim("(no checkpoints yet — taken before each turn when fileCheckpoints is on)\n"));
        }
        const cp = cps[Number(parts[1]) - 1];
        if (!cp) return void out(c.dim(`(no checkpoint ${parts[1] ?? ""})\n`));
        const k = restoreCheckpoint(cwd, cp.sha);
        out(k == null ? c.red("(restore failed)\n") : c.green(`(restored ${k} file(s) to ${cp.sha} — '${cp.label}'; prior state snapshotted too)\n`));
      },
    },
    {
      name: "evolve",
      desc: "show or run auditable self-evolution: /evolve [status|now]",
      run: async (a) => {
        const action = (a ?? "").trim() || "status";
        if (action === "status") return void out(evolutionStatus(cfg) + "\n");
        if (action !== "now") return void out(c.dim("usage: /evolve [status|now]\n"));
        if (cfg.evolve === "off") return void out(c.dim("(self-evolution is off — set `hara config set evolve light|proactive` first)\n"));
        if (history.length < 2) return void out(c.dim("(not enough session evidence to curate)\n"));
        out(c.dim("Curating evidence-backed memories and reusable skills…\n"));
        const outcome = await curateSessionLearning(provider, history, cfg, {
          cwd,
          sandbox,
          profileId: authoritativeProfileId,
          spaceId: meta.spaceId,
          sessionId: meta.id,
          spawn,
          confirm,
          approvalChannel: true,
          memory: buildMemory(),
          stats,
        });
        persistSession();
        out(outcome.status === "completed" ? c.green("(self-evolution curation complete)\n") : c.yellow(`(self-evolution stopped: ${outcome.error ?? outcome.status})\n`));
      },
    },
    {
      name: "compact",
      desc: "summarize the conversation so far to free up context",
      run: async () => {
        out(c.dim("Compacting…\n"));
        const compactTurn = new AbortController();
        currentTurn = compactTurn;
        let summary: string | null = null;
        try {
          if (cfg.evolve !== "off") {
            const distill = await curateSessionLearning(provider, history, cfg, {
              cwd,
              sandbox,
              profileId: authoritativeProfileId,
              spaceId: meta.spaceId,
              sessionId: meta.id,
              spawn,
              confirm,
              approvalChannel: true,
              memory: buildMemory(),
              stats,
              signal: compactTurn.signal,
            });
            if (distill.status !== "completed") {
              out(c.yellow(`(compact cancelled — self-evolution stopped: ${distill.error ?? distill.status})\n`));
              return;
            }
          }
          summary = await compactConversation(provider, history, meta, stats, compactTurn.signal, task);
        } finally {
          if (currentTurn === compactTurn) currentTurn = null;
        }
        out(summary ? c.green(`(compacted — ${summary.length} chars; context replaced with the summary)\n`) : c.dim("(nothing to compact / compact failed)\n"));
      },
    },
    {
      name: "recall",
      desc: "pull snippets from your code-asset library into context: /recall <query>",
      run: async (a) => {
        if (!a) return void out(c.dim("usage: /recall <query>\n"));
        const hits = await searchHybrid(a, cwd, { indexName: "assets", roots: assetSearchRoots(cwd), limit: 3 });
        if (!hits.length) return void out(c.dim(`(no matches in ${assetsDir()})\n`));
        const block = hits.map((h) => `Recalled \`${h.path}\` (${h.title}):\n${h.snippet}`).join("\n\n");
        recalledContext += (recalledContext ? "\n\n" : "") + block;
        out(c.green(`↗ recalled ${hits.length}: ${hits.map((h) => h.path).join(", ")} (added to your next message)\n`));
      },
    },
    {
      name: "name",
      desc: "rename this session: /name <name>",
      run: (a) => {
        if (!a) return void out(c.dim(`session: ${meta.title || "(untitled)"} · ${meta.id}\n`));
        meta.title = sanitizeSessionTitle(a, 32);
        if (bar.isActive()) bar.update({ sessionName: meta.title });
        persistSession();
        out(c.green(`(renamed → ${meta.title})\n`));
      },
    },
    {
      name: "reset",
      aliases: ["clear"],
      desc: "clear conversation context",
      run: () => {
        history.length = 0;
        task = undefined;
        resumeTaskPending = false;
        recalledContext = "";
        recalledSkillPolicies = [];
        clearTodos();
        meta.todos = [];
        resetReachability();
        resetRepeatGuard();
        clearTouched();
        persistSession();
        out(c.dim("(context cleared)\n"));
      },
    },
    {
      name: "exit",
      aliases: ["quit"],
      desc: "leave",
      run: async () => {
        if (shouldAutoEvolve(cfg.evolve, history.length)) {
          out(c.dim("Distilling session learnings…\n"));
          try {
            await curateSessionLearning(provider, history, cfg, {
              cwd,
              sandbox,
              profileId: authoritativeProfileId,
              spaceId: meta.spaceId,
              sessionId: meta.id,
              spawn,
              confirm,
              approvalChannel: true,
              memory: buildMemory(),
              stats,
            });
            persistSession();
          } catch {
            /* exiting remains available if optional curation fails */
          }
        }
        return "exit";
      },
    },
  ];
  const byName = new Map<string, Slash>();
  for (const cmd of commands) {
    byName.set(cmd.name, cmd);
    for (const a of cmd.aliases ?? []) byName.set(a, cmd);
  }

  if (useTui) {
    rl.close(); // hand stdin over to ink
    // First-run AGENTS.md offer — via a tiny ink prompt, NOT readline. A readline question before the
    // main TUI leaves stdin unreadable by ink (dead input box); ink cleans up on unmount, so the TUI
    // mounted right after gets working input. Runs before mount, like the classic path.
    if (!homeWorkspace && !hasAgentsMd(cwd) && hasProjectContent(cwd)) {
      if (await askConfirm("No AGENTS.md here — analyze this project and create one?")) {
        out(c.dim("Analyzing project…\n"));
        try {
          await runInit(provider, cwd, sandbox, cfg, authoritativeProfileId, meta.spaceId);
        } catch (e: any) {
          out(c.red(`[init error] ${e.message}\n`));
        }
        projectContext = loadAgentContext(cwd) || undefined;
      }
    }
    setTheme(cfg.theme);
    const getImageProvider = async (): Promise<Provider | null> => {
      assertInteractiveAudience();
      if (interactiveVisionRoute.model && visionProvider !== undefined) return visionProvider;
      const route = await buildImageProviderForRoute(cfg, provider, __activeP, interactiveVisionSpaceId);
      if (interactiveVisionRoute.model) visionProvider = route.provider;
      assertInteractiveAudience();
      return route.provider;
    };
    // Computer screenshots use the explicit vision-first model when configured, otherwise the current
    // multimodal conversation model. Only a focused screenshot prompt accompanies the image bytes.
    // Uses the screenshot-tuned prompt (actionable UI elements + positions) + an optional focus hint, so a
    // native multimodal model gets actionable UI context rather than a generic transcription.
    const describeScreenshot = async (path: string, hint?: string, signal?: AbortSignal): Promise<string> => {
      try {
        const vp = await getImageProvider();
        if (!vp) return "";
        const description = await describeImages(vp, [{ path, mediaType: "image/png" }], { system: SCREENSHOT_SYSTEM, hint, signal });
        assertInteractiveAudience();
        return description;
      } catch {
        assertInteractiveAudience();
        return "";
      }
    };
    const inspectImage = (image: ImageAttachment, hint?: string, signal?: AbortSignal) =>
      inspectImageWithCurrentRoute(provider, __activeP, image, hint, signal, meta.spaceId);
    // grounding for accurate RPA: ask the vision model WHERE an element is (0..1 fractions) so the computer
    // tool can click it precisely instead of guessing pixels from a text description.
    const locateScreenshot = async (path: string, target: string, signal?: AbortSignal): Promise<{ x: number; y: number } | null> => {
      try {
        const vp = await getImageProvider();
        if (!vp) return null;
        const location = await locateImage(vp, { path, mediaType: "image/png" }, target, { signal });
        assertInteractiveAudience();
        return location;
      } catch {
        assertInteractiveAudience();
        return null;
      }
    };
    const remindVision = (sink: { notice: (s: string) => void }): void => {
      if (remindedVision) return void sink.notice(`⚠ image skipped — ${cfg.model} is text-only. Configure /vision <model> or switch models.`);
      remindedVision = true;
      sink.notice(
        `⚠ ${cfg.model} is text-only and can't see images, so your image was skipped.\n` +
          "  Configure a vision-first model with /vision <model>, or switch to a native image model, then resend.",
      );
    };
    const resolveImages = async (
      imgs: ImageAttachment[] | undefined,
      h: { sink: { notice: (s: string) => void }; select: (t: string, o: { label: string; value: string }[]) => Promise<string>; signal?: AbortSignal },
    ): Promise<{ extraText?: string; attach?: ImageAttachment[]; skip?: boolean }> => {
      if (!imgs?.length) return {};
      if (interactiveVisionRoute.model) {
        try {
          const vp = await getImageProvider();
          if (!vp) throw new Error("vision-first provider is unavailable");
          h.sink.notice(`✻ reading ${imgs.length} image${imgs.length === 1 ? "" : "s"} with ${interactiveVisionRoute.model} before ${cfg.model}…`);
          const desc = await describeImages(vp, imgs, { signal: h.signal });
          return { extraText: `\n\n[Attached image description — read first by ${interactiveVisionRoute.model}]\n${desc}` };
        } catch (error) {
          const message = h.signal?.aborted
            ? "image description cancelled"
            : `image description failed: ${error instanceof Error ? error.message : String(error)}`;
          h.sink.notice(`(${message})`);
          return { skip: true };
        }
      }
      let cap = classifyVision(cfg.provider, cfg.model, cfg.modelVision);
      if (cap === "unknown") {
        const ans = await h.select(`Can your model "${cfg.model}" understand images (vision)?`, [
          { label: "Yes — send images to it directly", value: "yes" },
          { label: "No — this is a text-only model", value: "no" },
          { label: "Skip the image this time", value: "skip" },
        ]);
        if (ans === "skip") return { skip: true };
        cap = ans === "yes" ? "vision" : "text";
        cfg.modelVision = { ...cfg.modelVision, [cfg.model]: ans as "yes" | "no" };
        setModelVisionOverride(cfg.model, ans as "yes" | "no");
        h.sink.notice(`(remembered: ${cfg.model} ${ans === "yes" ? "supports images" : "is text-only"})`);
      }
      if (cap === "vision") return { attach: imgs };
      remindVision(h.sink);
      return { skip: true };
    };
    // ── Header (rebuilt per 顾雅 spec, 2026-06):
    //   • Single-line logo + tagline (no ASCII banner block).
    //   • Identity line branches on profile kind: personal collapses to `personal <provider>:<model>`
    //     (route host only when baseURL is custom); org spreads to `org <label> · <id> → <host>`
    //     plus its own `model` line annotated with the source (org default / user override).
    //   • cwd line silently appends "· AGENTS.md" when loaded — we never show a negative noise line.
    //   • The optional vision-first route is visible because it changes where every image is processed.
    const __mainCap = classifyVision(cfg.provider, cfg.model, cfg.modelVision);
    const __routeForHeader = routeHost(__activeP);
    // Model-source label (org only). `loadConfig` already merges env > project > overlay > globals,
    // so cfg.model is whatever the runtime will actually use. If it equals the profile's defaultModel
    // we treat it as "org default"; otherwise it's a user override (per-profile setModel, env, or flag).
    const __modelSource =
      __activeP.kind === "gateway"
        ? cfg.model && __activeP.defaultModel && cfg.model === __activeP.defaultModel
          ? "org default"
          : "user override"
        : undefined;
    const __visionNotice = interactiveVisionRoute.model
      ? `vision-first ${interactiveVisionRoute.model} → text for ${cfg.model}`
      : __mainCap === "text"
        ? `${cfg.model} is text-only — configure /vision <model> or switch models before attaching images`
        : undefined;
    await runTui({
      initialStatus: { sessionName: meta.title || shortId(meta.id), approval, input: stats.input, output: stats.output, ctxPct: 0, agents: 0 },
      model: cfg.model,
      cwd,
      agentSlashCommands: loadSkillIndex(cwd).filter((skill) => skill.userInvocable).map((skill) => skill.id),
      header: {
        version: pkg.version,
        modelLabel: `${cfg.provider}:${cfg.model}`,
        cwd,
        agentsMdLoaded: hasAgentsMd(cwd),
        session: meta.id,
        kind: __activeP.kind === "gateway" ? "org" : "personal",
        profileId: __activeP.kind === "gateway" || __activeP.id === PERSONAL_ID ? undefined : __activeP.id,
        orgLabel: __activeP.kind === "gateway" ? __activeP.label : undefined,
        orgId: __activeP.kind === "gateway" ? __activeP.deviceId || __activeP.id : undefined,
        routeHost: __routeForHeader?.host,
        modelSource: __modelSource,
        // the pre-mount stdout notice (line ~2497) doesn't survive ink taking the screen — TUI users
        // never saw update notices and versions silently went stale (field report: stuck on 0.112.5)
        updateNotice: cfg.updateCheck ? (checkForUpdate(pkg.version) ?? undefined) : undefined,
        workspaceNotice: homeWorkspace
          ? "Home is not a project workspace · use /cd /path/to/project to switch"
          : undefined,
      },
      visionNotice: __visionNotice,
      cycleApproval: (m) => cycleMode(m),
      onClipboardImage: readClipboardImage,
      vim: cfg.vimMode,
      onSubmit: async (line, h, images, interaction) => {
        try {
          assertInteractiveAudience();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/^\/(?:exit|quit)\b/i.test(line.trim())) {
            h.sink.notice(`(${message})`);
            return void h.exit();
          }
          return void h.sink.notice(`(${message})`);
        }
        // `/continue` is a task interaction, not a control-only command: turn it into a model message before
        // slash dispatch, preserving the submitted turn id while explicitly targeting the unfinished task.
        const continueCommand = /^\/continue(?:\s+([\s\S]+))?$/i.exec(line.trim());
        if (continueCommand) {
          if (!task || task.status === "completed") return void h.sink.notice("(there is no unfinished task to continue)");
          line = continueCommand[1]?.trim() || "continue";
          interaction = {
            kind: "steer",
            expectedTurnId: task.turnId,
            turnId: interaction?.turnId ?? newTurnInteraction().turnId,
          };
        }
        // Type-ahead steering belongs to every executable Agent turn, including `/skill` kickoff turns.
        // Local slash controls never publish a steer target in App, so they cannot enter this callback.
        const pendingInput = async (): Promise<NeutralMsg[]> => {
          const freshMessages = new Map<string, NeutralMsg>();
          for (const it of h.drainQueue()) {
            const r2 = await resolveImages(it.images, h);
            const body = await expandMentionsAsync(it.line, cwd, { signal: h.signal }) + (r2.skip ? "" : (r2.extraText ?? ""));
            const attach = !r2.skip && r2.attach?.length ? r2.attach : undefined;
            if (!body.trim() && !attach) continue;
            const recorded = recordTaskSteering(task, it.expectedTurnId, body || "(image-only steering)");
            if (!recorded.ok) {
              h.sink.notice(`(steer rejected: ${recorded.reason})`);
              continue;
            }
            task = recorded.task;
            const accepted = task.steering?.at(-1);
            if (accepted?.deliveryState === "pending") {
              freshMessages.set(accepted.id, { role: "user", content: `${INTERJECT_PREFIX}\n\n${body}`, ...(attach ? { images: attach } : {}) });
            }
          }
          const consumed = consumePendingTaskSteering(task);
          if (!consumed) return [];
          const out = consumed.entries.map((entry): NeutralMsg => freshMessages.get(entry.id) ?? ({
            role: "user",
            content: `${INTERJECT_PREFIX}\n\n${entry.content}`,
          }));
          // Write ahead both the transcript projection and the consumed inbox state. Returning [] prevents
          // runAgent from appending the same messages again after this shared live history is updated.
          saveSession(meta, [...history, ...out], consumed.task);
          task = consumed.task;
          history.push(...out);
          return [];
        };
        // A dropped/pasted file path (`/Users/…/doc.md`, maybe trailing text/images) starts with '/' but
        // is NOT a command — treat it as a file to read, not "Unknown command" (see isSlashCommand).
        if (isSlashCommand(line)) {
          const [nm, ...rest] = line.slice(1).split(/\s+/);
          const arg = rest.join(" ").trim();
          if (nm === "cd") {
            const result = resolveWorkspaceSwitch(arg, cwd);
            if (!result.ok) return void h.sink.notice(`(${result.error})`);
            if (result.cwd === realpathSync.native(cwd)) return void h.sink.notice(`(already in ${result.cwd})`);
            try {
              h.sink.notice(queueWorkspaceSwitch(result.cwd));
              return void h.exit();
            } catch (error) {
              return void h.sink.notice(`(could not switch workspace without losing context: ${error instanceof Error ? error.message : String(error)})`);
            }
          }
          if (nm === "resume") {
            if (!arg) {
              const ms = recentSessionMetadata({ sources: ["interactive"], limit: 12 });
              return void h.sink.notice(ms.length
                ? "Saved sessions — /resume <id>:\n" + ms.map((m) => `  ${shortId(m.id)}  ${displaySessionCwd(m.cwd)}  ${m.title || "(untitled)"}`).join("\n")
                : "No sessions yet.");
            }
            const target = resolveSessionResumeTarget(arg, cwd);
            if (!target.ok) {
              if (target.reason === "cwd-unavailable") return void h.sink.notice(`(saved project unavailable: ${target.cwd})`);
              return void h.sink.notice(`(cannot resume '${arg}': ${target.reason})`);
            }
            if (target.id === sessionId) return void h.sink.notice("(this session is already open)");
            requestedSessionSwitch = { id: target.id, cwd: target.cwd, kind: "resume" };
            h.sink.notice(`(resuming ${shortId(target.id)} → ${displaySessionCwd(target.cwd)})`);
            return void h.exit();
          }
          if (nm === "exit" || nm === "quit") {
            if (shouldAutoEvolve(cfg.evolve, history.length)) {
              h.sink.notice("✻ distilling session learnings…");
              try {
                await curateSessionLearning(provider, history, cfg, {
                  cwd,
                  sandbox,
                  profileId: authoritativeProfileId,
                  spaceId: meta.spaceId,
                  sessionId: meta.id,
                  spawn,
                  ui: { text: h.sink.assistantDelta, reasoning: h.sink.reasoningDelta, tool: h.sink.tool, diff: h.sink.diff, notice: h.sink.notice },
                  confirm: h.confirm,
                  approvalChannel: true,
                  memory: buildMemory(),
                  stats,
                  signal: h.signal,
                });
                persistSession();
              } catch {
                /* exit anyway */
              }
            }
            return void h.exit();
          }
          if (nm === "help") return void h.sink.notice(commands.map((x) => `/${x.name} — ${x.desc}`).join("\n"));
          if (nm === "tools")
            return void h.sink.notice(getTools().map((t) => `${t.name}${t.kind !== "read" ? " *" : ""} — ${t.description}`).join("\n"));
          if (nm === "evolve") {
            if (!arg || arg === "status") return void h.sink.notice(evolutionStatus(cfg));
            if (arg !== "now") return void h.sink.notice("usage: /evolve [status|now]");
            if (cfg.evolve === "off") return void h.sink.notice("(self-evolution is off — set `hara config set evolve light|proactive` first)");
            if (history.length < 2) return void h.sink.notice("(not enough session evidence to curate)");
            h.sink.notice("✻ curating evidence-backed memories and reusable skills…");
            const outcome = await curateSessionLearning(provider, history, cfg, {
              cwd,
              sandbox,
              profileId: authoritativeProfileId,
              spaceId: meta.spaceId,
              sessionId: meta.id,
              spawn,
              ui: { text: h.sink.assistantDelta, reasoning: h.sink.reasoningDelta, tool: h.sink.tool, diff: h.sink.diff, notice: h.sink.notice },
              confirm: h.confirm,
              approvalChannel: true,
              memory: buildMemory(),
              stats,
              signal: h.signal,
            });
            persistSession();
            return void h.sink.notice(outcome.status === "completed" ? "(self-evolution curation complete)" : `(self-evolution stopped: ${outcome.error ?? outcome.status})`);
          }
          if (nm === "reset" || nm === "clear") {
            history.length = 0;
            task = undefined;
            resumeTaskPending = false;
            continuationSession = false;
            recalledContext = "";
            recalledSkillPolicies = [];
            resetReachability(); // fresh start — drop any "host unreachable" marks (network may be fixed)
            resetRepeatGuard(); // …and the repeated-failure streaks (the user may have fixed the cause)
            clearTouched();
            clearTodos();
            meta.todos = [];
            persistSession();
            return void h.sink.notice("(context cleared)");
          }
          if (nm === "undo") {
            const r = await undoLast();
            return void h.sink.notice("error" in r ? `(${r.error})` : `↩ reverted: ${r.files.join(", ")}`);
          }
          if (nm === "model") {
            try {
              assertInteractiveAudience();
              const parts = (arg || "").trim().split(/\s+/).filter(Boolean);
              const force = parts.some((p) => p === "--force" || p === "all" || p === "-f");
              const id = parts.find((p) => p !== "--force" && p !== "all" && p !== "-f");
              if (!id) {
                // Bare /model → the interactive picker: the endpoint's live model list (↑↓) + its thinking
                // level (←→, per the registry's reasoning style). Falls back to typing an id if the endpoint
                // doesn't enumerate models.
                const bURL = cfg.baseURL ?? providerDefaultBaseURL(cfg.provider);
                const models = await listModels(
                  bURL,
                  cfg.apiKey ?? "",
                  createModelFetch(cfg.proxy),
                  cfg.model,
                );
                assertInteractiveAudience();
                const style = resolvePlatform(cfg.provider, bURL, undefined, cfg.model).reasoning;
                // Buying advice is endpoint-specific; other providers show a plain list until they have one.
                const hint = isOfficialTokenPlanOpenAIEndpoint(bURL) ? tokenPlanModelHint : undefined;
                const chosen = await h.pickModel({ models, style, current: cfg.model, effort: cfg.reasoningEffort, hint });
                if (!chosen) return; // esc — no change
                const nextModel = chosen.model || cfg.model;
                const nextProvider = await rebuildInteractiveProvider(nextModel, chosen.effort);
                if (!nextProvider) return void h.sink.notice("(could not rebuild provider)");
                provider = nextProvider;
                meta.model = nextProvider.model;
                remindedVision = false;
                persistSession();
                return void h.sink.notice(`(model → ${cfg.provider}:${nextProvider.model} · thinking ${chosen.effort ?? "default"})`);
              }
              const nextProvider = await rebuildInteractiveProvider(id);
              if (!nextProvider) return void h.sink.notice("(could not rebuild provider)");
              provider = nextProvider;
              meta.model = nextProvider.model;
              setSessionForceModel(force);
              remindedVision = false;
              persistSession(); // persist only after provider + Space checks both succeed
              return void h.sink.notice(`(model → ${cfg.provider}:${nextProvider.model}${force ? " · forced (all roles)" : ""})`);
            } catch (error) {
              return void h.sink.notice(`(${error instanceof Error ? error.message : String(error)})`);
            }
          }
          if (nm === "recall") {
            if (!arg) return void h.sink.notice("usage: /recall <query>");
            const hits = await searchHybrid(arg, cwd, { indexName: "assets", roots: assetSearchRoots(cwd), limit: 3 });
            if (!hits.length) return void h.sink.notice(`(no matches in ${assetsDir()})`);
            recalledContext += (recalledContext ? "\n\n" : "") + hits.map((x) => `Recalled \`${x.path}\` (${x.title}):\n${x.snippet}`).join("\n\n");
            return void h.sink.notice(`↗ recalled ${hits.length}: ${hits.map((x) => x.path).join(", ")} (added to your next message)`);
          }
          if (nm === "name") {
            if (!arg) return void h.sink.notice(`session: ${meta.title || "(untitled)"} · ${meta.id}`);
            meta.title = sanitizeSessionTitle(arg, 32);
            h.sink.session(meta.title);
            persistSession();
            return void h.sink.notice(`(renamed → ${meta.title})`);
          }
          if (nm === "context") return void h.sink.notice(formatContextReport(history, cfg.model));
          if (nm === "task") {
            if (arg === "clear") {
              task = undefined;
              resumeTaskPending = false;
              persistSession();
              return void h.sink.notice("(task state cleared; conversation kept)");
            }
            return void h.sink.notice(formatTaskExecution(task));
          }
          if (nm === "new") {
            task = undefined;
            resumeTaskPending = false;
            clearTodos();
            meta.todos = [];
            persistSession();
            return void h.sink.notice("(new task boundary; conversation kept — type the new objective)");
          }
          if (nm === "rewind") {
            if (!arg) {
              const turns = userTurnPreviews(history);
              return void h.sink.notice(turns.length ? "Recent turns (newest first) — /rewind <n> (files unchanged):\n" + turns.map((t) => `  ${t.n}. ${t.preview}`).join("\n") : "(nothing to rewind)");
            }
            const nh = rewindTo(history, Number(arg));
            if (!nh) return void h.sink.notice(`(no such turn: ${arg})`);
            history.length = 0;
            history.push(...nh);
            task = undefined;
            resumeTaskPending = false;
            persistSession();
            return void h.sink.notice(`(rewound — kept ${history.length} messages; files unchanged. Type your next message.)`);
          }
          if (nm === "checkpoint") {
            const parts = arg.split(/\s+/);
            const cps = listCheckpoints(cwd);
            if (parts[0] !== "restore") {
              return void h.sink.notice(cps.length ? "File checkpoints (newest first) — /checkpoint restore <n>:\n" + cps.map((cp, i) => `  ${i + 1}. ${cp.sha}  ${cp.label}`).join("\n") : "(no checkpoints yet)");
            }
            const cp = cps[Number(parts[1]) - 1];
            if (!cp) return void h.sink.notice(`(no checkpoint ${parts[1] ?? ""})`);
            const k = restoreCheckpoint(cwd, cp.sha);
            return void h.sink.notice(k == null ? "(restore failed)" : `(restored ${k} file(s) to ${cp.sha} — '${cp.label}')`);
          }
          if (nm === "compact") {
            if (history.length < 2) return void h.sink.notice("(nothing to compact)");
            h.sink.notice("✻ compacting…");
            const cui = { text: h.sink.assistantDelta, reasoning: h.sink.reasoningDelta, tool: h.sink.tool, diff: h.sink.diff, notice: h.sink.notice };
            let distillOutcome: RunOutcome | undefined;
            if (cfg.evolve !== "off") {
              try {
                distillOutcome = await curateSessionLearning(provider, history, cfg, {
                  cwd,
                  sandbox,
                  profileId: authoritativeProfileId,
                  spaceId: meta.spaceId,
                  sessionId: meta.id,
                  spawn,
                  ui: cui,
                  confirm: h.confirm,
                  approvalChannel: true,
                  memory: buildMemory(),
                  stats,
                  signal: h.signal,
                });
              } catch {
                return void h.sink.notice("(compact cancelled — memory distillation did not complete)");
              }
            }
            if (h.signal.aborted || (distillOutcome && distillOutcome.status !== "completed")) {
              return void h.sink.notice("(compact cancelled — memory distillation was interrupted)");
            }
            const summary = await compactConversation(provider, history, meta, stats, h.signal, task);
            return void h.sink.notice(summary ? `(compacted — kept ${meta.workingSet?.length ?? 0} working-memory notes)` : "(nothing to compact / compact failed)");
          }
          if (nm === "sessions") {
            const ms = recentSessionMetadata({ sources: ["interactive"], limit: 12 });
            return void h.sink.notice(
              ms.length ? ms.slice(0, 12).map((m) => `  ${shortId(m.id)}  ${m.updatedAt.slice(0, 16).replace("T", " ")}  ${displaySessionCwd(m.cwd)}  ${m.title || "(untitled)"}`).join("\n") : "No sessions yet.",
            );
          }
          if (nm === "usage") return void h.sink.notice(`tokens — ↑${stats.input} ↓${stats.output}`);
          if (nm === "jobs") {
            const [sub, jid] = (arg || "").trim().split(/\s+/);
            if (sub === "kill" && jid) return void h.sink.notice(killJob(jid) ? `✕ killed ${jid}` : `no running job ${jid}`);
            if (sub === "tail" && jid) return void h.sink.notice(tailJob(jid) ?? `no job ${jid}`);
            return void h.sink.notice(renderBgJobs());
          }
          if (nm === "doctor") return void h.sink.notice(runDoctor(cfg).replace(/\[[0-9;]*m/g, ""));
          if (nm === "vision") return void h.sink.notice(applyVision(arg));
          if (nm === "roles") {
            const rs = loadActiveRoles(cwd, authoritativeProfileId);
            return void h.sink.notice(rs.length ? rs.map((r) => `  ${r.id} [${roleMeta(r)}] — owns: ${r.owns.join(", ")}`).join("\n") : "No roles. Run `hara roles init`.");
          }
          if (nm === "skills") {
            const ss = loadSkillIndex(cwd);
            return void h.sink.notice(ss.length ? ss.map((s) => `  ${s.id} — ${s.description}`).join("\n") : "No skills. Run `hara skills init`.");
          }
          if (nm === "skill") {
            if (!arg) return void h.sink.notice("usage: /skill <id>");
            const sk = loadSkillIndex(cwd).find((s) => s.id === arg.trim());
            if (!sk) return void h.sink.notice(`(no skill '${arg.trim()}')`);
            recalledContext += (recalledContext ? "\n\n" : "") + `Skill \`${sk.id}\`:\n${loadSkillBody(sk)}`;
            if (sk.allowedTools !== undefined) {
              recalledSkillPolicies = [...recalledSkillPolicies, { id: sk.id, allowedTools: sk.allowedTools }];
            }
            return void h.sink.notice(`↗ loaded skill ${sk.id} (added to your next message)`);
          }
          if (nm === "approval") {
            const all = ["suggest", "auto-edit", "full-auto", "plan"];
            if (arg && !all.includes(arg)) return void h.sink.notice(`Invalid mode. One of: ${all.join(", ")}`);
            const m = (arg || cycleMode(h.approval)) as Approval;
            h.setApproval(m);
            return void h.sink.notice(`(approval → ${m})`);
          }
          if (nm === "diff") {
            try {
              const d = (await runShell(arg === "staged" ? "git diff --staged" : "git diff HEAD", cwd, "off", { timeout: 30_000, maxBuffer: 8_000_000 })).stdout.trim();
              if (!d) return void h.sink.notice(arg === "staged" ? "(nothing staged)" : "(no changes vs HEAD — /diff staged for the index)");
              return void h.sink.diff(d.length > 12_000 ? d.slice(0, 12_000) + "\n…[truncated]" : d);
            } catch {
              return void h.sink.notice("(git diff failed — is this a git repo?)");
            }
          }
          if (nm === "commit") {
            h.sink.notice("✻ writing a commit message…");
            const commitProfile = profileByIdForConfig(cfg, authoritativeProfileId);
            if (!commitProfile) return void h.sink.notice("✗ active identity connection is unavailable; commit was not started");
            const r = await autoCommit(
              provider,
              cwd,
              h.signal,
              companyCommitGuard(cfg, commitProfile, { approvalChannel: true }),
            ); // stages all + commits with an AI message
            return void h.sink.notice(r.startsWith("error:") ? `✗ ${r}` : r === "nothing to commit" ? "(nothing to commit — make or stage changes first)" : `✓ committed · ${r.slice(0, 100)}`);
          }
          if (nm === "review") {
            const changes = captureChanges(cwd, 120_000, { includeUntracked: true });
            if (changes.error) return void h.sink.notice(`(review capture failed closed: ${changes.error})`);
            if (!changes.diff && !changes.newFiles.length && !changes.skippedFiles.length && !changes.omittedDeletions.length) {
              return void h.sink.notice("(nothing to review — no changes vs HEAD)");
            }
            if (changes.skippedFiles.length) {
              h.sink.notice(`Protected paths omitted: ${changes.skippedFiles.map((p) => JSON.stringify(p)).join(", ")}`);
            }
            const rui = { text: h.sink.assistantDelta, reasoning: h.sink.reasoningDelta, tool: h.sink.tool, diff: h.sink.diff, notice: h.sink.notice };
            const xin = stats.input;
            const xout = stats.output;
            await runAgent([{ role: "user", content: standaloneReviewPrompt(changes) }], {
              provider,
              ctx: { cwd, sandbox, profileId: authoritativeProfileId, spaceId: meta.spaceId, ui: rui },
              approval: "full-auto", // read-only via the tool filter, so nothing prompts
              approvalChannel: true,
              confirm: h.confirm,
              toolFilter: (n) => READONLY_TOOLS.has(n),
              hooks: false,
              systemOverride: REVIEW_SYSTEM,
              memory: buildMemory(),
              stats,
              signal: h.signal,
              ...agentRunLimits(cfg),
            });
            h.sink.usage(stats.input - xin, stats.output - xout);
            return;
          }
          if (byName.has(nm))
            return void h.sink.notice(`/${nm} isn't wired into the TUI yet — use \`hara ${nm} …\` as a subcommand, or HARA_TUI=0.`);
          // /<skill> — a user-invocable skill (built-in/global/plugin). ENTER it: load the skill + run a kickoff
          // turn so the agent acts at once (e.g. design mode opens its live workspace + surfaces prior progress).
          {
            const sk = loadSkillIndex(cwd).find((s) => s.id === nm && s.userInvocable);
            if (sk) {
              h.sink.notice(`↗ entering ${sk.id}…`);
              refreshProjectContext();
              resumeTaskPending = false; // an explicit skill entry starts its own task
              clearTodos();
              meta.todos = [];
              const skillContent = `Skill \`${sk.id}\`:\n${loadSkillBody(sk)}\n\n---\nEntering ${sk.id} mode${arg ? ` — request: ${arg}` : ""}. Follow this skill now. If it has a workspace or live preview, OPEN it FIRST so any existing progress is visible, then proceed — offer to continue existing work or start fresh.`;
              const skillInteraction = routeTaskInteraction(task, interaction ?? newTurnInteraction()).interaction;
              if (skillInteraction.kind === "steer") {
                const continued = continueTaskExecution(task, skillInteraction);
                if (!continued.ok) return void h.sink.notice(`(steer rejected: ${continued.reason})`);
                task = continued.task;
              } else {
                task = createTaskExecution(arg || `enter ${sk.id}`, skillInteraction.turnId);
              }
              const skillExecutionContext = taskExecutionContext(task, skillInteraction);
              history.push({ role: "user", content: skillContent });
              persistSession();
              const skin = stats.input;
              const skout = stats.output;
              // `h.approval` is the TUI-level union (includes "plan"); runAgent wants the config-level
              // ApprovalMode (no "plan"). Inside a /<skill> kickoff "plan" wouldn't make sense anyway —
              // fall back to "suggest" so we keep the user's confirm gate without crashing the type check.
              const __skApproval: ApprovalMode = h.approval === "plan" ? "suggest" : h.approval;
              let skillOutcome: RunOutcome | undefined;
              try {
                skillOutcome = await runAgent(history, { provider, ctx: { cwd, sandbox, profileId: authoritativeProfileId, spaceId: meta.spaceId, sessionId: meta.id, spawn, ui: { text: h.sink.assistantDelta, reasoning: h.sink.reasoningDelta, tool: h.sink.tool, diff: h.sink.diff, notice: h.sink.notice }, ask: h.ask, describeImage: describeScreenshot, inspectImage, locate: locateScreenshot }, approval: __skApproval, approvalChannel: true, confirm: h.confirm, autoApprove, projectApprovals, projectContext, memory: buildMemory(), continuationSession, executionContext: skillExecutionContext, ...(sk.allowedTools !== undefined ? { skillPolicies: [{ id: sk.id, allowedTools: sk.allowedTools }] } : {}), taskIntake: taskIntakeForRun(), pendingInput, stats, signal: h.signal, fallback: fbOpt, guardian: guardianOpt, ...agentRunLimits(cfg) });
              } catch (e: any) {
                h.sink.notice(`[error] ${e?.message ?? e}`);
              }
              if (!meta.title && skillOutcome?.status === "completed" && !h.signal.aborted) {
                meta.title = await nameSession(provider, history, h.signal);
                h.sink.session(meta.title);
              }
              h.sink.usage(stats.input - skin, stats.output - skout);
              task = finishTaskExecution(task, skillOutcome, meta.todos ?? [], h.signal.aborted);
              keepUnfinishedTaskActive();
              persistSession();
              return;
            }
          }
          const near = nearest(nm, [...byName.keys()]);
          return void h.sink.notice(`Unknown command /${nm}.${near.length ? " Did you mean " + near.map((n) => "/" + n).join(", ") + "?" : ""}`);
        }
        // A message that begins with an absolute file path (the case skipped above) → inline it as an
        // @-mention so its content is read into the turn (drag-a-file-in → interpret it).
        line = inlineLeadingPath(line, existsSync);
        refreshProjectContext();
        const ui = { text: h.sink.assistantDelta, reasoning: h.sink.reasoningDelta, tool: h.sink.tool, diff: h.sink.diff, notice: h.sink.notice };
        const appr = h.approval;
        let submittedInteraction: TaskInteraction = routeTaskInteraction(
          task,
          interaction ?? newTurnInteraction(),
          { allowInactive: !!continueCommand },
        ).interaction;
        if (resumeTaskPending && task && submittedInteraction.kind === "turn" &&
          (hasPendingTaskSteering(task) || requestsTaskContinuation(line))) {
          submittedInteraction = { kind: "steer", expectedTurnId: task.turnId, turnId: submittedInteraction.turnId };
        }
        const beginExecution = (objective: string): string | null => {
          if (submittedInteraction.kind === "steer") {
            const continued = continueTaskExecution(task, submittedInteraction);
            if (!continued.ok) {
              h.sink.notice(`(steer rejected: ${continued.reason})`);
              return null;
            }
            task = continued.task;
          } else {
            task = createTaskExecution(objective, submittedInteraction.turnId);
            clearTodos();
            meta.todos = [];
          }
          resumeTaskPending = false;
          return taskExecutionContext(task, submittedInteraction, meta.todos ?? []);
        };
        const turnStart = Date.now(); // for the task-done notification (gated on elapsed)
        if (appr === "plan") {
          // PLAN MODE: read-only investigate; the MODEL signals plan-readiness by calling `exit_plan`
          // (Claude-Code style handshake) — only then do we pop the proceed prompt. Turns that were just
          // investigation / Q&A end back at the input, still in plan mode, with no nagging.
          const planImg = await resolveImages(images, h);
          if (planImg.skip) return;
          const automaticRecall = await automaticSessionRecall(line, { cwd, sessionId: meta.id, signal: h.signal });
          const recallPrefix = [recalledContext, automaticRecall].filter(Boolean).join("\n\n");
          const turnSkillPolicies = recalledSkillPolicies;
          const planContent = (recallPrefix ? `${recallPrefix}\n\n---\n\n` : "") + await expandMentionsAsync(line, cwd, { signal: h.signal }) + (planImg.extraText ?? "");
          const executionContext = beginExecution(line);
          if (!executionContext) return;
          history.push({ role: "user", content: planContent, ...(planImg.attach?.length ? { images: planImg.attach } : {}) });
          persistSession();
          recalledContext = "";
          recalledSkillPolicies = [];
          const pin = stats.input;
          const pout = stats.output;
          // Run-scoped tool (never in the registry, so no other mode can see it): captures the proposed
          // plan and renders it as a bordered block (codex's ProposedPlanCell equivalent) via the sink.
          let proposedPlan: string | null = null;
          const exitPlanTool: Tool = {
            name: "exit_plan",
            description:
              "Call when your plan is complete and ready for the user to approve. Pass the FULL plan as concise " +
              "markdown (short numbered steps). This ends the planning phase — after calling it, stop and wait.",
            input_schema: { type: "object", properties: { plan: { type: "string", description: "the complete plan (markdown, short numbered steps)" } }, required: ["plan"] },
            kind: "read", // never prompts — submitting a plan is not a mutation
            run: async (input, tctx) => {
              proposedPlan = String((input as { plan?: unknown })?.plan ?? "").trim();
              if (proposedPlan) tctx.ui?.diff(renderPlanBlock(proposedPlan));
              return "Plan submitted to the user for approval. Stop now and wait for their decision — do not keep working.";
            },
          };
          let planOutcome = await runAgent(history, {
            provider,
            ctx: { cwd, sandbox, profileId: authoritativeProfileId, spaceId: meta.spaceId, sessionId: meta.id, spawn, ui, ask: h.ask, describeImage: describeScreenshot, inspectImage, locate: locateScreenshot },
            approval: "suggest",
            approvalChannel: true,
            confirm: h.confirm,
            toolFilter: (n) => READONLY_TOOLS.has(n) || n === "memory_search" || n === "memory_get" || n === "session_search",
            hooks: false,
            extraTools: [exitPlanTool],
            systemOverride: PLAN_SYSTEM,
            memory: buildMemory(),
            projectContext,
            continuationSession,
            executionContext,
            skillPolicies: turnSkillPolicies,
            taskIntake: taskIntakeForRun(),
            stats,
            signal: h.signal,
            pendingInput,
            ...agentRunLimits(cfg),
          });
          if (!meta.title && planOutcome.status === "completed" && !h.signal.aborted) {
            meta.title = await nameSession(provider, history, h.signal);
            h.sink.session(meta.title);
          }
          h.sink.usage(stats.input - pin, stats.output - pout);
          persistSession();
          if (planOutcome.status !== "completed" || h.signal.aborted) {
            task = finishTaskExecution(task, planOutcome, meta.todos ?? [], h.signal.aborted);
            keepUnfinishedTaskActive();
            persistSession();
            notifyDone(cfg.notify, {
              message: planOutcome.error ?? "plan turn did not complete",
              elapsedMs: Date.now() - turnStart,
              minMs: 0,
            });
            return;
          }
          if (!proposedPlan) {
            // No exit_plan this turn — the model was investigating or answering. Stay in plan mode quietly.
            task = finishTaskExecution(task, planOutcome, meta.todos ?? [], h.signal.aborted);
            keepUnfinishedTaskActive();
            persistSession();
            notifyDone(cfg.notify, {
              message: meta.title || "plan turn complete",
              elapsedMs: Date.now() - turnStart,
            });
            return;
          }
          const choice = await h.select("hara has a plan — proceed?", [
            { label: "Yes, and auto-apply edits", value: "auto-edit" },
            { label: "Yes, approve each edit", value: "suggest" },
            { label: "No, keep planning  (esc)", value: "no" },
          ]);
          if (choice !== "no") {
            h.setApproval(choice as "auto-edit" | "suggest");
            history.push({ role: "user", content: "Proceed: execute the plan above." });
            const xin = stats.input;
            const xout = stats.output;
            planOutcome = await runAgent(history, {
              provider,
              ctx: { cwd, sandbox, profileId: authoritativeProfileId, spaceId: meta.spaceId, sessionId: meta.id, spawn, ui, ask: h.ask, describeImage: describeScreenshot, inspectImage, locate: locateScreenshot },
              approval: choice as ApprovalMode,
              approvalChannel: true,
              memory: buildMemory(),
              confirm: h.confirm,
              autoApprove,
              projectApprovals,
              projectContext,
              continuationSession,
              executionContext,
              skillPolicies: turnSkillPolicies,
              taskIntake: taskIntakeForRun(),
              stats,
              signal: h.signal,
              pendingInput,
              guardian: guardianOpt,
              ...agentRunLimits(cfg),
            });
            h.sink.usage(stats.input - xin, stats.output - xout);
          }
          task = choice === "no"
            ? finishTaskExecution(task, planOutcome, [{ text: "execute approved plan", status: "pending" }], false)
            : finishTaskExecution(task, planOutcome, meta.todos ?? [], h.signal.aborted);
          keepUnfinishedTaskActive();
          persistSession();
          notifyDone(cfg.notify, {
            message: planOutcome.status === "halted" ? (planOutcome.error ?? "agent run halted") : (meta.title || "plan turn complete"),
            elapsedMs: Date.now() - turnStart,
            minMs: planOutcome.status === "halted" ? 0 : undefined,
          });
          return;
        }
        const ri = await resolveImages(images, h);
        if (ri.skip) return;
        const automaticRecall = await automaticSessionRecall(line, { cwd, sessionId: meta.id, signal: h.signal });
        const recallPrefix = [recalledContext, automaticRecall].filter(Boolean).join("\n\n");
        const turnSkillPolicies = recalledSkillPolicies;
        const userContent = (recallPrefix ? `${recallPrefix}\n\n---\n\n` : "") + await expandMentionsAsync(line, cwd, { signal: h.signal }) + (ri.extraText ?? "");
        recalledContext = "";
        recalledSkillPolicies = [];
        const executionContext = beginExecution(line);
        if (!executionContext) return;
        history.push({ role: "user", content: userContent, ...(ri.attach?.length ? { images: ri.attach } : {}) });
        persistSession();
        if (cfg.fileCheckpoints) checkpoint(cwd, line.slice(0, 80)); // shadow-git snapshot before the turn mutates
        const beforeIn = stats.input;
        const beforeOut = stats.output;
        const turnOutcome = await runAgent(history, {
          provider,
          ctx: { cwd, sandbox, profileId: authoritativeProfileId, spaceId: meta.spaceId, sessionId: meta.id, spawn, ui, ask: h.ask, describeImage: describeScreenshot, inspectImage, locate: locateScreenshot },
          approval: appr,
          approvalChannel: true,
          memory: buildMemory(),
          confirm: h.confirm,
          autoApprove,
          projectApprovals,
          projectContext,
          continuationSession,
          executionContext,
          skillPolicies: turnSkillPolicies,
          taskIntake: taskIntakeForRun(),
          stats,
          signal: h.signal,
          pendingInput,
          fallback: fbOpt,
          guardian: guardianOpt,
          ...agentRunLimits(cfg),
        });
        if (!meta.title && turnOutcome.status === "completed" && !h.signal.aborted) {
          meta.title = await nameSession(provider, history, h.signal);
          h.sink.session(meta.title);
        }
        h.sink.usage(stats.input - beforeIn, stats.output - beforeOut);
        notifyDone(cfg.notify, {
          message: turnOutcome.status === "halted" ? (turnOutcome.error ?? "agent run halted") : (meta.title || "turn complete"),
          elapsedMs: Date.now() - turnStart,
          minMs: turnOutcome.status === "halted" ? 0 : undefined,
        });
        task = finishTaskExecution(task, turnOutcome, meta.todos ?? [], h.signal.aborted);
        keepUnfinishedTaskActive();
        persistSession();
        if (turnOutcome.status === "completed" && !h.signal.aborted) {
          await maybeAutoCompact(provider, history, meta, stats, cfg, (m) => h.sink.notice(m), h.signal, task);
        }
      },
    });
    // Only claim "saved · resume" if a turn actually persisted the session. A zero-turn session (opened,
    // then exited without submitting anything) is never written by saveSession — so printing the resume
    // hint would mislead and `hara resume <id>` would fail with "no session matching".
    if (loadSession(meta.id))
      out("\n" + c.dim("Session ") + c.bold(shortId(meta.id)) + c.dim(" saved · resume:  ") + c.cyan(`hara resume ${shortId(meta.id)}`) + "\n");
    await closeMcp();
    await relaunchRequestedTarget();
    process.exit(process.exitCode ?? 0); // TUI done — exit cleanly (ink can leave stdin referenced)
  }

  out(c.dim(`Type a task. /help · @path attaches a file · shift+tab cycles mode · Esc interrupts · /exit to quit.${hasAgentsMd(cwd) ? "  (AGENTS.md loaded)" : ""}\n\n`));

  bar.install({ sessionName: meta.title || shortId(meta.id), model: cfg.model, approval, input: stats.input, output: stats.output, profileId: __activeP.id, profileKind: __activeP.kind });
  process.on("exit", () => {
    try {
      bar.uninstall();
    } catch {
      /* best-effort terminal reset */
    }
  });

  for (;;) {
    bar.renderTop(); // top border + session name
    let line: string;
    try {
      line = (await rl.question(c.cyan("› "))).trim();
    } catch {
      break;
    }
    bar.renderBottom(); // bottom border + modes/usage
    if (!line) continue;
    try {
      assertInteractiveAudience();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      out(c.red(`(${message})\n`));
      if (/^\/(?:exit|quit)\b/i.test(line)) break;
      continue;
    }
    let forcedContinuation: Extract<TaskInteraction, { kind: "steer" }> | undefined;
    const continueCommand = /^\/continue(?:\s+([\s\S]+))?$/i.exec(line);
    if (continueCommand) {
      if (!task || task.status === "completed") {
        out(c.dim("(there is no unfinished task to continue)\n"));
        continue;
      }
      line = continueCommand[1]?.trim() || "continue";
      forcedContinuation = newSteerInteraction(task.turnId);
    }
    // A dropped/pasted file path starts with '/' but isn't a command — read it, don't error (see TUI path).
    if (isSlashCommand(line)) {
      const [name, ...rest] = line.slice(1).split(/\s+/);
      const cmd = byName.get(name);
      if (!cmd) {
        const sk = loadSkillIndex(cwd).find((s) => s.id === name && s.userInvocable);
        if (sk) {
          // ENTER the mode: load the skill + run a kickoff turn now (mirrors the TUI path) so e.g. /design
          // opens its workspace + surfaces prior progress immediately, instead of just staging context.
          out(c.dim(`↗ entering ${sk.id}…\n`));
          refreshProjectContext();
          const skillContent = `Skill \`${sk.id}\`:\n${loadSkillBody(sk)}\n\n---\nEntering ${sk.id} mode${rest.length ? ` — request: ${rest.join(" ")}` : ""}. Follow this skill now. If it has a workspace or live preview, OPEN it FIRST so any existing progress is visible, then proceed — offer to continue existing work or start fresh.`;
          const skillInteraction = newTurnInteraction();
          resumeTaskPending = false;
          clearTodos();
          meta.todos = [];
          task = createTaskExecution(rest.join(" ") || `enter ${sk.id}`, skillInteraction.turnId);
          const skillExecutionContext = taskExecutionContext(task, skillInteraction);
          history.push({ role: "user", content: skillContent });
          persistSession();
          const skillTurn = new AbortController();
          currentTurn = skillTurn;
          let skillOutcome: RunOutcome | undefined;
          try {
            skillOutcome = await runAgent(history, { provider, ctx: { cwd, sandbox, profileId: authoritativeProfileId, spaceId: meta.spaceId, sessionId: meta.id, spawn, ask: askUser, inspectImage: (image, hint, signal) => inspectImageWithCurrentRoute(provider, __activeP, image, hint, signal, meta.spaceId) }, approval, approvalChannel: true, confirm, autoApprove, projectApprovals, projectContext, memory: buildMemory(), continuationSession, executionContext: skillExecutionContext, ...(sk.allowedTools !== undefined ? { skillPolicies: [{ id: sk.id, allowedTools: sk.allowedTools }] } : {}), taskIntake: taskIntakeForRun(), stats, signal: skillTurn.signal, fallback: fbOpt, guardian: guardianOpt, ...agentRunLimits(cfg) });
          } catch (e: any) {
            out(c.red(`\n[error] ${e.message}\n`));
          }
          try {
            if (!meta.title && skillOutcome?.status === "completed" && !skillTurn.signal.aborted) {
              meta.title = await nameSession(provider, history, skillTurn.signal);
            }
            task = finishTaskExecution(task, skillOutcome, meta.todos ?? [], skillTurn.signal.aborted);
            keepUnfinishedTaskActive();
            persistSession();
          } finally {
            if (currentTurn === skillTurn) currentTurn = null;
          }
          continue;
        }
        const near = nearest(name, [...byName.keys()]);
        const hint = near.length ? c.dim(` Did you mean ${near.map((n) => "/" + n).join(", ")}?`) : "";
        out(c.red(`Unknown command /${name}.`) + hint + c.dim(" — /help for the list.\n"));
        continue;
      }
      const res = await cmd.run(rest.join(" "));
      if (res === "exit") break;
      continue;
    }
    line = inlineLeadingPath(line, existsSync); // leading dropped file path → @-mention so it's read in
    refreshProjectContext();
    const automaticRecall = await automaticSessionRecall(line, { cwd, sessionId: meta.id });
    const recallPrefix = [recalledContext, automaticRecall].filter(Boolean).join("\n\n");
    const turnSkillPolicies = recalledSkillPolicies;
    const userContent = (recallPrefix ? `${recallPrefix}\n\n---\n\n` : "") + await expandMentionsAsync(line, cwd);
    recalledContext = "";
    recalledSkillPolicies = [];
    const recoveredClassicSteering = consumePendingTaskSteering(task);
    if (recoveredClassicSteering) {
      task = recoveredClassicSteering.task;
      history.push(...recoveredClassicSteering.entries.map((entry): NeutralMsg => ({
        role: "user",
        content: `${INTERJECT_PREFIX}\n\n${entry.content}`,
      })));
    }
    let interaction: TaskInteraction = forcedContinuation ?? newTurnInteraction();
    if (resumeTaskPending && task && (recoveredClassicSteering !== null || requestsTaskContinuation(line))) {
      interaction = newSteerInteraction(task.turnId);
    }
    if (interaction.kind === "steer") {
      const continued = continueTaskExecution(task, interaction);
      if (!continued.ok) {
        out(c.red(`(steer rejected: ${continued.reason})\n`));
        continue;
      }
      task = continued.task;
    } else {
      task = createTaskExecution(line, interaction.turnId);
      clearTodos();
      meta.todos = [];
    }
    resumeTaskPending = false;
    const executionContext = taskExecutionContext(task, interaction, meta.todos ?? []);
    history.push({ role: "user", content: userContent });
    persistSession();
    if (cfg.fileCheckpoints) checkpoint(cwd, userContent.slice(0, 80)); // shadow-git snapshot before the turn mutates
    const turnController = new AbortController();
    currentTurn = turnController;
    const t0 = Date.now();
    let turnOutcome: RunOutcome | undefined;
    try {
      turnOutcome = await runAgent(history, { provider, ctx: { cwd, sandbox, profileId: authoritativeProfileId, spaceId: meta.spaceId, sessionId: meta.id, spawn, ask: askUser, inspectImage: (image, hint, signal) => inspectImageWithCurrentRoute(provider, __activeP, image, hint, signal, meta.spaceId) }, approval, approvalChannel: true, confirm, autoApprove, projectApprovals, projectContext, memory: buildMemory(), continuationSession, executionContext, skillPolicies: turnSkillPolicies, taskIntake: taskIntakeForRun(), stats, signal: turnController.signal, fallback: fbOpt, guardian: guardianOpt, ...agentRunLimits(cfg) });
    } catch (e: any) {
      out(c.red(`\n[error] ${e.message}\n`));
    }
    notifyDone(cfg.notify, {
      message: turnOutcome?.status === "halted" ? (turnOutcome.error ?? "agent run halted") : (meta.title || "turn complete"),
      elapsedMs: Date.now() - t0,
      minMs: turnOutcome?.status === "halted" ? 0 : undefined,
    });
    try {
      if (!meta.title && turnOutcome?.status === "completed" && !turnController.signal.aborted) {
        meta.title = await nameSession(provider, history, turnController.signal);
      }
      if (bar.isActive()) {
        bar.update({
          sessionName: meta.title,
          input: stats.input,
          output: stats.output,
          ctxPct: bar.ctxPctFor(cfg.model, stats.lastInput ?? 0),
        });
      } else {
        out(statusLine(cfg.model, stats.input, stats.output) + "\n\n");
      }
      task = finishTaskExecution(task, turnOutcome, meta.todos ?? [], turnController.signal.aborted);
      keepUnfinishedTaskActive();
      persistSession();
      const compacted = turnOutcome?.status === "completed" && !turnController.signal.aborted
        ? await maybeAutoCompact(provider, history, meta, stats, cfg, (m) => out(c.dim(`${m}\n`)), turnController.signal, task)
        : false;
      if (!compacted) {
        const ctxPct = bar.ctxPctFor(cfg.model, stats.lastInput ?? 0);
        if (ctxPct >= 80) out(c.yellow(`  ⚠ context ${ctxPct}% full — /compact to summarize, or /clear to reset\n`));
      }
    } finally {
      if (currentTurn === turnController) currentTurn = null;
    }
  }
  bar.uninstall();
  if (loadSession(meta.id))
    out("\n" + c.dim("Session ") + c.bold(shortId(meta.id)) + c.dim(" saved · resume:  ") + c.cyan(`hara resume ${shortId(meta.id)}`) + "\n");
  rl.close();
  await closeMcp();
  await relaunchRequestedTarget();
});

program.parseAsync().catch((e) => {
  try {
    bar.uninstall();
  } catch {
    /* ignore */
  }
  out(c.red(`\n[fatal] ${e?.message ?? e}\n`));
  process.exit(1);
});
