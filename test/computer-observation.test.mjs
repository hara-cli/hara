import { test } from "node:test";
import assert from "node:assert/strict";
import { Script, runInNewContext } from "node:vm";
import {
  nativeTargetInvocation,
  parseDesktopTarget,
  pointInTarget,
  sameDesktopTarget,
} from "../dist/tools/computer-observation.js";

const target = {
  app: "Example Editor",
  pid: 123,
  windowId: "456",
  frame: { x: 100, y: 50, width: 800, height: 600 },
  screen: { x: 0, y: 0, width: 1440, height: 900 },
};

function nativeOutput(value = target) {
  return [value.app, value.pid, value.windowId,
    value.frame.x, value.frame.y, value.frame.width, value.frame.height,
    value.screen.x, value.screen.y, value.screen.width, value.screen.height,
    ...(value.title === undefined ? [] : [value.title])].join("\n");
}

test("native target parser preserves logical coordinates, nonzero origins, and large native IDs", () => {
  assert.deepEqual(parseDesktopTarget(`${nativeOutput()}\n`), target);
  const offset = {
    ...target,
    windowId: "18446744073709551615",
    frame: { x: -120, y: 90.5, width: 800, height: 600 },
    screen: { x: -1440, y: -100, width: 2880, height: 900 },
    title: "Document A",
  };
  assert.deepEqual(parseDesktopTarget(nativeOutput(offset).replaceAll("\n", "\r\n")), offset);
  assert.equal(parseDesktopTarget(nativeOutput({ ...target, windowId: "0x1A2B" })).windowId, "0x1A2B");
});

test("native target parser rejects ambiguous protocols and invalid identities or geometry", () => {
  for (const output of [
    "",
    nativeOutput().split("\n").slice(0, 10).join("\n"),
    `${nativeOutput()}\nUnexpected title\nextra diagnostics`,
    `debug output\n${nativeOutput()}`,
    `${nativeOutput()}\n\n\n`,
    nativeOutput({ ...target, app: " " }),
    nativeOutput({ ...target, app: "Editor\tInjected" }),
    nativeOutput({ ...target, pid: 0 }),
    nativeOutput({ ...target, pid: -1 }),
    nativeOutput({ ...target, pid: 1.5 }),
    nativeOutput({ ...target, pid: "1e2" }),
    nativeOutput({ ...target, pid: "9007199254740993" }),
    nativeOutput({ ...target, windowId: "" }),
    nativeOutput({ ...target, windowId: "0" }),
    nativeOutput({ ...target, windowId: "0x0000" }),
    nativeOutput({ ...target, windowId: "window title as ID" }),
    nativeOutput({ ...target, windowId: "45\r6" }),
    nativeOutput({ ...target, frame: { ...target.frame, x: "100px" } }),
    nativeOutput({ ...target, frame: { ...target.frame, x: " 100" } }),
    nativeOutput({ ...target, frame: { ...target.frame, width: 0 } }),
    nativeOutput({ ...target, frame: { ...target.frame, height: -1 } }),
    nativeOutput({ ...target, frame: { ...target.frame, x: Infinity } }),
    nativeOutput({ ...target, screen: { ...target.screen, y: NaN } }),
    nativeOutput({ ...target, screen: { ...target.screen, width: -1 } }),
    nativeOutput({ ...target, screen: { ...target.screen, height: 0 } }),
    nativeOutput({ ...target, frame: { ...target.frame, x: Number.MAX_SAFE_INTEGER, width: 100 } }),
    nativeOutput({ ...target, title: "Secret\u0000metadata" }),
  ]) {
    assert.equal(parseDesktopTarget(output), null, output);
  }
});

test("native target comparison binds app, process, stable window ID, frame, and screenshot area", () => {
  assert.equal(sameDesktopTarget(target, structuredClone(target)), true);
  assert.equal(sameDesktopTarget({ ...target, title: "A" }, { ...target, title: "B" }), true);
  for (const after of [
    { ...target, app: "Another Editor" },
    { ...target, pid: 124 },
    { ...target, windowId: "457" },
    ...["x", "y", "width", "height"].map((field) => ({
      ...target, frame: { ...target.frame, [field]: target.frame[field] + 1 },
    })),
    ...["x", "y", "width", "height"].map((field) => ({
      ...target, screen: { ...target.screen, [field]: target.screen[field] + 1 },
    })),
  ]) {
    assert.equal(sameDesktopTarget(target, after), false, JSON.stringify(after));
  }
});

