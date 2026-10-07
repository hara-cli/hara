// computer — native screen control (operate desktop software, not just the browser). Shell-out per OS, no
// heavy deps: mac = screencapture + cliclick · windows = PowerShell + .NET/user32 · linux = scrot + xdotool.
// Safety: opt-in tier (config computerUse off|read|click|full) + per-app allowlist (config computerApps:
// frontmost-window check before any pointer/keyboard action) + dangerous-key blocklist + per-action approval
// (tool kind "computer" always confirms through a live human channel, even in full-auto). Screenshots
// reach native image input or the explicitly authorized inspection route, never durable history.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerTool, type ToolContext } from "./registry.js";
import { acquireComputerLease, type ComputerLease } from "../security/computer-lease.js";
import { createComputerRunScope, closeComputerRunScope, type ComputerRunScope } from "./computer-run.js";
import { nativeTargetInvocation, parseDesktopTarget, sameDesktopTarget, type DesktopTarget } from "./computer-observation.js";
import { computerSnapshotDigest, computerObservationError, computerPointError } from "./computer-action-boundary.js";
import { readVerifiedRegularFileBytesSync } from "../fs-read.js";
import { MAX_NATIVE_IMAGE_BYTES } from "../vision.js";
import { loadConfig } from "../config.js";
import { terminateSubprocessTree, toolSubprocessEnv } from "../security/subprocess-env.js";
import { safeProviderErrorMessage } from "../providers/errors.js";
import { registerToolMediaRedaction, removeToolMediaRedaction, redactOwnedToolImageText, toolMediaRedaction } from "../security/tool-media-redaction.js";

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
//    Grounding returns fixed-unit 0..1 fractions; use the bound primary-display logical rectangle.
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
const computerTransaction = new AsyncLocalStorage<{ lease: ComputerLease; scope: ComputerRunScope; ctx: ToolContext }>();
let legacyScope = createComputerRunScope();
export function resetComputerFails(): void {
  legacyScope = createComputerRunScope();
}
function ok(msg: string): string {
  (computerTransaction.getStore()?.scope ?? legacyScope).failures = 0;
  return msg;
}
function fail(msg: string): string {
  msg = redactOwnedToolImageText(msg);
  const transaction = computerTransaction.getStore();
  transaction?.ctx.markToolError?.();
  const scope = transaction?.scope ?? legacyScope;
  scope.failures += 1;
  if (scope.failures >= FAIL_LIMIT) {
    scope.halted = true;
    return `Error: screen control stopped for this run — ${FAIL_LIMIT} actions failed (last: ${msg}). Fix permissions or the target, then start a new user turn. No more screen actions will run in this turn.`;
  }
  return `Failed: ${msg}  [${scope.failures}/${FAIL_LIMIT} before this run stops]`;
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
    const lease = computerTransaction.getStore()?.lease;
    try {
      lease?.prepareWorker();
      child = spawn(cmd, args, { detached: processGroup, env: toolSubprocessEnv() });
      if (child.pid) lease?.trackWorker(child.pid);
      else lease?.cancelPreparedWorker();
    } catch (error) {
      if (typeof child! !== "undefined" && child!.pid) {
        // A spawned but not durably tracked worker is uncertain, not "never executed". Keep
        // its reservation until close confirms death; do not grant another desktop owner early.
        const uncertainChild = child!;
        const scope = computerTransaction.getStore()?.scope;
        if (scope) scope.halted = true;
        uncertainChild.once("close", () => {
          try { lease?.untrackWorker(uncertainChild.pid!); } catch { /* retain ownership */ }
          try {
            try { process.kill(uncertainChild.pid!, 0); return; }
            catch (check: any) { if (check?.code !== "ESRCH") return; }
            lease?.cancelPreparedWorker();
          } catch { /* no pending reservation, or retain it for diagnosis */ }
        });
        uncertainChild.once("error", () => {});
        terminateSubprocessTree(uncertainChild, { force: true, processGroup });
      } else {
        try { lease?.cancelPreparedWorker(); } catch { /* retain uncertain reservations */ }
      }
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
      if (child.pid) {
        try { lease?.untrackWorker(child.pid); } catch { /* keep the lease if a worker may still act */ }
      }
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
    child.once("close", (code) => {
      // A cancellation fallback can settle before close. Still retire a genuinely exited worker,
      // otherwise deferred lease.release() would keep a dead worker owned by this live process.
      if (child.pid) { try { lease?.untrackWorker(child.pid); } catch { /* retain uncertain worker ownership */ } }
      settle(code);
    });
  });
}
const has = async (cmd: string, signal?: AbortSignal): Promise<boolean> =>
  (await (process.platform === "win32" ? run("where", [cmd], signal) : run("which", [cmd], signal))).ok;
