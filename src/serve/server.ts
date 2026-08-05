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
  shouldAutoCompactTokens,
  workingSetFromSummary,
} from "../agent/compact.js";
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
import type { ApprovalMode } from "../config.js";
import type { SandboxMode } from "../sandbox.js";
import { loadAgentContext } from "../context/agents-md.js";
import {
  expandExplicitAttachmentsAsync,
  expandMentionsAsync,
} from "../context/mentions.js";
import type { EffectiveAttachmentCapabilities } from "../vision.js";
import { memoryDigest } from "../memory/store.js";
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
import { parseDeliver } from "../cron/deliver.js";
import { installScheduler, isInstalled } from "../cron/install.js";
import { runJobTracked, selfArgv } from "../cron/runner.js";
import { loadTasks } from "../tools/task.js";
import { listPending, resolvePending } from "../gateway/flows-pending.js";
import { disposeTodoScope, onTodosChange, restoreTodos, serializeTodos } from "../tools/todo.js";
import { INTERJECT_PREFIX, disposeReminderScope } from "../agent/reminders.js";
import { SessionHub, realStore, type SessionStore, type ServeSession } from "./sessions.js";
import { ensureSessionMetadataIndex } from "../session/store.js";
import { parseFrame, rpcResult, rpcError, rpcNotify, ERR, PROTOCOL_VERSION } from "./protocol.js";
import {
  taskLifecycleEvent,
  type TaskLifecycleActivity,
  type TaskLifecycleCursor,
} from "./task-events.js";
import { readModelContextFileSync } from "../fs-read.js";
import { optionalPosixOpenFlag } from "../fs-open-flags.js";
import { tightenPrivateDescriptorMode } from "../fs-permissions.js";
import { sameOpenedFileIdentity } from "../fs-identity.js";
import { redactSensitiveText, redactSensitiveValue } from "../security/secrets.js";
import { projectApprovalPolicy } from "../security/project-approvals.js";
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

/** What the CLI entry injects (built in index.ts, where config/providers/guardian already live). */
export interface ServeDeps {
  version: string;
  providerId: string;
  model: string;
  buildSessionProvider: (cwd?: string, profileId?: string) => Promise<Provider | null>; // fresh live config/credential route
  /** provider for a specific model/effort — powers per-session model switching (composer picker) */
  buildProviderFor?: (model: string, effort?: string, cwd?: string, profileId?: string) => Promise<Provider | null>;
  /** live model list from the endpoint (may be empty — not every endpoint enumerates) */
  listModels?: (cwd?: string, profileId?: string) => Promise<string[]>;
  /** Live per-project context policy. Production re-reads config for every completed turn; embedders that
   * omit it retain manual-only `session.compact` behavior. */
  autoCompact?: (cwd?: string) => { enabled: boolean; tokenCap?: number };
  /** Normalize image input for the session's pinned model: keep native images or translate them
   * through a configured vision sidecar. The callback is identity-aware and must never reroute profiles. */
  prepareImages?: (
    images: ImageAttachment[],
    opts: {
      cwd: string;
      model: string;
      profileId?: string;
      signal: AbortSignal;
    },
  ) => Promise<{ images?: ImageAttachment[]; description?: string; viaModel?: string }>;
  /** Redacted provider/local-model control plane for Desktop settings. Credentials are accepted only by
   * save/test and must never be returned by these callbacks. */
  providerSettings?: (cwd?: string) => ProviderSettingsState;
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
  runtimeInfo?: (cwd?: string, model?: string, profileId?: string) => {
    providerId: string;
    model: string;
    /** Effective identity route. Persisted into each new session and reused on resume. */
    profileId?: string;
    effortLevels?: string[];
    /** Finite server-authorized set for a scoped gateway token. Missing means unconstrained discovery. */
    availableModels?: string[];
    /** Effective Hara input chain, including a configured vision sidecar when present. */
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
    observers?: Pick<RunOpts, "onProviderTurn" | "onToolRun">,
    profileId?: string,
  ) => Promise<string>;
  guardian?: { provider?: Provider | null; enabled?: boolean };
  buildGuardian?: (cwd?: string, profileId?: string) => Promise<{ provider?: Provider | null; enabled?: boolean } | undefined>;
  sandbox: SandboxMode;
  approval: ApprovalMode;
  store?: SessionStore; // tests inject a hermetic store
  quietDiscovery?: boolean; // tests: skip ~/.hara/serve.json
  discoveryHome?: string; // tests: isolate the discovery file from the real home directory
  artifactHome?: string; // tests/embedders: isolate ~/.hara/artifacts from the real home directory
  compactTimeoutMs?: number; // tests/embedders: bound a provider that ignores cancellation
}

