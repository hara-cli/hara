import { captureExpandedMetadata, type ExpandedMetadataCapture } from "../agent-runtime/expanded-metadata.js";
import { DOCUMENTED_EXPANDED_MODELS, EXPANDED_MODEL_SOURCES, copilotHelpEfforts, parseCursorModels } from "../agent-runtime/expanded-models.js";
import { OPTIONAL_RUNTIMES } from "./runtime-catalog.js";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRuntimeExecutionPolicy } from "../agent-runtime/execution-policy.js";
import { codexHostToolOverrides } from "../agent-runtime/codex-host-config.js";
import { WorkspaceJsonState, exact, plain } from "./local-state.js";
import { join } from "node:path";
import { ExternalJsonlRpcRequestError, runExternalCommandCapture, JsonlRpcClient } from "../external-sessions/process.js";
import { withPrivateStateLockSync, writePrivateStateFileSync } from "../security/private-state.js";
import { HARA_RUNTIME_VERSION } from "../version.js";
import { inspectWorkspaceResourceFile, sameWorkspaceResourceBinding, workspaceStateHome,
  type WorkspaceResourceBinding, type WorkspaceResourceStorage } from "./resource-context.js";
import { optionalRuntimeId, type OptionalRuntimeId, type WorkspaceRuntimeInstaller } from "./runtime-install.js";
import { defaultEffortForLevels } from "./default-effort.js";

export interface RuntimeModel { id: string; label: string; description?: string; recommended?: boolean;
  /** Reasoning levels this exact model advertised on the live inventory. Absent/empty means the
   * capability is unknown, and effort selection must be refused rather than guessed. */
  supportedReasoningEfforts?: string[]; defaultReasoningEffort?: string }
