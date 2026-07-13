// `hara gateway` — an opt-in long-running daemon that lets you drive your LOCAL hara from a chat app
// (Telegram now; WeChat-iLink / Feishu via the same ChatAdapter next). Each inbound message → a fresh `hara`
// subprocess (the cron pattern) on that chat's session → the reply is sent back. This is hara's first
// persistent process; it is never required by the core CLI.
import { spawn, type ChildProcess } from "node:child_process";
import { telegramAdapter, type ChatAdapter, type InboundMsg } from "./telegram.js";
import { dispatchFlows } from "./flows.js";
import { handleOwnerReply, runNoToolModel } from "./flows-pending.js";
import { chatContext, chatCd, newChatSession, ownsChatSession, resolveOwnedSessionId, setChatSession, setChatAgent, toggleVoice } from "./sessions.js";
import { plainChat } from "../cron/deliver.js";
import { pickPaneForReply, capturePane, injectTmux, outputDelta } from "./tmux-routes.js";
import { synthesize } from "./tts.js";
import { cleanupTransientMedia, pruneStaleMedia } from "./media.js";
import { selfArgv } from "../cron/runner.js";
import { listSessions, loadSession } from "../session/store.js";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chmodSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, rmSync } from "node:fs";
import { redactToolSubprocessOutput, terminateSubprocessTree } from "../security/subprocess-env.js";
import {
  cleanupOutboundSnapshot,
  cleanupOutboundSnapshots,
  consumeOutboundSnapshots,
  queueOutboundSnapshot,
  type OutboundFilePayload,
} from "./outbound-files.js";

/** Parse a leading slash-command from a chat message (pure). null if it isn't one. */
export function parseCommand(text: string): { cmd: string; arg: string } | null {
  const m = /^\/([a-z]+)\b\s*([\s\S]*)$/i.exec(text.trim());
  return m ? { cmd: m[1].toLowerCase(), arg: m[2].trim() } : null;
}

/** Whether a user may drive the gateway. Empty allowlist = nobody (safe default — never wide-open). */
export function isAllowed(userId: number | string, allowlist: Set<string>): boolean {
  return allowlist.size > 0 && allowlist.has(String(userId));
}

/** Media is fetched only for an explicitly classified DM from an allowed identity. Group flows still receive
 * their text/metadata through the normal callback, but never cause the adapter to touch attachment bytes. */
export function shouldDownloadInboundMedia(m: InboundMsg, allowlist: Set<string>): boolean {
  return m.chatType === "p2p" && isAllowed(m.userId, allowlist);
}

/** CLI aliases are accepted only at the startup boundary. Session keys, flow matching, approval targets,
 * and HARA_GATEWAY must use the adapter's canonical platform name so deferred delivery can parse them. */
export function canonicalGatewayPlatform(platform: string): string {
  const value = platform.trim().toLowerCase();
  if (value === "lark") return "feishu";
  if (value === "ding") return "dingtalk";
  if (value === "wework") return "wecom";
  return value;
}

/** Strip hara's CLI chrome from captured `-p` output so a chat reply is just the answer: MCP status lines
 *  (`mcp: …`) and the token-usage footer (`… · ↑N ↓N tok`). Colors are off when piped, so no ANSI to strip. */
export function cleanReply(raw: string): string {
  return redactToolSubprocessOutput(raw)
    .split("\n")
    .filter((ln) => !/^\s*mcp: /.test(ln) && !/·\s*↑\d+\s*↓\d+\s*tok\s*$/.test(ln))
    .join("\n")
    .trim();
}

let outboxSeq = 0;
export interface HaraRun {
  reply: string;
  /** bounded, verified attachment bytes the agent asked to deliver via send_file */
  files: OutboundFilePayload[];
}

/** Snapshot and materialize a direct gateway file before an adapter sees it. This also covers TTS output, so
 * every outbound attachment crosses the same verified-byte boundary rather than handing adapters a pathname. */
async function deliverVerifiedLocalFile(
  adapter: ChatAdapter,
  chatId: number | string,
  sourcePath: string,
): Promise<void> {
  const sendFile = adapter.sendFile;
  if (!sendFile) throw new Error("this platform can't send files yet");
  const outbox = join(tmpdir(), `hara-direct-send-${process.pid}-${Date.now()}-${outboxSeq++}.txt`);
  let payload: OutboundFilePayload | undefined;
  try {
    await queueOutboundSnapshot(sourcePath, outbox);
    [payload] = await consumeOutboundSnapshots(outbox);
    cleanupOutboundSnapshots(outbox, payload ? [payload.snapshotPath] : []);
    if (!payload) throw new Error("the private file snapshot could not be verified");
    await sendFile(chatId, payload);
  } finally {
    if (payload) cleanupOutboundSnapshot(payload.snapshotPath);
    cleanupOutboundSnapshots(outbox);
  }
}

