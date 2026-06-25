// tmux reply routing — lets a chat reply (WeChat) be injected back into an already-running tmux session
// (e.g. a Claude Code / codex / hara you started yourself), so "ping me on WeChat → I reply from outside →
// that session continues" works WITHOUT the daemon owning the process. The asking session registers its tmux
// pane (via the wechat-send `--ask` flow); the gateway daemon (sole WeChat receiver) injects the owner's reply
// into the oldest live registered pane with `tmux send-keys`. Borrows the ccgram keystroke-injection pattern.
//
// Safety: the daemon only reaches this AFTER its allow-list gate (so only the owner can trigger it), and it
// ONLY injects into panes that opted in by registering — never an arbitrary pane.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";

export interface TmuxRoute {
  pane: string; // tmux pane id, e.g. "%3" or "sess:0.1"
  peer?: string; // the chat peer that should answer (informational; matching is owner-gated upstream)
  cwd?: string;
  ts: number;
  /** "once" (default) = consumed after one injected reply; "bind" = persistent, every reply injects until unbound. */
  mode?: "once" | "bind";
}

function dir(): string {
  return join(homedir(), ".hara", "gateway");
}
function storePath(): string {
  return join(dir(), "tmux-routes.json");
}

function load(): TmuxRoute[] {
  try {
    const j = JSON.parse(readFileSync(storePath(), "utf8"));
    return Array.isArray(j?.routes) ? j.routes : [];
  } catch {
    return [];
  }
}
function save(routes: TmuxRoute[]): void {
  mkdirSync(dir(), { recursive: true });
  writeFileSync(storePath(), JSON.stringify({ routes }, null, 2));
}

/** Register (or refresh) a pane as awaiting a reply. De-dups by pane. mode "once" (default) = consumed after one
 *  reply; "bind" = persistent (every reply injects until unbound). */
export function registerTmuxRoute(pane: string, peer?: string, cwd?: string, mode: "once" | "bind" = "once", now = Date.now()): void {
  const routes = load().filter((r) => r.pane !== pane);
  routes.push({ pane, peer, cwd, ts: now, mode });
  save(routes);
}

/** Remove a pane's route(s). Returns how many were removed. */
export function unbindPane(pane: string): number {
  const before = load();
  const after = before.filter((r) => r.pane !== pane);
  save(after);
  return before.length - after.length;
}

/** All current routes (for `hara remote status`). */
export function listRoutes(): TmuxRoute[] {
  return load();
}

/** Remove all persistent "bind" routes (the chat `/detach` command). Returns how many were removed. */
export function unbindBinds(): number {
  const before = load();
  const after = before.filter((r) => r.mode === "bind" ? false : true);
  save(after);
  return before.length - after.length;
}

/** Pure: pick the OLDEST live registered pane (FIFO — the longest-waiting ask answers first); return it plus the
 *  routes to keep. A "once" route is consumed after use; a "bind" route persists. Dead panes are always pruned. */
export function pickRoute(routes: TmuxRoute[], isAlive: (pane: string) => boolean): { chosen: TmuxRoute | null; remaining: TmuxRoute[] } {
  const live = routes.filter((r) => isAlive(r.pane)).sort((a, b) => a.ts - b.ts);
  const chosen = live[0] ?? null;
  const remaining = chosen && chosen.mode !== "bind" ? live.filter((r) => r.pane !== chosen.pane) : live;
  return { chosen, remaining };
}

/** Is this tmux pane still alive? Checks membership in `list-panes -a` (display-message -t is too lenient and
 *  falls back to the active pane for a bogus target). false if tmux isn't running or the pane is gone. */
export function paneAlive(pane: string): boolean {
  try {
    const out = execFileSync("tmux", ["list-panes", "-a", "-F", "#{pane_id}"], { encoding: "utf8", timeout: 3000 });
    return out.split("\n").map((s) => s.trim()).includes(pane);
  } catch {
    return false;
  }
}

/** Type `text` into a tmux pane as if the user typed it, then press Enter (submits the line / sends the turn). */
export function injectTmux(pane: string, text: string): void {
  execFileSync("tmux", ["send-keys", "-t", pane, "-l", "--", text], { timeout: 3000 });
  execFileSync("tmux", ["send-keys", "-t", pane, "Enter"], { timeout: 3000 });
}

/** Daemon entrypoint: deliver an inbound reply to the oldest live registered pane. Returns the pane id injected
 *  into, or null if there was no pending route (→ caller treats the message as a normal task). One-shot: the
 *  chosen route is consumed and dead panes are pruned. */
export function deliverToTmux(text: string): string | null {
  const { chosen, remaining } = pickRoute(load(), paneAlive);
  save(remaining);
  if (!chosen) return null;
  try {
    injectTmux(chosen.pane, text);
    return chosen.pane;
  } catch {
    return null;
  }
}
