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
  fchmodSync,
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
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import "../tools/all.js"; // register the full built-in toolset — serve must work as a standalone entry
import { runAgent } from "../agent/loop.js";
import { COMPACT_SYSTEM, buildFileRestore, workingSetFromSummary } from "../agent/compact.js";
import { rewindTo } from "../agent/rewind.js";
import { analyzeContext } from "../agent/context-report.js";
import { clearTouched, recentTouched } from "../agent/touched.js";
import { resetRepeatGuard } from "../agent/repeat-guard.js";
import { contextWindow, ctxPctFor } from "../statusbar.js";
import { listProjectFilesAsync } from "../fs-walk.js";
import { fuzzyRank } from "../fuzzy.js";
import type { Provider, NeutralMsg } from "../providers/types.js";
import type { UiSink } from "../tools/registry.js";
import type { ApprovalMode } from "../config.js";
import type { SandboxMode } from "../sandbox.js";
import { loadAgentContext } from "../context/agents-md.js";
import { expandMentionsAsync } from "../context/mentions.js";
import { memoryDigest } from "../memory/store.js";
import { listInstalled, enabledPlugins, setPluginEnabled, panelsForProject } from "../plugins/plugins.js";
import { loadSkillIndex, loadSkillBody } from "../skills/skills.js";
import { loadJobs, addJob, removeJob, setEnabled } from "../cron/store.js";
import { parseSchedule, describeSchedule } from "../cron/schedule.js";
import { loadTasks } from "../tools/task.js";
import { listPending, resolvePending } from "../gateway/flows-pending.js";
import { disposeTodoScope, restoreTodos, serializeTodos } from "../tools/todo.js";
import { disposeReminderScope } from "../agent/reminders.js";
import { SessionHub, realStore, type SessionStore, type ServeSession } from "./sessions.js";
import { parseFrame, rpcResult, rpcError, rpcNotify, ERR, PROTOCOL_VERSION } from "./protocol.js";
import { readModelContextFileSync } from "../fs-read.js";