test("native target pointer checks intersect window and screenshot bounds with exclusive far edges", () => {
  assert.equal(pointInTarget(100, 50, target), true);
  assert.equal(pointInTarget(899, 649, target), true);
  for (const [x, y] of [[99, 50], [100, 49], [900, 50], [100, 650], [NaN, 60], [100, Infinity]]) {
    assert.equal(pointInTarget(x, y, target), false, `${x},${y}`);
  }
  const spanning = { ...target, frame: { x: -500, y: -100, width: 3000, height: 1500 } };
  assert.equal(pointInTarget(0, 0, spanning), true);
  assert.equal(pointInTarget(-1, 0, spanning), false);
  assert.equal(pointInTarget(1440, 800, spanning), false);
  assert.equal(pointInTarget(1000, 900, spanning), false);
  const offset = { ...target, frame: { x: -500, y: -100, width: 800, height: 600 },
    screen: { x: -1440, y: -100, width: 2880, height: 900 } };
  assert.equal(pointInTarget(-500, -100, offset), true);
  assert.equal(pointInTarget(-501, -100, offset), false);
});

test("platform target invocations are fixed read-only scripts and unknown platforms fail closed", () => {
  assert.equal(nativeTargetInvocation("freebsd"), null);
  assert.equal(nativeTargetInvocation("darwin; run injected command"), null);
  const mac = nativeTargetInvocation("darwin");
  assert.deepEqual(mac.args.slice(0, 3), ["-l", "JavaScript", "-e"]);
  assert.equal(mac.command, "osascript");
  assert.doesNotThrow(() => new Script(mac.args[3]), "JXA script is valid JavaScript; do not execute it");
  assert.match(mac.args[3], /CGWindowListCopyWindowInfo/);
  assert.match(mac.args[3], /kCGWindowNumber/);
  assert.match(mac.args[3], /kCGWindowOwnerPID === pid/);
  assert.match(mac.args[3], /matches\.length !== 1/);
  assert.match(mac.args[3], /NSScreen\.screens/);
  assert.match(mac.args[3], /screens\.objectAtIndex\(0\)/);
  assert.doesNotMatch(mac.args[3], /Finder|mainScreen|window\.name|window\.id/);
  const linux = nativeTargetInvocation("linux");
  assert.equal(linux.command, "bash");
  assert.equal(linux.args[0], "-c");
  assert.match(linux.args[1], /xdotool getactivewindow/);
  assert.match(linux.args[1], /xdotool getwindowpid/);
  assert.match(linux.args[1], /xdotool getwindowclassname/);
  assert.match(linux.args[1], /getwindowgeometry --shell/);
  assert.match(linux.args[1], /getdisplaygeometry/);
  assert.match(linux.args[1], /\$\{DISPLAY:-\}/);
  assert.match(linux.args[1], /WAYLAND_DISPLAY/);
  assert.doesNotMatch(linux.args[1], /\beval\b/);
  const windows = nativeTargetInvocation("win32");
  assert.equal(windows.command, "powershell");
  assert.deepEqual(windows.args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
  for (const nativeApi of ["GetForegroundWindow", "GetWindowThreadProcessId", "GetWindowRect", "SetProcessDPIAware", "PrimaryScreen.Bounds"]) {
    assert.ok(windows.args[3].includes(nativeApi), nativeApi);
  }
  assert.doesNotMatch(windows.args[3], /MainWindowTitle|AppActivate|SendKeys|mouse_event/);
  mac.args[3] = "mutated copy";
  assert.match(nativeTargetInvocation("darwin").args[3], /CGWindowListCopyWindowInfo/);
});

test("mac target script emits the native protocol using synthetic AX, CGWindow, and primary-screen data", () => {
  const script = nativeTargetInvocation("darwin").args[3];
  const nativeWindow = { kCGWindowOwnerPID: target.pid, kCGWindowIsOnscreen: true,
    kCGWindowNumber: 456, kCGWindowBounds: {
      X: target.frame.x, Y: target.frame.y, Width: target.frame.width, Height: target.frame.height,
    } };
  const process = {
    name: () => target.app,
    unixId: () => target.pid,
    windows: [{ position: () => [target.frame.x, target.frame.y], size: () => [target.frame.width, target.frame.height] }],
  };
  const environment = (windows) => ({
    ObjC: { import() {}, deepUnwrap: (value) => value },
    Application: () => ({ applicationProcesses: { whose: () => [process] } }),
    $: {
      NSApplication: { sharedApplication: {} },
      NSScreen: { screens: { count: 1, objectAtIndex: () => ({
        frame: { origin: { x: 0, y: 0 }, size: { width: 1440, height: 900 } },
      }) } },
      kCGWindowListOptionOnScreenOnly: 1,
      kCGWindowListExcludeDesktopElements: 16,
      kCGNullWindowID: 0,
      CGWindowListCopyWindowInfo: () => windows,
    },
  });
  const output = runInNewContext(script, environment([nativeWindow]), { timeout: 1000 });
  assert.deepEqual(parseDesktopTarget(output), target, "script emits real newline separators, not literal backslash-n");
  assert.throws(() => runInNewContext(script, environment([]), { timeout: 1000 }), /no unique native window ID/);
  assert.throws(() => runInNewContext(script, environment([nativeWindow, nativeWindow]), { timeout: 1000 }), /no unique native window ID/);
});
