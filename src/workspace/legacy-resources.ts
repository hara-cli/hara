import { createHash } from "node:crypto";
import { basename, isAbsolute, resolve } from "node:path";
import { redactSensitiveText } from "../security/secrets.js";
import { canonical, exact, plain, WorkspaceJsonState } from "./local-state.js";
import { sameWorkspaceResourceBinding, type WorkspaceResourceBinding, type WorkspaceResourceStorage } from "./resource-context.js";
import { LegacyOwnerFileDomain } from "./legacy-file-domain.js";

type Purpose = "workspace-files" | "project" | "schedule-cwd";
export interface LegacyResourceRecord { id: string; pathHash: string; originalPath: string; label: string; purposes: Purpose[]; access: "catalog_only" }
interface State { revision: number; resourceBinding: WorkspaceResourceBinding; sourceFingerprint: string; resources: LegacyResourceRecord[] }
const hash = (value: string) => createHash("sha256").update(value).digest("hex"), purposes = ["workspace-files", "project", "schedule-cwd"];
/** Register exact old folder identities without scanning them or treating owns/cwd as a new file,
 * shell or credential grant. Actual execution must supply a separately fenced resource mount. */
export function planLegacyResources(input: { jobs: unknown; projects: unknown; legacyWorkspacePath: string }): LegacyResourceRecord[] {
  const jobs = Array.isArray(input.jobs) ? input.jobs : plain(input.jobs) ? input.jobs.jobs : null;
  const projects = Array.isArray(input.projects) ? input.projects : plain(input.projects) ? input.projects.projects : null;
  if (!Array.isArray(jobs) || jobs.length > 4096 || !Array.isArray(projects) || projects.length > 256) throw new Error("Invalid legacy resource source");
  const rows = new Map<string, Set<Purpose>>();
  const add = (path: unknown, purpose: Purpose) => {
    if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path || path === "/" || path.length > 4096 || /[\u0000-\u001f\u007f]/.test(path) || redactSensitiveText(path).redactions.length) throw new Error("Legacy folder requires explicit path review");
    const found = rows.get(path) ?? new Set<Purpose>(); found.add(purpose); rows.set(path, found);
  };
  add(input.legacyWorkspacePath, "workspace-files");
  for (const row of jobs) { if (!plain(row)) throw new Error("Invalid legacy task resource"); add(row.cwd, "schedule-cwd"); }
  for (const row of projects) { if (!plain(row)) throw new Error("Invalid legacy project resource"); add(row.path, "project"); }
  return [...rows].sort(([a], [b]) => a.localeCompare(b)).map(([originalPath, kinds]) => ({ id: "lr_" + hash(originalPath), pathHash: hash(originalPath), originalPath,
    label: basename(originalPath), purposes: [...kinds].sort(), access: "catalog_only" }));
}
function checked(row: unknown): LegacyResourceRecord {
  if (!plain(row) || !exact(row, ["id", "pathHash", "originalPath", "label", "purposes", "access"]) || typeof row.originalPath !== "string"
    || !isAbsolute(row.originalPath) || resolve(row.originalPath) !== row.originalPath || row.originalPath === "/" || row.originalPath.length > 4096 || /[\u0000-\u001f\u007f]/.test(row.originalPath) || row.pathHash !== hash(row.originalPath) || row.id !== "lr_" + row.pathHash
    || row.label !== basename(row.originalPath) || row.access !== "catalog_only" || !Array.isArray(row.purposes) || !row.purposes.length || row.purposes.length > 3 || new Set(row.purposes).size !== row.purposes.length || row.purposes.some(value => !purposes.includes(String(value)))
    || redactSensitiveText(row.originalPath).redactions.length) throw new Error("Invalid inherited resource identity");
  return structuredClone(row) as unknown as LegacyResourceRecord;
}
export class WorkspaceLegacyResources {
  private readonly state: WorkspaceJsonState<State>;
  constructor(private readonly storage: WorkspaceResourceStorage) {
    this.state = new WorkspaceJsonState<State>(storage, "workspace-legacy-resources-v1.json", raw => {
      if (!plain(raw) || !sameWorkspaceResourceBinding(raw.resourceBinding as WorkspaceResourceBinding, this.state.binding()) || !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 1
        || typeof raw.sourceFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(raw.sourceFingerprint) || !Array.isArray(raw.resources) || raw.resources.length > 4353) throw new Error("Invalid legacy resources index");
      const resources = raw.resources.map(checked); if (new Set(resources.map(row => row.id)).size !== resources.length) throw new Error("Duplicate resource identity");
      return { ...raw, resources } as unknown as State;
    }, () => ({ revision: 0, resourceBinding: this.state.binding(), sourceFingerprint: "", resources: [] }));
  }
  list() { return this.state.read().resources.map(({ originalPath: _path, ...row }) => row); }
  /** Host-only lookup is metadata, not a runnable mount or a renderer-selected filesystem path. */
  sourceForHost(id: string) { const row = this.state.read().resources.find(row => row.id === id); if (!row) throw new Error("Resource not registered in this Workspace"); return row; }
  domain(sourceFingerprint: string, rows: readonly LegacyResourceRecord[]) {
    if (!/^[a-f0-9]{64}$/.test(sourceFingerprint) || rows.length > 4353) throw new Error("Invalid resource import source");
    const resources = rows.map(checked); if (new Set(resources.map(row => row.id)).size !== resources.length) throw new Error("Duplicate resource identity");
    return new LegacyOwnerFileDomain(this.storage, "resources", sourceFingerprint, [".hara/workspace-legacy-resources-v1.json"], resources.length, () => {
      const before = this.state.read(); if (before.revision) { if (before.sourceFingerprint !== sourceFingerprint || canonical(before.resources) !== canonical(resources)) throw new Error("Legacy resources source changed; existing records preserved"); return; }
      this.state.update(0, old => ({ ...old, sourceFingerprint, resources }));
    });
  }
}
