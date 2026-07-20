import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  installPlugin,
  uninstallPlugin,
  enabledPlugins,
  listInstalled,
  setPluginEnabled,
  pluginSkillDirs,
  pluginRoleDirs,
  pluginMcpServers,
  pluginGitCloneFailure,
} from "../dist/plugins/plugins.js";
import { loadSkillIndex } from "../dist/skills/skills.js";
import { loadRoles } from "../dist/org/roles.js";

function makeDemoPlugin(name) {
  const root = join(tmpdir(), "hara-demo-plugin-" + Math.random().toString(36).slice(2));
  mkdirSync(join(root, ".hara-plugin"), { recursive: true });
  writeFileSync(
    join(root, ".hara-plugin", "plugin.json"),
    JSON.stringify({ name, version: "1.2.3", description: "demo", skills: ["skills"], agents: ["agents"], mcpServers: { demoSrv: { command: "echo", args: ["hi"] } } }),
  );
  mkdirSync(join(root, "skills", "demo-skill"), { recursive: true });
  writeFileSync(join(root, "skills", "demo-skill", "SKILL.md"), "---\nname: demo-skill\ndescription: a plugin skill\n---\n\nbody");
  mkdirSync(join(root, "agents"), { recursive: true });
  writeFileSync(join(root, "agents", "demo-role.md"), "---\nname: demo-role\ndescription: a plugin role\nowns: [demo]\n---\nYou are demo.");
  return root;
}
function cleanPluginFlag(name) {
  const p = join(homedir(), ".hara", "config.json");
  try {
    const cfg = JSON.parse(readFileSync(p, "utf8"));
    if (cfg.plugins?.enabled) {
      delete cfg.plugins.enabled[name];
      writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
    }
  } catch {
    /* no config */
  }
}

function makePlugin(manifest, files = {}) {
  const root = join(tmpdir(), "hara-plugin-fixture-" + Math.random().toString(36).slice(2));
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "plugin.json"), JSON.stringify(manifest));
  for (const [rel, contents] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  return root;
}

function installedRoot(name) {
  return join(homedir(), ".hara", "plugins", name);
}

function receiptPath(name) {
  return join(homedir(), ".hara", "plugin-receipts", `${name}.json`);
}

test("plugin Git clone diagnostics distinguish private-repo access without echoing remote stderr", () => {
  const privateError = pluginGitCloneFailure("github", {
    stderr: "remote: Repository not found. token=ghp_do-not-echo\nfatal: Authentication failed",
  });
  assert.match(privateError, /authentication|access was denied/i);
  assert.match(privateError, /gh auth login/);
  assert.doesNotMatch(privateError, /ghp_do-not-echo|remote:/);

  const networkError = pluginGitCloneFailure("git", {
    stderr: "fatal: unable to access 'https://secret@example.invalid/x': Could not resolve host",
  });
  assert.match(networkError, /DNS|network/i);
  assert.doesNotMatch(networkError, /secret@example/);

  assert.match(pluginGitCloneFailure("github", { code: "ENOENT" }), /Git is not installed/i);
});

test("plugin Git source rejects embedded HTTPS credentials before network access", () => {
  assert.throws(
    () => installPlugin("git:https://ghp_never_echo@example.invalid/org/plugin.git"),
    /must not embed credentials/i,
  );
  assert.throws(
    () => installPlugin("git:https://example.invalid/org/plugin.git?token=never"),
    /query\/fragment secrets/i,
  );
  assert.throws(
    () => installPlugin("git:ssh://git:never@example.invalid/org/plugin.git"),
    /must not embed credentials/i,
  );
});

test("plugin install → skills/roles/mcp auto-contribute; disable hides them; uninstall removes", () => {
  const pname = "hara-test-plugin-" + Math.random().toString(36).slice(2, 8);
  const src = makeDemoPlugin(pname);
  const dest = join(homedir(), ".hara", "plugins", pname);
  try {
    const p = installPlugin("file:" + src);
    assert.equal(p.name, pname);
    // installed plugins are enabled by default (no config entry needed)
    assert.ok(pluginSkillDirs().some((d) => d.includes(pname)), "plugin skill dir contributed");
    const sk = loadSkillIndex(process.cwd()).find((s) => s.id === "demo-skill");
    assert.ok(sk && sk.source === "plugin", "plugin skill in the index, tagged source=plugin");
    assert.ok(pluginRoleDirs().some((d) => d.includes(pname)), "plugin role dir contributed");
    assert.ok(loadRoles(process.cwd()).some((r) => r.id === "demo-role"), "plugin role loaded");
    assert.ok(pluginMcpServers().demoSrv, "plugin mcp server contributed");

    setPluginEnabled(pname, false); // disable
    assert.ok(!pluginSkillDirs().some((d) => d.includes(pname)), "disabled plugin contributes nothing");
    assert.ok(!enabledPlugins().some((x) => x.name === pname));

    assert.equal(uninstallPlugin(pname), true);
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
    cleanPluginFlag(pname);
  }
});

