import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";

import {
  AgentWorktreeManager,
  agentWorktreeRegistrationMatches,
} from "../dist/subagent/worktree.js";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const HEAD = "1".repeat(40);

function porcelain(...fields) {
  return `${fields.join("\0")}\0`;
}

const posixPaths = {
  canonicalize: value => value,
  isAbsolutePath: posix.isAbsolute,
};

test("worktree registration normalizes Git's Windows separators before exact comparison", () => {
  const target = "C:\\Users\\runner\\AppData\\Local\\Temp\\hara\\managed\\agent";
  const seen = [];
  const options = {
    canonicalize(value) { seen.push(value); return win32.normalize(value); },
    isAbsolutePath: win32.isAbsolute,
  };
  const gitPath = target.replaceAll("\\", "/");
  assert.equal(agentWorktreeRegistrationMatches(porcelain(
    "worktree C:/source/repo", `HEAD ${HEAD}`, "branch refs/heads/main", "",
    `worktree ${gitPath}`, `HEAD ${HEAD}`, "detached", "",
  ), target, options), true);
  assert.ok(seen.includes(gitPath), "the Git path must reach native canonicalization unmodified");
  assert.equal(agentWorktreeRegistrationMatches(porcelain(
    `worktree ${target}`, `HEAD ${HEAD}`, "detached", "",
  ), target, options), true);
  for (const other of [`${gitPath}-other`, `${gitPath}/nested`, gitPath.replace("/runner/", "/Runner/")]) {
    assert.equal(agentWorktreeRegistrationMatches(porcelain(`worktree ${other}`, ""), target, options), false);
  }
});

test("worktree registration also handles Windows UNC paths without widening identity", () => {
  const target = "\\\\server\\share\\团队 folder\\agent";
  const options = { canonicalize: win32.normalize, isAbsolutePath: win32.isAbsolute };
  assert.equal(agentWorktreeRegistrationMatches(porcelain(
    "worktree //server/share/团队 folder/agent", `HEAD ${HEAD}`, "detached", "",
  ), target, options), true);
  assert.equal(agentWorktreeRegistrationMatches(porcelain(
    "worktree //other-server/share/团队 folder/agent", "",
  ), target, options), false);
});

test("NUL-delimited registration preserves Unicode, spaces and embedded newlines in a path", () => {
  const target = "/tmp/团队 folder/line\nworktree fake/trailing space ";
  const seen = [];
  assert.equal(agentWorktreeRegistrationMatches(porcelain(
    `worktree ${target}`, `HEAD ${HEAD}`, "locked reason with spaces\nand a newline", "",
  ), target, {
    ...posixPaths,
    canonicalize(value) { seen.push(value); return value; },
  }), true);
  assert.deepEqual(seen, [target], "paths must not be trimmed, unquoted or split on newline");
  assert.equal(agentWorktreeRegistrationMatches(porcelain(
    `worktree ${target.trimEnd()}`, "",
  ), target, posixPaths), false);
});

test("only complete NUL-delimited worktree fields can establish registration", () => {
  const target = "/tmp/managed/agent";
  for (const output of [
    "",
    `worktree ${target}`,
    `worktree ${target}\nHEAD ${HEAD}\ndetached\n\n`,
    `worktree ${target}\0HEAD ${HEAD}`,
    porcelain(`HEAD worktree ${target}`, `branch worktree ${target}`, `locked worktree ${target}`, ""),
    porcelain(`worktree-other ${target}`, ` worktree ${target}`, `worktree\t${target}`, ""),
    porcelain(`worktree ${target}-other`, `worktree ${target}/child`, ""),
    porcelain(`worktree \"${target}\"`, ""),
    porcelain(`worktree /tmp/managed\nworktree ${target}`, ""),
  ]) {
    assert.equal(agentWorktreeRegistrationMatches(output, target, posixPaths), false, JSON.stringify(output));
  }
});

test("relative worktree fields are rejected before filesystem canonicalization", () => {
  const seen = [];
  const options = {
    canonicalize(value) { seen.push(value); return "C:\\managed\\agent"; },
    isAbsolutePath: win32.isAbsolute,
  };
  for (const value of ["", "agent", "../agent", "C:managed/agent", "file:///C:/managed/agent"]) {
    assert.equal(agentWorktreeRegistrationMatches(porcelain(`worktree ${value}`, ""), "C:\\managed\\agent", options), false);
  }
  assert.deepEqual(seen, []);
});

