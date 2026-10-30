import { WorkspaceJsonState, exact, plain } from "./local-state.js";
import { sameWorkspaceResourceBinding, type WorkspaceResourceBinding, type WorkspaceResourceStorage } from "./resource-context.js";
import { optionalRuntimeId, type OptionalRuntimeId, type WorkspaceRuntimeInstaller } from "./runtime-install.js";

export interface RuntimeModel { id: string; label: string; description?: string; recommended?: boolean }
interface ModelSelection { runtimeId: OptionalRuntimeId; revision: number; selectedModelId: string | null }
interface RuntimeModelsState { resourceBinding: WorkspaceResourceBinding; revision: number; selections: ModelSelection[] }

// A bounded Core-owned catalog. It is deliberately independent of workspace connections.
const CATALOG: Record<OptionalRuntimeId, readonly RuntimeModel[]> = {
  codex: [{ id: "o3", label: "o3" }, { id: "o4-mini", label: "o4-mini" }, { id: "gpt-5", label: "GPT-5", recommended: true }],
  claude: [{ id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", recommended: true }, { id: "claude-opus-4-1", label: "Claude Opus 4.1" }],
  opencode: [{ id: "openai/gpt-5", label: "GPT-5" }, { id: "anthropic/claude-sonnet-4-5", label: "Claude Sonnet 4.5" }],
  agy: [{ id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", recommended: true }],
};
const validModelId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(value)
  && !value.includes("..") && !value.includes("//") && !value.endsWith("/");

/** Workspace-scoped model preference, separate from all connection and coding settings state. */
export class WorkspaceRuntimeModels {
  private readonly state: WorkspaceJsonState<RuntimeModelsState>;
  constructor(storage: WorkspaceResourceStorage, private readonly runtimes: WorkspaceRuntimeInstaller) {
    this.state = new WorkspaceJsonState(storage, "runtime-models-v1.json", value => {
      if (!plain(value) || !exact(value, ["resourceBinding", "revision", "selections"])
        || !sameWorkspaceResourceBinding(value.resourceBinding as WorkspaceResourceBinding, this.state.binding())
        || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1
        || !Array.isArray(value.selections) || value.selections.length > 4) throw new Error("Runtime model state is damaged");
      const seen = new Set<string>();
      for (const row of value.selections) {
        if (!plain(row) || !exact(row, ["runtimeId", "revision", "selectedModelId"])
          || !optionalRuntimeId(row.runtimeId) || seen.has(row.runtimeId)
          || !Number.isSafeInteger(row.revision) || Number(row.revision) < 1
          || !validModelId(row.selectedModelId) || !CATALOG[row.runtimeId].some(model => model.id === row.selectedModelId)) throw new Error("Runtime model state is damaged");
        seen.add(row.runtimeId);
      }
      return structuredClone(value) as unknown as RuntimeModelsState;
    }, () => ({ resourceBinding: this.state.binding(), revision: 0, selections: [] }));
  }
  private bound(runtimeId: unknown): asserts runtimeId is OptionalRuntimeId {
    if (!optionalRuntimeId(runtimeId)) throw new Error("Invalid runtimeId");
    const option = this.runtimes.list().options.find(row => row.runtimeId === runtimeId);
    if (!option?.registered || (option.state !== "local_registered" && option.state !== "registered"))
      throw new Error("Runtime not bound in this workspace");
  }
  list(runtimeId: unknown) {
    this.bound(runtimeId);
    const row = this.state.read().selections.find(row => row.runtimeId === runtimeId);
    return { runtimeId, revision: row?.revision ?? 0, selectedModelId: row?.selectedModelId ?? null,
      models: CATALOG[runtimeId].map(model => ({ ...model })) };
  }
  select(runtimeId: unknown, modelId: unknown, expectedRevision: unknown): void {
    this.bound(runtimeId);
    if (!validModelId(modelId) || !CATALOG[runtimeId].some(model => model.id === modelId)) throw new Error("Invalid runtime modelId");
    if (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 0) throw new Error("Invalid runtime model revision");
    const current = this.state.read();
    if ((current.selections.find(row => row.runtimeId === runtimeId)?.revision ?? 0) !== expectedRevision)
      throw new Error("Runtime model revision changed; refresh before selecting");
    this.state.update(current.revision, value => {
      // Recheck under the state lock so a concurrent selection cannot overwrite this runtime.
      if ((value.selections.find(row => row.runtimeId === runtimeId)?.revision ?? 0) !== expectedRevision)
        throw new Error("Runtime model revision changed; refresh before selecting");
      this.bound(runtimeId);
      return { ...value, selections: [...value.selections.filter(row => row.runtimeId !== runtimeId),
        { runtimeId, revision: Number(expectedRevision) + 1, selectedModelId: modelId }] };
    });
  }
}