interface QueueEntry {
  task: () => Promise<unknown> | unknown;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

interface QueueState {
  /** Running + waiting tasks for this key. */
  depth: number;
  running: boolean;
  ready: boolean;
  waiting: QueueEntry[];
}

export class GatewayQueueFullError extends Error {
  constructor(
    public readonly key: string,
    public readonly limit: number,
    public readonly scope: "session" | "queued" | "keys" = "session",
  ) {
    const subject = scope === "session" ? `queue '${key}'` : scope === "keys" ? "session-key set" : "global waiting queue";
    super(`gateway ${subject} is full (${limit})`);
    this.name = "GatewayQueueFullError";
  }
}

export class GatewayQueueClosedError extends Error {
  constructor(message = "gateway is shutting down") {
    super(message);
    this.name = "GatewayQueueClosedError";
  }
}

/** A bounded serial queue per key. Tasks with the same key run in arrival order, while different keys may
 * run concurrently up to `maxActive`. Global key and waiting-task limits prevent rotating chat/session ids
 * from turning the daemon into an unbounded child-process launcher. Settled keys are removed eagerly. */
export class KeyedSerialQueue {
  private readonly states = new Map<string, QueueState>();
  private readonly ready: string[] = [];
  private readonly idleWaiters = new Set<() => void>();
  private active = 0;
  private queued = 0;
  private closedError: GatewayQueueClosedError | undefined;

  constructor(
    public readonly maxDepth = 8,
    public readonly maxActive = 4,
    public readonly maxQueued = 64,
    public readonly maxKeys = 32,
  ) {
    if (!Number.isSafeInteger(maxDepth) || maxDepth < 1) throw new RangeError("maxDepth must be a positive integer");
    if (!Number.isSafeInteger(maxActive) || maxActive < 1) throw new RangeError("maxActive must be a positive integer");
    if (!Number.isSafeInteger(maxQueued) || maxQueued < 1) throw new RangeError("maxQueued must be a positive integer");
    if (!Number.isSafeInteger(maxKeys) || maxKeys < 1) throw new RangeError("maxKeys must be a positive integer");
  }

  get size(): number {
    return this.states.size;
  }

  pending(key: string): number {
    return this.states.get(key)?.depth ?? 0;
  }

  get activeCount(): number {
    return this.active;
  }

  get queuedCount(): number {
    return this.queued;
  }

  run<T>(key: string, task: () => Promise<T> | T): Promise<T> {
    if (this.closedError) return Promise.reject(this.closedError);
    let state = this.states.get(key);
    if (state && state.depth >= this.maxDepth) return Promise.reject(new GatewayQueueFullError(key, this.maxDepth));
    if (!state) {
      if (this.states.size >= this.maxKeys) return Promise.reject(new GatewayQueueFullError(key, this.maxKeys, "keys"));
      state = { depth: 0, running: false, ready: false, waiting: [] };
      this.states.set(key, state);
    }

    if (this.queued >= this.maxQueued) {
      if (state.depth === 0) this.states.delete(key);
      return Promise.reject(new GatewayQueueFullError(key, this.maxQueued, "queued"));
    }

    const result = new Promise<T>((resolve, reject) => {
      state!.waiting.push({
        task,
        resolve: (value) => resolve(value as T),
        reject,
      });
    });
    state.depth++;
    this.queued++;
    this.markReady(key, state);
    this.drain();
    return result;
  }

  /** Reject work that has not started. Running tasks settle normally (their AbortSignal is owned by the
   * caller), allowing daemon shutdown to kill the actual child and then wait for a bounded clean drain. */
  close(error = new GatewayQueueClosedError()): void {
    if (this.closedError) return;
    this.closedError = error;
    this.ready.length = 0;
    for (const [key, state] of this.states) {
      state.ready = false;
      const waiting = state.waiting.splice(0);
      state.depth -= waiting.length;
      this.queued -= waiting.length;
      for (const entry of waiting) entry.reject(error);
      if (!state.running) this.states.delete(key);
    }
    this.notifyIdle();
  }

