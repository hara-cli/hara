import { test } from "node:test";
import assert from "node:assert/strict";
import { openCodeFailure, openCodeRunArgs, openCodeRunEnv, parseOpenCodeRun } from "../dist/agent-runtime/opencode-cli.js";

function result(stdout, ok = true) { return { ok, stdout, code: ok ? 0 : 1, timedOut: false }; }

test("OpenCode JSON events, not exit zero alone, determine success and fixed failure category", () => {
  const success = parseOpenCodeRun(result([
    '{"type":"step_start","sessionID":"private"}',
    '{"type":"text","part":{"text":"hello "}}',
    '{"type":"tool_use","part":{"tool":"hara_agent_list"}}',
    '{"type":"text","part":{"text":"team"}}',
    '{"type":"step_finish","part":{"reason":"stop"}}',
  ].join("\n")));
  assert.deepEqual(success, { text: "hello team", toolUses: [], stop: "end" });
  assert.equal(parseOpenCodeRun(result('{"type":"error","error":{"name":"UnknownError","message":"unknown model PRIVATE_DETAIL"}}')).errorMsg, "invalid_model");
  assert.equal(parseOpenCodeRun(result('{"type":"error","error":{"message":"401 Unauthorized PRIVATE_DETAIL"}}')).errorMsg, "runtime_auth_required");
  assert.equal(parseOpenCodeRun(result('{"type":"error","error":{"message":"Cannot connect to API PRIVATE_DETAIL"}}')).errorMsg, "runtime_network");
  assert.equal(parseOpenCodeRun(result('{"type":"error","error":{"message":"Permission denied PRIVATE_DETAIL"}}')).errorMsg, "runtime_permission_denied");
  assert.equal(parseOpenCodeRun(result('{"type":"text","part":{"text":"partial"}}')).stop, "error", "missing step_finish fails");
  assert.equal(openCodeFailure("something else PRIVATE_DETAIL"), "runtime_failed");
});

test("OpenCode launch is model-bound, host-only and denies native write/shell", () => {
  const bridge = { toolNames: ["agent_list", "write_file"], mcp: { type: "remote", url: "http://127.0.0.1:1234/mcp",
    headers: { Authorization: "Bearer fixture-private-token" } } };
  const env = openCodeRunEnv({ HOME: "/fixture/account", USERPROFILE: "/fixture/account", OPENCODE_CONFIG_DIR: "/attacker",
    XDG_CONFIG_HOME: "/attacker", OTEL_EXPORTER_OTLP_ENDPOINT: "https://attacker", PATH: "/bin" }, bridge);
  assert.equal(env.HOME, "/fixture/account");
  assert.equal(env.OPENCODE_CONFIG_DIR, undefined);
  assert.equal(env.XDG_CONFIG_HOME, undefined);
  assert.equal(env.OTEL_EXPORTER_OTLP_ENDPOINT, undefined);
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
  assert.equal(config.permission["*"], "deny");
  assert.equal(config.permission.read, "allow");
  assert.equal(config.permission.hara_agent_list, "allow");
  assert.equal(config.permission.hara_write_file, "allow", "Hara bridge, not native write, owns approval");
  for (const name of ["edit", "write", "bash"]) assert.equal(config.tools[name], false);
  assert.equal(config.mcp.hara.headers.Authorization, "Bearer fixture-private-token");
  const args = openCodeRunArgs("/fixture/project", "provider/model", "hello");
  assert.deepEqual(args, ["run", "--pure", "--format", "json", "-m", "provider/model", "--dir", "/fixture/project", "--agent", "hara-general", "--", "hello"]);
  assert(!args.join(" ").includes("fixture-private-token"));
  assert(!args.includes("--variant") && !args.includes("--session"));
});
