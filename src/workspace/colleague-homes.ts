import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isWorkspaceAgentId } from "./agent-binding.js";
import { captureWorkspaceProjectIdentity, workspaceFileIdMatches, type WorkspaceRunBinding } from "./run-binding.js";
import { exact, plain, positive, UUID, WorkspaceJsonState } from "./local-state.js";
import { sameWorkspaceResourceBinding, type WorkspaceResourceBinding, type WorkspaceResourceStorage } from "./resource-context.js";

type Identity = WorkspaceRunBinding["project"];
interface Activation { sessionId: string; requestId: string }
interface Home { agentId: string; project: Identity; createdAt: string; codexActivations: Activation[] }
interface State { schemaVersion: 1; revision: number; resourceBinding: WorkspaceResourceBinding; legacyProject: Identity | null; homes: Home[] }
const fileId = (value: unknown) => typeof value === "number" ? Number.isSafeInteger(value) && value >= 0
  : typeof value === "string" && /^(?:0|[1-9][0-9]{0,19})$/u.test(value) && BigInt(value) <= 0xffffffffffffffffn;
const identity = (value: unknown, root: string): value is Identity => plain(value) && exact(value, ["root", "dev", "ino"]) && value.root === root && fileId(value.dev) && fileId(value.ino);
export class WorkspacePrimaryDirectoryError extends Error {
  readonly code = "workspace_primary_unavailable";
  constructor() { super("The colleague working folder is unavailable or changed. Reconnect the drive or review the folder before retrying."); }
}
/** Host-owned paths only. No renderer/model path can register a root or become an execution grant. */
export class WorkspaceColleagueHomes {
  private readonly state: WorkspaceJsonState<State>;
  constructor(private readonly storage: WorkspaceResourceStorage, readonly legacyRoot: string) {
    if (basename(legacyRoot) !== storage.scope.workspaceId || basename(dirname(legacyRoot)) !== "project") throw new WorkspacePrimaryDirectoryError();
    this.state = new WorkspaceJsonState(storage, "workspace-colleague-homes-v1.json", raw => {
      if (!plain(raw) || !exact(raw, ["schemaVersion", "revision", "resourceBinding", "legacyProject", "homes"]) || raw.schemaVersion !== 1 || !positive(raw.revision)
        || !sameWorkspaceResourceBinding(raw.resourceBinding as WorkspaceResourceBinding, this.state.binding())
        || !(raw.legacyProject === null || identity(raw.legacyProject, legacyRoot)) || !Array.isArray(raw.homes) || raw.homes.length > 4096
        || new Set(raw.homes.map(row => row?.agentId)).size !== raw.homes.length) throw new WorkspacePrimaryDirectoryError();
      for (const row of raw.homes) {
        if (!plain(row) || !exact(row, ["agentId", "project", "createdAt", "codexActivations"]) || !isWorkspaceAgentId(row.agentId) || !identity(row.project, this.path(row.agentId))
          || typeof row.createdAt !== "string" || !Number.isFinite(Date.parse(row.createdAt)) || !Array.isArray(row.codexActivations)
          || row.codexActivations.length > 1024 || new Set(row.codexActivations.map(item => JSON.stringify([item?.sessionId, item?.requestId]))).size !== row.codexActivations.length
          || row.codexActivations.some(item => !plain(item) || !exact(item, ["sessionId", "requestId"]) || typeof item.sessionId !== "string" || !UUID.test(item.sessionId)
            || typeof item.requestId !== "string" || !UUID.test(item.requestId))) throw new WorkspacePrimaryDirectoryError();
      }
      return structuredClone(raw) as unknown as State;
    }, () => ({ schemaVersion: 1, revision: 0, resourceBinding: this.state.binding(), legacyProject: null, homes: [] }));
  }
  path(agentId: string): string {
    if (!isWorkspaceAgentId(agentId)) throw new WorkspacePrimaryDirectoryError();
    return join(this.legacyRoot, "colleagues", agentId);
  }
  private capture(root: string): Identity {
    try { return captureWorkspaceProjectIdentity(root); } catch { throw new WorkspacePrimaryDirectoryError(); }
  }
  private checked(expected: Identity): void {
    try {
      const info = lstatSync(expected.root, { bigint: true });
      if (!info.isDirectory() || info.isSymbolicLink() || realpathSync.native(expected.root) !== expected.root
        || !workspaceFileIdMatches(expected.dev, info.dev) || !workspaceFileIdMatches(expected.ino, info.ino)) throw new WorkspacePrimaryDirectoryError();
    } catch { throw new WorkspacePrimaryDirectoryError(); }
  }
  /** Existing records never recreate an offline/moved directory and never adopt a replacement inode. */
  ensure(agentId: string): Readonly<Home> {
    return this.storage.run(() => {
      const value = this.state.read();
      if (value.legacyProject) this.checked(value.legacyProject);
      const old = value.homes.find(row => row.agentId === agentId);
      if (old) { this.checked(old.project); return Object.freeze(structuredClone(old)); }
      const root = this.path(agentId), legacyProject = value.legacyProject ?? this.capture(this.legacyRoot), parent = join(this.legacyRoot, "colleagues");
      this.checked(legacyProject);
      try { mkdirSync(parent, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new WorkspacePrimaryDirectoryError(); }
      const namespace = this.capture(parent); this.checked(namespace);
      // An unregistered existing folder may contain unique user data or an interrupted operation: hold.
      try { mkdirSync(root, { mode: 0o700 }); } catch { throw new WorkspacePrimaryDirectoryError(); }
      const project = this.capture(root), record: Home = { agentId, project, createdAt: new Date().toISOString(), codexActivations: [] };
      this.checked(legacyProject); this.checked(namespace); this.checked(project);
      this.state.update(value.revision, current => ({ ...current, legacyProject, homes: [...current.homes, record] }));
      return Object.freeze(structuredClone(record));
    });
  }
  /** A write-ahead choice activates only when the matching native reset has also committed. */
  activateCodexSession(agentId: string, sessionId: string, requestId: string): void {
    if (!UUID.test(sessionId) || !UUID.test(requestId)) throw new WorkspacePrimaryDirectoryError();
    this.ensure(agentId);
    const value = this.state.read(), row = value.homes.find(item => item.agentId === agentId)!;
    if (row.codexActivations.some(item => item.sessionId === sessionId && item.requestId === requestId)) return;
    if (row.codexActivations.length >= 1024) throw new WorkspacePrimaryDirectoryError();
    this.state.update(value.revision, current => ({ ...current, homes: current.homes.map(item => item.agentId === agentId ? { ...item,
      codexActivations: [...item.codexActivations, { sessionId, requestId }] } : item) }));
  }
  codexHomeActivated(agentId: string, sessionId: string, committedResets: readonly { requestId: string }[]): boolean {
    const value = this.state.read(), row = value.homes.find(item => item.agentId === agentId);
    return Boolean(row?.codexActivations.some(activation => activation.sessionId === sessionId && committedResets.some(item => item.requestId === activation.requestId)));
  }
  view(agentId: string) {
    const value = this.state.read(), row = value.homes.find(item => item.agentId === agentId);
    let available = false;
    if (row) { try { if (value.legacyProject) this.checked(value.legacyProject); this.checked(row.project); available = true; } catch { /* Metadata reports unavailable; never creates a fallback. */ } }
    return { path: this.path(agentId), legacyPath: this.legacyRoot, created: Boolean(row), available, memoryScope: "private" as const };
  }
}