/** What the CLI entry injects (built in index.ts, where config/providers/guardian already live). */
export interface ServeDeps {
  version: string;
  providerId: string;
  model: string;
  buildSessionProvider: (cwd?: string) => Promise<Provider | null>; // fresh live config/credential route
  /** provider for a specific model/effort — powers per-session model switching (composer picker) */
  buildProviderFor?: (model: string, effort?: string, cwd?: string) => Promise<Provider | null>;
  /** live model list from the endpoint (may be empty — not every endpoint enumerates) */
  listModels?: (cwd?: string) => Promise<string[]>;
  /** thinking-dial levels valid for this endpoint's reasoning style (from the provider registry) */
  effortLevels?: string[];
  /** Live defaults advertised to persistent clients after config/profile edits. */
  runtimeInfo?: (cwd?: string) => { providerId: string; model: string; effortLevels?: string[] };
  /** Per-project lifecycle limits, read at turn start so persistent Desktop sessions pick up config edits. */
  runLimits?: (cwd?: string) => { timeoutMs: number; maxRounds: number };
  spawnSubagent: (provider: Provider, cwd: string, projectContext: string | undefined, stats: { input: number; output: number; lastInput?: number }, task: string, role?: string, signal?: AbortSignal) => Promise<string>;
  guardian?: { provider?: Provider | null; enabled?: boolean };
  buildGuardian?: (cwd?: string) => Promise<{ provider?: Provider | null; enabled?: boolean } | undefined>;
  sandbox: SandboxMode;
  approval: ApprovalMode;
  store?: SessionStore; // tests inject a hermetic store
  quietDiscovery?: boolean; // tests: skip ~/.hara/serve.json
  discoveryHome?: string; // tests: isolate the discovery file from the real home directory
  compactTimeoutMs?: number; // tests/embedders: bound a provider that ignores cancellation
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
    fd = openSync(dir, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    const st = fstatSync(fd);
    if (!st.isDirectory()) throw new Error(`${dir} must be a private directory, not a symlink`);
    // mkdir's mode does not affect a legacy directory. Operate through the verified descriptor so a path
    // replacement cannot redirect chmod to a symlink target between validation and permission tightening.
    fchmodSync(fd, 0o700);
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
      fd = openSync(temp, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
      fchmodSync(fd, 0o600);
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
      fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
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
      if (!linked.isFile() || linked.isSymbolicLink() || linked.dev !== opened.dev || linked.ino !== opened.ino) return;
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

/** Compact history for session.resume — enough for a client to render the transcript. */
export function historyForClient(history: NeutralMsg[]): { role: string; text: string }[] {
  const out: { role: string; text: string }[] = [];
  for (const m of history) {
    if (m.role === "user") out.push({ role: "user", text: m.content });
    else if (m.role === "assistant" && m.text) out.push({ role: "assistant", text: m.text });
    // tool results are omitted — clients see live tool events; persisted detail stays in the store
  }
  return out;
}

export async function startServe(opts: ServeOpts, deps: ServeDeps): Promise<ServeHandle> {
  const token = opts.token ?? randomBytes(16).toString("hex");
  const instanceId = randomUUID();
  const hub = new SessionHub(deps.store ?? realStore);
  const runtimeInfo = (cwd?: string): { providerId: string; model: string; effortLevels: string[] } => {
    const live = deps.runtimeInfo?.(cwd);
    return {
      providerId: live?.providerId ?? deps.providerId,
      model: live?.model ?? deps.model,
      effortLevels: live?.effortLevels ?? deps.effortLevels ?? [],
    };
  };
  const refreshSessionProvider = async (session: ServeSession): Promise<boolean> => {
    const fresh = deps.buildProviderFor
      ? await deps.buildProviderFor(session.meta.model, session.effort, session.meta.cwd)
      : await deps.buildSessionProvider(session.meta.cwd);
    if (!fresh) return false;
    session.provider = fresh;
    session.meta.provider = fresh.id;
    // Preserve the user's pinned model in meta; provider factories should honor it, but fail closed if they do not.
    return fresh.model === session.meta.model;
  };
  const wss = new WebSocketServer({ host: opts.host, port: opts.port, maxPayload: 10 * 1024 * 1024 });
  await new Promise<void>((res, rej) => {
    wss.once("listening", res);
    wss.once("error", rej);
  });
  const port = (wss.address() as { port: number }).port;

  const authed = new Set<WebSocket>();
  const pendingApprovals = new Map<string, (v: boolean | "always") => void>();
  const inFlightRequests = new Set<Promise<void>>();
  let closing = false;
  let closePromise: Promise<void> | null = null;

  const broadcast = (method: string, params: Record<string, unknown>): void => {
    const frame = rpcNotify(method, params);
    for (const ws of authed) if (ws.readyState === ws.OPEN) ws.send(frame);
  };

  // Discovery file — the desktop shell reads this to find the running server (like a pid/port file).
  const discoveryDir = join(deps.discoveryHome ?? homedir(), ".hara");
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

  /** Run one turn on a session, streaming events to all authed clients. */
  const runTurn = async (
    s: ServeSession,
    text: string,
    images?: { path: string; mediaType: string }[],
  ): Promise<{ reply: string; usage: { input: number; output: number }; ctx: { lastInput: number; window: number; pct: number } }> => {
    const sessionId = s.meta.id;
    s.busy = true;
    const turnAbort = new AbortController();
    s.abort = turnAbort;
    const historyStart = s.history.length;
    const before = { input: s.stats.input, output: s.stats.output };
    const sink: UiSink = {
      text: (d) => broadcast("event.text", { sessionId, delta: d }),
      reasoning: (d) => broadcast("event.reasoning", { sessionId, delta: d }),
      tool: (name, preview) => broadcast("event.tool", { sessionId, name, preview }),
      diff: (t) => broadcast("event.diff", { sessionId, text: t }),
      notice: (t) => broadcast("event.notice", { sessionId, text: t }),
    };
    const confirm = (q: string, signal: AbortSignal = turnAbort.signal): Promise<boolean | "always"> =>
      new Promise((resolve) => {
        const approvalId = randomUUID();
        let settled = false;
        let timer: ReturnType<typeof setTimeout>;
        const finish = (v: boolean | "always"): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          pendingApprovals.delete(approvalId);
          signal.removeEventListener("abort", onAbort);
          resolve(v);
        };
        const onAbort = (): void => finish(false);
        timer = setTimeout(() => finish(false), APPROVAL_TIMEOUT_MS); // unanswered → deny, turn continues
        pendingApprovals.set(approvalId, finish);
        if (signal.aborted) finish(false);
        else {
          // `signal` is runAgent's combined Esc + total-deadline signal. Listening only to turnAbort would
          // leave the approval map and Desktop prompt stale when the internal lifecycle deadline fires.
          signal.addEventListener("abort", onAbort, { once: true });
          broadcast("approval.request", { sessionId, approvalId, question: q });
        }
      });
    try {
      if (!(await refreshSessionProvider(s))) {
        throw new Error(`provider not authenticated for pinned model '${s.meta.model}' at ${s.meta.cwd}`);
      }
      const turnGuardian = deps.buildGuardian ? await deps.buildGuardian(s.meta.cwd) : deps.guardian;
      restoreTodos(s.meta.todos, sessionId);
      // Slash skills, CLI parity: "/skill-id request…" expands into the skill-entering message, so a
      // desktop composer's "/" popup triggers the exact behavior the terminal gets. Unknown ids fall
      // through as plain text (the model sees what the user typed).
      let content = text;
      const slash = /^\/([a-z0-9][\w-]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
      if (slash) {
        const sk = loadSkillIndex(s.meta.cwd).find((k) => k.id === slash[1]);
        if (sk) {
          const rest = slash[2]?.trim();
          content = `Skill \`${sk.id}\`:\n${loadSkillBody(sk)}\n\n---\nEntering ${sk.id} mode${rest ? ` — request: ${rest}` : ""}. Follow this skill now. If it has a workspace or live preview, OPEN it FIRST so any existing progress is visible, then proceed — offer to continue existing work or start fresh.`;
        }
      }
      // @file mentions expand to file contents, same as the CLI (`@src/foo.ts` in the composer works).
      // Pasted images ride along as NeutralMsg.images — a vision-capable model sees them inline.
      s.history.push({ role: "user", content: await expandMentionsAsync(content, s.meta.cwd, { signal: turnAbort.signal }), ...(images && images.length ? { images } : {}) });
      const outcome = await runAgent(s.history, {
        provider: s.provider,
        ctx: {
          cwd: s.meta.cwd,
          sandbox: deps.sandbox,
          todoScope: sessionId,
          spawn: (t, role, signal) => deps.spawnSubagent(s.provider, s.meta.cwd, s.projectContext, s.stats, t, role, signal),
          ui: sink,
        },
        approval: s.approval,
        confirm,
        autoApprove: s.autoApprove,
        projectContext: s.projectContext,
        memory: memoryDigest(s.meta.cwd),
        continuationSession: s.continuationSession,
        stats: s.stats,
        signal: turnAbort.signal,
        onProviderTurn: (turn) => {
          s.pendingProviderTurns += 1;
          const settled = (): void => {
            s.pendingProviderTurns = Math.max(0, s.pendingProviderTurns - 1);
            if (closing) hub.releaseIdle();
          };
          void turn.then(settled, settled);
        },
        onToolRun: (toolRun) => {
          s.pendingToolRuns += 1;
          const settled = (): void => {
            s.pendingToolRuns = Math.max(0, s.pendingToolRuns - 1);
            // `abort === null` means the logical turn already returned. Keep the session busy/locked until
            // every late side-effect-capable Promise has physically stopped.
            if (s.pendingToolRuns === 0 && s.abort === null) s.busy = false;
            if (closing) hub.releaseIdle();
          };
          void toolRun.then(settled, settled);
        },
        guardian: turnGuardian,
        ...(deps.runLimits?.(s.meta.cwd) ?? {}),
      });
      s.meta.todos = serializeTodos(sessionId);
      hub.save(s);
      const usage = { input: s.stats.input - before.input, output: s.stats.output - before.output };
      // context watermark rides along with every turn end (codex thread/tokenUsage/updated pattern) —
      // clients render a meter without an extra round-trip.
      const ctx = ctxOf(s);
      if (outcome.status !== "completed") {
        const failure = outcome.error ?? (outcome.status === "empty"
          ? "the model returned an empty response after retrying"
          : outcome.status === "halted"
            ? "agent turn halted by a safety control"
            : "agent turn failed");
        broadcast("event.turn_end", { sessionId, reply: "", error: failure, status: outcome.status, usage, ctx });
        throw new Error(failure);
      }
      // A persistent session may already contain many assistant messages. Only messages appended by THIS
      // request are eligible for its reply; a failed/empty turn must never replay a previous success.
      const reply = lastAssistantText(s.history.slice(historyStart));
      broadcast("event.turn_end", { sessionId, reply, usage, ctx });
      return { reply, usage, ctx };
    } finally {
      s.abort = null;
      s.busy = s.pendingToolRuns > 0;
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
      void Promise.resolve().then(() => {
        // The abort can fire after scheduling this microtask but before it runs. Gate the provider call at
        // the actual invocation boundary so an interrupted/expired compact cannot start a late request.
        if (controller.signal.aborted) throw new Error(timedOut ? "compaction timed out" : "compaction interrupted");
        return s.provider.turn({
          system: COMPACT_SYSTEM,
          history: [...s.history, { role: "user", content: "Summarize our conversation so far per the instructions." }],
          tools: [],
          onText: () => {},
          signal: controller.signal,
        });
      }).then(
        (result) => finish(() => resolve(result)),
        (error) => finish(() => reject(error)),
      );
    });
    if (controller.signal.aborted || r.stop === "error") return null;
    const summary = r.text.trim();
    if (!summary) return null;
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
    s.history.length = 0;
    s.history.push({ role: "user", content: `Summary of our conversation so far (continue from here):\n\n${summary}` });
    if (restore) s.history.push({ role: "user", content: restore });
    s.stats.input += r.usage?.input ?? 0;
    s.stats.output += r.usage?.output ?? 0;
    s.stats.lastInput = r.usage?.input ?? 0; // ctx% now reflects the (small) summary
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
            "session.list", "session.create", "session.resume", "session.send", "session.interrupt", "session.set-model",
            "session.rename", "session.archive", "session.compact", "session.rewind", "session.context", "session.delete", "session.fork",
            "approval.reply", "plugins.list", "plugins.set", "skills.list", "models.list", "files.search", "project.panels",
            "automation.list", "automation.add", "automation.toggle", "automation.delete",
            "tasks.list", "approvals.list", "approvals.resolve",
          ];
          const runtime = runtimeInfo();
          return reply(rpcResult(id!, { name: "hara", version: deps.version, protocol: PROTOCOL_VERSION, cwd: opts.cwd, provider: runtime.providerId, model: runtime.model, capabilities: { methods } }));
        }
        if (!authed.has(ws)) return reply(rpcError(id, ERR.UNAUTHORIZED, "initialize first"));

        switch (req.method) {
          case "session.list":
            return reply(rpcResult(id!, { sessions: hub.list(typeof p.cwd === "string" ? p.cwd : undefined).filter((m) => !m.archived || p.archived === true).map((m) => ({ id: m.id, title: m.title, cwd: m.cwd, model: m.model, updatedAt: m.updatedAt, source: m.source ?? "interactive", sourceName: m.sourceName, archived: m.archived ?? false })) }));
          case "session.create": {
            const cwd = typeof p.cwd === "string" && p.cwd ? p.cwd : opts.cwd;
            const provider = await deps.buildSessionProvider(cwd);
            if (closing) return;
            if (!provider) return reply(rpcError(id, ERR.INTERNAL, "provider not authenticated — check the active profile and ~/.hara/config.json"));
            const approval = (["suggest", "auto-edit", "full-auto"] as ApprovalMode[]).includes(p.approval) ? (p.approval as ApprovalMode) : deps.approval;
            const s = hub.create({ cwd, provider, providerId: provider.id, model: provider.model, approval, projectContext: loadAgentContext(cwd) || undefined });
            return reply(rpcResult(id!, { sessionId: s.meta.id, model: s.meta.model }));
          }
          case "session.resume": {
            if (typeof p.sessionId !== "string") return reply(rpcError(id, ERR.PARAMS, "sessionId required"));
            const live = hub.get(p.sessionId);
            if (live?.busy || live?.configuring) return reply(rpcError(id, ERR.BUSY, "session is running or changing configuration — retry resume shortly"));
            const priorMeta = hub.peekMeta(p.sessionId);
            const provider = priorMeta && deps.buildProviderFor
              ? await deps.buildProviderFor(priorMeta.model, undefined, priorMeta.cwd)
              : await deps.buildSessionProvider(priorMeta?.cwd);
            if (closing) return;
            if (!provider) return reply(rpcError(id, ERR.INTERNAL, "provider not authenticated — check the active profile and ~/.hara/config.json"));
            const r = hub.resume(p.sessionId, { provider, approval: deps.approval, projectContext: undefined });
            if ("missing" in r) return reply(rpcError(id, ERR.NO_SESSION, `no session ${p.sessionId}`));
            if ("lockedBy" in r) return reply(rpcError(id, ERR.LOCKED, `session held by live pid ${r.lockedBy}`));
            if ("busy" in r) return reply(rpcError(id, ERR.BUSY, "session is running or changing configuration — retry resume shortly"));
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
            r.session.projectContext = loadAgentContext(r.session.meta.cwd) || undefined;
            return reply(rpcResult(id!, { sessionId: r.session.meta.id, model: r.session.meta.model, history: historyForClient(r.session.history) }));
          }
          case "session.send": {
            if (typeof p.sessionId !== "string" || typeof p.text !== "string" || !p.text) return reply(rpcError(id, ERR.PARAMS, "sessionId + text required"));
            const s = hub.get(p.sessionId);
            if (!s) return reply(rpcError(id, ERR.NO_SESSION, `no live session ${p.sessionId} — session.create/resume first`));
            if (s.busy || s.configuring) return reply(rpcError(id, ERR.BUSY, "this session is busy or changing configuration"));
            const images = Array.isArray(p.images)
              ? p.images.filter((im: any) => im && typeof im.path === "string").map((im: any) => ({ path: im.path, mediaType: typeof im.mediaType === "string" ? im.mediaType : "image/png" }))
              : undefined;
            const r = await runTurn(s, p.text, images);
            return reply(rpcResult(id!, r));
          }
          case "session.interrupt": {
            const s = typeof p.sessionId === "string" ? hub.get(p.sessionId) : undefined;
            if (!s) return reply(rpcError(id, ERR.NO_SESSION, "no such live session"));
            s.abort?.abort();
            return reply(rpcResult(id!, {}));
          }
          case "approval.reply": {
            if (typeof p.approvalId !== "string") return reply(rpcError(id, ERR.PARAMS, "approvalId required"));
            const resolve = pendingApprovals.get(p.approvalId);
            if (resolve) resolve(p.always === true ? "always" : p.allow === true);
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
            const provider = sourceMeta && deps.buildProviderFor
              ? await deps.buildProviderFor(sourceMeta.model, undefined, sourceMeta.cwd)
              : await deps.buildSessionProvider(sourceMeta?.cwd);
            if (closing) return;
            if (!provider) return reply(rpcError(id, ERR.INTERNAL, "provider not authenticated — check the active profile and ~/.hara/config.json"));
            const r = hub.fork(p.sessionId, { provider, providerId: provider.id, approval: deps.approval, projectContext: undefined });
            if ("missing" in r) return reply(rpcError(id, ERR.NO_SESSION, `no session ${p.sessionId}`));
            if ("busy" in r) return reply(rpcError(id, ERR.BUSY, "source session is mid-turn — fork after it completes"));
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
            const session = typeof p.sessionId === "string" ? hub.get(p.sessionId) : undefined;
            const targetCwd = typeof p.cwd === "string" && p.cwd ? p.cwd : (session?.meta.cwd ?? opts.cwd);
            const models = deps.listModels ? await deps.listModels(targetCwd).catch(() => []) : [];
            const runtime = runtimeInfo(targetCwd);
            return reply(rpcResult(id!, { models, current: session?.meta.model ?? runtime.model, effort: session?.effort ?? null, effortLevels: runtime.effortLevels }));
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
            s.configuring = true;
            try {
              const provider = await deps.buildProviderFor(model, effort, s.meta.cwd);
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
            // as conversation". Read-only.
            const jobs = loadJobs().map((j) => ({ id: j.id, name: j.name, mode: j.mode, cwd: j.cwd, enabled: j.enabled, deliver: j.deliver, lastRunAt: j.lastRunAt, lastStatus: j.lastStatus, lastError: j.lastError, schedule: describeSchedule(j.schedule) }));
            const automated = hub.list().filter((m) => m.source === "cron" || m.source === "gateway").map((m) => ({ id: m.id, title: m.title, cwd: m.cwd, source: m.source, sourceName: m.sourceName, updatedAt: m.updatedAt }));
            return reply(rpcResult(id!, { jobs, sessions: automated }));
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
            if (typeof p.name !== "string" || !p.name || typeof p.schedule !== "string" || typeof p.task !== "string" || !p.task) {
              return reply(rpcError(id, ERR.PARAMS, "name + schedule + task required"));
            }
            const sched = parseSchedule(p.schedule, Date.now());
            if ("error" in sched) return reply(rpcError(id, ERR.PARAMS, `bad schedule: ${sched.error}`));
            const job = addJob({
              name: p.name.slice(0, 60),
              schedule: sched,
              task: p.task,
              mode: (["print", "org", "command"] as const).includes(p.mode) ? p.mode : "print",
              cwd: typeof p.cwd === "string" && p.cwd ? p.cwd : opts.cwd,
              ...(typeof p.tz === "string" && p.tz ? { tz: p.tz } : {}),
              createdAt: Date.now(),
            });
            return reply(rpcResult(id!, { id: job.id, name: job.name, schedule: describeSchedule(job.schedule) }));
          }
          case "automation.toggle": {
            if (typeof p.id !== "string" || typeof p.enabled !== "boolean") return reply(rpcError(id, ERR.PARAMS, "id + enabled required"));
            if (!setEnabled(p.id, p.enabled)) return reply(rpcError(id, ERR.PARAMS, `no job ${p.id}`));
            return reply(rpcResult(id!, { id: p.id, enabled: p.enabled }));
          }
          case "automation.delete": {
            if (typeof p.id !== "string") return reply(rpcError(id, ERR.PARAMS, "id required"));
            if (!removeJob(p.id)) return reply(rpcError(id, ERR.PARAMS, `no job ${p.id}`));
            return reply(rpcResult(id!, { id: p.id, deleted: true }));
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
              s.busy = false;
              if (s.abort === compactAbort) s.abort = null;
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
            hub.save(s);
            return reply(rpcResult(id!, { sessionId: s.meta.id, history: historyForClient(s.history) }));
          }
          default:
            return reply(rpcError(id, ERR.METHOD, `unknown method ${req.method}`));
        }
        } catch (e: any) {
          return reply(rpcError(id, ERR.INTERNAL, String(e?.message ?? e)));
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
        for (const resolve of pendingApprovals.values()) resolve(false);
        pendingApprovals.clear();
      }
    });
  });

  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closing = true; // message handlers check this before parsing, so no new work enters the hub
    closePromise = (async () => {
      const deadline = Date.now() + SHUTDOWN_GRACE_MS;
      const serverClosed = new Promise<void>((resolve) => {
        try {
          wss.close(() => resolve()); // stop accepting sockets immediately
        } catch {
          resolve(); // already closed/not running
        }
      });

      for (const resolve of pendingApprovals.values()) resolve(false);
      pendingApprovals.clear();
      for (const session of hub.active()) session.abort?.abort();

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

      let quiet = false;
      while (Date.now() < deadline) {
        if (inFlightRequests.size === 0 && hub.active().every((session) => !session.busy && !session.configuring && session.pendingProviderTurns === 0 && session.pendingToolRuns === 0)) {
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