const ps = (script: string, signal?: AbortSignal) => run("powershell", ["-NoProfile", "-Command", script], signal);

const WINDOWS_CLIPBOARD_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "Add-Type -AssemblyName System.Windows.Forms",
  "$encoded=[Console]::In.ReadToEnd().Trim()",
  "$bytes=[Convert]::FromBase64String($encoded)",
  "$value=[Text.Encoding]::UTF8.GetString($bytes)",
  "[System.Windows.Forms.Clipboard]::SetText($value)",
].join("; ");

/** SendKeys values are data on stdin, never interpolated PowerShell source. */
function windowsTargetGuard(target: DesktopTarget): string {
  // Native identities/rectangles are validated finite data, not model-supplied script fragments.
  return `Add-Type @'
using System;using System.Runtime.InteropServices;public class TargetGuard{[StructLayout(LayoutKind.Sequential)]public struct Rect{public int Left,Top,Right,Bottom;}[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();[DllImport("user32.dll")]public static extern int GetWindowThreadProcessId(IntPtr h,out int p);[DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr h,out Rect r);[DllImport("user32.dll")]public static extern bool SetProcessDPIAware();}
'@
[void][TargetGuard]::SetProcessDPIAware(); $h=[TargetGuard]::GetForegroundWindow();$owner=0;$rect=New-Object TargetGuard+Rect;[void][TargetGuard]::GetWindowThreadProcessId($h,[ref]$owner);if($h.ToInt64() -ne [Convert]::ToInt64('${target.windowId}',${target.windowId.startsWith("0x") ? 16 : 10}) -or $owner -ne ${target.pid} -or -not [TargetGuard]::GetWindowRect($h,[ref]$rect) -or $rect.Left -ne ${target.frame.x} -or $rect.Top -ne ${target.frame.y} -or ($rect.Right-$rect.Left) -ne ${target.frame.width} -or ($rect.Bottom-$rect.Top) -ne ${target.frame.height}){throw 'bound foreground window changed; no input was sent'};`;
}

function windowsSendKeysInvocation(value: string, target: DesktopTarget) {
  return {
    command: "powershell",
    args: ["-NoProfile", "-NonInteractive", "-STA", "-Command", [
      "$ErrorActionPreference='Stop'",
      "Add-Type -AssemblyName System.Windows.Forms",
      "$encoded=[Console]::In.ReadToEnd().Trim()",
      "$value=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded))",
      windowsTargetGuard(target),
      "[System.Windows.Forms.SendKeys]::SendWait($value)",
    ].join("; ")],
    input: Buffer.from(value, "utf8").toString("base64"),
  };
}

/** A fixed-script, stdin-only Windows clipboard invocation. `clip.exe` decodes redirected bytes through
 * the active legacy code page and can turn CJK/emoji into `?`. Base64 keeps user text out of both the
 * PowerShell command line and that code-page boundary; PowerShell decodes the original UTF-8 in STA mode. */
export function windowsClipboardInvocation(text: string): { command: string; args: string[]; input: string } {
  return {
    command: "powershell",
    args: ["-NoProfile", "-NonInteractive", "-STA", "-Command", WINDOWS_CLIPBOARD_SCRIPT],
    input: Buffer.from(text, "utf8").toString("base64"),
  };
}

