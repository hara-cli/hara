// computer — native screen control (operate desktop software, not just the browser). Shell-out per OS, no
// heavy deps: mac = screencapture + cliclick · windows = PowerShell + .NET/user32 · linux = scrot + xdotool.
// Safety: opt-in tier (config computerUse off|read|click|full) + per-app allowlist (config computerApps:
// frontmost-window check before any pointer/keyboard action) + dangerous-key blocklist + a once-per-session
// grant (tool kind "computer" always confirms once, even in full-auto). Screenshots are read via the vision
// sidecar (ctx.describeImage) so a text main model can still "see" them.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerTool } from "./registry.js";
import { loadConfig } from "../config.js";
import { terminateSubprocessTree, toolSubprocessEnv } from "../security/subprocess-env.js";

// ── RPA gotchas (hard-won; read before changing this file) ───────────────────────────────────────────
// 0. TWO macOS PERMISSIONS, separately: Screen Recording (for `screencapture`) AND Accessibility (for
//    `cliclick` click/move/type/key). They're granted independently in System Settings → Privacy & Security.
//    Screenshots can work while clicks/keys SILENTLY DO NOTHING — if cliclick has no Accessibility grant it
//    no-ops with exit 0, so the screen just never changes (the #1 cause of "it does nothing"). `open -a` is
//    used to foreground apps (below) precisely because it needs no Accessibility grant.
// 1. FOREGROUND TRAP: hara runs inside a terminal, which is the frontmost window — so screenshots capture
//    and clicks land on the TERMINAL, not the app you mean. Always `activate` the target app FIRST
//    (activateApp → osascript/AppActivate/wmctrl), then screenshot/find/click. The per-app allowlist also
//    refuses clicks unless an allowlisted app is frontmost.
// 2. IME TRAP: keystroke injection (`cliclick t:`) is intercepted/converted by a CJK input method, so it
//    cannot reliably enter Chinese/emoji (you get pinyin candidates or garble). `type` therefore PASTES via
//    the clipboard (setClipboard + Cmd/Ctrl+V) — IME-immune and Unicode-safe — and only falls back to
//    keystrokes if the clipboard set fails.
// 3. RETINA/COORDS: screencapture is pixel-resolution (2× on Retina) but cliclick uses LOGICAL points.
//    Grounding returns 0..1 fractions; multiply by screenSize() (logical) so clicks are scale-independent.
// 4. GROUNDING IS FRAGILE: the vision model can mislocate an element. Prefer `find` to sanity-check coords,
//    and ALWAYS re-screenshot after a click to verify before the next step.
// 5. PLACEHOLDER TEXT: a model unsure what to type may emit placeholders (the observed "AAAA"). This tool
//    faithfully types `input.text`; the caller/prompt must supply the REAL text, never a placeholder.
// For *reliable* app automation prefer a real UI-automation backend (e.g. the pywechat MCP on Windows) over
// this screenshot→ground→click loop, which is best-effort.
type Tier = "off" | "read" | "click" | "full";
const RANK: Record<Tier, number> = { off: 0, read: 1, click: 2, full: 3 };
const ACTION_MIN: Record<string, Tier> = { screenshot: "read", find: "read", activate: "click", move: "click", click: "click", type: "full", key: "full" };
// dangerous combos refused even at full tier (quit / close / delete / task-switch-kill).
const KEY_BLOCK = /(?:\b(cmd|command|ctrl|control|alt|option|win|super|meta)\b.*\+.*\b(q|w|delete|del|f4|escape|esc)\b)|ctrl\+alt\+(?:delete|del|backspace)/i;
// Windows SendKeys spells modifiers as % (Alt) / ^ (Ctrl) with no modifier WORD, so the combo regex
// above misses them: block Alt+F4 / Ctrl+F4 (close window) and Ctrl+W (close tab) in that syntax.
const KEY_BLOCK_SENDKEYS = /[%^]\s*\{\s*f4\s*\}|\^\s*w\b/i;
// Linux/X keysyms for logout / power-off (xdotool key XF86LogOff …) — not modifier combos.
const KEY_BLOCK_KEYSYM = /\bxf86(logoff|poweroff|reboot|sleep)\b/i;

