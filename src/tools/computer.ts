// computer — native screen control (operate desktop software, not just the browser). Shell-out per OS, no
// heavy deps: mac = screencapture + cliclick · windows = PowerShell + .NET/user32 · linux = scrot + xdotool.
// Safety: opt-in tier (config computerUse off|read|click|full) + per-app allowlist (config computerApps:
// frontmost-window check before any pointer/keyboard action) + dangerous-key blocklist + a once-per-session
// grant (tool kind "computer" always confirms once, even in full-auto). Screenshots are read via the vision
// sidecar (ctx.describeImage) so a text main model can still "see" them.
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerTool } from "./registry.js";
import { loadConfig } from "../config.js";

// ── RPA gotchas (hard-won; read before changing this file) ───────────────────────────────────────────
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
// dangerous combos refused even at full tier (quit / close / delete / task-switch-kill)
const KEY_BLOCK = /(?:\b(cmd|command|ctrl|control|alt|option|win|super|meta)\b.*\+.*\b(q|w|delete|del|f4|escape|esc)\b)|ctrl\+alt\+(?:delete|del|backspace)/i;

/** Whether the configured tier permits the action. Exported for tests. */
export function actionAllowed(tier: Tier, action: string): boolean {
  return RANK[tier] >= RANK[ACTION_MIN[action] ?? "full"];
}
/** Whether a key combo is on the dangerous blocklist. Exported for tests. */
export function keyIsBlocked(keys: string): boolean {
  return KEY_BLOCK.test(keys);
}

function run(cmd: string, args: string[]): { ok: boolean; out: string } {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 15000 });
    return { ok: r.status === 0, out: ((r.stdout || "") + (r.stderr || "")).trim() };
  } catch (e: any) {
    return { ok: false, out: e?.message || "spawn failed" };
  }
}
function has(cmd: string): boolean {
  return (process.platform === "win32" ? run("where", [cmd]) : run("which", [cmd])).ok;
}
const ps = (script: string) => run("powershell", ["-NoProfile", "-Command", script]);