test("plugin staging rejects traversal, absolute paths, undeclared panel commands, and relative MCP escapes", () => {
  const outside = join(tmpdir(), "hara-plugin-escape-" + Math.random().toString(36).slice(2));
  writeFileSync(outside, "outside");
  const cases = [
    { name: "../escape" },
    { name: "bad-skills", skills: ["../outside"] },
    { name: "bad-agents", agents: [tmpdir()] },
    { name: "bad-bin", bin: { bad: "../outside" } },
    { name: "bad-mcp", mcpServers: { bad: { command: "../outside" } } },
    { name: "bad-panel", bin: { panel: "panel.mjs" }, panels: [{ id: "p", title: "P", command: "panel", detect: ["../secret"] }] },
    { name: "bad-panel-command", panels: [{ id: "p", title: "P", command: "external" }] },
  ];
  try {
    for (const manifest of cases) {
      const files = manifest.bin ? { "panel.mjs": "#!/usr/bin/env node\n" } : {};
      const source = makePlugin(manifest, files);
      try {
        assert.throws(() => installPlugin(`file:${source}`), /plugin|relative|manifest|panel|MCP|path|name/i);
      } finally {
        rmSync(source, { recursive: true, force: true });
      }
    }
    assert.equal(existsSync(join(homedir(), ".hara", "escape")), false);
  } finally {
    rmSync(outside, { force: true });
  }
});

test("plugin MCP entry scripts and cwd are bound to the installed immutable package root", () => {
  const name = "hara-mcp-root-" + Math.random().toString(36).slice(2, 8);
  const source = makePlugin(
    {
      name,
      mcpServers: {
        server: { command: "node", args: ["server.mjs", "--stdio"] },
        direct: { command: "./server.mjs" },
      },
    },
    { "server.mjs": "process.exit(0);\n" },
  );
  try {
    const plugin = installPlugin(`file:${source}`);
    const servers = pluginMcpServers();
    const server = servers.server;
    assert.equal(server.cwd, plugin.root);
    assert.equal(server.command, "node");
    assert.equal(server.args[0], join(plugin.root, "server.mjs"));
    assert.equal(servers.direct.cwd, plugin.root);
    assert.equal(servers.direct.command, join(plugin.root, "server.mjs"));
    assert.equal(uninstallPlugin(name), true);
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(installedRoot(name), { recursive: true, force: true });
    rmSync(receiptPath(name), { force: true });
    cleanPluginFlag(name);
  }
});

test("plugin packages containing symlinks are rejected before activation", { skip: process.platform === "win32" }, () => {
  const name = "hara-link-plugin-" + Math.random().toString(36).slice(2, 8);
  const source = makePlugin({ name, skills: ["skills"] });
  const outside = join(tmpdir(), "hara-plugin-link-target-" + Math.random().toString(36).slice(2));
  mkdirSync(join(source, "skills"), { recursive: true });
  writeFileSync(outside, "do not copy");
  symlinkSync(outside, join(source, "skills", "outside"));
  try {
    assert.throws(() => installPlugin(`file:${source}`), /symbolic link/i);
    assert.equal(existsSync(installedRoot(name)), false);
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(outside, { force: true });
  }
});