interface ModelSelection { runtimeId: OptionalRuntimeId; revision: number; selectedModelId: string | null; selectedEffort?: string | null }
interface RuntimeModelsState { resourceBinding: WorkspaceResourceBinding; revision: number; selections: ModelSelection[] }
const MAX_INVENTORY_BYTES = 4 * 1024 * 1024;
const MAX_EFFORTS = 8;
const EFFORT_ID = /^[a-z][a-z0-9-]{0,31}$/;
const selectionFields = ["runtimeId", "revision", "selectedModelId"] as const;

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
    // `debug models` (and cached copies) do not publish reasoning capability; only live `model/list`.
    const efforts = field === "data" ? codexEfforts(value) : {};
    return { id, label, ...(typeof value.description === "string" ? { description: value.description } : {}),
      ...(value.isDefault === true ? { recommended: true } : {}), ...efforts };
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
/** Host mode: the CLI's own cache is a legitimate read-only fallback, never a copy target. */
function hostCodexModels(runtimes: WorkspaceRuntimeInstaller): RuntimeModel[] {
  const text = runtimes.hostCodexModelCache();
  if (text === null) throw new Error("cache missing (host CODEX_HOME)");
  try { return codexModels(JSON.parse(text), "models"); }
  catch { throw new Error("cache invalid (host CODEX_HOME)"); }
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
/** Inventory is not an execution permit. Give its native process an empty, externally read-only cwd. */
async function protectedInventory<T>(storage: WorkspaceResourceStorage, runtimes: WorkspaceRuntimeInstaller, runtimeId: "codex" | "claude" | "opencode",
  resolved: ReturnType<WorkspaceRuntimeInstaller["resolveBound"]>, args: string[],
  run: (launch: { command: string; args: string[]; env: NodeJS.ProcessEnv; onProcess: NonNullable<import("../external-sessions/process.js").ExternalCommandOptions["onProcess"]>; drainProcess(): Promise<void> }) => Promise<T>): Promise<T> {
  if (!resolved.env.HOME) throw new Error("Runtime login HOME unavailable");
  const workRoot = mkdtempSync(join(realpathSync.native(tmpdir()), "hara-inventory-"));
  let policy;
  try {
    policy = createRuntimeExecutionPolicy({ runtimeId, tier: "controlled", workRoot,
      ...runtimes.executionPolicyDirectories(runtimeId, resolved), loginSource: resolved.loginSource });
    if (runtimeId === "opencode") resolved = { ...resolved, env: { ...resolved.env, XDG_CONFIG_HOME: join(policy.tempRoot, "config"), OPENCODE_CONFIG_DIR: join(policy.tempRoot, "config/opencode") } };
    const suffix = runtimeId === "codex" ? codexHostToolOverrides(resolved.env.HOME!, resolved.env.CODEX_HOME) : [];
    return await run(policy.wrap({ command: resolved.command, args: [...args, ...suffix], env: resolved.env }));
  } finally { await policy?.close(); rmSync(workRoot, { recursive: true, force: true }); }
}
async function liveModels(runtimeId: "codex" | "opencode" | "cursor", runtimes: WorkspaceRuntimeInstaller,
  storage: WorkspaceResourceStorage, expandedMetadata: ExpandedMetadataCapture): Promise<RuntimeModel[]> {
  let { command, env, loginSource, proxyUrl } = await runtimes.prepareBound(runtimeId);
  if (runtimeId === "cursor") {
    const result = await expandedMetadata({ runtimeId, command, env, proxyUrl, ...runtimes.executionPolicyDirectories(runtimeId, { command, env, loginSource }) });
    if (!result.ok) throw new Error(result.errorCode === "runtime_proxy_failed" ? result.errorCode : "cursor model inventory failed");
    return parseCursorModels(result.stdout);
  }
  const failures: string[] = [];
  const remember = (models: RuntimeModel[]): RuntimeModel[] => {
    // The private cache is Hara-owned state inside runtime-homes/<id>. A host login must not be
    // mirrored into it: that would copy a credential-adjacent inventory out of the user's own home.
    if (loginSource === "isolated") try { cacheCodexModels(models, env, storage); }
    catch { /* A refused cache write must not hide a usable live inventory or bypass its private-file checks. */ }
    return models;
  };
  if (runtimeId === "codex") {
    try {
      const result = await protectedInventory(storage, runtimes, "codex", { command, env, loginSource }, ["app-server", "--stdio"], async launch => {
        const client = JsonlRpcClient.start({ ...launch, appServerArgs: launch.args, timeoutMs: 15000, maxOutputBytes: 4 * 1024 * 1024 });
        try {
          await client.call("initialize", { clientInfo: { name: "hara", title: "Hara", version: HARA_RUNTIME_VERSION }, capabilities: { experimentalApi: false } });
          client.notify("initialized"); return await client.call("model/list", {});
        } finally { client.close(); await client.waitForClose(); }
      });
      return remember(codexModels(result, "data"));
    } catch (error) { failures.push(`app-server model/list: ${codexFailure(error)}`); }
  }
  // A failed async app-server query is followed by a new physical process, so it needs fresh proxy
  // admission too. Never let a newly configured Workspace proxy be bypassed by the old unset env.
  if (runtimeId === "codex") ({ command, env, loginSource, proxyUrl } = await runtimes.prepareBound(runtimeId));
  const inventoryEnv = { ...env, NO_COLOR: "1", OPENCODE_DISABLE_AUTOUPDATE: "true", OPENCODE_DISABLE_MODELS_FETCH: "true",
    ...(runtimeId === "opencode" ? { OPENCODE_PURE: "1", OPENCODE_DISABLE_DEFAULT_PLUGINS: "1", OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugin: [], mcp: {}, permission: { "*": "deny" } }) } : {}) };
  const result = await protectedInventory(storage, runtimes, runtimeId, { command, env: inventoryEnv, loginSource },
    runtimeId === "codex" ? ["debug", "models"] : ["models"], launch => runExternalCommandCapture(launch, launch.args,
      { cwd: env.HOME, proxyUrl, waitForClose: true, timeoutMs: 15000, maxOutputBytes: 4 * 1024 * 1024 }));
  if (result.errorCode === "runtime_proxy_failed") throw new Error(result.errorCode);
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
    try { return loginSource === "isolated" ? cachedCodexModels(env, storage) : hostCodexModels(runtimes); }
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
const validEffort = (value: unknown): value is string => typeof value === "string" && EFFORT_ID.test(value);

/** Live app-server entries carry reasoning capability; `debug models` and the private cache do not.
 * Keep only values the provider actually declared so an unknown model can never receive an effort. */