/** Put text on the OS clipboard (so `type` can paste it — IME-safe + Unicode-safe, unlike keystroke injection). */
function setClipboard(text: string): boolean {
  try {
    if (process.platform === "darwin") return spawnSync("pbcopy", [], { input: text, timeout: 5000 }).status === 0;
    if (process.platform === "win32") return spawnSync("clip", [], { input: text, timeout: 5000 }).status === 0;
    if (has("wl-copy")) return spawnSync("wl-copy", [], { input: text, timeout: 5000 }).status === 0;
    if (has("xclip")) return spawnSync("xclip", ["-selection", "clipboard"], { input: text, timeout: 5000 }).status === 0;
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

function screenshot(): { path?: string; error?: string } {
  const out = tmpShot();
  if (process.platform === "darwin") {
    if (!run("screencapture", ["-x", out]).ok) return { error: "screencapture failed (grant Screen Recording permission)" };
  } else if (process.platform === "linux") {
    if (has("scrot")) run("scrot", ["-o", out]);
    else if (has("import")) run("import", ["-window", "root", out]);
    else if (has("grim")) run("grim", [out]);
    else return { error: "no screenshot tool — install scrot / imagemagick / grim" };
  } else if (process.platform === "win32") {
    const script = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp=New-Object System.Drawing.Bitmap($b.Width,$b.Height); $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $bmp.Save(${JSON.stringify(out)})`;
    if (!ps(script).ok) return { error: "PowerShell screenshot failed" };
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
function activateApp(app: string): { ok: boolean; msg: string } {
  if (process.platform === "darwin") {
    const r = run("osascript", ["-e", `tell application ${JSON.stringify(app)} to activate`]);
    return { ok: r.ok, msg: r.ok ? `activated ${app}` : r.out || `couldn't activate ${app}` };
  }
  if (process.platform === "win32") {
    const r = ps(`(New-Object -ComObject WScript.Shell).AppActivate(${JSON.stringify(app)})`);
    return { ok: r.ok, msg: r.ok ? `activated ${app}` : r.out || `couldn't activate ${app}` };
  }
  if (process.platform === "linux") {
    const r = has("wmctrl") ? run("wmctrl", ["-a", app]) : run("xdotool", ["search", "--name", app, "windowactivate"]);
    return { ok: r.ok, msg: r.ok ? `activated ${app}` : r.out || `couldn't activate ${app} (need wmctrl/xdotool)` };
  }
  return { ok: false, msg: `activate unsupported on ${process.platform}` };
}

/** Logical screen size in the coordinate space the click backends use (points on mac, pixels on win/linux).
 *  Grounding returns 0..1 fractions, so click = fraction × this. null if undetectable. */
function screenSize(): { w: number; h: number } | null {
  try {
    if (process.platform === "darwin") {
      const r = run("osascript", ["-e", 'tell application "Finder" to get bounds of window of desktop']);
      const n = r.out.match(/-?\d+/g);
      if (n && n.length >= 4) return { w: Number(n[2]), h: Number(n[3]) };
    } else if (process.platform === "linux") {
      const [w, h] = run("xdotool", ["getdisplaygeometry"]).out.trim().split(/\s+/).map(Number);
      if (w && h) return { w, h };
    } else if (process.platform === "win32") {
      const [w, h] = ps('Add-Type -AssemblyName System.Windows.Forms; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; "$($b.Width) $($b.Height)"').out.trim().split(/\s+/).map(Number);
      if (w && h) return { w, h };
    }
  } catch {
    /* fall through */
  }
  return null;
}

/** Name of the frontmost application/window (for the allowlist check). "" if undetectable. */
function frontmostApp(): string {
  if (process.platform === "darwin") {
    const r = run("osascript", ["-e", 'tell application "System Events" to get name of first application process whose frontmost is true']);
    return r.ok ? r.out : "";
  }
  if (process.platform === "linux") {
    const r = run("xdotool", ["getactivewindow", "getwindowclassname"]);
    return r.ok ? r.out : "";
  }
  if (process.platform === "win32") {
    const script = `Add-Type @"
using System;using System.Runtime.InteropServices;public class Hw{[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();[DllImport("user32.dll")]public static extern int GetWindowThreadProcessId(IntPtr h,out int p);}
"@; $p=0;[void][Hw]::GetWindowThreadProcessId([Hw]::GetForegroundWindow(),[ref]$p);(Get-Process -Id $p).ProcessName`;
    const r = ps(script);
    return r.ok ? r.out : "";
  }
  return "";
}

function pointerOrKeyboard(action: string, input: any): { ok: boolean; msg: string } {
  const x = Math.round(Number(input.x));
  const y = Math.round(Number(input.y));
  const mac = process.platform === "darwin";
  const lin = process.platform === "linux";
  const win = process.platform === "win32";

  if (action === "click" || action === "move") {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, msg: `${action} needs x,y` };
    if (mac) {
      if (!has("cliclick")) return { ok: false, msg: "cliclick not found — install with `brew install cliclick`" };
      const r = run("cliclick", [`${action === "click" ? "c" : "m"}:${x},${y}`]);
      return { ok: r.ok, msg: r.ok ? `${action} at ${x},${y}` : r.out };
    }
    if (lin) {
      if (!has("xdotool")) return { ok: false, msg: "xdotool not found" };
      const r = run("xdotool", action === "click" ? ["mousemove", `${x}`, `${y}`, "click", "1"] : ["mousemove", `${x}`, `${y}`]);
      return { ok: r.ok, msg: r.ok ? `${action} at ${x},${y}` : r.out };
    }
    if (win) {
      const move = `Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.Cursor]::Position=New-Object System.Drawing.Point(${x},${y})`;
      const m1 = ps(`Add-Type -AssemblyName System.Drawing;${move}`);
      if (action === "click" && m1.ok) {
        ps(`Add-Type @"
using System;using System.Runtime.InteropServices;public class Ms{[DllImport("user32.dll")]public static extern void mouse_event(int f,int x,int y,int d,int e);}
"@; [Ms]::mouse_event(0x2,0,0,0,0);[Ms]::mouse_event(0x4,0,0,0,0)`);
      }
      return { ok: m1.ok, msg: m1.ok ? `${action} at ${x},${y}` : m1.out };
    }
  }
  if (action === "type") {
    const text = String(input.text ?? "");
    if (!text) return { ok: false, msg: "type needs text" };
    // IME-safe path: set the clipboard and paste. Keystroke injection (below) is intercepted/garbled by a
    // CJK input method and can't enter Chinese/emoji reliably; pasting is immune and Unicode-safe.
    if (setClipboard(text)) {
      if (mac && has("cliclick")) {
        const r = run("cliclick", ["kd:cmd", "t:v", "ku:cmd"]); // Cmd+V
        if (r.ok) return { ok: true, msg: `pasted ${text.length} chars` };
      } else if (lin && has("xdotool")) {
        const r = run("xdotool", ["key", "ctrl+v"]);
        if (r.ok) return { ok: true, msg: `pasted ${text.length} chars` };
      } else if (win) {
        const r = ps("Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.SendKeys]::SendWait('^v')");
        if (r.ok) return { ok: true, msg: `pasted ${text.length} chars` };
      }
    }
    // Fallback: keystroke injection (fine for ASCII when no IME is active).
    if (mac) {
      if (!has("cliclick")) return { ok: false, msg: "cliclick not found — install with `brew install cliclick`" };
      const r = run("cliclick", [`t:${text}`]);
      return { ok: r.ok, msg: r.ok ? `typed ${text.length} chars (keystroke)` : r.out };
    }
    if (lin) {
      if (!has("xdotool")) return { ok: false, msg: "xdotool not found" };
      const r = run("xdotool", ["type", "--clearmodifiers", text]);
      return { ok: r.ok, msg: r.ok ? `typed ${text.length} chars (keystroke)` : r.out };
    }
    if (win) {
      const r = ps(`Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.SendKeys]::SendWait(${JSON.stringify(text)})`);
      return { ok: r.ok, msg: r.ok ? `typed ${text.length} chars (keystroke)` : r.out };
    }
  }
  if (action === "key") {
    const keys = String(input.keys ?? "");
    if (!keys) return { ok: false, msg: "key needs a key/combo" };
    if (keyIsBlocked(keys)) return { ok: false, msg: `refused dangerous key combo: ${keys}` };
    if (mac) {
      if (!has("cliclick")) return { ok: false, msg: "cliclick not found — install with `brew install cliclick`" };
      const r = run("cliclick", [`kp:${keys}`]);
      return { ok: r.ok, msg: r.ok ? `pressed ${keys}` : r.out };
    }
    if (lin) {
      if (!has("xdotool")) return { ok: false, msg: "xdotool not found" };
      const r = run("xdotool", ["key", keys]);
      return { ok: r.ok, msg: r.ok ? `pressed ${keys}` : r.out };
    }
    if (win) {
      const r = ps(`Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.SendKeys]::SendWait(${JSON.stringify(keys)})`);
      return { ok: r.ok, msg: r.ok ? `pressed ${keys}` : r.out };
    }
  }
  return { ok: false, msg: `unknown or unsupported action '${action}' on ${process.platform}` };
}

/** Per-OS backend availability — for `hara doctor`. */
export function computerBackends(): string {
  if (process.platform === "darwin") return `screencapture ✓ · cliclick ${has("cliclick") ? "✓" : "✗ (brew install cliclick)"}`;
  if (process.platform === "linux") return `scrot ${has("scrot") ? "✓" : "✗"} · xdotool ${has("xdotool") ? "✓" : "✗"}`;
  if (process.platform === "win32") return "PowerShell (built-in)";
  return `unsupported (${process.platform})`;
}

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
    const cfg = loadConfig();
    const tier = cfg.computerUse as Tier;
    if (tier === "off") return "Screen control is off. Enable it: `hara config set computerUse read|click|full` (and `hara config set computerApps \"App Name, …\"` for the click/type allowlist).";
    const action = String(input.action ?? "");
    if (!actionAllowed(tier, action)) return `'${action}' needs a higher tier (current computerUse=${tier}). Raise it with \`hara config set computerUse …\`.`;

    // Bring the target app to the foreground first — without this, clicks land on the terminal hara runs in.
    if (action === "activate") {
      const app = String(input.app ?? input.target ?? "");
      if (!app) return "activate needs an `app` name (e.g. 'WeChat').";
      if (!cfg.computerApps.some((a) => app.toLowerCase().includes(a.toLowerCase()) || a.toLowerCase().includes(app.toLowerCase())))
        return `Refused: "${app}" isn't in your allowlist (${cfg.computerApps.join(", ") || "empty"}). Add it: \`hara config set computerApps "${app}"\`.`;
      const r = activateApp(app);
      return r.ok ? `✓ ${r.msg} — now screenshot/find/click to act on it` : `Failed: ${r.msg}`;
    }

    if (action !== "screenshot" && action !== "find") {
      // per-app allowlist: only act when an allowlisted app is frontmost (the key guard against wrong-window clicks)
      if (!cfg.computerApps.length) return "No apps allowlisted — set `hara config set computerApps \"App Name, …\"` before clicking/typing.";
      const app = frontmostApp();
      const allowed = cfg.computerApps.some((a) => app.toLowerCase().includes(a.toLowerCase()) || a.toLowerCase().includes(app.toLowerCase()));
      if (!allowed) return `Refused: frontmost app "${app || "unknown"}" isn't in your allowlist (${cfg.computerApps.join(", ")}). Switch to an allowed app or update computerApps.`;
    }

    if (action === "screenshot") {
      const s = screenshot();
      if (s.error) return `Screenshot failed: ${s.error}`;
      if (ctx.describeImage) {
        try {
          const desc = await ctx.describeImage(s.path!, input.focus ? String(input.focus) : undefined);
          if (desc) return `Screenshot (read via vision):\n${desc}`;
        } catch {
          /* fall through to path */
        }
      }
      return `Screenshot saved to ${s.path}. Configure a vision model so I can read it: \`hara config set visionModel <model>\`.`;
    }

    // Grounding: locate a described element and turn it into screen coordinates (more reliable than guessing
    // pixels from a text description). Used for `find`, and for click/move when given a `target` and no x,y.
    const needsLocate = action === "find" || ((action === "click" || action === "move") && input.target != null && (input.x == null || input.y == null));
    if (needsLocate) {
      const target = String(input.target ?? "");
      if (!target) return action === "find" ? "find needs a `target` (what to locate)." : "click/move needs `x,y` or a `target`.";
      if (!ctx.locate) return "Grounding needs a vision model that can see images — set one: `hara config set visionModel <model>`.";
      const s = screenshot();
      if (s.error) return `Screenshot failed: ${s.error}`;
      const loc = await ctx.locate(s.path!, target);
      if (!loc) return `Couldn't locate "${target}" on screen — try a screenshot to see what's there, or rephrase the target.`;
      const size = screenSize();
      if (!size) return `Located "${target}" but couldn't read the screen size to convert coordinates.`;
      const gx = Math.round(loc.x * size.w);
      const gy = Math.round(loc.y * size.h);
      if (action === "find") return `"${target}" is at ~${gx},${gy} (${Math.round(loc.x * 100)}% across, ${Math.round(loc.y * 100)}% down).`;
      input.x = gx;
      input.y = gy;
    }

    const r = pointerOrKeyboard(action, input);
    return r.ok ? `✓ ${r.msg}${needsLocate ? ` (located "${input.target}")` : ""}` : `Failed: ${r.msg}`;
  },
});
