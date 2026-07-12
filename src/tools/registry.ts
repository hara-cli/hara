import type { ToolSpec } from "../providers/types.js";
import type { SandboxMode } from "../sandbox.js";
import { limitToolResult } from "./result-limit.js";

/** Where agent-side output goes. In the TUI it drives ink state; in plain mode it's absent and
 *  the loop/tools fall back to writing the terminal directly. */
export interface UiSink {
  text(delta: string): void;
  reasoning(delta: string): void;
  tool(name: string, preview: string): void;
  diff(text: string): void;
  notice(text: string): void;
}

export interface ToolContext {
  cwd: string;
  sandbox?: SandboxMode;
  /** spawn a sub-agent for a sub-task (set by the REPL/-p; absent inside sub-agents) */
  spawn?: (task: string, role?: string) => Promise<string>;
  /** UI sink (set in TUI mode) — tools route diffs/output here instead of stdout */
  ui?: UiSink;
  /** Ask the user a structured question mid-turn and await their answer (drives the `ask_user` tool).
   *  Set only on INTERACTIVE run paths (classic REPL + TUI), routed through the SAME input channel as the
   *  approval `confirm` prompt. Absent in headless / non-TTY / `-p` / gateway / sub-agent runs — so the tool
   *  must treat `ask === undefined` as "no interactive user available" and not block. When `options` are
   *  given they are offered as a numbered list; the user may also type a free-text answer. Returns the chosen
   *  option text or the free text. */
  ask?: (question: string, options?: string[]) => Promise<string>;
  /** describe an image file via the vision sidecar (lets the computer tool return a screenshot as text);
   *  `hint` focuses the description on a goal (e.g. "the Login button") for actionable RPA output */
  describeImage?: (path: string, hint?: string) => Promise<string>;
  /** locate a UI element in a screenshot via a grounding vision model → center as 0..1 fractions (for RPA clicks) */
  locate?: (path: string, target: string) => Promise<{ x: number; y: number } | null>;
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
    run: async (input, ctx) => limitToolResult(await run(input, ctx)),
  });
  specsCache = null;
}

export function getTool(name: string): Tool | undefined {
  return registry.get(name);
}

export function getTools(): Tool[] {
  return [...registry.values()];
}

/** Provider-neutral tool specs derived from the registry. */
export function toolSpecs(): ToolSpec[] {
  if (!specsCache) {
    specsCache = getTools().map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    }));
  }
  // Callers commonly filter the array for a role. Return a shallow copy so that never mutates the
  // stable cached snapshot shared by subsequent agent rounds.
  return specsCache.slice();
}
