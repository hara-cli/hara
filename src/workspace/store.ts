import { isAbsolute } from "node:path";
import {
  bindPrivateHaraStateFile,
  readPrivateStateFileSnapshotSync,
  withPrivateStateLockSync,
  writePrivateStateFileSync,
  type PrivateStateFileSnapshot,
} from "../security/private-state.js";
import {
  bootstrapWorkspaceRegistry,
  parseWorkspaceRegistry,
  type LegacyWorkspaceConnection,
  type WorkspaceRegistry,
} from "./registry.js";

const FILENAME = "workspaces.json";
const MAX_BYTES = 1024 * 1024;

/** Owner-only local metadata, NOT a cloud membership/authorization service. Explicit home prevents a
 * test/embedder from silently initializing the operator's home. No constructor read or automatic migration.
 * Existing profile/config/session stores are never written by this class. */
export class WorkspaceRegistryStore {
  constructor(private readonly home: string) {
    if (typeof home !== "string" || !isAbsolute(home)) throw new Error("Workspace registry requires an explicit absolute home");
  }

  private readSnapshot(): { value: WorkspaceRegistry; snapshot: PrivateStateFileSnapshot } | null {
    const binding = bindPrivateHaraStateFile(this.home, [], FILENAME);
    const snapshot = readPrivateStateFileSnapshotSync(binding.path, MAX_BYTES);
    if (!snapshot) return null;
    let raw: unknown;
    try { raw = JSON.parse(snapshot.text); } catch {
      throw new Error("Workspace registry is not valid JSON; refusing to replace it");
    }
    return { value: parseWorkspaceRegistry(raw), snapshot };
  }

  read(): WorkspaceRegistry | null {
    return this.readSnapshot()?.value ?? null;
  }

  initialize(legacy: readonly LegacyWorkspaceConnection[], activeProfileId: string | null): WorkspaceRegistry {
    return withPrivateStateLockSync(this.home, [], "workspace-registry", () => {
      const current = this.readSnapshot();
      if (current) return current.value;
      const next = bootstrapWorkspaceRegistry(legacy, activeProfileId);
      const binding = bindPrivateHaraStateFile(this.home, [], FILENAME);
      this.persist(binding, next, { expectedMissing: true });
      return next;
    });
  }

  /** Revision check + per-resource interprocess lock + filesystem CAS. Stale dialogs cannot overwrite
   * another change. Mutation functions must be synchronous and are not exposed directly as RPC handlers. */
  update(expectedRevision: number, mutate: (registry: WorkspaceRegistry) => WorkspaceRegistry): WorkspaceRegistry {
    return withPrivateStateLockSync(this.home, [], "workspace-registry", () => {
      const current = this.readSnapshot();
      if (!current || current.value.revision !== expectedRevision) throw new Error("Workspace registry changed; reload before editing");
      const next = parseWorkspaceRegistry(mutate(structuredClone(current.value)));
      if (next.revision !== expectedRevision + 1) throw new Error("Workspace update must advance exactly one revision");
      const binding = bindPrivateHaraStateFile(this.home, [], FILENAME);
      this.persist(binding, next, { expectedText: current.snapshot.text });
      return next;
    });
  }

  private persist(
    binding: ReturnType<typeof bindPrivateHaraStateFile>,
    registry: WorkspaceRegistry,
    guard: { expectedMissing?: boolean; expectedText?: string },
  ): void {
    const text = JSON.stringify(registry, null, 2) + "\n";
    if (Buffer.byteLength(text, "utf8") > MAX_BYTES) throw new Error("Workspace registry is too large; no state was replaced");
    writePrivateStateFileSync(binding, text, guard);
  }
}
