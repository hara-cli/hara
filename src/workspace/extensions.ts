// Catalog/authorization only. This module cannot connect, spawn, install or invoke an upstream MCP.
import { isWorkspaceAgentId } from "./agent-binding.js";
import { VersionedSettings } from "./versioned-settings.js";
import { canonical, exact, plain } from "./local-state.js";
import { currentWorkspaceResourceBinding, sameWorkspaceResourceBinding, workspaceStateHome,
  type WorkspaceResourceBinding, type WorkspaceResourceStorage } from "./resource-context.js";
import { extensionDigest, validateExtensionCatalog, type ExtensionSourceDescriptor } from "./extension-catalog.js";

interface SourceBinding { descriptor: ExtensionSourceDescriptor; catalogLock: string; enabled: boolean; allowedTools: string[] }
interface Assignment { sourceId: string; catalogLock: string; agentId: string; agentEpoch: number; enabled: boolean; allowedTools: string[] }
interface ExtensionState { schemaVersion: 1; revision: number; resourceBinding: WorkspaceResourceBinding; sources: SourceBinding[]; assignments: Assignment[] }
export type ExtensionChange = { sourceId: string; sourceRevision: string; enabled: boolean; allowedTools: string[] } &
  ({ target: "workspace" } | { target: "agent"; agentId: string; agentEpoch: number });
