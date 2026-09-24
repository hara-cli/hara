import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  constants as fsConstants,
  existsSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { BUNDLED_JEV_WECHAT_FILES, BUNDLED_JEV_WECHAT_REVISION } from "./embedded/jev-wechat.js";
import {
  bindPrivateHaraStateFile,
  readPrivateStateFileSnapshotSync,
  writePrivateStateFileSync,
} from "./security/private-state.js";

export type WeChatGroupPermission = "granted" | "required" | "unknown";
export type WeChatGroupHelperState =
  | "unsupported"
  | "not-configured"
  | "runtime-missing"
  | "ready"
  | "error";
export type WeChatGroupMode = "assist" | "managed";
export type WeChatGroupManagedTrigger = "mention" | "all";
export type WeChatGroupManagedEvent = "armed" | "ignored" | "processing" | "sent" | "paused";

export interface WeChatGroupSceneSettings {
  version: 4;
  agentRef: string;
  trigger: "manual";
  mode: WeChatGroupMode;
  managedTrigger: WeChatGroupManagedTrigger;
  /** Group-visible name after @. Empty keeps the selected Agent/Hara aliases. */
  managedMentionName: string;
}

export interface WeChatGroupSceneStatus {
  supported: boolean;
  helper: WeChatGroupHelperState;
  helperLabel?: string;
  configured: boolean;
  active: boolean;
  agentRef?: string;
  trigger: "manual";
  mode: WeChatGroupMode;
  managedTrigger: WeChatGroupManagedTrigger;
  managedMentionName: string;
  managedArmed: boolean;
  managedPausedReason?: string;
  lastManagedAt?: number;
  lastManagedEvent?: WeChatGroupManagedEvent;
  lastManagedEventAt?: number;
  lastManagedDetail?: string;
  screenCapture: WeChatGroupPermission;
  accessibility: WeChatGroupPermission;
  wechat: "running" | "not-running" | "unknown";
  conversation?: string;
  detail?: string;
}

export interface WeChatGroupObservedMessage {
  side: "them" | "me" | "unknown";
  text: string;
  sender?: string;
  confidence: number;
}

export interface WeChatGroupPreview {
  scanId: string;
  conversation: string;
  messages: WeChatGroupObservedMessage[];
  latestIncoming?: WeChatGroupObservedMessage;
  observedAt: number;
  changed: boolean;
}

export interface WeChatGroupManagedClaim {
  action: "reply" | "ignore" | "idle" | "paused";
  reason: string;
}

export interface WeChatGroupReplyContext {
  scanId: string;
  agentRef: string;
  cwd: string;
  conversation: string;
  messages: WeChatGroupObservedMessage[];
  latestIncoming: WeChatGroupObservedMessage;
  managed: boolean;
}

export interface WeChatGroupDraft {
  draftId: string;
  scanId: string;
  conversation: string;
  text: string;
  generatedAt: number;
}

export interface WeChatGroupFillResult {
  filled: boolean;
  reviewRequired: boolean;
  reason: string;
}

export interface WeChatGroupSendResult {
  sent: true;
  reason: string;
}

interface BridgeStatus {
  ok: boolean;
  screenCapture?: WeChatGroupPermission;
  accessibility?: WeChatGroupPermission;
  wechat?: "running" | "not-running";
  error?: string;
}

interface BridgeScan extends BridgeStatus {
  title?: string;
  digest?: string;
  messages?: WeChatGroupObservedMessage[];
}

interface StoredScan extends Omit<WeChatGroupReplyContext, "managed"> {
  digest: string;
  createdAt: number;
}

interface StoredDraft extends WeChatGroupDraft {
  digest: string;
  createdAt: number;
}

interface SceneControllerOptions {
  home?: string;
  platform?: NodeJS.Platform;
  now?: () => number;
  bridge?: (request: Record<string, unknown>) => Promise<Record<string, unknown>>;
  prepareRuntime?: () => Promise<void>;
}

