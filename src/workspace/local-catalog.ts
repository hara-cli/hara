import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { realpathSync } from "node:fs";
import {
  bindPrivateHaraStateFile, readPrivateStateFileSnapshotSync, withPrivateStateLockSync, writePrivateStateFileSync,
} from "../security/private-state.js";
import { parseWorkspaceResourceScope, type WorkspaceResourceScope } from "./resource-context.js";
import { exact, plain, positive, text, UUID } from "./local-state.js";
import { isWorkspaceId } from "./registry.js";

export interface LocalWorkspaceRecord {
  scope: WorkspaceResourceScope;
  label: string;
  actorId: string;
  policyRevision: number;
  grantId: string;
  grantRevision: number;
  active: boolean;
}
export interface LocalWorkspaceCatalogState {
  schemaVersion: 2;
  revision: number;
  localAuthorityId: string;
  hostId: string;
  hostEpoch: number;
  activeWorkspaceId: string | null;
  workspaces: LocalWorkspaceRecord[];
}
const fields = ["schemaVersion", "revision", "localAuthorityId", "hostId", "hostEpoch", "activeWorkspaceId", "workspaces"];
function parse(value: unknown): LocalWorkspaceCatalogState {
  const fail = (): never => { throw new Error("invalid local Workspace catalog; existing state was preserved"); };
  if (!plain(value) || !exact(value, fields) || value.schemaVersion !== 2 || !positive(value.revision)
    || typeof value.localAuthorityId !== "string" || !UUID.test(value.localAuthorityId)
    || !text(value.hostId) || !positive(value.hostEpoch) || !Array.isArray(value.workspaces) || value.workspaces.length > 128) return fail();
  const seen = new Set<string>();
  for (const row of value.workspaces) {
    if (!plain(row) || !exact(row, ["scope", "label", "actorId", "policyRevision", "grantId", "grantRevision", "active"])
      || !text(row.label, 80) || !text(row.actorId) || !text(row.grantId) || !positive(row.policyRevision)
      || !positive(row.grantRevision) || typeof row.active !== "boolean") return fail();
    const scope = parseWorkspaceResourceScope(row.scope);
    if (scope.authority.kind !== "local" || scope.authority.localAuthorityId !== value.localAuthorityId || seen.has(scope.workspaceId)) return fail();
    seen.add(scope.workspaceId);
  }
  if (value.activeWorkspaceId !== null && (!isWorkspaceId(value.activeWorkspaceId)
    || !value.workspaces.some(row => row.scope.workspaceId === value.activeWorkspaceId && row.active))) return fail();
  return structuredClone(value) as unknown as LocalWorkspaceCatalogState;
}

/** Local owner registration for the opt-in Dev host; no Account/profile import or global home access. */
export class LocalWorkspaceCatalog {
  readonly home: string;
  private readonly registration: Pick<LocalWorkspaceCatalogState, "localAuthorityId" | "hostId">;
  constructor(home: string) {
    if (!isAbsolute(home)) throw new Error("local Workspace requires an explicit absolute private host home");
    this.home = realpathSync.native(home);
    const initial = withPrivateStateLockSync(this.home, ["workspace-local-dev"], "catalog", () => {
      const file = this.file(), snapshot = readPrivateStateFileSnapshotSync(file.path, 128 * 1024);
      if (snapshot) return this.decode(snapshot.text);
      const state: LocalWorkspaceCatalogState = { schemaVersion: 2, revision: 1, localAuthorityId: randomUUID(),
        hostId: `host_${randomUUID()}`, hostEpoch: 1, activeWorkspaceId: null, workspaces: [] };
      writePrivateStateFileSync(file, JSON.stringify(state) + "\n", { expectedMissing: true });
      return state;
    });
    this.registration = { localAuthorityId: initial.localAuthorityId, hostId: initial.hostId };
  }
  private file() { return bindPrivateHaraStateFile(this.home, ["workspace-local-dev"], "catalog-v2.json"); }
  private decode(body: string) { try { return parse(JSON.parse(body)); } catch { throw new Error("invalid local Workspace catalog; existing state was preserved"); } }
  read(): LocalWorkspaceCatalogState {
    const file = this.file(), snapshot = readPrivateStateFileSnapshotSync(file.path, 128 * 1024);
    if (!snapshot) throw new Error("local Workspace registration disappeared; no identity was recreated");
    const state = this.decode(snapshot.text);
    if (state.localAuthorityId !== this.registration.localAuthorityId || state.hostId !== this.registration.hostId) throw new Error("local Workspace registration changed");
    return state;
  }
  private update(expectedRevision: number, mutate: (state: LocalWorkspaceCatalogState) => void): LocalWorkspaceCatalogState {
    if (!positive(expectedRevision)) throw new Error("invalid local Workspace revision");
    return withPrivateStateLockSync(this.home, ["workspace-local-dev"], "catalog", () => {
      const file = this.file(), snapshot = readPrivateStateFileSnapshotSync(file.path, 128 * 1024), state = this.read();
      if (!snapshot || state.revision !== expectedRevision || state.revision >= Number.MAX_SAFE_INTEGER) throw new Error("local Workspace catalog changed; refresh");
      mutate(state); state.revision++;
      const next = parse(state);
      // The private writer temporarily claims the target during publication. Re-reading that same
      // path in its commit callback would mistake its own claim for revocation. The exact snapshot
      // CAS and directory-identity checks belong to the writer; registration was checked above.
      writePrivateStateFileSync(file, JSON.stringify(next) + "\n", { expectedText: snapshot.text });
      return next;
    });
  }
  create(label: string, expectedRevision: number): LocalWorkspaceRecord {
    if (!text(label, 80)) throw new Error("invalid Workspace label");
    const workspaceId = `ws_${randomUUID()}`;
    const next = this.update(expectedRevision, state => {
      state.workspaces.push({ scope: { schemaVersion: 1, workspaceId, authority: { kind: "local", localAuthorityId: state.localAuthorityId } },
        label, actorId: `owner_${randomUUID()}`, policyRevision: 1, grantId: `grant_${randomUUID()}`, grantRevision: 1, active: true });
      state.activeWorkspaceId ??= workspaceId;
    });
    return next.workspaces.find(row => row.scope.workspaceId === workspaceId)!;
  }
  select(workspaceId: string, expectedRevision: number): void {
    this.update(expectedRevision, state => {
      if (!state.workspaces.some(row => row.scope.workspaceId === workspaceId && row.active)) throw new Error("Workspace unavailable");
      state.activeWorkspaceId = workspaceId;
    });
  }
  /** Host-owner operation, not an Agent tool or model-call option. Does not change foreground selection authority. */
  revoke(workspaceId: string, expectedRevision: number): void {
    this.update(expectedRevision, state => {
      const row = state.workspaces.find(row => row.scope.workspaceId === workspaceId && row.active);
      if (!row || row.grantRevision >= Number.MAX_SAFE_INTEGER) throw new Error("Workspace grant unavailable");
      row.active = false; row.grantRevision++;
      if (state.activeWorkspaceId === workspaceId) state.activeWorkspaceId = null;
    });
  }
  resolve(workspaceId: string): LocalWorkspaceRecord {
    const row = this.read().workspaces.find(row => row.scope.workspaceId === workspaceId && row.active);
    if (!row) throw new Error("Workspace is unavailable or revoked");
    return row;
  }
}