/** Whether the configured tier permits the action. Exported for tests. */
export function actionAllowed(tier: Tier, action: string): boolean {
  return RANK[tier] >= RANK[ACTION_MIN[action] ?? "full"];
}
/** Whether a key combo is on the dangerous blocklist. Exported for tests. */
export function keyIsBlocked(keys: string): boolean {
  return KEY_BLOCK.test(keys) || KEY_BLOCK_SENDKEYS.test(keys) || KEY_BLOCK_KEYSYM.test(keys);
}

// Circuit breaker (learned from codex): bound consecutive screen-control failures so the agent can't loop
// forever on a broken setup. Reset on any success; after FAIL_LIMIT in a row, return a clear stop + how to fix.
const FAIL_LIMIT = 3;
let consecFails = 0;
export function resetComputerFails(): void {
  consecFails = 0;
}
function ok(msg: string): string {
  consecFails = 0;
  return msg;
}
function fail(msg: string): string {
  consecFails += 1;
  if (consecFails >= FAIL_LIMIT) {
    consecFails = 0;
    return `⛔ Stopping screen control — ${FAIL_LIMIT} actions failed in a row (last: ${msg}). Most likely a missing macOS permission (Accessibility for click/type, Screen Recording for screenshots) or the target app isn't reachable. Fix that, then ask me to try again — I won't keep retrying blindly.`;
  }
  return `Failed: ${msg}  [${consecFails}/${FAIL_LIMIT} before I stop]`;
}

/** Doctor runs outside an agent turn and may retain a small bounded synchronous availability probe. */
function runProbeSync(cmd: string, args: string[]): { ok: boolean; out: string } {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 3_000, env: toolSubprocessEnv() });
    return { ok: r.status === 0, out: ((r.stdout || "") + (r.stderr || "")).trim() };
  } catch (e: any) {
    return { ok: false, out: e?.message || "spawn failed" };
  }
}
function hasProbeSync(cmd: string): boolean {
  return (process.platform === "win32" ? runProbeSync("where", [cmd]) : runProbeSync("which", [cmd])).ok;
}

class ComputerInterruptedError extends Error {
  constructor() {
    super("computer action interrupted by agent run deadline or cancellation");
  }
}

/** Async, signal-aware command primitive for every agent-driven screen action. It owns a process group so
 *  Esc/deadline kills descendants as well as the direct launcher, and it rechecks the signal before spawn. */
async function run(
  cmd: string,
  args: string[],
  signal?: AbortSignal,
  input?: string,
  timeoutMs = 15_000,
): Promise<{ ok: boolean; out: string }> {
  if (signal?.aborted) throw new ComputerInterruptedError();
  return await new Promise((resolve, reject) => {
    const processGroup = process.platform !== "win32";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { detached: processGroup, env: toolSubprocessEnv() });
    } catch (error) {
      resolve({ ok: false, out: error instanceof Error ? error.message : "spawn failed" });
      return;
    }
    let stdout = "";
    let stderr = "";
    let done = false;
    let timedOut = false;
    let aborted = false;
    let fallback: NodeJS.Timeout | undefined;
    const append = (current: string, chunk: Buffer): string =>
      current.length >= 256 * 1024 ? current : current + chunk.toString().slice(0, 256 * 1024 - current.length);
    const settle = (code: number | null, launchError?: Error): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (fallback) clearTimeout(fallback);
      signal?.removeEventListener("abort", abortRun);
      const out = (stdout + stderr).trim();
      if (aborted) reject(new ComputerInterruptedError());
      else if (launchError) resolve({ ok: false, out: launchError.message });
      else if (timedOut) resolve({ ok: false, out: `timed out after ${timeoutMs}ms${out ? `: ${out}` : ""}` });
      else resolve({ ok: code === 0, out });
    };
    const stop = (fromAbort: boolean): void => {
      if (done || aborted || timedOut) return;
      aborted = fromAbort;
      timedOut = !fromAbort;
      terminateSubprocessTree(child, { force: true, processGroup });
      // A daemon can escape while retaining pipes. Destroy our ends so the API still settles promptly.
      fallback = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        settle(null);
      }, 750);
    };
    const abortRun = (): void => stop(true);
    const timer = setTimeout(() => stop(false), timeoutMs);
    signal?.addEventListener("abort", abortRun, { once: true });
    if (signal?.aborted) {
      abortRun();
    }
    child.stdout?.on("data", (chunk: Buffer) => { if (!done) stdout = append(stdout, chunk); });
    child.stderr?.on("data", (chunk: Buffer) => { if (!done) stderr = append(stderr, chunk); });
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
    child.once("error", (error) => settle(null, error));
    child.once("close", (code) => settle(code));
  });
}
const has = async (cmd: string, signal?: AbortSignal): Promise<boolean> =>
  (await (process.platform === "win32" ? run("where", [cmd], signal) : run("which", [cmd], signal))).ok;
