// Host-only command occurrence boundary. A copied cwd/role/planner DTO is NOT an execution permit.
// No default launcher, process.env, OS vault, global hara, transport or scheduler activation exists here.
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { validTz } from "../cron/schedule.js";
import { createToolOutputLineRedactor } from "../security/subprocess-env.js";
import { redactSensitiveText } from "../security/secrets.js";
import { canonical, messageBody, plain, text, UUID, WorkspaceJsonState } from "./local-state.js";
import { sameWorkspaceResourceBinding, type WorkspaceResourceBinding, type WorkspaceResourceStorage } from "./resource-context.js";
import type { WorkspaceFeatures, WorkspaceSchedule } from "./features.js";
import type { WorkspaceLegacyResources } from "./legacy-resources.js";

const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const MAX_OUTPUT = 8000, MAX_RUNS = 256;
type Reason = "host_execution_grant_required" | "hara_cli_adapter_pending" | "notification_adapter_pending"
  | "command_failed" | "command_timed_out" | "command_cancelled" | "command_output_limit"
  | "execution_outcome_unconfirmed" | "authority_changed";
const reasons: Reason[] = ["host_execution_grant_required", "hara_cli_adapter_pending", "notification_adapter_pending", "command_failed",
  "command_timed_out", "command_cancelled", "command_output_limit", "execution_outcome_unconfirmed", "authority_changed"];
type RunState = "running" | "completed" | "failed" | "blocked" | "timed_out" | "cancelled" | "unknown";
export interface LegacyCommandReceipt {
  requestId: string; runId: string; scheduleId: string; definitionHash: string; occurredAt: number;
  state: RunState; code: number | null; reason: Reason | null; output: string; truncated: boolean;
}
interface State { resourceBinding: WorkspaceResourceBinding; revision: number; runs: LegacyCommandReceipt[] }
export interface LegacyCommandReview {
  workspaceId: string; resourceBinding: WorkspaceResourceBinding; scheduleId: string; definitionHash: string;
  sourceHash: string; resourceId: string; originalPath: string;
}
/** Issued by trusted Host composition only, never from an RPC/model argument or an imported role.
 * The Host owns the actual mount, shell/OS containment and per-task credential lease. Merely changing
 * cwd/HOME is NOT an OS read/network sandbox, and does not make this adapter production-ready. */
export interface LegacyCommandGrant {
  resourceBinding: WorkspaceResourceBinding; definitionHash: string; resourceId: string;
  cwd: string; isolatedHome: string; searchPath: string;
  /** Only the separately approved task's Feishu environment, read at execution time. No ambient pool. */
  feishu?: { appId: string; appSecret: string; domain: "feishu" | "lark" };
  assertCurrent(): void;
}
export interface LegacyCommandInvocation {
  command: string; cwd: string; env: Readonly<Record<string, string>>; signal: AbortSignal;
  /** Raw child bytes/text belong in this redactor, never in logs, receipts or an error message. */
  onOutput(stream: "stdout" | "stderr", chunk: string): void;
}
export interface LegacyCommandExit {
  code: number | null;
  /** True only after the Host launcher has confirmed the owned process tree stopped. */
  terminated: boolean;
}
interface Options {
  // Synchronous, bounded Host permit/vault lookup, not a network authorization wait. An asynchronous
  // installer/approval flow must finish separately before issuing this occurrence-specific permit.
  authorize(review: Readonly<LegacyCommandReview>): LegacyCommandGrant | undefined;
  launch(invocation: LegacyCommandInvocation): Promise<LegacyCommandExit>;
  timeoutMs?: number; terminationGraceMs?: number;
}
function absolute(value: unknown): value is string {
  return typeof value === "string" && isAbsolute(value) && value !== "/" && value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value);
}
function fence(operation: () => void): void {
  const result: unknown = operation();
  if (result !== undefined) {
    if (result && typeof (result as { then?: unknown }).then === "function") void Promise.resolve(result).catch(() => {});
    throw new Error("Command authority fence must be synchronous and return void");
  }
}
/** Durable intent is published BEFORE grant/credential work or launch. Unknown occurrences never
 * auto-replay, including after restart. This is deliberately not wired into the live scheduler yet. */
