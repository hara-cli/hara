import { WorkspaceJsonState, exact, plain } from "./local-state.js";
import { join } from "node:path";
import { ExternalJsonlRpcRequestError, runExternalCommandCapture, runJsonlRpcSequence } from "../external-sessions/process.js";
import { withPrivateStateLockSync, writePrivateStateFileSync } from "../security/private-state.js";
import { HARA_RUNTIME_VERSION } from "../version.js";
import { inspectWorkspaceResourceFile, sameWorkspaceResourceBinding, workspaceStateHome,
  type WorkspaceResourceBinding, type WorkspaceResourceStorage } from "./resource-context.js";
import { optionalRuntimeId, type OptionalRuntimeId, type WorkspaceRuntimeInstaller } from "./runtime-install.js";

export interface RuntimeModel { id: string; label: string; description?: string; recommended?: boolean }
interface ModelSelection { runtimeId: OptionalRuntimeId; revision: number; selectedModelId: string | null }
interface RuntimeModelsState { resourceBinding: WorkspaceResourceBinding; revision: number; selections: ModelSelection[] }
const MAX_INVENTORY_BYTES = 4 * 1024 * 1024;

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
function codexFailure(error: unknown): string {
  if (error instanceof ExternalJsonlRpcRequestError) return `RPC error ${error.code}`;
  // Only fixed diagnostics from our parser/transport cross the RPC boundary, never provider payloads.
  const message = error instanceof Error ? error.message : "";
  if (["codex model inventory is invalid", "codex model inventory has duplicate IDs",
    "external session adapter command was not found", "external session adapter could not start",
    "external session adapter closed before completing its request", "external session adapter process failed",
    "external session adapter timed out", "external session adapter returned invalid JSONL",
    "external session adapter returned an overlong JSONL frame", "external session adapter exceeded its output limit"].includes(message)
    || /^external session adapter exited before replying \(code (?:-?\d+|unknown)\)$/.test(message)) return message;
  return "unavailable";
}
function cachedCodexModels(env: NodeJS.ProcessEnv, storage: WorkspaceResourceStorage): RuntimeModel[] {
  let snapshot: ReturnType<typeof inspectWorkspaceResourceFile>["snapshot"];
  try {
    snapshot = storage.run(() => inspectWorkspaceResourceFile(join(env.CODEX_HOME!, "models_cache.json"), MAX_INVENTORY_BYTES).snapshot);
  } catch { throw new Error("cache unsafe"); }
  if (!snapshot) throw new Error("cache missing (private CODEX_HOME)");
  try { return codexModels(JSON.parse(snapshot.text), "models"); }
  catch { throw new Error("cache invalid"); }
}
function cacheCodexModels(models: RuntimeModel[], env: NodeJS.ProcessEnv, storage: WorkspaceResourceStorage): void {
  // Store only validated model metadata. Unknown native fields and authentication data are never copied.
  const text = JSON.stringify({ models: models.map(model => ({ slug: model.id, display_name: model.label,
    ...(model.description !== undefined ? { description: model.description } : {}),
    ...(model.recommended ? { isDefault: true } : {}) })) }) + "\n";
  if (Buffer.byteLength(text) > MAX_INVENTORY_BYTES) return;
  storage.run(() => withPrivateStateLockSync(workspaceStateHome(), ["runtime-homes", "codex", ".codex"], "models-cache", () => {
    const file = inspectWorkspaceResourceFile(join(env.CODEX_HOME!, "models_cache.json"), MAX_INVENTORY_BYTES);
    writePrivateStateFileSync(file, text, {
      ...(file.snapshot ? { expectedText: file.snapshot.text } : { expectedMissing: true }),
      assertCurrent: file.assertCurrent,
    });
  }));
}
async function liveModels(runtimeId: "codex" | "opencode", runtimes: WorkspaceRuntimeInstaller,
  storage: WorkspaceResourceStorage): Promise<RuntimeModel[]> {
  const { command, env } = runtimes.resolveBound(runtimeId);
  const failures: string[] = [];
  const remember = (models: RuntimeModel[]): RuntimeModel[] => {
    try { cacheCodexModels(models, env, storage); }
    catch { /* A refused cache write must not hide a usable live inventory or bypass its private-file checks. */ }
    return models;
  };
  if (runtimeId === "codex") {
    try {
      const result = await runJsonlRpcSequence<unknown>({ command, env, timeoutMs: 15000, maxOutputBytes: 4 * 1024 * 1024,
        requests: [{ id: 1, method: "initialize", params: { clientInfo: { name: "hara", title: "Hara", version: HARA_RUNTIME_VERSION },
          capabilities: { experimentalApi: false, requestAttestation: false, optOutNotificationMethods: [] } } },
          { method: "initialized" }, { id: 2, method: "model/list", params: {} }], resultId: 2 });
      return remember(codexModels(result, "data"));
    } catch (error) { failures.push(`app-server model/list: ${codexFailure(error)}`); }
  }
  const result = await runExternalCommandCapture({ command, env: { ...env, NO_COLOR: "1", OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_MODELS_FETCH: "true" } }, runtimeId === "codex" ? ["debug", "models"] : ["models"],
  { cwd: env.HOME, timeoutMs: 15000, maxOutputBytes: 4 * 1024 * 1024 });
  if (!result.ok && runtimeId === "opencode") throw new Error("opencode model inventory failed");
  const { stdout } = result;
  let models: RuntimeModel[];
  if (runtimeId === "codex") {
    if (!result.ok) {
      const reason = result.timedOut ? "timed out" : ["command_not_found", "spawn_failed", "output_limit"].includes(result.errorCode ?? "")
        ? result.errorCode : `command failed (code ${result.code ?? "unknown"})`;
      failures.push(`debug models: ${reason}`);
    } else {
      let parsed: unknown;
      try { parsed = JSON.parse(stdout); }
      catch { failures.push("debug models: invalid JSON"); }
      if (parsed !== undefined) {
        try { return remember(codexModels(parsed, "models")); }
        catch (error) { failures.push(`debug models: ${codexFailure(error)}`); }
      }
    }
    try { return cachedCodexModels(env, storage); }
    catch (error) {
      const reason = error instanceof Error ? error.message : "cache unsafe";
      throw new Error(`codex model inventory failed; ${[...failures, reason].join("; ")}`);
    }
  } else {
    models = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(id => {
      if (!validModelId(id)) throw new Error("opencode model inventory is invalid");
      return { id, label: id };
    });
  }
  if (new Set(models.map(model => model.id)).size !== models.length) throw new Error(`${runtimeId} model inventory has duplicate IDs`);
  return models;
}
const validModelId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(value)
  && !value.includes("..") && !value.includes("//") && !value.endsWith("/");

