import type { Provider, NeutralMsg, ToolResult } from "../providers/types.js";
import { getTool, toolSpecs, type Tool, type ToolContext } from "../tools/registry.js";
import { stdout } from "node:process";
import { c, out } from "../ui.js";
import { activity } from "../activity.js";
import { makeRenderer } from "../md.js";
import { skillsDigest } from "../skills/skills.js";
import { runHooks } from "../hooks.js";
import { mapLimit, maxParallel } from "../concurrency.js";
import type { ApprovalMode } from "../config.js";
import { decideCommand, loadPermissionRules } from "../security/permissions.js";
import { classifyRisk, guardianVeto, guardianEnabled, newBreaker, recordBlock, type BreakerState } from "../security/guardian.js";
import { subdirHint } from "../context/subdir-hints.js";
import { classifyError, failoverAction, errorHint } from "./failover.js";
import { currentTodos, type Todo } from "../tools/todo.js";

/** Spinner verb (terminal mode + reused by TUI tests): when the agent has an in_progress todo,
 *  surface its activeForm/text so the bottom-of-screen line reads concretely ("▶ updating tests… 3s")
 *  instead of "working 3s". Pure: takes a snapshot + elapsed seconds. */
export function spinnerVerb(list: Todo[], elapsedSec: number): string {
  const active = list.find((t) => t.status === "in_progress");
  if (active) {
    const phrase = active.activeForm?.trim() || active.text;
    return `${phrase}… ${elapsedSec}s`;
  }
  return `working ${elapsedSec}s`;
}

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
  /** Ad-hoc tools for THIS run only (e.g. plan mode's `exit_plan`) — appended AFTER toolFilter (so a
   *  filter can't accidentally drop them) and resolved BEFORE the registry on dispatch. Never
   *  registered globally, so other runs/modes can't see or call them. */
  extraTools?: Tool[];
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
  /** Guardian (internal safety layer): a deterministic HIGH-RISK classifier + a conservative cheap-model
   *  veto + a hard circuit-breaker, layered on top of permission rules / PreToolUse hooks / approval gate.
   *  `provider` is the cheap model used for the veto (fail-open if absent/glitchy). Normal (low-risk) tools
   *  never touch it — zero added latency. Absent → guardian off. */
  guardian?: { provider?: Provider | null; enabled?: boolean };
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

  // Guardian: engaged only on HIGH-RISK actions (see classifyRisk). `on` gates the whole layer so normal
  // work never pays for it; the breaker is per-run (a hard stop after repeated blocks).
  const guardianOn = !!opts.guardian && (opts.guardian.enabled ?? true) && guardianEnabled();
  const breaker: BreakerState = newBreaker();
  let breakerHalt = false; // set when a tripped breaker aborts this run

  for (;;) {
    // Type-ahead steering: fold in anything the user submitted while the previous step ran, so it
    // reaches the model on this next call (drained after the last tool round; empty on the 1st pass).
    if (opts.pendingInput) {
      for (const m of await opts.pendingInput()) history.push(m);
    }
    const baseSpecs = opts.toolFilter ? toolSpecs().filter((t) => opts.toolFilter!(t.name)) : toolSpecs();
    const specs = opts.extraTools?.length
      ? [...baseSpecs, ...opts.extraTools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }))]
      : baseSpecs;
    const sink = ctx.ui; // TUI mode: route output to ink instead of stdout
    const tty = stdout.isTTY && !opts.quiet && !sink;
    const md = tty && process.env.HARA_MD !== "0" ? makeRenderer(out) : null;
    // Reasoning rendering in plain-terminal mode: we put reasoning on its OWN dim lines (prefixed
    // "│ ") instead of sharing a line with the spinner — that's what was eating DeepSeek's
    // reasoning_content in non-TUI mode (each spinner tick `\r`-overwrote it). The TUI keeps its
    // existing 5-line scroll window via the ink Block; this is the terminal equivalent.
    let reasoningOpen = false;
    const flushReasoningTail = (): void => {
      if (reasoningOpen) {
        out("\n");
        reasoningOpen = false;
      }
    };
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
      spin = setInterval(() => {
        const verb = spinnerVerb(currentTodos(), Math.floor((Date.now() - t0) / 1000));
        out(`\r\x1b[K${c.dim(`${frames[fi++ % frames.length]} ${verb}`)}`);
      }, 100);
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
        flushReasoningTail();
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
              // Terminal mode: render reasoning on its own dim lines (prefix `│ ` per line). Each
              // line is committed once and never overwritten — so a subsequent spinner tick can't
              // clobber it (the old `out(c.dim(d))` bug). Multi-line deltas split cleanly; the
              // current line resumes mid-output when the next delta arrives.
              stopSpin();
              const lines = d.split("\n");
              for (let i = 0; i < lines.length; i++) {
                if (!reasoningOpen) {
                  out(c.dim("│ "));
                  reasoningOpen = true;
                }
                out(c.dim(lines[i]));
                if (i < lines.length - 1) {
                  out("\n");
                  reasoningOpen = false;
                }
              }
            }
          : undefined,
      signal: opts.signal,
    });
    stopSpin();
    flushReasoningTail();
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
    // Extra (per-run) tools win over the registry so a run-scoped tool can't be shadowed by a global one.
    const resolveTool = (name: string): Tool | undefined => opts.extraTools?.find((t) => t.name === name) ?? getTool(name);
    for (const tu of r.toolUses) {
      if (breakerHalt) {
        // Circuit-breaker halted the run: refuse every remaining call in this round with a clear message
        // (no hang, no further tools) so the model + user get a definitive stop.
        plans.push({ tu, tool: resolveTool(tu.name), denied: "Guardian circuit-breaker halted this run (too many high-risk actions blocked). Ask the user to review and re-run." });
        continue;
      }
      const tool = resolveTool(tu.name);
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
      // Guardian layer — runs AFTER permission rules, alongside/just before the confirm gate. The
      // deterministic classifier short-circuits FIRST: read tools, in-project edits, and ordinary shell
      // commands classify `low` (pure Node, no LLM) and skip everything below — zero added latency. Only a
      // genuinely HIGH-RISK action pays for a cheap-model veto, and that veto fails OPEN on any glitch.
      if (guardianOn && !breakerHalt) {
        const risk = classifyRisk(tu.name, tool.kind, input, ctx.cwd);
        if (risk.level === "high") {
          const detail = String(input.command ?? input.path ?? "").replace(/\s+/g, " ").trim().slice(0, 400);
          const verdict = await guardianVeto(
            opts.guardian!.provider,
            { tool: tu.name, detail, classifierReason: risk.reason },
            history,
            { signal: opts.signal },
          );
          if (verdict.decision === "block") {
            const tripped = recordBlock(breaker); // deterministic circuit-breaker: N blocks → hard stop
            plans.push({
              tu,
              tool,
              denied: `Guardian blocked this high-risk action: ${verdict.reason || risk.reason}. Reconsider — take a safer, in-scope step, or ask the user before doing this.`,
            });
            if (!opts.quiet) {
              const note = `⛔ guardian blocked ${tu.name} — ${verdict.reason || risk.reason}`;
              if (sink) sink.notice(note);
              else out(c.yellow(`  ${note}\n`));
            }
            if (tripped) {
              // Circuit-breaker tripped — a HARDER stop than the soft stuck-guard. On an INTERACTIVE run
              // (an `ask` channel exists), require an explicit human OK to continue. In headless/no-UI
              // (gateway/cron/-p, where `confirm` is auto-yes and there's no real user), abort SAFELY —
              // never auto-continue past the breaker, and never hang.
              const interactive = !!ctx.ask;
              const cont = interactive
                ? await opts.confirm(`${c.red("⛔ guardian circuit-breaker")} — ${breaker.blocks} high-risk actions blocked this turn. Continue anyway?`)
                : false;
              if (cont === false) {
                breakerHalt = true;
              } else {
                breaker.tripped = false;
                breaker.blocks = 0; // user vouched → reset the counter, keep classifying
              }
            }
            continue;
          }
        }
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

    if (breakerHalt) {
      // A tripped-and-declined circuit-breaker is a hard stop: end the run cleanly (the denial messages are
      // already in `results` so the model/user see why). Never spin further.
      if (!opts.quiet) {
        const note = "⛔ guardian circuit-breaker: run halted (too many high-risk actions blocked). Review and re-run.";
        if (sink) sink.notice(note);
        else out(c.red(`${note}\n`));
      }
      return;
    }

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
