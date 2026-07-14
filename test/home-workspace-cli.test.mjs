import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = join(process.cwd(), "dist", "index.js");

function runAtHome(home, args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: home,
    env: { ...process.env, HOME: home, USERPROFILE: home, HARA_TUI: "0" },
    encoding: "utf8",
    timeout: 5_000,
  });
}

test("CLI refuses explicit project initialization and repo indexing at the home root before provider work", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-cli-home-"));
  try {
    const init = runAtHome(home, ["init"]);
    assert.equal(init.status, 2, init.stderr || init.stdout);
    assert.match(init.stdout + init.stderr, /home directory.*not an implicit project workspace/i);
    assert.equal(existsSync(join(home, "AGENTS.md")), false, "home never receives a generated project context file");

    const index = runAtHome(home, ["index", "--repo"]);
    assert.equal(index.status, 2, index.stderr || index.stdout);
    assert.match(index.stdout + index.stderr, /home directory.*not an implicit project workspace/i);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
