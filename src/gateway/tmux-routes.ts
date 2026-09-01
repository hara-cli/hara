// Explicit tmux reply routing — lets `/remote send <message>` inject into an already-running tmux session
// (e.g. Claude Code / Codex / Hara started by the user) without the gateway owning that process. The asking
// session registers its pane, and only the namespaced gateway command may consume it. Ordinary chat messages
// are never routed here. Borrows the ccgram keystroke-injection pattern.
//
// Safety: the daemon only reaches this AFTER its allow-list gate (so only the owner can trigger it), and it
// ONLY injects into panes that opted in by registering — never an arbitrary pane.
import { chmodSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";

export interface TmuxRoute {
  pane: string; // tmux pane id, e.g. "%3" or "sess:0.1"
  peer?: string; // exact chat peer allowed to answer; absent only on legacy routes, which inbound chat ignores
  cwd?: string;
  ts: number;
  /** "once" (default) = consumed after one injected reply; "bind" = persistent, every reply injects until unbound. */
  mode?: "once" | "bind";
}

export const TMUX_ONCE_ROUTE_TTL_MS = 30 * 60 * 1000;
export const TMUX_BIND_ROUTE_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_ROUTE_CLOCK_SKEW_MS = 60 * 1000;

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
  mkdirSync(dir(), { recursive: true, mode: 0o700 });
  try { chmodSync(dir(), 0o700); } catch { /* best effort */ }
  writeFileSync(storePath(), JSON.stringify({ routes }, null, 2), { mode: 0o600 });
  try { chmodSync(storePath(), 0o600); } catch { /* best effort */ }
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

/** Remove persistent routes for one chat. An explicit peer also clears legacy unscoped routes so an
 * upgrade cannot leave an old global bind hijacking normal messages. Omit peer for the local all-route tool. */
export function unbindBinds(peer?: string): number {
  const before = load();
  const after = before.filter((route) => (
    route.mode !== "bind"
    || (peer !== undefined && route.peer !== peer && Boolean(route.peer))
  ));
  save(after);
  return before.length - after.length;
}

/** Pure: pick the OLDEST live registered pane (FIFO — the longest-waiting ask answers first); return it plus the
 *  routes to keep. Inbound gateway calls MUST pass the exact chat peer: legacy/unscoped and other-chat routes
 *  are never eligible. One-shot routes expire after 30 minutes and binds after 12 hours so a forgotten live
 *  tmux pane cannot silently capture ordinary chat forever. */
export function pickRoute(
  routes: TmuxRoute[],
  isAlive: (pane: string) => boolean,
  peer?: string,
  now = Date.now(),
): { chosen: TmuxRoute | null; remaining: TmuxRoute[] } {
  const live = routes.filter((route) => {
    const ttl = route.mode === "bind" ? TMUX_BIND_ROUTE_TTL_MS : TMUX_ONCE_ROUTE_TTL_MS;
    return route.ts <= now + MAX_ROUTE_CLOCK_SKEW_MS
      && now - route.ts <= ttl
      && isAlive(route.pane);
  }).sort((a, b) => a.ts - b.ts);
  const eligible = peer === undefined ? live : live.filter((route) => route.peer === peer);
  const chosen = eligible[0] ?? null;
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

/** Persistent ("bind") routes only — the panes whose OUTPUT we relay back to chat (two-way remote terminal). */
export function boundRoutes(): TmuxRoute[] {
  return load().filter((r) => r.mode === "bind");
}

/** Capture a tmux pane's visible text (plain, no ANSI). null if unavailable. */
export function capturePane(pane: string): string | null {
  try {
    return execFileSync("tmux", ["capture-pane", "-p", "-t", pane], { encoding: "utf8", timeout: 3000 });
  } catch {
    return null;
  }
}

/** Pure: the NEW output to relay, given what we last sent and the current pane capture. "" = nothing new.
 *  Handles the common append case, anchors on the last sent line when the pane has scrolled, and falls back to
 *  the tail when it can't re-anchor. */
export function outputDelta(lastSent: string, current: string): string {
  if (current === lastSent) return "";
  if (!lastSent) return current; // caller decides whether to baseline (skip) or send on first sight
  if (current.startsWith(lastSent)) return current.slice(lastSent.length);
  const lines = lastSent.split("\n").filter((l) => l.trim());
  const anchor = lines[lines.length - 1];
  if (anchor) {
    const idx = current.lastIndexOf(anchor);
    if (idx >= 0) return current.slice(idx + anchor.length);
  }
  return current.split("\n").slice(-20).join("\n"); // scrolled past our anchor → send the tail
}

/** Pick (and consume per mode) the oldest live registered pane WITHOUT injecting — so the caller can capture the
 *  pane before/after injecting and relay just the new output. Returns the pane id, or null if none pending. */
export function pickPaneForReply(peer: string): string | null {
  const { chosen, remaining } = pickRoute(load(), paneAlive, peer);
  save(remaining);
  return chosen?.pane ?? null;
}

/** Explicit relay helper retained for embedders. Callers must already have parsed an opt-in `/remote send`
 * command; the Hara gateway never passes ordinary inbound messages here. One-shot routes are consumed. */
export function deliverToTmux(text: string, peer: string): string | null {
  const { chosen, remaining } = pickRoute(load(), paneAlive, peer);
  save(remaining);
  if (!chosen) return null;
  try {
    injectTmux(chosen.pane, text);
    return chosen.pane;
  } catch {
    return null;
  }
}
