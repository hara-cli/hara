// Windows shell resolution — hara/the model speak POSIX shell, so on Windows we prefer a real bash
// (Git Bash / WSL) and fall back to cmd.exe. Pure argv logic, unit-tested without spawning.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  firstHealthyWindowsBash,
  firstInstalledWindowsBash,
  resolveShellArgv,
  windowsShellPathPreflight,
  windowsBashCandidates,
} from "../dist/sandbox.js";

test("resolveShellArgv: POSIX platforms use /bin/sh -c", () => {
  assert.deepEqual(resolveShellArgv("ls -la", "darwin", null), { cmd: "/bin/sh", args: ["-c", "ls -la"] });
  assert.deepEqual(resolveShellArgv("grep x", "linux", null), { cmd: "/bin/sh", args: ["-c", "grep x"] });
});

test("resolveShellArgv: Windows uses bash when found (Git Bash / WSL keeps ls/grep working)", () => {
  const r = resolveShellArgv("ls -la", "win32", "C:\\Program Files\\Git\\bin\\bash.exe");
  assert.equal(r.cmd, "C:\\Program Files\\Git\\bin\\bash.exe");
  assert.deepEqual(r.args, ["-c", "ls -la"]);
});

test("resolveShellArgv: Windows falls back to cmd.exe when no bash is on PATH", () => {
  const r = resolveShellArgv("echo hi", "win32", null, {
    SystemRoot: "D:\\Windows",
    PATH: "D:\\Portable\\bin",
  });
  assert.equal(r.cmd, "D:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(r.args, ["/d", "/s", "/c", "echo hi"]);
});

test("resolveShellArgv: Windows honors an absolute ComSpec even when PATH omits System32", () => {
  const r = resolveShellArgv("echo hi", "win32", null, {
    ComSpec: "E:\\OS\\System32\\cmd.exe",
    PATH: "D:\\Portable\\bin",
  });
  assert.equal(r.cmd, "E:\\OS\\System32\\cmd.exe");
});

test("Windows shell discovery probes conventional Git Bash installs outside PATH", () => {
  const candidates = windowsBashCandidates({ ProgramFiles: "D:\\Apps", LocalAppData: "E:\\Portable" });
  assert.ok(candidates.includes("D:\\Apps\\Git\\bin\\bash.exe"));
  assert.ok(candidates.includes("C:\\Program Files\\Git\\bin\\bash.exe"));
  assert.equal(
    firstInstalledWindowsBash(candidates, (path) => path === "C:\\Program Files\\Git\\bin\\bash.exe"),
    "C:\\Program Files\\Git\\bin\\bash.exe",
  );
});

test("Windows shell discovery skips a broken WSL alias and keeps probing for Git Bash", () => {
  const attempts = [];
  const selected = firstHealthyWindowsBash(
    [
      "C:\\Windows\\System32\\bash.exe",
      "C:\\Program Files\\Git\\bin\\bash.exe",
    ],
    (path) => {
      attempts.push(path);
      return path.includes("Program Files");
    },
  );
  assert.equal(selected, "C:\\Program Files\\Git\\bin\\bash.exe");
  assert.deepEqual(attempts, [
    "C:\\Windows\\System32\\bash.exe",
    "C:\\Program Files\\Git\\bin\\bash.exe",
  ]);
});

test("Windows shell discovery returns no bash when every discovered executable is unhealthy", () => {
  assert.equal(firstHealthyWindowsBash(["C:\\Windows\\System32\\bash.exe"], () => false), null);
});

test("Windows shell path preflight rejects WSL/drive-letter mixing before Node resolves a bogus path", () => {
  const wsl = "C:\\Windows\\System32\\bash.exe";
  assert.match(
    windowsShellPathPreflight('node "D:/Work/八字案例短视频/nayi-admin-mcp/index.js"', wsl) ?? "",
    /Windows absolute path to WSL Bash.*\/mnt\/d\/.*wslpath.*Git Bash/is,
  );
  assert.match(
    windowsShellPathPreflight('node "/mnt/d/Work/八字案例短视频/D:/Work/八字案例短视频/index.js"', wsl) ?? "",
    /mixes WSL.*Windows.*one absolute path dialect/is,
  );
});

test("Windows shell path preflight permits one deliberate dialect", () => {
  const wsl = "C:\\Windows\\System32\\bash.exe";
  const git = "C:\\Program Files\\Git\\bin\\bash.exe";
  assert.equal(windowsShellPathPreflight('node "/mnt/d/Work/project/index.js"', wsl), undefined);
  assert.equal(windowsShellPathPreflight('node "D:/Work/project/index.js"', git), undefined);
  assert.equal(windowsShellPathPreflight('node "$(wslpath -u \'D:\\Work\\project\\index.js\')"', wsl), undefined);
  assert.equal(windowsShellPathPreflight('node.exe "D:/Work/project/index.js"', wsl), undefined);
});