test("missing or non-directory registration paths do not hide a later matching worktree", () => {
  const target = "/tmp/managed/agent";
  for (const code of ["ENOENT", "ENOTDIR"]) {
    const options = {
      ...posixPaths,
      canonicalize(value) {
        if (value === "/tmp/stale") throw Object.assign(new Error("synthetic stale path"), { code });
        return value;
      },
    };
    assert.equal(agentWorktreeRegistrationMatches(porcelain("worktree /tmp/stale", ""), target, options), false);
    assert.equal(agentWorktreeRegistrationMatches(porcelain(
      "worktree /tmp/stale", "", `worktree ${target}`, "",
    ), target, options), true);
  }
});

test("permission and unexpected canonicalization failures remain fail-closed errors", () => {
  const target = "/tmp/managed/agent";
  for (const code of ["EACCES", "EPERM", "EIO", "ELOOP", undefined]) {
    const failure = Object.assign(new Error("synthetic canonicalization failure"), code ? { code } : {});
    assert.throws(() => agentWorktreeRegistrationMatches(porcelain(
      "worktree /tmp/unreadable", "", `worktree ${target}`, "",
    ), target, { ...posixPaths, canonicalize() { throw failure; } }), error => error === failure);
  }
});

function fixture(t) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "hara-worktree-registration-")));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const home = join(root, "home");
  const repo = join(root, "repo");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(repo, { mode: 0o700 });
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "appdata"),
    LOCALAPPDATA: join(home, "localappdata"),
    XDG_CONFIG_HOME: join(home, "config"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(home, "empty-gitconfig"),
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "0",
    ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot ?? "C:\\Windows" } : {}),
  };
  function git(...args) {
    const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], {
      cwd: repo, env, encoding: "utf8", windowsHide: true, timeout: 30_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr || `git ${args[0]} failed`);
    return result.stdout;
  }
  git("init", "-q");
  git("config", "user.email", "test@example.test");
  git("config", "user.name", "Hara Test");
  git("config", "core.autocrlf", "false");
  writeFileSync(join(repo, "source.txt"), "synthetic worktree source\n");
  git("add", "source.txt");
  git("commit", "-qm", "synthetic base");
  return { root, home, repo, git };
}

test("native worktree prepare and empty capture accept the repository's actual registration", t => {
  const state = fixture(t);
  const manager = new AgentWorktreeManager(state.repo, state.home, "registration-native");
  const binding = manager.prepare(AGENT_ID);
  assert.equal(binding.path, realpathSync.native(binding.path));
  assert.equal(agentWorktreeRegistrationMatches(state.git("worktree", "list", "--porcelain", "-z"), binding.path), true);
  assert.equal(manager.prepare(AGENT_ID, binding.baseCommit).path, binding.path);
  const diff = manager.capture(AGENT_ID, binding.baseCommit);
  assert.deepEqual(diff.changedPaths, []);
  assert.equal(diff.patch, "");
  assert.equal(diff.patchBytes, 0);
  assert.equal(diff.ownerAgentId, AGENT_ID);
  assert.equal(diff.workspaceId, binding.workspaceId);
});

test("native registration matching does not allow a linked managed worktree", t => {
  const state = fixture(t);
  const manager = new AgentWorktreeManager(state.repo, state.home, "registration-link");
  const binding = manager.prepare(AGENT_ID);
  const moved = join(state.root, "moved-worktree");
  renameSync(binding.path, moved);
  symlinkSync(moved, binding.path, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => manager.prepare(AGENT_ID), /replaced or linked/i);
  assert.throws(() => manager.capture(AGENT_ID, binding.baseCommit), /replaced or linked/i);
  assert.equal(readFileSync(join(moved, "source.txt"), "utf8"), "synthetic worktree source\n");
});

test("native registration matching rejects another repository's worktree at the managed path", t => {
  const state = fixture(t);
  const foreign = fixture(t);
  const manager = new AgentWorktreeManager(state.repo, state.home, "registration-foreign");
  const binding = manager.prepare(AGENT_ID);
  state.git("worktree", "remove", "--force", binding.path);
  foreign.git("worktree", "add", "--detach", binding.path);
  assert.equal(existsSync(binding.path), true);
  assert.throws(() => manager.prepare(AGENT_ID), /not registered to the source repository/i);
  assert.throws(() => manager.capture(AGENT_ID), /not registered to the source repository/i);
  assert.equal(readFileSync(join(binding.path, "source.txt"), "utf8"), "synthetic worktree source\n");
});