  waitForIdle(): Promise<void> {
    if (this.active === 0 && this.queued === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  private markReady(key: string, state: QueueState): void {
    if (state.ready || state.running || state.waiting.length === 0) return;
    state.ready = true;
    this.ready.push(key);
  }

  private drain(): void {
    while (!this.closedError && this.active < this.maxActive && this.ready.length > 0) {
      const key = this.ready.shift()!;
      const state = this.states.get(key);
      if (!state || state.running || state.waiting.length === 0) continue;
      state.ready = false;
      state.running = true;
      const entry = state.waiting.shift()!;
      this.queued--;
      this.active++;
      void Promise.resolve()
        .then(entry.task)
        .then(
          (value) => this.finish(key, state, entry, true, value),
          (error: unknown) => this.finish(key, state, entry, false, error),
        );
    }
  }

  private finish(key: string, state: QueueState, entry: QueueEntry, ok: boolean, outcome: unknown): void {
    this.active--;
    state.depth--;
    state.running = false;
    if (state.depth === 0 && this.states.get(key) === state) this.states.delete(key);
    else if (!this.closedError) this.markReady(key, state);
    this.drain();
    this.notifyIdle();
    if (ok) entry.resolve(outcome);
    else entry.reject(outcome);
  }

  private notifyIdle(): void {
    if (this.active !== 0 || this.queued !== 0) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }
}

const DEFAULT_RUN_TIMEOUT_MS = 15 * 60_000;
const MAX_RUN_TIMEOUT_MS = 30 * 60_000;
const MIN_RUN_TIMEOUT_MS = 50;
const DEFAULT_KILL_GRACE_MS = 2_000;
const MAX_KILL_GRACE_MS = 5_000;

function boundedDuration(value: number | string | undefined, fallback: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.max(MIN_RUN_TIMEOUT_MS, Math.min(max, Math.trunc(parsed))) : fallback;
}

/** `HARA_GATEWAY_RUN_TIMEOUT_MS` is operator-tunable but cannot disable or exceed the hard 30-minute cap. */
export function gatewayRunTimeoutMs(value: number | string | undefined = process.env.HARA_GATEWAY_RUN_TIMEOUT_MS): number {
  return boundedDuration(value, DEFAULT_RUN_TIMEOUT_MS, MAX_RUN_TIMEOUT_MS);
}

export interface HaraRunOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  killGraceMs?: number;
}

function runFailure(message: string, output: string): string {
  const detail = cleanReply(output);
  return detail ? `✗ ${message}\n${detail}` : `✗ ${message}`;
}

function durationLabel(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.round(ms / 1_000)}s`;
}

/** Run hara headlessly on a chat's session. Returns its cleaned text reply plus any files the agent queued
 *  via send_file. The gateway env (HARA_GATEWAY + a per-message outbox file) is what makes send_file and the
 *  in-chat system context active in the subprocess; the daemon delivers the queued files after it exits. */
export function runHara(
  text: string,
  sessionId: string,
  cwd: string,
  platform: string,
  images?: string[],
  role?: string,
  options: HaraRunOptions = {},
): Promise<HaraRun> {
  if (options.signal?.aborted) return Promise.resolve({ reply: "✗ hara run cancelled because the gateway is shutting down.", files: [] });
  const outbox = join(tmpdir(), `hara-outbox-${process.pid}-${Date.now()}-${outboxSeq++}.txt`);
  const timeoutMs = gatewayRunTimeoutMs(options.timeoutMs);
  const killGraceMs = boundedDuration(options.killGraceMs, DEFAULT_KILL_GRACE_MS, MAX_KILL_GRACE_MS);
  return new Promise((res) => {
    const self = selfArgv();
    const args = [...self.slice(1), "-p", text, "--approval", "full-auto", "--resume", sessionId];
    if (role) args.push("--role", role); // /agent-pinned persona for this thread (default = main agent)
    let child: ChildProcess;
    try {
      child = spawn(self[0], args, {
        cwd,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          HARA_GATEWAY: platform,
          HARA_GATEWAY_OUTBOX: outbox,
          ...(images?.length ? { HARA_GATEWAY_IMAGES: images.join("\n") } : {}),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res({ reply: `✗ couldn't start hara: ${message}`, files: [] });
      return;
    }
    let out = "";
    let settled = false;
    let exited = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let stopReason: "timeout" | "shutdown" | undefined;
    let drainTimer: NodeJS.Timeout | undefined;
    let forceIssued = false;
    let cancelTermination: ((cancelForce?: boolean) => void) | undefined;
    const cap = (d: Buffer): void => {
      if (settled || stopReason) return;
      out = (out + d.toString().slice(-12_000)).slice(-12_000);
    };
    child.stdout?.on("data", cap);
    child.stderr?.on("data", cap);
    // The promise/timers govern lifecycle. Neither the child handle nor inherited pipe writers may keep a
    // shutting-down gateway alive indefinitely.
    child.unref();
    (child.stdout as (NodeJS.ReadableStream & { unref?: () => void }) | null)?.unref?.();
    (child.stderr as (NodeJS.ReadableStream & { unref?: () => void }) | null)?.unref?.();

    const readOutbox = async (): Promise<OutboundFilePayload[]> => {
      const files = await consumeOutboundSnapshots(outbox);
      // Remove abandoned partials and invalid queue entries, but retain accepted snapshots until the adapter
      // has finished uploading them in the parent gateway process.
      cleanupOutboundSnapshots(outbox, files.map((file) => file.snapshotPath));
      return files;
    };

    const finish = (reply: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (drainTimer) clearTimeout(drainTimer);
      // The helper deliberately keeps its force timer alive by default. When a direct child closes after
      // TERM, that timer must still SIGKILL the owned group before this stopped run can be considered gone.
      cancelTermination?.();
      options.signal?.removeEventListener("abort", abortRun);
      child.stdout?.destroy();
      child.stderr?.destroy();
      void readOutbox().then(
        (files) => res({ reply, files }),
        () => {
          cleanupOutboundSnapshots(outbox);
          res({ reply, files: [] });
        },
      );
    };

    const finishFromExit = (): void => {
      // `exit`/`close` describes only the direct child. During a timeout/shutdown, wait until the forced
      // process-group signal has been issued so a quiet TERM-resistant descendant cannot escape cleanup.
      if (stopReason && !forceIssued) return;
      if (stopReason === "timeout") {
        finish(runFailure(`hara timed out after ${durationLabel(timeoutMs)}; the run was stopped.`, out));
      } else if (stopReason === "shutdown") {
        finish(runFailure("hara run cancelled because the gateway is shutting down.", out));
      } else if (exitSignal) {
        finish(runFailure(`hara was terminated by ${exitSignal}.`, out));
      } else if (exitCode !== 0) {
        finish(runFailure(exitCode === null ? "hara stopped without an exit status." : `hara failed with exit code ${exitCode}.`, out));
      } else {
        const reply = cleanReply(out);
        finish(reply || "✗ hara completed but produced no reply.");
      }
    };

    const terminate = (reason: "timeout" | "shutdown"): void => {
      if (settled || cancelTermination) return;
      stopReason ??= reason;
      cancelTermination = terminateSubprocessTree(child, {
        processGroup: process.platform !== "win32",
        graceMs: killGraceMs,
        fallbackMs: 250,
        onForce: () => {
          forceIssued = true;
          if (exited) finishFromExit();
        },
        // A daemon may escape the group or a runtime may fail to emit exit/close. Destroying our pipe ends in
        // `finish` keeps gateway shutdown and per-run timeout bounded even in that case.
        onFallback: finishFromExit,
      });
    };
    const abortRun = (): void => terminate("shutdown");
    const timeoutTimer = setTimeout(() => terminate("timeout"), timeoutMs);
    if (options.signal) options.signal.addEventListener("abort", abortRun, { once: true });
    // Close the narrow race where the signal aborts after the entry check but before the listener is attached.
    if (options.signal?.aborted) abortRun();