export interface ExtensionToolSnapshot {
  readonly workspaceId: string; readonly resourceGeneration: string; readonly revision: number;
  readonly agentId: string; readonly agentEpoch: number;
  readonly tools: readonly Readonly<{ sourceId: string; toolId: string; sourceRevision: string; catalogLock: string; name: string; description: string }>[];
}
const snapshots = new WeakMap<object, WorkspaceExtensions>();
const unique = (values: readonly string[]) => new Set(values).size === values.length;
function tools(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 64 || !value.every(item => typeof item === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/u.test(item)) || !unique(value)) throw new Error("Invalid explicit extension tool allowlist");
  return [...value].sort();
}
const epoch = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
/** Separate versioned domain: old feature/settings documents are never migrated or rewritten. */
export class WorkspaceExtensions {
  private readonly state: VersionedSettings<ExtensionState>;
  private catalog: ExtensionSourceDescriptor[] = [];
  private catalogAvailable = true;
  constructor(private readonly storage: WorkspaceResourceStorage, catalog: readonly ExtensionSourceDescriptor[] = []) {
    this.refreshCatalog(catalog);
    const binding = () => storage.run(() => ({ ...currentWorkspaceResourceBinding()! }));
    this.state = new VersionedSettings(() => storage.run(() => workspaceStateHome()), "workspace-extensions-v1.json", 1,
      () => ({ schemaVersion: 1, revision: 0, resourceBinding: binding(), sources: [], assignments: [] }), raw => {
        if (!plain(raw) || !exact(raw, ["schemaVersion", "revision", "resourceBinding", "sources", "assignments"])
          || raw.schemaVersion !== 1 || !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 0
          || !sameWorkspaceResourceBinding(raw.resourceBinding as WorkspaceResourceBinding, binding())
          || !Array.isArray(raw.sources) || raw.sources.length > 256 || !Array.isArray(raw.assignments) || raw.assignments.length > 2048) throw new Error("Invalid extension settings");
        const sources: SourceBinding[] = raw.sources.map(row => {
          if (!plain(row) || !exact(row, ["descriptor", "catalogLock", "enabled", "allowedTools"]) || typeof row.enabled !== "boolean") throw new Error("Invalid extension source binding");
          const descriptor = validateExtensionCatalog([row.descriptor as ExtensionSourceDescriptor])[0]!;
          const allowedTools = tools(row.allowedTools), catalogLock = extensionDigest(descriptor);
          if (row.catalogLock !== catalogLock || !allowedTools.every(id => descriptor.tools.some(tool => tool.toolId === id))) throw new Error("Invalid extension source lock");
          return { descriptor, catalogLock, enabled: row.enabled, allowedTools };
        });
        const assignments: Assignment[] = raw.assignments.map(row => {
          if (!plain(row) || !exact(row, ["sourceId", "catalogLock", "agentId", "agentEpoch", "enabled", "allowedTools"])
            || !isWorkspaceAgentId(row.agentId) || !epoch(row.agentEpoch)
            || typeof row.sourceId !== "string" || typeof row.enabled !== "boolean" || typeof row.catalogLock !== "string"
            || !/^[a-f0-9]{64}$/u.test(row.catalogLock) || !sources.some(source => source.descriptor.sourceId === row.sourceId)) throw new Error("Invalid extension assignment");
          return { sourceId: row.sourceId, catalogLock: row.catalogLock, agentId: row.agentId, agentEpoch: row.agentEpoch,
            enabled: row.enabled, allowedTools: tools(row.allowedTools) };
        });
        if (!unique(sources.map(row => row.descriptor.sourceId)) || !unique(assignments.map(row => `${row.agentId}:${row.sourceId}`))) throw new Error("Duplicate extension binding");
        const result: ExtensionState = { schemaVersion: 1, revision: Number(raw.revision), resourceBinding: binding(), sources, assignments };
        if (Buffer.byteLength(canonical(result)) > 2 * 1024 * 1024) throw new Error("Extension settings exceed storage limit");
        return result;
      }, {}, storage);
  }
  refreshCatalog(catalog: readonly ExtensionSourceDescriptor[]): void { this.catalogAvailable = false; this.catalog = validateExtensionCatalog(catalog); this.catalogAvailable = true; }
  invalidateCatalog(): void { this.catalogAvailable = false; }
  private identity() { return { workspaceId: this.storage.scope.workspaceId, resourceGeneration: this.storage.run(() => currentWorkspaceResourceBinding()!.generation) }; }
  list(agent?: { agentId: string; agentEpoch: number }) {
    if (agent && !epoch(agent.agentEpoch)) throw new Error("Invalid extension agent epoch");
    const { value, readOnly } = this.state.read();
    const sources = new Map(value.sources.map(row => [row.descriptor.sourceId, row.descriptor]));
    if (this.catalogAvailable) for (const source of this.catalog) sources.set(source.sourceId, source);
    return { ...this.identity(), revision: value.revision, readOnly: readOnly || !this.catalogAvailable,
      ...(agent ? { agentId: agent.agentId, agentEpoch: agent.agentEpoch } : {}), sources: [...sources.values()].map(descriptor => {
        const source = value.sources.find(row => row.descriptor.sourceId === descriptor.sourceId);
        const current = this.catalogAvailable ? this.catalog.find(row => row.sourceId === descriptor.sourceId) : undefined;
        const catalogLock = extensionDigest(descriptor), stale = !!source && source.catalogLock !== catalogLock;
        const assignment = agent ? value.assignments.find(row => row.sourceId === descriptor.sourceId && row.agentId === agent.agentId) : undefined;
        const workspaceEnabled = !!current && !stale && !!source?.enabled && !readOnly;
        const assigned = !!assignment?.enabled && assignment.agentEpoch === agent?.agentEpoch && assignment.catalogLock === catalogLock;
        const allowedTools = source && !stale ? source.allowedTools : [];
        return { ...descriptor, status: !current ? "unavailable" as const : stale ? "needs-review" as const : descriptor.tools.length ? "ready" as const : "unreviewed" as const,
          enabled: source?.enabled ?? false, workspaceEnabled, allowedTools,
          assignedAgentCount: value.assignments.filter(row => row.sourceId === descriptor.sourceId && row.enabled && row.catalogLock === catalogLock).length,
          ...(agent ? { assignmentEnabled: assigned, assignedTools: assignment?.catalogLock === catalogLock && assignment.agentEpoch === agent.agentEpoch ? assignment.allowedTools : [],
            effectiveTools: assigned && workspaceEnabled ? assignment!.allowedTools.filter(id => allowedTools.includes(id)) : [] } : {}) };
      }) };
  }
  describe(sourceId: string) { const view = this.list(), source = view.sources.find(row => row.sourceId === sourceId); if (!source) throw new Error("Extension source unavailable"); return { ...view, sources: [source] }; }
  validateChange(input: unknown, expectedRevision: number): ExtensionChange {
    if (!plain(input) || !["workspace", "agent"].includes(String(input.target))
      || !exact(input, ["target", "sourceId", "sourceRevision", "enabled", "allowedTools", ...(input.target === "agent" ? ["agentId", "agentEpoch"] : [])])
      || typeof input.sourceId !== "string" || typeof input.sourceRevision !== "string" || typeof input.enabled !== "boolean"
      || input.target === "agent" && (!isWorkspaceAgentId(input.agentId) || !epoch(input.agentEpoch))) throw new Error("Invalid extension change");
    const view = this.list();
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || view.revision !== expectedRevision) throw new Error("Extension settings changed; refresh before writing");
    if (view.readOnly) throw new Error("Extension settings are read-only");
    const source = view.sources.find(row => row.sourceId === input.sourceId), allowedTools = tools(input.allowedTools);
    if (!source || source.sourceRevision !== input.sourceRevision) throw new Error("Extension catalog changed; review again");
    if (input.enabled && source.status === "unavailable" || !allowedTools.every(id => source?.tools.some(tool => tool.toolId === id))) throw new Error("Extension tool catalog unavailable");
    if (input.target === "agent" && input.enabled && (!source.workspaceEnabled || !allowedTools.every(id => source.allowedTools.includes(id)))) throw new Error("Enable and allow tools in this Workspace first");
    return { ...input, allowedTools } as ExtensionChange;
  }
  apply(input: unknown, expectedRevision: number) {
    const change = this.validateChange(input, expectedRevision), descriptor = this.list().sources.find(row => row.sourceId === change.sourceId)!;
    const safeDescriptor = validateExtensionCatalog([descriptor])[0]!, catalogLock = extensionDigest(safeDescriptor);
    this.state.update(expectedRevision, current => {
      if (change.target === "workspace") {
        current.sources = [...current.sources.filter(row => row.descriptor.sourceId !== change.sourceId), { descriptor: safeDescriptor, catalogLock, enabled: change.enabled, allowedTools: change.allowedTools }];
      } else {
        if (!current.sources.some(row => row.descriptor.sourceId === change.sourceId)) throw new Error("Workspace extension is not configured");
        current.assignments = [...current.assignments.filter(row => !(row.agentId === change.agentId && row.sourceId === change.sourceId)),
          { sourceId: change.sourceId, catalogLock, agentId: change.agentId, agentEpoch: change.agentEpoch, enabled: change.enabled, allowedTools: change.allowedTools }];
      }
      return current;
    });
    return this.list(change.target === "agent" ? change : undefined);
  }
  /** Frozen metadata seam for registered-cli-mcp and Pi. No Tool.run or upstream executor exists here. */
  snapshot(agentId: string, agentEpoch: number): ExtensionToolSnapshot {
    const view = this.list({ agentId, agentEpoch });
    const snapshot: ExtensionToolSnapshot = Object.freeze({ workspaceId: view.workspaceId, resourceGeneration: view.resourceGeneration,
      revision: view.revision, agentId, agentEpoch, tools: Object.freeze(view.sources.flatMap(source => (source.effectiveTools ?? []).map(toolId => {
        const tool = source.tools.find(row => row.toolId === toolId)!;
        return Object.freeze({ sourceId: source.sourceId, toolId, sourceRevision: source.sourceRevision, catalogLock: extensionDigest(validateExtensionCatalog([source])[0]!), name: tool.name, description: tool.description });
      }))) });
    snapshots.set(snapshot, this); return snapshot;
  }
  /** Must be called again at dispatch, even if an old native tool list still shows this tool. */
  assertCurrentTool(snapshot: ExtensionToolSnapshot, sourceId: string, toolId: string, agentEpoch: number): void {
    if (snapshots.get(snapshot) !== this || snapshot.agentEpoch !== agentEpoch) throw new Error("Extension snapshot unavailable");
    const current = this.snapshot(snapshot.agentId, agentEpoch);
    if (current.revision !== snapshot.revision || current.resourceGeneration !== snapshot.resourceGeneration
      || !snapshot.tools.some(row => row.sourceId === sourceId && row.toolId === toolId)
      || !current.tools.some(row => row.sourceId === sourceId && row.toolId === toolId
        && snapshot.tools.some(old => canonical(old) === canonical(row)))) throw new Error("Extension authorization changed; start a new attempt");
  }
}