export class WorkspaceLegacyCommands {
  private readonly state: WorkspaceJsonState<State>;
  private readonly active = new Map<string, Promise<LegacyCommandReceipt>>();
  private readonly timeout: number;
  private readonly grace: number;
  constructor(private readonly storage: WorkspaceResourceStorage, private readonly features: WorkspaceFeatures,
    private readonly resources: WorkspaceLegacyResources, private readonly options: Options) {
    this.timeout = options.timeoutMs ?? 30 * 60_000;
    this.grace = options.terminationGraceMs ?? 1500;
    if (!Number.isSafeInteger(this.timeout) || this.timeout < 10 || this.timeout > 24 * 60 * 60_000
      || !Number.isSafeInteger(this.grace) || this.grace < 10 || this.grace > 30_000
      || typeof options.authorize !== "function" || typeof options.launch !== "function") throw new Error("Invalid explicit command Host options");
    this.state = new WorkspaceJsonState<State>(storage, "workspace-legacy-command-runs-v1.json", raw => {
      if (!plain(raw) || !sameWorkspaceResourceBinding(raw.resourceBinding as WorkspaceResourceBinding, this.state.binding())
        || !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 1 || !Array.isArray(raw.runs) || raw.runs.length > MAX_RUNS) throw new Error("Invalid command receipts; no work replayed");
      const ids = new Set<string>();
      for (const row of raw.runs) {
        if (!plain(row) || typeof row.requestId !== "string" || !UUID.test(row.requestId) || ids.has(row.requestId)
          || typeof row.runId !== "string" || !UUID.test(row.runId) || !text(row.scheduleId) || typeof row.definitionHash !== "string" || !/^[a-f0-9]{64}$/.test(row.definitionHash)
          || typeof row.occurredAt !== "number" || !Number.isFinite(row.occurredAt) || !["running", "completed", "failed", "blocked", "timed_out", "cancelled", "unknown"].includes(String(row.state))
          || !(row.code === null || Number.isSafeInteger(row.code)) || !(row.reason === null || reasons.includes(row.reason as Reason))
          || typeof row.output !== "string" || row.output.length > MAX_OUTPUT || typeof row.truncated !== "boolean") throw new Error("Invalid command occurrence; source preserved");
        ids.add(row.requestId);
      }
      return structuredClone(raw) as unknown as State;
    }, () => ({ resourceBinding: this.state.binding(), revision: 0, runs: [] }));
  }
  list(): LegacyCommandReceipt[] {
    return this.state.read().runs.map(row => row.state === "running" && !this.active.has(row.requestId)
      ? { ...row, state: "unknown", reason: "execution_outcome_unconfirmed" } : row);
  }
  private row(id: string): WorkspaceSchedule {
    const row = this.features.schedules().find(row => row.id === id);
    if (!row || row.workspaceId !== this.storage.scope.workspaceId || row.source !== "legacy-v1" || !row.migrationId || !row.enabled
      || row.definition.mode !== "command" || !messageBody(row.definition.task, 128000) || redactSensitiveText(row.definition.task).redactions.length
      || !plain(row.definition.legacy) || row.definition.legacy.quarantined !== false || typeof row.definition.legacy.sourceHash !== "string"
      || !/^[a-f0-9]{64}$/.test(row.definition.legacy.sourceHash) || typeof row.definition.legacy.resourceId !== "string"
      || typeof row.definition.tz !== "string" || !validTz(row.definition.tz)) throw new Error("Reviewed enabled legacy command unavailable; no command launched");
    const resource = this.resources.sourceForHost(row.definition.legacy.resourceId);
    if (!resource.purposes.includes("schedule-cwd") || resource.originalPath !== row.definition.cwd) throw new Error("Command resource mapping changed; no command launched");
    return row;
  }
  execute(id: string, requestId: string, signal?: AbortSignal): Promise<LegacyCommandReceipt> {
    if (typeof requestId !== "string" || !UUID.test(requestId)) return Promise.reject(new Error("Invalid command request identity"));
    const row = this.row(id), definitionHash = hash(row), before = this.state.read();
    const previous = before.runs.find(item => item.requestId === requestId);
    if (previous) {
      if (previous.scheduleId !== id || previous.definitionHash !== definitionHash) return Promise.reject(new Error("Command request identity conflicts; no work replayed"));
      const pending = this.active.get(requestId); if (pending) return pending;
      return Promise.resolve(previous.state === "running" ? { ...previous, state: "unknown", reason: "execution_outcome_unconfirmed" } : previous);
    }
    if (signal?.aborted) return Promise.reject(new Error("Command cancelled before admission; no occurrence or model call created"));
    if (before.runs.some(row => row.scheduleId === id && (row.state === "running" || row.state === "unknown"))) return Promise.reject(new Error("This command has unconfirmed work; no new occurrence launched"));
    // Never discard dedupe identities to make room. A separate, reviewed archive protocol is needed
    // before production retention can advance; silently forgetting an old request permits replay.
    if (before.runs.length >= MAX_RUNS || before.runs.filter(row => row.state === "running" || row.state === "unknown").length >= 128) return Promise.reject(new Error("Command receipt capacity requires inspection; no new command launched"));
    const run: LegacyCommandReceipt = { requestId, runId: randomUUID(), scheduleId: id, definitionHash, occurredAt: Date.now(), state: "running", code: null, reason: null, output: "", truncated: false };
    this.state.update(before.revision, old => ({ ...old, runs: [...old.runs, run] }));
    // Defer the operation so the in-flight map is installed even for a synchronous authorization path.
    const pending = Promise.resolve().then(() => this.run(row, run, signal)); this.active.set(requestId, pending);
    void pending.finally(() => this.active.delete(requestId)).catch(() => {});
    return pending;
  }
  private finish(run: LegacyCommandReceipt, patch: Partial<LegacyCommandReceipt>): LegacyCommandReceipt {
    const next = { ...run, ...patch }, old = this.state.read();
    if (!old.runs.some(row => row.requestId === run.requestId && row.runId === run.runId && row.state === "running")) throw new Error("Command receipt changed; outcome requires inspection");
    this.state.update(old.revision, value => ({ ...value, runs: value.runs.map(row => row.runId === run.runId ? next : row) }));
    return next;
  }
  private async run(row: WorkspaceSchedule, run: LegacyCommandReceipt, signal?: AbortSignal): Promise<LegacyCommandReceipt> {
    // Do not rewrite shell text or let a PATH lookup fall through to old hara/global HOME/8790.
    // This diagnostic is intentionally conservative, not a shell parser/security sandbox. The Host
    // launcher must still enforce its executable/mount boundary for nested scripts and escaped text.
    if (/(?:^|[^a-z0-9_-])hara(?:$|[^a-z0-9_-])/i.test(row.definition.task as string)) return this.finish(run, { state: "blocked", reason: "hara_cli_adapter_pending" });
    if (row.definition.deliver || row.definition.alertAfter) return this.finish(run, { state: "blocked", reason: "notification_adapter_pending" });
    let grant: LegacyCommandGrant | undefined;
    try {
      const legacy = row.definition.legacy as Record<string, string>;
      grant = this.options.authorize(Object.freeze({ workspaceId: row.workspaceId, resourceBinding: Object.freeze(this.state.binding()), scheduleId: row.id,
        definitionHash: run.definitionHash, sourceHash: legacy.sourceHash!, resourceId: legacy.resourceId!, originalPath: row.definition.cwd as string }));
      if (grant && typeof (grant as unknown as { then?: unknown }).then === "function") {
        void Promise.resolve(grant).catch(() => {}); throw new Error("Asynchronous command authority is not a permit");
      }
      if (!grant) return this.finish(run, { state: "blocked", reason: "host_execution_grant_required" });
      if (!sameWorkspaceResourceBinding(grant.resourceBinding, this.state.binding()) || grant.definitionHash !== run.definitionHash
        || grant.resourceId !== legacy.resourceId || !absolute(grant.cwd) || !absolute(grant.isolatedHome)
        || typeof grant.searchPath !== "string" || !grant.searchPath || grant.searchPath.split(":").some(path => !absolute(path)) || typeof grant.assertCurrent !== "function") throw new Error();
      // Freeze the reviewed launch payload, not the Host's mutable object/foreground selection. The
      // original fence may revoke its lease, but cannot silently redirect cwd/env after this check.
      grant = Object.freeze({ ...grant, resourceBinding: Object.freeze({ ...grant.resourceBinding }),
        ...(grant.feishu ? { feishu: Object.freeze({ ...grant.feishu }) } : {}), assertCurrent: grant.assertCurrent.bind(grant) });
      const assertCurrent = () => { this.storage.run(() => {}); if (hash(this.row(row.id)) !== run.definitionHash) throw new Error(); fence(() => grant!.assertCurrent()); };
      assertCurrent();
      if (signal?.aborted) return this.finish(run, { state: "cancelled", reason: "command_cancelled" });
      const env: Record<string, string> = { HOME: grant.isolatedHome, USERPROFILE: grant.isolatedHome, PATH: grant.searchPath, TZ: row.definition.tz as string,
        HARA_CRON: "1", HARA_CRON_ID: row.id, HARA_UPDATE_CHECK: "0", NO_UPDATE_NOTIFIER: "1", npm_config_update_notifier: "false",
        npm_config_offline: "true", GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };
      if (grant.feishu) {
        if (!text(grant.feishu.appId, 128) || typeof grant.feishu.appSecret !== "string" || grant.feishu.appSecret.length < 6 || grant.feishu.appSecret.length > 16384
          || /[\s\u0000-\u001f\u007f]/.test(grant.feishu.appSecret) || !["feishu", "lark"].includes(grant.feishu.domain)) throw new Error();
        env.HARA_FEISHU_APP_ID = grant.feishu.appId; env.HARA_FEISHU_APP_SECRET = grant.feishu.appSecret; env.HARA_FEISHU_DOMAIN = grant.feishu.domain;
      }
      // Do not catch a started occurrence's persistence/authority failure as a pre-launch refusal.
      // Its durable running intent must remain unknown, never be relabelled "blocked" or replayed.
      return this.launch(row, run, grant, Object.freeze(env), assertCurrent, signal);
    } catch { return this.finish(run, { state: "blocked", reason: "authority_changed" }); }
  }
  private async launch(row: WorkspaceSchedule, run: LegacyCommandReceipt, grant: LegacyCommandGrant, env: Readonly<Record<string, string>>,
    assertCurrent: () => void, parent?: AbortSignal): Promise<LegacyCommandReceipt> {
    const abort = new AbortController(); let reason: Reason | null = null, output = "", truncated = false, rawCharacters = 0;
    const stop = (why: Reason) => { if (!reason) { reason = why; abort.abort(); } };
    const capture = (safe: string) => { const left = MAX_OUTPUT - output.length; if (safe.length > left || safe.startsWith("[output line omitted")) truncated = true; if (left > 0) output += safe.slice(0, left); };
    const stdout = createToolOutputLineRedactor(capture, {}, env, 8192), stderr = createToolOutputLineRedactor(capture, {}, env, 8192);
    const onOutput = (stream: "stdout" | "stderr", chunk: string) => {
      if (typeof chunk !== "string" || reason) return;
      rawCharacters += chunk.length;
      if (rawCharacters > 256000) { truncated = true; stop("command_output_limit"); return; }
      (stream === "stdout" ? stdout : stderr).push(chunk);
    };
    const cancel = () => stop("command_cancelled"); parent?.addEventListener("abort", cancel, { once: true });
    const timeout = setTimeout(() => stop("command_timed_out"), this.timeout);
    const guard = setInterval(() => { try { assertCurrent(); } catch { stop("authority_changed"); } }, 50);
    let hardTimer: NodeJS.Timeout | undefined;
    const stopped = new Promise<LegacyCommandExit>(resolve => abort.signal.addEventListener("abort", () => {
      hardTimer = setTimeout(() => resolve({ code: null, terminated: false }), this.grace);
    }, { once: true }));
    try {
      assertCurrent(); if (parent?.aborted) cancel();
      if (abort.signal.aborted) return this.finish(run, { state: "cancelled", reason: "command_cancelled" });
      const launched = Promise.resolve().then(() => { assertCurrent(); return this.options.launch({ command: row.definition.task as string, cwd: grant.cwd, env, signal: abort.signal, onOutput }); });
      let exit: LegacyCommandExit;
      try { exit = await Promise.race([launched, stopped]); }
      catch { stop("execution_outcome_unconfirmed"); exit = { code: null, terminated: false }; }
      stdout.flush(); stderr.flush();
      try { assertCurrent(); } catch { reason = "authority_changed"; }
      if (!exit || typeof exit.terminated !== "boolean" || !(exit.code === null || Number.isSafeInteger(exit.code)) || !exit.terminated || reason === "authority_changed") {
        return this.finish(run, { state: "unknown", reason: reason === "authority_changed" ? reason : "execution_outcome_unconfirmed", output, truncated });
      }
      const terminal = reason === "command_timed_out" ? "timed_out" : reason === "command_cancelled" ? "cancelled" : reason ? "failed" : exit.code === 0 ? "completed" : "failed";
      return this.finish(run, { state: terminal, code: exit.code, reason: reason ?? (exit.code === 0 ? null : "command_failed"), output, truncated });
    } finally {
      clearTimeout(timeout); clearInterval(guard); if (hardTimer) clearTimeout(hardTimer);
      parent?.removeEventListener("abort", cancel);
    }
  }
}