function windowsDataInvocation(value: string, script: string): { command: string; args: string[]; input: string } {
  return {
    command: "powershell",
    args: ["-NoProfile", "-NonInteractive", "-STA", "-Command",
      "$ErrorActionPreference='Stop';$value=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()));" + script],
    input: Buffer.from(value, "utf8").toString("base64"),
  };
}

export function windowsActivateInvocation(app: string) {
  return windowsDataInvocation(app, "if(-not (New-Object -ComObject WScript.Shell).AppActivate($value)){throw 'the app could not be activated'}");
}

export function windowsScreenshotInvocation(outputPath: string) {
  return windowsDataInvocation(outputPath, `Add-Type @'
using System;using System.Runtime.InteropServices;public class ScreenDpi{[DllImport("user32.dll")]public static extern bool SetProcessDPIAware();}
'@
[void][ScreenDpi]::SetProcessDPIAware(); Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp=New-Object System.Drawing.Bitmap($b.Width,$b.Height); $g=[System.Drawing.Graphics]::FromImage($bmp); try {$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $bmp.Save($value)} finally {$g.Dispose();$bmp.Dispose()}`);
}

/** Put text on the OS clipboard (so `type` can paste it — IME-safe + Unicode-safe, unlike keystroke injection). */
async function setClipboard(text: string, signal?: AbortSignal): Promise<boolean> {
  try {
    if (process.platform === "darwin") return (await run("pbcopy", [], signal, text, 5_000)).ok;
    if (process.platform === "win32") {
      const invocation = windowsClipboardInvocation(text);
      return (await run(invocation.command, invocation.args, signal, invocation.input, 5_000)).ok;
    }
    if (await has("wl-copy", signal)) return (await run("wl-copy", [], signal, text, 5_000)).ok;
    if (await has("xclip", signal)) return (await run("xclip", ["-selection", "clipboard"], signal, text, 5_000)).ok;
  } catch {
    /* fall through */
  }
  return false;
}

