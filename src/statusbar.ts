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
  /** Active identity profile id ("personal" / "default-org" / …). Empty = legacy/no-profile build. */
  profileId?: string;
  /** Profile kind controls the badge color and label in the bottom border. */
  profileKind?: "byok" | "gateway";
}

let state: BarState = { sessionName: "new session", model: "", approval: "suggest", input: 0, output: 0, ctxPct: 0 };
let active = false;

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const vlen = (s: string): number => stripAnsi(s).length;
const fmtTok = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);
const truncate = (s: string, max: number): string => (s.length <= max ? s : s.slice(0, Math.max(0, max - 1)) + "…");
const rule = (n: number): string => c.dim("─".repeat(Math.max(0, n)));

export function contextWindow(model: string): number {
  // Provider prefixes are common (`qwen/qwen3.7-plus`). Match the actual model id and prefer exact
  // documented Coding Plan families over broad words such as "coder"/"max": those previously labeled
  // qwen3-coder-next and qwen3-max as 1M, causing the context guard to overfeed their 262k windows.
  const m = model.toLowerCase().split("/").at(-1) ?? model.toLowerCase();
  if (/haiku/.test(m)) return 200_000;
  if (/^qwen3\.[567]-plus(?:-|$)/.test(m) || /^qwen3-coder-plus(?:-|$)/.test(m)) return 1_000_000;
  if (/^(?:qwen3-max-2026-01-23|qwen3-coder-next)(?:-|$)/.test(m) || /^kimi-k2\.5(?:-|$)/.test(m)) return 262_144;
  if (/^glm-(?:5|4\.7)(?:-|$)/.test(m)) return 202_752;
  if (/^minimax-m2\.5(?:-|$)/.test(m)) return 196_608;
  if (/qwen3\.6[-:]27b/.test(m)) return 262_144;
  if (/(opus|sonnet|fable)|claude-4|1m/.test(m)) return 1_000_000;
  return 200_000;
}
export const ctxPctFor = (model: string, lastInput: number): number =>
  lastInput > 0 ? Math.min(99, Math.round((lastInput / contextWindow(model)) * 100)) : 0;

/** Top border with the session name in the right corner: `────── [profile] ⏺ session ─`.
 *  The profile chip on the left flank surfaces "which identity am I as right now". gateway
 *  profiles get a cyan ORG badge (drawing the eye — your traffic is going somewhere else),
 *  personal/byok profiles get a dim badge so they fade into the background. */
export function borderTop(s: BarState, cols: number): string {
  const name = truncate(s.sessionName || "new session", Math.max(8, cols - 14));
  const right = `${c.cyan("⏺")} ${c.bold(name)}`;
  const chip = s.profileId
    ? (s.profileKind === "gateway" ? c.cyan(`[${s.profileId} · ORG]`) : c.dim(`[${s.profileId}]`))
    : "";
  const left = chip ? chip + " " : "";
  const innerLen = vlen(left) + vlen(right);
  const pad = Math.max(0, cols - innerLen - 4);
  return rule(1) + " " + left + rule(pad) + " " + right + " " + rule(1);
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
