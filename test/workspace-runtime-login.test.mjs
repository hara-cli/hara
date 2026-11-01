import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { WorkspaceRuntimeInstaller } from "../dist/workspace/runtime-install.js";

test("private login guidance shell-quotes paths and does not inherit the global Codex home", { skip: process.platform === "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "hara-private-login-"));
  try {
    const command = join(root, "codex ' ; $fixture"), privateHome = join(root, "private ' home"), codexHome = join(privateHome, ".codex");
    writeFileSync(command, `#!${process.execPath}\nconsole.log(JSON.stringify({ args: process.argv.slice(2), home: process.env.HOME, user: process.env.USERPROFILE, codex: process.env.CODEX_HOME }));\n`, { mode: 0o700 });
    const guide = WorkspaceRuntimeInstaller.prototype.codexLoginInstructions.call({ resolveBound(id) {
      assert.equal(id, "codex"); return { command, env: { HOME: privateHome, USERPROFILE: privateHome, CODEX_HOME: codexHome } };
    } });
    const result = spawnSync("/bin/sh", ["-c", guide.command], { encoding: "utf8", env: { PATH: process.env.PATH, CODEX_HOME: "/global-fixture-never-used" } });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { args: ["login"], home: privateHome, user: privateHome, codex: codexHome });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("unsafe login-command control characters fail closed", () => {
  assert.throws(() => WorkspaceRuntimeInstaller.prototype.codexLoginInstructions.call({ resolveBound() {
    return { command: "/fixture/codex", env: { HOME: "/private/home", USERPROFILE: "/private/home", CODEX_HOME: "/private/home\ncommand" } };
  } }), /unavailable or unsafe/);
});
