import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isHomeWorkspace,
  isUnsafeProjectWorkspace,
  resolveWorkspaceSwitch,
} from "../dist/context/workspace-scope.js";

test("workspace scope blocks Home and its ancestors while allowing an explicit child project", () => {
  const root = mkdtempSync(join(tmpdir(), "hara-workspace-scope-"));
  const home = join(root, "home");
  const project = join(home, "Projects", "demo");
  mkdirSync(project, { recursive: true });
  try {
    const canonicalProject = realpathSync.native(project);
    assert.equal(isHomeWorkspace(home, home), true);
    assert.equal(isUnsafeProjectWorkspace(home, home), true);
    assert.equal(isUnsafeProjectWorkspace(root, home), true, "an ancestor scope recursively contains Home");
    assert.equal(isUnsafeProjectWorkspace(project, home), false, "an explicitly selected child is a project scope");

    assert.match(resolveWorkspaceSwitch("", home, home).error, /usage: \/cd/);
    assert.match(resolveWorkspaceSwitch("~", project, home).error, /not an implicit project workspace/);
    assert.match(resolveWorkspaceSwitch(root, project, home).error, /not an implicit project workspace/);
    assert.deepEqual(resolveWorkspaceSwitch('"~/Projects/demo"', home, home), { ok: true, cwd: canonicalProject });
    assert.deepEqual(resolveWorkspaceSwitch("Projects/demo", home, home), { ok: true, cwd: canonicalProject });
    assert.match(resolveWorkspaceSwitch("missing", home, home).error, /cannot switch/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
