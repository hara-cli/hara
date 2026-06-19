// Persistent bottom status bar for the REPL — pins a footer (session name · 3 approval modes ·
// live token usage + ctx% · concurrent-op count) below a scrolling transcript, using a terminal
// scroll region (DECSTBM). TTY-only; on a non-TTY it stays inactive and the caller falls back to
// the plain after-turn status line. The `footerLines` composer is pure, for tests.
import { stdout } from "node:process";
import { c } from "./ui.js";
import { activity } from "./activity.js";
import type { ApprovalMode } from "./config.js";

export const MODES: ApprovalMode[] = ["suggest", "auto-edit", "full-auto"];
const FOOTER_H = 2;

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

/** Pure footer composer — two lines, fit to `cols`, with `agents` concurrent ops. */
export function footerLines(s: BarState, cols: number, agents: number): string[] {
  const sel = MODES.map((m) => (m === s.approval ? c.green(c.bold(`◆${m}`)) : c.dim(m))).join("  ");
  const name = truncate(s.sessionName || "new session", Math.max(8, cols - vlen(stripAnsi(sel)) - 8));
  const line1 = ` ${c.cyan("⏺")} ${c.bold(name)}   ${sel}`;
  const ctx = s.ctxPct > 0 ? ` · ctx ${s.ctxPct}%` : "";
  const usage = c.dim(`↑${fmtTok(s.input)} ↓${fmtTok(s.output)}${ctx}`);
  const ag = agents > 0 ? c.yellow(`⛁ ${agents} agents`) : c.dim("⛁ 0 agents");
  const line2 = padBetween(` ${usage}`, `${ag} `, cols);
  return [line1, line2];
}

const w = (s: string): void => {
  try {
    stdout.write(s);
  } catch {
    /* ignore write errors (closed pipe, etc.) */
  }
};
const rows = (): number => stdout.rows ?? 24;
const cols = (): number => stdout.columns ?? 80;

function setupRegion(): void {
  const r = rows();
  w("\n".repeat(FOOTER_H)); // make room at the bottom (scrolls existing content up)
  w(`\x1b[1;${r - FOOTER_H}r`); // scroll region = rows 1..(r-FOOTER_H)
  w(`\x1b[${r - FOOTER_H};1H`); // park cursor just above the footer
}

function onResize(): void {
  if (!active) return;
  setupRegion();
  redraw();
}

export function redraw(): void {
  if (!active) return;
  const r = rows();
  const lines = footerLines(state, cols(), activity.running);
  w("\x1b7"); // save cursor
  for (let i = 0; i < FOOTER_H; i++) {
    w(`\x1b[${r - FOOTER_H + 1 + i};1H\x1b[2K`); // move to footer row i, clear it
    w(lines[i] ?? "");
  }
  w("\x1b8"); // restore cursor
}

export function update(partial: Partial<BarState>): void {
  state = { ...state, ...partial };
  redraw();
}

export function install(initial: Partial<BarState>): void {
  state = { ...state, ...initial };
  if (process.env.HARA_FOOTER === "0" || !stdout.isTTY || rows() < FOOTER_H + 3) {
    active = false;
    return;
  }
  active = true;
  setupRegion();
  activity.onChange(redraw);
  stdout.on("resize", onResize);
  redraw();
}

export function uninstall(): void {
  if (!active) return;
  active = false;
  activity.onChange(null);
  stdout.removeListener("resize", onResize);
  const r = rows();
  w(`\x1b[${r - FOOTER_H + 1};1H\x1b[2K\x1b[${r};1H\x1b[2K`); // clear footer rows
  w("\x1b[r"); // reset scroll region to full screen
  w(`\x1b[${r - FOOTER_H + 1};1H`); // cursor back to where flow was
}

export const isActive = (): boolean => active;

/** Next approval mode in the cycle (for shift+tab / bare /approval). */
export function nextMode(m: ApprovalMode): ApprovalMode {
  return MODES[(MODES.indexOf(m) + 1) % MODES.length];
}