    child.once("error", (error) => {
      if (!stopReason) return finish(runFailure(`couldn't start hara: ${error.message}`, out));
      exited = true;
      if (forceIssued) finishFromExit();
    });
    child.once("exit", (code, signal) => {
      exited = true;
      exitCode = code;
      exitSignal = signal;
      // Usually `close` follows after the final pipe data. A grandchild can retain stdout/stderr forever, so
      // cap that drain window and then destroy the pipes ourselves.
      if (stopReason) finishFromExit();
      else drainTimer = setTimeout(finishFromExit, 100);
    });
    child.once("close", (code, signal) => {
      exited = true;
      exitCode = code;
      exitSignal = signal;
      finishFromExit();
    });
  });
}

/** Run a one-off FLOW text task directly against the provider with `tools: []`. The old subprocess path
 * launched the full coding agent with `--approval full-auto`, allowing a prompt-injected group message to
 * reach bash/edit/MCP tools. `cwd` is intentionally ignored: isolated flow judgments cannot read a project. */
function runFlowAgent(prompt: string, _cwd: string, schema?: object, signal?: AbortSignal): Promise<string> {
  return runNoToolModel(prompt, { schema, timeoutMs: 60_000, signal });
}

/** Re-exported so `hara gateway --platform weixin --login` can run the QR flow. */
export { weixinLogin } from "./weixin.js";

async function buildAdapter(platform: string): Promise<{ adapter: ChatAdapter; ownerId?: string } | null> {
  if (platform === "weixin") {
    const { loadWeixinCreds, weixinAdapter } = await import("./weixin.js");
    const creds = loadWeixinCreds();
    if (!creds) {
      console.error("hara gateway: no WeChat login found. Run `hara gateway --platform weixin --login` first.");
      return null;
    }
    // The iLink user_id is whoever scanned the QR — the bot owner. Auto-allow them so there's no wxid dance.
    return { adapter: weixinAdapter(creds), ownerId: creds.user_id || undefined };
  }
  if (platform === "discord") {
    const token = process.env.HARA_DISCORD_TOKEN;
    if (!token) {
      console.error("hara gateway: set HARA_DISCORD_TOKEN (Discord bot token) and HARA_GATEWAY_ALLOWED=<your discord user id>. Enable the Message Content Intent on the bot.");
      return null;
    }
    const { discordAdapter } = await import("./discord.js");
    return { adapter: discordAdapter(token) };
  }
  if (platform === "feishu" || platform === "lark") {
    const appId = process.env.HARA_FEISHU_APP_ID;
    const appSecret = process.env.HARA_FEISHU_APP_SECRET;
    if (!appId || !appSecret) {
      console.error("hara gateway: set HARA_FEISHU_APP_ID + HARA_FEISHU_APP_SECRET (Feishu app console) and HARA_GATEWAY_ALLOWED=<your open_id>. (HARA_FEISHU_DOMAIN=lark for larksuite.com.)");
      return null;
    }
    const { feishuAdapter } = await import("./feishu.js");
    return { adapter: feishuAdapter(appId, appSecret) };
  }
  if (platform === "slack") {
    const appToken = process.env.HARA_SLACK_APP_TOKEN;
    const botToken = process.env.HARA_SLACK_BOT_TOKEN;
    if (!appToken || !botToken) {
      console.error("hara gateway: set HARA_SLACK_APP_TOKEN (xapp-, Socket Mode app-level token w/ connections:write) + HARA_SLACK_BOT_TOKEN (xoxb-, bot token w/ chat:write,files:write,files:read,*:history) and HARA_GATEWAY_ALLOWED=<your slack user id>.");
      return null;
    }
    const { slackAdapter } = await import("./slack.js");
    return { adapter: slackAdapter(appToken, botToken) };
  }
  if (platform === "mattermost") {
    const url = process.env.HARA_MATTERMOST_URL;
    const token = process.env.HARA_MATTERMOST_TOKEN;
    if (!url || !token) {
      console.error("hara gateway: set HARA_MATTERMOST_URL (e.g. https://mm.example.com) + HARA_MATTERMOST_TOKEN (bot or personal-access token) and HARA_GATEWAY_ALLOWED=<your mattermost user id>.");
      return null;
    }
    const { mattermostAdapter } = await import("./mattermost.js");
    return { adapter: mattermostAdapter(url, token) };
  }
  if (platform === "matrix") {
    const homeserver = process.env.HARA_MATRIX_HOMESERVER;
    const token = process.env.HARA_MATRIX_TOKEN;
    const userId = process.env.HARA_MATRIX_USER_ID;
    if (!homeserver || !token || !userId) {
      console.error("hara gateway: set HARA_MATRIX_HOMESERVER (e.g. https://matrix.org), HARA_MATRIX_TOKEN (access token), HARA_MATRIX_USER_ID (@bot:server) and HARA_GATEWAY_ALLOWED=<@you:server>. Unencrypted rooms only (no E2EE in v1).");
      return null;
    }
    const { matrixAdapter } = await import("./matrix.js");
    return { adapter: matrixAdapter(homeserver, token, userId) };
  }
  if (platform === "dingtalk" || platform === "ding") {
    const clientId = process.env.HARA_DINGTALK_CLIENT_ID;
    const clientSecret = process.env.HARA_DINGTALK_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      console.error("hara gateway: set HARA_DINGTALK_CLIENT_ID + HARA_DINGTALK_CLIENT_SECRET (钉钉开放平台 app AppKey/AppSecret, Stream mode enabled on the bot) and HARA_GATEWAY_ALLOWED=<your senderStaffId>.");
      return null;
    }
    const { dingtalkAdapter } = await import("./dingtalk.js");
    return { adapter: dingtalkAdapter(clientId, clientSecret) };
  }
  if (platform === "wecom" || platform === "wework") {
    const botId = process.env.HARA_WECOM_BOT_ID;
    const secret = process.env.HARA_WECOM_SECRET;
    if (!botId || !secret) {
      console.error("hara gateway: set HARA_WECOM_BOT_ID + HARA_WECOM_SECRET (企业微信 admin console → AI Bot credentials) and HARA_GATEWAY_ALLOWED=<your wecom userid>. (HARA_WECOM_WS_URL overrides the gateway URL.)");
      return null;
    }
    const { wecomAdapter } = await import("./wecom.js");
    return { adapter: wecomAdapter(botId, secret, process.env.HARA_WECOM_WS_URL) };
  }
  if (platform === "signal") {
    const rpcUrl = process.env.HARA_SIGNAL_RPC_URL;
    const number = process.env.HARA_SIGNAL_NUMBER;
    if (!rpcUrl || !number) {
      console.error("hara gateway: set HARA_SIGNAL_RPC_URL (e.g. http://localhost:8080) + HARA_SIGNAL_NUMBER (the bot's registered phone, E.164) and HARA_GATEWAY_ALLOWED=<your signal number/uuid>. Requires a local signal-cli daemon: `signal-cli -a <number> daemon --http localhost:8080`.");
      return null;
    }
    const { signalAdapter } = await import("./signal.js");
    return { adapter: signalAdapter(rpcUrl, number) };
  }
  const token = process.env.HARA_TELEGRAM_TOKEN;
  if (!token) {
    console.error("hara gateway: set HARA_TELEGRAM_TOKEN (from @BotFather) and HARA_GATEWAY_ALLOWED=<your telegram user id>.");
    return null;
  }
  return { adapter: telegramAdapter(token) };
}

