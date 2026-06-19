// REPL status line — session name · the 3 approval modes (current highlighted) · token usage + ctx%
// · concurrent-op count. Rendered as a header just above each prompt (call `render()` per loop turn).
//
// NOTE: an earlier version tried to PIN this to the terminal bottom via a scroll region (DECSTBM),
// but Node's `readline` doesn't know about reserved rows, so it didn't render reliably. True bottom
// pinning needs a full TUI (ink/ratatui) — a separate effort. A per-prompt header is robust and works
// everywhere. The `footerLines` composer is pure, for tests.
import { stdout } from "node:process";
import { c } from "./ui.js";
import { activity } from "./activity.js";
import type { ApprovalMode } from "./config.js";

export const MODES: ApprovalMode[] = ["suggest", "auto-edit", "full-auto"];

export interface BarState {
  sessionName: string;
  model: string;
  approval: ApprovalMode;
  input: number;
  output: number;
  ctxPct: number;
}

let state: BarState = { sessionName: "new session", model: "", approval: "suggest", input: 0, output: 0, ctxPct: 0 };
let active = false;

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const vlen = (s: string): number => stripAnsi(s).length;
const fmtTok = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);
const truncate = (s: string, max: number): string => (s.length <= max ? s : s.slice(0, Math.max(0, max - 1)) + "…");

function padBetween(left: string, right: string, cols: number): string {
  const gap = Math.max(1, cols - vlen(left) - vlen(right));
  return left + " ".repeat(gap) + right;
}

/** Rough context-window estimate for the ctx% gauge (UI hint only; not authoritative). */
export function contextWindow(model: string): number {
  const m = model.toLowerCase();
  if (/haiku/.test(m)) return 200_000;
  if (/(opus|sonnet|fable)|claude-4|qwen3|glm-[45]|max-2026|coder|1m/.test(m)) return 1_000_000;
  return 200_000;
}
export const ctxPctFor = (model: string, lastInput: number): number =>
  lastInput > 0 ? Math.min(99, Math.round((lastInput / contextWindow(model)) * 100)) : 0;

/** Pure status composer — two lines fit to `cols`, with `agents` concurrent ops. */
export function footerLines(s: BarState, cols: number, agents: number): string[] {
  const sel = MODES.map((m) => (m === s.approval ? c.green(c.bold(`◆${m}`)) : c.dim(m))).join("  ");
  const name = truncate(s.sessionName || "new session", Math.max(8, cols - vlen(stripAnsi(sel)) - 8));
  const line1 = ` ${c.cyan("⏺")} ${c.bold(name)}   ${sel}`;
  const ctx = s.ctxPct > 0 ? ` · ctx ${s.ctxPct}%` : "";
  const usage = c.dim(`↑${fmtTok(s.input)} ↓${fmtTok(s.output)}${ctx}`);
  const ag = agents > 0 ? c.yellow(`⛁ ${agents} agents`) : c.dim("⛁ idle");
  const line2 = padBetween(` ${usage}`, `${ag} `, cols);
  return [line1, line2];
}

export function install(initial: Partial<BarState>): void {
  state = { ...state, ...initial };
  active = process.env.HARA_FOOTER !== "0" && !!stdout.isTTY;
}

export function update(partial: Partial<BarState>): void {
  state = { ...state, ...partial };
}

/** Print the status header above the next prompt (call once per REPL loop iteration). */
export function render(): void {
  if (!active) return;
  const lines = footerLines(state, stdout.columns ?? 80, activity.running);
  try {
    stdout.write(c.dim("─".repeat(Math.min(stdout.columns ?? 80, 60))) + "\n" + lines.join("\n") + "\n");
  } catch {
    /* ignore write errors */
  }
}

export const isActive = (): boolean => active;
export function uninstall(): void {
  /* no-op (header model — nothing pinned to tear down) */
}

/** Next approval mode in the cycle (for shift+tab / bare /approval). */
export function nextMode(m: ApprovalMode): ApprovalMode {
  return MODES[(MODES.indexOf(m) + 1) % MODES.length];
}
