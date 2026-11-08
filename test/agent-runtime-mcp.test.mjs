import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createWorkspaceMcpEndpoint, WORKSPACE_MCP_TOKEN_ENV } from "../dist/agent-runtime/registered-cli-mcp.js";
import { registeredCliArgs } from "../dist/agent-runtime/registered-cli.js";
import { DEFAULT_TIER, FULL_TIER_SKIP, SEATBELT } from "./helpers/platform-tier.mjs";

test("per-attempt MCP binds loopback, rejects wrong/cross-attempt tokens and origins, and expires on close", async t => {
  const a = new AbortController(), b = new AbortController(); let current = true, calls = 0;
  const create = (controller, audience) => createWorkspaceMcpEndpoint({ signal: controller.signal,
    assertCurrent() { if (!current) throw new Error("fixture generation/lease revoked"); },
    tools: () => [{ name: "agent_list", description: "Scoped fixture", input_schema: { type: "object", properties: {} } }],
    async call(name, input) {
      if (Object.keys(input).length) throw new Error("invalid scoped input");
      calls++; return { id: "fixture", name, content: JSON.stringify({ audience }) };
    } });
  const first = await create(a, "A"), second = await create(b, "B");
  const token = first.env[WORKSPACE_MCP_TOKEN_ENV];
  const client = new Client({ name: "fixture", version: "1" });
  t.after(async () => { await client.close().catch(() => {}); await first.close(); await second.close(); });
  assert.match(first.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  const probe = (url, credential, extra = {}) => fetch(url, { method: "POST", headers: {
    "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: "Bearer " + credential, ...extra },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
  assert.equal((await probe(first.url, "wrong")).status, 401);
  assert.equal((await probe(second.url, token)).status, 401, "a different Workspace/attempt has a different bearer");
  assert.equal((await probe(first.url, token, { Origin: "https://outside.invalid" })).status, 403);
  const deniedHost = await new Promise((resolve, reject) => {
    const request = http.request(new URL(first.url), { method: "POST", headers: { Host: "outside.invalid", Authorization: "Bearer " + token,
      "Content-Type": "application/json" } }, response => { response.resume(); resolve(response.statusCode); });
    request.once("error", reject); request.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
  });
  assert.equal(deniedHost, 403);
  assert.equal(calls, 0);
  await client.connect(new StreamableHTTPClientTransport(new URL(first.url), { requestInit: { headers: { Authorization: "Bearer " + token } } }));
  const list = await client.listTools(); assert.deepEqual(list.tools.map(row => row.name), ["agent_list"]);
  assert.equal(JSON.stringify(list).includes(token), false);
  const result = await client.callTool({ name: "agent_list", arguments: {} });
  assert.deepEqual(JSON.parse(result.content[0].text), { audience: "A" });
  const hidden = await client.callTool({ name: "agent_create", arguments: {} }); assert.equal(hidden.isError, true);
  await assert.rejects(client.callTool({ name: "agent_list", arguments: { workspaceId: "B" } }), /Workspace MCP request unavailable/);
  assert.equal(calls, 1);
  current = false;
  assert.equal((await probe(first.url, token)).status, 403, "revoked authority is checked before the SDK");
  current = true; a.abort(); await first.close();
  assert.equal(first.env[WORKSPACE_MCP_TOKEN_ENV], undefined);
  await assert.rejects(probe(first.url, token));
});

test("native CLI bridge keeps token values out of argv and trusts only the hara server", () => {
  const common = { prompt: "fixture", cwd: "/fixture", model: null, effort: null, skipGitRepoCheck: true,
    mcp: { url: "http://127.0.0.1:1234/mcp", timeoutMs: 120000 } };
  const codex = registeredCliArgs({ id: "codex", ...common, permissionTier: "full-protected", osWriteSandbox: true });
  // For the full-protected tier the reviewed outer Seatbelt owns confinement; nested Codex Seatbelt is disabled.
  assert(codex.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert(codex.includes('approval_policy="never"'));
  assert(codex.includes('shell_environment_policy.set.HARA_WORKSPACE_MCP_TOKEN=""'));
  assert(codex.includes('mcp_servers.hara_workspace.default_tools_approval_mode="approve"'));
  assert(codex.includes("mcp_servers.hara_workspace.bearer_token_env_var=" + JSON.stringify(WORKSPACE_MCP_TOKEN_ENV)));
  assert.equal(codex.some(value => value.includes("default_tools_approval_mode") && !value.startsWith("mcp_servers.hara_workspace.")), false);
  assert.equal(codex.some(value => /Bearer /u.test(value)), false);
  assert.throws(() => registeredCliArgs({ id: "codex", ...common, mcp: { ...common.mcp, serverName: "foreign" } }), /Host MCP namespace/);
  const claude = registeredCliArgs({ id: "claude", ...common });
  assert(claude.includes("plan")); assert(claude.includes("--strict-mcp-config"));
  assert.equal(claude[claude.indexOf("--allowedTools") + 1], "mcp__hara__*");
  const config = JSON.parse(claude[claude.indexOf("--mcp-config") + 1]);
  assert.deepEqual(Object.keys(config.mcpServers), ["hara"]);
  assert.equal(config.mcpServers.hara.headers.Authorization, "Bearer $" + "{" + WORKSPACE_MCP_TOKEN_ENV + "}");
});
