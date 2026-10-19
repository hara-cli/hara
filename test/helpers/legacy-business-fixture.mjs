import fs from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { LocalWorkspaceCatalog } from "../../dist/workspace/local-catalog.js";
import { WorkspaceResourceStorage } from "../../dist/workspace/resource-context.js";
import { WorkspaceResources } from "../../dist/workspace/resources.js";
import { WorkspaceFeatures } from "../../dist/workspace/features.js";
import { WorkspaceLegacyResources, planLegacyResources } from "../../dist/workspace/legacy-resources.js";
import { legacyScheduleRows, legacySchedulesDomain } from "../../dist/workspace/legacy-schedules.js";
import { buildLegacyInheritancePlan } from "../../dist/workspace/legacy-plan.js";
import { canonical } from "../../dist/workspace/local-state.js";
import { openLocalWorkspaceDevRoot } from "../../dist/workspace/local-dev-root.js";
export const hash = value => createHash("sha256").update(canonical(value)).digest("hex");
export async function businessFixture(root, jobs, taskPlan, sourceFingerprint = "c".repeat(64)) {
  openLocalWorkspaceDevRoot(root); // real Host-compatible private root, never ambient user HOME
  const home = join(root, "home"), cwd = join(root, "process-cwd"), isolatedHome = join(root, "process-home"), bin = join(root, "bin");
  for (const path of [home, cwd, isolatedHome, bin]) fs.mkdirSync(path, { mode: 0o700, recursive: true });
  const catalog = new LocalWorkspaceCatalog(home), record = catalog.create("Copy business Workspace", 1); catalog.resolvePersonalWorkspace();
  const storage = new WorkspaceResourceStorage(home, record.scope); storage.initialize(); const resources = new WorkspaceResources(home, record.scope); resources.initialize();
  const main = resources.agents.initializeMain(), features = new WorkspaceFeatures(storage, home, record.scope.workspaceId), folders = new WorkspaceLegacyResources(storage);
  const plan = taskPlan ?? buildLegacyInheritancePlan({ sourceFingerprint, now: 120000, jobs, roles: [], config: {}, profiles: {}, flows: [], sessions: [] }).tasks;
  await folders.domain(sourceFingerprint, planLegacyResources({ jobs, projects: [], legacyWorkspacePath: "/copy/legacy/workspace" })).apply();
  const rows = legacyScheduleRows({ jobs, plan, sourceFingerprint, workspaceId: record.scope.workspaceId, mainAgentId: main.agentId, resources: folders });
  await legacySchedulesDomain(storage, features, sourceFingerprint, rows).apply();
  const grant = review => ({ resourceBinding: review.resourceBinding, definitionHash: review.definitionHash, resourceId: review.resourceId,
    cwd, isolatedHome, searchPath: `${bin}:/usr/bin:/bin`, assertCurrent() {} });
  const review = (id, requestId) => { const row = features.schedules().find(row => row.id === id); return { workspaceId: row.workspaceId, resourceBinding: folders.bindingForHost(),
    requestId, scheduleId: id, definitionHash: hash(row), sourceHash: row.definition.legacy.sourceHash, resourceId: row.definition.legacy.resourceId, originalPath: row.definition.cwd }; };
  return { home, cwd, isolatedHome, bin, catalog, record, storage, resources, features, folders, rows, main, grant, review };
}
