import type { Provider, NeutralMsg, ToolResult } from "../providers/types.js";
import { getTool, toolSpecs, type ToolContext } from "../tools/registry.js";
import { stdout } from "node:process";
import { c, out } from "../ui.js";
import { activity } from "../activity.js";
import { makeRenderer } from "../md.js";
import { skillsDigest } from "../skills/skills.js";
import { runHooks } from "../hooks.js";
import { mapLimit, maxParallel } from "../concurrency.js";
import type { ApprovalMode } from "../config.js";

/** Whether a tool call needs user confirmation under the given approval mode. */
export function needsConfirm(kind: string | undefined, mode: ApprovalMode): boolean {
  if (kind === "read") return false;
  if (kind === "computer") return true; // screen control always needs a session grant (even full-auto)
  if (mode === "full-auto") return false;
  if (mode === "auto-edit") return kind === "exec";
  return true; // suggest: confirm edits and exec
}

const HARA_SYSTEM = (cwd: string) =>
  `You are hara, a coding agent running in the user's terminal.
Working directory: ${cwd}
Be concise and direct. Use the provided tools to read files, edit/write files, and run shell
commands. Prefer small, verifiable steps; edit existing files with edit_file rather than rewriting
them whole. For a multi-step task, call \`todo_write\` to plan a short checklist and keep it updated as
you go (one item in_progress at a time) — skip it for trivial one-step tasks. You have a persistent
memory: use memory_search before answering about prior decisions,
conventions, or the user's preferences, and memory_write to proactively save durable facts you learn.
When a task matches one of the Skills listed below, call the \`skill\` tool to load its full instructions
before acting; save a reusable how-to as a new skill with skill_create. If you discover a durable project
convention, you may propose an edit to AGENTS.md via edit_file (the user reviews the diff). After completing
a task, give a one-line summary.`;

function composeSystem(cwd: string, projectContext?: string, override?: string, memory?: string): string {
  const head = override ? `${override}\n\nWorking directory: ${cwd}` : HARA_SYSTEM(cwd);
  const skills = skillsDigest(cwd);
  return (
    head +
    (projectContext ? `\n\n# Project context (AGENTS.md)\n${projectContext}` : "") +
    (memory ? `\n\n# Memory (durable — facts/decisions/prefs you've saved; use memory_search/get for more)\n${memory}` : "") +
    (skills ? `\n\n# Skills (capabilities you can load — call the \`skill\` tool with the id for full instructions before using one)\n${skills}` : "")
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
  /** Type-ahead steering (TUI): pull messages the user submitted *while this turn was running* and
   *  inject them before the next model call — so an addition/clarification reaches the model mid-task
   *  (codex-style) instead of waiting for the turn to end. Returns image-resolved user messages, or []. */
  pendingInput?: () => Promise<NeutralMsg[]>;
}

/** Provider-agnostic agentic loop. Mutates `history` in place. */
export async function runAgent(history: NeutralMsg[], opts: RunOpts): Promise<void> {
  const { provider, ctx } = opts;

  for (;;) {
    // Type-ahead steering: fold in anything the user submitted while the previous step ran, so it
    // reaches the model on this next call (drained after the last tool round; empty on the 1st pass).
    if (opts.pendingInput) {
      for (const m of await opts.pendingInput()) history.push(m);
    }
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
      // Screen control is gated on EVERY action — a prior "don't ask again" must never satisfy it.
      const alwaysGate = tool.kind === "computer";
      if (needsConfirm(tool.kind, opts.approval) && (alwaysGate || !opts.autoApprove?.has(tu.name))) {
        const reply = await opts.confirm(`${c.yellow("⚠")}  ${c.bold(tu.name)} ${c.dim(preview)} — run?`);
        if (reply === false) {
          plans.push({ tu, tool, denied: "User denied this action." });
          continue;
        }
        if (reply === "always" && !alwaysGate) opts.autoApprove?.add(tu.name); // computer: treat "always" as one-time yes
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
        const pre = runHooks("PreToolUse", p.tu.name, p.tu.input, ctx.cwd); // a hook may veto the call
        if (pre.block) {
          results[idx] = { id: p.tu.id, name: p.tu.name, content: pre.message, isError: true };
          return;
        }
        const res = await p.tool!.run(p.tu.input, ctx);
        results[idx] = { id: p.tu.id, name: p.tu.name, content: res };
        runHooks("PostToolUse", p.tu.name, { input: p.tu.input, result: res }, ctx.cwd); // observe-only
      } catch (e: any) {
        results[idx] = { id: p.tu.id, name: p.tu.name, content: `Error: ${e.message}`, isError: true };
      } finally {
        activity.dec();
      }
    };
    let batch: number[] = []; // indices of pending read-kind tools (run concurrently, capped)
    const flush = async (): Promise<void> => {
      if (!batch.length) return;
      const idx = batch;
      batch = [];
      await mapLimit(idx, maxParallel(), (i) => runOne(i, plans[i])); // bounded fan-out (e.g. 20 parallel agents → 8 at a time)
    };
    for (let i = 0; i < plans.length; i++) {
      const p = plans[i];
      if (p.denied === undefined && p.tool?.kind === "read") {
        batch.push(i); // safe → accumulate to run concurrently
      } else {
        await flush(); // flush pending reads before an edit/exec
        await runOne(i, p);
      }
    }
    await flush();
    history.push({ role: "tool", results });
  }
}
