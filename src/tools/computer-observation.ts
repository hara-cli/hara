// Fixed, read-only platform probes and pure checks for binding native input to one observed window.
// This module never starts a subprocess; computer.ts owns execution, cancellation, and permissions.
export interface DesktopRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DesktopTarget {
  app: string;
  pid: number;
  /** Native window-server ID / HWND / X11 window ID, never a title or array index. */
  windowId: string;
  frame: DesktopRect;
  /** The same coordinate space and display area as the screenshot and input backend. */
  screen: DesktopRect;
  /** Display-only metadata; changes here do not imply a different native window. */
  title?: string;
}

export interface NativeTargetInvocation {
  command: string;
  args: string[];
}

// macOS does not consistently expose AX window IDs. Match the AX front window's PID and exact frame
// to one on-screen Core Graphics window and use its native ID. Never substitute the window title.
// NSScreen.screens[0] is the logical primary display; mainScreen follows the focused window instead.
// This matches screencapture -m and cliclick's top-left logical coordinates, including Retina displays.
const MAC_TARGET_SCRIPT = String.raw`
ObjC.import("AppKit");
ObjC.import("CoreGraphics");
$.NSApplication.sharedApplication;
function frontTarget() {
  var process = Application("System Events").applicationProcesses.whose({ frontmost: true })[0];
  var app = process.name();
  var pid = process.unixId();
  var window = process.windows[0];
  var position = window.position();
  var size = window.size();
  var info = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID);
  var windows = ObjC.deepUnwrap(info);
  if (!Array.isArray(windows)) throw Error("Native window list unavailable");
  var matches = windows.filter(function (candidate) {
    var bounds = candidate.kCGWindowBounds;
    return candidate.kCGWindowOwnerPID === pid && candidate.kCGWindowIsOnscreen && bounds &&
      bounds.X === position[0] && bounds.Y === position[1] &&
      bounds.Width === size[0] && bounds.Height === size[1] && candidate.kCGWindowNumber > 0;
  });
  if (matches.length !== 1) throw Error("Front window has no unique native window ID");
  return { app: app, pid: pid, windowId: String(matches[0].kCGWindowNumber),
    frame: { x: position[0], y: position[1], width: size[0], height: size[1] } };
}
function primaryScreen() {
  var screens = $.NSScreen.screens;
  if (Number(screens.count) < 1) throw Error("Primary screen unavailable");
  var frame = screens.objectAtIndex(0).frame;
  if (frame.origin.x !== 0 || frame.origin.y !== 0) throw Error("Unexpected primary screen origin");
  return { x: 0, y: 0, width: frame.size.width, height: frame.size.height };
}
var before = frontTarget();
var screen = primaryScreen();
if (JSON.stringify(before) !== JSON.stringify(frontTarget()) ||
    JSON.stringify(screen) !== JSON.stringify(primaryScreen())) throw Error("Desktop changed during observation");
[before.app, before.pid, before.windowId, before.frame.x, before.frame.y,
  before.frame.width, before.frame.height, screen.x, screen.y, screen.width, screen.height].join("\n");
`.trim();

// X11 root geometry uses origin (0,0), matching scrot / ImageMagick root screenshots and xdotool input.
// Do not evaluate xdotool's --shell output: parse the fixed geometry keys as data.
const LINUX_TARGET_SCRIPT = String.raw`
set -eu
if [ -z "${"$"}{DISPLAY:-}" ] || [ "${"$"}{XDG_SESSION_TYPE:-}" = "wayland" ] || [ -n "${"$"}{WAYLAND_DISPLAY:-}" ]; then
  exit 1
fi
window_id=$(xdotool getactivewindow)
process_id=$(xdotool getwindowpid "$window_id")
app_name=$(xdotool getwindowclassname "$window_id")
geometry=$(xdotool getwindowgeometry --shell "$window_id")
frame_x= frame_y= frame_width= frame_height=
while IFS='=' read -r field value; do
  case "$field" in
    X) frame_x=$value ;;
    Y) frame_y=$value ;;
    WIDTH) frame_width=$value ;;
    HEIGHT) frame_height=$value ;;
  esac
done <<EOF
$geometry
EOF
display_geometry=$(xdotool getdisplaygeometry)
case "$display_geometry" in
  *' '*) screen_width=${"$"}{display_geometry%% *}; screen_height=${"$"}{display_geometry#* } ;;
  *) exit 1 ;;
esac
test "$window_id" = "$(xdotool getactivewindow)"
test "$process_id" = "$(xdotool getwindowpid "$window_id")"
test "$geometry" = "$(xdotool getwindowgeometry --shell "$window_id")"
test "$display_geometry" = "$(xdotool getdisplaygeometry)"
printf '%s\n' "$app_name" "$process_id" "$window_id" "$frame_x" "$frame_y" "$frame_width" "$frame_height" 0 0 "$screen_width" "$screen_height"
`.trim();

