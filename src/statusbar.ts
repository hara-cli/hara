// REPL input frame — a border line above and below the prompt, session name in the top-right,
// mode/tokens/concurrency in the bottom border. Drawn around the readline prompt (plain printed
// lines — no scroll region, works everywhere). `borderTop`/`borderBottom` are pure, for tests.
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
const rule = (n: number): string => c.dim("─".repeat(Math.max(0, n)));

export function contextWindow(model: string): number {
  const m = model.toLowerCase();
  if (/haiku/.test(m)) return 200_000;
  if (/(opus|sonnet|fable)|claude-4|qwen3|glm-[45]|max-2026|coder|1m/.test(m)) return 1_000_000;
  return 200_000;
}
export const ctxPctFor = (model: string, lastInput: number): number =>
  lastInput > 0 ? Math.min(99, Math.round((lastInput / contextWindow(model)) * 100)) : 0;

/** Top border with the session name in the right corner: `────────── ⏺ session ─` */
export function borderTop(s: BarState, cols: number): string {
  const name = truncate(s.sessionName || "new session", Math.max(8, cols - 14));
  const label = `${c.cyan("⏺")} ${c.bold(name)}`;
  return rule(cols - vlen(label) - 3) + " " + label + " " + rule(1);
}

/** Bottom border carrying mode · tokens · concurrency: `── ◆suggest auto-edit full-auto · ↑0 ↓0 · ⛁ ──` */
export function borderBottom(s: BarState, cols: number, agents: number): string {
  const sel = MODES.map((m) => (m === s.approval ? c.green(`◆${m}`) : c.dim(m))).join(" ");
  const ctx = s.ctxPct > 0 ? ` · ctx ${s.ctxPct}%` : "";
  const ag = agents > 0 ? c.yellow(`⛁${agents}`) : c.dim("⛁");
  const info = `${sel} ${c.dim("·")} ${c.dim(`↑${fmtTok(s.input)} ↓${fmtTok(s.output)}${ctx}`)} ${c.dim("·")} ${ag}`;
  return rule(2) + " " + info + " " + rule(cols - vlen(info) - 4);
}

export function install(initial: Partial<BarState>): void {
  state = { ...state, ...initial };
  active = process.env.HARA_FOOTER !== "0" && !!stdout.isTTY;
}
export function update(partial: Partial<BarState>): void {
  state = { ...state, ...partial };
}
const w = (s: string): void => {
  try {
    stdout.write(s);
  } catch {
    /* ignore */
  }
};
/** Top border — call right before the prompt. */
export function renderTop(): void {
  if (active) w(borderTop(state, stdout.columns ?? 80) + "\n");
}
/** Bottom border — call right after the prompt is submitted. */
export function renderBottom(): void {
  if (active) w(borderBottom(state, stdout.columns ?? 80, activity.running) + "\n");
}
export const isActive = (): boolean => active;
export function uninstall(): void {
  /* no-op (border model — nothing pinned) */
}
export function nextMode(m: ApprovalMode): ApprovalMode {
  return MODES[(MODES.indexOf(m) + 1) % MODES.length];
}
