// Windows shell resolution — hara/the model speak POSIX shell, so on Windows we prefer a real bash
// (Git Bash / WSL) and fall back to cmd.exe. Pure argv logic, unit-tested without spawning.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveShellArgv } from "../dist/sandbox.js";

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
  const r = resolveShellArgv("echo hi", "win32", null);
  assert.equal(r.cmd, "cmd.exe");
  assert.deepEqual(r.args, ["/d", "/s", "/c", "echo hi"]);
});
