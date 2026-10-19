// Read-only planning. A DTO is evidence of classification, never an execution/Keychain grant.
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { parseRoleFrontmatter } from "../org/roles.js";
import { scanMemory } from "../memory/guard.js";
import { redactSensitiveText } from "../security/secrets.js";
import { nextRun, validTz } from "../cron/schedule.js";
import { validWorkspaceSchedule } from "./features.js";
import { canonical, plain } from "./local-state.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export interface LegacyPlanInput {
  sourceFingerprint: string; now: number; jobs: unknown;
  roles: { file: string; content: string }[];
  sessions: { meta: Record<string, unknown> }[]; flows: unknown; config: unknown; profiles: unknown;
}
export interface LegacyTaskPlan {
  id: string; name: string; definitionHash: string; taskHash: string; mode: string;
  schedule: unknown; timezone: string; timezoneDefaulted: boolean; originalEnabled: boolean; importEnabled: boolean;
  expiredOnce: boolean; cwdRef: string; haraCli: boolean; externalTargetHints: number; structuredDeliver: boolean;
  alertAfter: number | null; consecutiveErrors: number; relatedRoles: string[];
  classification: "needs_adapters" | "safe_disabled" | "rejected"; reasons: string[]; nextRunAt: number | null;
  definitionValidation: "pass" | "reject"; execution: "not_run"; idempotency: "not_run"; rollback: "not_run";
}
export interface LegacyRolePlan {
  username: string; displayName: string; sourceHash: string; instructionsHash: string; instructionsBytes: number;
  policyHash: string; allowToolsCount: number; ownsCount: number; runtime: "pi";
  state: "active" | "archived"; rank: number; enabledTaskRefs: number; taskRefs: string[]; flowRefs: number; lastUsed: number;
  validation: "pass" | "reject"; reasons: string[]; imported: false; taskExecution: "not_run"; restart: "not_run";
}
const bounded = (value: unknown, size = 256): value is string => typeof value === "string" && value.length > 0 && value.length <= size && !/[\u0000-\u001f\u007f]/.test(value);
function credentialValues(...inputs: unknown[]): string[] {
  const found = new Set<string>(); let nodes = 0;
  const walk = (value: unknown, depth: number) => {
    if (++nodes > 10000 || depth > 10) throw new Error("Legacy settings exceed planning bounds");
    if (Array.isArray(value)) { for (const row of value) walk(row, depth + 1); }
    else if (plain(value)) for (const [key, field] of Object.entries(value)) {
      if (/(?:api.?key|secret|password|token|credential)/i.test(key) && typeof field === "string" && field.length >= 4) found.add(field);
      else if (field && typeof field === "object") walk(field, depth + 1);
    }
  };
  for (const input of inputs) walk(input, 0);
  return [...found].sort((a, b) => b.length - a.length);
}
/** Safe labels are independent from the private prompt/command. Known copied credentials are scrubbed
 * even when they don't look like provider keys; output never contains command bodies or destinations. */