const ps = (script: string, signal?: AbortSignal) => run("powershell", ["-NoProfile", "-Command", script], signal);

/** Put text on the OS clipboard (so `type` can paste it — IME-safe + Unicode-safe, unlike keystroke injection). */
async function setClipboard(text: string, signal?: AbortSignal): Promise<boolean> {
  try {
    if (process.platform === "darwin") return (await run("pbcopy", [], signal, text, 5_000)).ok;
    if (process.platform === "win32") return (await run("clip", [], signal, text, 5_000)).ok;
    if (await has("wl-copy", signal)) return (await run("wl-copy", [], signal, text, 5_000)).ok;
    if (await has("xclip", signal)) return (await run("xclip", ["-selection", "clipboard"], signal, text, 5_000)).ok;
  } catch {
    /* fall through */
  }
  return false;
}

let seq = 0;
function tmpShot(): string {
  seq += 1;
  return join(tmpdir(), `hara-screen-${process.pid}-${Date.now()}-${seq}.png`);
}

async function screenshot(signal?: AbortSignal): Promise<{ path?: string; error?: string }> {
  const out = tmpShot();
  if (process.platform === "darwin") {
    if (!(await run("screencapture", ["-x", out], signal)).ok) return { error: "screencapture failed (grant Screen Recording permission)" };
  } else if (process.platform === "linux") {
    if (await has("scrot", signal)) await run("scrot", ["-o", out], signal);
    else if (await has("import", signal)) await run("import", ["-window", "root", out], signal);
    else if (await has("grim", signal)) await run("grim", [out], signal);
    else return { error: "no screenshot tool — install scrot / imagemagick / grim" };
  } else if (process.platform === "win32") {
    const script = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp=New-Object System.Drawing.Bitmap($b.Width,$b.Height); $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $bmp.Save(${JSON.stringify(out)})`;
    if (!(await ps(script, signal)).ok) return { error: "PowerShell screenshot failed" };
  } else {
    return { error: `unsupported platform ${process.platform}` };
  }
  try {
    if (!existsSync(out) || statSync(out).size === 0) return { error: "screenshot produced no file" };
  } catch {
    return { error: "screenshot produced no file" };
  }
  return { path: out };
}

/** Bring an app to the foreground so screenshots/clicks land on IT, not the terminal hara runs in. */
async function activateApp(app: string, signal?: AbortSignal): Promise<{ ok: boolean; msg: string }> {
  if (process.platform === "darwin") {
    // `open -a` reliably launches+foregrounds; `osascript … activate` often leaves another window on top.
    const r = await run("open", ["-a", app], signal);
    return { ok: r.ok, msg: r.ok ? `activated ${app}` : r.out || `couldn't activate ${app}` };
  }
  if (process.platform === "win32") {
    const r = await ps(`(New-Object -ComObject WScript.Shell).AppActivate(${JSON.stringify(app)})`, signal);
    return { ok: r.ok, msg: r.ok ? `activated ${app}` : r.out || `couldn't activate ${app}` };
  }
  if (process.platform === "linux") {
    const r = await (await has("wmctrl", signal)
      ? run("wmctrl", ["-a", app], signal)
      : run("xdotool", ["search", "--name", app, "windowactivate"], signal));
    return { ok: r.ok, msg: r.ok ? `activated ${app}` : r.out || `couldn't activate ${app} (need wmctrl/xdotool)` };
  }
  return { ok: false, msg: `activate unsupported on ${process.platform}` };
}

/** Logical screen size in the coordinate space the click backends use (points on mac, pixels on win/linux).
 *  Grounding returns 0..1 fractions, so click = fraction × this. null if undetectable. */
