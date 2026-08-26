import type { ImageAttachment, ToolSpec } from "../providers/types.js";
import type { SandboxMode } from "../sandbox.js";
import { prepareToolResult } from "./result-limit.js";
import { homeWorkspaceActionError, isUnsafeProjectWorkspace } from "../context/workspace-scope.js";
import type { SkillToolPolicyActivation } from "../skills/tool-policy.js";

/** Where agent-side output goes. In the TUI it drives ink state; in plain mode it's absent and
 *  the loop/tools fall back to writing the terminal directly. */
export interface UiSink {
  text(delta: string): void;
  reasoning(delta: string): void;
  /** Provider request lifecycle without provider text. Persistent clients use `waiting` to replace a
   * stale tool/checkpoint phase while the next model round is in flight. */
  status?(phase: "waiting" | "streaming"): void;
  tool(name: string, preview: string): void;
  diff(text: string): void;
  notice(text: string): void;
  /** Typed visual surface offer for persistent clients. Optional so terminal sinks and older embedders
   * keep working without learning Desktop navigation semantics. Artifact ids are opaque and URL
   * resources are independently validated by both the offering tool and the Desktop host. */
  surface?(event: {
    kind: "presentation" | "spreadsheet" | "document" | "design" | "browser" | "capability";
    title: string;
    resource:
      | { type: "artifact"; artifactId: string; revisionId: string }
      | { type: "url"; url: string };
  }): void;
}

export interface ToolContext {
  cwd: string;
  /** Host-selected local state root. Normal agent runs omit this and use the operating-system home;
   * hermetic embedders/tests may isolate durable Artifact state without mutating the user's profile. */
  stateHome?: string;
  sandbox?: SandboxMode;
  /** Identity route that owns the current persisted conversation. Auxiliary prompts/providers must use
   * this instead of consulting whichever profile is globally active at the moment. */
  profileId?: string;
  /** Immutable Personal/company audience for data that must survive a mutable provider connection.
   * Organization learning is keyed by this value, never by the reusable local profile id. */
  spaceId?: string;
  /** Current durable conversation, when this run has one. Transcript recall uses it to exclude the active
   * session and enforce interactive/gateway/cron audience boundaries. */
  sessionId?: string;
  /** Engine-owned execution identity for evidence deduplication. Tools may use it for opaque provenance;
   * models never provide or override it. */
  taskId?: string;
  /** One-run cancellation boundary. Built-in tools must stop owned subprocesses/work promptly when fired. */
  signal?: AbortSignal;
  /** Isolate the in-memory todo_write checklist for concurrent agent runs (serve sessions/sub-agents). */
  todoScope?: string;
  /** Activate provider-neutral deferred tools for the next model round. Returns the subset accepted by
   * this run's role/tool filter; absent for direct tool callers outside the agent loop. */
  activateTools?: (names: string[]) => string[];
  /** Narrow this run to a skill's declared allowed-tools. Repeated activations intersect and can never
   * widen the current floor. Absent for direct callers that cannot enforce a run-wide restriction. */
  restrictToolsForSkill?: (skillId: string, allowedTools: readonly string[]) => SkillToolPolicyActivation;
  /** spawn a sub-agent for a sub-task (set by the REPL/-p; absent inside sub-agents) */
  spawn?: (task: string, role?: string, signal?: AbortSignal) => Promise<string>;
  /** UI sink (set in TUI mode) — tools route diffs/output here instead of stdout */
  ui?: UiSink;
  /** Ask the user a structured question mid-turn and await their answer (drives the `ask_user` tool).
   *  Set only on INTERACTIVE run paths (classic REPL + TUI), routed through the SAME input channel as the
   *  approval `confirm` prompt. Absent in headless / non-TTY / `-p` / gateway / sub-agent runs — so the tool
   *  must treat `ask === undefined` as "no interactive user available" and not block. When `options` are
   *  given they are offered as a numbered list; the user may also type a free-text answer. Returns the chosen
   *  option text or the free text. */
  ask?: (question: string, options?: string[], signal?: AbortSignal) => Promise<string>;
  /** Describe a screenshot with the selected conversation model's native image input. `hint` focuses the
   * description on a goal (e.g. "the Login button") for actionable RPA output. */
  describeImage?: (path: string, hint?: string, signal?: AbortSignal) => Promise<string>;
  /** Inspect a verified, engine-owned image snapshot with the current session's authorized image route.
   * The inspect_image tool owns filesystem validation and passes only a private temporary snapshot here;
   * embedders must preserve the session/profile identity when selecting the provider. */
  inspectImage?: (
    image: ImageAttachment,
    hint?: string,
    signal?: AbortSignal,
  ) => Promise<{ text: string; model: string }>;
  /** locate a UI element in a screenshot via a grounding vision model → center as 0..1 fractions (for RPA clicks) */
  locate?: (path: string, target: string, signal?: AbortSignal) => Promise<{ x: number; y: number } | null>;
}

