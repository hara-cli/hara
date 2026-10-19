import { WorkspaceJsonState, plain, canonical } from "./local-state.js";
import { sameWorkspaceResourceBinding, type WorkspaceResourceBinding, type WorkspaceResourceStorage } from "./resource-context.js";
import { validateWorkspaceSkill, type WorkspaceSkillBundle } from "./skills.js";
import { LegacyOwnerFileDomain } from "./legacy-file-domain.js";

interface State { revision: number; resourceBinding: WorkspaceResourceBinding; sourceFingerprint: string; skills: WorkspaceSkillBundle[] }
/** Separate immutable inherited defaults: user toggles/forks still go to workspace-features-v1.
 * Keeping domains in separate files avoids cross-domain rollback mistaking our later schedule writes
 * for user edits. Global source material never confers shell/tool/credential rights. */
export class WorkspaceInheritedSkills {
  private readonly state: WorkspaceJsonState<State>;
  constructor(private readonly storage: WorkspaceResourceStorage) {
    this.state = new WorkspaceJsonState<State>(storage, "workspace-legacy-skills-v1.json", raw => {
      if (!plain(raw) || !sameWorkspaceResourceBinding(raw.resourceBinding as WorkspaceResourceBinding, this.state.binding()) || !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 1
        || typeof raw.sourceFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(raw.sourceFingerprint) || !Array.isArray(raw.skills) || raw.skills.length > 128) throw new Error("Invalid inherited skill index");
      const skills = raw.skills.map(validateWorkspaceSkill); if (new Set(skills.map(row => row.id)).size !== skills.length) throw new Error("Duplicate inherited skill identities");
      return { ...raw, skills } as unknown as State;
    }, () => ({ revision: 0, resourceBinding: this.state.binding(), sourceFingerprint: "", skills: [] }));
  }
  list() { return this.state.read().skills; }
  domain(sourceFingerprint: string, bundles: readonly WorkspaceSkillBundle[]) {
    if (!/^[a-f0-9]{64}$/.test(sourceFingerprint) || bundles.length > 128) throw new Error("Invalid inherited skill source");
    const skills = bundles.map(validateWorkspaceSkill); if (new Set(skills.map(row => row.id)).size !== skills.length) throw new Error("Duplicate inherited skill identities");
    return new LegacyOwnerFileDomain(this.storage, "skills", sourceFingerprint, [".hara/workspace-legacy-skills-v1.json"], skills.length, () => {
      const before = this.state.read(); if (before.revision) { if (before.sourceFingerprint !== sourceFingerprint || canonical(before.skills) !== canonical(skills)) throw new Error("Inherited skill source changed; locked versions preserved"); return; }
      this.state.update(0, old => ({ ...old, sourceFingerprint, skills }));
    });
  }
}
