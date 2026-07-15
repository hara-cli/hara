import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = join(process.cwd(), "dist", "index.js");

function runAtHome(home, args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: home,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      HARA_TUI: "0",
      HARA_PROVIDER: "anthropic",
      HARA_API_KEY: "",
      ANTHROPIC_API_KEY: "",
    },
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

test("CLI --cwd explicitly selects a child project without weakening the Home boundary", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-cli-cwd-"));
  const project = join(home, "project");
  mkdirSync(project);
  writeFileSync(join(project, "package.json"), "{}\n");
  try {
    const shifted = runAtHome(home, ["--cwd", "project", "init"]);
    assert.equal(shifted.status, 1, shifted.stderr || shifted.stdout);
    assert.match(shifted.stdout + shifted.stderr, /not authenticated/i, "the command reached project/provider setup");
    assert.doesNotMatch(shifted.stdout + shifted.stderr, /home directory.*not an implicit project workspace/i);

    const missing = runAtHome(home, ["--cwd", "missing-project", "sessions"]);
    assert.equal(missing.status, 2);
    assert.match(missing.stdout + missing.stderr, /Cannot use --cwd.*missing-project/i);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
