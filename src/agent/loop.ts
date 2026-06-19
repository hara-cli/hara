import type { Provider, NeutralMsg, ToolResult } from "../providers/types.js";
import { getTool, toolSpecs, type ToolContext } from "../tools/registry.js";
import { stdout } from "node:process";
import { c, out } from "../ui.js";
import { activity } from "../activity.js";
import { makeRenderer } from "../md.js";
import type { ApprovalMode } from "../config.js";

/** Whether a tool call needs user confirmation under the given approval mode. */
export function needsConfirm(kind: string | undefined, mode: ApprovalMode): boolean {
  if (kind === "read") return false;
  if (mode === "full-auto") return false;
  if (mode === "auto-edit") return kind === "exec";
  return true; // suggest: confirm edits and exec
}

const HARA_SYSTEM = (cwd: string) =>
  `You are hara, a coding agent running in the user's terminal.
Working directory: ${cwd}
Be concise and direct. Use the provided tools to read files, edit/write files, and run shell
commands. Prefer small, verifiable steps; edit existing files with edit_file rather than rewriting
them whole. You have a persistent memory: use memory_search before answering about prior decisions,
conventions, or the user's preferences, and memory_write to proactively save durable facts you learn.
After completing a task, give a one-line summary.`;

function composeSystem(cwd: string, projectContext?: string, override?: string, memory?: string): string {
  const head = override ? `${override}\n\nWorking directory: ${cwd}` : HARA_SYSTEM(cwd);
  return (
    head +
    (projectContext ? `\n\n# Project context (AGENTS.md)\n${projectContext}` : "") +
    (memory ? `\n\n# Memory (durable — facts/decisions/prefs you've saved; use memory_search/get for more)\n${memory}` : "")
  );
}

export interface RunOpts {
  provider: Provider;
  ctx: ToolContext;
  approval: ApprovalMode;
  confirm: (q: string) => Promise<boolean | "always">;
  /** tool names auto-approved for the rest of the session (chosen via "don't ask again") */
  autoApprove?: Set<string>;
  projectContext?: string;
  /** durable memory digest injected into the system prompt (frozen snapshot) */
  memory?: string;
  stats?: { input: number; output: number; lastInput?: number };
  /** role persona used instead of the default hara system prompt */
  systemOverride?: string;
  /** restrict which tools this run may use (by name) */
  toolFilter?: (name: string) => boolean;
  /** abort the in-flight LLM request (user interrupt) */
  signal?: AbortSignal;
  /** suppress streaming/tool output (sub-agents running in parallel) */
  quiet?: boolean;
}