async function screenSize(signal?: AbortSignal): Promise<{ w: number; h: number } | null> {
  try {
    if (process.platform === "darwin") {
      const r = await run("osascript", ["-e", 'tell application "Finder" to get bounds of window of desktop'], signal);
      const n = r.out.match(/-?\d+/g);
      if (n && n.length >= 4) return { w: Number(n[2]), h: Number(n[3]) };
    } else if (process.platform === "linux") {
      const [w, h] = (await run("xdotool", ["getdisplaygeometry"], signal)).out.trim().split(/\s+/).map(Number);
      if (w && h) return { w, h };
    } else if (process.platform === "win32") {
      const [w, h] = (await ps('Add-Type -AssemblyName System.Windows.Forms; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; "$($b.Width) $($b.Height)"', signal)).out.trim().split(/\s+/).map(Number);
      if (w && h) return { w, h };
    }
  } catch {
    /* fall through */
  }
  return null;
}

/** Name of the frontmost application/window (for the allowlist check). "" if undetectable. */
async function frontmostApp(signal?: AbortSignal): Promise<string> {
  if (process.platform === "darwin") {
    const r = await run("osascript", ["-e", 'tell application "System Events" to get name of first application process whose frontmost is true'], signal);
    return r.ok ? r.out : "";
  }
  if (process.platform === "linux") {
    const r = await run("xdotool", ["getactivewindow", "getwindowclassname"], signal);
    return r.ok ? r.out : "";
  }
  if (process.platform === "win32") {
    const script = `Add-Type @"
using System;using System.Runtime.InteropServices;public class Hw{[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();[DllImport("user32.dll")]public static extern int GetWindowThreadProcessId(IntPtr h,out int p);}
"@; $p=0;[void][Hw]::GetWindowThreadProcessId([Hw]::GetForegroundWindow(),[ref]$p);(Get-Process -Id $p).ProcessName`;
    const r = await ps(script, signal);
    return r.ok ? r.out : "";
  }
  return "";
}

async function pointerOrKeyboard(action: string, input: any, signal?: AbortSignal): Promise<{ ok: boolean; msg: string }> {
  const x = Math.round(Number(input.x));
  const y = Math.round(Number(input.y));
  const mac = process.platform === "darwin";
  const lin = process.platform === "linux";
  const win = process.platform === "win32";

  if (action === "click" || action === "move") {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, msg: `${action} needs x,y` };
    if (mac) {
      if (!(await has("cliclick", signal))) return { ok: false, msg: "cliclick not found — install with `brew install cliclick`" };
      const r = await run("cliclick", [`${action === "click" ? "c" : "m"}:${x},${y}`], signal);
      return { ok: r.ok, msg: r.ok ? `${action} at ${x},${y}` : r.out };
    }
    if (lin) {
      if (!(await has("xdotool", signal))) return { ok: false, msg: "xdotool not found" };
      const r = await run("xdotool", action === "click" ? ["mousemove", `${x}`, `${y}`, "click", "1"] : ["mousemove", `${x}`, `${y}`], signal);
      return { ok: r.ok, msg: r.ok ? `${action} at ${x},${y}` : r.out };
    }
    if (win) {
      const move = `Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.Cursor]::Position=New-Object System.Drawing.Point(${x},${y})`;
      const m1 = await ps(`Add-Type -AssemblyName System.Drawing;${move}`, signal);
      if (action === "click" && m1.ok) {
        await ps(`Add-Type @"
using System;using System.Runtime.InteropServices;public class Ms{[DllImport("user32.dll")]public static extern void mouse_event(int f,int x,int y,int d,int e);}
"@; [Ms]::mouse_event(0x2,0,0,0,0);[Ms]::mouse_event(0x4,0,0,0,0)`, signal);
      }
      return { ok: m1.ok, msg: m1.ok ? `${action} at ${x},${y}` : m1.out };
    }
  }
  if (action === "type") {
    const text = String(input.text ?? "");
    if (!text) return { ok: false, msg: "type needs text" };
    // IME-safe path: set the clipboard and paste. Keystroke injection (below) is intercepted/garbled by a
    // CJK input method and can't enter Chinese/emoji reliably; pasting is immune and Unicode-safe.
    if (await setClipboard(text, signal)) {
      if (mac && await has("cliclick", signal)) {
        const r = await run("cliclick", ["kd:cmd", "t:v", "ku:cmd"], signal); // Cmd+V
        if (r.ok) return { ok: true, msg: `pasted ${text.length} chars` };
      } else if (lin && await has("xdotool", signal)) {
        const r = await run("xdotool", ["key", "ctrl+v"], signal);
        if (r.ok) return { ok: true, msg: `pasted ${text.length} chars` };
      } else if (win) {
        const r = await ps("Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.SendKeys]::SendWait('^v')", signal);
        if (r.ok) return { ok: true, msg: `pasted ${text.length} chars` };
      }
    }
    // Fallback: keystroke injection (fine for ASCII when no IME is active).
    if (mac) {
      if (!(await has("cliclick", signal))) return { ok: false, msg: "cliclick not found — install with `brew install cliclick`" };
      const r = await run("cliclick", [`t:${text}`], signal);
      return { ok: r.ok, msg: r.ok ? `typed ${text.length} chars (keystroke)` : r.out };
    }
    if (lin) {
      if (!(await has("xdotool", signal))) return { ok: false, msg: "xdotool not found" };
      const r = await run("xdotool", ["type", "--clearmodifiers", text], signal);
      return { ok: r.ok, msg: r.ok ? `typed ${text.length} chars (keystroke)` : r.out };
    }
    if (win) {
      const r = await ps(`Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.SendKeys]::SendWait(${JSON.stringify(text)})`, signal);
      return { ok: r.ok, msg: r.ok ? `typed ${text.length} chars (keystroke)` : r.out };
    }
  }
  if (action === "key") {
    const keys = String(input.keys ?? "");
    if (!keys) return { ok: false, msg: "key needs a key/combo" };
    if (keyIsBlocked(keys)) return { ok: false, msg: `refused dangerous key combo: ${keys}` };
    if (mac) {
      if (!(await has("cliclick", signal))) return { ok: false, msg: "cliclick not found — install with `brew install cliclick`" };
      const r = await run("cliclick", [`kp:${keys}`], signal);
      return { ok: r.ok, msg: r.ok ? `pressed ${keys}` : r.out };
    }
    if (lin) {
      if (!(await has("xdotool", signal))) return { ok: false, msg: "xdotool not found" };
      const r = await run("xdotool", ["key", keys], signal);
      return { ok: r.ok, msg: r.ok ? `pressed ${keys}` : r.out };
    }
    if (win) {
      const r = await ps(`Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.SendKeys]::SendWait(${JSON.stringify(keys)})`, signal);
      return { ok: r.ok, msg: r.ok ? `pressed ${keys}` : r.out };
    }
  }
  return { ok: false, msg: `unknown or unsupported action '${action}' on ${process.platform}` };
}