export type ToolEffect = "read" | "state" | "probe" | "edit" | "exec" | "computer" | "interactive";

export interface ToolOperationTraits {
  /** Concrete effect for this input. Multi-action tools must not share one static permission label. */
  effect: ToolEffect;
  /** True only when this exact operation can overlap other operations without shared-state races. */
  concurrencySafe: boolean;
  /** Optional approval boundary when it is stricter than the operation's data effect. For example,
   * isolated browser rendering remains a read but still requires explicit computer-use consent. */
  approvalKind?: "read" | "edit" | "exec" | "computer";
  /** Metadata for future audit/permission UIs; never weakens the ordinary approval/guardian boundary. */
  destructive?: boolean;
}

export interface Tool {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  /** read | edit | exec | computer — drives the approval gate (read never prompts; computer always asks
   *  once per session for a grant, even in full-auto) */
  kind?: "read" | "edit" | "exec" | "computer";
  /** Static concurrency declaration for tools whose effect does not depend on input. Omitted is
   * conservative/serial; third-party tools never become parallel merely because kind is "read". */
  concurrencySafe?: boolean;
  /** Input-level effect/concurrency classification. `kind` remains the conservative compatibility default. */
  classify?: (input: any, ctx: ToolContext) => ToolOperationTraits;
  /** Deferred schemas stay out of provider prompts until tool_search activates them for this run. */
  visibility?: "eager" | "deferred";
  /** This operation treats cwd as a project scope (for example a coding mutation or project-aware process)
   *  and therefore cannot run with Home as its implicit workspace. `kind:"exec"`/`kind:"edit"` alone are
   *  approval classes: explicit management or delivery actions remain valid at Home unless opted in here. */
  requiresProjectWorkspace?: boolean;
  /** Opaque host process (MCP/external coding agent). It sits outside Hara's in-process file boundary,
   *  therefore always needs an interactive grant and is disabled in headless/full-auto unless the user
   *  opted in before launch with HARA_ALLOW_TRUSTED_EXTENSIONS=1. */
  trustBoundary?: "external";
  run(input: any, ctx: ToolContext): Promise<string>;
}

/** Names of required parameters that are ABSENT (undefined/null) in a tool call's input. Defends
 *  against models that drop parameters outright (observed: qwen3.7-plus losing write_file's
 *  path/content mid-stream) — the loop rejects the call with a precise error instead of executing
 *  garbage, and repeat-guard escalates if the model loops on the same broken shape. Empty strings
 *  are NOT flagged (writing an empty file is legitimate). */
export function missingRequired(tool: Tool, input: unknown): string[] {
  const req = tool.input_schema.required ?? [];
  const obj = (input && typeof input === "object" ? (input as Record<string, unknown>) : {});
  return req.filter((k) => obj[k] === undefined || obj[k] === null);
}

const registry = new Map<string, Tool>();
let specsCache: ToolSpec[] | null = null;

export function registerTool(t: Tool): void {
  const run = t.run;
  registry.set(t.name, {
    ...t,
    // Apply the context boundary at registration so every caller (main loop, tests, embedders) gets
    // identical behavior instead of relying on one orchestration path to remember the cap.
    run: async (input, ctx) => {
      // A tool reference can be retained by a non-cooperative wrapper and invoked after runAgent has already
      // returned its deadline outcome. Gate at the registered call boundary (not just in the agent loop) so
      // delayed getTool(...).run(...) calls never start fresh work after cancellation.
      if (ctx.signal?.aborted) {
        return `Error: ${t.name} cancelled before execution because the agent run has ended.`;
      }
      // Only explicitly project-scoped operations are blocked. Tool kinds are also used for safe
      // management/delivery side effects, so a kind must not itself imply a project workspace requirement.
      // Canonical comparison closes Home symlink aliases.
      if (t.requiresProjectWorkspace && isUnsafeProjectWorkspace(ctx.cwd)) {
        return `Error: ${homeWorkspaceActionError(`run ${t.name}`)}`;
      }
      // Verified read_file content already passed the protected-file policy. Preserve its historical
      // explicit opt-in semantics and harmless template placeholders in the immediate preview; oversized
      // continuation storage is still independently redacted by storeToolResult().
      return prepareToolResult(await run(input, ctx), undefined, { redactPreview: t.name !== "read_file" });
    },
  });
  specsCache = null;
}

