// cronjob — the model-facing scheduler tool (hermes parity): "remind me every morning at 9" in chat
// just works, no CLI knowledge needed. One action-style tool (add/list/remove/enable/disable/run)
// instead of six. kind:"exec" so creating/removing jobs rides the normal approval gate.
//
// Recursion guard (hermes's rule): a session SPAWNED BY a cron job runs with HARA_CRON=1 and is
// refused here — a scheduled task must never schedule more tasks, or one bad prompt snowballs.
import { registerTool } from "./registry.js";
import { addJob, loadJobs, resolveJob, removeJob, setEnabled } from "../cron/store.js";
import { parseSchedule, describeSchedule, nextRun, validTz } from "../cron/schedule.js";
import { runJobOnce } from "../cron/runner.js";
import { parseDeliver } from "../cron/deliver.js";
import { isInstalled } from "../cron/install.js";
import { sensitiveShellCommandReason } from "../security/sensitive-files.js";

const fmt = (ms: number | null): string => (ms ? new Date(ms).toLocaleString() : "—");

registerTool({
  name: "cronjob",
  description:
    "Manage the user's scheduled jobs (hara cron). Use when they ask to schedule, automate, or be reminded of " +
    "something on a time basis. action=add needs `schedule` (cron expr \"0 9 * * *\" · \"every 30m\" · \"in 2h\" · ISO time) " +
    "and `task`. Optional: `name`; `mode` — \"print\" (default: run task as a hara prompt), \"org\" (role-routed), or " +
    "\"command\" (run task as a plain SHELL COMMAND — deterministic, no agent, no tokens; prefer it for fixed scripts); " +
    "`tz` (IANA, e.g. Asia/Shanghai, for cron exprs); `deliver` (push each run's result: telegram:<chatId> | " +
    "feishu:<chatId> | webhook:<url>). Other actions: list · remove · enable · disable · run (fire now), with `id`. " +
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
      deliver: { type: "string", description: "telegram:<chatId> | feishu:<chatId> | webhook:<url>" },
      id: { type: "string", description: "job id (or unique prefix) for remove/enable/disable/run" },
    },
    required: ["action"],
  },
  kind: "exec", // scheduling machinery on the user's machine — approval-gated like any exec
  async run(input, ctx) {
    if (process.env.HARA_CRON === "1") return "Error: cron-run sessions cannot manage cron jobs (recursion guard — a scheduled task must not schedule more tasks).";
    const action = String(input.action ?? "");
    if (action === "list") {
      const jobs = loadJobs();
      if (!jobs.length) return "No scheduled jobs.";
      return jobs
        .map((j) => {
          const next = nextRun(j, Date.now());
          return `${j.id} · ${j.enabled ? "on " : "OFF"} · ${j.name} · ${describeSchedule(j.schedule)}${j.tz ? ` @ ${j.tz}` : ""} · mode ${j.mode}${j.deliver ? ` · → ${j.deliver}` : ""} · next ${fmt(next)} · last ${j.lastStatus ?? "—"}${j.consecutiveErrors ? ` (${j.consecutiveErrors}✗)` : ""}`;
        })
        .join("\n");
    }
    if (action === "add") {
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
      const mode = input.mode === "org" || input.mode === "command" ? input.mode : "print";
      if (mode === "command") {
        const denied = sensitiveShellCommandReason(task, ctx.cwd);
        if (denied) return `Error: scheduled shell command crosses Hara's protected secret boundary (${denied}).`;
      }
      const job = addJob({
        name: input.name ? String(input.name) : task.slice(0, 48),
        schedule: sched,
        task,
        mode,
        cwd: ctx.cwd,
        ...(tz ? { tz } : {}),
        ...(deliver ? { deliver } : {}),
        createdAt: Date.now(),
      });
      const warn = isInstalled() ? "" : "\n⚠ The OS scheduler isn't installed yet — tell the user to run `hara cron install` once, or jobs won't fire.";
      return `✓ scheduled ${job.id} · ${describeSchedule(sched)}${tz ? ` @ ${tz}` : ""} · mode ${mode}${deliver ? ` · → ${deliver}` : ""} · next ${fmt(nextRun(job, Date.now()))}${warn}`;
    }
    // id-based actions
    const idArg = String(input.id ?? "").trim();
    if (!idArg) return `Error: ${action} needs \`id\`.`;
    const j = resolveJob(idArg);
    if (j === "ambiguous") return `Error: id "${idArg}" matches multiple jobs — use more characters.`;
    if (!j) return `Error: no job matching "${idArg}".`;
    if (action === "remove") return removeJob(j.id) ? `✓ removed ${j.id} (${j.name})` : "Error: remove failed.";
    if (action === "enable" || action === "disable") {
      setEnabled(j.id, action === "enable");
      return `✓ ${j.id} ${action}d`;
    }
    if (action === "run") {
      const r = await runJobOnce(j);
      return r.ok ? `✓ ran ${j.id} — ok\n${(r.output ?? "").trim().slice(-800)}` : `✗ ${j.id} failed: ${r.error}\n${(r.output ?? "").trim().slice(-800)}`;
    }
    return `Error: unknown action "${action}".`;
  },
});
