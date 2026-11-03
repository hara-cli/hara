import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultEffortForLevels } from "../dist/workspace/default-effort.js";
import { codexHostToolOverrides } from "../dist/agent-runtime/codex-host-config.js";
import { registeredCliArgs } from "../dist/agent-runtime/registered-cli.js";

test("new strength chooses medium or the nearest advertised lower level", () => {
  assert.equal(defaultEffortForLevels(["low", "medium", "high", "max"]), "medium");
  assert.equal(defaultEffortForLevels(["off", "low", "high"]), "low");
  assert.equal(defaultEffortForLevels(["off", "high"]), "off");
  assert.equal(defaultEffortForLevels(["high", "max"]), null);
  assert.equal(defaultEffortForLevels(undefined), null);
});

test("host Codex launch disables named user MCPs and plugins while preserving the Hara bridge", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-codex-config-"));
  try {
    mkdirSync(join(home, ".codex"));
    const config = join(home, ".codex", "config.toml");
    writeFileSync(config, '[mcp_servers.node_repl]\ncommand = "SECRET_NOT_IN_ARGS"\n[mcp_servers.node_repl.env]\nTOKEN = "SECRET_NOT_IN_ARGS"\n[mcp_servers.stripe-live]\ncommand = "other"\n');
    const overrides = codexHostToolOverrides(home);
    assert.deepEqual(overrides, ["-c", "mcp_servers.node_repl.enabled=false", "-c", "mcp_servers.stripe-live.enabled=false",
      "-c", "features.plugins=false"]);
    const args = registeredCliArgs({ id: "codex", prompt: "hello", cwd: home, model: "fixture", effort: "medium",
      skipGitRepoCheck: true, hostToolOverrides: overrides, mcp: { url: "http://127.0.0.1:1234/mcp", timeoutMs: 30000 } });
    assert(args.includes("mcp_servers.hara.required=true"));
    assert(args.includes("features.plugins=false"));
    assert(!JSON.stringify(args).includes("SECRET_NOT_IN_ARGS"));
    writeFileSync(config, '[mcp_servers."unexpected.name"]\ncommand="other"\n');
    assert.deepEqual(codexHostToolOverrides(home), [], "unrecognized table shape retains prior behavior");
    writeFileSync(config, '[mcp_servers.hara]\ncommand="other"\n');
    assert.deepEqual(codexHostToolOverrides(home), [], "a user Hara collision is not silently overridden");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
