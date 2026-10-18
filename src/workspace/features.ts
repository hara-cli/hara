import { createHash } from "node:crypto";
import { readFileSync, copyFileSync, constants, lstatSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, join } from "node:path";
import { tmpdir } from "node:os";
import { WorkspaceJsonState, plain, text } from "./local-state.js";
import { sameWorkspaceResourceBinding, workspaceStateHome, type WorkspaceResourceBinding, type WorkspaceResourceStorage } from "./resource-context.js";
import { WorkspaceSkillLibrary, forkWorkspaceSkill, validateWorkspaceSkill, type WorkspaceSkillBundle } from "./skills.js";
import { parseCron, type Schedule } from "../cron/schedule.js";
import { redactSensitiveText } from "../security/secrets.js";

interface WorkspaceSchedule { id: string; name: string; schedule: Schedule; enabled: boolean; workspaceId: string; migrationId: string; source: string; definition: Record<string, unknown> }
interface FeatureState { resourceBinding: WorkspaceResourceBinding; revision: number; schedules: WorkspaceSchedule[]; disabledSkills: string[]; skills: WorkspaceSkillBundle[] }
const safe = (value: string) => redactSensitiveText(value).text;
function validSchedule(value: any): value is Schedule {
  return plain(value) && (value.kind === "cron" && typeof value.expr === "string" && Boolean(parseCron(value.expr))
    || value.kind === "every" && Number.isSafeInteger(value.everyMs) && Number(value.everyMs) > 0 && typeof value.display === "string"
    || value.kind === "once" && typeof value.runAt === "number" && Number.isFinite(value.runAt) && typeof value.display === "string");
}
export class WorkspaceFeatures {
  private readonly state: WorkspaceJsonState<FeatureState>;
  private readonly library: WorkspaceSkillLibrary;
  constructor(private readonly storage: WorkspaceResourceStorage, private readonly project: string, private readonly workspaceId: string, libraryHome?: string) {
    this.library = new WorkspaceSkillLibrary(libraryHome ?? storage.run(() => workspaceStateHome()));
    this.state = new WorkspaceJsonState(storage, "workspace-features-v1.json", raw => {
      if (!plain(raw) || !sameWorkspaceResourceBinding(raw.resourceBinding as WorkspaceResourceBinding, this.state.binding()) || !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 1
        || !Array.isArray(raw.schedules) || raw.schedules.length > 4096 || !Array.isArray(raw.disabledSkills) || raw.disabledSkills.some(id => !text(id))) throw new Error("Invalid workspace feature settings");
      for (const item of raw.schedules) if (!plain(item) || item.workspaceId !== workspaceId || !text(item.id) || !text(item.name, 256) || !validSchedule(item.schedule)
        || typeof item.enabled !== "boolean" || typeof item.migrationId !== "string" || typeof item.source !== "string" || !plain(item.definition)) throw new Error("Invalid scoped schedule");
      const skills = raw.skills === undefined ? [] : Array.isArray(raw.skills) && raw.skills.length <= 128 ? raw.skills.map(validateWorkspaceSkill) : null;
      if (!skills || new Set(skills.map(row => row.id)).size !== skills.length) throw new Error("Invalid skill locks");
      return { ...structuredClone(raw), skills } as unknown as FeatureState;
    }, () => ({ resourceBinding: this.state.binding(), revision: 0, schedules: [], disabledSkills: [], skills: [] }));
  }
  list() {
    const value = this.state.read();
    const candidates = this.library.candidates(this.project), skills = new Map(candidates.map(row => [row.id, row]));
    for (const row of value.skills) skills.set(row.id, row);
    return { revision: value.revision, workspaceId: this.workspaceId,
      schedules: value.schedules.map(({ definition: _task, ...row }) => ({ ...row, name: safe(row.name) })),
      skills: [...skills.values()].map(row => ({ id: row.id, description: row.description, enabled: row.enabled, version: row.version, source: row.source,
        locked: value.skills.some(pin => pin.id === row.id), availableVersion: candidates.find(candidate => candidate.id === row.id)?.version ?? row.version })) };
  }
  setScheduleEnabled(id: string, enabled: boolean, expected: number) {
    this.state.update(expected, current => { const row = current.schedules.find(row => row.id === id); if (!row) throw new Error("Scoped schedule unavailable"); row.enabled = enabled; return current; });
  }
  setSkillEnabled(id: string, enabled: boolean, expected: number, version?: string) {
    const state = this.state.read(), pinned = state.skills.find(row => row.id === id), candidate = this.library.candidates(this.project).find(row => row.id === id);
    const selected = version !== undefined ? [pinned, candidate].find(row => row?.version === version) : pinned ?? candidate;
    if (!selected || state.revision !== expected) throw new Error("Scoped skill version unavailable; refresh before changing");
    if (enabled) this.library.preserve(selected);
    this.state.update(expected, current => ({ ...current, skills: [...current.skills.filter(row => row.id !== id), { ...selected, enabled }] }));
  }
  enabledSkills() { return this.state.read().skills.filter(row => row.enabled); }
  assertSkill(id: string, version: string) { if (!this.enabledSkills().some(row => row.id === id && row.version === version)) throw new Error("Workspace skill lock changed"); }
  skillContent(id: string) { const row = this.state.read().skills.find(row => row.id === id); if (!row) throw new Error("Pinned skill unavailable"); return { id, version: row.version, content: row.files["SKILL.md"] }; }
  forkSkill(id: string, content: unknown, expected: number) {
    if (typeof content !== "string" || content.length > 64000) throw new Error("Invalid private skill instructions");
    this.state.update(expected, current => { const row = current.skills.find(row => row.id === id); if (!row) throw new Error("Pinned skill unavailable");
      return { ...current, skills: current.skills.map(value => value.id === id ? forkWorkspaceSkill(row, content) : value) }; });
  }
  /** Offline migration only, deliberately not exposed to RPC/startup or a scheduler. */
  importLegacy(rows: WorkspaceSchedule[]) {
    const state = this.state.read(), fresh = rows.filter(row => row.workspaceId === this.workspaceId && !state.schedules.some(old => old.migrationId === row.migrationId));
    if (fresh.length) this.state.update(state.revision, current => ({ ...current, schedules: [...current.schedules, ...fresh] }));
    return fresh.length;
  }
}
export function planLegacySchedules(raw: unknown, personalWorkspaceId: string, source: string): { state: string; jobs: WorkspaceSchedule[] } {
  const rows = Array.isArray(raw) ? raw : plain(raw) && Array.isArray(raw.jobs) ? raw.jobs : null;
  if (!text(personalWorkspaceId) || !rows || rows.length > 4096) return { state: "invalid_source", jobs: [] };
  const jobs: WorkspaceSchedule[] = [];
  for (const row of rows) {
    if (!plain(row) || !text(row.id) || !text(row.name, 256) || !validSchedule(row.schedule) || typeof row.enabled !== "boolean") return { state: "invalid_source", jobs: [] };
    if (redactSensitiveText(JSON.stringify(row)).redactions.length) return { state: "requires_secret_cleanup", jobs: [] };
    const workspaceId = text(row.workspaceId) ? row.workspaceId : text(row.workspace) ? row.workspace : personalWorkspaceId;
    jobs.push({ id: row.id, name: row.name, schedule: structuredClone(row.schedule), enabled: row.enabled, workspaceId, source,
      migrationId: createHash("sha256").update(`${source}\0${row.id}`).digest("hex"), definition: structuredClone(row) });
  }
  return { state: "planned", jobs };
}
/** This slice permits fixture execution only. Real cutover still needs Jeff's separate approval. */
export function migrateLegacyScheduleFixture(input: { fixtureRoot: string; source: string; personalWorkspaceId: string; targets: Map<string, WorkspaceFeatures> }) {
  const root = realpathSync(input.fixtureRoot), path = realpathSync(input.source);
  const systemTemp = realpathSync(tmpdir());
  if (!isAbsolute(input.fixtureRoot) || !root.startsWith("/private/tmp/") && !root.startsWith(`${systemTemp}/`) || relative(root, path).startsWith("..") || lstatSync(input.source).isSymbolicLink()
    || process.platform !== "win32" && (lstatSync(root).mode & 0o077) !== 0) throw new Error("Only an explicitly owned fixture may run this migration");
  let plan; try { plan = planLegacySchedules(JSON.parse(readFileSync(path, "utf8")), input.personalWorkspaceId, path); } catch { return { state: "invalid_source", imported: 0 }; }
  if (plan.state !== "planned") return { state: plan.state, imported: 0 };
  if (plan.jobs.some(row => !input.targets.has(row.workspaceId))) return { state: "unmapped_workspace", imported: 0 };
  const backup = `${path}.before-workspace-migration`;
  try { copyFileSync(path, backup, constants.COPYFILE_EXCL); } catch (error: any) {
    if (error.code !== "EEXIST") throw error;
    if (lstatSync(backup).isSymbolicLink() || !readFileSync(backup).equals(readFileSync(path))) return { state: "source_changed_since_backup", imported: 0 };
  }
  let imported = 0;
  for (const target of input.targets.values()) imported += target.importLegacy(plan.jobs);
  const receipt = { state: "completed", imported, source: path, backup, jobs: plan.jobs.map(row => ({ id: row.id, workspaceId: row.workspaceId, migrationId: row.migrationId })) };
  writeFileSync(join(root, "schedule-migration-receipt.json"), JSON.stringify(receipt) + "\n", { mode: 0o600 }); return receipt;
}
