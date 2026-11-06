import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultEffortForLevels } from "../dist/workspace/default-effort.js";
import { codexHostToolOverrides } from "../dist/agent-runtime/codex-host-config.js";
import { registeredCliArgs } from "../dist/agent-runtime/registered-cli.js";

test("a new setting stays automatic until the Host has an objective", () => {
  for (const levels of [["low", "medium", "high", "max"], ["off", "low", "high"], ["off", "high"], ["high", "max"], undefined])
    assert.equal(defaultEffortForLevels(levels), null);
});

test("host Codex launch disables named user MCPs and plugins while preserving the Hara bridge", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-codex-config-"));
  try {
    mkdirSync(join(home, ".codex"));
    const config = join(home, ".codex", "config.toml");
    writeFileSync(config, '[mcp_servers.node_repl]\ncommand = "SECRET_NOT_IN_ARGS"\n[mcp_servers.node_repl.env]\nTOKEN = "SECRET_NOT_IN_ARGS"\n[mcp_servers.stripe-live]\ncommand = "other"\n');
    const overrides = codexHostToolOverrides(home);
    assert.deepEqual(overrides, ["-c", "mcp_servers.\"node_repl\"={enabled=false,command=\"hara-disabled-global-mcp\"}", "-c", "mcp_servers.\"stripe-live\"={enabled=false,command=\"hara-disabled-global-mcp\"}", "-c", "skills.bundled.enabled=false", "-c", "features.apps=false", "-c", "features.plugins=false", "-c", "features.hooks=false", "-c", "features.codex_hooks=false", "-c", "hooks={}", "-c", "notify=[]", "-c", "features.multi_agent=false", "-c", "features.in_app_local_automation=false", "-c", "features.remote_control=false", "-c", "features.unified_exec=false"]);
    const args = registeredCliArgs({ id: "codex", prompt: "hello", cwd: home, model: "fixture", effort: "medium",
      skipGitRepoCheck: true, hostToolOverrides: overrides, mcp: { url: "http://127.0.0.1:1234/mcp", timeoutMs: 30000 } });
    assert(args.includes("mcp_servers.hara_workspace.required=true"));
    assert(args.includes("features.plugins=false"));
    assert(!JSON.stringify(args).includes("SECRET_NOT_IN_ARGS"));
    writeFileSync(config, '[mcp_servers."unexpected.name"]\ncommand="other"\n');
    assert(codexHostToolOverrides(home).includes('mcp_servers."unexpected.name"={enabled=false,command="hara-disabled-global-mcp"}'), "quoted user MCP names are disabled too");
    writeFileSync(config, '[mcp_servers.hara]\ncommand="other"\n');
    assert(codexHostToolOverrides(home).includes('mcp_servers."hara"={enabled=false,command="hara-disabled-global-mcp"}'));
    writeFileSync(config, '[mcp_servers.hara_workspace_000000000000000000000000]\ncommand="other"\n');
    assert.throws(() => codexHostToolOverrides(home, undefined, undefined, "hara_workspace_000000000000000000000000"), /private Hara namespace/);
    writeFileSync(config, 'mcp_servers={foreign={command="other"}}\n');
    assert.throws(() => codexHostToolOverrides(home), /Inline/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