/** Allowlist = the env ids ∪ a platform-confirmed owner (WeChat QR) ∪ an explicitly configured approval
 * owner. Matrix/Signal bot account IDs are deliberately not treated as human owners. */
export function resolveAllowlist(envValue: string | undefined, ownerId?: string, explicitOwner?: string): Set<string> {
  const set = new Set((envValue ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  if (ownerId) set.add(ownerId);
  if (explicitOwner?.trim()) set.add(explicitOwner.trim());
  return set;
}

/** Choose exactly one identity allowed to approve consequential flow actions. A configured owner wins,
 * then a platform-confirmed owner; otherwise a one-person allowlist is unambiguous. Multiple allowlisted
 * operators must set HARA_GATEWAY_OWNER — we never let whichever DM replies first become "owner". */
export function resolveApprovalOwner(explicitOwner: string | undefined, detectedOwner: string | undefined, allowlist: Set<string>): string | undefined {
  const candidate = explicitOwner?.trim() || detectedOwner?.trim();
  if (candidate) return allowlist.has(candidate) ? candidate : undefined;
  if (allowlist.size === 1) return allowlist.values().next().value as string | undefined;
  return undefined;
}

/** Approval replies must be private as well as identity-matched. Adapters that explicitly classify the chat
 * are authoritative; older adapters may use the conservative DM invariant chatId===userId. Unknown channel
 * shapes fail closed (the same action remains available in the local desktop approvals inbox). */
export function isPrivateApprovalMessage(m: InboundMsg): boolean {
  if (m.chatType === "p2p") return true;
  if (m.chatType === "group") return false;
  return String(m.chatId) === String(m.userId);
}

/** The gateway's default workspace when no --cwd is given: a dedicated safe home under ~/.hara (like Hermes'
 *  ~/.hermes), NOT the launch dir — so a full-auto chat bot never lands on a real repo by accident. */
export function defaultWorkspace(): string {
  const base = join(homedir(), ".hara");
  const dir = join(base, "workspace");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(base, 0o700);
    chmodSync(dir, 0o700);
  } catch {
    /* best effort on filesystems without POSIX modes */
  }
  const agents = join(dir, "AGENTS.md");
  const LEGACY =
    "# hara chat workspace\n\nDefault working directory for `hara gateway` (Telegram/WeChat). Each message runs here with `--approval full-auto`. A safe scratch — pass `--cwd <dir>` to point the gateway at a real project instead.\n";
  const TEMPLATE =
    "# hara chat workspace\n\n" +
    "Default working directory for `hara gateway`. Each message runs here with `--approval full-auto`. " +
    "A safe scratch — pass `--cwd <dir>` to point the gateway at a real project instead.\n\n" +
    "## How to work here\n\n" +
    "- You are a chat-driven assistant on the user's machine. Deliver files/images with the `send_file` tool.\n" +
    "- To interact with chat/work platforms (Feishu, Slack, WeChat, email, …), use an available skill or their HTTP API — " +
    "check `skill` and the user's configured skills FIRST. Do NOT try to control other desktop apps' windows; " +
    "screen control is disabled in gateway runs.\n" +
    "- You often lack project context here. If a request concerns a specific project, say so and suggest `/cd <project>` " +
    "(or answer from what you can read) rather than guessing.\n";
  if (!existsSync(agents)) writeFileSync(agents, TEMPLATE, { mode: 0o600 });
  else {
    try {
      if (readFileSync(agents, "utf8") === LEGACY) writeFileSync(agents, TEMPLATE); // refresh unmodified old default
      chmodSync(agents, 0o600);
    } catch {
      /* unreadable — leave it alone */
    }
  }
  return dir;
}

export async function runGateway(opts: { cwd?: string; platform?: string }): Promise<void> {
  const requestedPlatform = opts.platform || "telegram";
  const cwd = opts.cwd ?? defaultWorkspace(); // dir-free default: hara's own ~/.hara/workspace, like Hermes' ~/.hermes
  const built = await buildAdapter(requestedPlatform);
  if (!built) process.exit(1);
  const { adapter, ownerId } = built;
  // Adapter names are the source of truth (e.g. requested `lark` builds the `feishu` adapter). Keep the
  // requested spelling only for startup/config hints; all persisted/routable identities are canonical.
  const platform = adapter.name || canonicalGatewayPlatform(requestedPlatform);
  const explicitOwner = process.env.HARA_GATEWAY_OWNER?.trim();
  const allowlist = resolveAllowlist(process.env.HARA_GATEWAY_ALLOWED, ownerId, explicitOwner);
  const approvalUserId = resolveApprovalOwner(explicitOwner, ownerId, allowlist);
  const approvalOwner = approvalUserId ? `${platform}:${approvalUserId}` : undefined;
  if (allowlist.size === 0) {
    const hint = platform === "weixin"
      ? "your WeChat id"
      : platform === "telegram"
        ? "your Telegram user id (DM @userinfobot)"
        : `your ${platform} user id`;
    console.error(`hara gateway: ⚠ HARA_GATEWAY_ALLOWED is empty — nobody is allowed. Set it to ${hint}.`);
  } else if (ownerId) {
    console.error(`hara gateway: bot owner auto-allowed (${ownerId}).`);
  }
  if (!approvalOwner) {
    console.error("hara gateway: flow approvals disabled — set HARA_GATEWAY_OWNER to one allowed sender id (required when multiple users are allowed).");
  } else {
    console.error(`hara gateway: flow approvals restricted to ${approvalOwner}.`);
  }
  const ac = new AbortController();
  const sessionRuns = new KeyedSerialQueue(8, 4, 64, 32);
  const stop = (): void => ac.abort(new GatewayQueueClosedError());
  const closeQueue = (): void => sessionRuns.close(new GatewayQueueClosedError());
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  ac.signal.addEventListener("abort", closeQueue, { once: true });
  console.error(`hara gateway: ${adapter.name} up · cwd=${cwd} · ${allowlist.size} allowed user(s) · Ctrl-C to stop`);

  try {
    await pruneStaleMedia(platform).catch((error) => {
      console.error(`hara gateway: media cleanup failed — ${error instanceof Error ? error.message : String(error)}`);
    });

    await adapter.start(async (m: InboundMsg) => {
    try {
    if (ac.signal.aborted) return;
    // Flows (opt-in, ~/.hara/flows.json): rules that intercept a matching inbound message → agent task + deliver,
    // BEFORE the allowlist/DM-driver logic. A matched flow is authorized by its own presence in the user's config
    // (group senders won't be in the allowlist), so this must run first; the agent run/deliver is fire-and-forget.
    const flowRan = await dispatchFlows(
      m,
      platform,
      (prompt, home, schema, signal) => runFlowAgent(prompt, home ?? cwd, schema, signal), // stateless per trigger; rule cwd = agent's home
      (text) => adapter.send(m.chatId, plainChat(text)), // flow replies are chat bubbles too — flatten markdown
      approvalOwner,
      ac.signal,
    );
    if (flowRan) return;
    // The gateway's default is a DM driver. Unknown channel shapes fail closed too: older/third-party adapters
    // may omit chatType, and treating every unknown room as a DM would expose the full coding agent in groups.
    // The chatId===userId invariant preserves legacy Telegram/Weixin-style DMs until their adapter is upgraded.
    if (!isPrivateApprovalMessage(m)) return;

    if (!isAllowed(m.userId, allowlist)) {
      console.error(`hara gateway: ✗ message from ${m.userId} — not in allowlist. Add it to HARA_GATEWAY_ALLOWED to authorize.`);
      await adapter.send(m.chatId, "⛔ not authorized.");
      return;
    }
    // Owner approving a pending flow action ("采用" / "改:…" / "取消")? Execute it (e.g. post the drafted reply
    // back to the origin group) instead of routing this as a fresh command. This is the flow approve→execute loop.
    if (approvalUserId && String(m.userId) === approvalUserId && isPrivateApprovalMessage(m)) {
      const pendingReply = await handleOwnerReply(approvalOwner!, m.text, { signal: ac.signal });
      if (pendingReply) {
        await adapter.send(m.chatId, pendingReply);
        return;
      }
    }
    // If a tmux session opted in (via `hara remote ask/bind`), this reply is its input → inject it into that
    // pane, let it react, and reply with the session's NEW output (on-inbound relay — quiet + iLink-friendly:
    // one reply per message, no continuous push). Owner-gated by the allowlist check above.
    if (!parseCommand(m.text)) {
      const pane = pickPaneForReply();
      if (pane) {
        console.error(`hara gateway: routed reply → tmux pane ${pane}`);
        const before = capturePane(pane) ?? "";
        injectTmux(pane, m.text);
        // wait for the session's output to SETTLE (poll every 800ms; stable for ~1.6s → done; cap ~10s) so a
        // slow response isn't missed and we don't capture mid-stream.
        let after = "";
        let stable = 0;
        for (let i = 0; i < 12; i++) {
          await new Promise((r) => setTimeout(r, 800));
          const cur = capturePane(pane) ?? "";
          if (cur === after) {
            if (++stable >= 2) break;
          } else {
            stable = 0;
            after = cur;
          }
        }
        const delta = outputDelta(before, after).trim();
        const body = delta ? (delta.length > 1500 ? "…\n" + delta.slice(-1500) : delta) : "(已注入,暂无新输出 — 发 ? 再看)";
        await adapter.send(m.chatId, `🖥 ${pane}\n${body}`);
        return;
      }
    }
    // Thread identity is (platform, chat) for DMs and (platform, chat, USER) for groups — auto-derived, so
    // group members each get their own session thread instead of interleaving into one polluted context.
    const who = { userId: m.userId, chatType: m.chatType };
    const ctx = chatContext(adapter.name, m.chatId, cwd, who); // this chat's current { cwd, sessionId, agent }
    if (ctx.rotatedFrom) {
      // Idle auto-rotation just happened (session hygiene): tell the user ONCE, with the escape hatch.
      await adapter.send(m.chatId, `🧵 fresh thread (chat was idle) — /resume ${ctx.rotatedFrom.slice(-18)} continues the previous one`);
    }
    const cmd = parseCommand(m.text);
    if (cmd) {
      if (cmd.cmd === "help")
        return adapter.send(
          m.chatId,
          "commands:\n/pwd · /cd <dir> — project\n/sessions · /new · /resume <id> — threads\n/agent <name|project:name|main> — who answers this thread (default: main)\n/voice · /say <text> — speech · /send <path> — send a file\n/detach — stop injecting replies into bound tmux panes\n/help\nanything else = run hara here",
        );
      if (cmd.cmd === "agent") {
        // Per-thread agent switch, resolved via the GLOBAL index: an agent with a home also /cd's the thread
        // there (its data + AGENTS.md context — correctness over chat continuity; /agent main switches back,
        // and the previous thread is preserved per (chat, cwd), so nothing is lost).
        if (!cmd.arg) return adapter.send(m.chatId, `🤖 current agent: ${ctx.agent ?? "main"}\nusage: /agent <name|project:name> · /agent main`);
        if (cmd.arg === "main" || cmd.arg === "off") {
          setChatAgent(adapter.name, m.chatId, undefined, who);
          const restored = chatContext(adapter.name, m.chatId, cwd, who);
          return adapter.send(m.chatId, `🤖 back to the main agent.\n📂 ${restored.cwd}`);
        }
        const { resolveAgent } = await import("../org/projects.js");
        // A bare name means the override in the thread's current project when one exists; explicit
        // `global:name` and `project:name` remain deterministic. This avoids making a local reviewer
        // ambiguous merely because several other registered projects also define one.
        const hit = resolveAgent(cmd.arg, ctx.cwd);
        if (!hit) return adapter.send(m.chatId, `✗ no agent '${cmd.arg}' — see \`hara agents\` on the host.`);
        if ("ambiguous" in hit) return adapter.send(m.chatId, `'${cmd.arg}' exists in several projects — pick one:\n${hit.ambiguous.map((e) => `${e.project}:${e.name}`).join("\n")}`);
        const agentRef = hit.project ? `${hit.project}:${hit.name}` : `global:${hit.name}`;
        setChatAgent(adapter.name, m.chatId, agentRef, who, hit.home || undefined);
        return adapter.send(m.chatId, `🤖 this thread now talks to ${agentRef}${hit.home ? `\n📂 ${hit.home}` : ""}\n/agent main switches back`);
      }
      if (cmd.cmd === "detach") {
        const { unbindBinds } = await import("./tmux-routes.js");
        const n = unbindBinds();
        return adapter.send(m.chatId, n ? `🔓 detached ${n} bound tmux pane(s) — replies go to hara again.` : "(no tmux panes were bound)");
      }
      if (cmd.cmd === "pwd") return adapter.send(m.chatId, `📂 ${ctx.cwd}\n🧵 ${ctx.sessionId.slice(-18)}`);
      if (cmd.cmd === "cd" || cmd.cmd === "project") {
        if (ctx.agent && !ctx.agent.startsWith("global:")) {
          return adapter.send(m.chatId, `🤖 ${ctx.agent} is pinned to its home. Use /agent main before changing project.`);
        }
        if (!cmd.arg) return adapter.send(m.chatId, `📂 ${ctx.cwd}\nusage: /cd <dir> (absolute, ~, or relative to here)`);
        const target = resolve(ctx.cwd, cmd.arg.replace(/^~(?=\/|$)/, homedir()));
        if (!existsSync(target) || !statSync(target).isDirectory()) return adapter.send(m.chatId, `✗ not a directory: ${target}`);
        const sid = chatCd(adapter.name, m.chatId, target, who);
        return adapter.send(m.chatId, `📂 now in ${target}\n🧵 ${sid.slice(-18)} · /sessions lists this dir's threads`);
      }
      if (cmd.cmd === "new") return adapter.send(m.chatId, `✨ new thread: ${newChatSession(adapter.name, m.chatId, cwd, who).slice(-18)}`);
      if (cmd.cmd === "sessions") {
        const list = listSessions(ctx.cwd).filter((session) => ownsChatSession(adapter.name, m.chatId, session.id, who)).slice(0, 10).map((x) => `${x.id.slice(-18)}  ${x.title || "(untitled)"}`).join("\n");
        return adapter.send(m.chatId, `📂 ${ctx.cwd}\n${list || "(no threads in this dir yet)"}`);
      }
      if (cmd.cmd === "resume") {
        const match = resolveOwnedSessionId(adapter.name, m.chatId, cmd.arg, listSessions().map((session) => session.id), who);
        if (!match) return adapter.send(m.chatId, `no session '${cmd.arg}' in this chat thread`);
        if ("ambiguous" in match) return adapter.send(m.chatId, `ambiguous session '${cmd.arg}' — use more characters`);
        const id = match.id;
        const target = loadSession(id)?.meta.cwd || ctx.cwd; // follow the session's own dir so it runs in the right place
        setChatSession(adapter.name, m.chatId, id, target, who);
        return adapter.send(m.chatId, `↩ resumed ${id.slice(-18)}\n📂 ${target}`);
      }
      if (cmd.cmd === "voice") {
        if (!adapter.sendFile) return adapter.send(m.chatId, "this platform can't send voice yet.");
        const on = toggleVoice(adapter.name, m.chatId, who);
        return adapter.send(m.chatId, on ? "🔊 voice replies ON — I'll speak each reply too." : "🔇 voice replies OFF.");
      }
      if (cmd.cmd === "say") {
        if (!adapter.sendFile) return adapter.send(m.chatId, "this platform can't send voice yet.");
        if (!cmd.arg) return adapter.send(m.chatId, "usage: /say <text to speak>");
        const audio = await synthesize(cmd.arg);
        if (!audio) return adapter.send(m.chatId, "✗ TTS failed (check HARA_TTS_* config).");
        try {
          await deliverVerifiedLocalFile(adapter, m.chatId, audio);
        } finally {
          rmSync(audio, { force: true });
        }
        return;
      }
      if (cmd.cmd === "send") {
        if (!adapter.sendFile) return adapter.send(m.chatId, "this platform can't send files yet.");
        const p = cmd.arg ? resolve(ctx.cwd, cmd.arg.replace(/^~(?=\/|$)/, homedir())) : "";
        if (!p) return adapter.send(m.chatId, "usage: /send <path> (abs, ~, or relative to current dir)");
        try {
          await deliverVerifiedLocalFile(adapter, m.chatId, p);
        } catch (error) {
          return adapter.send(m.chatId, `✗ couldn't send ${p}: ${error instanceof Error ? error.message : String(error)}`);
        }
        return;
      }
      // any other slash word → treat as a normal task
    }
    // Transient progress marker — capability-driven: sent ONLY where it can be recalled afterwards (Feishu),
    // so it never leaves residue. Platforms without recall (WeChat iLink: send response is `{}`, no message
    // id exists to revoke) get no marker at all — a clean thread beats a permanent "working…" bubble.
    let workingId: string | undefined;
    if (adapter.sendTracked && adapter.recall) workingId = await adapter.sendTracked(m.chatId, "⟳ working…").catch(() => undefined);
    let result: HaraRun;
    try {
      result = await sessionRuns.run(ctx.sessionId, () => runHara(m.text, ctx.sessionId, ctx.cwd, adapter.name, m.images, ctx.agent, { signal: ac.signal }));
    } catch (e) {
      if (e instanceof GatewayQueueFullError) {
        const message = e.scope === "session"
          ? "⏳ this thread is busy — wait for an earlier message to finish, then retry."
          : "⏳ the gateway is at capacity — try again shortly.";
        await adapter.send(m.chatId, message);
        return;
      }
      if (e instanceof GatewayQueueClosedError || ac.signal.aborted) {
        return;
      }
      throw e;
    } finally {
      if (workingId && adapter.recall) await adapter.recall(m.chatId, workingId).catch(() => {});
    }
    const { reply, files } = result;
    try {
      if (ac.signal.aborted) return;
      const hasReply = Boolean(reply);
      if (hasReply) await adapter.send(m.chatId, plainChat(reply)); // chat bubbles are plain text — flatten markdown
      else if (files.length) await adapter.send(m.chatId, "📎");
      // Deliver only immutable private snapshots produced by send_file.
      for (const f of files) {
        if (!adapter.sendFile) {
          await adapter.send(m.chatId, "(this platform can't send files yet)");
          break;
        }
        try {
          await adapter.sendFile(m.chatId, f);
        } catch (e: any) {
          await adapter.send(m.chatId, `✗ couldn't send attachment: ${e.message}`);
        }
      }
      if (hasReply && ctx.voice && adapter.sendFile) {
        const audio = await synthesize(reply);
        if (audio) {
          try {
            await deliverVerifiedLocalFile(adapter, m.chatId, audio);
          } finally {
            rmSync(audio, { force: true });
          }
        }
      }
    } finally {
      // Text-send failures, shutdown races, unsupported adapters, and upload failures all remove snapshots.
      for (const f of files) cleanupOutboundSnapshot(f.snapshotPath);
    }
    } finally {
      await cleanupTransientMedia(platform, m.transientFiles).catch((error) => {
        console.error(`hara gateway: inbound media cleanup failed — ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    }, ac.signal, (m) => shouldDownloadInboundMedia(m, allowlist));
  } finally {
    stop();
    closeQueue();
    await sessionRuns.waitForIdle();
    ac.signal.removeEventListener("abort", closeQueue);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
