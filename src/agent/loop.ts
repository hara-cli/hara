import type { Provider, NeutralMsg, ToolResult } from "../providers/types.js";
import { getTool, toolSpecs, type ToolContext } from "../tools/registry.js";
import { c, out } from "../ui.js";
import type { ApprovalMode } from "../config.js";

/** Whether a tool call needs user confirmation under the given approval mode. */
export function needsConfirm(kind: string | undefined, mode: ApprovalMode): boolean {
  if (kind === "read") return false;
  if (mode === "full-auto") return false;
  if (mode === "auto-edit") return kind === "exec";
  return true; // suggest: confirm edits and exec
}

const system = (cwd: string, projectContext?: string) =>
  `You are hara, a coding agent running in the user's terminal.
Working directory: ${cwd}
Be concise and direct. Use the provided tools to read files, edit/write files, and run shell
commands. Prefer small, verifiable steps; edit existing files with edit_file rather than rewriting
them whole. After completing a task, give a one-line summary.` +
  (projectContext ? `\n\n# Project context (AGENTS.md)\n${projectContext}` : "");

export interface RunOpts {
  provider: Provider;
  ctx: ToolContext;
  approval: ApprovalMode;
  confirm: (q: string) => Promise<boolean>;
  projectContext?: string;
  stats?: { input: number; output: number };
}

/** Provider-agnostic agentic loop. Mutates `history` in place. */
export async function runAgent(history: NeutralMsg[], opts: RunOpts): Promise<void> {
  const { provider, ctx } = opts;

  for (;;) {
    const r = await provider.turn({ system: system(ctx.cwd, opts.projectContext), history, tools: toolSpecs(), onText: out });
    out("\n");
    if (r.usage && opts.stats) {
      opts.stats.input += r.usage.input;
      opts.stats.output += r.usage.output;
    }
    history.push({ role: "assistant", text: r.text, toolUses: r.toolUses });

    if (r.stop === "error") {
      out(c.red(`[${provider.id} error] ${r.errorMsg ?? "unknown"}\n`));
      return;
    }
    if (r.stop !== "tool_use") return;

    const results: ToolResult[] = [];
    for (const tu of r.toolUses) {
      const tool = getTool(tu.name);
      if (!tool) {
        results.push({ id: tu.id, name: tu.name, content: `Unknown tool: ${tu.name}`, isError: true });
        continue;
      }
      if (needsConfirm(tool.kind, opts.approval)) {
        const input = tu.input as Record<string, unknown>;
        const preview = String(input.command ?? input.path ?? "");
        const ok = await opts.confirm(`${c.yellow("⚠")}  ${c.bold(tu.name)} ${c.dim(preview)} — run?`);
        if (!ok) {
          results.push({ id: tu.id, name: tu.name, content: "User denied this action.", isError: true });
          continue;
        }
      }
      out(c.dim(`  ↳ ${tu.name}\n`));
      try {
        const res = await tool.run(tu.input, ctx);
        results.push({ id: tu.id, name: tu.name, content: res });
      } catch (e: any) {
        results.push({ id: tu.id, name: tu.name, content: `Error: ${e.message}`, isError: true });
      }
    }
    history.push({ role: "tool", results });
  }
}