const SETTINGS_VERSION = 4 as const;
const SCAN_TTL_MS = 5 * 60_000;
const MAX_EPHEMERAL_RECORDS = 24;
const MAX_BRIDGE_OUTPUT = 1024 * 1024;
const HELPER_TIMEOUT_MS = 15_000;
const HELPER_SCAN_TIMEOUT_MS = 35_000;
const HELPER_FILL_TIMEOUT_MS = 45_000;
const INITIAL_READ_ATTEMPTS = 2;
const INITIAL_READ_RETRY_MS = 300;
const MANAGED_RATE_WINDOW_MS = 10 * 60_000;
const MANAGED_MIN_SEND_INTERVAL_MS = 10_000;
const MANAGED_MAX_SENDS_PER_WINDOW = 6;
const MAX_MANAGED_DIGESTS = 128;
const MAX_MANAGED_AUDIT_EVENTS = 200;
const MAX_MANAGED_MENTION_NAME = 32;
const AGENT_REF_RE = /^(?:main|[A-Za-z0-9][A-Za-z0-9._-]{0,79}:[A-Za-z0-9][A-Za-z0-9._-]{0,79})$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const WECHAT_RUNTIME_PACKAGES = [
  "pyobjc-framework-applicationservices>=12.2.2",
  "pyobjc-framework-cocoa>=12.2.2",
  "pyobjc-framework-quartz>=12.2.2",
  "pyobjc-framework-vision>=12.2.2",
  "numpy>=2,<3",
  "rapidocr-onnxruntime>=1.4,<2",
];

function safeDetail(value: unknown): string {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function managedCategory(value: unknown): string {
  const category = String(value ?? "").trim().toLocaleLowerCase();
  return /^[a-z][a-z0-9_]{0,63}$/.test(category) ? category : "";
}

function normalizedMentionName(value: unknown): string | undefined {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") return undefined;
  const normalized = value
    .normalize("NFKC")
    .trim()
    .replace(/^@\s*/u, "")
    .replace(/\s+/gu, " ");
  if (!normalized) return "";
  if (
    [...normalized].length > MAX_MANAGED_MENTION_NAME
    || /[\u0000-\u001f\u007f@]/u.test(normalized)
    || !/[\p{L}\p{N}]/u.test(normalized)
  ) return undefined;
  return normalized;
}

function escapedRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasExplicitMention(text: string, names: string[]): boolean {
  const normalizedText = text.normalize("NFKC").toLocaleLowerCase();
  return names.some((rawName) => {
    const name = normalizedMentionName(rawName)?.toLocaleLowerCase();
    if (!name) return false;
    // A wake name is a real @ mention, not a loose substring. The trailing boundary prevents
    // @Hara from claiming @Harald, while punctuation/emoji after a Chinese name remains valid.
    return new RegExp(`@\\s*${escapedRegExp(name)}(?=$|[\\s\\p{P}\\p{S}])`, "u").test(normalizedText);
  });
}

function normalizedSettings(value: unknown): WeChatGroupSceneSettings | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const rawAgentRef = typeof candidate.agentRef === "string" ? candidate.agentRef : undefined;
  // Early local builds exposed the synthetic main Agent as global:hara. The public Serve catalog has
  // always used `main`; migrate that stale local-only reference before validating or executing it.
  const agentRef = rawAgentRef === "global:hara" ? "main" : rawAgentRef;
  if (
    (candidate.version !== 1 && candidate.version !== 2 && candidate.version !== 3 && candidate.version !== SETTINGS_VERSION)
    || agentRef === undefined
    || (agentRef && !AGENT_REF_RE.test(agentRef))
    || candidate.trigger !== "manual"
  ) return undefined;
  const mode = candidate.mode === "managed" ? "managed" : "assist";
  const managedTrigger = candidate.managedTrigger === "all" ? "all" : "mention";
  const managedMentionName = normalizedMentionName(candidate.managedMentionName);
  if (managedMentionName === undefined) return undefined;
  return {
    version: SETTINGS_VERSION,
    agentRef,
    trigger: "manual",
    mode,
    managedTrigger,
    managedMentionName,
  };
}

function commandEnvironment(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: process.env.LANG ?? "en_US.UTF-8",
    LC_ALL: process.env.LC_ALL,
    TMPDIR: process.env.TMPDIR,
    PYTHONUNBUFFERED: "1",
  };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  return env;
}

function runProcess(
  executable: string,
  args: string[],
  options: { home: string; input?: string; timeoutMs?: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      env: commandEnvironment(options.home),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: NodeJS.Timeout;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ stdout, stderr });
    };
    const append = (current: string, chunk: Buffer): string => {
      if (Buffer.byteLength(current, "utf8") + chunk.length > MAX_BRIDGE_OUTPUT) {
        child.kill("SIGKILL");
        finish(new Error("local WeChat helper returned too much data"));
        return current;
      }
      return current + chunk.toString("utf8");
    };
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (settled) return;
      if (code === 0) finish();
      else finish(new Error(safeDetail(stderr) || `local WeChat helper exited with ${code ?? "unknown status"}`));
    });
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("local WeChat helper timed out"));
    }, options.timeoutMs ?? HELPER_TIMEOUT_MS);
    child.stdin.end(options.input ?? "");
  });
}