/** Per-OS backend availability — for `hara doctor`. */
export function computerBackends(): string {
  if (process.platform === "darwin") return `screencapture ✓ · cliclick ${hasProbeSync("cliclick") ? "✓" : "✗ (brew install cliclick)"}`;
  if (process.platform === "linux") return `scrot ${hasProbeSync("scrot") ? "✓" : "✗"} · xdotool ${hasProbeSync("xdotool") ? "✓" : "✗"}`;
  if (process.platform === "win32") return "PowerShell (built-in)";
  return `unsupported (${process.platform})`;
}

// Gateway runs get NO computer tool by default (HARA_GATEWAY_COMPUTER=1 opts back in): a chat-driven, full-auto
// agent reaching for desktop automation is how "check Feishu" turns into blindly clicking another app's windows.
// In a gateway context the right lever is an API/skill, and send_file already covers delivery — so the safe
// default is to not offer screen control at all rather than trust the model to decline it.
if (!process.env.HARA_GATEWAY || process.env.HARA_GATEWAY_COMPUTER === "1") {
registerTool({
  name: "computer",
  description:
    "Control the screen to operate desktop software (not just the browser). ALWAYS `activate` the target app " +
    "FIRST (e.g. activate WeChat) — otherwise screenshots/clicks hit the terminal hara runs in, not the app. " +
    "Then prefer grounding over guessing pixels: pass `target` (e.g. 'the Send button') to click/move and it's " +
    "located by a vision model; or `find` to just get coordinates. Workflow: activate → screenshot → click a " +
    "target → re-screenshot to verify. When typing, type the ACTUAL text — never placeholders. Opt-in and " +
    "permission-gated (tier + per-app allowlist).",
  input_schema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["screenshot", "activate", "find", "click", "move", "type", "key"] },
      app: { type: "string", description: "app to bring to the foreground (activate) — e.g. 'WeChat'. Do this BEFORE screenshot/click so they hit the app, not the terminal." },
      target: { type: "string", description: "describe a UI element to locate (find) or click/move to — e.g. 'the Send button'. Preferred over x,y." },
      x: { type: "number", description: "x pixel (click/move; or use `target`)" },
      y: { type: "number", description: "y pixel (click/move; or use `target`)" },
      text: { type: "string", description: "text to type (type)" },
      keys: { type: "string", description: "key or combo, e.g. 'return', 'cmd+c' (key)" },
      focus: { type: "string", description: "screenshot only: what to look for — focuses the read" },
    },
    required: ["action"],
  },
  kind: "computer",
  async run(input, ctx) {
    if (ctx.signal?.aborted) throw new ComputerInterruptedError();
    const cfg = loadConfig();
    const tier = cfg.computerUse as Tier;
    if (tier === "off") return "Screen control is off. Enable it: `hara config set computerUse read|click|full` (and `hara config set computerApps \"App Name, …\"` for the click/type allowlist).";
    const action = String(input.action ?? "");
    if (!actionAllowed(tier, action)) return `'${action}' needs a higher tier (current computerUse=${tier}). Raise it with \`hara config set computerUse …\`.`;

    // Bring the target app to the foreground first — without this, clicks land on the terminal hara runs in.
    if (action === "activate") {
      const app = String(input.app ?? input.target ?? "");
      if (!app) return "activate needs an `app` name (e.g. 'WeChat').";
      if (!cfg.computerApps.some((a) => a.toLowerCase() === app.toLowerCase()))
        return `Refused: "${app}" isn't in your allowlist (${cfg.computerApps.join(", ") || "empty"}). Add it: \`hara config set computerApps "${app}"\`.`;
      const r = await activateApp(app, ctx.signal);
      return r.ok ? ok(`✓ ${r.msg} — now screenshot/find/click to act on it`) : fail(r.msg);
    }

    if (action !== "screenshot" && action !== "find") {
      // per-app allowlist: only act when an allowlisted app is frontmost (the key guard against wrong-window clicks)
      if (!cfg.computerApps.length) return "No apps allowlisted — set `hara config set computerApps \"App Name, …\"` before clicking/typing.";
      const app = await frontmostApp(ctx.signal);
      const allowed = cfg.computerApps.some((a) => a.toLowerCase() === app.toLowerCase());
      if (!allowed) return `Refused: frontmost app "${app || "unknown"}" isn't in your allowlist (${cfg.computerApps.join(", ")}). Switch to an allowed app or update computerApps.`;
    }

    if (action === "screenshot") {
      const s = await screenshot(ctx.signal);
      if (s.error) return fail(`screenshot — ${s.error}`);
      if (ctx.describeImage) {
        try {
          const desc = await ctx.describeImage(s.path!, input.focus ? String(input.focus) : undefined, ctx.signal);
          if (desc) return ok(`Screenshot (read via vision):\n${desc}`);
        } catch {
          /* fall through to path */
        }
      }
      return ok(`Screenshot saved to ${s.path}. Configure a vision model so I can read it: \`hara config set visionModel <model>\`.`);
    }

    // Grounding: locate a described element and turn it into screen coordinates (more reliable than guessing
    // pixels from a text description). Used for `find`, and for click/move when given a `target` and no x,y.
    const needsLocate = action === "find" || ((action === "click" || action === "move") && input.target != null && (input.x == null || input.y == null));
    if (needsLocate) {
      const target = String(input.target ?? "");
      if (!target) return action === "find" ? "find needs a `target` (what to locate)." : "click/move needs `x,y` or a `target`.";
      if (!ctx.locate) return "Grounding needs a vision model that can see images — set one: `hara config set visionModel <model>`.";
      const s = await screenshot(ctx.signal);
      if (s.error) return fail(`screenshot — ${s.error}`);
      const loc = await ctx.locate(s.path!, target, ctx.signal);
      if (!loc) return fail(`couldn't locate "${target}" on screen — try a screenshot first, or rephrase the target`);
      const size = await screenSize(ctx.signal);
      if (!size) return fail(`located "${target}" but couldn't read the screen size to convert coordinates`);
      const gx = Math.round(loc.x * size.w);
      const gy = Math.round(loc.y * size.h);
      if (action === "find") return ok(`"${target}" is at ~${gx},${gy} (${Math.round(loc.x * 100)}% across, ${Math.round(loc.y * 100)}% down).`);
      input.x = gx;
      input.y = gy;
    }

    const r = await pointerOrKeyboard(action, input, ctx.signal);
    return r.ok ? ok(`✓ ${r.msg}${needsLocate ? ` (located "${input.target}")` : ""}`) : fail(r.msg);
  },
});
}
