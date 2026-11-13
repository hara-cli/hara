import { randomUUID } from "node:crypto";
import { isAgentRuntimeId, type AgentRuntimeId } from "../agent-runtime/bindings.js";
import { exact, plain, UUID } from "./local-state.js";
import { VersionedSettings } from "./versioned-settings.js";
import { workspaceStateHome, type WorkspaceResourceStorage } from "./resource-context.js";

export interface WorkspaceOnboardingProgress {
  runId: string; step: 1 | 2 | 3; engineChoice: AgentRuntimeId | null;
  thirdPartySkipped: boolean; dismissed: boolean; completedAt: string | null;
}
interface State extends WorkspaceOnboardingProgress { schemaVersion: 1; revision: number }
const FIELDS = ["runId", "step", "engineChoice", "thirdPartySkipped", "dismissed", "completedAt"];
function progress(raw: unknown): WorkspaceOnboardingProgress {
  if (!plain(raw) || !exact(raw, FIELDS) || typeof raw.runId !== "string" || !UUID.test(raw.runId)
    || ![1, 2, 3].includes(Number(raw.step)) || typeof raw.step !== "number"
    || raw.engineChoice !== null && !isAgentRuntimeId(raw.engineChoice)
    || typeof raw.thirdPartySkipped !== "boolean" || typeof raw.dismissed !== "boolean"
    || !(raw.completedAt === null || typeof raw.completedAt === "string"
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(raw.completedAt) && Number.isFinite(Date.parse(raw.completedAt)))
    || raw.completedAt !== null && raw.step !== 3) throw new Error("Invalid onboarding progress");
  return structuredClone(raw) as unknown as WorkspaceOnboardingProgress;
}
/** Workspace-bound UX metadata only. No runtime probe, batch creation, model or authorization fact. */
export class WorkspaceOnboarding {
  private readonly state: VersionedSettings<State>;
  constructor(storage: WorkspaceResourceStorage) {
    const initialRunId = randomUUID();
    this.state = new VersionedSettings(() => workspaceStateHome(), "workspace-onboarding-v1.json", 1,
      // Missing state belongs to a pre-upgrade or interrupted workspace: never auto-open it.
      () => ({ schemaVersion: 1, revision: 0, runId: initialRunId, step: 1, engineChoice: null,
        thirdPartySkipped: false, dismissed: true, completedAt: null }),
      raw => {
        if (!plain(raw) || !exact(raw, ["schemaVersion", "revision", ...FIELDS]) || raw.schemaVersion !== 1
          || !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 0) throw new Error("Invalid onboarding state");
        const { schemaVersion, revision, ...fields } = raw;
        return { schemaVersion: 1, revision: Number(revision), ...progress(fields) };
      }, {}, storage);
  }
  get() {
    const current = this.state.read();
    if (!current.readOnly && current.value.revision === 0) {
      try { this.state.update(0, old => old); }
      catch (error) { const latest = this.state.read(); if (latest.readOnly || latest.value.revision === 0) throw error; }
    }
    const { value, readOnly, recovered } = this.state.read(); return { ...value, readOnly, recovered };
  }
  /** Called only by the trusted Host immediately after creating a NEW workspace/main colleague.
   * A crash before this marker commits conservatively keeps onboarding dismissed on reopen. */
  initializeNew(dismissed = false): void {
    this.state.update(0, old => ({ ...old, dismissed }));
  }
  set(input: unknown, expectedRevision: number) {
    const next = progress(input);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error("Invalid onboarding revision");
    this.state.update(expectedRevision, old => {
      if (next.runId !== old.runId && (next.step !== 1 || next.completedAt !== null || next.thirdPartySkipped)) throw new Error("A new onboarding run must start at step one");
      if (next.runId === old.runId && old.completedAt !== null && next.completedAt !== old.completedAt) throw new Error("Completed onboarding requires an explicit new run");
      return { ...old, ...next };
    });
    return this.get();
  }
}
