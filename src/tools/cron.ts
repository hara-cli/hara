// cronjob — the model-facing scheduler tool (hermes parity): "remind me every morning at 9" in chat
// just works, no CLI knowledge needed. One action-style tool (add/list/remove/enable/disable/run)
// instead of six. kind:"exec" so creating/removing jobs rides the normal approval gate.
//
// Recursion guard (hermes's rule): a session SPAWNED BY a cron job runs with HARA_CRON=1 and is
// refused here — a scheduled task must never schedule more tasks, or one bad prompt snowballs.
import { registerTool } from "./registry.js";
import { addJob, loadJobs, resolveJob, removeJob, setEnabled } from "../cron/store.js";
import { parseSchedule, describeSchedule, nextRun, validTz } from "../cron/schedule.js";
import { runJobTracked } from "../cron/runner.js";
import { parseDeliver } from "../cron/deliver.js";
import { isInstalled } from "../cron/install.js";
import { sensitiveShellCommandReason } from "../security/sensitive-files.js";
import { homeWorkspaceActionError, isUnsafeProjectWorkspace } from "../context/workspace-scope.js";

const fmt = (ms: number | null): string => (ms ? new Date(ms).toLocaleString() : "—");
const fmtNext = (ms: number | null, now: number): string => (
  ms !== null && ms <= now ? "due now" : fmt(ms)
);
const duration = (ms: number | undefined): string => {
  if (ms === undefined) return "";
  if (ms >= 3_600_000) return ` after ${Math.round(ms / 360_000) / 10}h`;
  if (ms >= 60_000) return ` after ${Math.round(ms / 6_000) / 10}m`;
  if (ms >= 1_000) return ` after ${Math.round(ms / 1_000)}s`;
  return ` after ${ms}ms`;
};

const status = (j: ReturnType<typeof loadJobs>[number]): string => {
  if (j.lastStatus === "running") return `running since ${fmt(j.runningSince ?? j.lastRunAt ?? null)}`;
  if (j.lastStatus === "timed_out") return `timed out${duration(j.lastDurationMs)}`;
  if (j.lastStatus === "error") return `error${duration(j.lastDurationMs)}`;
  if (j.lastStatus === "ok") return `ok${duration(j.lastDurationMs)}`;
  return "—";
};

