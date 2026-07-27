import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
      HARA_UPDATE_CHECK: "0",
      HARA_PROVIDER: "anthropic",
      HARA_API_KEY: "",
      ANTHROPIC_API_KEY: "",
    },
    encoding: "utf8",
    timeout: 30_000,
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

test("ordinary interactive startup imports legacy sessions before exposing session menus", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-cli-session-index-startup-"));
  const project = join(home, "project");
  const sessions = join(home, ".hara", "sessions");
  mkdirSync(project, { recursive: true });
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(project, "package.json"), "{}\n");
  writeFileSync(join(sessions, "legacy-interactive-startup.json"), JSON.stringify({
    meta: {
      id: "legacy-interactive-startup",
      cwd: project,
      provider: "anthropic",
      model: "claude-test",
      title: "legacy startup",
      createdAt: "2026-07-24T03:00:00.000Z",
      updatedAt: "2026-07-24T03:30:00.000Z",
      source: "interactive",
    },
    history: [],
  }));
  try {
    const launch = runAtHome(home, ["--cwd", "project"]);
    assert.equal(launch.status, 1, launch.stderr || launch.stdout);
    assert.match(launch.stdout + launch.stderr, /not authenticated/i);
    const migrated = JSON.parse(
      readFileSync(join(sessions, "legacy-interactive-startup.json"), "utf8"),
    );
    assert.match(
      migrated.storageGeneration,
      /^[0-9a-f-]{36}$/i,
      "the default interactive action completes compatibility migration before provider startup",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("CLI export imports a legacy transcript before resolving its displayed id", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-cli-session-export-migration-"));
  const project = join(home, "project");
  const sessions = join(home, ".hara", "sessions");
  mkdirSync(project, { recursive: true });
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(project, "package.json"), "{}\n");
  writeFileSync(join(sessions, "legacy-export-session.json"), JSON.stringify({
    meta: {
      id: "legacy-export-session",
      cwd: project,
      provider: "anthropic",
      model: "claude-test",
      title: "legacy export",
      createdAt: "2026-07-24T03:00:00.000Z",
      updatedAt: "2026-07-24T03:30:00.000Z",
      source: "interactive",
    },
    history: [{ role: "user", content: "export migration marker" }],
  }));
  try {
    const exported = runAtHome(home, [
      "--cwd",
      "project",
      "export",
      "legacy-export",
    ]);
    assert.equal(exported.status, 0, exported.stderr || exported.stdout);
    assert.match(exported.stdout, /export migration marker/);
    assert.match(
      JSON.parse(readFileSync(join(sessions, "legacy-export-session.json"), "utf8")).storageGeneration,
      /^[0-9a-f-]{36}$/i,
      "export resolves against the migrated route index",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("CLI exposes safe per-run proxy and language controls", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-cli-flags-"));
  try {
    const help = runAtHome(home, ["--help"]);
    assert.equal(help.status, 0, help.stderr || help.stdout);
    assert.match(help.stdout, /--proxy <url>/);
    assert.match(help.stdout, /--lang <tag>/);
    assert.match(help.stdout, /--registry <url>/);

    const valid = runAtHome(home, ["--proxy", "http://127.0.0.1:7890", "--registry", "npmmirror", "--lang", "zh-CN", "sessions"]);
    assert.equal(valid.status, 0, valid.stderr || valid.stdout);

    const credential = runAtHome(home, ["--proxy", "http://user:secret-value@127.0.0.1:7890", "sessions"]);
    assert.equal(credential.status, 2);
    assert.match(credential.stdout + credential.stderr, /authenticated proxy URLs.*config/i);
    assert.doesNotMatch(credential.stdout + credential.stderr, /secret-value/, "proxy credentials are never reflected");

    const invalidLanguage = runAtHome(home, ["--lang", "not_a_language", "sessions"]);
    assert.equal(invalidLanguage.status, 2);
    assert.match(invalidLanguage.stdout + invalidLanguage.stderr, /Cannot use --lang/i);

    const invalidRegistry = runAtHome(home, ["--registry", "https://user:secret-registry@packages.example/", "sessions"]);
    assert.equal(invalidRegistry.status, 2);
    assert.match(invalidRegistry.stdout + invalidRegistry.stderr, /Cannot use --registry/i);
    assert.doesNotMatch(invalidRegistry.stdout + invalidRegistry.stderr, /secret-registry/);

    const persistedRegistry = runAtHome(home, ["config", "set", "packageRegistry", "npmmirror"]);
    assert.equal(persistedRegistry.status, 0, persistedRegistry.stderr || persistedRegistry.stdout);
    const readRegistry = runAtHome(home, ["config", "get", "packageRegistry"]);
    assert.equal(readRegistry.status, 0, readRegistry.stderr || readRegistry.stdout);
    assert.equal(readRegistry.stdout.trim(), "https://registry.npmmirror.com/");

    const rejectedRegistry = runAtHome(home, ["config", "set", "packageRegistry", "https://user:another-secret@packages.example/"]);
    assert.equal(rejectedRegistry.status, 1);
    assert.match(rejectedRegistry.stdout + rejectedRegistry.stderr, /Invalid package registry/i);
    assert.doesNotMatch(rejectedRegistry.stdout + rejectedRegistry.stderr, /another-secret/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("CLI accepts the familiar plural plugins alias", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-cli-plugins-alias-"));
  try {
    const singular = runAtHome(home, ["plugin"]);
    const plural = runAtHome(home, ["plugins"]);
    assert.equal(singular.status, 0, singular.stderr || singular.stdout);
    assert.equal(plural.status, 0, plural.stderr || plural.stdout);
    assert.equal(plural.stdout, singular.stdout);
    assert.match(plural.stdout, /No plugins/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