// Set DPI awareness before asking user32 or WinForms for coordinates. The screenshot process must use
// the same setting; otherwise GetWindowRect can be virtualized while the screenshot is physical pixels.
const WINDOWS_TARGET_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class HaraDesktopTarget {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", SetLastError=true)] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
[void][HaraDesktopTarget]::SetProcessDPIAware()
$window = [HaraDesktopTarget]::GetForegroundWindow()
if ($window -eq [IntPtr]::Zero) { throw 'Foreground window unavailable' }
[uint32]$targetPid = 0
if ([HaraDesktopTarget]::GetWindowThreadProcessId($window, [ref]$targetPid) -eq 0) { throw 'Window process unavailable' }
$process = Get-Process -Id $targetPid -ErrorAction Stop
$rect = New-Object 'HaraDesktopTarget+Rect'
if (-not [HaraDesktopTarget]::GetWindowRect($window, [ref]$rect)) { throw 'Window frame unavailable' }
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$afterRect = New-Object 'HaraDesktopTarget+Rect'
if ($window -ne [HaraDesktopTarget]::GetForegroundWindow() -or
    -not [HaraDesktopTarget]::GetWindowRect($window, [ref]$afterRect) -or
    $rect.Left -ne $afterRect.Left -or $rect.Top -ne $afterRect.Top -or
    $rect.Right -ne $afterRect.Right -or $rect.Bottom -ne $afterRect.Bottom -or
    $screen -ne [System.Windows.Forms.Screen]::PrimaryScreen.Bounds) { throw 'Desktop changed during observation' }
$values = @($process.ProcessName, $targetPid, $window.ToInt64().ToString(),
  $rect.Left, $rect.Top, ($rect.Right - $rect.Left), ($rect.Bottom - $rect.Top),
  $screen.X, $screen.Y, $screen.Width, $screen.Height)
[string]::Join([Environment]::NewLine, $values)
`.trim();

/** Build a fixed read-only invocation. No model-provided text is interpolated into any script. */
export function nativeTargetInvocation(platform: string): NativeTargetInvocation | null {
  if (platform === "darwin") return { command: "osascript", args: ["-l", "JavaScript", "-e", MAC_TARGET_SCRIPT] };
  if (platform === "linux") return { command: "bash", args: ["-c", LINUX_TARGET_SCRIPT] };
  if (platform === "win32") return {
    command: "powershell",
    args: ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_TARGET_SCRIPT],
  };
  return null;
}

const NATIVE_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const NATIVE_ID = /^(?:[1-9]\d*|0x[0-9a-f]*[1-9a-f][0-9a-f]*)$/i;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

function nativeNumber(text: string): number | null {
  if (!NATIVE_NUMBER.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER ? value : null;
}

function validRect(rect: DesktopRect): boolean {
  return [rect.x, rect.y, rect.width, rect.height, rect.x + rect.width, rect.y + rect.height].every(
    (value) => Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER,
  ) && rect.width > 0 && rect.height > 0;
}

/** Parse the native 11-line protocol: app, PID, native ID, frame x/y/w/h, screen x/y/w/h.
 * An optional twelfth line is a display-only title. CRLF is accepted; diagnostics or extra data are not. */
export function parseDesktopTarget(stdout: string): DesktopTarget | null {
  if (stdout.length > 8192) return null;
  const normalized = stdout.replace(/\r\n/g, "\n");
  const lines = (normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized).split("\n");
  if (lines.length !== 11 && lines.length !== 12) return null;
  const [app, pidText, windowId] = lines;
  if (!app.trim() || app.length > 1024 || CONTROL_CHARACTER.test(app) ||
      !/^[1-9]\d*$/.test(pidText) || !Number.isSafeInteger(Number(pidText)) ||
      windowId.length > 128 || !NATIVE_ID.test(windowId)) return null;
  const geometry = lines.slice(3, 11).map(nativeNumber);
  if (geometry.some((value) => value === null)) return null;
  const [x, y, width, height, screenX, screenY, screenWidth, screenHeight] = geometry as number[];
  const frame = { x, y, width, height };
  const screen = { x: screenX, y: screenY, width: screenWidth, height: screenHeight };
  if (!validRect(frame) || !validRect(screen)) return null;
  const title = lines[11];
  if (title !== undefined && (title.length > 2048 || CONTROL_CHARACTER.test(title))) return null;
  return { app, pid: Number(pidText), windowId, frame, screen, ...(title !== undefined ? { title } : {}) };
}

function sameRect(before: DesktopRect, after: DesktopRect): boolean {
  return before.x === after.x && before.y === after.y && before.width === after.width && before.height === after.height;
}

/** Compare identity and geometry, not title text (which may change during normal typing). */
export function sameDesktopTarget(before: DesktopTarget, after: DesktopTarget): boolean {
  return before.app === after.app && before.pid === after.pid && before.windowId === after.windowId &&
    sameRect(before.frame, after.frame) && sameRect(before.screen, after.screen);
}

/** Only permit points in both the captured display area and the observed window; far edges are exclusive. */
export function pointInTarget(x: number, y: number, target: DesktopTarget): boolean {
  const contains = (rect: DesktopRect): boolean => validRect(rect) &&
    x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height;
  return Number.isFinite(x) && Number.isFinite(y) && contains(target.screen) && contains(target.frame);
}