test("plugin update fails closed on a foreign bin collision and preserves the prior install", () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const name = `hara-update-${suffix}`;
  const oldCommand = `hara-old-${suffix}`;
  const sharedCommand = `hara-shared-${suffix}`;
  const foreignCommand = `hara-foreign-${suffix}`;
  const oldSource = makePlugin(
    {
      name,
      version: "1.0.0",
      bin: {
        [oldCommand]: "bin/old.mjs",
        [sharedCommand]: "bin/shared.mjs",
      },
    },
    {
      "bin/old.mjs": "#!/usr/bin/env node\n",
      "bin/shared.mjs": "#!/usr/bin/env node\n",
    },
  );
  const nextSource = makePlugin(
    {
      name,
      version: "2.0.0",
      bin: {
        [sharedCommand]: "bin/shared.mjs",
        [foreignCommand]: "bin/new.mjs",
      },
    },
    {
      "bin/shared.mjs": "#!/usr/bin/env node\n",
      "bin/new.mjs": "#!/usr/bin/env node\n",
    },
  );
  const foreign = join(homedir(), ".hara", "bin", foreignCommand);
  try {
    const first = installPlugin(`file:${oldSource}`);
    writeFileSync(foreign, "owned by somebody else");
    assert.throws(() => installPlugin(`file:${nextSource}`), /foreign command entry/i);
    const stillInstalled = listInstalled().find((plugin) => plugin.name === name);
    assert.equal(stillInstalled?.version, "1.0.0");
    const oldLink = join(homedir(), ".hara", "bin", oldCommand);
    const sharedLink = join(homedir(), ".hara", "bin", sharedCommand);
    assert.equal(lstatSync(oldLink).isSymbolicLink(), true);
    assert.equal(resolve(dirname(oldLink), readlinkSync(oldLink)), join(first.root, "bin/old.mjs"));
    assert.equal(lstatSync(sharedLink).isSymbolicLink(), true);
    assert.equal(resolve(dirname(sharedLink), readlinkSync(sharedLink)), join(first.root, "bin/shared.mjs"));
    rmSync(foreign, { force: true });
    assert.equal(uninstallPlugin(name), true);
  } finally {
    rmSync(foreign, { force: true });
    rmSync(oldSource, { recursive: true, force: true });
    rmSync(nextSource, { recursive: true, force: true });
    rmSync(installedRoot(name), { recursive: true, force: true });
    rmSync(receiptPath(name), { force: true });
    cleanPluginFlag(name);
  }
});

test("plugin uninstall requires its receipt and never removes a foreign replacement bin", () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const name = `hara-owned-${suffix}`;
  const command = `hara-owned-bin-${suffix}`;
  const source = makePlugin(
    { name, bin: { [command]: "bin/run.mjs" } },
    { "bin/run.mjs": "#!/usr/bin/env node\n" },
  );
  const link = join(homedir(), ".hara", "bin", command);
  try {
    installPlugin(`file:${source}`);
    rmSync(link);
    writeFileSync(link, "foreign");
    assert.throws(() => uninstallPlugin(name), /foreign command entry/i);
    assert.equal(existsSync(installedRoot(name)), true);

    rmSync(link);
    symlinkSync(join(installedRoot(name), "bin/run.mjs"), link, "file");
    assert.equal(uninstallPlugin(name), true);
    assert.equal(existsSync(link), false);
    assert.equal(existsSync(receiptPath(name)), false);

    // A manually copied legacy root has no receipt and therefore cannot authorize recursive deletion.
    mkdirSync(installedRoot(name), { recursive: true });
    writeFileSync(join(installedRoot(name), "plugin.json"), JSON.stringify({ name }));
    assert.throws(() => uninstallPlugin(name), /without an ownership receipt/i);
    assert.equal(existsSync(installedRoot(name)), true);
  } finally {
    rmSync(link, { force: true });
    rmSync(source, { recursive: true, force: true });
    rmSync(installedRoot(name), { recursive: true, force: true });
    rmSync(receiptPath(name), { force: true });
    cleanPluginFlag(name);
  }
});

test(".claude/agents subagents load as roles (Claude-Code interop, tools→allowTools)", () => {
  const proj = join(tmpdir(), "hara-cc-agents-" + Math.random().toString(36).slice(2));
  mkdirSync(join(proj, ".git"), { recursive: true });
  mkdirSync(join(proj, ".claude", "agents"), { recursive: true });
  writeFileSync(join(proj, ".claude", "agents", "explorer.md"), "---\nname: explorer\ndescription: explores\ntools: Read, Grep\n---\nYou explore the codebase.");
  try {
    const r = loadRoles(proj).find((x) => x.id === "explorer");
    assert.ok(r, "claude subagent loaded as a role");
    assert.deepEqual(r.allowTools, ["read_file", "grep"], "Claude `tools:` TRANSLATED to hara tool names (not passed verbatim)");
  } finally {
    rmSync(proj, { recursive: true, force: true });
  }
});
