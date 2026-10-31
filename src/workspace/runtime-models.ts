import { WorkspaceJsonState, exact, plain } from "./local-state.js";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runExternalCommandCapture, runJsonlRpcSequence } from "../external-sessions/process.js";
import { HARA_RUNTIME_VERSION } from "../version.js";
import { sameWorkspaceResourceBinding, type WorkspaceResourceBinding, type WorkspaceResourceStorage } from "./resource-context.js";
import { optionalRuntimeId, type OptionalRuntimeId, type WorkspaceRuntimeInstaller } from "./runtime-install.js";

export interface RuntimeModel { id: string; label: string; description?: string; recommended?: boolean }
interface ModelSelection { runtimeId: OptionalRuntimeId; revision: number; selectedModelId: string | null }
interface RuntimeModelsState { resourceBinding: WorkspaceResourceBinding; revision: number; selections: ModelSelection[] }

// These runtimes have no stable, non-interactive model inventory yet.
const CATALOG: Partial<Record<OptionalRuntimeId, readonly RuntimeModel[]>> = {
  claude: [{ id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", recommended: true }, { id: "claude-opus-4-1", label: "Claude Opus 4.1" }],
  agy: [{ id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", recommended: true }],
};
function codexModels(parsed: unknown, field: "models" | "data"): RuntimeModel[] {
  if (!plain(parsed) || !Array.isArray(parsed[field])) throw new Error("codex model inventory is invalid");
  const visible = parsed[field].filter((value: unknown) => !plain(value) || (field === "models"
    ? value.visibility === undefined || value.visibility === "list"
    : value.hidden !== true));
  const models = visible.map((value: unknown) => {
    if (!plain(value)) throw new Error("codex model inventory is invalid");
    const id = field === "models" ? value.slug : value.id;
    const label = field === "models" ? value.display_name : value.displayName;
    if (!validModelId(id) || typeof label !== "string" || !label.trim()) throw new Error("codex model inventory is invalid");
    return { id, label, ...(typeof value.description === "string" ? { description: value.description } : {}),
      ...(value.isDefault === true ? { recommended: true } : {}) };
  });
  if (new Set(models.map(model => model.id)).size !== models.length) throw new Error("codex model inventory has duplicate IDs");
  return models;
}
async function liveModels(runtimeId: "codex" | "opencode", runtimes: WorkspaceRuntimeInstaller): Promise<RuntimeModel[]> {
  const { command, env } = runtimes.resolveBound(runtimeId);
  if (runtimeId === "codex") {
    try {
      const result = await runJsonlRpcSequence<unknown>({ command, env, timeoutMs: 15000, maxOutputBytes: 4 * 1024 * 1024,
        requests: [{ id: 1, method: "initialize", params: { clientInfo: { name: "hara", title: "Hara", version: HARA_RUNTIME_VERSION },
          capabilities: { experimentalApi: false, requestAttestation: false, optOutNotificationMethods: [] } } },
          { method: "initialized" }, { id: 2, method: "model/list", params: {} }], resultId: 2 });
      return codexModels(result, "data");
    } catch { /* The bound binary may lack app-server model/list. Try its debug inventory. */ }
  }
  const result = await runExternalCommandCapture({ command, env: { ...env, NO_COLOR: "1", OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_MODELS_FETCH: "true" } }, runtimeId === "codex" ? ["debug", "models"] : ["models"],
  { cwd: env.HOME, timeoutMs: 15000, maxOutputBytes: 4 * 1024 * 1024 });
  if (!result.ok) {
    if (runtimeId === "codex") return cachedCodexModels(env);
    throw new Error(`${runtimeId} model inventory failed`);
  }
  const { stdout } = result;
  let models: RuntimeModel[];
  if (runtimeId === "codex") {
    let parsed: unknown;
    try { parsed = JSON.parse(stdout); } catch { return cachedCodexModels(env); }
    try { return codexModels(parsed, "models"); } catch { return cachedCodexModels(env); }
  } else {
    models = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(id => {
      if (!validModelId(id)) throw new Error("opencode model inventory is invalid");
      return { id, label: id };
    });
  }
  if (new Set(models.map(model => model.id)).size !== models.length) throw new Error(`${runtimeId} model inventory has duplicate IDs`);
  return models;
}
function cachedCodexModels(env: NodeJS.ProcessEnv): RuntimeModel[] {
  try {
    const path = join(env.CODEX_HOME ?? join(env.HOME!, ".codex"), "models_cache.json");
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw new Error("unsafe cache");
    return codexModels(JSON.parse(readFileSync(path, "utf8")), "models");
  } catch { throw new Error("codex model inventory failed"); }
}
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
          || !validModelId(row.selectedModelId)) throw new Error("Runtime model state is damaged");
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
  selected(runtimeId: OptionalRuntimeId): string | null {
    this.bound(runtimeId);
    return this.state.read().selections.find(row => row.runtimeId === runtimeId)?.selectedModelId ?? null;
  }
  async list(runtimeId: unknown) {
    this.bound(runtimeId);
    const row = this.state.read().selections.find(row => row.runtimeId === runtimeId);
    const models = runtimeId === "codex" || runtimeId === "opencode" ? await liveModels(runtimeId, this.runtimes) : CATALOG[runtimeId]!.map(model => ({ ...model }));
    return { runtimeId, revision: row?.revision ?? 0, selectedModelId: row?.selectedModelId ?? null,
      models };
  }
  async select(runtimeId: unknown, modelId: unknown, expectedRevision: unknown): Promise<void> {
    this.bound(runtimeId);
    if (!validModelId(modelId)) throw new Error("Invalid runtime modelId");
    const models = runtimeId === "codex" || runtimeId === "opencode" ? await liveModels(runtimeId, this.runtimes) : CATALOG[runtimeId]!;
    if (!models.some(model => model.id === modelId)) throw new Error("Invalid runtime modelId");
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