export function getTool(name: string): Tool | undefined {
  return registry.get(name);
}

export function getTools(): Tool[] {
  return [...registry.values()];
}

function defaultEffect(tool: Tool): ToolEffect {
  if (tool.kind === "edit") return "edit";
  if (tool.kind === "exec") return "exec";
  if (tool.kind === "computer") return "computer";
  if (tool.kind === "read") return "read";
  // Legacy/plugin tools that omitted their safety declaration used to remain approval-gated. Preserve that
  // conservative boundary: missing metadata must never silently mean read-only.
  return "exec";
}

const TOOL_EFFECTS = new Set<ToolEffect>(["read", "state", "probe", "edit", "exec", "computer", "interactive"]);
const TOOL_APPROVAL_KINDS = new Set(["read", "edit", "exec", "computer"]);

/** Conservative, non-throwing classifier shared by approval, understanding, guardian, and scheduling. */
export function toolOperationTraits(tool: Tool, input: unknown, ctx: ToolContext): ToolOperationTraits {
  const effect = defaultEffect(tool);
  const fallback: ToolOperationTraits = { effect, concurrencySafe: tool.concurrencySafe === true };
  if (!tool.classify) return fallback;
  try {
    const classified = tool.classify(input, ctx);
    if (!classified || typeof classified !== "object" || !TOOL_EFFECTS.has(classified.effect)) {
      return { ...fallback, concurrencySafe: false };
    }
    return {
      effect: classified.effect,
      concurrencySafe: classified.concurrencySafe === true,
      ...(classified.approvalKind && TOOL_APPROVAL_KINDS.has(classified.approvalKind)
        ? { approvalKind: classified.approvalKind }
        : {}),
      ...(classified.destructive === true ? { destructive: true } : {}),
    };
  } catch {
    // A failed classifier may never downgrade into parallel execution.
    return { ...fallback, concurrencySafe: false };
  }
}

export function approvalKindForOperation(traits: ToolOperationTraits): Tool["kind"] {
  if (traits.approvalKind) return traits.approvalKind;
  if (traits.effect === "probe") return "exec";
  if (traits.effect === "edit") return "edit";
  if (traits.effect === "exec") return "exec";
  if (traits.effect === "computer") return "computer";
  return "read";
}

export interface ToolSpecOptions {
  /** No options preserves the historical library API that returns every registered schema. */
  activatedDeferred?: ReadonlySet<string>;
  includeDeferred?: boolean;
}

/** Provider-neutral tool specs derived from the registry. */
export function toolSpecs(options?: ToolSpecOptions): ToolSpec[] {
  if (!specsCache) {
    specsCache = getTools().map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    }));
  }
  const visible = options === undefined || options.includeDeferred
    ? specsCache
    : specsCache.filter((spec) => {
        const tool = registry.get(spec.name);
        return tool?.visibility !== "deferred" || options.activatedDeferred?.has(spec.name);
      });
  // Callers commonly filter the array for a role. Return a shallow copy so that never mutates the
  // stable cached snapshot shared by subsequent agent rounds.
  return visible.slice();
}

export interface ToolCatalogMatch {
  name: string;
  description: string;
  score: number;
}

function catalogTerms(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9_\-\u3400-\u9fff]+/u).filter(Boolean);
}

/** Search deferred tools without exposing every JSON schema. Names rank above descriptions. */
export function searchDeferredToolCatalog(query: string, limit = 8): ToolCatalogMatch[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];
  const terms = catalogTerms(normalized);
  const matches: ToolCatalogMatch[] = [];
  for (const tool of getTools()) {
    if (tool.visibility !== "deferred") continue;
    const name = tool.name.toLowerCase();
    const description = tool.description.toLowerCase();
    let score = 0;
    if (name === normalized) score += 100;
    if (name.includes(normalized)) score += 30;
    if (description.includes(normalized)) score += 15;
    for (const term of terms) {
      if (name === term) score += 20;
      else if (name.includes(term)) score += 8;
      if (description.includes(term)) score += 3;
    }
    if (score > 0) matches.push({ name: tool.name, description: tool.description, score });
  }
  return matches
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, Math.max(1, Math.min(32, Math.floor(limit))));
}