async function screenshot(signal?: AbortSignal): Promise<{ path?: string; error?: string; dispose: () => void }> {
  const directory = mkdtempSync(join(tmpdir(), "hara-screen-"));
  chmodSync(directory, 0o700);
  const out = join(directory, "screen.png");
  const dispose = (): void => { rmSync(directory, { recursive: true, force: true }); };
  try {
    if (process.platform === "darwin") {
      if (!(await run("screencapture", ["-x", "-m", out], signal)).ok) return { error: "screencapture failed (grant Screen Recording permission)", dispose };
    } else if (process.platform === "linux") {
      if (await has("scrot", signal)) await run("scrot", ["-o", out], signal);
      else if (await has("import", signal)) await run("import", ["-window", "root", out], signal);
      else if (await has("grim", signal)) await run("grim", [out], signal);
      else return { error: "no screenshot tool — install scrot / imagemagick / grim", dispose };
    } else if (process.platform === "win32") {
      const invocation = windowsScreenshotInvocation(out);
      if (!(await run(invocation.command, invocation.args, signal, invocation.input)).ok) return { error: "PowerShell screenshot failed", dispose };
    } else {
      return { error: `unsupported platform ${process.platform}`, dispose };
    }
    try {
      if (!existsSync(out) || statSync(out).size === 0) return { error: "screenshot produced no file", dispose };
      chmodSync(out, 0o600);
    } catch {
      return { error: "screenshot produced no file", dispose };
    }
    return { path: out, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}

/** Bring an app to the foreground so screenshots/clicks land on IT, not the terminal hara runs in. */
async function activateApp(app: string, signal?: AbortSignal): Promise<{ ok: boolean; msg: string }> {
  if (process.platform === "darwin") {
    // `open -a` reliably launches+foregrounds; `osascript … activate` often leaves another window on top.
    const r = await run("open", ["-a", app], signal);
    return { ok: r.ok, msg: r.ok ? `activated ${app}` : r.out || `couldn't activate ${app}` };
  }
  if (process.platform === "win32") {
    const invocation = windowsActivateInvocation(app);
    const r = await run(invocation.command, invocation.args, signal, invocation.input);
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

/** On an uncertain macOS paste, release only the modifier this invocation may have held. Cleanup
 * stays inside the desktop lease and deliberately ignores the cancelled action signal: it is a fixed
 * key-up, never another paste, key-down, click, or automatic input retry. */
async function macPaste(signal?: AbortSignal): Promise<{ ok: boolean; out: string }> {
  if (signal?.aborted) throw new ComputerInterruptedError();
  let completed = false;
  try {
    const result = await run("cliclick", ["kd:cmd", "t:v", "ku:cmd"], signal);
    completed = result.ok;
    return result;
  } finally {
    if (!completed) {
      const scope = computerTransaction.getStore()?.scope;
      if (scope) scope.halted = true;
      try { await run("cliclick", ["ku:cmd"], undefined, undefined, 2_000); }
      catch { /* best-effort release is not evidence that input or key state succeeded */ }
    }
  }
}

async function pointerOrKeyboard(action: string, input: any, signal: AbortSignal | undefined, verify: () => Promise<void>): Promise<{ ok: boolean; msg: string }> {
  const x = Math.round(Number(input.x));
  const y = Math.round(Number(input.y));
  const mac = process.platform === "darwin";
  const lin = process.platform === "linux";
  const win = process.platform === "win32";

  if (action === "click" || action === "move") {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, msg: `${action} needs x,y` };
    if (mac) {
      if (!(await has("cliclick", signal))) return { ok: false, msg: "cliclick not found — install with `brew install cliclick`" };
      await verify();
      const r = await run("cliclick", [`${action === "click" ? "c" : "m"}:${x},${y}`], signal);
      return { ok: r.ok, msg: r.ok ? `${action} at ${x},${y}` : r.out };
    }
    if (lin) {
      if (!(await has("xdotool", signal))) return { ok: false, msg: "xdotool not found" };
      await verify();
      const r = await run("xdotool", action === "click" ? ["mousemove", `${x}`, `${y}`, "click", "1"] : ["mousemove", `${x}`, `${y}`], signal);
      return { ok: r.ok, msg: r.ok ? `${action} at ${x},${y}` : r.out };
    }
    if (win) {
      await verify();
      const r = await ps(`$ErrorActionPreference='Stop';Add-Type @'
using System;using System.Runtime.InteropServices;public class Ms{[DllImport("user32.dll")]public static extern bool SetProcessDPIAware();[DllImport("user32.dll")]public static extern bool SetCursorPos(int x,int y);[DllImport("user32.dll")]public static extern void mouse_event(int f,int x,int y,int d,int e);}
'@
${windowsTargetGuard(input.boundTarget)}
[void][Ms]::SetProcessDPIAware(); if(-not [Ms]::SetCursorPos(${x},${y})){throw 'cursor move failed'}; ${action === "click" ? "[Ms]::mouse_event(0x2,0,0,0,0);[Ms]::mouse_event(0x4,0,0,0,0)" : ""}`, signal);
      return { ok: r.ok, msg: r.ok ? `${action} at ${x},${y}` : r.out };
    }
  }
  if (action === "type") {
    const text = String(input.text ?? "");
    if (!text) return { ok: false, msg: "type needs text" };
    // IME-safe path: set the clipboard and paste. Keystroke injection (below) is intercepted/garbled by a
    // CJK input method and can't enter Chinese/emoji reliably; pasting is immune and Unicode-safe.
    if (await setClipboard(text, signal)) {
      if (mac && await has("cliclick", signal)) {
        await verify();
        const r = await macPaste(signal);
        return { ok: r.ok, msg: r.ok ? `pasted ${text.length} chars` : `paste dispatch failed or is uncertain: ${r.out}; do not retry blindly` };
      } else if (lin && await has("xdotool", signal)) {
        await verify();
        const r = await run("xdotool", ["key", "--window", input.boundTarget.windowId, "ctrl+v"], signal);
        return { ok: r.ok, msg: r.ok ? `pasted ${text.length} chars` : `paste dispatch failed or is uncertain: ${r.out}; do not retry blindly` };
      } else if (win) {
        await verify();
        const invocation = windowsSendKeysInvocation("^v", input.boundTarget);
        const r = await run(invocation.command, invocation.args, signal, invocation.input);
        return { ok: r.ok, msg: r.ok ? `pasted ${text.length} chars` : `paste dispatch failed or is uncertain: ${r.out}; do not retry blindly` };
      }
    }
    // Fallback: keystroke injection (fine for ASCII when no IME is active).
    if (mac) {
      if (!(await has("cliclick", signal))) return { ok: false, msg: "cliclick not found — install with `brew install cliclick`" };
      await verify();
      const r = await run("cliclick", [`t:${text}`], signal);
      return { ok: r.ok, msg: r.ok ? `typed ${text.length} chars (keystroke)` : r.out };
    }
    if (lin) {
      if (!(await has("xdotool", signal))) return { ok: false, msg: "xdotool not found" };
      await verify();
      const r = await run("xdotool", ["type", "--window", input.boundTarget.windowId, "--clearmodifiers", text], signal);
      return { ok: r.ok, msg: r.ok ? `typed ${text.length} chars (keystroke)` : r.out };
    }
    if (win) {
      await verify();
      // SendKeys treats literal +%^{} as control syntax; don't fall back to it for arbitrary text.
      return { ok: false, msg: "Unicode clipboard unavailable; no text input was dispatched" };
    }
  }
  if (action === "key") {
    const keys = String(input.keys ?? "");
    if (!keys) return { ok: false, msg: "key needs a key/combo" };
    if (keyIsBlocked(keys)) return { ok: false, msg: `refused dangerous key combo: ${keys}` };
    if (mac) {
      if (!(await has("cliclick", signal))) return { ok: false, msg: "cliclick not found — install with `brew install cliclick`" };
      await verify();
      const r = await run("cliclick", [`kp:${keys}`], signal);
      return { ok: r.ok, msg: r.ok ? `pressed ${keys}` : r.out };
    }
    if (lin) {
      if (!(await has("xdotool", signal))) return { ok: false, msg: "xdotool not found" };
      await verify();
      const r = await run("xdotool", ["key", "--window", input.boundTarget.windowId, keys], signal);
      return { ok: r.ok, msg: r.ok ? `pressed ${keys}` : r.out };
    }
    if (win) {
      await verify();
      const invocation = windowsSendKeysInvocation(keys, input.boundTarget);
      const r = await run(invocation.command, invocation.args, signal, invocation.input);
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

async function readDesktopTarget(signal?: AbortSignal): Promise<DesktopTarget | null> {
  const invocation = nativeTargetInvocation(process.platform);
  if (!invocation) return null;
  const result = await run(invocation.command, invocation.args, signal);
  return result.ok ? parseDesktopTarget(result.out) : null;
}

async function observeDesktop(signal?: AbortSignal) {
  const before = await readDesktopTarget(signal);
  const shot = await screenshot(signal);
  if (!shot.path) { shot.dispose(); throw new Error(shot.error ?? "screenshot unavailable"); }
  try {
    const after = await readDesktopTarget(signal);
    if (before && (!after || !sameDesktopTarget(before, after))) throw new Error("desktop target changed while capturing the screenshot");
    const snapshot = readVerifiedRegularFileBytesSync(shot.path, MAX_NATIVE_IMAGE_BYTES, {
      action: "observe computer screen", rejectHardLinks: true, protectSensitive: false,
    });
    // Grounding/legacy inspection receives this capture before a tool-image attachment is allocated.
    // Register opaque fingerprints during that call too; SDK diagnostics must not echo its pixels/path.
    const owner = shot.path;
    registerToolMediaRedaction(owner, toolMediaRedaction(snapshot.bytes.toString("base64"), shot.path));
    const dispose = (): void => { removeToolMediaRedaction(owner); shot.dispose(); };
    return { ...shot, dispose, path: shot.path, target: before && after ? after : null,
      bytes: snapshot.bytes, digest: computerSnapshotDigest(snapshot.bytes) };
  } catch (error) { shot.dispose(); throw error; }
}

async function exposeObservation(shot: Awaited<ReturnType<typeof observeDesktop>>, ctx: ToolContext, hint?: string): Promise<string> {
  if (ctx.attachToolImage) {
    ctx.attachToolImage({ data: shot.bytes, mediaType: "image/png" });
    return "A fresh screenshot is offered to the immediately following model request through the authorized image route only; it is not retained in chat history. If the route is unavailable, the runtime will mark it unread.";
  }
  if (ctx.describeImage) {
    const text = await ctx.describeImage(shot.path, hint, ctx.signal);
    if (text) return `Fresh screenshot inspected:\n${redactOwnedToolImageText(text)}`;
  }
  return "Screenshot captured but not read: no authorized image route is available. Configure a vision-first route or select an image-capable model.";
}

async function runComputerAction(input: any, ctx: ToolContext, scope: ComputerRunScope, cfg: ReturnType<typeof loadConfig>): Promise<string> {
  const action = String(input.action ?? "");
  if (!scope.active || scope.halted) return fail("this desktop-control run has ended or stopped; start a new user turn");
  const currentPolicyError = (app?: string): string | null => {
    const live = loadConfig({ cwd: ctx.cwd });
    if (!actionAllowed(live.computerUse as Tier, action)) return "Computer Use permission was lowered or disabled; no input was sent";
    if (app && !live.computerApps.some((allowed) => allowed.toLowerCase() === app.toLowerCase())) return "the exact app was removed from the allowlist; no input was sent";
    return null;
  };
  const initialPolicyError = currentPolicyError(action === "activate" ? String(input.app ?? input.target ?? "") : undefined);
  if (initialPolicyError) return fail(initialPolicyError);
  if (action === "activate") {
    const app = String(input.app ?? input.target ?? "");
    const result = await activateApp(app, ctx.signal);
    if (!result.ok) return fail(result.msg);
    const target = await readDesktopTarget(ctx.signal);
    if (!target || target.app.toLowerCase() !== app.toLowerCase()) {
      return fail("activation was dispatched, but the exact native foreground app/window could not be verified; no input was sent");
    }
    const horizontal = Math.min(target.frame.x + target.frame.width, target.screen.x + target.screen.width) - Math.max(target.frame.x, target.screen.x);
    const vertical = Math.min(target.frame.y + target.frame.height, target.screen.y + target.screen.height) - Math.max(target.frame.y, target.screen.y);
    if (horizontal <= 0 || vertical <= 0) return fail("the target window is outside the primary screenshot display; move it onto the primary display");
    scope.target = target;
    scope.observation = undefined;
    return ok(`Observed: ${app} native window ${target.windowId} is foreground. Take a screenshot before coordinate/keyboard input; activation alone is not task completion.`);
  }
  const shot = await observeDesktop(ctx.signal);
  try {
    if (action === "screenshot") {
      const id = randomUUID();
      if (shot.target && scope.target && sameDesktopTarget(scope.target, shot.target)) {
        scope.observation = { id, target: shot.target, digest: shot.digest, at: Date.now() };
      } else scope.observation = undefined;
      return ok(`Observed screenshot${scope.observation ? `; observationId=${id}` : "; no input-authorizing window binding (activate the exact app first)"}.\n${await exposeObservation(shot, ctx, input.focus)}`);
    }
    if (!shot.target || !scope.target || !sameDesktopTarget(scope.target, shot.target)) {
      scope.observation = undefined;
      return fail("the exact bound foreground app/window is unavailable or changed; activate the intended app again. No input was sent");
    }
    if (!cfg.computerApps.some((app) => app.toLowerCase() === shot.target!.app.toLowerCase())) return fail("the bound app is no longer allowlisted; no input was sent");
    const needsLocate = action === "find" || ((action === "click" || action === "move") && input.target != null && (input.x == null || input.y == null));
    const argumentsForInput = { ...input, boundTarget: shot.target };
    if (needsLocate) {
      const target = String(input.target ?? "");
      if (!target || !ctx.locate) return fail("grounding requires a target and an authorized image-capable route; no input was sent");
      const location = await ctx.locate(shot.path, target, ctx.signal);
      if (!location || !Number.isFinite(location.x) || !Number.isFinite(location.y)
        || location.x < 0 || location.x > 1 || location.y < 0 || location.y > 1) return fail("grounding did not return valid fixed-unit coordinates; no input was sent");
      argumentsForInput.x = Math.round(shot.target.screen.x + location.x * shot.target.screen.width);
      argumentsForInput.y = Math.round(shot.target.screen.y + location.y * shot.target.screen.height);
      const pointError = computerPointError(argumentsForInput.x, argumentsForInput.y, shot.target);
      if (pointError) return fail(`${pointError}; no input was sent`);
      const id = randomUUID();
      scope.observation = { id, target: shot.target, digest: shot.digest, at: Date.now() };
      argumentsForInput.observationId = id;
      if (action === "find") {
        return ok(`Observed: "${target}" at ${argumentsForInput.x},${argumentsForInput.y}; observationId=${id}. Coordinates are bound to this run/window for 30 seconds and invalidated by screen changes.`);
      }
    } else {
      const error = computerObservationError(scope, shot.target, shot.digest, input.observationId);
      if (error) return fail(`${error}; no input was sent`);
    }
    if (action === "click" || action === "move") {
      const error = computerPointError(argumentsForInput.x, argumentsForInput.y, shot.target);
      if (error) return fail(`${error}; no input was sent`);
    }
    const verify = async (): Promise<void> => {
      if (ctx.signal?.aborted || !scope.active) throw new ComputerInterruptedError();
      const fresh = await observeDesktop(ctx.signal);
      try {
        if (!fresh.target) throw new Error("native foreground window could not be revalidated; no input was sent");
        const error = computerObservationError(scope, fresh.target, fresh.digest, argumentsForInput.observationId);
        if (error) throw new Error(`${error}; no input was sent`);
      } finally { fresh.dispose(); }
      if (ctx.signal?.aborted || !scope.active) throw new ComputerInterruptedError();
      const policyError = currentPolicyError(scope.target?.app);
      if (policyError) throw new Error(policyError);
    };
    const result = await pointerOrKeyboard(action, argumentsForInput, ctx.signal, verify);
    scope.observation = undefined; // Never replay an input on the same observation.
    if (!result.ok) {
      scope.halted = true; // A failed dispatch may have had a partial effect; never try another input path.
      return fail(result.msg);
    }
    try {
      const after = await observeDesktop(ctx.signal);
      try {
        const id = randomUUID();
        if (after.target && sameDesktopTarget(scope.target, after.target)) {
          scope.observation = { id, target: after.target, digest: after.digest, at: Date.now() };
        }
        return ok(`Dispatched: ${result.msg}. Business outcome is NOT verified (exit code is not proof of a click, paste, or send).\nObserved: fresh post-action screenshot${scope.observation ? `; observationId=${id}` : "; window changed, activate again before further input"}.\n${await exposeObservation(after, ctx)}`);
      } finally { after.dispose(); }
    } catch (error) {
      if (ctx.signal?.aborted) throw error;
      scope.halted = true;
      return fail(`input was dispatched, but its effect could not be observed (${error instanceof Error ? error.message : "observation failed"}). This run is stopped; verify manually before a new user turn`);
    }
  } catch (error) {
    if (ctx.signal?.aborted || error instanceof ComputerInterruptedError) throw error;
    // Scrub while this screenshot's fingerprint is still live, before finally disposes its ownership.
    throw new Error(safeProviderErrorMessage(error));
  } finally { shot.dispose(); }
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
    "target → inspect the post-action screenshot. Raw coordinates, typing, and keys require the observationId " +
    "from the latest screenshot/find in this run. Only the primary display is supported; screen/window changes " +
    "invalidate the observation. Dispatched input is not verified business success. When typing, type the " +
    "ACTUAL text — never placeholders. Opt-in, per-action human approval, exact-window binding and desktop lease.",
  input_schema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["screenshot", "activate", "find", "click", "move", "type", "key"] },
      app: { type: "string", description: "app to bring to the foreground (activate) — e.g. 'WeChat'. Do this BEFORE screenshot/click so they hit the app, not the terminal." },
      target: { type: "string", description: "describe a UI element to locate (find) or click/move to — e.g. 'the Send button'. Preferred over x,y." },
      x: { type: "number", description: "x in logical desktop points on macOS, pixels on Windows/X11; must lie in bound window (or use target)" },
      y: { type: "number", description: "y in the same desktop coordinate space as x" },
      observationId: { type: "string", description: "opaque id from this run's latest screenshot/find; required for raw coordinates, typing and keys" },
      text: { type: "string", description: "text to type (type)" },
      keys: { type: "string", description: "key or combo, e.g. 'return', 'cmd+c' (key)" },
      focus: { type: "string", description: "screenshot only: what to look for — focuses the read" },
    },
    required: ["action"],
  },
  kind: "computer",
  visibility: "deferred",
  async run(input, ctx) {
    if (ctx.signal?.aborted) throw new ComputerInterruptedError();
    const cfg = loadConfig({ cwd: ctx.cwd });
    const tier = cfg.computerUse as Tier;
    if (tier === "off") return "Screen control is off. Enable it in Hara Desktop → Settings → Security → Computer Use, or run `hara config set computerUse read|click|full` (and set an app allowlist for click/type).";
    const action = String(input.action ?? "");
    if (!actionAllowed(tier, action)) return `'${action}' needs a higher tier (current computerUse=${tier}). Raise it in Hara Desktop → Settings → Security → Computer Use, or with \`hara config set computerUse …\`.`;

    if (!Object.hasOwn(ACTION_MIN, action)) return "Error: unsupported computer action; no input was sent";
    // Validate static refusals before acquiring a lease or touching the physical desktop.
    if (action === "activate") {
      const app = String(input.app ?? input.target ?? "");
      if (!app) return "activate needs an `app` name (e.g. 'WeChat').";
      if (!cfg.computerApps.some((a) => a.toLowerCase() === app.toLowerCase()))
        return `Refused: "${app}" isn't in your allowlist (${cfg.computerApps.join(", ") || "empty"}). Add it in Hara Desktop → Settings → Security → Computer Use, or run \`hara config set computerApps "${app}"\`.`;
    }
    if (action !== "screenshot" && action !== "activate") {
      if (!cfg.computerApps.length) return "No apps allowlisted — add exact app names in Hara Desktop → Settings → Security → Computer Use, or set `hara config set computerApps \"App Name, …\"`, before clicking/typing.";
    }
    if (action === "key" && keyIsBlocked(String(input.keys ?? ""))) return "Error: refused dangerous key combo; no input was sent";
    const scope = ctx.computerScope ?? createComputerRunScope();
    if (!scope.active || scope.halted) return "Error: screen control stopped for this run; start a new user turn";
    let lease: ComputerLease;
    try { lease = acquireComputerLease({ home: ctx.stateHome, runId: scope.runId, sessionId: ctx.sessionId }); }
    catch (error) { ctx.markToolError?.(); return `Error: desktop control unavailable: ${error instanceof Error ? error.message : "another run owns the desktop"}. No action was dispatched.`; }
    try {
      return await computerTransaction.run({ lease, scope, ctx }, async () => {
        try { return await runComputerAction(input, ctx, scope, cfg); }
        catch (error) {
          if (ctx.signal?.aborted || error instanceof ComputerInterruptedError) throw error;
          return fail(error instanceof Error ? error.message : "desktop action failed");
        }
      });
    } finally {
      lease.release();
      if (!ctx.computerScope) closeComputerRunScope(scope);
    }
  },
});
}