export function buildLegacyInheritancePlan(input: LegacyPlanInput) {
  if (!/^[a-f0-9]{64}$/.test(input.sourceFingerprint) || !Number.isFinite(input.now) || input.roles.length > 256 || input.sessions.length > 10000) throw new Error("Invalid legacy planning envelope");
  const needles = credentialValues(input.config, input.profiles);
  const safe = (value: unknown, cap = 80) => {
    let result = typeof value === "string" ? value : "";
    for (const needle of needles) result = result.split(needle).join("[REDACTED]");
    return redactSensitiveText(result).text.replace(/[\u0000-\u001f\u007f|]/g, " ").slice(0, cap);
  };
  const rawJobs = Array.isArray(input.jobs) ? input.jobs : plain(input.jobs) && Array.isArray(input.jobs.jobs) ? input.jobs.jobs : null;
  if (!rawJobs || rawJobs.length > 4096 || rawJobs.some(row => !plain(row))) throw new Error("Invalid legacy task source; no partial plan produced");
  const ids = new Set<string>();
  for (const row of rawJobs) { if (!bounded(row.id) || ids.has(row.id) || safe(row.id, 256) !== row.id) throw new Error("Invalid or duplicate legacy task identity"); ids.add(row.id); }
  const flowRows = Array.isArray(input.flows) ? input.flows : plain(input.flows) && Array.isArray(input.flows.rules) ? input.flows.rules : [];
  const flowTexts = flowRows.filter(plain).map(row => [row.name, row.do, row.guard].filter(value => typeof value === "string").join("\n"));
  const roles = input.roles.map(source => {
    if (!/^[a-zA-Z0-9_-]+\.md$/.test(source.file) || Buffer.byteLength(source.content) > 512 * 1024) throw new Error("Invalid legacy role source");
    const { fm, body } = parseRoleFrontmatter(source.content);
    const username = String(fm.name || source.file.slice(0, -3)), label = String(fm.displayName || fm["display-name"] || fm["public-name"] || fm["chinese-name"] || username);
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(username) || ["main", "hara"].includes(username) || safe(username) !== username) throw new Error("Invalid or reserved legacy role identity");
    const matches = (text: string) => {
      const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(^|[^a-zA-Z0-9_-])(?:global:)?${escaped}($|[^a-zA-Z0-9_-])`, "i").test(text)
        || label !== username && label.length >= 2 && text.includes(label);
    };
    const linked = rawJobs.filter(row => matches([row.name, row.task].filter(value => typeof value === "string").join("\n")));
    const lastUsed = input.sessions.filter(row => row.meta.agentRef === `global:${username}` || row.meta.agentRef === username)
      .map(row => typeof row.meta.updatedAt === "string" ? Date.parse(row.meta.updatedAt) : 0).filter(Number.isFinite).sort((a, b) => b - a)[0] ?? 0;
    const policy = { allowTools: fm.allowTools ?? null, denyTools: fm.denyTools ?? null, readOnly: fm.readOnly ?? null, owns: fm.owns ?? [] };
    const reasons: string[] = [];
    if (!scanMemory(body).ok || redactSensitiveText(source.content).redactions.length || needles.some(value => source.content.includes(value))) reasons.push("unsafe_role_source");
    if (body.length > 32000) reasons.push("instructions_exceed_v1_limit");
    for (const key of ["allowTools", "denyTools", "owns"]) if (fm[key] !== undefined && (!Array.isArray(fm[key]) || fm[key].some((value: unknown) => !bounded(value, 256)))) reasons.push("unsupported_policy_shape");
    return { username, displayName: safe(label), sourceHash: hash(source.content), instructionsHash: hash(body), instructionsBytes: Buffer.byteLength(body),
      policyHash: hash(canonical(policy)), allowToolsCount: Array.isArray(fm.allowTools) ? fm.allowTools.length : 0, ownsCount: Array.isArray(fm.owns) ? fm.owns.length : 0,
      runtime: "pi" as const, state: "archived" as "active" | "archived", rank: 0,
      enabledTaskRefs: linked.filter(row => row.enabled === true).length, taskRefs: linked.map(row => row.id as string), flowRefs: flowTexts.filter(matches).length, lastUsed,
      validation: reasons.length ? "reject" as const : "pass" as const, reasons, imported: false as const, taskExecution: "not_run" as const, restart: "not_run" as const };
  });
  if (new Set(roles.map(row => row.username)).size !== roles.length) throw new Error("Duplicate legacy roles; no target selected");
  const ranked = [...roles].sort((a, b) => Number(b.enabledTaskRefs + b.flowRefs > 0) - Number(a.enabledTaskRefs + a.flowRefs > 0)
    || b.lastUsed - a.lastUsed || b.enabledTaskRefs + b.flowRefs - a.enabledTaskRefs - a.flowRefs || a.username.localeCompare(b.username));
  let online = 0;
  ranked.forEach((row, index) => { row.rank = index + 1; if (row.validation === "pass" && online < 10) { row.state = "active"; online++; } });
  const roots = [...new Set(rawJobs.map(row => typeof row.cwd === "string" ? row.cwd : ""))].sort();
  const tasks: LegacyTaskPlan[] = rawJobs.map(row => {
    const reasons: string[] = [], task = typeof row.task === "string" ? row.task : "", mode = typeof row.mode === "string" ? row.mode : "print";
    const timezoneDefaulted = row.tz === undefined || row.tz === "", timezone = timezoneDefaulted ? "Asia/Shanghai" : String(row.tz);
    const expiredOnce = plain(row.schedule) && row.schedule.kind === "once" && typeof row.schedule.runAt === "number" && row.schedule.runAt < input.now;
    if (!validWorkspaceSchedule(row.schedule)) reasons.push("invalid_schedule");
    if (!validTz(timezone)) reasons.push("invalid_timezone");
    if (!bounded(row.name, 256) || !bounded(row.cwd, 4096) || !isAbsolute(row.cwd as string) || typeof row.enabled !== "boolean" || !task || task.length > 128000) reasons.push("invalid_definition");
    if (!["print", "command", "org"].includes(mode)) reasons.push("unsupported_mode");
    if (needles.some(value => task.includes(value))) reasons.push("embedded_credential_requires_extraction");
    else if (redactSensitiveText(task).redactions.length) reasons.push("credential_syntax_requires_review");
    const rejected = reasons.length > 0;
    const enabled = row.enabled === true && !expiredOnce, cli = mode === "command" && /(?:^|[\s/"'])hara(?:[\s"']|$)/.test(task);
    const related = roles.filter(role => role.taskRefs.includes(row.id as string)).map(role => role.username);
    if (!rejected) {
      reasons.push("cwd_resource_mapping_pending");
      if (mode === "command") reasons.push("command_adapter_pending", "scoped_environment_pending");
      if (mode === "org" || cli) reasons.push("hara_cli_compatibility_pending");
      if (mode === "print") reasons.push("pi_binding_and_model_connection_pending");
      if (row.deliver) reasons.push("durable_delivery_adapter_pending");
      if (row.alertAfter || row.consecutiveErrors) reasons.push("alert_state_adapter_pending");
      if (expiredOnce) reasons.push("expired_once_disabled");
      if (enabled) reasons.push("cutover_and_24h_observation_pending");
    }
    let nextRunAt: number | null = null;
    if (!rejected && enabled) nextRunAt = nextRun({ schedule: row.schedule as any, createdAt: typeof row.createdAt === "number" ? row.createdAt : input.now,
      tz: timezone, ...(typeof row.lastRunAt === "number" ? { lastRunAt: row.lastRunAt } : {}) }, input.now, { deadlineMs: Date.now() + 40 });
    const schedule = validWorkspaceSchedule(row.schedule) ? row.schedule.kind === "cron" ? { kind: "cron", expr: row.schedule.expr }
      : row.schedule.kind === "once" ? { kind: "once", runAt: row.schedule.runAt } : { kind: "every", everyMs: row.schedule.everyMs } : null;
    return { id: row.id as string, name: safe(row.name, 128), definitionHash: hash(canonical(row)), taskHash: hash(task), mode: ["print", "command", "org"].includes(mode) ? mode : "unknown",
      schedule, timezone: safe(timezone), timezoneDefaulted, originalEnabled: row.enabled === true, importEnabled: enabled,
      expiredOnce, cwdRef: `R${String(roots.indexOf(typeof row.cwd === "string" ? row.cwd : "") + 1).padStart(2, "0")}`, haraCli: cli,
      externalTargetHints: new Set(task.match(/(?:feishu|telegram|weixin|webhook):[^\s"'`<>]+/g) ?? []).size, structuredDeliver: Boolean(row.deliver),
      alertAfter: Number.isSafeInteger(row.alertAfter) ? Number(row.alertAfter) : null, consecutiveErrors: Number.isSafeInteger(row.consecutiveErrors) ? Number(row.consecutiveErrors) : 0,
      relatedRoles: related, classification: rejected ? "rejected" : !enabled ? "safe_disabled" : "needs_adapters", reasons, nextRunAt,
      definitionValidation: rejected ? "reject" : "pass", execution: "not_run", idempotency: "not_run", rollback: "not_run" };
  });
  const plan = { schemaVersion: 1, kind: "read_only_dry_run", sourceFingerprint: input.sourceFingerprint, at: input.now,
    tasks, roles, resources: roots.map((path, index) => ({ ref: `R${String(index + 1).padStart(2, "0")}`, pathHash: hash(path), mapped: false })),
    summary: { tasks: tasks.length, commands: tasks.filter(row => row.mode === "command").length, print: tasks.filter(row => row.mode === "print").length,
      enabledBefore: tasks.filter(row => row.originalEnabled).length, enabledAfter: tasks.filter(row => row.importEnabled).length,
      rejected: tasks.filter(row => row.classification === "rejected").length, timezoneDefaulted: tasks.filter(row => row.timezoneDefaulted).length,
      expiredOnce: tasks.filter(row => row.expiredOnce).length, roles: roles.length, active: roles.filter(row => row.state === "active").length, archived: roles.filter(row => row.state === "archived").length,
      modelCalls: 0, scriptsExecuted: 0, messagesSent: 0, keychainAccesses: 0, liveServicesChanged: 0 } };
  const serialized = JSON.stringify(plan);
  if (needles.some(value => serialized.includes(value))) throw new Error("Legacy output failed secret boundary; nothing published");
  return plan;
}
