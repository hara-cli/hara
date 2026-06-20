import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { installPlugin, uninstallPlugin, enabledPlugins, setPluginEnabled, pluginSkillDirs, pluginRoleDirs, pluginMcpServers } from "../dist/plugins/plugins.js";
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

test(".claude/agents subagents load as roles (Claude-Code interop, tools→allowTools)", () => {
  const proj = join(tmpdir(), "hara-cc-agents-" + Math.random().toString(36).slice(2));
  mkdirSync(join(proj, ".git"), { recursive: true });
  mkdirSync(join(proj, ".claude", "agents"), { recursive: true });
  writeFileSync(join(proj, ".claude", "agents", "explorer.md"), "---\nname: explorer\ndescription: explores\ntools: Read, Grep\n---\nYou explore the codebase.");
  try {
    const r = loadRoles(proj).find((x) => x.id === "explorer");
    assert.ok(r, "claude subagent loaded as a role");
    assert.deepEqual(r.allowTools, ["Read", "Grep"], "Claude `tools:` mapped to allowTools");
  } finally {
    rmSync(proj, { recursive: true, force: true });
  }
});