export interface ServeAutoCompactDecision {
  compact: boolean;
  pct: number;
  tokenCap: number;
}

/** Shared, deterministic trigger for Desktop/Serve auto-compaction. Keep it separate from the provider
 * call so configuration corruption cannot turn every short conversation into a summarization request. */
export function serveAutoCompactDecision(
  model: string,
  lastInput: number,
  historyLength: number,
  policy: { enabled: boolean; tokenCap?: number } | undefined,
): ServeAutoCompactDecision {
  const safeLastInput = Number.isFinite(lastInput) ? Math.max(0, Math.floor(lastInput)) : 0;
  const tokenCap = autoCompactTokenCap(policy?.tokenCap);
  const enabled = policy?.enabled === true;
  const pct = ctxPctFor(model, safeLastInput);
  return {
    compact:
      shouldAutoCompact(pct, historyLength, enabled)
      || shouldAutoCompactTokens(safeLastInput, historyLength, enabled, tokenCap),
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
  };
  providers: ProviderSettingsCatalogEntry[];
  connections?: ProviderConnectionSummary[];
  switchLocked?: boolean;
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
}

export interface ProviderSettingsInput {
  provider: string;
  model: string;
  baseURL?: string;
  apiKey?: string;
  clearApiKey?: boolean;
  activatePersonal?: boolean;
}

export interface ProviderConnectionCreateInput extends ProviderSettingsInput {
  id: string;
  label: string;
  activate?: boolean;
}

export interface ProviderSettingsTestResult {
  ok: boolean;
  models: string[];
  error?: string;
}

export type OrganizationAccessState = "valid" | "permanent" | "expiring" | "expired" | "legacy" | "invalid";

