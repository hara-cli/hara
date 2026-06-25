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
import { decideCommand, loadPermissionRules } from "../security/permissions.js";
import { subdirHint } from "../context/subdir-hints.js";
import { classifyError, failoverAction, errorHint } from "./failover.js";

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

/** When running inside `hara gateway`, tell the agent it's in a chat — so it delivers files via send_file
 *  (the only channel that reaches the peer) and never reaches for the desktop client / computer tool. */
function gatewayNote(): string {
  const plat = process.env.HARA_GATEWAY;
  if (!plat) return "";
  return (
    `\n\n# You are in a chat gateway (${plat})\n` +
    `You are talking to the user through the ${plat} chat — not a terminal, and NOT the desktop ${plat} app. ` +
    `To send a file or image to them, call the \`send_file\` tool with an absolute path; that is the ONLY channel ` +
    `that reaches this chat. Do NOT use the \`computer\` tool, AppleScript, or any desktop/${plat}-client automation ` +
    `to deliver files — that drives a different window and silently fails to reach the user. Never tell the user a ` +
    `file was sent unless \`send_file\` returned success. Keep replies short and chat-friendly.`
  );
}

function composeSystem(cwd: string, projectContext?: string, override?: string, memory?: string): string {
  const head = override ? `${override}\n\nWorking directory: ${cwd}` : HARA_SYSTEM(cwd);
  const skills = skillsDigest(cwd);
  return (
    head +
    gatewayNote() +
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
  /** App-level failover (wired only at the main chat entry): retry an errored, recoverable turn once on a
   *  fallback-model `provider` (overload / rate-limit / timeout / context-overflow → a different model). */
  fallback?: { provider?: Provider };
}

/** Provider-agnostic agentic loop. Mutates `history` in place. */
export async function runAgent(history: NeutralMsg[], opts: RunOpts): Promise<void> {
  const { provider, ctx } = opts;
  const permRules = loadPermissionRules(ctx.cwd); // command-level allow/ask/deny policy for the bash tool
  let activeProvider = provider; // may switch to a fallback model on a recoverable error (app-failover)
  let triedFallback = false;

  // Stuck/loop guard — only in headless chat (`hara gateway`), where a wrong approach can grind forever with
  // nobody to hit Esc (e.g. screenshots it can't read). Once per run, when the agent keeps repeating one
  // non-read tool or acting blind, we inject a reflection nudge so it steps back instead of spinning.
  const guard = !!process.env.HARA_GATEWAY;
  const toolCounts = new Map<string, number>();
  let blindShots = 0;
  let nudged = false;

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
    const r = await activeProvider.turn({
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
      const kind = classifyError(r.errorMsg ?? "");
      if (failoverAction(kind, { hasFallback: !!opts.fallback?.provider, triedFallback }) === "fallback") {
        triedFallback = true;
        history.pop(); // drop the errored (partial/empty) assistant turn before retrying
        activeProvider = opts.fallback!.provider!;
        if (!opts.quiet) {
          const note = `✻ ${kind} → falling back to ${activeProvider.model}…`;
          if (sink) sink.notice(note);
          else out(c.dim(`${note}\n`));
        }
        continue; // retry once on the fallback model (guarded by triedFallback)
      }
      const msg = kind === "interrupted" ? "(interrupted)" : `[${activeProvider.id} error] ${r.errorMsg ?? "unknown"}${errorHint(kind)}`;
      if (!opts.quiet) {
        if (sink) sink.notice(msg);
        else out(kind === "interrupted" ? c.dim(`\n${msg}\n`) : c.red(`${msg}\n`));
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
      // Command-level policy for shell commands: a deny rule blocks even in full-auto; an allow rule (or a
      // read-only command) auto-runs even in suggest mode. Composes with, doesn't replace, the approval mode.
      const cmdDecision = tool.kind === "exec" && typeof input.command === "string" ? decideCommand(input.command, permRules) : null;
      if (cmdDecision === "deny") {
        plans.push({ tu, tool, denied: "Denied by a permission rule (~/.hara/permissions.json). Loosen the rule or run it yourself." });
        continue;
      }
      if (cmdDecision !== "allow" && needsConfirm(tool.kind, opts.approval) && (alwaysGate || !opts.autoApprove?.has(tu.name))) {
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
        // append any not-yet-seen subdirectory AGENTS.md/CLAUDE.md this call touched (monorepo-local conventions)
        results[idx] = { id: p.tu.id, name: p.tu.name, content: res + subdirHint(p.tu.input, ctx.cwd) };
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

    if (guard && !nudged) {
      for (const p of plans) if (p.tool && p.tool.kind !== "read") toolCounts.set(p.tu.name, (toolCounts.get(p.tu.name) ?? 0) + 1);
      for (const res of results) if (typeof res.content === "string" && /Configure a vision model/.test(res.content)) blindShots++;
      const maxRepeat = Math.max(0, ...toolCounts.values());
      const blind = blindShots >= 2;
      if (blind || maxRepeat >= 5) {
        nudged = true;
        history.push({
          role: "user",
          content: blind
            ? "⚠ Self-check: your screenshots come back unreadable (no vision model) — you are acting blind, so this approach cannot work. Stop using the computer tool. Reach the user through a non-visual path instead (a CLI, an API, or the send_file tool). State the new plan in one line, then do it."
            : "⚠ Self-check: you've repeated the same action several times without resolving the task. Stop and reconsider — is there a more direct tool or channel (e.g. send_file to deliver a file)? Don't keep retrying the same thing. State your revised plan in one line, then act.",
        });
        if (!opts.quiet && !ctx.ui) out(c.dim("  ⟲ stuck-guard: nudging a rethink\n"));
      }
    }
  }
}
