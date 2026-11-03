import test from "node:test";
import assert from "node:assert/strict";
import { registeredCliArgs } from "../dist/agent-runtime/registered-cli.js";

const common = { id: "claude", prompt: "probe", cwd: "/fixture", model: "sonnet", effort: "high", skipGitRepoCheck: false,
  mcp: { url: "http://127.0.0.1:1234/mcp", timeoutMs: 120000 } };

test("Claude full candidate enables native tools, blocks plan and scheduling, and excludes personal customizations", () => {
  const args = registeredCliArgs({ ...common, claudePermissionMode: "bypassPermissions" });
  assert.equal(args[args.indexOf("--permission-mode") + 1], "bypassPermissions");
  assert(!args.includes("dontAsk") && !args.includes("--tools"));
  assert.equal(args[args.indexOf("--setting-sources") + 1], "project,local");
  assert.deepEqual(JSON.parse(args[args.indexOf("--settings") + 1]), { disableAllHooks: true, sandbox: { enabled: false } });
  for (const name of ["EnterPlanMode", "ExitPlanMode", "ScheduleWakeup", "CronCreate", "CronList", "CronDelete", "Cron*", "Monitor"])
    assert(args.includes(name));
  assert(args.includes("--disallowedTools") && args.includes("--strict-mcp-config"));
  const config = JSON.parse(args[args.indexOf("--mcp-config") + 1]);
  assert.deepEqual(Object.keys(config.mcpServers), ["hara"]);
  assert.equal(config.mcpServers.hara.headers.Authorization, "Bearer $" + "{HARA_WORKSPACE_MCP_TOKEN}");
  assert.equal(args[args.indexOf("--effort") + 1], "high");
});

test("production stays controlled until its write-protection execution interface is attached", () => {
  const args = registeredCliArgs(common);
  assert.equal(args[args.indexOf("--permission-mode") + 1], "plan");
  assert(!args.includes("bypassPermissions"));
  for (const name of ["ScheduleWakeup", "CronCreate", "CronList", "CronDelete", "Cron*", "Monitor"]) assert(args.includes(name));
  const stream = registeredCliArgs({ ...common, claudeStreamJson: true });
  assert.equal(stream[stream.indexOf("--output-format") + 1], "stream-json"); assert(stream.includes("--verbose"));
});

test("custom providers and native host login share a customization boundary without changing Codex", () => {
  const args = registeredCliArgs({ ...common, claudePermissionMode: "bypassPermissions", claudeCustomProvider: true });
  assert.equal(args[args.indexOf("--setting-sources") + 1], "project,local");
  const codex = registeredCliArgs({ ...common, id: "codex", claudePermissionMode: "bypassPermissions", claudeCustomProvider: true });
  assert(codex.includes("read-only"));
  assert(!codex.includes("bypassPermissions") && !codex.includes("--setting-sources"));
});