registerTool({
  name: "cronjob",
  description:
    "Manage the user's scheduled jobs (hara cron). Use when they ask to schedule, automate, or be reminded of " +
    "something on a time basis. action=add needs `schedule` (cron expr \"0 9 * * *\" · \"every 30m\" · \"in 2h\" · ISO time) " +
    "and `task`. Optional: `name`; `mode` — \"print\" (default: run task as a hara prompt), \"org\" (role-routed), or " +
    "\"command\" (run task as a plain SHELL COMMAND — deterministic, no agent, no tokens; prefer it for fixed scripts); " +
    "`tz` (IANA, e.g. Asia/Shanghai, for cron exprs); `deliver` (telegram:<chatId> | feishu:<chatId> | " +
    "weixin:<peerId> | webhook:<url>); `deliverMode` — always (default), on-output (stdout non-empty), or " +
    "on-error (failed runs only); `alertAfter` (1..1000 consecutive failures, default 3). Other actions: " +
    "list · remove · enable · disable · run (fire now), with `id`. " +
    "Jobs fire via the OS scheduler even when hara isn't running.",
  input_schema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["add", "list", "remove", "enable", "disable", "run"] },
      schedule: { type: "string", description: "for add" },
      task: { type: "string", description: "for add — the prompt / org task / shell command" },
      name: { type: "string" },
      mode: { type: "string", enum: ["print", "org", "command"] },
      tz: { type: "string", description: "IANA timezone for cron exprs" },
      deliver: { type: "string", description: "telegram:<chatId> | feishu:<chatId> | weixin:<peerId> | webhook:<url>" },
      deliverMode: { type: "string", enum: ["always", "on-output", "on-error"] },
      alertAfter: { type: "integer", minimum: 1, maximum: 1000, description: "consecutive failures before 🚨 (default 3)" },
      id: { type: "string", description: "job id (or unique prefix) for remove/enable/disable/run" },
    },
    required: ["action"],
  },
  kind: "exec", // scheduling machinery on the user's machine — approval-gated like any exec
  visibility: "deferred",
  classify(input) {
    return input?.action === "list"
      ? { effect: "read", concurrencySafe: true }
      : {
          effect: "exec",
          concurrencySafe: false,
          destructive: input?.action === "remove" || input?.action === "disable",
        };
  },
  async run(input, ctx) {
    if (process.env.HARA_CRON === "1") return "Error: cron-run sessions cannot manage cron jobs (recursion guard — a scheduled task must not schedule more tasks).";
    const action = String(input.action ?? "");
    if (action === "list") {
      let jobs: ReturnType<typeof loadJobs>;
      try { jobs = loadJobs(); } catch (error) { return `Error: ${error instanceof Error ? error.message : String(error)}`; }
      if (!jobs.length) return "No scheduled jobs.";
      return jobs
        .map((j) => {
          const now = Date.now();
          const next = nextRun(j, now);
          return `${j.id} · ${j.enabled ? "on " : "OFF"} · ${j.name} · ${describeSchedule(j.schedule)}${j.tz ? ` @ ${j.tz}` : ""} · mode ${j.mode}${j.deliver ? ` · → ${j.deliver} (${j.deliverMode ?? "always"})` : ""} · next ${fmtNext(next, now)} · last ${status(j)}${j.consecutiveErrors ? ` (${j.consecutiveErrors}✗)` : ""}`;
        })
        .join("\n");
    }
    if (action === "add") {
      // Every new job persists ctx.cwd and later treats it as its implicit agent/shell workspace. Management
      // of existing jobs remains available at Home, but creating a Home-root job would bypass project scope.
      if (isUnsafeProjectWorkspace(ctx.cwd)) return `Error: ${homeWorkspaceActionError("schedule a job")}`;
      const scheduleStr = String(input.schedule ?? "").trim();
      const task = String(input.task ?? "").trim();
      if (!scheduleStr || !task) return "Error: add needs `schedule` and `task`.";
      const sched = parseSchedule(scheduleStr, Date.now());
      if ("error" in sched) return `Error: ${sched.error}`;
      const tz = input.tz ? String(input.tz) : undefined;
      if (tz && !validTz(tz)) return `Error: invalid timezone "${tz}" (IANA name, e.g. Asia/Shanghai).`;
      if (tz && sched.kind !== "cron") return "Error: `tz` only applies to cron expressions.";
      const deliver = input.deliver ? String(input.deliver) : undefined;
      if (deliver) {
        const d = parseDeliver(deliver);
        if ("error" in d) return `Error: ${d.error}`;
      }
      const deliverMode = input.deliverMode === undefined ? undefined : String(input.deliverMode);
      if (deliverMode && !deliver) return "Error: `deliverMode` requires `deliver`.";
      if (deliverMode && !["always", "on-output", "on-error"].includes(deliverMode)) {
        return "Error: `deliverMode` must be always, on-output, or on-error.";
      }
      const alertAfter = input.alertAfter === undefined ? undefined : Number(input.alertAfter);
      if (alertAfter !== undefined && (!Number.isInteger(alertAfter) || alertAfter < 1 || alertAfter > 1_000)) {
        return "Error: `alertAfter` must be an integer from 1 to 1000.";
      }
      const mode = input.mode === "org" || input.mode === "command" ? input.mode : "print";
      if (mode === "command") {
        const denied = sensitiveShellCommandReason(task, ctx.cwd);
        if (denied) return `Error: scheduled shell command crosses Hara's protected secret boundary (${denied}).`;
      }
      let job: ReturnType<typeof addJob>;
      try {
        job = addJob({
          name: input.name ? String(input.name) : task.slice(0, 48),
          schedule: sched,
          task,
          mode,
          cwd: ctx.cwd,
          ...(tz ? { tz } : {}),
          ...(deliver ? { deliver } : {}),
          ...(deliverMode ? { deliverMode: deliverMode as "always" | "on-output" | "on-error" } : {}),
          ...(alertAfter !== undefined ? { alertAfter } : {}),
          createdAt: Date.now(),
        });
      } catch (error) {
        return `Error: ${error instanceof Error ? error.message : String(error)}`;
      }
      const warn = isInstalled() ? "" : "\n⚠ The OS scheduler isn't installed yet — tell the user to run `hara cron install` once, or jobs won't fire.";
      return `✓ scheduled ${job.id} · ${describeSchedule(sched)}${tz ? ` @ ${tz}` : ""} · mode ${mode}${deliver ? ` · → ${deliver} (${deliverMode ?? "always"})` : ""}${alertAfter !== undefined ? ` · alert ≥${alertAfter}` : ""} · next ${fmt(nextRun(job, Date.now()))}${warn}`;
    }
    // id-based actions
    const idArg = String(input.id ?? "").trim();
    if (!idArg) return `Error: ${action} needs \`id\`.`;
    let j: ReturnType<typeof resolveJob>;
    try { j = resolveJob(idArg); } catch (error) { return `Error: ${error instanceof Error ? error.message : String(error)}`; }
    if (j === "ambiguous") return `Error: id "${idArg}" matches multiple jobs — use more characters.`;
    if (!j) return `Error: no job matching "${idArg}".`;
    if (action === "remove") return removeJob(j.id) ? `✓ removed ${j.id} (${j.name})` : "Error: remove failed.";
    if (action === "enable" || action === "disable") {
      setEnabled(j.id, action === "enable");
      return `✓ ${j.id} ${action}d`;
    }
    if (action === "run") {
      const r = await runJobTracked(j, { signal: ctx.signal });
      return r.ok ? `✓ ran ${j.id} — ok\n${(r.output ?? "").trim().slice(-800)}` : `✗ ${j.id} failed: ${r.error}\n${(r.output ?? "").trim().slice(-800)}`;
    }
    return `Error: unknown action "${action}".`;
  },
});