/** Workspace-scoped model preference, separate from all connection and coding settings state. */
export class WorkspaceRuntimeModels {
  private readonly state: WorkspaceJsonState<RuntimeModelsState>;
  private readonly pending = new Map<string, Promise<RuntimeModel[]>>();
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
  /** Registration/binding can prepare inventory without making authentication a prerequisite for binding. */
  warm(runtimeId: unknown): void {
    if (runtimeId === "codex") void this.list(runtimeId).catch(() => { /* listModels reports stage failures on demand. */ });
  }
  private live(runtimeId: "codex" | "opencode"): Promise<RuntimeModel[]> {
    // Coalesce a registration/bind warm-up with an immediate list/select, but never retain stale results.
    const key = JSON.stringify(this.runtimes.list().options.find(row => row.runtimeId === runtimeId));
    let pending = this.pending.get(key);
    if (!pending) {
      pending = liveModels(runtimeId, this.runtimes, this.state.storage).finally(() => this.pending.delete(key));
      this.pending.set(key, pending);
    }
    return pending;
  }
  async list(runtimeId: unknown) {
    this.bound(runtimeId);
    const row = this.state.read().selections.find(row => row.runtimeId === runtimeId);
    const models = runtimeId === "codex" || runtimeId === "opencode" ? await this.live(runtimeId) : CATALOG[runtimeId]!.map(model => ({ ...model }));
    this.bound(runtimeId);
    return { runtimeId, revision: row?.revision ?? 0, selectedModelId: row?.selectedModelId ?? null,
      models };
  }
  async select(runtimeId: unknown, modelId: unknown, expectedRevision: unknown): Promise<void> {
    this.bound(runtimeId);
    if (!validModelId(modelId)) throw new Error("Invalid runtime modelId");
    const models = runtimeId === "codex" || runtimeId === "opencode" ? await this.live(runtimeId) : CATALOG[runtimeId]!;
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