function executableFromPath(name: string, home: string): string | undefined {
  const candidates = [
    join(home, ".local", "bin", name),
    join("/opt/homebrew/bin", name),
    join("/usr/local/bin", name),
    ...(process.env.PATH ?? "").split(delimiter).filter(Boolean).map((part) => join(part, name)),
  ];
  return candidates.find((candidate) => {
    try {
      accessSync(candidate, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function parseBridgeResult(stdout: string): Record<string, unknown> {
  const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!line) throw new Error("local WeChat helper returned no result");
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("local WeChat helper returned an invalid result");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("local WeChat helper returned an invalid result");
  }
  return value as Record<string, unknown>;
}

function bridgeStatus(value: Record<string, unknown>): BridgeStatus {
  const permission = (candidate: unknown): WeChatGroupPermission => (
    candidate === "granted" || candidate === "required" ? candidate : "unknown"
  );
  return {
    ok: value.ok === true,
    screenCapture: permission(value.screenCapture),
    accessibility: permission(value.accessibility),
    wechat: value.wechat === "running" || value.wechat === "not-running"
      ? value.wechat
      : undefined,
    ...(typeof value.error === "string" ? { error: safeDetail(value.error) } : {}),
  };
}

function bridgeScan(value: Record<string, unknown>): BridgeScan {
  return {
    ...bridgeStatus(value),
    ...(typeof value.title === "string" ? { title: value.title } : {}),
    ...(typeof value.digest === "string" ? { digest: value.digest } : {}),
    ...(Array.isArray(value.messages) ? { messages: value.messages as WeChatGroupObservedMessage[] } : {}),
  };
}

export class WeChatGroupSceneController {
  private readonly home: string;
  private readonly runtimePlatform: NodeJS.Platform;
  private readonly now: () => number;
  private readonly customBridge?: SceneControllerOptions["bridge"];
  private readonly customPrepare?: SceneControllerOptions["prepareRuntime"];
  private active = false;
  private boundConversation?: string;
  private boundCwd?: string;
  private lastDigest?: string;
  private managedArmed = false;
  private managedBaselineDigest?: string;
  private managedPendingDigest?: string;
  private managedPausedReason?: string;
  private managedSentAt: number[] = [];
  private managedDigests = new Set<string>();
  private lastManagedEvent?: WeChatGroupManagedEvent;
  private lastManagedEventAt?: number;
  private lastManagedDetail?: string;
  private scans = new Map<string, StoredScan>();
  private drafts = new Map<string, StoredDraft>();

  constructor(options: SceneControllerOptions = {}) {
    this.home = options.home ?? homedir();
    this.runtimePlatform = options.platform ?? platform();
    this.now = options.now ?? Date.now;
    this.customBridge = options.bridge;
    this.customPrepare = options.prepareRuntime;
  }

  private settingsBinding() {
    return bindPrivateHaraStateFile(this.home, ["wechat-group"], "settings.json");
  }

  private managedAuditBinding() {
    return bindPrivateHaraStateFile(this.home, ["wechat-group"], "managed-audit.json");
  }

  private managedAudit(
    event: "armed" | "ignored" | "sent" | "paused" | "detached",
    input: { conversation?: string; digest?: string; detail?: string } = {},
  ): void {
    const binding = this.managedAuditBinding();
    let entries: Array<Record<string, unknown>> = [];
    try {
      const snapshot = readPrivateStateFileSnapshotSync(binding.path, 256 * 1024);
      const parsed: unknown = snapshot ? JSON.parse(snapshot.text) : [];
      if (Array.isArray(parsed)) entries = parsed.filter((entry) => entry && typeof entry === "object").slice(-MAX_MANAGED_AUDIT_EVENTS + 1);
    } catch {
      entries = [];
    }
    const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
    entries.push({
      at: this.now(),
      event,
      ...(input.conversation ? { conversationHash: hash(input.conversation) } : {}),
      ...(input.digest ? { observationDigest: input.digest } : {}),
      ...(input.detail ? { detail: safeDetail(input.detail) } : {}),
    });
    writePrivateStateFileSync(binding, JSON.stringify(entries, null, 2) + "\n");
  }

  private managedOutcome(event: WeChatGroupManagedEvent, detail?: string): void {
    this.lastManagedEvent = event;
    this.lastManagedEventAt = this.now();
    this.lastManagedDetail = managedCategory(detail);
  }

  private managedObservationKey(scan: StoredScan): string {
    const incoming = scan.messages
      .filter((message) => message.side === "them")
      .map((message) => [message.sender ?? "", message.text]);
    return createHash("sha256").update(JSON.stringify(incoming)).digest("hex");
  }

  private runtimeDirectory(): string {
    return dirname(bindPrivateHaraStateFile(this.home, ["wechat-group", "runtime"], "state").path);
  }

  private runtimePython(): string {
    return join(this.runtimeDirectory(), "bin", "python");
  }

  private helperDirectory(): string {
    return join(this.runtimeDirectory(), "jev");
  }

  private helperBinding(name: string) {
    const parts = name.split("/");
    const fileName = parts.pop();
    if (!fileName || parts.some((part) => !part || part === "." || part === "..")) {
      throw new Error("invalid embedded Jev file name");
    }
    return bindPrivateHaraStateFile(
      this.home,
      ["wechat-group", "runtime", "jev", ...parts],
      fileName,
    );
  }

  private helperReady(): boolean {
    for (const [name, expected] of Object.entries(BUNDLED_JEV_WECHAT_FILES)) {
      try {
        const snapshot = readPrivateStateFileSnapshotSync(this.helperBinding(name).path, 1024 * 1024);
        if (!snapshot || snapshot.text !== expected) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  private materializeHelper(): void {
    for (const [name, contents] of Object.entries(BUNDLED_JEV_WECHAT_FILES)) {
      const binding = this.helperBinding(name);
      const current = readPrivateStateFileSnapshotSync(binding.path, 1024 * 1024);
      if (current?.text !== contents) writePrivateStateFileSync(binding, contents);
    }
  }

  settings(): WeChatGroupSceneSettings {
    try {
      const snapshot = readPrivateStateFileSnapshotSync(this.settingsBinding().path, 64 * 1024);
      const value: unknown = snapshot ? JSON.parse(snapshot.text) : undefined;
      const normalized = normalizedSettings(value);
      if (normalized) return normalized;
    } catch {
      // Invalid private state is treated as unconfigured. Saving replaces it atomically.
    }
    return {
      version: SETTINGS_VERSION,
      agentRef: "",
      trigger: "manual",
      mode: "assist",
      managedTrigger: "mention",
      managedMentionName: "",
    };
  }

  save(input: {
    agentRef: string;
    mode?: WeChatGroupMode;
    managedTrigger?: WeChatGroupManagedTrigger;
    managedMentionName?: string;
  }): WeChatGroupSceneSettings {
    if (this.runtimePlatform !== "darwin") throw new Error("the local WeChat scene currently requires macOS");
    const requestedAgentRef = input.agentRef.trim();
    const agentRef = requestedAgentRef === "global:hara" ? "main" : requestedAgentRef;
    if (!AGENT_REF_RE.test(agentRef)) throw new Error("select one available Hara Agent");
    const previous = this.settings();
    const managedMentionName = normalizedMentionName(
      input.managedMentionName === undefined ? previous.managedMentionName : input.managedMentionName,
    );
    if (managedMentionName === undefined) {
      throw new Error(`enter a valid group wake name of at most ${MAX_MANAGED_MENTION_NAME} characters`);
    }
    const next: WeChatGroupSceneSettings = {
      version: SETTINGS_VERSION,
      agentRef,
      trigger: "manual",
      mode: input.mode === "managed" ? "managed" : "assist",
      managedTrigger: input.managedTrigger === "all" ? "all" : "mention",
      managedMentionName,
    };
    writePrivateStateFileSync(this.settingsBinding(), JSON.stringify(next, null, 2) + "\n");
    this.stop();
    return next;
  }

  private sourceState(): WeChatGroupHelperState {
    if (this.runtimePlatform !== "darwin") return "unsupported";
    if (this.customBridge) return "ready";
    return existsSync(this.runtimePython()) && this.helperReady() ? "ready" : "runtime-missing";
  }

  private async invokeBridge(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.customBridge) return this.customBridge(request);
    const python = this.runtimePython();
    if (!existsSync(python)) throw new Error("prepare the local WeChat recognition runtime first");
    const result = await runProcess(python, [join(this.helperDirectory(), "bridge.py")], {
      home: this.home,
      input: JSON.stringify(request),
      timeoutMs: request.action === "fill" || request.action === "send"
        ? HELPER_FILL_TIMEOUT_MS
        : request.action === "scan"
          ? HELPER_SCAN_TIMEOUT_MS
          : HELPER_TIMEOUT_MS,
    });
    return parseBridgeResult(result.stdout);
  }

  async prepare(): Promise<WeChatGroupSceneStatus> {
    if (this.customPrepare) {
      await this.customPrepare();
      return this.status();
    }
    if (this.runtimePlatform !== "darwin") throw new Error("the local WeChat scene currently requires macOS");
    const uv = executableFromPath("uv", this.home);
    if (!uv) throw new Error("uv is required to prepare the local WeChat recognition runtime");
    const runtime = this.runtimeDirectory();
    this.materializeHelper();
    await runProcess(uv, ["venv", "--allow-existing", "--python", "3.12", runtime], {
      home: this.home,
      timeoutMs: 5 * 60_000,
    });
    await runProcess(uv, ["pip", "install", "--python", this.runtimePython(), ...WECHAT_RUNTIME_PACKAGES], {
      home: this.home,
      timeoutMs: 10 * 60_000,
    });
    return this.status();
  }

  async status(): Promise<WeChatGroupSceneStatus> {
    const settings = this.settings();
    const helper = this.sourceState();
    const base: WeChatGroupSceneStatus = {
      supported: this.runtimePlatform === "darwin",
      helper,
      helperLabel: `Jev · Hara built-in · ${BUNDLED_JEV_WECHAT_REVISION.slice(0, 7)}`,
      configured: Boolean(settings.agentRef),
      active: this.active,
      ...(settings.agentRef ? { agentRef: settings.agentRef } : {}),
      trigger: "manual",
      mode: settings.mode,
      managedTrigger: settings.managedTrigger,
      managedMentionName: settings.managedMentionName,
      managedArmed: this.managedArmed,
      ...(this.managedPausedReason ? { managedPausedReason: this.managedPausedReason } : {}),
      ...(this.managedSentAt.length ? { lastManagedAt: this.managedSentAt.at(-1) } : {}),
      ...(this.lastManagedEvent ? { lastManagedEvent: this.lastManagedEvent } : {}),
      ...(this.lastManagedEventAt !== undefined ? { lastManagedEventAt: this.lastManagedEventAt } : {}),
      ...(this.lastManagedDetail ? { lastManagedDetail: this.lastManagedDetail } : {}),
      screenCapture: "unknown",
      accessibility: "unknown",
      wechat: "unknown",
      ...(this.boundConversation ? { conversation: this.boundConversation } : {}),
    };
    if (helper !== "ready") return base;
    try {
      const result = bridgeStatus(await this.invokeBridge({ action: "status", jevRoot: this.helperDirectory() }));
      if (!result.ok) return { ...base, helper: "error", detail: safeDetail(result.error) };
      return {
        ...base,
        screenCapture: result.screenCapture ?? "unknown",
        accessibility: result.accessibility ?? "unknown",
        wechat: result.wechat ?? "unknown",
      };
    } catch (error) {
      return { ...base, helper: "error", detail: safeDetail(error instanceof Error ? error.message : error) };
    }
  }

  async requestPermissions(): Promise<WeChatGroupSceneStatus> {
    if (this.sourceState() !== "ready") {
      throw new Error("prepare the local WeChat recognition runtime first");
    }
    const result = bridgeStatus(await this.invokeBridge({
      action: "request-permissions",
      jevRoot: this.helperDirectory(),
    }));
    if (!result.ok) throw new Error(safeDetail(result.error) || "macOS permissions could not be requested");
    // TCC prompts settle asynchronously. A fresh status read is authoritative and keeps repeated
    // background polling read-only; only this explicit method is ever allowed to ask macOS.
    return this.status();
  }

  private prune(): void {
    const cutoff = this.now() - SCAN_TTL_MS;
    for (const [id, scan] of this.scans) if (scan.createdAt < cutoff) this.scans.delete(id);
    for (const [id, draft] of this.drafts) if (draft.createdAt < cutoff) this.drafts.delete(id);
    while (this.scans.size > MAX_EPHEMERAL_RECORDS) this.scans.delete(this.scans.keys().next().value!);
    while (this.drafts.size > MAX_EPHEMERAL_RECORDS) this.drafts.delete(this.drafts.keys().next().value!);
  }

  private observedMessages(value: unknown): WeChatGroupObservedMessage[] {
    if (!Array.isArray(value)) return [];
    return value.slice(-10).flatMap((entry): WeChatGroupObservedMessage[] => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const item = entry as Record<string, unknown>;
      const side = item.side === "them" || item.side === "me" || item.side === "unknown" ? item.side : "unknown";
      const text = String(item.text ?? "")
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
        .trim()
        .slice(0, 2000);
      if (!text) return [];
      const sender = safeDetail(item.sender).slice(0, 120);
      return [{
        side,
        text,
        ...(sender ? { sender } : {}),
        confidence: Number.isFinite(Number(item.confidence)) ? Number(item.confidence) : 0,
      }];
    });
  }

  private async readCurrent(cwd: string): Promise<WeChatGroupPreview> {
    const settings = this.settings();
    if (this.sourceState() !== "ready") throw new Error("prepare the local WeChat recognition runtime first");
    const raw = bridgeScan(await this.invokeBridge({ action: "scan", jevRoot: this.helperDirectory() }));
    if (!raw.ok) {
      if (raw.error === "screen-recording-required") {
        throw new Error("grant Hara Screen Recording permission, then retry");
      }
      throw new Error(safeDetail(raw.error) || "the visible WeChat conversation could not be read");
    }
    const conversation = safeDetail(raw.title);
    const digest = safeDetail(raw.digest);
    const messages = this.observedMessages(raw.messages);
    const latestIncoming = [...messages].reverse().find((message) => message.side === "them");
    if (!conversation || !DIGEST_RE.test(digest)) throw new Error("the visible WeChat conversation could not be verified");
    if (!latestIncoming) throw new Error("no readable incoming group message is visible yet");
    if (this.boundConversation && this.boundConversation !== conversation) {
      throw new Error(`the visible WeChat conversation changed; reopen '${this.boundConversation}' before continuing`);
    }
    const changed = digest !== this.lastDigest;
    const scanId = randomUUID();
    const observedAt = this.now();
    this.lastDigest = digest;
    const stored: StoredScan = {
      scanId,
      agentRef: settings.agentRef,
      cwd,
      conversation,
      messages,
      latestIncoming,
      digest,
      createdAt: observedAt,
    };
    this.scans.set(scanId, stored);
    this.prune();
    return { scanId, conversation, messages, latestIncoming, observedAt, changed };
  }

  private async readInitialCurrent(cwd: string): Promise<WeChatGroupPreview> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= INITIAL_READ_ATTEMPTS; attempt += 1) {
      try {
        return await this.readCurrent(cwd);
      } catch (error) {
        lastError = error;
        const retryable = error instanceof Error
          && error.message === "no readable incoming group message is visible yet";
        if (!retryable || attempt === INITIAL_READ_ATTEMPTS) throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, INITIAL_READ_RETRY_MS));
      }
    }
    throw lastError;
  }

  async start(
    cwd: string,
    confirmGroup: boolean,
    confirmManaged = false,
  ): Promise<{ status: WeChatGroupSceneStatus; preview: WeChatGroupPreview }> {
    const settings = this.settings();
    if (!settings.agentRef) throw new Error("select and save one Hara Agent first");
    if (!confirmGroup) throw new Error("confirm that the current visible WeChat conversation is a group chat");
    if (settings.mode === "managed" && !confirmManaged) {
      throw new Error("confirmManaged=true is required before Hara may automatically send to this group");
    }
    this.active = true;
    this.boundConversation = undefined;
    this.boundCwd = cwd;
    this.lastDigest = undefined;
    this.managedArmed = false;
    this.managedBaselineDigest = undefined;
    this.managedPendingDigest = undefined;
    this.managedPausedReason = undefined;
    this.managedSentAt = [];
    this.managedDigests.clear();
    this.lastManagedEvent = undefined;
    this.lastManagedEventAt = undefined;
    this.lastManagedDetail = undefined;
    try {
      // WeChat can briefly repaint the conversation when Hara comes forward for confirmation. Give
      // that one initial observation a bounded retry before declaring that no incoming bubble is
      // visible. Later scans remain single-shot so a changed/uncertain bound group fails closed.
      const preview = await this.readInitialCurrent(cwd);
      this.boundConversation = preview.conversation;
      const stored = this.scans.get(preview.scanId);
      if (settings.mode === "managed" && stored) {
        const preflight = await this.invokeBridge({
          action: "send-preflight",
          jevRoot: this.helperDirectory(),
          expectedTitle: stored.conversation,
          expectedDigest: stored.digest,
          managed: true,
        });
        if (preflight.ok !== true || preflight.ready !== true) {
          throw new Error(safeDetail(preflight.reason ?? preflight.error) || "managed send is not available in this WeChat window");
        }
        // The message already visible during attachment is a baseline, never an implicit send request.
        this.managedArmed = true;
        const observationKey = this.managedObservationKey(stored);
        this.managedBaselineDigest = observationKey;
        this.managedDigests.add(observationKey);
        this.managedOutcome("armed", `delivery_${managedCategory(preflight.inputMode) || "ready"}`);
        this.managedAudit("armed", { conversation: preview.conversation, digest: stored.digest });
      }
      return { status: await this.status(), preview };
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  stop(): WeChatGroupSceneStatus {
    if (this.active && this.settings().mode === "managed") {
      this.managedAudit("detached", { conversation: this.boundConversation });
    }
    this.active = false;
    this.boundConversation = undefined;
    this.boundCwd = undefined;
    this.lastDigest = undefined;
    this.managedArmed = false;
    this.managedBaselineDigest = undefined;
    this.managedPendingDigest = undefined;
    this.managedPausedReason = undefined;
    this.managedSentAt = [];
    this.managedDigests.clear();
    this.lastManagedEvent = undefined;
    this.lastManagedEventAt = undefined;
    this.lastManagedDetail = undefined;
    this.scans.clear();
    this.drafts.clear();
    const settings = this.settings();
    return {
      supported: this.runtimePlatform === "darwin",
      helper: this.sourceState(),
      helperLabel: `Jev · Hara built-in · ${BUNDLED_JEV_WECHAT_REVISION.slice(0, 7)}`,
      configured: Boolean(settings.agentRef),
      active: false,
      ...(settings.agentRef ? { agentRef: settings.agentRef } : {}),
      trigger: "manual",
      mode: settings.mode,
      managedTrigger: settings.managedTrigger,
      managedMentionName: settings.managedMentionName,
      managedArmed: false,
      screenCapture: "unknown",
      accessibility: "unknown",
      wechat: "unknown",
    };
  }

  async scan(cwd: string): Promise<WeChatGroupPreview> {
    if (!this.active || !this.boundConversation) throw new Error("start and bind the visible WeChat group first");
    // The Agent/model route is fixed when the group is attached. Desktop navigation cannot silently move
    // later managed turns into another project, profile, or Space.
    return this.readCurrent(this.boundCwd ?? cwd);
  }

  managedActive(): boolean {
    return this.active && this.managedArmed && this.settings().mode === "managed";
  }

  managedClaim(scanId: string, agentAliases: string[]): WeChatGroupManagedClaim {
    this.prune();
    const settings = this.settings();
    if (!this.active || settings.mode !== "managed" || !this.managedArmed) {
      return { action: "idle", reason: this.managedPausedReason || "managed mode is not armed" };
    }
    const scan = this.scans.get(scanId);
    if (!scan || scan.conversation !== this.boundConversation) {
      return { action: "idle", reason: "the observation expired or no longer matches the attached group" };
    }
    const observationKey = this.managedObservationKey(scan);
    if (
      observationKey === this.managedBaselineDigest
      || this.managedDigests.has(observationKey)
      || this.managedPendingDigest === observationKey
    ) {
      return { action: "idle", reason: "this observation was already handled" };
    }
    if (scan.messages.at(-1)?.side !== "them") {
      return { action: "idle", reason: "the newest visible message is not an incoming message" };
    }

    if (settings.managedTrigger === "mention") {
      const aliases = (settings.managedMentionName
        ? [settings.managedMentionName]
        : ["hara", ...agentAliases])
        .map((value) => safeDetail(value))
        .filter((value, index, all) => value && all.indexOf(value) === index);
      const mentioned = hasExplicitMention(scan.latestIncoming.text, aliases);
      if (!mentioned) {
        this.rememberManagedDigest(observationKey);
        this.managedOutcome("ignored", "mention_required");
        this.managedAudit("ignored", {
          conversation: scan.conversation,
          digest: scan.digest,
          detail: "mention_required",
        });
        return { action: "ignore", reason: "the newest message did not mention the attached Agent" };
      }
    }

    const current = this.now();
    this.managedSentAt = this.managedSentAt.filter((timestamp) => current - timestamp < MANAGED_RATE_WINDOW_MS);
    const latest = this.managedSentAt.at(-1);
    if (
      this.managedSentAt.length >= MANAGED_MAX_SENDS_PER_WINDOW
      || (latest !== undefined && current - latest < MANAGED_MIN_SEND_INTERVAL_MS)
    ) {
      this.pauseManaged("Managed mode paused after reaching its local send-rate boundary.", scanId, "rate_limited");
      return { action: "paused", reason: this.managedPausedReason! };
    }
    this.managedPendingDigest = observationKey;
    this.managedOutcome("processing", "trigger_matched");
    return { action: "reply", reason: "a new allowed incoming message is ready" };
  }

  pauseManaged(reason: string, scanId?: string, category = "managed_pipeline_failed"): void {
    if (!this.managedArmed && this.managedPausedReason) return;
    const scan = scanId ? this.scans.get(scanId) : undefined;
    this.managedArmed = false;
    this.managedPendingDigest = undefined;
    this.managedPausedReason = safeDetail(reason) || "Managed mode paused after an unexpected failure.";
    const safeCategory = managedCategory(category) || "managed_pipeline_failed";
    this.managedOutcome("paused", safeCategory);
    this.managedAudit("paused", {
      conversation: scan?.conversation ?? this.boundConversation,
      digest: scan?.digest,
      // Persist only a stable category; the in-memory/UI reason may contain provider diagnostics.
      detail: safeCategory,
    });
  }

  private rememberManagedDigest(digest: string): void {
    this.managedDigests.add(digest);
    while (this.managedDigests.size > MAX_MANAGED_DIGESTS) {
      this.managedDigests.delete(this.managedDigests.values().next().value!);
    }
  }

  replyContext(scanId: string): WeChatGroupReplyContext {
    this.prune();
    if (!this.active) throw new Error("the local WeChat group scene is not running");
    const scan = this.scans.get(scanId);
    if (!scan) throw new Error("this WeChat observation expired; scan the visible group again");
    return {
      scanId: scan.scanId,
      agentRef: scan.agentRef,
      cwd: scan.cwd,
      conversation: scan.conversation,
      messages: scan.messages.map((message) => ({ ...message })),
      latestIncoming: { ...scan.latestIncoming },
      managed: this.settings().mode === "managed" && this.managedArmed,
    };
  }

  rememberDraft(scanId: string, text: string): WeChatGroupDraft {
    const scan = this.scans.get(scanId);
    if (!scan) throw new Error("this WeChat observation expired; scan the visible group again");
    const bounded = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, 4000);
    if (!bounded) throw new Error("the Agent returned an empty reply");
    const draftId = randomUUID();
    const generatedAt = this.now();
    const draft: StoredDraft = {
      draftId,
      scanId,
      conversation: scan.conversation,
      text: bounded,
      generatedAt,
      digest: scan.digest,
      createdAt: generatedAt,
    };
    this.drafts.set(draftId, draft);
    this.prune();
    return { draftId, scanId, conversation: draft.conversation, text: bounded, generatedAt };
  }

  async fill(draftId: string): Promise<WeChatGroupFillResult> {
    this.prune();
    if (!this.active) throw new Error("the local WeChat group scene is not running");
    const draft = this.drafts.get(draftId);
    if (!draft) throw new Error("this reply draft expired; ask the Agent for a fresh reply");
    const result = await this.invokeBridge({
      action: "fill",
      jevRoot: this.helperDirectory(),
      draft: draft.text,
      expectedTitle: draft.conversation,
      expectedDigest: draft.digest,
    });
    const verified = result.ok === true && result.filled === true;
    const reviewRequired = result.ok === true
      && result.filled === false
      && result.attempted === true
      && result.reviewRequired === true;
    if (!verified && !reviewRequired) {
      throw new Error(safeDetail(result.reason ?? result.error) || "the draft was not filled into WeChat");
    }
    // A visual write with uncertain OCR readback must never remain retryable: repeating it can duplicate
    // text that is already present. The UI receives an explicit review state instead of a false error.
    this.drafts.delete(draftId);
    return {
      filled: verified,
      reviewRequired,
      reason: safeDetail(result.reason) || (verified ? "filled without sending" : "input attempted; review WeChat before continuing"),
    };
  }

  async sendManaged(draftId: string): Promise<WeChatGroupSendResult> {
    this.prune();
    const settings = this.settings();
    if (!this.active || settings.mode !== "managed" || !this.managedArmed) {
      throw new Error(this.managedPausedReason || "managed mode is not armed");
    }
    const draft = this.drafts.get(draftId);
    if (!draft) throw new Error("this managed reply draft expired");
    const scan = this.scans.get(draft.scanId);
    if (
      !scan
      || scan.digest !== draft.digest
      || this.managedPendingDigest !== this.managedObservationKey(scan)
    ) {
      this.pauseManaged("Managed mode paused because its observation changed before sending.", draft.scanId, "observation_changed");
      throw new Error(this.managedPausedReason);
    }
    const result = await this.invokeBridge({
      action: "send",
      jevRoot: this.helperDirectory(),
      draft: draft.text,
      expectedTitle: draft.conversation,
      expectedDigest: draft.digest,
      managed: true,
    });
    if (result.ok !== true || result.sent !== true) {
      this.pauseManaged(
        safeDetail(result.reason ?? result.error) || "Managed mode paused because delivery could not be verified.",
        draft.scanId,
        managedCategory(result.category) || "send_failed",
      );
      throw new Error(this.managedPausedReason);
    }
    const sentAt = this.now();
    this.managedSentAt.push(sentAt);
    this.rememberManagedDigest(this.managedObservationKey(scan));
    this.managedPendingDigest = undefined;
    this.drafts.delete(draftId);
    this.managedOutcome("sent", `delivery_${managedCategory(result.sendMode ?? result.inputMode) || "verified"}`);
    this.managedAudit("sent", {
      conversation: draft.conversation,
      digest: draft.digest,
      detail: "verified_send",
    });
    return { sent: true, reason: safeDetail(result.reason) || "managed reply sent and verified" };
  }
}
