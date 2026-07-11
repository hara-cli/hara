// hara serve — the persistent local server (WebSocket JSON-RPC, protocol.ts) that desktop shells, ACP
// clients, and IDE plugins drive. codex's app-server layering in TypeScript: shell ↔ protocol ↔ agent
// core, with the agent core (runAgent + plugins + skills + memory) running IN-PROCESS — plugins need no
// bridging. Provider building / subagent spawn / guardian stay in index.ts and are injected as ServeDeps
// (no import cycle back into the CLI entry).
import { WebSocketServer, type WebSocket } from "ws";
import { randomBytes, randomUUID, timingSafeEqual, createHash } from "node:crypto";
import { writeFileSync, unlinkSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import "../tools/all.js"; // register the full built-in toolset — serve must work as a standalone entry
import { runAgent } from "../agent/loop.js";
import { COMPACT_SYSTEM, buildFileRestore, workingSetFromSummary } from "../agent/compact.js";
import { rewindTo } from "../agent/rewind.js";
import { analyzeContext } from "../agent/context-report.js";
import { recentTouched } from "../agent/touched.js";
import { contextWindow, ctxPctFor } from "../statusbar.js";
import { listProjectFiles } from "../fs-walk.js";
import { fuzzyRank } from "../fuzzy.js";
import type { Provider, NeutralMsg } from "../providers/types.js";
import type { UiSink } from "../tools/registry.js";
import type { ApprovalMode } from "../config.js";
import type { SandboxMode } from "../sandbox.js";
import { loadAgentsMd } from "../context/agents-md.js";
import { expandMentions } from "../context/mentions.js";
import { memoryDigest } from "../memory/store.js";
import { listInstalled, enabledPlugins, setPluginEnabled, panelsForProject } from "../plugins/plugins.js";
import { loadSkillIndex, loadSkillBody } from "../skills/skills.js";
import { loadJobs, saveJobs, addJob } from "../cron/store.js";
import { parseSchedule, describeSchedule } from "../cron/schedule.js";
import { SessionHub, realStore, type SessionStore, type ServeSession } from "./sessions.js";
import { parseFrame, rpcResult, rpcError, rpcNotify, ERR, PROTOCOL_VERSION } from "./protocol.js";

/** What the CLI entry injects (built in index.ts, where config/providers/guardian already live). */
export interface ServeDeps {
  version: string;
  providerId: string;
  model: string;
  buildSessionProvider: () => Promise<Provider | null>; // fresh provider per session (stateless today, cheap)
  /** provider for a specific model/effort — powers per-session model switching (composer picker) */
  buildProviderFor?: (model: string, effort?: string) => Promise<Provider | null>;
  /** live model list from the endpoint (may be empty — not every endpoint enumerates) */
  listModels?: () => Promise<string[]>;
  /** thinking-dial levels valid for this endpoint's reasoning style (from the provider registry) */
  effortLevels?: string[];
  spawnSubagent: (provider: Provider, cwd: string, projectContext: string | undefined, stats: { input: number; output: number; lastInput?: number }, task: string, role?: string) => Promise<string>;
  guardian?: { provider?: Provider | null; enabled?: boolean };
  sandbox: SandboxMode;
  approval: ApprovalMode;
  store?: SessionStore; // tests inject a hermetic store
  quietDiscovery?: boolean; // tests: skip ~/.hara/serve.json
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
  const hub = new SessionHub(deps.store ?? realStore);
  const wss = new WebSocketServer({ host: opts.host, port: opts.port, maxPayload: 10 * 1024 * 1024 });
  await new Promise<void>((res, rej) => {
    wss.once("listening", res);
    wss.once("error", rej);
  });
  const port = (wss.address() as { port: number }).port;

  const authed = new Set<WebSocket>();
  const pendingApprovals = new Map<string, (v: boolean | "always") => void>();

  const broadcast = (method: string, params: Record<string, unknown>): void => {
    const frame = rpcNotify(method, params);
    for (const ws of authed) if (ws.readyState === ws.OPEN) ws.send(frame);
  };

  // Discovery file — the desktop shell reads this to find the running server (like a pid/port file).
  const discoveryPath = join(homedir(), ".hara", "serve.json");
  if (!deps.quietDiscovery) {
    mkdirSync(join(homedir(), ".hara"), { recursive: true });
    writeFileSync(discoveryPath, JSON.stringify({ host: opts.host, port, token, pid: process.pid, version: deps.version }, null, 2), { mode: 0o600 });
  }

  /** Run one turn on a session, streaming events to all authed clients. */
  const runTurn = async (
    s: ServeSession,
    text: string,
    images?: { path: string; mediaType: string }[],
  ): Promise<{ reply: string; usage: { input: number; output: number }; ctx: { lastInput: number; window: number; pct: number } }> => {
    const sessionId = s.meta.id;
    s.busy = true;
    s.abort = new AbortController();
    const before = { input: s.stats.input, output: s.stats.output };
    const sink: UiSink = {
      text: (d) => broadcast("event.text", { sessionId, delta: d }),
      reasoning: (d) => broadcast("event.reasoning", { sessionId, delta: d }),
      tool: (name, preview) => broadcast("event.tool", { sessionId, name, preview }),
      diff: (t) => broadcast("event.diff", { sessionId, text: t }),
      notice: (t) => broadcast("event.notice", { sessionId, text: t }),
    };
    const confirm = (q: string): Promise<boolean | "always"> =>
      new Promise((resolve) => {
        const approvalId = randomUUID();
        const timer = setTimeout(() => {
          if (pendingApprovals.delete(approvalId)) resolve(false); // unanswered → deny, turn continues
        }, APPROVAL_TIMEOUT_MS);
        pendingApprovals.set(approvalId, (v) => {
          clearTimeout(timer);
          pendingApprovals.delete(approvalId);
          resolve(v);
        });
        broadcast("approval.request", { sessionId, approvalId, question: q });
      });
    try {
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
      s.history.push({ role: "user", content: expandMentions(content, s.meta.cwd), ...(images && images.length ? { images } : {}) });
      await runAgent(s.history, {
        provider: s.provider,
        ctx: {
          cwd: s.meta.cwd,
          sandbox: deps.sandbox,
          spawn: (t, role) => deps.spawnSubagent(s.provider, s.meta.cwd, s.projectContext, s.stats, t, role),
          ui: sink,
        },
        approval: s.approval,
        confirm,
        autoApprove: s.autoApprove,
        projectContext: s.projectContext,
        memory: memoryDigest(s.meta.cwd),
        stats: s.stats,
        signal: s.abort.signal,
        guardian: deps.guardian,
      });
      hub.save(s);
      const usage = { input: s.stats.input - before.input, output: s.stats.output - before.output };
      const reply = lastAssistantText(s.history);
      // context watermark rides along with every turn end (codex thread/tokenUsage/updated pattern) —
      // clients render a meter without an extra round-trip.
      const ctx = ctxOf(s);
      broadcast("event.turn_end", { sessionId, reply, usage, ctx });
      return { reply, usage, ctx };
    } finally {
      s.busy = false;
      s.abort = null;
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
  const compactSession = async (s: ServeSession): Promise<string | null> => {
    const r = await s.provider.turn({
      system: COMPACT_SYSTEM,
      history: [...s.history, { role: "user", content: "Summarize our conversation so far per the instructions." }],
      tools: [],
      onText: () => {},
    });
    if (r.stop === "error") return null;
    const summary = r.text.trim();
    if (!summary) return null;
    s.meta.workingSet = workingSetFromSummary(summary);
    s.history.length = 0;
    s.history.push({ role: "user", content: `Summary of our conversation so far (continue from here):\n\n${summary}` });
    const touched = recentTouched(20).filter((f) => f.startsWith(s.meta.cwd)).slice(0, 5);
    const restore = buildFileRestore(touched, (f) => {
      try {
        return readFileSync(f, "utf8");
      } catch {
        return null;
      }
    });
    if (restore) s.history.push({ role: "user", content: restore });
    s.stats.input += r.usage?.input ?? 0;
    s.stats.output += r.usage?.output ?? 0;
    s.stats.lastInput = r.usage?.input ?? 0; // ctx% now reflects the (small) summary
    hub.save(s);
    return summary;
  };

  wss.on("connection", (ws: WebSocket) => {
    ws.on("message", async (raw) => {
      const parsed = parseFrame(String(raw));
      if ("error" in parsed) return void ws.send(rpcError(null, ERR.PARSE, parsed.error));
      const { req } = parsed;
      const id = req.id ?? null;
      const reply = (frame: string): void => void (id !== null && ws.send(frame));
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
          ];
          return reply(rpcResult(id!, { name: "hara", version: deps.version, protocol: PROTOCOL_VERSION, cwd: opts.cwd, provider: deps.providerId, model: deps.model, capabilities: { methods } }));
        }
        if (!authed.has(ws)) return reply(rpcError(id, ERR.UNAUTHORIZED, "initialize first"));

        switch (req.method) {
          case "session.list":
            return reply(rpcResult(id!, { sessions: hub.list(typeof p.cwd === "string" ? p.cwd : undefined).filter((m) => !m.archived || p.archived === true).map((m) => ({ id: m.id, title: m.title, cwd: m.cwd, model: m.model, updatedAt: m.updatedAt, source: m.source ?? "interactive", sourceName: m.sourceName, archived: m.archived ?? false })) }));
          case "session.create": {
            const provider = await deps.buildSessionProvider();
            if (!provider) return reply(rpcError(id, ERR.INTERNAL, "provider not authenticated — run `hara setup`"));
            const cwd = typeof p.cwd === "string" && p.cwd ? p.cwd : opts.cwd;
            const approval = (["suggest", "auto-edit", "full-auto"] as ApprovalMode[]).includes(p.approval) ? (p.approval as ApprovalMode) : deps.approval;
            const s = hub.create({ cwd, provider, providerId: deps.providerId, model: deps.model, approval, projectContext: loadAgentsMd(cwd) || undefined });
            return reply(rpcResult(id!, { sessionId: s.meta.id, model: s.meta.model }));
          }
          case "session.resume": {
            if (typeof p.sessionId !== "string") return reply(rpcError(id, ERR.PARAMS, "sessionId required"));
            const provider = await deps.buildSessionProvider();
            if (!provider) return reply(rpcError(id, ERR.INTERNAL, "provider not authenticated — run `hara setup`"));
            const r = hub.resume(p.sessionId, { provider, approval: deps.approval, projectContext: undefined });
            if ("missing" in r) return reply(rpcError(id, ERR.NO_SESSION, `no session ${p.sessionId}`));
            if ("lockedBy" in r) return reply(rpcError(id, ERR.LOCKED, `session held by live pid ${r.lockedBy}`));
            r.session.projectContext = loadAgentsMd(r.session.meta.cwd) || undefined;
            return reply(rpcResult(id!, { sessionId: r.session.meta.id, model: r.session.meta.model, history: historyForClient(r.session.history) }));
          }
          case "session.send": {
            if (typeof p.sessionId !== "string" || typeof p.text !== "string" || !p.text) return reply(rpcError(id, ERR.PARAMS, "sessionId + text required"));
            const s = hub.get(p.sessionId);
            if (!s) return reply(rpcError(id, ERR.NO_SESSION, `no live session ${p.sessionId} — session.create/resume first`));
            if (s.busy) return reply(rpcError(id, ERR.BUSY, "a turn is already running on this session"));
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
            if (!hub.rename(p.sessionId, p.title.slice(0, 120))) return reply(rpcError(id, ERR.NO_SESSION, `no session ${p.sessionId}`));
            return reply(rpcResult(id!, { sessionId: p.sessionId, title: p.title.slice(0, 120) }));
          }
          case "session.archive": {
            if (typeof p.sessionId !== "string" || typeof p.archived !== "boolean") return reply(rpcError(id, ERR.PARAMS, "sessionId + archived required"));
            if (!hub.setArchived(p.sessionId, p.archived)) return reply(rpcError(id, ERR.NO_SESSION, `no session ${p.sessionId}`));
            return reply(rpcResult(id!, { sessionId: p.sessionId, archived: p.archived }));
          }
          case "session.fork": {
            // duplicate the conversation into a new session (codex thread/fork) — rewind's
            // non-destructive sibling: explore a different direction without losing the original
            if (typeof p.sessionId !== "string") return reply(rpcError(id, ERR.PARAMS, "sessionId required"));
            const provider = await deps.buildSessionProvider();
            if (!provider) return reply(rpcError(id, ERR.INTERNAL, "provider not authenticated — run `hara setup`"));
            const r = hub.fork(p.sessionId, { provider, providerId: deps.providerId, approval: deps.approval, projectContext: undefined });
            if ("missing" in r) return reply(rpcError(id, ERR.NO_SESSION, `no session ${p.sessionId}`));
            r.session.projectContext = loadAgentsMd(r.session.meta.cwd) || undefined;
            return reply(rpcResult(id!, { sessionId: r.session.meta.id, title: r.session.meta.title, model: r.session.meta.model, history: historyForClient(r.session.history) }));
          }
          case "session.delete": {
            // permanent removal (codex thread/delete) — archive is the soft path; this one is forever
            if (typeof p.sessionId !== "string") return reply(rpcError(id, ERR.PARAMS, "sessionId required"));
            const r = hub.delete(p.sessionId);
            if (r === "busy") return reply(rpcError(id, ERR.BUSY, "a turn is running — delete after it finishes"));
            if (r === "missing") return reply(rpcError(id, ERR.NO_SESSION, `no session ${p.sessionId} (or held by another process)`));
            return reply(rpcResult(id!, { sessionId: p.sessionId, deleted: true }));
          }
          case "models.list": {
            const models = deps.listModels ? await deps.listModels().catch(() => []) : [];
            return reply(rpcResult(id!, { models, current: deps.model, effortLevels: deps.effortLevels ?? [] }));
          }
          case "session.set-model": {
            // per-session model / thinking-effort switch (the composer picker). Rebuilds the session's
            // provider; takes effect on the NEXT turn. Refused mid-turn.
            if (typeof p.sessionId !== "string") return reply(rpcError(id, ERR.PARAMS, "sessionId required"));
            const s = hub.get(p.sessionId);
            if (!s) return reply(rpcError(id, ERR.NO_SESSION, `no live session ${p.sessionId}`));
            if (s.busy) return reply(rpcError(id, ERR.BUSY, "a turn is running — switch after it finishes"));
            const model = typeof p.model === "string" && p.model ? p.model : s.meta.model;
            const effort = typeof p.effort === "string" && p.effort ? p.effort : undefined;
            if (!deps.buildProviderFor) return reply(rpcError(id, ERR.METHOD, "model switching not supported by this server"));
            const provider = await deps.buildProviderFor(model, effort);
            if (!provider) return reply(rpcError(id, ERR.INTERNAL, `could not build provider for ${model}`));
            s.provider = provider;
            s.meta.model = model;
            s.effort = effort;
            return reply(rpcResult(id!, { sessionId: s.meta.id, model, effort: effort ?? null }));
          }
          case "automation.list": {
            // The automation timeline's data: cron jobs with their last outcome, plus this machine's
            // automated sessions (source=cron/gateway) so the desktop can render results and "continue
            // as conversation". Read-only.
            const jobs = loadJobs().map((j) => ({ id: j.id, name: j.name, mode: j.mode, cwd: j.cwd, enabled: j.enabled, deliver: j.deliver, lastRunAt: j.lastRunAt, lastStatus: j.lastStatus, lastError: j.lastError, schedule: describeSchedule(j.schedule) }));
            const automated = hub.list().filter((m) => m.source === "cron" || m.source === "gateway").map((m) => ({ id: m.id, title: m.title, cwd: m.cwd, source: m.source, sourceName: m.sourceName, updatedAt: m.updatedAt }));
            return reply(rpcResult(id!, { jobs, sessions: automated }));
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
            const jobs = loadJobs();
            const job = jobs.find((j) => j.id === p.id);
            if (!job) return reply(rpcError(id, ERR.PARAMS, `no job ${p.id}`));
            job.enabled = p.enabled;
            saveJobs(jobs);
            return reply(rpcResult(id!, { id: job.id, enabled: job.enabled }));
          }
          case "automation.delete": {
            if (typeof p.id !== "string") return reply(rpcError(id, ERR.PARAMS, "id required"));
            const jobs = loadJobs();
            if (!jobs.some((j) => j.id === p.id)) return reply(rpcError(id, ERR.PARAMS, `no job ${p.id}`));
            saveJobs(jobs.filter((j) => j.id !== p.id));
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
            const all = listProjectFiles(cwd);
            const query = typeof p.query === "string" ? p.query : "";
            const files = query ? fuzzyRank(query, all, (f) => f).slice(0, limit).map((r) => r.item) : all.slice(0, limit);
            return reply(rpcResult(id!, { files, cwd }));
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
            if (s.busy) return reply(rpcError(id, ERR.BUSY, "a turn is running — compact after it finishes"));
            if (s.history.length < 2) return reply(rpcError(id, ERR.PARAMS, "nothing to compact yet"));
            s.busy = true;
            try {
              broadcast("event.notice", { sessionId: s.meta.id, text: "✻ Compacting conversation…" });
              const summary = await compactSession(s);
              if (!summary) return reply(rpcError(id, ERR.INTERNAL, "compaction failed — try again or /clear"));
              broadcast("event.notice", { sessionId: s.meta.id, text: `(compacted — history replaced with a summary; ${s.meta.workingSet?.length ?? 0} notes kept)` });
              return reply(rpcResult(id!, { sessionId: s.meta.id, ctx: ctxOf(s), notes: s.meta.workingSet?.length ?? 0, history: historyForClient(s.history) }));
            } finally {
              s.busy = false;
            }
          }
          case "session.rewind": {
            // fork the thread back to before the n-th-most-recent user turn (codex thread/rollback;
            // n=1 drops the last exchange). History-only — file edits are not reverted.
            if (typeof p.sessionId !== "string" || !Number.isInteger(p.n)) return reply(rpcError(id, ERR.PARAMS, "sessionId + n required"));
            const s = hub.get(p.sessionId);
            if (!s) return reply(rpcError(id, ERR.NO_SESSION, `no live session ${p.sessionId}`));
            if (s.busy) return reply(rpcError(id, ERR.BUSY, "a turn is running — rewind after it finishes"));
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

  const close = async (): Promise<void> => {
    for (const resolve of pendingApprovals.values()) resolve(false);
    pendingApprovals.clear();
    hub.releaseAll();
    if (!deps.quietDiscovery) {
      try {
        unlinkSync(discoveryPath);
      } catch {
        /* already gone */
      }
    }
    await new Promise<void>((res) => wss.close(() => res()));
  };
  return { port, token, close };
}