/** Provider-agnostic agentic loop. Mutates `history` in place. */
export async function runAgent(history: NeutralMsg[], opts: RunOpts): Promise<void> {
  const { provider, ctx } = opts;

  for (;;) {
    const specs = opts.toolFilter ? toolSpecs().filter((t) => opts.toolFilter!(t.name)) : toolSpecs();
    const sink = ctx.ui; // TUI mode: route output to ink instead of stdout
    const tty = stdout.isTTY && !opts.quiet && !sink;
    const md = tty && process.env.HARA_MD !== "0" ? makeRenderer(out) : null;
    let sawReasoning = false;
    // "working Ns" spinner until the first output arrives (cleared on text/reasoning or turn end)
    let spin: ReturnType<typeof setInterval> | null = null;
    const stopSpin = (): void => {
      if (spin) {
        clearInterval(spin);
        spin = null;
        out("\r\x1b[K");
      }
    };
    if (tty) {
      const frames = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
      const t0 = Date.now();
      let fi = 0;
      spin = setInterval(() => out(`\r${c.dim(`${frames[fi++ % frames.length]} working ${Math.floor((Date.now() - t0) / 1000)}s`)}`), 100);
    }
    const r = await provider.turn({
      system: composeSystem(ctx.cwd, opts.projectContext, opts.systemOverride, opts.memory),
      history,
      tools: specs,
      onText: (d) => {
        if (opts.quiet) return;
        if (sink) {
          sink.text(d);
          return;
        }
        stopSpin();
        if (sawReasoning) {
          out("\n");
          sawReasoning = false;
        }
        if (md) md.push(d);
        else out(d);
      },
      onReasoning:
        sink || tty
          ? (d) => {
              if (opts.quiet) return;
              if (sink) {
                sink.reasoning(d);
                return;
              }
              stopSpin();
              sawReasoning = true;
              out(c.dim(d));
            }
          : undefined,
      signal: opts.signal,
    });
    stopSpin();
    md?.end();
    if (!opts.quiet && !sink) out("\n");
    if (r.usage && opts.stats) {
      opts.stats.input += r.usage.input;
      opts.stats.output += r.usage.output;
      opts.stats.lastInput = r.usage.input;
    }
    history.push({ role: "assistant", text: r.text, toolUses: r.toolUses });

    if (r.stop === "error") {
      const msg = r.errorMsg === "interrupted" ? "(interrupted)" : `[${provider.id} error] ${r.errorMsg ?? "unknown"}`;
      if (!opts.quiet) {
        if (sink) sink.notice(msg);
        else out(r.errorMsg === "interrupted" ? c.dim(`\n${msg}\n`) : c.red(`${msg}\n`));
      }
      return;
    }
    if (r.stop !== "tool_use") return;

    // Resolve + gate each call first (confirmations must be sequential — can't prompt in parallel).
    interface Plan {
      tu: (typeof r.toolUses)[number];
      tool: ReturnType<typeof getTool>;
      denied?: string;
    }
    const plans: Plan[] = [];
    for (const tu of r.toolUses) {
      const tool = getTool(tu.name);
      if (!tool) {
        plans.push({ tu, tool: undefined, denied: `Unknown tool: ${tu.name}` });
        continue;
      }
      const input = tu.input as Record<string, unknown>;
      const preview = String(input.path ?? input.command ?? input.pattern ?? input.url ?? input.task ?? "")
        .replace(/\s+/g, " ")
        .trim();
      if (needsConfirm(tool.kind, opts.approval) && !opts.autoApprove?.has(tu.name)) {
        const reply = await opts.confirm(`${c.yellow("⚠")}  ${c.bold(tu.name)} ${c.dim(preview)} — run?`);
        if (reply === false) {
          plans.push({ tu, tool, denied: "User denied this action." });
          continue;
        }
        if (reply === "always") opts.autoApprove?.add(tu.name);
      }
      plans.push({ tu, tool });
      if (!opts.quiet) {
        const pv = preview ? preview.slice(0, 80) : "";
        if (sink) sink.tool(tu.name, pv);
        else out(c.dim(`  ↳ ${tu.name}${pv ? " " + pv : ""}\n`));
      }
    }

    // Execute: read-only tools run concurrently; edit/exec run alone, in order.
    const results: ToolResult[] = new Array(plans.length);
    const runOne = async (idx: number, p: Plan): Promise<void> => {
      if (p.denied !== undefined) {
        results[idx] = { id: p.tu.id, name: p.tu.name, content: p.denied, isError: true };
        return;
      }
      activity.inc();
      try {
        const res = await p.tool!.run(p.tu.input, ctx);
        results[idx] = { id: p.tu.id, name: p.tu.name, content: res };
      } catch (e: any) {
        results[idx] = { id: p.tu.id, name: p.tu.name, content: `Error: ${e.message}`, isError: true };
      } finally {
        activity.dec();
      }
    };
    let batch: Promise<void>[] = [];
    for (let i = 0; i < plans.length; i++) {
      const p = plans[i];
      if (p.denied === undefined && p.tool?.kind === "read") {
        batch.push(runOne(i, p)); // safe → accumulate to run concurrently
      } else {
        if (batch.length) {
          await Promise.all(batch); // flush pending reads before an edit/exec
          batch = [];
        }
        await runOne(i, p);
      }
    }
    await Promise.all(batch);
    history.push({ role: "tool", results });
  }
}