export interface OrganizationConnectionSummary {
  id: string;
  label: string;
  active: boolean;
  gatewayUrl: string;
  gatewayHost: string;
  model: string;
  availableModels?: string[];
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
} {
  if (!job.deliver) return { kind: "none", label: "Saved only in Hara" };
  const parsed = parseDeliver(job.deliver);
  const mode = job.deliverMode ?? "always";
  if ("error" in parsed) return { kind: "other", label: "External delivery · configured", mode };
  const labels = {
    feishu: "Feishu · configured",
    weixin: "WeChat · configured",
    telegram: "Telegram · configured",
    webhook: "Webhook · configured",
  } as const;
  return { kind: parsed.platform, label: labels[parsed.platform], mode };
}

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
    const installed = isInstalled();
    return {
      installed,
      supported: true,
      platform: currentPlatform,
      detail: installed
        ? "The local scheduler is installed."
        : "Install the local scheduler once so enabled tasks can run while Desktop is closed.",
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
  const token = opts.token ?? randomBytes(16).toString("hex");
  const instanceId = randomUUID();
  const hub = new SessionHub(deps.store ?? realStore);
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
  const runtimeInfo = (cwd?: string, model?: string, profileId?: string): {
    providerId: string;
    model: string;
    profileId?: string;
    effortLevels: string[];
    availableModels?: string[];
    attachmentCapabilities?: EffectiveAttachmentCapabilities;
  } => {
    const live = deps.runtimeInfo?.(cwd, model, profileId);
    return {
      providerId: live?.providerId ?? deps.providerId,
      model: live?.model ?? model ?? deps.model,
      ...(live?.profileId ? { profileId: live.profileId } : profileId ? { profileId } : {}),
      effortLevels: live?.effortLevels ?? deps.effortLevels ?? [],
      ...(live?.availableModels ? { availableModels: live.availableModels } : {}),
      ...(live?.attachmentCapabilities
        ? { attachmentCapabilities: live.attachmentCapabilities }
        : {}),
    };
  };
  const refreshSessionProvider = async (session: ServeSession): Promise<boolean> => {
    const fresh = deps.buildProviderFor
      ? await deps.buildProviderFor(session.meta.model, session.effort, session.meta.cwd, session.meta.profileId)
      : await deps.buildSessionProvider(session.meta.cwd, session.meta.profileId);
    if (!fresh || fresh.model !== session.meta.model) return false;
    session.provider = fresh;
    session.meta.provider = fresh.id;
    return true;
  };
  const wss = new WebSocketServer({ host: opts.host, port: opts.port, maxPayload: 10 * 1024 * 1024 });
  await new Promise<void>((res, rej) => {
    wss.once("listening", res);
    wss.once("error", rej);
  });
  const port = (wss.address() as { port: number }).port;

  const authed = new Set<WebSocket>();
  const pendingApprovals = new Map<string, {
    finish: (v: boolean | "always") => void;
    allowAlways: boolean;
  }>();
  const inFlightRequests = new Set<Promise<void>>();
  const automationRuns = new Map<AbortController, ReturnType<typeof runJobTracked>>();
  // Physical provider/tool work can outlive its logical timeout. Keep a process-level ledger independent
  // of SessionHub membership so detach/delete cannot make an updater believe the old engine is quiescent.
  const activeOperations = new Set<Promise<unknown>>();
  let taskEventSequence = 0;
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
    session.pendingProviderTurns += 1;
    trackActiveOperation(turn);
    const settled = (): void => {
      session.pendingProviderTurns = Math.max(0, session.pendingProviderTurns - 1);
      // A logical timeout/interrupt may return before a non-cooperative provider physically settles.
      // Retain the per-session lease so a second turn cannot share that provider instance concurrently.
      releaseSessionBusyIfIdle(session);
      if (closing) hub.releaseIdle();
    };
    void turn.then(settled, settled);
  };

  const observeToolRun = (session: ServeSession, toolRun: Promise<unknown>): void => {
    session.pendingToolRuns += 1;
    trackActiveOperation(toolRun);
    const settled = (): void => {
      session.pendingToolRuns = Math.max(0, session.pendingToolRuns - 1);
      // `abort === null` means the logical turn already returned. Keep the session busy/locked until
      // every late side-effect-capable Promise has physically stopped.
      releaseSessionBusyIfIdle(session);
      if (closing) hub.releaseIdle();
    };
    void toolRun.then(settled, settled);
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
  };
  const broadcastTaskState = (session: ServeSession, activity: TaskLifecycleActivity): void => {
    if (!session.task) return;
    publishTaskState(taskLifecycleEvent(
      session.meta.id,
      session.task,
      session.meta.todos ?? [],
      activity,
      nextTaskEventCursor(),
    ));
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
    stopReason?: "deadline";
  }> => {
    const sessionId = s.meta.id;
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
    emitTaskState({ state: "running", phase: "starting" });
    const historyStart = s.history.length;
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
      tool: (name, preview) => {
        // The task/status plane is safe for ambient surfaces such as an always-on-top companion.
        // Command/path previews remain on the explicit event.tool transcript plane only.
        emitTaskState({ state: "running", phase: "tool", detail: name });
        broadcast("event.tool", { sessionId, name, preview });
      },
      diff: (t) => broadcast("event.diff", { sessionId, text: t }),
      notice: (t) => broadcast("event.notice", { sessionId, text: t }),
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
        throw new Error(`provider not authenticated for pinned model '${s.meta.model}' at ${s.meta.cwd}`);
      }
      const turnGuardian = deps.buildGuardian
        ? await deps.buildGuardian(s.meta.cwd, s.meta.profileId)
        : deps.guardian;
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
        const runtime = runtimeInfo(s.meta.cwd, s.meta.model, s.meta.profileId);
        const imageMode = runtime.attachmentCapabilities?.image.mode;
        if (deps.prepareImages) {
          const prepared = await deps.prepareImages(preparedImages, {
            cwd: s.meta.cwd,
            model: s.meta.model,
            profileId: s.meta.profileId,
            signal: turnAbort.signal,
          });
          preparedImages = prepared.images ?? [];
          imageDescription = prepared.description?.trim() || undefined;
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
              `\n\n[Attached image description — read by ${viaModel} for ` +
              `${s.meta.model}]\n${imageDescription}`
            );
          }
        } else if (imageMode === "unsupported" || imageMode === "unknown") {
          throw new Error(
            imageMode === "unsupported"
              ? `model '${s.meta.model}' cannot read images and no vision sidecar is configured`
              : `image capability for model '${s.meta.model}' is unknown; configure a vision model or a modelVision override before sending images`,
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
      // image context afterwards so a text-only main model does not lose the sidecar description.
      content += imageContext;
      content += await expandExplicitAttachmentsAsync(
        attachments.contexts,
        s.meta.cwd,
        { signal: turnAbort.signal },
      );
      // @file mentions expand to file contents, same as the CLI (`@src/foo.ts` in the composer works).
      // Pasted images ride along as NeutralMsg.images — a vision-capable model sees them inline.
      s.history.push({
        role: "user",
        content: await expandMentionsAsync(content, s.meta.cwd, { signal: turnAbort.signal }),
        displayContent: displayText,
        ...(preparedImages.length ? { images: preparedImages } : {}),
        ...(attachmentViews.length ? { attachments: attachmentViews } : {}),
        ...(imageDescription ? { imageDescription } : {}),
      });
      let outcome;
      do {
        outcome = await runAgent(s.history, {
        provider: s.provider,
        ctx: {
          cwd: s.meta.cwd,
          sandbox: deps.sandbox,
          profileId: s.meta.profileId,
          todoScope: sessionId,
          sessionId,
          spawn: (t, role, signal) => deps.spawnSubagent(
            s.provider,
            s.meta.cwd,
            s.projectContext,
            s.stats,
            t,
            role,
            signal,
            {
              onProviderTurn: (turn) => observeProviderTurn(s, turn),
              onToolRun: (toolRun) => observeToolRun(s, toolRun),
            },
            s.meta.profileId,
          ),
          ui: sink,
        },
        approval: s.approval,
        confirm,
        autoApprove: s.autoApprove,
        projectApprovals: projectApprovalPolicy(s.meta.cwd),
        projectContext: s.projectContext,
        memory: memoryDigest(s.meta.cwd),
        continuationSession: s.continuationSession,
        executionContext,
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
        },
        pendingInput: async () => {
          materializePendingSteering(s); // helper updates the shared live history after its write-ahead save
          return [];
        },
        stats: s.stats,
        signal: turnAbort.signal,
        onProviderTurn: (turn) => observeProviderTurn(s, turn),
        onToolRun: (toolRun) => observeToolRun(s, toolRun),
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
        if (outcome.status === "halted" && outcome.stopReason === "deadline") {
          // An active-execution deadline is a successful, recoverable checkpoint transition. The typed
          // task event already says `paused`; returning a normal RPC result keeps Desktop and other Serve
          // clients from rendering the same state as `error:` while still exposing the focused /continue
          // guidance to request/response-only clients. Other safety halts remain explicit failures.
          broadcast("event.turn_end", {
            sessionId,
            taskId: s.task!.id,
            turnId: s.task!.turnId,
            reply: "",
            status: "paused",
            stopReason: "deadline",
            usage,
            ctx,
          });
          return {
            reply: failure,
            usage,
            ctx,
            taskId: s.task!.id,
            turnId: s.task!.turnId,
            status: "paused",
            stopReason: "deadline",
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
        );
        if (decision.compact && !turnAbort.signal.aborted) {
          broadcast("event.notice", {
            sessionId,
            text: `✻ Auto-compacting conversation (context ${decision.pct}% full, ~${Math.round((s.stats.lastInput ?? 0) / 1000)}k tok)…`,
          });
          const summary = await compactSession(s, turnAbort);
          broadcast("event.notice", {
            sessionId,
            text: summary
              ? `(auto-compacted — context replaced with a summary; ${s.meta.workingSet?.length ?? 0} notes kept)`
              : "(auto-compact failed — conversation was kept; use Compact or start a new conversation)",
          });
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
      throw error;
    } finally {
      stopTodoEvents();
      s.abort = null;
      s.busy = s.pendingProviderTurns > 0 || s.pendingToolRuns > 0;
    }
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
          if (typeof p.token !== "string" || !sameToken(p.token, token)) return reply(rpcError(id, ERR.UNAUTHORIZED, "bad token"));
          authed.add(ws);
          // capability negotiation (codex app-server pattern): the server ADVERTISES its method set so
          // clients feature-detect up front instead of probing for -32601 per call. `p.capabilities`
          // (client-declared) is accepted and currently unused — reserved for opt-outs/experimental gating.
          const methods = [
            "server.shutdown",
            "session.list", "session.create", "session.resume", "session.send", "session.steer", "session.interrupt", "session.set-model",
            "session.rename", "session.archive", "session.compact", "session.rewind", "session.context", "session.delete", "session.fork",
            "approval.reply", "plugins.list", "plugins.set", "skills.list", "models.list", "files.search", "project.panels",
            "settings.providers.list", "settings.providers.test", "settings.providers.save",
            "settings.providers.connections.create", "settings.providers.connections.test", "settings.providers.connections.use",
            "settings.providers.connections.remove", "settings.gateways.list",
            "settings.gateways.login.start", "settings.gateways.login.status", "settings.gateways.login.cancel",
            "settings.organizations.list", "settings.organizations.enroll", "settings.organizations.use",
            "settings.organizations.remove", "settings.organizations.check",
            "automation.list", "automation.validate", "automation.add", "automation.update",
            "automation.run", "automation.toggle", "automation.delete", "automation.scheduler.install",
            "artifact.import", "artifact.commit", "artifact.revert", "artifact.validate", "artifact.export",
            "artifact.list", "artifact.get", "artifact.revisions",
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
          const features = ["composer.attachments.v1", "models.capabilities.v1"];
          if (collaborationRemote) features.push("collaboration.remote.v1");
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
              events: ["event.task_state"],
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
                profileId: m.profileId,
                updatedAt: m.updatedAt,
                source: m.source ?? "interactive",
                sourceName: m.sourceName,
                jobId: m.jobId,
                archived: m.archived ?? false,
              })),
              page: {
                hasMore: page.hasMore,
                limit: page.limit,
                ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
              },
            }));
          }
          case "session.create": {
            const cwd = typeof p.cwd === "string" && p.cwd ? p.cwd : opts.cwd;
            const activeRuntime = runtimeInfo(cwd);
            const profileId = activeRuntime.profileId ?? "personal";
            const provider = await deps.buildSessionProvider(cwd, profileId);
            if (closing) return;
            if (!provider) return reply(rpcError(id, ERR.INTERNAL, "provider not authenticated — check the active profile and ~/.hara/config.json"));
            const approval = (["suggest", "auto-edit", "full-auto"] as ApprovalMode[]).includes(p.approval) ? (p.approval as ApprovalMode) : deps.approval;
            const s = hub.create({ cwd, profileId, provider, providerId: provider.id, model: provider.model, approval, projectContext: loadAgentContext(cwd) || undefined });
            return reply(rpcResult(id!, { sessionId: s.meta.id, model: s.meta.model, profileId: s.meta.profileId }));
          }
          case "session.resume": {
            if (typeof p.sessionId !== "string") return reply(rpcError(id, ERR.PARAMS, "sessionId required"));
            const live = hub.get(p.sessionId);
            if (live?.busy || live?.configuring) return reply(rpcError(id, ERR.BUSY, "session is running or changing configuration — retry resume shortly"));
            const priorMeta = hub.peekMeta(p.sessionId);
            const boundProfileId = priorMeta?.profileId ?? runtimeInfo(priorMeta?.cwd).profileId ?? "personal";
            const resumeModel = priorMeta?.model || runtimeInfo(priorMeta?.cwd, undefined, boundProfileId).model;
            const provider = priorMeta && deps.buildProviderFor
              ? await deps.buildProviderFor(resumeModel, undefined, priorMeta.cwd, boundProfileId)
              : await deps.buildSessionProvider(priorMeta?.cwd, boundProfileId);
            if (closing) return;
            if (!provider) return reply(rpcError(id, ERR.INTERNAL, "provider not authenticated — check the active profile and ~/.hara/config.json"));
            const r = hub.resume(p.sessionId, { provider, approval: deps.approval, projectContext: undefined });
            if ("missing" in r) return reply(rpcError(id, ERR.NO_SESSION, `no session ${p.sessionId}`));
            if ("lockedBy" in r) return reply(rpcError(id, ERR.LOCKED, `session held by live pid ${r.lockedBy}`));
            if ("busy" in r) return reply(rpcError(id, ERR.BUSY, "session is running or changing configuration — retry resume shortly"));
            if (r.session.meta.profileId && r.session.meta.profileId !== boundProfileId) {
              hub.detach(r.session.meta.id);
              return reply(rpcError(id, ERR.BUSY, "session identity changed while resume was starting — retry resume"));
            }
            const migratedProfileBinding = !r.session.meta.profileId;
            const migratedRuntimeDefaults = !r.session.meta.model;
            r.session.meta.profileId = boundProfileId;
            if (migratedRuntimeDefaults) {
              r.session.meta.model = provider.model;
              r.session.meta.provider = provider.id;
            }
            r.session.configuring = true;
            let refreshed = false;
            try {
              refreshed = await refreshSessionProvider(r.session);
            } finally {
              r.session.configuring = false;
            }
            if (!refreshed) {
              hub.detach(r.session.meta.id);
              return reply(rpcError(id, ERR.INTERNAL, `provider not authenticated for pinned model '${r.session.meta.model}'`));
            }
            if (migratedProfileBinding || migratedRuntimeDefaults) hub.save(r.session);
            r.session.projectContext = loadAgentContext(r.session.meta.cwd) || undefined;
            broadcastTaskState(r.session, { phase: "restored" });
            return reply(rpcResult(id!, {
              sessionId: r.session.meta.id,
              model: r.session.meta.model,
              profileId: r.session.meta.profileId,
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
          case "session.send": {
            if (typeof p.sessionId !== "string" || typeof p.text !== "string") {
              return reply(rpcError(id, ERR.PARAMS, "sessionId + text required"));
            }
            const s = hub.get(p.sessionId);
            if (!s) return reply(rpcError(id, ERR.NO_SESSION, `no live session ${p.sessionId} — session.create/resume first`));
            if (s.busy || s.configuring) return reply(rpcError(id, ERR.BUSY, "this session is busy or changing configuration"));
            if (p.images !== undefined && !Array.isArray(p.images)) {
              return reply(rpcError(id, ERR.PARAMS, "images must be an array"));
            }
            if (p.attachments !== undefined && !Array.isArray(p.attachments)) {
              return reply(rpcError(id, ERR.PARAMS, "attachments must be an array"));
            }
            const intents: SessionAttachmentIntent[] = [
              ...((p.attachments ?? []) as SessionAttachmentIntent[]),
              ...((p.images ?? []).map((image: any) => ({
                kind: "image" as const,
                path: image?.path,
                ...(typeof image?.mediaType === "string" ? { mediaType: image.mediaType } : {}),
              }))),
            ];
            if (!p.text.trim() && intents.length === 0) {
              return reply(rpcError(id, ERR.PARAMS, "text or at least one attachment is required"));
            }
            let validated: ValidatedSessionAttachments;
            try {
              validated = validateSessionAttachments(s.meta.cwd, intents);
            } catch (error: any) {
              return reply(rpcError(id, ERR.PARAMS, String(error?.message ?? error)));
            }
            const text = p.text.trim()
              ? p.text
              : "Please inspect the attached context and tell me what you find.";
            const r = await runTurn(s, text, validated, p.newTask === true, p.text);
            return reply(rpcResult(id!, r));
          }
          case "session.steer": {
            if (typeof p.sessionId !== "string" || typeof p.text !== "string" || !p.text || typeof p.expectedTurnId !== "string") {
              return reply(rpcError(id, ERR.PARAMS, "sessionId + text + expectedTurnId required"));
            }
            const s = hub.get(p.sessionId);
            if (!s) return reply(rpcError(id, ERR.NO_SESSION, "no such live session"));
            if (!s.busy || !s.abort || s.configuring) return reply(rpcError(id, ERR.BUSY, "there is no steerable running turn"));
            const expanded = await expandMentionsAsync(p.text, s.meta.cwd, { signal: s.abort.signal });
            const recorded = recordTaskSteering(s.task, p.expectedTurnId, expanded);
            if (!recorded.ok) return reply(rpcError(id, ERR.BUSY, recorded.reason));
            s.task = recorded.task;
            hub.save(s); // executable inbox entry is durable before ACK
            broadcastTaskState(s, { state: "running", phase: "steering", detail: "Steering accepted" });
            return reply(rpcResult(id!, { accepted: true, taskId: s.task.id, turnId: s.task.turnId }));
          }
          case "session.interrupt": {
            const s = typeof p.sessionId === "string" ? hub.get(p.sessionId) : undefined;
            if (!s) return reply(rpcError(id, ERR.NO_SESSION, "no such live session"));
            if (s.abort && s.task?.status === "running") {
              broadcastTaskState(s, { state: "running", phase: "stopping", detail: "Stopping at a safe boundary" });
            }
            s.abort?.abort();
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
            if (!hub.rename(p.sessionId, p.title.slice(0, 120))) return reply(rpcError(id, ERR.NO_SESSION, `no session ${p.sessionId}`));
            return reply(rpcResult(id!, { sessionId: p.sessionId, title: p.title.slice(0, 120) }));
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
            // non-destructive sibling: explore a different direction without losing the original
            if (typeof p.sessionId !== "string") return reply(rpcError(id, ERR.PARAMS, "sessionId required"));
            const sourceMeta = hub.peekMeta(p.sessionId);
            const boundProfileId = sourceMeta?.profileId ?? runtimeInfo(sourceMeta?.cwd).profileId ?? "personal";
            const sourceModel = sourceMeta?.model || runtimeInfo(sourceMeta?.cwd, undefined, boundProfileId).model;
            const provider = sourceMeta && deps.buildProviderFor
              ? await deps.buildProviderFor(sourceModel, undefined, sourceMeta.cwd, boundProfileId)
              : await deps.buildSessionProvider(sourceMeta?.cwd, boundProfileId);
            if (closing) return;
            if (!provider) return reply(rpcError(id, ERR.INTERNAL, "provider not authenticated — check the active profile and ~/.hara/config.json"));
            const r = hub.fork(p.sessionId, { profileId: boundProfileId, provider, providerId: provider.id, approval: deps.approval, projectContext: undefined });
            if ("missing" in r) return reply(rpcError(id, ERR.NO_SESSION, `no session ${p.sessionId}`));
            if ("busy" in r) return reply(rpcError(id, ERR.BUSY, "source session is mid-turn — fork after it completes"));
            if (!r.session.meta.model) {
              r.session.meta.model = provider.model;
              r.session.meta.provider = provider.id;
            }
            r.session.configuring = true;
            let refreshed = false;
            try {
              refreshed = await refreshSessionProvider(r.session);
            } finally {
              r.session.configuring = false;
            }
            if (!refreshed) {
              hub.delete(r.session.meta.id);
              return reply(rpcError(id, ERR.INTERNAL, `provider not authenticated for pinned model '${r.session.meta.model}'`));
            }
            r.session.projectContext = loadAgentContext(r.session.meta.cwd) || undefined;
            return reply(rpcResult(id!, { sessionId: r.session.meta.id, title: r.session.meta.title, model: r.session.meta.model, history: historyForClient(r.session.history) }));
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
            const discoveredModels = deps.listModels ? await deps.listModels(targetCwd, profileId).catch(() => []) : [];
            const defaultRuntime = runtimeInfo(targetCwd, undefined, profileId);
            const current = savedMeta?.model ?? defaultRuntime.model;
            const currentRuntime = runtimeInfo(targetCwd, current, profileId);
            const models = defaultRuntime.availableModels?.length
              ? [...defaultRuntime.availableModels]
              : discoveredModels;
            const entries = [...new Set([current, ...models])].map((model) => {
              const modelRuntime = runtimeInfo(targetCwd, model, profileId);
              return {
                id: model,
                providerId: modelRuntime.providerId,
                effortLevels: modelRuntime.effortLevels ?? [],
                attachmentCapabilities: modelRuntime.attachmentCapabilities,
              };
            });
            return reply(rpcResult(id!, {
              models,
              entries,
              current,
              profileId: savedMeta?.profileId ?? defaultRuntime.profileId,
              effort: session?.effort ?? savedMeta?.effort ?? null,
              effortLevels: currentRuntime.effortLevels,
              attachmentCapabilities: currentRuntime.attachmentCapabilities,
            }));
          }
          case "settings.providers.list": {
            if (!deps.providerSettings) return reply(rpcError(id, ERR.METHOD, "provider settings not supported by this server"));
            const targetCwd = typeof p.cwd === "string" && p.cwd ? p.cwd : opts.cwd;
            return reply(rpcResult(id!, redactSensitiveValue(deps.providerSettings(targetCwd)).value));
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
              (p.activate !== undefined && typeof p.activate !== "boolean")
            ) {
              return reply(rpcError(id, ERR.PARAMS, "id + label + provider + model required; optional baseURL/apiKey/clearApiKey/activate have invalid types"));
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
              (p.activatePersonal !== undefined && typeof p.activatePersonal !== "boolean")
            ) {
              return reply(rpcError(id, ERR.PARAMS, "provider + model required; optional baseURL/apiKey/clearApiKey/activatePersonal have invalid types"));
            }
            const targetCwd = typeof p.cwd === "string" && p.cwd ? p.cwd : opts.cwd;
            const input: ProviderSettingsInput = {
              provider: p.provider,
              model: p.model,
              ...(p.baseURL !== undefined ? { baseURL: p.baseURL } : {}),
              ...(p.apiKey !== undefined ? { apiKey: p.apiKey } : {}),
              ...(p.clearApiKey !== undefined ? { clearApiKey: p.clearApiKey } : {}),
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
            const model = typeof p.model === "string" && p.model ? p.model : s.meta.model;
            const effort = typeof p.effort === "string" && p.effort ? p.effort : undefined;
            if (!deps.buildProviderFor) return reply(rpcError(id, ERR.METHOD, "model switching not supported by this server"));
            const requestedRuntime = runtimeInfo(s.meta.cwd, model, s.meta.profileId);
            if (requestedRuntime.availableModels?.length && !requestedRuntime.availableModels.includes(model)) {
              return reply(rpcError(id, ERR.PARAMS, `model '${model}' is not authorized for the active organization connection`));
            }
            if (effort && !requestedRuntime.effortLevels.includes(effort)) {
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
              const provider = await deps.buildProviderFor(model, effort, s.meta.cwd, s.meta.profileId);
              if (closing) return;
              if (!provider) return reply(rpcError(id, ERR.INTERNAL, `could not build provider for ${model}`));
              if (provider.model !== model) return reply(rpcError(id, ERR.INTERNAL, `provider did not honor requested model ${model}`));
              s.provider = provider;
              s.meta.provider = provider.id;
              s.meta.model = model;
              s.meta.effort = effort;
              s.effort = effort;
              hub.save(s); // persist the picker immediately, even if no next turn is sent
              return reply(rpcResult(id!, { sessionId: s.meta.id, model, effort: effort ?? null }));
            } finally {
              s.configuring = false;
            }
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
            const automated = automatedPage.sessions.map((m) => ({
              id: m.id,
              title: m.title,
              cwd: m.cwd,
              source: m.source,
              sourceName: m.sourceName,
              jobId: m.jobId,
              updatedAt: m.updatedAt,
            }));
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
          return reply(rpcError(id, ERR.INTERNAL, redactSensitiveText(String(e?.message ?? e)).text));
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
      const ownedAutomationRuns = [...automationRuns.entries()];
      for (const [controller] of ownedAutomationRuns) {
        controller.abort(new Error("Hara Serve is shutting down"));
      }
      for (const session of hub.active()) session.abort?.abort();
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
