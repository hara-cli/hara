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

type Tier = "off" | "read" | "click" | "full";
const RANK: Record<Tier, number> = { off: 0, read: 1, click: 2, full: 3 };
const ACTION_MIN: Record<string, Tier> = { screenshot: "read", move: "click", click: "click", type: "full", key: "full" };
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
    if (mac) {
      if (!has("cliclick")) return { ok: false, msg: "cliclick not found — install with `brew install cliclick`" };
      const r = run("cliclick", [`t:${text}`]);
      return { ok: r.ok, msg: r.ok ? `typed ${text.length} chars` : r.out };
    }
    if (lin) {
      if (!has("xdotool")) return { ok: false, msg: "xdotool not found" };
      const r = run("xdotool", ["type", "--clearmodifiers", text]);
      return { ok: r.ok, msg: r.ok ? `typed ${text.length} chars` : r.out };
    }
    if (win) {
      const r = ps(`Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.SendKeys]::SendWait(${JSON.stringify(text)})`);
      return { ok: r.ok, msg: r.ok ? `typed ${text.length} chars` : r.out };
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
    "Control the screen to operate desktop software (not just the browser): take a screenshot, then " +
    "click/move/type/press keys at coordinates. Workflow: screenshot → read what's on screen → act. " +
    "A screenshot returns the interactive elements and their positions so you can click them; pass `focus` " +
    "to target what you're looking for. Opt-in and permission-gated (tier + per-app allowlist).",
  input_schema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["screenshot", "click", "move", "type", "key"] },
      x: { type: "number", description: "x pixel (click/move)" },
      y: { type: "number", description: "y pixel (click/move)" },
      text: { type: "string", description: "text to type (type)" },
      keys: { type: "string", description: "key or combo, e.g. 'return', 'cmd+c' (key)" },
      focus: { type: "string", description: "screenshot only: what to look for, e.g. 'the Login button' — focuses the read" },
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

    if (action !== "screenshot") {
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
    const r = pointerOrKeyboard(action, input);
    return r.ok ? `✓ ${r.msg}` : `Failed: ${r.msg}`;
  },
});