function codexEfforts(value: unknown): { supportedReasoningEfforts?: string[]; defaultReasoningEffort?: string } {
  const raw = plain(value) && Array.isArray(value.supportedReasoningEfforts) ? value.supportedReasoningEfforts : null;
  if (!raw) return {};
  const ids: string[] = [];
  for (const entry of raw) {
    const id = typeof entry === "string" ? entry : plain(entry) ? (entry.reasoningEffort ?? entry.id) : null;
    // The live contract (and the daemon's own parser) accepts either bare ids or `{ reasonEffort | id }`.
    if (!validEffort(id) || ids.includes(id)) continue;
    ids.push(id);
    if (ids.length >= MAX_EFFORTS) break;
  }
  const defaultEffort = plain(value) && validEffort(value.defaultReasoningEffort) && ids.includes(value.defaultReasoningEffort)
    ? value.defaultReasoningEffort : undefined;
  return ids.length ? { supportedReasoningEfforts: ids, ...(defaultEffort ? { defaultReasoningEffort: defaultEffort } : {}) } : {};
}

/** Workspace-scoped model preference, separate from all connection and coding settings state. */
export class WorkspaceRuntimeModels {
  private readonly state: WorkspaceJsonState<RuntimeModelsState>;
  private readonly pending = new Map<string, Promise<RuntimeModel[]>>();
  private readonly launchDefaults = new Map<string, Promise<{ modelId: string | null; effort: string | null }>>();
  constructor(private readonly storage: WorkspaceResourceStorage, private readonly runtimes: WorkspaceRuntimeInstaller,
    private readonly expandedMetadata: ExpandedMetadataCapture = captureExpandedMetadata) {
    this.state = new WorkspaceJsonState(storage, "runtime-models-v1.json", value => {
      if (!plain(value) || !exact(value, ["resourceBinding", "revision", "selections"])
        || !sameWorkspaceResourceBinding(value.resourceBinding as WorkspaceResourceBinding, this.state.binding())
        || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1
        || !Array.isArray(value.selections) || value.selections.length > OPTIONAL_RUNTIMES.length) throw new Error("Runtime model state is damaged");
      const seen = new Set<string>();
      for (const row of value.selections) {
        // `selectedEffort` is written from now on but must stay optional on read: state files created
        // before effort existed have no such field, and an older Hara must never be locked out by it.
        if (!plain(row) || !exact(row, [...selectionFields, ...(row.selectedEffort === undefined ? [] : ["selectedEffort"])])
          || !optionalRuntimeId(row.runtimeId) || seen.has(row.runtimeId)
          || !Number.isSafeInteger(row.revision) || Number(row.revision) < 1
          || !validModelId(row.selectedModelId)
          || (row.selectedEffort !== undefined && row.selectedEffort !== null && !validEffort(row.selectedEffort))) throw new Error("Runtime model state is damaged");
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
  /**
   * Claude's model inventory is a static catalog, but its `--effort` flag is version-dependent. Ask the
   * registered binary once per resolved identity and only publish levels it actually lists; a CLI without
   * the flag reports no levels, so the UI cannot offer a level the launch would reject.
   */
  private claudeEfforts: { key: string; levels: string[] } | null = null;
  private async claudeEffortLevels(): Promise<string[]> {
    let resolved: ReturnType<WorkspaceRuntimeInstaller["resolveBound"]>;
    try { resolved = await this.runtimes.prepareBound("claude"); } catch (error) { if (error instanceof Error && error.message.startsWith("runtime_proxy_")) throw error; return []; }
    const bound = this.runtimes.list().options.find(row => row.runtimeId === "claude");
    const key = JSON.stringify([resolved.command, bound?.fingerprint ?? bound?.version ?? null]);
    if (this.claudeEfforts?.key === key) return this.claudeEfforts.levels;
    const result = await protectedInventory(this.storage, this.runtimes, "claude", resolved, ["--setting-sources", "project,local", "--settings", JSON.stringify({ disableAllHooks: true, sandbox: { enabled: false } }), "--help"],
      launch => runExternalCommandCapture(launch, launch.args, { cwd: resolved.env.HOME, waitForClose: true, timeoutMs: 10_000, maxOutputBytes: 256 * 1024 }));
    const text = result.ok ? result.stdout : "";
    const flag = /--effort\s+(?:<[^>]+>)?[\s\S]{0,400}?\(([a-z][a-z0-9, ]*)\)/.exec(text);
    const levels = flag ? [...new Set(flag[1]!.split(",").map(value => value.trim()).filter(validEffort))].slice(0, MAX_EFFORTS) : [];
    this.claudeEfforts = { key, levels };
    return levels;
  }
  private copilotEfforts: { key: string; levels: string[] } | null = null;
  private async copilotEffortLevels(): Promise<string[]> {
    const resolved = await this.runtimes.prepareBound("copilot");
    const bound = this.runtimes.list().options.find(row => row.runtimeId === "copilot");
    const key = JSON.stringify([resolved.command, bound?.fingerprint ?? bound?.version]);
    if (this.copilotEfforts?.key === key) return this.copilotEfforts.levels;
    let result;
    try { result = await this.expandedMetadata({ runtimeId: "copilot", command: resolved.command, env: resolved.env, proxyUrl: resolved.proxyUrl,
      ...this.runtimes.executionPolicyDirectories("copilot", resolved) }); }
    catch { return []; } // A closed metadata gate must not claim live effort support.
    const levels = result.ok ? copilotHelpEfforts(result.stdout) : [];
    this.copilotEfforts = { key, levels }; return levels;
  }
  private async catalogModels(runtimeId: OptionalRuntimeId): Promise<RuntimeModel[]> {
    if (runtimeId === "copilot" || runtimeId === "grok") {
      const models = DOCUMENTED_EXPANDED_MODELS[runtimeId]!.map(row => ({ ...row }));
      if (runtimeId === "grok") return models;
      const levels = await this.copilotEffortLevels();
      return models.map(row => { const supported = levels.filter(level => level !== "max" || row.id.startsWith("claude-"));
        return { ...row, ...(supported.length ? { supportedReasoningEfforts: supported } : {}) }; });
    }
    const models = CATALOG[runtimeId]!.map(model => ({ ...model }));
    if (runtimeId !== "claude") return models;
    const levels = await this.claudeEffortLevels();
    return levels.length ? models.map(model => ({ ...model, supportedReasoningEfforts: [...levels] })) : models;
  }
  /**
   * Whether this runtime's registered binary can accept a reasoning level at launch. Codex always can
   * (`-c model_reasoning_effort` is a config override). Claude only when its own `--help` lists the flag;
   * the answer is cached per verified binary fingerprint, so a replacement is checked on the next launch.
   */
  async effortLaunchable(runtimeId: OptionalRuntimeId): Promise<boolean> {
    this.bound(runtimeId);
    if (runtimeId === "codex") return true;
    if (runtimeId === "copilot") return (await this.copilotEffortLevels()).length > 0;
    if (runtimeId !== "claude") return false;
    return (await this.claudeEffortLevels()).length > 0;
  }
  selection(runtimeId: OptionalRuntimeId): { modelId: string | null; effort: string | null } {
    this.bound(runtimeId);
    const row = this.state.read().selections.find(row => row.runtimeId === runtimeId);
    return { modelId: row?.selectedModelId ?? null, effort: row?.selectedEffort ?? null };
  }
  /** New/legacy unchosen strength gets a live-model-backed default at launch. Explicit saved
   * string or null is never changed. The returned choice is not persisted behind the user's back. */
  async launchSelection(runtimeId: OptionalRuntimeId): Promise<{ modelId: string | null; effort: string | null }> {
    this.bound(runtimeId);
    const row = this.state.read().selections.find(value => value.runtimeId === runtimeId);
    if (row && Object.hasOwn(row, "selectedEffort")) return this.selection(runtimeId);
    // The first lookup needs the live inventory; repeating app-server model/list on every chat
    // would add a second native process to the latency path. Reuse only for this bound runtime
    // identity and state revision. A failed lookup is retried on the next attempt.
    const key = JSON.stringify([runtimeId, row?.revision ?? 0, row?.selectedModelId ?? null,
      this.runtimes.list().options.find(value => value.runtimeId === runtimeId)]);
    let choice = this.launchDefaults.get(key);
    if (!choice) {
      choice = this.list(runtimeId).then(inventory => {
        const model = inventory.models.find(value => value.id === row?.selectedModelId)
          ?? (!row ? inventory.models.find(value => value.recommended) : undefined);
        return { modelId: row?.selectedModelId ?? model?.id ?? null,
          effort: runtimeId === "opencode" ? null : defaultEffortForLevels(model?.supportedReasoningEfforts) };
      }).catch(error => { this.launchDefaults.delete(key); throw error; });
      if (this.launchDefaults.size >= 8) this.launchDefaults.clear();
      this.launchDefaults.set(key, choice);
    }
    return choice;
  }
  selected(runtimeId: OptionalRuntimeId): string | null { return this.selection(runtimeId).modelId; }
  selectedEffort(runtimeId: OptionalRuntimeId): string | null { return this.selection(runtimeId).effort; }
  /** Registration/binding can prepare inventory without making authentication a prerequisite for binding. */
  warm(runtimeId: unknown): void {
    if (runtimeId === "codex") void this.list(runtimeId).catch(() => { /* listModels reports stage failures on demand. */ });
  }
  private live(runtimeId: "codex" | "opencode" | "cursor"): Promise<RuntimeModel[]> {
    // Coalesce a registration/bind warm-up with an immediate list/select, but never retain stale results.
    const key = JSON.stringify([this.runtimes.list().options.find(row => row.runtimeId === runtimeId), this.runtimes.proxy.read().revision]);
    let pending = this.pending.get(key);
    if (!pending) {
      pending = liveModels(runtimeId, this.runtimes, this.state.storage, this.expandedMetadata).finally(() => this.pending.delete(key));
      this.pending.set(key, pending);
    }
    return pending;
  }
  async list(runtimeId: unknown) {
    this.bound(runtimeId);
    const row = this.state.read().selections.find(row => row.runtimeId === runtimeId);
    const models = runtimeId === "codex" || runtimeId === "opencode" || runtimeId === "cursor" ? await this.live(runtimeId) : await this.catalogModels(runtimeId);
    this.bound(runtimeId);
    const selected = models.find(value => value.id === row?.selectedModelId);
    return { runtimeId, ...(["copilot", "cursor", "grok"].includes(runtimeId) ? { source: runtimeId === "cursor" ? "live" as const : "documented" as const, sourceUrl: EXPANDED_MODEL_SOURCES[runtimeId as keyof typeof EXPANDED_MODEL_SOURCES] } : {}), revision: row?.revision ?? 0, selectedModelId: row?.selectedModelId ?? null,
      selectedEffort: row && Object.hasOwn(row, "selectedEffort") ? row.selectedEffort ?? null
        : runtimeId === "opencode" ? null : defaultEffortForLevels(selected?.supportedReasoningEfforts), models };
  }
  /**
   * Persist the model and, optionally, its reasoning level.
   *
   * `effort` is three-valued: `undefined` keeps the current level, `null` clears it, and a string must
   * be one the selected model declared on the live inventory. An unknown model capability is a refusal,
   * never a silent reset — the caller asked for a level this model cannot promise.
   */
  async select(runtimeId: unknown, modelId: unknown, expectedRevision: unknown, effort?: unknown): Promise<void> {
    this.bound(runtimeId);
    if (!validModelId(modelId)) throw new Error("Invalid runtime modelId");
    if (effort !== undefined && effort !== null && !validEffort(effort)) throw new Error("Invalid runtime effort");
    const models = runtimeId === "codex" || runtimeId === "opencode" || runtimeId === "cursor" ? await this.live(runtimeId) : await this.catalogModels(runtimeId);
    const model = models.find(row => row.id === modelId);
    if (!model) throw new Error("Invalid runtime modelId");
    if (effort !== undefined && effort !== null) {
      const declared = model.supportedReasoningEfforts ?? [];
      if (!declared.length) throw new Error("This model does not report reasoning effort; no level was selected");
      if (!declared.includes(effort as string)) throw new Error("Invalid runtime effort");
    }
    if (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 0) throw new Error("Invalid runtime model revision");
    const current = this.state.read();
    const prior = current.selections.find(row => row.runtimeId === runtimeId);
    if ((prior?.revision ?? 0) !== expectedRevision) throw new Error("Runtime model revision changed; refresh before selecting");
    const nextEffort = effort === undefined ? (prior?.selectedModelId === modelId && prior !== undefined && Object.hasOwn(prior, "selectedEffort")
      ? prior?.selectedEffort ?? null : runtimeId === "opencode" ? null : defaultEffortForLevels(model.supportedReasoningEfforts))
      : effort as string | null;
    this.state.update(current.revision, value => {
      // Recheck under the state lock so a concurrent selection cannot overwrite this runtime.
      if ((value.selections.find(row => row.runtimeId === runtimeId)?.revision ?? 0) !== expectedRevision)
        throw new Error("Runtime model revision changed; refresh before selecting");
      this.bound(runtimeId);
      return { ...value, selections: [...value.selections.filter(row => row.runtimeId !== runtimeId),
        { runtimeId, revision: Number(expectedRevision) + 1, selectedModelId: modelId, selectedEffort: nextEffort }] };
    });
  }
}
